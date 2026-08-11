from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail, ContactPhone
from apps.authn.services import (
    PhoneVerificationDeliveryError,
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
)
from apps.authn.services.email.challenges import AuthChallengeInvalid

Member = get_user_model()


class ContactPhoneTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member, email_address="primary@example.com", email_type="primary", verified=True
        )
        self.other_member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.other_member, email_address="other@example.com", email_type="primary", verified=True
        )
        self.client.force_authenticate(user=self.member)

    # ── List ─────────────────────────────────────────────

    def test_list_contact_phones_empty(self):
        response = self.client.get("/authn/contact-phones/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, [])

    def test_list_returns_own_phones_only(self):
        ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        ContactPhone.objects.create(member=self.other_member, phone_number="2025555678", region="1-US")
        response = self.client.get("/authn/contact-phones/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["phone_number"], "2025551234")

    # ── Create ───────────────────────────────────────────

    def test_create_contact_phone(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "2025551234", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["phone_number"], "2025551234")
        self.assertEqual(response.data["region"], "1-US")
        self.assertEqual(response.data["region_display"], "United States")
        self.assertFalse(response.data["subscribe"])
        self.assertFalse(response.data["verified"])
        self.assertIn("id", response.data)
        self.assertIn("created_at", response.data)

    def test_create_with_subscribe(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "2025551234", "region": "1-US", "subscribe": True},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["subscribe"])

    def test_create_normalizes_formatted_number(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "(202) 555-1234", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["phone_number"], "2025551234")

    def test_create_strips_country_code_prefix(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "+12025551234", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["phone_number"], "2025551234")

    def test_create_rejects_duplicate(self):
        ContactPhone.objects.create(member=self.other_member, phone_number="2025551234", region="1-US")
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "2025551234", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_too_short(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "123", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_too_long(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "1234567890123456", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_non_us_length(self):
        # US-only: a 7-9 digit number must be rejected (was accepted under the old 7-15 bounds).
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "5551234"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_invalid_region(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "2025551234", "region": "999-XX"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_rejects_non_digits(self):
        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "abc1234567", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_create_reclaims_soft_deleted(self):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        phone.delete()  # soft-delete
        self.assertFalse(ContactPhone.objects.filter(pk=phone.pk).exists())

        response = self.client.post(
            "/authn/contact-phones/",
            {"phone_number": "+12025551234", "region": "1-US"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["phone_number"], "2025551234")

    # ── Update (subscribe toggle) ──────────────────────

    def test_patch_subscribe_toggle(self):
        phone = ContactPhone.objects.create(
            member=self.member, phone_number="2025551234", region="1-US", subscribe=False
        )
        response = self.client.patch(
            f"/authn/contact-phones/{phone.pk}/",
            {"subscribe": True},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["subscribe"])

        phone.refresh_from_db()
        self.assertTrue(phone.subscribe)

    def test_cannot_patch_other_users_phone(self):
        phone = ContactPhone.objects.create(member=self.other_member, phone_number="2025551234", region="1-US")
        response = self.client.patch(
            f"/authn/contact-phones/{phone.pk}/",
            {"subscribe": True},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

    # ── Delete ───────────────────────────────────────────

    def test_delete_returns_204(self):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.delete(f"/authn/contact-phones/{phone.pk}/")
        self.assertEqual(response.status_code, 204)

        # Soft-deleted: not visible via objects
        self.assertFalse(ContactPhone.objects.filter(pk=phone.pk).exists())

    # ── Scoping ──────────────────────────────────────────

    def test_cannot_delete_other_users_phone(self):
        phone = ContactPhone.objects.create(member=self.other_member, phone_number="2025551234", region="1-US")
        response = self.client.delete(f"/authn/contact-phones/{phone.pk}/")
        self.assertEqual(response.status_code, 404)

    # ── Patch validation ─────────────────────────────────

    def test_patch_invalid_payload_returns_400(self):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.patch(
            f"/authn/contact-phones/{phone.pk}/",
            {"subscribe": "not-a-bool-value-xyz"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    # ── Request verification ─────────────────────────────

    @patch("apps.authn.views.account.contact_phones.request_phone_verification")
    def test_request_verification_success(self, mock_request):
        mock_request.return_value = {"message": "Verification code sent via SMS."}
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(f"/authn/contact-phones/{phone.pk}/request-verification/")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.data["message"], "Verification code sent via SMS.")

    @patch("apps.authn.views.account.contact_phones.request_phone_verification")
    def test_request_verification_is_rate_limited_per_user(self, mock_request):
        # An authenticated caller cannot pump unlimited SMS (real SNS spend): the
        # per-user throttle (5/minute) fires regardless of destination rotation.
        from django.core.cache import cache

        cache.clear()
        self.addCleanup(cache.clear)
        mock_request.return_value = {"message": "sent"}
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        statuses = [
            self.client.post(f"/authn/contact-phones/{phone.pk}/request-verification/").status_code for _ in range(6)
        ]
        self.assertEqual(statuses[-1], 429)

    @patch("apps.authn.views.account.contact_phones.request_phone_verification")
    def test_request_verification_not_found_returns_400(self, mock_request):
        mock_request.side_effect = AuthChallengeInvalid("nope")
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(f"/authn/contact-phones/{phone.pk}/request-verification/")
        self.assertEqual(response.status_code, 400)

    @patch("apps.authn.views.account.contact_phones.request_phone_verification")
    def test_request_verification_throttled_returns_429(self, mock_request):
        mock_request.side_effect = PhoneVerificationThrottled()
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(f"/authn/contact-phones/{phone.pk}/request-verification/")
        self.assertEqual(response.status_code, 429)

    @patch("apps.authn.views.account.contact_phones.request_phone_verification")
    def test_request_verification_delivery_error_returns_503(self, mock_request):
        mock_request.side_effect = PhoneVerificationDeliveryError()
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(f"/authn/contact-phones/{phone.pk}/request-verification/")
        self.assertEqual(response.status_code, 503)

    # ── Verify code ──────────────────────────────────────

    def test_verify_code_invalid_payload_returns_400(self):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(
            f"/authn/contact-phones/{phone.pk}/verify-code/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    @patch("apps.authn.views.account.contact_phones.verify_phone_code")
    def test_verify_code_success(self, mock_verify):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        phone.verified = True
        mock_verify.return_value = phone
        response = self.client.post(
            f"/authn/contact-phones/{phone.pk}/verify-code/",
            {"code": "123456"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["verified"])

    @patch("apps.authn.views.account.contact_phones.verify_phone_code")
    def test_verify_code_auth_challenge_invalid_returns_400(self, mock_verify):
        mock_verify.side_effect = AuthChallengeInvalid("nope")
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(
            f"/authn/contact-phones/{phone.pk}/verify-code/",
            {"code": "123456"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    @patch("apps.authn.views.account.contact_phones.verify_phone_code")
    def test_verify_code_phone_verification_invalid_returns_400(self, mock_verify):
        mock_verify.side_effect = PhoneVerificationInvalid()
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(
            f"/authn/contact-phones/{phone.pk}/verify-code/",
            {"code": "123456"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    @patch("apps.authn.views.account.contact_phones.verify_phone_code")
    def test_verify_code_throttled_returns_429(self, mock_verify):
        mock_verify.side_effect = PhoneVerificationThrottled()
        phone = ContactPhone.objects.create(member=self.member, phone_number="2025551234", region="1-US")
        response = self.client.post(
            f"/authn/contact-phones/{phone.pk}/verify-code/",
            {"code": "123456"},
            format="json",
        )
        self.assertEqual(response.status_code, 429)

    # ── Auth required ────────────────────────────────────

    def test_unauthenticated_list_rejected(self):
        self.client.force_authenticate(user=None)
        response = self.client.get("/authn/contact-phones/")
        self.assertEqual(response.status_code, 401)
