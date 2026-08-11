"""Tests for PublicKeyView endpoint."""

import uuid
from unittest.mock import patch

from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import RSAKeypair


class PublicKeyViewTests(APITestCase):
    # noinspection PyMethodMayBeStatic,PyPep8Naming
    def setUp(self):
        cache.clear()
        RSAKeypair.objects.all().delete()

    def test_get_public_key_returns_200(self):
        response = self.client.get("/authn/public-key/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("public_key", response.data)
        self.assertIn("key_id", response.data)

    def test_public_key_is_valid_pem(self):
        response = self.client.get("/authn/public-key/")
        self.assertTrue(response.data["public_key"].startswith("-----BEGIN PUBLIC KEY-----"))

    def test_key_id_is_valid_uuid(self):
        response = self.client.get("/authn/public-key/")
        # Should not raise
        uuid.UUID(response.data["key_id"])

    def test_endpoint_is_public(self):
        # No auth header, should still work
        self.client.credentials()
        response = self.client.get("/authn/public-key/")
        self.assertEqual(response.status_code, 200)

    def test_consecutive_calls_return_same_key(self):
        r1 = self.client.get("/authn/public-key/")
        r2 = self.client.get("/authn/public-key/")
        self.assertEqual(r1.data["key_id"], r2.data["key_id"])
        self.assertEqual(r1.data["public_key"], r2.data["public_key"])

    @patch("apps.authn.views.auth.public_key.get_public_key_pem", side_effect=RuntimeError("boom"))
    def test_internal_errors_return_generic_message(self, _mock_get_public_key):
        response = self.client.get("/authn/public-key/")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.data, {"detail": "Failed to retrieve public key."})
