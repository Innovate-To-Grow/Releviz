"""Coverage for serializer helpers, register, and unified-auth serializers."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase, override_settings
from rest_framework import serializers

from apps.authn.models import ContactEmail
from apps.authn.serializers.auth.register import RegisterSerializer
from apps.authn.serializers.email_code.auth import (
    RegisterResendCodeSerializer,
    UnifiedEmailAuthRequestSerializer,
    UnifiedEmailAuthVerifySerializer,
)
from apps.authn.serializers.helpers import decrypt_field, decrypt_password_pair

Member = get_user_model()


def _member(email=None, **kw):
    member = Member.objects.create_user(
        password="StrongPass123!",
        first_name=kw.pop("first_name", "A"),
        last_name=kw.pop("last_name", "B"),
        **kw,
    )
    if email:
        ContactEmail.objects.create(member=member, email_address=email, email_type="primary", verified=True)
    return member


class DecryptFieldTests(TestCase):
    def test_plaintext_passthrough_when_not_required(self):
        self.assertEqual(decrypt_field("plaintext"), "plaintext")

    @override_settings(REQUIRE_ENCRYPTED_PASSWORDS=True)
    def test_plaintext_rejected_when_required(self):
        with self.assertRaises(serializers.ValidationError):
            decrypt_field("plaintext")

    def test_encrypted_value_decrypt_failure_raises(self):
        # A value that *looks* encrypted (long base64) but cannot be decrypted.
        import base64

        fake = base64.b64encode(b"\x00" * 256).decode()
        with patch("apps.authn.serializers.helpers.is_encrypted_password", return_value=True):
            with self.assertRaises(serializers.ValidationError):
                decrypt_field(fake)


class DecryptPasswordPairTests(TestCase):
    def test_password_decrypt_error_wrapped(self):
        with patch("apps.authn.serializers.helpers.decrypt_field", side_effect=serializers.ValidationError("x")):
            with self.assertRaises(serializers.ValidationError):
                decrypt_password_pair({"new_password": "a", "new_password_confirm": "b"})

    def test_confirm_decrypt_error_wrapped(self):
        calls = []

        def fake_decrypt(value, key_id=None):
            calls.append(value)
            if value == "confirmval":
                raise serializers.ValidationError("bad confirm")
            return value

        with patch("apps.authn.serializers.helpers.decrypt_field", side_effect=fake_decrypt):
            with self.assertRaises(serializers.ValidationError):
                decrypt_password_pair({"new_password": "GoodPass123!", "new_password_confirm": "confirmval"})

    def test_too_short_password_rejected(self):
        with self.assertRaises(serializers.ValidationError):
            decrypt_password_pair({"new_password": "short", "new_password_confirm": "short"})

    def test_password_validation_failure_rejected(self):
        # "password" fails Django's common-password validator.
        with self.assertRaises(serializers.ValidationError):
            decrypt_password_pair({"new_password": "password", "new_password_confirm": "password"})

    def test_mismatched_passwords_rejected(self):
        with self.assertRaises(serializers.ValidationError):
            decrypt_password_pair({"new_password": "StrongPass123!", "new_password_confirm": "DifferentPass123!"})


class RegisterSerializerValidationTests(TestCase):
    def _payload(self, **overrides):
        base = {
            "email": "newbie@example.com",
            "password": "PlaintextPass123!",
            "password_confirm": "PlaintextPass123!",
            "first_name": "New",
            "last_name": "Bie",
            "organization": "Acme",
        }
        base.update(overrides)
        return base

    def test_first_name_rejects_html(self):
        serializer = RegisterSerializer(data=self._payload(first_name="<b>Hax</b>"))
        self.assertFalse(serializer.is_valid())
        self.assertIn("first_name", serializer.errors)

    def test_last_name_rejects_html(self):
        serializer = RegisterSerializer(data=self._payload(last_name="<i>Hax</i>"))
        self.assertFalse(serializer.is_valid())
        self.assertIn("last_name", serializer.errors)

    def test_password_rejects_similarity_to_registration_name(self):
        serializer = RegisterSerializer(
            data=self._payload(
                first_name="CorrectHorseBatteryStaple",
                password="CorrectHorseBatteryStaple",
                password_confirm="CorrectHorseBatteryStaple",
            )
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("password", serializer.errors)

    @patch("apps.authn.serializers.auth.register.issue_email_challenge")
    def test_create_reuses_pending_member(self, _mock_issue):
        pending = _member(email="pending@example.com", is_active=False)
        serializer = RegisterSerializer(data=self._payload(email="pending@example.com"))
        self.assertTrue(serializer.is_valid(), serializer.errors)
        member = serializer.save()
        self.assertEqual(member.pk, pending.pk)
        self.assertFalse(member.is_active)

    @patch("apps.authn.serializers.auth.register.issue_email_challenge")
    def test_create_new_member_with_unclaimed_email(self, _mock_issue):
        ContactEmail.objects.create(
            email_address="unclaimed@example.com", email_type="primary", member=None, verified=False
        )
        serializer = RegisterSerializer(data=self._payload(email="unclaimed@example.com"))
        self.assertTrue(serializer.is_valid(), serializer.errors)
        member = serializer.save()
        contact = ContactEmail.objects.get(email_address="unclaimed@example.com")
        self.assertEqual(contact.member, member)


class UnifiedEmailAuthVerifyValidationTests(TestCase):
    def test_validate_code_rejects_non_numeric(self):
        serializer = UnifiedEmailAuthVerifySerializer(data={"email": "x@y.com", "code": "12ab56"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("code", serializer.errors)

    def test_validate_rejects_when_no_challenge(self):
        serializer = UnifiedEmailAuthVerifySerializer(data={"email": "nobody@example.com", "code": "123456"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("detail", serializer.errors)


class CreatePendingMemberIntegrityTests(TestCase):
    @patch("apps.authn.serializers.email_code.auth.issue_email_challenge")
    @patch("apps.authn.serializers.email_code.auth.claim_unclaimed_contact_email", return_value=None)
    @patch("apps.authn.serializers.email_code.auth.get_pending_registration_member", return_value=None)
    def test_create_pending_member_integrity_error_raises(self, _mock_pending, _mock_claim, _mock_issue):
        serializer = UnifiedEmailAuthRequestSerializer()
        with patch(
            "apps.authn.models.ContactEmail.objects.create",
            side_effect=IntegrityError("dup"),
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer._create_pending_member("conflict@example.com")

    @patch("apps.authn.serializers.email_code.auth.issue_email_challenge")
    @patch("apps.authn.serializers.email_code.auth.claim_unclaimed_contact_email", return_value=None)
    def test_create_pending_member_returns_existing_pending_on_race(self, _mock_claim, _mock_issue):
        existing = _member(email="race@example.com", is_active=False)
        serializer = UnifiedEmailAuthRequestSerializer()
        with patch(
            "apps.authn.serializers.email_code.auth.get_pending_registration_member",
            return_value=existing,
        ):
            result = serializer._create_pending_member("race@example.com")
        self.assertEqual(result.pk, existing.pk)


class RegisterResendCodeTests(TestCase):
    @patch("apps.authn.serializers.email_code.auth.issue_email_challenge")
    def test_resend_no_pending_member_raises(self, _mock_issue):
        serializer = RegisterResendCodeSerializer(data={"email": "nobody@example.com"})
        self.assertTrue(serializer.is_valid())
        with self.assertRaises(serializers.ValidationError):
            serializer.save()

    @patch("apps.authn.serializers.email_code.auth.issue_email_challenge")
    def test_resend_for_pending_member_succeeds(self, mock_issue):
        _member(email="pending2@example.com", is_active=False)
        serializer = RegisterResendCodeSerializer(data={"email": "pending2@example.com"})
        self.assertTrue(serializer.is_valid())
        result = serializer.save()
        self.assertEqual(result, {"message": "Verification code sent."})
        mock_issue.assert_called_once()
