"""Direct serializer-validation coverage for authn serializers."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import RequestFactory, TestCase
from django.utils import timezone
from rest_framework import serializers

from apps.authn.models import ContactEmail, EmailAuthChallenge
from apps.authn.serializers.auth.login import LoginSerializer
from apps.authn.serializers.contacts.emails import (
    ContactEmailCreateSerializer,
    ContactEmailUpdateSerializer,
    ContactEmailVerifyCodeSerializer,
)
from apps.authn.serializers.email_code.base import BaseCodeVerifySerializer
from apps.authn.serializers.email_code.passwords import (
    ChangePasswordCodeVerifySerializer,
    DeleteAccountCodeRequestSerializer,
    DeleteAccountCodeVerifySerializer,
)

Member = get_user_model()


class ContactEmailSerializerValidationTests(TestCase):
    def test_create_rejects_primary_type(self):
        serializer = ContactEmailCreateSerializer(
            data={"email_address": "x@y.com", "email_type": "primary"}
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("email_type", serializer.errors)

    def test_update_rejects_primary_type(self):
        serializer = ContactEmailUpdateSerializer(data={"email_type": "primary"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("email_type", serializer.errors)

    def test_verify_code_rejects_non_numeric(self):
        serializer = ContactEmailVerifyCodeSerializer(data={"code": "abcdef"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("code", serializer.errors)


class BaseCodeVerifySerializerTests(TestCase):
    def test_validate_code_rejects_non_six_digit(self):
        with self.assertRaises(serializers.ValidationError):
            BaseCodeVerifySerializer().validate_code("12ab56")

    def test_validate_raises_for_missing_challenge(self):
        class _S(BaseCodeVerifySerializer):
            purpose = EmailAuthChallenge.Purpose.LOGIN

        serializer = _S(data={"email": "nobody@example.com", "code": "123456"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("detail", serializer.errors)


class LoginSerializerValidationTests(TestCase):
    def setUp(self):
        self.password = "StrongPass123!"
        self.member = Member.objects.create_user(password=self.password, is_active=True)
        ContactEmail.objects.create(
            member=self.member,
            email_address="login@example.com",
            email_type="primary",
            verified=True,
        )

    def test_invalid_credentials_when_email_unknown(self):
        serializer = LoginSerializer(
            data={"email": "unknown@example.com", "password": self.password}
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("non_field_errors", serializer.errors)

    def test_invalid_credentials_when_inactive(self):
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        serializer = LoginSerializer(data={"email": "login@example.com", "password": self.password})
        self.assertFalse(serializer.is_valid())
        self.assertIn("non_field_errors", serializer.errors)

    def test_invalid_credentials_when_password_wrong(self):
        serializer = LoginSerializer(data={"email": "login@example.com", "password": "WrongPass!"})
        self.assertFalse(serializer.is_valid())
        self.assertIn("non_field_errors", serializer.errors)

    def test_valid_login(self):
        serializer = LoginSerializer(data={"email": "login@example.com", "password": self.password})
        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertEqual(serializer.validated_data["user"], self.member)


class PasswordCodeEdgeTests(TestCase):
    def setUp(self):
        self.rf = RequestFactory()
        self.member = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.member,
            email_address="user@example.com",
            email_type="primary",
            verified=True,
        )
        self.other = Member.objects.create_user(password="StrongPass123!", is_active=True)
        ContactEmail.objects.create(
            member=self.other,
            email_address="other@example.com",
            email_type="primary",
            verified=True,
        )

    def _ctx(self, user):
        request = self.rf.post("/authn/")
        request.user = user
        return {"request": request}

    def _challenge(self, member, purpose, email):
        return EmailAuthChallenge.objects.create(
            member=member,
            purpose=purpose,
            target_email=email,
            code_hash=make_password("123456"),
            expires_at=timezone.now() + timedelta(minutes=10),
            max_attempts=5,
            last_sent_at=timezone.now(),
        )

    def test_change_password_verify_rejects_other_members_challenge(self):
        # Challenge belongs to self.other but request.user is self.member.
        self._challenge(self.other, EmailAuthChallenge.Purpose.PASSWORD_CHANGE, "other@example.com")
        serializer = ChangePasswordCodeVerifySerializer(
            data={"email": "other@example.com", "code": "123456"}, context=self._ctx(self.member)
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("detail", serializer.errors)

    def test_delete_account_request_no_primary_email(self):
        bare = Member.objects.create_user(password="StrongPass123!", is_active=True)
        serializer = DeleteAccountCodeRequestSerializer(data={}, context=self._ctx(bare))
        serializer.is_valid()
        with self.assertRaises(serializers.ValidationError):
            serializer.save()

    def test_delete_account_verify_no_primary_email(self):
        bare = Member.objects.create_user(password="StrongPass123!", is_active=True)
        serializer = DeleteAccountCodeVerifySerializer(
            data={"code": "123456"}, context=self._ctx(bare)
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("detail", serializer.errors)

    def test_delete_account_verify_rejects_mismatched_member(self):
        # Create an ACCOUNT_DELETE challenge for self.member's email but bound to self.other.
        self._challenge(self.other, EmailAuthChallenge.Purpose.ACCOUNT_DELETE, "user@example.com")
        serializer = DeleteAccountCodeVerifySerializer(
            data={"code": "123456"}, context=self._ctx(self.member)
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("detail", serializer.errors)
