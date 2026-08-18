"""Tests for AcceptInvitationView (Django view, not DRF)."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.forms.invitation import AcceptInvitationForm
from apps.authn.models import ContactEmail
from apps.authn.models.members.admin_invitation import AdminInvitation

Member = get_user_model()


class AcceptInvitationViewTests(TestCase):
    # noinspection PyMethodMayBeStatic
    def _create_invitation(
        self, email="invite@example.com", role=AdminInvitation.Role.ADMIN, **kwargs
    ):
        defaults = {
            "email": email,
            "token": AdminInvitation.generate_token(),
            "role": role,
            "status": AdminInvitation.Status.PENDING,
            "expires_at": timezone.now() + timezone.timedelta(days=7),
        }
        defaults.update(kwargs)
        return AdminInvitation.objects.create(**defaults)

    def test_get_valid_invitation_renders_form(self):
        invitation = self._create_invitation()
        response = self.client.get(f"/authn/invite/{invitation.token}/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "invite@example.com")

    def test_get_invalid_token_returns_error(self):
        response = self.client.get("/authn/invite/nonexistent-token/")
        self.assertEqual(response.status_code, 400)

    def test_get_expired_invitation_returns_error(self):
        invitation = self._create_invitation(
            expires_at=timezone.now() - timezone.timedelta(days=1),
        )
        response = self.client.get(f"/authn/invite/{invitation.token}/")
        self.assertEqual(response.status_code, 400)

    def test_get_cancelled_invitation_returns_error(self):
        invitation = self._create_invitation(status=AdminInvitation.Status.CANCELLED)
        response = self.client.get(f"/authn/invite/{invitation.token}/")
        self.assertEqual(response.status_code, 400)

    def test_get_existing_verified_member_requires_post_confirmation(self):
        invitation = self._create_invitation(email="existing@example.com")
        member = Member.objects.create_user(
            password="StrongPass123!",
            first_name="Ex",
            last_name="Member",
            is_staff=False,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=member, email_address="existing@example.com", email_type="primary", verified=True
        )
        response = self.client.get(f"/authn/invite/{invitation.token}/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "existing@example.com")
        self.assertContains(response, "Grant admin access")
        member.refresh_from_db()
        self.assertFalse(member.is_staff)
        self.assertEqual(member.admin_apps, [])
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AdminInvitation.Status.PENDING)

    def test_post_invalid_token_returns_error(self):
        response = self.client.post(
            "/authn/invite/nonexistent-token/",
            {"first_name": "A", "last_name": "B", "password1": "x", "password2": "x"},
        )
        self.assertEqual(response.status_code, 400)

    @override_settings(
        AUTH_RATE_LIMITS={
            "admin_invitation_accept": {
                "ip": {"limit": 1, "window": 60, "block": 30},
                "identity": {"limit": 1, "window": 60, "block": 30},
            }
        }
    )
    def test_post_rate_limited_returns_429(self):
        invitation = self._create_invitation(email="rl@example.com")
        payload = {"first_name": "A", "last_name": "B", "password1": "x", "password2": "x"}
        first = self.client.post(
            f"/authn/invite/{invitation.token}/",
            payload,
        )
        self.assertEqual(first.status_code, 200)
        response = self.client.post(f"/authn/invite/{invitation.token}/", payload)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response["Retry-After"], "30")

    def test_post_creates_staff_member(self):
        invitation = self._create_invitation()
        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": "invite@example.com",
                "first_name": "Staff",
                "last_name": "User",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )
        self.assertEqual(response.status_code, 200)
        member = ContactEmail.objects.get(email_address="invite@example.com").member
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_active)
        # No app grant is handed out at acceptance time; the I2G Master grants
        # apps later via the Member admin (see apps.core.utils.access).
        self.assertEqual(member.admin_apps, [])

    def test_post_rechecks_invitation_after_form_validation(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        invitation = self._create_invitation()
        member_count = Member.objects.count()
        with patch.object(
            AcceptInvitationView,
            "_get_invitation",
            side_effect=[invitation, None],
        ):
            response = self.client.post(
                f"/authn/invite/{invitation.token}/",
                {
                    "email": invitation.email,
                    "first_name": "Race",
                    "last_name": "Loser",
                    "password1": "StrongPass123!",
                    "password2": "StrongPass123!",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(Member.objects.count(), member_count)

    def test_post_existing_member_upgrades_to_staff(self):
        existing = Member.objects.create_user(
            password="StrongPass123!",
            is_staff=False,
        )
        ContactEmail.objects.create(
            member=existing, email_address="invite@example.com", email_type="primary", verified=True
        )
        invitation = self._create_invitation(email="invite@example.com")
        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": "invite@example.com",
                "first_name": "Ignored",
                "last_name": "Ignored",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )
        self.assertEqual(response.status_code, 200)
        existing.refresh_from_db()
        self.assertTrue(existing.is_staff)
        self.assertEqual(existing.admin_apps, [])

    def test_post_existing_member_rechecks_locked_invitation(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        existing = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=existing,
            email_address="invite@example.com",
            email_type="primary",
            verified=True,
        )
        invitation = self._create_invitation(email="invite@example.com")

        with patch.object(
            AcceptInvitationView,
            "_get_invitation",
            side_effect=[invitation, None],
        ):
            response = self.client.post(f"/authn/invite/{invitation.token}/")

        self.assertEqual(response.status_code, 400)
        existing.refresh_from_db()
        self.assertFalse(existing.is_staff)

    def test_post_existing_member_rechecks_locked_contact(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        existing = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=existing,
            email_address="invite@example.com",
            email_type="primary",
            verified=True,
        )
        invitation = self._create_invitation(email="invite@example.com")

        with (
            patch.object(
                AcceptInvitationView,
                "_get_invitation",
                side_effect=[invitation, invitation],
            ),
            patch.object(
                AcceptInvitationView,
                "_get_verified_member",
                side_effect=[existing, None],
            ),
        ):
            response = self.client.post(f"/authn/invite/{invitation.token}/")

        self.assertEqual(response.status_code, 400)
        existing.refresh_from_db()
        self.assertFalse(existing.is_staff)

    def test_post_form_race_upgrades_newly_verified_member(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        existing = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=existing,
            email_address="invite@example.com",
            email_type="primary",
            verified=True,
        )
        invitation = self._create_invitation(email="invite@example.com")

        with patch.object(
            AcceptInvitationView,
            "_get_verified_member",
            side_effect=[None, existing],
        ):
            response = self.client.post(
                f"/authn/invite/{invitation.token}/",
                {
                    "email": invitation.email,
                    "first_name": "Race",
                    "last_name": "Winner",
                    "password1": "StrongPass123!",
                    "password2": "StrongPass123!",
                },
            )

        self.assertEqual(response.status_code, 200)
        existing.refresh_from_db()
        self.assertTrue(existing.is_staff)
        self.assertEqual(Member.objects.count(), 1)

    def test_locked_expired_invitation_is_marked_expired(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        invitation = self._create_invitation(
            expires_at=timezone.now() - timezone.timedelta(seconds=1),
        )

        self.assertIsNone(AcceptInvitationView()._get_invitation(invitation.token, for_update=True))
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AdminInvitation.Status.EXPIRED)

    def test_post_existing_inactive_verified_member_upgrades_and_activates(self):
        existing = Member.objects.create_user(
            password="StrongPass123!",
            is_active=False,
            is_staff=False,
        )
        ContactEmail.objects.create(
            member=existing, email_address="invite@example.com", email_type="primary", verified=True
        )
        invitation = self._create_invitation(email="invite@example.com")

        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": "invite@example.com",
                "first_name": "Ignored",
                "last_name": "Ignored",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )

        self.assertEqual(response.status_code, 200)
        existing.refresh_from_db()
        self.assertTrue(existing.is_staff)
        self.assertTrue(existing.is_active)

    def test_post_claims_existing_unclaimed_contact_email(self):
        ContactEmail.objects.create(
            member=None,
            email_address="invite@example.com",
            email_type="other",
            subscribe=False,
            verified=False,
        )
        invitation = self._create_invitation(email="invite@example.com")

        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": "invite@example.com",
                "first_name": "Staff",
                "last_name": "User",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(ContactEmail.objects.filter(email_address="invite@example.com").count(), 1)
        contact = ContactEmail.objects.get(email_address="invite@example.com")
        self.assertEqual(contact.email_type, "primary")
        self.assertTrue(contact.verified)
        self.assertFalse(contact.subscribe)
        self.assertTrue(contact.member.is_staff)

    def test_post_reclaims_unverified_contact_email_from_other_member(self):
        other = Member.objects.create_user(
            password="StrongPass123!", is_active=True, is_staff=False
        )
        ContactEmail.objects.create(
            member=other,
            email_address="invite@example.com",
            email_type="secondary",
            verified=False,
        )
        invitation = self._create_invitation(email="invite@example.com")

        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": "invite@example.com",
                "first_name": "Staff",
                "last_name": "User",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )

        self.assertEqual(response.status_code, 200)
        other.refresh_from_db()
        self.assertFalse(other.is_staff)
        contact = ContactEmail.objects.get(email_address="invite@example.com")
        self.assertNotEqual(contact.member_id, other.id)
        self.assertTrue(contact.member.is_staff)
        self.assertEqual(contact.email_type, "primary")
        self.assertTrue(contact.verified)

    def test_post_insert_race_upgrades_verified_winner_without_transferring_contact(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        winner = Member.objects.create_user(
            password="StrongPass123!",
            is_active=False,
            is_staff=False,
            access_level=Member.AccessLevel.TEMPORARY,
        )
        winning_contact = ContactEmail.objects.create(
            member=winner,
            email_address="invite@example.com",
            email_type="secondary",
            verified=True,
        )
        invitation = self._create_invitation(email="Invite@Example.com")

        with (
            patch.object(
                AcceptInvitationView,
                "_get_verified_member",
                side_effect=[None, None],
            ),
            patch.object(
                AcceptInvitationView,
                "_get_contact_for_update",
                side_effect=[None, winning_contact],
            ),
            patch(
                "apps.authn.views.admin.invitation.ContactEmail.objects.create",
                side_effect=IntegrityError("concurrent unique insert"),
            ),
        ):
            response = self.client.post(
                f"/authn/invite/{invitation.token}/",
                {
                    "email": invitation.email,
                    "first_name": "Race",
                    "last_name": "Candidate",
                    "password1": "StrongPass123!",
                    "password2": "StrongPass123!",
                },
            )

        self.assertEqual(response.status_code, 200)
        winner.refresh_from_db()
        winning_contact.refresh_from_db()
        invitation.refresh_from_db()
        self.assertTrue(winner.is_active)
        self.assertTrue(winner.is_staff)
        self.assertEqual(winner.access_level, Member.AccessLevel.FULL)
        self.assertEqual(winning_contact.member_id, winner.id)
        self.assertEqual(winning_contact.email_type, "secondary")
        self.assertEqual(Member.objects.count(), 1)
        self.assertEqual(invitation.accepted_by_id, winner.id)

    def test_post_reraises_unrelated_contact_insert_integrity_error(self):
        from apps.authn.views.admin.invitation import AcceptInvitationView

        invitation = self._create_invitation(email="invite@example.com")

        with (
            patch.object(
                AcceptInvitationView,
                "_get_contact_for_update",
                side_effect=[None, None],
            ),
            patch(
                "apps.authn.views.admin.invitation.ContactEmail.objects.create",
                side_effect=IntegrityError("unrelated constraint"),
            ),
            self.assertRaises(IntegrityError),
        ):
            self.client.post(
                f"/authn/invite/{invitation.token}/",
                {
                    "email": invitation.email,
                    "first_name": "Race",
                    "last_name": "Candidate",
                    "password1": "StrongPass123!",
                    "password2": "StrongPass123!",
                },
            )

        self.assertEqual(Member.objects.count(), 0)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AdminInvitation.Status.PENDING)

    def test_invitation_marked_accepted_after_success(self):
        invitation = self._create_invitation()
        self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": invitation.email,
                "first_name": "Accepted",
                "last_name": "User",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            },
        )
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AdminInvitation.Status.ACCEPTED)
        self.assertIsNotNone(invitation.accepted_by)
        self.assertIsNotNone(invitation.accepted_at)

    def test_post_password_mismatch_rejected(self):
        invitation = self._create_invitation()
        member_count_before = Member.objects.count()
        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {
                "email": invitation.email,
                "first_name": "Mis",
                "last_name": "Match",
                "password1": "StrongPass123!",
                "password2": "DifferentPass456!",
            },
        )
        # Should re-render form, not create member
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Member.objects.count(), member_count_before)

    def test_name_fields_reject_lone_markup_delimiters(self):
        form = AcceptInvitationForm(
            data={
                "email": "invite@example.com",
                "first_name": "Less < Than",
                "last_name": "Greater > Than",
                "password1": "StrongPass123!",
                "password2": "StrongPass123!",
            }
        )

        self.assertFalse(form.is_valid())
        self.assertIn("HTML tags are not allowed.", form.errors["first_name"])
        self.assertIn("HTML tags are not allowed.", form.errors["last_name"])
