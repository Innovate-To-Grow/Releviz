"""Tests for AdminInvitation Django admin behavior."""

from unittest.mock import ANY, patch

from django.contrib.admin.sites import AdminSite
from django.contrib.messages.storage.fallback import FallbackStorage
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.authn.admin.members.invitation import AdminInvitationAdmin
from apps.authn.models import AdminInvitation
from apps.authn.models.members.member import Member


@override_settings(ADMIN_REQUIRE_CONFIRMATION=False)
class AdminInvitationAdminTests(TestCase):
    def setUp(self):
        self.staff = Member.objects.create_superuser(
            password="StrongPass123!",
            first_name="Admin",
            last_name="User",
            is_active=True,
        )
        self.client.force_login(self.staff)

    def _create_invitation(self, email="invite@example.com", **kwargs):
        defaults = {
            "email": email,
            "token": AdminInvitation.generate_token(),
            "status": AdminInvitation.Status.PENDING,
            "expires_at": timezone.now() + timezone.timedelta(days=7),
            "invited_by": self.staff,
        }
        defaults.update(kwargs)
        return AdminInvitation.objects.create(**defaults)

    @patch("apps.authn.services.email.send_admin_invitation_email")
    def test_admin_add_sends_invitation_email(self, mock_send):
        response = self.client.post(
            reverse("admin:authn_admininvitation_add"),
            {
                "email": "New.Admin@Example.COM ",
                "role": AdminInvitation.Role.ADMIN,
                "message": "Welcome.",
                "_save": "Save",
            },
        )

        self.assertEqual(response.status_code, 302)
        invitation = AdminInvitation.objects.get(email="new.admin@example.com")
        self.assertEqual(invitation.invited_by, self.staff)
        self.assertEqual(invitation.status, AdminInvitation.Status.PENDING)
        self.assertTrue(invitation.token)
        self.assertGreater(invitation.expires_at, timezone.now())
        mock_send.assert_called_once_with(invitation=invitation, request=ANY)

    @patch("apps.authn.services.email.send_admin_invitation_email")
    def test_admin_add_cancels_previous_pending_invitation_for_email(self, mock_send):
        old = self._create_invitation(email="invite@example.com")

        response = self.client.post(
            reverse("admin:authn_admininvitation_add"),
            {
                "email": "INVITE@example.com",
                "role": AdminInvitation.Role.ADMIN,
                "message": "",
                "_save": "Save",
            },
        )

        self.assertEqual(response.status_code, 302)
        old.refresh_from_db()
        self.assertEqual(old.status, AdminInvitation.Status.CANCELLED)
        self.assertEqual(AdminInvitation.objects.filter(email__iexact="invite@example.com").count(), 2)
        mock_send.assert_called_once()

    @patch("apps.authn.services.email.send_admin_invitation_email")
    def test_resend_action_sends_only_valid_pending_invitations(self, mock_send):
        valid = self._create_invitation(email="valid@example.com")
        expired = self._create_invitation(
            email="expired@example.com",
            expires_at=timezone.now() - timezone.timedelta(days=1),
        )
        accepted = self._create_invitation(email="accepted@example.com", status=AdminInvitation.Status.ACCEPTED)

        request = RequestFactory().post("/")
        request.user = self.staff
        request.session = self.client.session
        request._messages = FallbackStorage(request)
        admin_obj = AdminInvitationAdmin(AdminInvitation, AdminSite())
        admin_obj.resend_invitations(
            request, AdminInvitation.objects.filter(pk__in=[valid.pk, expired.pk, accepted.pk])
        )

        mock_send.assert_called_once_with(invitation=valid, request=request)
        expired.refresh_from_db()
        self.assertEqual(expired.status, AdminInvitation.Status.EXPIRED)
