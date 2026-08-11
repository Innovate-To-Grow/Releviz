"""Passwordless phone-auth: validation, error mapping, throttling, enumeration."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactPhone
from apps.authn.services import (
    PhoneVerificationDeliveryError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
)

Member = get_user_model()

REQUEST_URL = "/authn/phone-auth/request-code/"
VERIFY_URL = "/authn/phone-auth/verify-code/"


@patch("apps.authn.services.sms.start_phone_verification", return_value="pending")
class PhoneAuthEdgeCaseTests(APITestCase):
    # noinspection PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    # ── Verify error mapping ─────────────────────────────
    @patch("apps.authn.views.auth.phone_code.check_phone_verification", side_effect=PhoneVerificationInvalid())
    def test_invalid_or_consumed_code_returns_400(self, _check, _start):
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "000000"}, format="json")
        self.assertEqual(response.status_code, 400)

    @patch("apps.authn.views.auth.phone_code.check_phone_verification", side_effect=PhoneVerificationThrottled())
    def test_verify_too_many_attempts_returns_429(self, _check, _start):
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "000000"}, format="json")
        self.assertEqual(response.status_code, 429)

    @patch("apps.authn.views.auth.phone_code.check_phone_verification", side_effect=PhoneVerificationDeliveryError())
    def test_verify_when_sms_unconfigured_returns_503(self, _check, _start):
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "654321"}, format="json")
        self.assertEqual(response.status_code, 503)

    # ── Request error mapping ────────────────────────────
    def test_request_throttled_returns_429(self, mock_start):
        mock_start.side_effect = PhoneVerificationThrottled()
        response = self.client.post(REQUEST_URL, {"phone_number": "2025550123"}, format="json")
        self.assertEqual(response.status_code, 429)

    def test_request_delivery_error_returns_503(self, mock_start):
        mock_start.side_effect = PhoneVerificationDeliveryError()
        response = self.client.post(REQUEST_URL, {"phone_number": "2025550123"}, format="json")
        self.assertEqual(response.status_code, 503)

    # ── Serializer validation ────────────────────────────
    def test_rejects_short_phone(self, _start):
        response = self.client.post(REQUEST_URL, {"phone_number": "123"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_rejects_non_digit_phone(self, _start):
        response = self.client.post(REQUEST_URL, {"phone_number": "abcdefghij"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_rejects_invalid_region(self, _start):
        response = self.client.post(REQUEST_URL, {"phone_number": "2025550123", "region": "999-XX"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_verify_rejects_bad_code_shape(self, _start):
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "12"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_verify_rejects_right_length_non_digit_code(self, _start):
        # 6 chars clears the length check, so the digit-regex guard in
        # validate_code is what rejects it.
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "12a45z"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_request_accepts_known_source(self, _start):
        response = self.client.post(REQUEST_URL, {"phone_number": "2025550123", "source": "subscribe"}, format="json")
        self.assertEqual(response.status_code, 202)

    def test_request_rejects_unknown_source(self, _start):
        response = self.client.post(REQUEST_URL, {"phone_number": "2025550123", "source": "bogus"}, format="json")
        self.assertEqual(response.status_code, 400)

    # ── Abuse / enumeration ──────────────────────────────
    def test_request_rate_limited_per_ip(self, _start):
        statuses = [
            self.client.post(REQUEST_URL, {"phone_number": "2025550123"}, format="json").status_code for _ in range(6)
        ]
        self.assertEqual(statuses[0], 202)
        self.assertEqual(statuses[-1], 429)

    def test_request_does_not_reveal_account_existence(self, _start):
        member = Member.objects.create_user(is_active=True)
        ContactPhone.objects.create(member=member, phone_number="2025550999", region="1-US", verified=True)
        r_existing = self.client.post(REQUEST_URL, {"phone_number": "2025550999"}, format="json")
        r_new = self.client.post(REQUEST_URL, {"phone_number": "2025550123"}, format="json")
        self.assertEqual(r_existing.status_code, 202)
        self.assertEqual(r_new.status_code, 202)
        self.assertEqual(r_existing.data["message"], r_new.data["message"])
