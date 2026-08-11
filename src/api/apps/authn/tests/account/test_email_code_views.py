"""Edge-case coverage for authenticated email-code account views.

Targets apps/authn/views/account/email_code.py error branches:
- invalid serializer payloads (400)
- ValidationError raised in save() (400)
- generic challenge errors routed through challenge_error_response (429)
- AuthChallengeInvalid in confirm flows (400)
"""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework import serializers
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail
from apps.authn.services import AuthChallengeThrottled

Member = get_user_model()


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class ChangePasswordCodeViewEdgeTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        self.email = ContactEmail.objects.create(
            member=self.member,
            email_address="member@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(user=self.member)

    def test_request_code_validation_error_returns_400(self, _code, _send):
        """save() raising serializers.ValidationError -> 400 with the detail (lines 47-48)."""
        with patch(
            "apps.authn.serializers.email_code.passwords.issue_email_challenge",
            side_effect=serializers.ValidationError({"email": ["bad"]}),
        ):
            resp = self.client.post(
                "/authn/change-password/request-code/",
                {"email": self.email.email_address},
                format="json",
            )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("email", resp.data)

    def test_request_code_throttled_returns_429(self, _code, _send):
        """save() raising AuthChallengeThrottled -> challenge_error_response -> 429 (lines 49-50)."""
        with patch(
            "apps.authn.serializers.email_code.passwords.issue_email_challenge",
            side_effect=AuthChallengeThrottled("slow down"),
        ):
            resp = self.client.post(
                "/authn/change-password/request-code/",
                {"email": self.email.email_address},
                format="json",
            )
        self.assertEqual(resp.status_code, 429)

    def test_verify_code_invalid_payload_returns_400(self, _code, _send):
        """Missing code -> serializer invalid -> 400 (line 62)."""
        resp = self.client.post("/authn/change-password/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_confirm_invalid_payload_returns_400(self, _code, _send):
        """Missing fields -> serializer invalid -> 400 (line 75)."""
        resp = self.client.post("/authn/change-password/confirm/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_confirm_invalid_token_returns_400(self, _code, _send):
        """A bogus verification token -> AuthChallengeInvalid -> 400 (lines 78-79)."""
        from apps.authn.constants import VERIFICATION_LINK_INVALID

        resp = self.client.post(
            "/authn/change-password/confirm/",
            {
                "verification_token": "not-a-real-token",
                "new_password": "BrandNewPass123!",
                "new_password_confirm": "BrandNewPass123!",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.data["detail"], VERIFICATION_LINK_INVALID)
        # Password unchanged.
        self.member.refresh_from_db()
        self.assertTrue(self.member.check_password("StrongPass123!"))


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class DeleteAccountCodeViewEdgeTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        self.email = ContactEmail.objects.create(
            member=self.member,
            email_address="delete@example.com",
            email_type="primary",
            verified=True,
        )
        self.client.force_authenticate(user=self.member)

    def test_request_code_without_primary_email_returns_400(self, _code, _send):
        """When the member has no primary email, serializer.save() raises
        ValidationError and the view returns 400 with the error detail."""
        # Drop the primary email so DeleteAccountCodeRequestSerializer.save()
        # hits its "no primary email" ValidationError branch.
        self.email.delete()

        resp = self.client.post("/authn/delete-account/request-code/", {}, format="json")

        self.assertEqual(resp.status_code, 400)
        self.assertIn("detail", resp.data)
        self.assertIn("detail", resp.data)

    def test_request_code_validation_error_no_primary_email(self, _code, _send):
        """No primary email -> serializer.save() raises ValidationError -> 400 (lines 94-95)."""
        # Remove the primary email so get_primary_email() returns falsy.
        self.email.delete()
        resp = self.client.post("/authn/delete-account/request-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("No verified email", str(resp.data))

    def test_request_code_throttled_returns_429(self, _code, _send):
        """save() raising AuthChallengeThrottled -> challenge_error_response -> 429 (lines 96-97)."""
        with patch(
            "apps.authn.serializers.email_code.passwords.issue_email_challenge",
            side_effect=AuthChallengeThrottled("slow down"),
        ):
            resp = self.client.post("/authn/delete-account/request-code/", {}, format="json")
        self.assertEqual(resp.status_code, 429)

    def test_confirm_invalid_payload_returns_400(self, _code, _send):
        """Missing verification token -> serializer invalid -> 400 (line 122)."""
        resp = self.client.post("/authn/delete-account/confirm/", {}, format="json")
        self.assertEqual(resp.status_code, 400)
        # Member still exists.
        self.assertTrue(Member.objects.filter(pk=self.member.pk).exists())
