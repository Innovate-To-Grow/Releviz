"""Revoking refresh sessions must take effect before access tokens expire."""

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail
from apps.authn.security import revoke_all_refresh_sessions

Member = get_user_model()


class SessionRevocationTests(APITestCase):
    def setUp(self):
        self.member = Member.objects.create_user(
            first_name="Rev",
            last_name="Oked",
            password="OldPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="revoked@example.com",
            email_type="primary",
            verified=True,
        )
        self.refresh = RefreshToken.for_user(self.member)

    def _profile(self, access):
        return self.client.get("/authn/profile/", headers={"Authorization": f"Bearer {access}"})

    def test_access_token_works_while_a_session_is_live(self):
        self.assertEqual(self._profile(self.refresh.access_token).status_code, 200)

    def test_access_token_is_rejected_once_every_session_is_revoked(self):
        access = self.refresh.access_token

        self.assertEqual(revoke_all_refresh_sessions(self.member), 1)

        # The token itself is still cryptographically valid and unexpired; it is
        # refused because the member has no surviving refresh session.
        self.assertEqual(self._profile(access).status_code, 401)

    def test_revoking_is_idempotent(self):
        self.assertEqual(revoke_all_refresh_sessions(self.member), 1)
        self.assertEqual(revoke_all_refresh_sessions(self.member), 0)

    def test_other_devices_keep_working_until_they_are_revoked(self):
        other = RefreshToken.for_user(self.member)

        self.assertEqual(self._profile(other.access_token).status_code, 200)
        revoke_all_refresh_sessions(self.member)
        self.assertEqual(self._profile(other.access_token).status_code, 401)
