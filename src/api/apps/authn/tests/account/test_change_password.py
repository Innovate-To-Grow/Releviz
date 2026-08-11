"""Tests for ChangePasswordView (direct password change, authenticated)."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.models import ContactEmail

Member = get_user_model()


class ChangePasswordViewTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="OldPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="chgpwd@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    def test_change_password_success(self):
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Password changed successfully.")

    def test_new_password_works_for_login(self):
        self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
            },
            format="json",
        )
        self.member.refresh_from_db()
        self.assertTrue(self.member.check_password("NewSecure456!"))
        self.assertFalse(self.member.check_password("OldPass123!"))

    def test_wrong_current_password_returns_400(self):
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "WrongPass!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("current_password", response.data)

    def test_mismatched_new_passwords_returns_400(self):
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "Mismatch789!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("new_password_confirm", response.data)

    def test_short_new_password_returns_400(self):
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "short",
                "new_password_confirm": "short",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("new_password", response.data)

    def test_unauthenticated_returns_401(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 401)

    def test_with_refresh_token_blacklists_and_returns_new_tokens(self):
        refresh = RefreshToken.for_user(self.member)
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
                "refresh": str(refresh),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.data)
        self.assertIn("refresh", response.data)

        # Old refresh token should be blacklisted — using it again should fail
        old_refresh_response = self.client.post(
            "/authn/refresh/",
            {"refresh": str(refresh)},
            format="json",
        )
        self.assertEqual(old_refresh_response.status_code, 401)

    def test_without_refresh_token_no_new_tokens(self):
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": "OldPass123!",
                "new_password": "NewSecure456!",
                "new_password_confirm": "NewSecure456!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access", response.data)
        self.assertNotIn("refresh", response.data)
