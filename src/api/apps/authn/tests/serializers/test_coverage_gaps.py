"""Coverage gaps for serializers: contacts, profile, register, email_code/auth."""

from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import SimpleTestCase, TestCase
from rest_framework import serializers

from apps.authn.models import ContactEmail

Member = get_user_model()


# ---------------------------------------------------------------------------
# serializers/contact_emails/__init__.py:34,50
# ---------------------------------------------------------------------------
class ContactEmailSerializerValidateMethodTests(SimpleTestCase):
    def test_create_validate_email_type_rejects_primary(self):
        """contact_emails:34 — validate_email_type('primary') raises in create serializer."""
        from apps.authn.serializers.contacts.emails import ContactEmailCreateSerializer

        with self.assertRaises(serializers.ValidationError):
            ContactEmailCreateSerializer().validate_email_type("primary")

    def test_update_validate_email_type_rejects_primary(self):
        """contact_emails:50 — validate_email_type('primary') raises in update serializer."""
        from apps.authn.serializers.contacts.emails import ContactEmailUpdateSerializer

        with self.assertRaises(serializers.ValidationError):
            ContactEmailUpdateSerializer().validate_email_type("primary")


# ---------------------------------------------------------------------------
# serializers/profile.py:70-71
# ---------------------------------------------------------------------------
class ProfileSerializerImageErrorTests(TestCase):
    def test_profile_image_attribute_error_yields_none(self):
        """profile.py:70-71 — profile_image without .startswith -> None (AttributeError path)."""
        from apps.authn.serializers.account.profile import ProfileSerializer

        member = Member.objects.create_user(
            first_name="Img", last_name="Err", password="StrongPass123!"
        )
        ContactEmail.objects.create(
            member=member, email_address="img@example.com", email_type="primary", verified=True
        )
        member.profile_image = 12345  # int -> .startswith raises AttributeError

        data = ProfileSerializer().to_representation(member)
        self.assertIsNone(data["profile_image"])


# ---------------------------------------------------------------------------
# serializers/register.py:136-137, 146-153  (pending-member race paths)
# ---------------------------------------------------------------------------
class RegisterSerializerRaceTests(TestCase):
    def _data(self, email="race@example.com"):
        return {
            "email": email,
            "password": "encpw",
            "password_confirm": "encpw",
            "first_name": "Race",
            "last_name": "Winner",
            "organization": "Org",
        }

    def test_claim_none_pending_exists_uses_pending(self):
        """register.py:136-137 — claim returns None but a pending member exists -> reuse it."""
        from apps.authn.serializers.auth.register import RegisterSerializer

        pending = Member.objects.create_user(first_name="", last_name="", is_active=False)

        serializer = RegisterSerializer(data=self._data())
        serializer.initial_data  # noqa: B018 - ensure data attached
        with (
            patch(
                "apps.authn.serializers.auth.register.decrypt_password_pair",
                return_value="plain123",
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.registration_email_conflicts",
                return_value=False,
            ),
        ):
            self.assertTrue(serializer.is_valid(), serializer.errors)

        with (
            patch(
                "apps.authn.serializers.auth.register.claim_unclaimed_contact_email",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                return_value=pending,
            ),
            patch("apps.authn.serializers.auth.register.issue_email_challenge"),
        ):
            member = serializer.save()

        self.assertEqual(member.pk, pending.pk)
        self.assertEqual(member.first_name, "Race")

    def test_claim_none_integrity_error_pending_appears(self):
        """register.py:146-153 — ContactEmail.create IntegrityError, pending then found -> reuse."""
        from apps.authn.serializers.auth.register import RegisterSerializer

        pending = Member.objects.create_user(first_name="", last_name="", is_active=False)

        serializer = RegisterSerializer(data=self._data("race2@example.com"))
        with (
            patch(
                "apps.authn.serializers.auth.register.decrypt_password_pair",
                return_value="plain123",
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.registration_email_conflicts",
                return_value=False,
            ),
        ):
            self.assertTrue(serializer.is_valid(), serializer.errors)

        with (
            patch(
                "apps.authn.serializers.auth.register.claim_unclaimed_contact_email",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                side_effect=[None, pending],
            ),
            patch(
                "apps.authn.models.ContactEmail.objects.create", side_effect=IntegrityError("dup")
            ),
            patch("apps.authn.serializers.auth.register.issue_email_challenge"),
        ):
            member = serializer.save()

        self.assertEqual(member.pk, pending.pk)

    def test_claim_none_integrity_error_no_pending_raises(self):
        """register.py:146-153 — IntegrityError and still no pending -> ValidationError."""
        from apps.authn.serializers.auth.register import RegisterSerializer

        serializer = RegisterSerializer(data=self._data("race3@example.com"))
        with (
            patch(
                "apps.authn.serializers.auth.register.decrypt_password_pair",
                return_value="plain123",
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.registration_email_conflicts",
                return_value=False,
            ),
        ):
            self.assertTrue(serializer.is_valid(), serializer.errors)

        with (
            patch(
                "apps.authn.serializers.auth.register.claim_unclaimed_contact_email",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.auth.register.get_pending_registration_member",
                side_effect=[None, None],
            ),
            patch(
                "apps.authn.models.ContactEmail.objects.create", side_effect=IntegrityError("dup")
            ),
            patch("apps.authn.serializers.auth.register.issue_email_challenge"),
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer.save()


# ---------------------------------------------------------------------------
# serializers/email_code/auth.py:81  (IntegrityError -> pending then found)
# ---------------------------------------------------------------------------
class UnifiedEmailAuthCreatePendingRaceTests(TestCase):
    def test_create_pending_integrity_then_pending_found(self):
        """auth.py:76-81 — ContactEmail.create IntegrityError, pending found -> reuse it."""
        from apps.authn.serializers.email_code.auth import UnifiedEmailAuthRequestSerializer

        pending = Member.objects.create_user(first_name="", last_name="", is_active=False)
        serializer = UnifiedEmailAuthRequestSerializer()

        with (
            patch(
                "apps.authn.serializers.email_code.auth.claim_unclaimed_contact_email",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.email_code.auth.get_pending_registration_member",
                side_effect=[None, pending],
            ),
            patch(
                "apps.authn.models.ContactEmail.objects.create", side_effect=IntegrityError("dup")
            ),
        ):
            result = serializer._create_pending_member("authrace@example.com")

        self.assertEqual(result.pk, pending.pk)

    def test_create_pending_integrity_no_pending_raises(self):
        """auth.py:82 — IntegrityError and no pending -> ValidationError."""
        from apps.authn.serializers.email_code.auth import UnifiedEmailAuthRequestSerializer

        serializer = UnifiedEmailAuthRequestSerializer()
        with (
            patch(
                "apps.authn.serializers.email_code.auth.claim_unclaimed_contact_email",
                return_value=None,
            ),
            patch(
                "apps.authn.serializers.email_code.auth.get_pending_registration_member",
                side_effect=[None, None],
            ),
            patch(
                "apps.authn.models.ContactEmail.objects.create", side_effect=IntegrityError("dup")
            ),
        ):
            with self.assertRaises(serializers.ValidationError):
                serializer._create_pending_member("authrace2@example.com")
