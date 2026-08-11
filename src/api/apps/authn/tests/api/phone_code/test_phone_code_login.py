"""Passwordless phone-auth: existing-account (login) flow."""

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactPhone

Member = get_user_model()

VERIFY_URL = "/authn/phone-auth/verify-code/"


def approve_phone_verification(
    phone_number,
    _code,
    *,
    approved_callback,
    **_kwargs,
):
    return approved_callback(
        SimpleNamespace(phone_number=phone_number or "+12025550123"),
    )


@patch(
    "apps.authn.views.auth.phone_code.check_phone_verification",
    side_effect=approve_phone_verification,
)
@patch("apps.authn.services.sms.start_phone_verification", return_value="pending")
class PhoneAuthLoginTests(APITestCase):
    # noinspection PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.member = Member.objects.create_user(
            password="StrongPass123!", is_active=True, first_name="Jo", last_name="Doe"
        )
        self.contact = ContactPhone.objects.create(
            member=self.member, phone_number="2025550123", region="1-US", verified=True
        )

    def test_verify_existing_active_member_logs_in_without_new_member(self, _mock_start, _mock_check):
        before = Member.objects.count()
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "654321"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Login successful.")
        self.assertEqual(response.data["user"]["member_uuid"], str(self.member.id))
        self.assertEqual(response.data["user"]["phone"], "+12025550123")
        self.assertEqual(Member.objects.count(), before)
        # Member already has a name, so no profile completion is required.
        self.assertFalse(response.data["requires_profile_completion"])
        self.assertEqual(response.data["next_step"], "account")

    def test_verify_marks_unverified_existing_phone_verified_on_login(self, _mock_start, _mock_check):
        self.contact.verified = False
        self.contact.save(update_fields=["verified"])
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "654321"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Login successful.")
        self.contact.refresh_from_db()
        self.assertTrue(self.contact.verified)

    def test_verify_inactive_member_is_rejected_without_reactivation(self, _mock_start, _mock_check):
        # Phone login must not revive a deactivated account; it returns the same
        # generic invalid-code 400 as the email flow and leaves it disabled.
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        response = self.client.post(VERIFY_URL, {"phone_number": "2025550123", "code": "654321"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["detail"], "Verification code is invalid or has expired.")
        self.assertNotIn("access", response.data)  # no JWT issued → no login
        self.member.refresh_from_db()
        self.assertFalse(self.member.is_active)

    def test_verify_matches_formatted_input_to_existing_account(self, _mock_start, _mock_check):
        before = Member.objects.count()
        response = self.client.post(VERIFY_URL, {"phone_number": "(202) 555-0123", "code": "654321"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Login successful.")
        self.assertEqual(Member.objects.count(), before)
