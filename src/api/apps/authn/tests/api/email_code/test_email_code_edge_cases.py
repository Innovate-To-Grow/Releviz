"""Edge-case coverage for public email-code views and helpers."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from rest_framework import serializers
from rest_framework.test import APITestCase

from apps.authn.constants import RECOVERY_CHANNEL_UNAVAILABLE
from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.serializers.email_code.passwords import (
    ChangePasswordCodeRequestSerializer,
    ChangePasswordCodeVerifySerializer,
    PasswordResetConfirmSerializer,
)
from apps.authn.services import (
    AuthChallengeDeliveryError,
    AuthChallengeInvalid,
    AuthChallengeThrottled,
    NoRecoveryChannelError,
)
from apps.authn.views.helpers import challenge_error_response

Member = get_user_model()
PURPOSE_LOGIN = EmailAuthChallenge.Purpose.LOGIN
PURPOSE_REGISTER = EmailAuthChallenge.Purpose.REGISTER


class PasswordResetSerializerSecurityTests(APITestCase):
    @patch(
        "apps.authn.serializers.email_code.passwords.consume_verification_token",
        side_effect=AuthChallengeInvalid("internal challenge details"),
    )
    @patch("apps.authn.serializers.email_code.passwords.validate_password")
    def test_confirm_suppresses_internal_exception_context(self, _validate_password, _consume):
        serializer = PasswordResetConfirmSerializer()
        serializer._validated_data = {
            "decrypted_new_password": "StrongPass123!",
            "resolved_member": object(),
            "verification_token": "opaque-token",
        }

        with self.assertRaises(serializers.ValidationError) as raised:
            serializer.save()

        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertNotIn("internal challenge details", str(raised.exception.detail))

    @patch(
        "apps.authn.serializers.email_code.passwords.select_recovery_channel",
        side_effect=NoRecoveryChannelError("internal recovery diagnostics"),
    )
    def test_password_change_serializers_use_client_safe_recovery_error(self, _select):
        request = SimpleNamespace(user=object())
        serializer_classes = (
            ChangePasswordCodeRequestSerializer,
            ChangePasswordCodeVerifySerializer,
        )

        for serializer_class in serializer_classes:
            with self.subTest(serializer=serializer_class.__name__):
                serializer = serializer_class(context={"request": request})
                with self.assertRaises(serializers.ValidationError) as raised:
                    serializer.validate({})

                self.assertEqual(
                    str(raised.exception.detail["detail"]), RECOVERY_CHANNEL_UNAVAILABLE
                )
                self.assertIsNone(raised.exception.__cause__)
                self.assertTrue(raised.exception.__suppress_context__)
                self.assertNotIn("internal recovery diagnostics", str(raised.exception.detail))


class ChallengeErrorResponseTests(APITestCase):
    def test_throttled_returns_429(self):
        resp = challenge_error_response(AuthChallengeThrottled("slow"))
        self.assertEqual(resp.status_code, 429)

    def test_delivery_error_returns_503(self):
        resp = challenge_error_response(AuthChallengeDeliveryError("nope"))
        self.assertEqual(resp.status_code, 503)

    def test_unknown_exception_reraised(self):
        with self.assertRaises(ValueError):
            challenge_error_response(ValueError("unexpected"))


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class PublicEmailCodeViewEdgeTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.active = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.active,
            email_address="active@example.com",
            email_type="primary",
            verified=True,
        )
        self.inactive = Member.objects.create_user(password="StrongPass123!", is_active=False)
        ContactEmail.objects.create(
            member=self.inactive,
            email_address="inactive@example.com",
            email_type="primary",
            verified=True,
        )

    # ── invalid serializer payloads (return 400) ──────────

    def test_login_verify_invalid_payload(self, _c, _s):
        resp = self.client.post("/authn/login/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_email_auth_verify_invalid_payload(self, _c, _s):
        resp = self.client.post(
            "/authn/email-auth/verify-code/", {"email": "x@y.com", "code": "12"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_register_verify_invalid_payload(self, _c, _s):
        resp = self.client.post("/authn/register/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    # ── inactive member on login verify (lines 58-62) ─────

    def test_login_verify_inactive_member_rejected(self, _c, _s):
        from django.utils import timezone

        EmailAuthChallenge.objects.create(
            member=self.inactive,
            purpose=PURPOSE_LOGIN,
            target_email="inactive@example.com",
            code_hash=make_password("654321"),
            expires_at=timezone.now() + timedelta(minutes=10),
            max_attempts=5,
            last_sent_at=timezone.now(),
        )
        resp = self.client.post(
            "/authn/login/verify-code/",
            {"email": "inactive@example.com", "code": "654321"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            EmailAuthChallenge.objects.get(member=self.inactive, purpose=PURPOSE_LOGIN).status,
            EmailAuthChallenge.Status.PENDING,
        )

    # ── unified verify login-with-inactive (lines 91-95) ──

    def test_email_auth_verify_inactive_login_rejected(self, _c, _s):
        from django.utils import timezone

        # A LOGIN-purpose challenge for an inactive member -> flow="login" + inactive -> 400.
        EmailAuthChallenge.objects.create(
            member=self.inactive,
            purpose=PURPOSE_LOGIN,
            target_email="inactive@example.com",
            code_hash=make_password("654321"),
            expires_at=timezone.now() + timedelta(minutes=10),
            max_attempts=5,
            last_sent_at=timezone.now(),
        )
        resp = self.client.post(
            "/authn/email-auth/verify-code/",
            {"email": "inactive@example.com", "code": "654321"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            EmailAuthChallenge.objects.get(member=self.inactive, purpose=PURPOSE_LOGIN).status,
            EmailAuthChallenge.Status.PENDING,
        )

    # ── resend code view (line 140) ───────────────────────

    def test_register_resend_code_for_pending_member(self, _c, mock_send):
        pending = Member.objects.create_user(password="StrongPass123!", is_active=False)
        ContactEmail.objects.create(
            member=pending,
            email_address="pending@example.com",
            email_type="primary",
            verified=False,
        )
        resp = self.client.post(
            "/authn/register/resend-code/",
            {"email": "pending@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 202)
        mock_send.assert_called()

    def test_register_resend_code_no_pending_returns_400(self, _c, _s):
        resp = self.client.post(
            "/authn/register/resend-code/",
            {"email": "nobody@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    # ── request_code_response delivery failure (helpers) ──

    def test_login_request_code_delivery_error_returns_503(self, _c, mock_send):
        mock_send.side_effect = AuthChallengeDeliveryError("ses down")
        resp = self.client.post(
            "/authn/login/request-code/",
            {"email": "active@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 503)

    # ── unified request-code registration path (_create_pending_member) ──

    def test_email_auth_request_creates_pending_member_for_new_email(self, _c, mock_send):
        resp = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "brandnew@example.com", "source": "subscribe"},
            format="json",
        )
        self.assertEqual(resp.status_code, 202)
        # A pending (inactive) member with an unclaimed-then-claimed contact email is created.
        contact = ContactEmail.objects.get(email_address="brandnew@example.com")
        self.assertIsNotNone(contact.member)
        self.assertFalse(contact.member.is_active)
        mock_send.assert_called()

    def test_email_auth_request_claims_unclaimed_contact_email(self, _c, mock_send):
        # An unclaimed ContactEmail should be claimed by the new pending member.
        ContactEmail.objects.create(
            email_address="unclaimed@example.com", email_type="primary", member=None, verified=False
        )
        resp = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "unclaimed@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 202)
        contact = ContactEmail.objects.get(email_address="unclaimed@example.com")
        self.assertIsNotNone(contact.member)

    def test_email_auth_request_existing_active_member_logs_in(self, _c, mock_send):
        resp = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "active@example.com"},
            format="json",
        )
        self.assertEqual(resp.status_code, 202)
        # A LOGIN challenge is issued for the existing active member.
        self.assertTrue(
            EmailAuthChallenge.objects.filter(member=self.active, purpose=PURPOSE_LOGIN).exists()
        )

    def test_email_auth_request_reuses_pending_member(self, _c, mock_send):
        resp = self.client.post(
            "/authn/email-auth/request-code/",
            {"email": "inactive@example.com"},
            format="json",
        )
        # inactive member already owns a primary contact -> pending_member path reused.
        self.assertEqual(resp.status_code, 202)
        self.assertTrue(
            EmailAuthChallenge.objects.filter(
                member=self.inactive, purpose=PURPOSE_REGISTER
            ).exists()
        )


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class RegisterViewEdgeTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_register_invalid_payload(self, _c, _s):
        resp = self.client.post("/authn/register/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_register_save_delivery_error_returns_503(self, _c, mock_send):
        mock_send.side_effect = AuthChallengeDeliveryError("ses down")
        resp = self.client.post(
            "/authn/register/",
            {
                "email": "newbie@example.com",
                "password": "PlaintextPass123!",
                "password_confirm": "PlaintextPass123!",
                "first_name": "New",
                "last_name": "Bie",
                "organization": "Acme",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 503)

    def test_password_reset_verify_invalid_payload(self, _c, _s):
        resp = self.client.post("/authn/password-reset/verify-code/", {}, format="json")
        self.assertEqual(resp.status_code, 400)
