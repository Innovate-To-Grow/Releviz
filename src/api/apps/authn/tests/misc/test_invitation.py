"""Tests for AcceptInvitationView (Django view, not DRF)."""

from django.contrib.auth import get_user_model
from django.test import TestCase
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

    def test_get_existing_verified_member_upgrades_and_shows_registered(self):
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
        member.refresh_from_db()
        self.assertTrue(member.is_staff)
        # Upgrading an existing member to staff must not auto-grant any apps.
        self.assertEqual(member.admin_apps, [])
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, AdminInvitation.Status.ACCEPTED)

    def test_post_invalid_token_returns_error(self):
        response = self.client.post(
            "/authn/invite/nonexistent-token/",
            {"first_name": "A", "last_name": "B", "password1": "x", "password2": "x"},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_rate_limited_returns_429(self):
        from django.core.cache import cache

        invitation = self._create_invitation(email="rl@example.com")
        cache.set(f"invitation-rate:{invitation.token}", 10, timeout=3600)
        response = self.client.post(
            f"/authn/invite/{invitation.token}/",
            {"first_name": "A", "last_name": "B", "password1": "x", "password2": "x"},
        )
        self.assertEqual(response.status_code, 429)
        cache.clear()

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
