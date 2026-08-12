"""Tests for listing and revoking cookie-backed refresh sessions."""

from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail

Member = get_user_model()


class AuthSessionsViewTests(APITestCase):
    def setUp(self):
        self.member = Member.objects.create_user(is_active=True)
        ContactEmail.objects.create(
            member=self.member,
            email_address="sessions@example.com",
            email_type="primary",
            verified=True,
        )
        self.current = RefreshToken.for_user(self.member)
        self.other = RefreshToken.for_user(self.member)
        self.client.force_authenticate(self.member)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE_NAME] = str(self.current)

    def test_lists_owned_sessions_and_marks_cookie_session_current(self):
        response = self.client.get("/authn/sessions/", HTTP_USER_AGENT="Test Browser")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["sessions"]), 2)
        current = next(item for item in response.data["sessions"] if item["current"])
        self.assertEqual(current["userAgent"], "Test Browser")

    def test_revokes_one_owned_session(self):
        listing = self.client.get("/authn/sessions/").data["sessions"]
        other = next(item for item in listing if not item["current"])

        response = self.client.delete(
            "/authn/sessions/",
            {"sessionId": other["id"]},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"revoked": 1, "currentRevoked": False})
        self.assertEqual(len(self.client.get("/authn/sessions/").data["sessions"]), 1)

    def test_revoke_all_clears_current_cookie(self):
        response = self.client.delete("/authn/sessions/", {"all": True}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["currentRevoked"])
        self.assertEqual(response.cookies[settings.AUTH_REFRESH_COOKIE_NAME]["max-age"], 0)
        self.assertEqual(self.client.get("/authn/sessions/").data["sessions"], [])

    def test_cannot_revoke_another_members_session(self):
        other_member = Member.objects.create_user(is_active=True)
        foreign = RefreshToken.for_user(other_member)
        foreign_id = foreign.payload["jti"]
        from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

        foreign_token = OutstandingToken.objects.get(jti=foreign_id)
        response = self.client.delete(
            "/authn/sessions/",
            {"sessionId": str(foreign_token.pk)},
            format="json",
        )

        self.assertEqual(response.status_code, 404)
