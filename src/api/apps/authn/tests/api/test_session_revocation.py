"""Revoking refresh sessions must take effect before access tokens expire."""

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from apps.authn.models import ContactEmail
from apps.authn.security import revoke_all_refresh_sessions
from apps.authn.services.security import (
    SESSION_REFRESH_JTI_CLAIM,
    issue_session_refresh_token,
)

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

    def test_revoking_one_bound_session_does_not_keep_it_alive_via_another(self):
        first = issue_session_refresh_token(self.member)
        second = issue_session_refresh_token(self.member)
        first_access = first.access_token
        second_access = second.access_token
        self.assertEqual(first_access[SESSION_REFRESH_JTI_CLAIM], first["jti"])
        self.assertEqual(second_access[SESSION_REFRESH_JTI_CLAIM], second["jti"])

        first_outstanding = OutstandingToken.objects.get(user=self.member, jti=first["jti"])
        BlacklistedToken.objects.create(token=first_outstanding)

        self.assertEqual(self._profile(first_access).status_code, 401)
        self.assertEqual(self._profile(second_access).status_code, 200)

    def test_login_and_refresh_access_tokens_keep_the_session_binding(self):
        login = self.client.post(
            "/authn/login/",
            {"email": "revoked@example.com", "password": "OldPass123!"},
            format="json",
        )
        self.assertEqual(login.status_code, 200)
        refresh = RefreshToken(self.client.cookies["releviz_refresh"].value)
        access = RefreshToken(self.client.cookies["releviz_refresh"].value).access_token
        # The returned access string, not a newly-derived token, carries the same
        # binding established by the login response.
        returned_access = AccessToken(login.data["access"])
        self.assertEqual(returned_access[SESSION_REFRESH_JTI_CLAIM], refresh["jti"])
        self.assertEqual(access[SESSION_REFRESH_JTI_CLAIM], refresh["jti"])

        refreshed = self.client.post("/authn/refresh/", {}, format="json")
        self.assertEqual(refreshed.status_code, 200)
        refreshed_access = AccessToken(refreshed.data["access"])
        current_refresh = RefreshToken(self.client.cookies["releviz_refresh"].value)
        self.assertEqual(
            refreshed_access[SESSION_REFRESH_JTI_CLAIM],
            current_refresh["jti"],
        )
