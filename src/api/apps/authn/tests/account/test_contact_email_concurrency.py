import threading
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.test import TransactionTestCase

from apps.authn.models import ContactEmail
from apps.authn.services import make_contact_email_primary
from apps.authn.views.account.contact_emails import _update_contact_email

Member = get_user_model()


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row-lock semantics")
class ContactEmailConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        self.primary = ContactEmail.objects.create(
            member=self.member,
            email_address="primary@example.com",
            email_type="primary",
            verified=True,
        )
        self.target = ContactEmail.objects.create(
            member=self.member,
            email_address="target@example.com",
            email_type="other",
            verified=True,
        )

    def test_patch_reloads_after_primary_swap_and_cannot_remove_all_primaries(self):
        swap_holds_member_lock = threading.Event()
        release_swap = threading.Event()
        patch_started = threading.Event()
        outcomes = []
        errors = []

        def swap_primary():
            close_old_connections()
            try:
                with transaction.atomic():
                    Member.objects.select_for_update().get(pk=self.member.pk)
                    make_contact_email_primary(
                        member=self.member,
                        contact_email_id=self.target.pk,
                    )
                    swap_holds_member_lock.set()
                    release_swap.wait(timeout=5)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
                swap_holds_member_lock.set()
            finally:
                connections.close_all()

        def patch_target():
            close_old_connections()
            patch_started.set()
            try:
                _, error = _update_contact_email(
                    self.member,
                    self.target.pk,
                    {"email_type": "other"},
                )
                outcomes.append(error)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                connections.close_all()

        swap_thread = threading.Thread(target=swap_primary)
        patch_thread = threading.Thread(target=patch_target)
        swap_thread.start()
        self.assertTrue(swap_holds_member_lock.wait(timeout=5))
        patch_thread.start()
        self.assertTrue(patch_started.wait(timeout=5))
        release_swap.set()
        swap_thread.join(timeout=10)
        patch_thread.join(timeout=10)

        if errors:
            raise errors[0]
        self.assertEqual(outcomes, ["primary_demotion"])
        self.assertEqual(
            ContactEmail.objects.filter(
                member=self.member,
                email_type="primary",
            ).count(),
            1,
        )
