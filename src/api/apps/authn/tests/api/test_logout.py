"""Tests for LogoutView — refresh-token blacklisting on user logout."""

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail

Member = get_user_model()


class LogoutViewTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.member,
            email_address="logout@example.com",
            email_type="primary",
            verified=True,
        )

    def test_logout_blacklists_refresh_token(self):
        refresh = RefreshToken.for_user(self.member)
        response = self.client.post("/authn/logout/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(response.status_code, 204)

        # Using the blacklisted refresh token must now fail.
        followup = self.client.post("/authn/refresh/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(followup.status_code, 401)

    def test_logout_without_session_is_idempotent(self):
        response = self.client.post("/authn/logout/", {}, format="json")
        self.assertEqual(response.status_code, 204)

    def test_logout_blacklists_cookie_refresh_and_clears_cookie(self):
        refresh = RefreshToken.for_user(self.member)
        self.client.cookies[settings.AUTH_REFRESH_COOKIE_NAME] = str(refresh)

        response = self.client.post("/authn/logout/", {}, format="json")

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.cookies[settings.AUTH_REFRESH_COOKIE_NAME]["max-age"], 0)
        followup = self.client.post("/authn/refresh/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(followup.status_code, 401)

    def test_logout_with_invalid_refresh_is_idempotent_and_clears_cookie(self):
        self.client.cookies[settings.AUTH_REFRESH_COOKIE_NAME] = "not-a-real-token"
        response = self.client.post(
            "/authn/logout/", {"refresh": "not-a-real-token"}, format="json"
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.cookies[settings.AUTH_REFRESH_COOKIE_NAME]["max-age"], 0)

    def test_logout_with_already_blacklisted_refresh_is_idempotent(self):
        refresh = RefreshToken.for_user(self.member)
        refresh.blacklist()
        self.client.cookies[settings.AUTH_REFRESH_COOKIE_NAME] = str(refresh)

        response = self.client.post("/authn/logout/", {}, format="json")

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.cookies[settings.AUTH_REFRESH_COOKIE_NAME]["max-age"], 0)

    def test_logout_does_not_require_authentication(self):
        """An already-expired access token should not block logout."""
        refresh = RefreshToken.for_user(self.member)
        self.client.credentials()  # no Authorization header
        response = self.client.post("/authn/logout/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(response.status_code, 204)
