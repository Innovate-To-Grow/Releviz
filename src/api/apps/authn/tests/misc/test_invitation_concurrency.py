import threading
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections
from django.test import Client, TransactionTestCase
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.authn.models.members.admin_invitation import AdminInvitation
from apps.authn.views.admin.invitation import AcceptInvitationView

Member = get_user_model()


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL transaction semantics")
class AcceptInvitationConcurrencyTests(TransactionTestCase):
    def test_verified_registration_wins_insert_race_without_contact_transfer(self):
        invitation = AdminInvitation.objects.create(
            email="Invite@Example.com",
            token=AdminInvitation.generate_token(),
            role=AdminInvitation.Role.ADMIN,
            status=AdminInvitation.Status.PENDING,
            expires_at=timezone.now() + timezone.timedelta(days=7),
        )
        absent_contact_checked = threading.Event()
        registration_committed = threading.Event()
        responses = []
        errors = []
        original_get_contact = AcceptInvitationView._get_contact_for_update

        def pause_after_absent_contact(view, current_invitation):
            contact = original_get_contact(view, current_invitation)
            if contact is None and not absent_contact_checked.is_set():
                absent_contact_checked.set()
                if not registration_committed.wait(timeout=5):
                    raise TimeoutError("concurrent registration did not commit")
            return contact

        def accept_invitation():
            close_old_connections()
            try:
                with patch.object(
                    AcceptInvitationView,
                    "_get_contact_for_update",
                    new=pause_after_absent_contact,
                ):
                    response = Client().post(
                        f"/authn/invite/{invitation.token}/",
                        {
                            "email": invitation.email,
                            "first_name": "Invitation",
                            "last_name": "Candidate",
                            "password1": "StrongPass123!",
                            "password2": "StrongPass123!",
                        },
                    )
                responses.append(response.status_code)
            except Exception as exc:  # noqa: BLE001 - surfaced in the test thread.
                errors.append(exc)
            finally:
                connections.close_all()

        thread = threading.Thread(target=accept_invitation)
        thread.start()
        self.assertTrue(absent_contact_checked.wait(timeout=5))

        try:
            winner = Member.objects.create_user(
                password="StrongPass123!",
                is_active=True,
                is_staff=False,
            )
            winning_contact = ContactEmail.objects.create(
                member=winner,
                email_address="invite@example.com",
                email_type="primary",
                verified=True,
            )
        finally:
            registration_committed.set()

        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        if errors:
            raise errors[0]

        self.assertEqual(responses, [200])
        winner.refresh_from_db()
        winning_contact.refresh_from_db()
        invitation.refresh_from_db()
        self.assertTrue(winner.is_staff)
        self.assertEqual(winning_contact.member_id, winner.id)
        self.assertEqual(
            ContactEmail.objects.filter(email_address__iexact=invitation.email).count(),
            1,
        )
        self.assertEqual(Member.objects.count(), 1)
        self.assertEqual(invitation.accepted_by_id, winner.id)
