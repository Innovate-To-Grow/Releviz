"""Coverage gaps for models: AdminInvitation."""

from django.test import TestCase


class AdminInvitationModelTests(TestCase):
    def _invitation(self):
        from apps.authn.models.members.admin_invitation import AdminInvitation

        return AdminInvitation.objects.create(
            email="invite@example.com",
            token=AdminInvitation.generate_token(),
            expires_at=AdminInvitation.default_expiry(),
        )

    def test_mark_cancelled_sets_status(self):
        """admin_invitation.py:75-76 — mark_cancelled() persists CANCELLED status."""
        from apps.authn.models.members.admin_invitation import AdminInvitation

        inv = self._invitation()
        inv.mark_cancelled()
        inv.refresh_from_db()
        self.assertEqual(inv.status, AdminInvitation.Status.CANCELLED)

    def test_get_acceptance_url_without_request_returns_path(self):
        """admin_invitation.py:84 — get_acceptance_url() with no request returns a relative path."""
        inv = self._invitation()
        url = inv.get_acceptance_url()
        self.assertIn(inv.token, url)
        self.assertTrue(url.startswith("/"))
