"""Coverage for services: challenges, rsa_manager, export_vcf, unsubscribe."""

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.authn.models import ContactEmail, RSAKeypair
from apps.authn.services.account.unsubscribe import build_unsubscribe_url
from apps.authn.services.email.challenges import _random_code
from apps.authn.services.members.export_vcf import _build_vcard, _escape, _profile_image
from apps.authn.services.security.rsa_manager import (
    RSADecryptionError,
    decrypt_password,
    get_or_create_auth_keypair,
)

Member = get_user_model()


def _member(**kw):
    return Member.objects.create_user(
        password="StrongPass123!",
        first_name=kw.pop("first_name", "A"),
        last_name=kw.pop("last_name", "B"),
        **kw,
    )


class RandomCodeTests(TestCase):
    def test_random_code_is_six_digits(self):
        code = _random_code()
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())


class RsaManagerEdgeTests(TestCase):
    def setUp(self):
        RSAKeypair.objects.all().delete()

    def test_decrypt_with_unknown_key_id_fails_closed(self):
        get_or_create_auth_keypair()
        with self.assertRaisesMessage(RSADecryptionError, "Unknown RSA key identifier"):
            decrypt_password("bm90LXZhbGlkLWVuY3J5cHRlZA==", key_id="00000000-0000-0000-0000-000000000000")

    def test_database_rejects_duplicate_active_key_name(self):
        from apps.authn.services.security.rsa_manager import AUTH_KEY_NAME

        RSAKeypair.objects.create(name=AUTH_KEY_NAME, is_active=True)
        with self.assertRaises(IntegrityError), transaction.atomic():
            RSAKeypair.objects.create(name=AUTH_KEY_NAME, is_active=True)

    @patch("apps.authn.services.security.rsa_manager.rotate_auth_keypair")
    def test_get_or_create_rotates_stale_key(self, mock_rotate):
        from datetime import timedelta

        from django.utils import timezone

        from apps.authn.services.security.rsa_manager import AUTH_KEY_NAME

        keypair = RSAKeypair.objects.create(name=AUTH_KEY_NAME, is_active=True)
        RSAKeypair.objects.filter(pk=keypair.pk).update(created_at=timezone.now() - timedelta(days=2))
        get_or_create_auth_keypair()
        mock_rotate.assert_called_once()


class ExportVcfHelperTests(TestCase):
    def test_escape_none_returns_empty(self):
        self.assertEqual(_escape(None), "")

    def test_profile_image_raw_without_data_uri(self):
        payload, mime = _profile_image("rawbase64data")
        self.assertEqual(payload, "rawbase64data")
        self.assertEqual(mime, "")

    def test__build_vcard_uses_email_when_no_name(self):
        member = Member.objects.create_user(password="StrongPass123!", first_name="", last_name="")
        ContactEmail.objects.create(
            member=member, email_address="noname@example.com", email_type="primary", verified=True
        )
        member.refresh_from_db()
        card = _build_vcard(member)
        self.assertIn("noname@example.com", card)

    def test__build_vcard_phone_e164_failure_omits_tel(self):
        from apps.authn.models import ContactPhone

        member = _member()
        ContactEmail.objects.create(member=member, email_address="p@example.com", email_type="primary", verified=True)
        ContactPhone.objects.create(member=member, phone_number="2095551234", region="1-US")
        member.refresh_from_db()
        with patch.object(ContactPhone, "to_e164", side_effect=RuntimeError("bad region")):
            card = _build_vcard(member)
        self.assertNotIn("TEL", card)


class UnsubscribeUrlTests(TestCase):
    def test_build_unsubscribe_url_contains_token(self):
        member = _member(is_active=True)
        url = build_unsubscribe_url(member)
        self.assertIn("/unsubscribe-login#token=", url)
