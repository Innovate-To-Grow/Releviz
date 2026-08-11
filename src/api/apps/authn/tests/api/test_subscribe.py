"""Tests for SubscribeView endpoint."""

from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.models import ContactEmail


class SubscribeViewTests(APITestCase):
    # noinspection PyPep8Naming,PyMethodMayBeStatic
    def setUp(self):
        cache.clear()

    def test_subscribe_new_email_returns_201(self):
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "new@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(ContactEmail.objects.filter(email_address="new@example.com", subscribe=True).exists())

    def test_subscribe_existing_returns_200(self):
        ContactEmail.objects.create(email_address="existing@example.com", subscribe=True, email_type="other")
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "existing@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)

    def test_double_submit_does_not_create_duplicate(self):
        first = self.client.post("/authn/subscribe/", {"email": "twice@example.com"}, format="json")
        second = self.client.post("/authn/subscribe/", {"email": "twice@example.com"}, format="json")
        self.assertIn(first.status_code, (200, 201))
        self.assertIn(second.status_code, (200, 201))
        self.assertEqual(ContactEmail.objects.filter(email_address="twice@example.com").count(), 1)

    def test_subscribe_resubscribe_flips_flag(self):
        ContactEmail.objects.create(email_address="unsub@example.com", subscribe=False, email_type="other")
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "unsub@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        contact = ContactEmail.objects.get(email_address="unsub@example.com")
        self.assertTrue(contact.subscribe)

    def test_subscribe_normalizes_email(self):
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "  FOO@EXAMPLE.COM  "},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(ContactEmail.objects.filter(email_address="foo@example.com").exists())

    def test_subscribe_invalid_email_returns_400(self):
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "not-an-email"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_subscribe_missing_email_returns_400(self):
        response = self.client.post(
            "/authn/subscribe/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_subscribe_is_public(self):
        self.client.credentials()
        response = self.client.post(
            "/authn/subscribe/",
            {"email": "public@example.com"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
