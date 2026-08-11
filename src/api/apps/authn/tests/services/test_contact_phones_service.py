"""Tests for apps.authn.services.contacts.contact_phones helpers."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.authn.models import ContactEmail, ContactPhone
from apps.authn.services.contacts.contact_phones import (
    create_contact_phone,
    delete_contact_phone,
    infer_region_from_e164,
    national_to_e164,
    normalize_to_national,
    request_phone_verification,
    verify_phone_code,
)
from apps.authn.services.email.challenges import AuthChallengeInvalid

Member = get_user_model()


class NormalizationHelperTests(TestCase):
    def test_national_to_e164_when_digits_already_have_country_code(self):
        # digits start with cc -> prefixed directly with "+"
        self.assertEqual(national_to_e164("12095551234", "1-US"), "+12095551234")

    def test_national_to_e164_prepends_country_code(self):
        # national digits without cc -> "+" + cc + digits
        self.assertEqual(national_to_e164("2095551234", "1-US"), "+12095551234")

    def test_normalize_to_national_strips_country_code(self):
        self.assertEqual(normalize_to_national("+12095551234", "1-US"), "2095551234")

    def test_infer_region_defaults_to_us_for_plus_one(self):
        self.assertEqual(infer_region_from_e164("+12095551234"), "1-US")

    def test_infer_region_preserves_ca_when_current_is_ca(self):
        self.assertEqual(infer_region_from_e164("+14165551234", "1-CA"), "1-CA")

    def test_infer_region_falls_back_to_current_when_no_match(self):
        # leading 0 matches no country code -> returns current_region
        self.assertEqual(infer_region_from_e164("0001234", "44"), "44")

    def test_infer_region_falls_back_to_us_when_no_current(self):
        self.assertEqual(infer_region_from_e164("0001234"), "1-US")

    def test_infer_region_keeps_legacy_non_us_region(self):
        # A legacy national number can begin with "1" (e.g. China 13800138000 / region "86").
        # With the US-only choice list it must NOT be reclassified to "1-US", which would
        # strip the leading "1" and drop a digit during admin normalization.
        self.assertEqual(infer_region_from_e164("13800138000", "86"), "86")
        self.assertEqual(normalize_to_national("13800138000", "86"), "13800138000")


class PhoneVerificationServiceTests(TestCase):
    def setUp(self):
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.member, email_address="m@example.com", email_type="primary", verified=True
        )

    def test_request_phone_verification_not_found_raises(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            request_phone_verification(member=self.member, contact_phone_id=uuid.uuid4())

    def test_request_phone_verification_already_verified_raises(self):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US", verified=True)
        with self.assertRaises(AuthChallengeInvalid):
            request_phone_verification(member=self.member, contact_phone_id=phone.pk)

    @patch("apps.authn.services.sms.start_phone_verification")
    def test_request_phone_verification_sends_code(self, mock_start):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US")
        result = request_phone_verification(member=self.member, contact_phone_id=phone.pk)
        self.assertEqual(result, {"message": "Verification code sent via SMS."})
        mock_start.assert_called_once_with(
            "+12095551234",
            purpose="contact_phone_verify",
            member=self.member,
            context_identifier=str(phone.pk),
        )

    def test_verify_phone_code_not_found_raises(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            verify_phone_code(member=self.member, contact_phone_id=uuid.uuid4(), code="123456")

    @patch("apps.authn.services.sms.check_phone_verification")
    def test_verify_phone_code_marks_verified(self, mock_check):
        phone = ContactPhone.objects.create(member=self.member, phone_number="2095551234", region="1-US")

        def approve(*_args, **kwargs):
            return kwargs["approved_callback"](object())

        mock_check.side_effect = approve
        updated = verify_phone_code(member=self.member, contact_phone_id=phone.pk, code="123456")
        self.assertTrue(updated.verified)
        mock_check.assert_called_once()
        args, kwargs = mock_check.call_args
        self.assertEqual(args, ("+12095551234", "123456"))
        self.assertEqual(kwargs["challenge_id"], None)
        self.assertEqual(kwargs["purpose"], "contact_phone_verify")
        self.assertEqual(kwargs["member"], self.member)
        self.assertEqual(kwargs["context_identifier"], str(phone.pk))
        self.assertTrue(callable(kwargs["approved_callback"]))
        phone.refresh_from_db()
        self.assertTrue(phone.verified)

    def test_create_contact_phone_duplicate_raises(self):
        create_contact_phone(member=self.member, phone_number="2095551234", region="1-US")
        other = Member.objects.create_user(password="StrongPass123!", is_active=True)
        with self.assertRaises(AuthChallengeInvalid):
            create_contact_phone(member=other, phone_number="2095551234", region="1-US")

    def test_delete_contact_phone_not_found_raises(self):
        import uuid

        with self.assertRaises(AuthChallengeInvalid):
            delete_contact_phone(member=self.member, contact_phone_id=uuid.uuid4())
