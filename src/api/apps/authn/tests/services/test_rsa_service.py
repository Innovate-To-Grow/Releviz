"""Tests for RSA key management service."""

import base64
from datetime import timedelta

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from django.test import TestCase
from django.utils import timezone

from apps.authn.models import RSAKeypair
from apps.authn.services.security.rsa_manager import (
    KEY_DECRYPTION_GRACE_PERIOD,
    KEY_PURGE_RETENTION,
    RSADecryptionError,
    decrypt_password,
    get_or_create_auth_keypair,
    get_public_key_pem,
    is_encrypted_password,
    purge_retired_auth_keypairs,
    rotate_auth_keypair,
)


class RSAManagerServiceTests(TestCase):
    # noinspection PyMethodMayBeStatic,PyPep8Naming
    def setUp(self):
        RSAKeypair.objects.all().delete()

    def test_get_public_key_creates_keypair(self):
        pem, key_id = get_public_key_pem()
        self.assertTrue(pem.startswith("-----BEGIN PUBLIC KEY-----"))
        self.assertIsNotNone(key_id)
        self.assertEqual(RSAKeypair.objects.count(), 1)

    def test_get_public_key_is_idempotent(self):
        pem1, kid1 = get_public_key_pem()
        pem2, kid2 = get_public_key_pem()
        self.assertEqual(kid1, kid2)
        self.assertEqual(pem1, pem2)

    def test_encrypt_decrypt_round_trip(self):
        keypair = get_or_create_auth_keypair()
        public_key = serialization.load_pem_public_key(keypair.public_key_pem.encode("utf-8"))

        plaintext = "MySecretPassword123!"
        encrypted = public_key.encrypt(
            plaintext.encode("utf-8"),
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        encrypted_b64 = base64.b64encode(encrypted).decode("utf-8")

        decrypted = decrypt_password(encrypted_b64, str(keypair.key_id))
        self.assertEqual(decrypted, plaintext)

    def test_is_encrypted_password_true_for_rsa(self):
        # 256 bytes of random data base64-encoded looks like RSA ciphertext
        fake_ciphertext = base64.b64encode(b"\x00" * 256).decode("utf-8")
        self.assertTrue(is_encrypted_password(fake_ciphertext))

    def test_is_encrypted_password_false_for_plaintext(self):
        self.assertFalse(is_encrypted_password("mypassword"))
        self.assertFalse(is_encrypted_password("short"))
        self.assertFalse(is_encrypted_password(""))

    def test_rotate_keypair_creates_new_row_and_retires_old_key(self):
        keypair = get_or_create_auth_keypair()
        old_pem = keypair.public_key_pem
        old_key_id = keypair.key_id

        replacement = rotate_auth_keypair(keypair)
        keypair.refresh_from_db()

        self.assertEqual(keypair.public_key_pem, old_pem)
        self.assertFalse(keypair.is_active)
        self.assertIsNotNone(keypair.rotated_at)
        self.assertTrue(replacement.is_active)
        self.assertNotEqual(replacement.key_id, old_key_id)
        self.assertNotEqual(replacement.public_key_pem, old_pem)

    def test_retired_key_can_decrypt_during_retention_window(self):
        keypair = get_or_create_auth_keypair()
        public_key = serialization.load_pem_public_key(keypair.public_key_pem.encode("utf-8"))
        encrypted = public_key.encrypt(
            b"cached-client-password",
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        rotate_auth_keypair(keypair)

        decrypted = decrypt_password(
            base64.b64encode(encrypted).decode("utf-8"),
            str(keypair.key_id),
        )

        self.assertEqual(decrypted, "cached-client-password")

    def test_retired_key_cannot_decrypt_after_24_hour_grace(self):
        keypair = get_or_create_auth_keypair()
        public_key = serialization.load_pem_public_key(keypair.public_key_pem.encode("utf-8"))
        encrypted = public_key.encrypt(
            b"expired-cached-password",
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        rotate_auth_keypair(keypair)
        RSAKeypair.objects.filter(pk=keypair.pk).update(
            rotated_at=timezone.now() - KEY_DECRYPTION_GRACE_PERIOD - timedelta(seconds=1)
        )

        with self.assertRaises(RSADecryptionError):
            decrypt_password(
                base64.b64encode(encrypted).decode("utf-8"),
                str(keypair.key_id),
            )
        self.assertTrue(RSAKeypair.objects.filter(pk=keypair.pk).exists())

    def test_purge_keeps_key_until_48_hour_retention_ends(self):
        keypair = get_or_create_auth_keypair()
        rotate_auth_keypair(keypair)
        RSAKeypair.objects.filter(pk=keypair.pk).update(
            rotated_at=timezone.now() - KEY_DECRYPTION_GRACE_PERIOD - timedelta(seconds=1)
        )

        deleted = purge_retired_auth_keypairs()

        self.assertEqual(deleted, 0)
        self.assertTrue(RSAKeypair.objects.filter(pk=keypair.pk).exists())

    def test_purge_removes_key_after_48_hour_retention_window(self):
        keypair = get_or_create_auth_keypair()
        rotate_auth_keypair(keypair)
        RSAKeypair.objects.filter(pk=keypair.pk).update(
            rotated_at=timezone.now() - KEY_PURGE_RETENTION - timedelta(seconds=1)
        )

        deleted = purge_retired_auth_keypairs()

        self.assertEqual(deleted, 1)
        self.assertFalse(RSAKeypair.objects.filter(pk=keypair.pk).exists())
