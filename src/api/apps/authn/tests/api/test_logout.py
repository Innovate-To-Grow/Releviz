"""Tests for LogoutView — refresh-token blacklisting on user logout."""

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
            member=self.member, email_address="logout@example.com", email_type="primary", verified=True
        )

    def test_logout_blacklists_refresh_token(self):
        refresh = RefreshToken.for_user(self.member)
        response = self.client.post("/authn/logout/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(response.status_code, 204)

        # Using the blacklisted refresh token must now fail.
        followup = self.client.post("/authn/refresh/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(followup.status_code, 401)

    def test_logout_rejects_missing_refresh(self):
        response = self.client.post("/authn/logout/", {}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_logout_rejects_invalid_refresh(self):
        response = self.client.post("/authn/logout/", {"refresh": "not-a-real-token"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_logout_does_not_require_authentication(self):
        """An already-expired access token should not block logout."""
        refresh = RefreshToken.for_user(self.member)
        self.client.credentials()  # no Authorization header
        response = self.client.post("/authn/logout/", {"refresh": str(refresh)}, format="json")
        self.assertEqual(response.status_code, 204)
