"""Tests for REQUIRE_ENCRYPTED_PASSWORDS guard across all password endpoints (S3 fix)."""

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail

Member = get_user_model()


@override_settings(REQUIRE_ENCRYPTED_PASSWORDS=True)
class RequireEncryptedPasswordsTests(APITestCase):
    """Verify that plaintext passwords are rejected when encryption is required."""

    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.password = "StrongPass123!"
        self.member = Member.objects.create_user(
            password=self.password,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="enctest@example.com", email_type="primary", verified=True
        )

    def test_login_rejects_plaintext_when_encryption_required(self):
        response = self.client.post(
            "/authn/login/",
            {"email": "enctest@example.com", "password": self.password},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Encrypted password required", str(response.data))

    def test_register_rejects_plaintext_when_encryption_required(self):
        response = self.client.post(
            "/authn/register/",
            {
                "email": "new@example.com",
                "password": self.password,
                "password_confirm": self.password,
                "first_name": "New",
                "last_name": "User",
                "organization": "Individual",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Encrypted password required", str(response.data))

    def test_change_password_rejects_plaintext_when_encryption_required(self):
        self.client.force_authenticate(user=self.member)
        response = self.client.post(
            "/authn/change-password/",
            {
                "current_password": self.password,
                "new_password": "NewStrong123!",
                "new_password_confirm": "NewStrong123!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Encrypted password required", str(response.data))

    def test_password_reset_confirm_rejects_plaintext_when_encryption_required(self):
        response = self.client.post(
            "/authn/password-reset/confirm/",
            {
                "email": "enctest@example.com",
                "verification_token": "fake-token",
                "new_password": "NewStrong123!",
                "new_password_confirm": "NewStrong123!",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Encrypted password required", str(response.data))
