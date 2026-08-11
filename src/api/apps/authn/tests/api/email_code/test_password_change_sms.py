"""Password create/change via SMS verification, and channel selection.

Covers the phone-only initial-password path (SMS OTP -> token -> confirm), the
OTP failure modes (wrong / throttled / reused / expired), and the
verification-channel selection order (verified primary email -> any verified
email -> verified phone via SMS).
"""

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.authn.constants import RECOVERY_CHANNEL_UNAVAILABLE
from apps.authn.models import (
    ContactEmail,
    ContactPhone,
    EmailAuthChallenge,
    PhoneVerificationChallenge,
)
from apps.authn.services import (
    PhoneVerificationDeliveryError,
    verify_sms_password_code_and_mint,
)

Member = get_user_model()

REQUEST_URL = "/authn/change-password/request-code/"
VERIFY_URL = "/authn/change-password/verify-code/"
CONFIRM_URL = "/authn/change-password/confirm/"
RESET_REQUEST_URL = "/authn/password-reset/request-code/"
RESET_VERIFY_URL = "/authn/password-reset/verify-code/"
NEW_PASSWORD = "SmsCreatedPass123!"


@patch("apps.authn.services.account.sms_password._check_phone_verification")
@patch("apps.authn.services.account.sms_password.start_phone_verification")
class PhoneOnlyPasswordCreateViaSmsTests(APITestCase):
    """A phone-only account (verified phone, no email, unusable password)."""

    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(is_active=True, first_name="Pat", last_name="Phone")
        self.member.set_unusable_password()
        self.member.save()
        self.phone = ContactPhone.objects.create(
            member=self.member, phone_number="2095551234", region="1-US", verified=True
        )
        self.client.force_authenticate(user=self.member)

    def _request_and_verify(self, mock_start, mock_check):
        mock_start.return_value = {"status": "pending", "challenge_id": str(uuid.uuid4())}
        mock_check.return_value = (object(), "approved")
        request = self.client.post(REQUEST_URL, {}, format="json")
        self.assertEqual(request.status_code, 202)
        self.assertEqual(request.data["channel"], "sms")
        verify = self.client.post(VERIFY_URL, {"code": "123456"}, format="json")
        self.assertEqual(verify.status_code, 200)
        return verify.data["verification_token"]

    def test_request_selects_sms_and_sends_code(self, mock_start, _mock_check):
        challenge_id = str(uuid.uuid4())
        mock_start.return_value = {"status": "pending", "challenge_id": challenge_id}
        response = self.client.post(REQUEST_URL, {}, format="json")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["channel"], "sms")
        self.assertEqual(response.data["challenge_id"], challenge_id)
        self.assertIn("4", response.data["destination"])  # last 4 digits surfaced, rest masked
        mock_start.assert_called_once_with(
            "+12095551234",
            purpose=EmailAuthChallenge.Purpose.PASSWORD_CHANGE,
            member=self.member,
            context_identifier=f"{EmailAuthChallenge.Purpose.PASSWORD_CHANGE}:{self.member.pk}",
        )

    def test_password_change_sms_delivery_failure_is_not_reported_as_sent(self, mock_start, _mock_check):
        mock_start.side_effect = PhoneVerificationDeliveryError("provider unavailable")

        response = self.client.post(REQUEST_URL, {}, format="json")

        self.assertEqual(response.status_code, 503)
        self.assertNotEqual(response.data.get("message"), "Verification code sent.")

    def test_password_reset_request_returns_enumeration_safe_challenge_id(self, mock_start, _mock_check):
        challenge_id = str(uuid.uuid4())
        mock_start.return_value = {"status": "pending", "challenge_id": challenge_id}

        response = self.client.post(
            RESET_REQUEST_URL,
            {"identifier": "2095551234"},
            format="json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["challenge_id"], challenge_id)
        mock_start.assert_called_once_with(
            "+12095551234",
            purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
            member=self.member,
            context_identifier=f"{EmailAuthChallenge.Purpose.PASSWORD_RESET}:{self.member.pk}",
        )

    def test_password_reset_verify_accepts_challenge_id(self, _mock_start, mock_check):
        challenge_id = uuid.uuid4()
        mock_check.return_value = (object(), "approved")

        response = self.client.post(
            RESET_VERIFY_URL,
            {
                "identifier": "2095551234",
                "code": "123456",
                "challenge_id": str(challenge_id),
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        mock_check.assert_called_once_with(
            phone_number="+12095551234",
            code="123456",
            challenge_id=challenge_id,
            purpose=EmailAuthChallenge.Purpose.PASSWORD_RESET,
            member=self.member,
            context_identifier=f"{EmailAuthChallenge.Purpose.PASSWORD_RESET}:{self.member.pk}",
            consume=True,
        )

    def test_phone_only_user_creates_initial_password_via_sms(self, mock_start, mock_check):
        token = self._request_and_verify(mock_start, mock_check)
        mock_check.assert_called_once_with(
            phone_number="+12095551234",
            code="123456",
            challenge_id=None,
            purpose=EmailAuthChallenge.Purpose.PASSWORD_CHANGE,
            member=self.member,
            context_identifier=f"{EmailAuthChallenge.Purpose.PASSWORD_CHANGE}:{self.member.pk}",
            consume=True,
        )

        confirm = self.client.post(
            CONFIRM_URL,
            {"verification_token": token, "new_password": NEW_PASSWORD, "new_password_confirm": NEW_PASSWORD},
            format="json",
        )
        self.assertEqual(confirm.status_code, 200)
        self.member.refresh_from_db()
        self.assertTrue(self.member.check_password(NEW_PASSWORD))

    def test_wrong_otp_does_not_mint_a_token(self, _mock_start, mock_check):
        self.client.post(REQUEST_URL, {}, format="json")
        mock_check.return_value = (None, "invalid")
        verify = self.client.post(VERIFY_URL, {"code": "000000"}, format="json")
        self.assertEqual(verify.status_code, 400)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                member=self.member,
                purpose=EmailAuthChallenge.Purpose.PASSWORD_CHANGE,
                status=EmailAuthChallenge.Status.VERIFIED,
            ).exists()
        )

    def test_over_attempted_otp_is_rejected(self, _mock_start, mock_check):
        self.client.post(REQUEST_URL, {}, format="json")
        mock_check.return_value = (None, "throttled")
        verify = self.client.post(VERIFY_URL, {"code": "000000"}, format="json")
        self.assertEqual(verify.status_code, 400)

    def test_reused_token_cannot_create_password_twice(self, mock_start, _mock_check):
        token = self._request_and_verify(mock_start, _mock_check)
        first = self.client.post(
            CONFIRM_URL,
            {"verification_token": token, "new_password": NEW_PASSWORD, "new_password_confirm": NEW_PASSWORD},
            format="json",
        )
        self.assertEqual(first.status_code, 200)
        second = self.client.post(
            CONFIRM_URL,
            {"verification_token": token, "new_password": "OtherPass456!", "new_password_confirm": "OtherPass456!"},
            format="json",
        )
        self.assertEqual(second.status_code, 400)

    def test_expired_token_cannot_create_password(self, mock_start, _mock_check):
        token = self._request_and_verify(mock_start, _mock_check)
        # Force the minted challenge to look expired.
        EmailAuthChallenge.objects.filter(
            member=self.member, purpose=EmailAuthChallenge.Purpose.PASSWORD_CHANGE
        ).update(expires_at=timezone.now() - timezone.timedelta(minutes=1))
        confirm = self.client.post(
            CONFIRM_URL,
            {"verification_token": token, "new_password": NEW_PASSWORD, "new_password_confirm": NEW_PASSWORD},
            format="json",
        )
        self.assertEqual(confirm.status_code, 400)

    def test_no_verified_contact_returns_clear_error(self, _mock_start, _mock_check):
        # Remove the verified phone so no recovery channel remains.
        self.phone.delete()
        response = self.client.post(REQUEST_URL, {}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(str(response.data["detail"][0]), RECOVERY_CHANNEL_UNAVAILABLE)


class SmsPasswordAtomicityTests(APITestCase):
    def setUp(self):
        self.member = Member.objects.create_user(is_active=True)
        self.e164 = "+12095551234"
        self.purpose = EmailAuthChallenge.Purpose.PASSWORD_CHANGE
        self.challenge = PhoneVerificationChallenge.objects.create(
            phone_number=self.e164,
            purpose=self.purpose,
            member=self.member,
            context_identifier=f"{self.purpose}:{self.member.pk}",
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timezone.timedelta(minutes=10),
        )

    def test_token_insert_failure_rolls_back_sms_consumption(self):
        with (
            patch.object(
                EmailAuthChallenge.objects,
                "create",
                side_effect=RuntimeError("token row unavailable"),
            ),
            self.assertRaises(RuntimeError),
        ):
            verify_sms_password_code_and_mint(
                member=self.member,
                purpose=self.purpose,
                e164=self.e164,
                code="123456",
                challenge_id=self.challenge.pk,
            )

        self.challenge.refresh_from_db()
        self.assertEqual(self.challenge.status, PhoneVerificationChallenge.Status.PENDING)
        self.assertFalse(
            EmailAuthChallenge.objects.filter(
                member=self.member,
                purpose=self.purpose,
                channel=EmailAuthChallenge.Channel.SMS,
            ).exists()
        )


@patch("apps.authn.services.email.send_email.send_verification_email")
@patch("apps.authn.services.email.challenges._random_code", return_value="654321")
class PasswordChannelSelectionTests(APITestCase):
    """The change-password flow prefers a verified email over SMS when one exists."""

    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(is_active=True, first_name="Eve", last_name="Email")
        self.member.set_unusable_password()
        self.member.save()
        ContactPhone.objects.create(member=self.member, phone_number="2095559999", region="1-US", verified=True)
        self.client.force_authenticate(user=self.member)

    def _email_flow(self, email_address):
        request = self.client.post(REQUEST_URL, {}, format="json")
        self.assertEqual(request.status_code, 202)
        self.assertEqual(request.data["channel"], "email")
        verify = self.client.post(VERIFY_URL, {"email": email_address, "code": "654321"}, format="json")
        self.assertEqual(verify.status_code, 200)
        token = verify.data["verification_token"]
        confirm = self.client.post(
            CONFIRM_URL,
            {"verification_token": token, "new_password": NEW_PASSWORD, "new_password_confirm": NEW_PASSWORD},
            format="json",
        )
        self.assertEqual(confirm.status_code, 200)
        self.member.refresh_from_db()
        self.assertTrue(self.member.check_password(NEW_PASSWORD))

    def test_phone_first_user_can_create_password_after_verifying_email(self, _mock_code, _mock_send):
        # Phone-first member adds a (now primary) verified email, then sets a password.
        ContactEmail.objects.create(
            member=self.member, email_address="eve@example.com", email_type="primary", verified=True
        )
        self._email_flow("eve@example.com")

    def test_verified_non_primary_email_used_when_no_primary(self, _mock_code, _mock_send):
        # No primary email exists, only a verified secondary; it must still work.
        ContactEmail.objects.create(
            member=self.member, email_address="eve-alt@example.com", email_type="secondary", verified=True
        )
        self.assertEqual(self.member.get_primary_email(), "")
        self._email_flow("eve-alt@example.com")
