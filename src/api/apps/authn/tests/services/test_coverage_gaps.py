"""Coverage gaps for services: rsa_manager."""

from django.test import TestCase

import apps.authn.services.security.rsa_manager as rsa_manager
from apps.authn.models import RSAKeypair


class RotateAuthKeypairTests(TestCase):
    def test_rotate_with_no_keypair_creates_and_rotates(self):
        """rsa_manager.py:62 — rotate_auth_keypair(None) resolves a keypair then rotates."""
        self.assertEqual(RSAKeypair.objects.count(), 0)
        keypair = rsa_manager.rotate_auth_keypair(None)
        self.assertIsNotNone(keypair.pk)
        self.assertTrue(keypair.is_active)
