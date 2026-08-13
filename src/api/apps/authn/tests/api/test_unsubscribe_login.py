"""Tests for UnsubscribeAutoLoginView endpoint."""

from time import time
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.authn.constants import UNSUBSCRIBE_LOGIN_INVALID
from apps.authn.models import ContactEmail
from apps.authn.services.account.unsubscribe import build_unsubscribe_login_token

Member = get_user_model()


class UnsubscribeAutoLoginViewTests(APITestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        cache.clear()
        self.member = Member.objects.create_user(
            password="StrongPass123!",
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.member,
            email_address="unsub@example.com",
            email_type="primary",
            verified=True,
        )

    def test_valid_token_unsubscribes_without_jwt(self):
        token = build_unsubscribe_login_token(self.member)
        response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": token},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data, {"message": "You have been unsubscribed.", "unsubscribed": True}
        )
        self.assertNotIn("access", response.data)
        self.assertNotIn("refresh", response.data)
        self.assertNotIn("user", response.data)

        self.member.refresh_from_db()
        self.assertFalse(self.member.get_primary_contact_email().subscribe)

    def test_invalid_token_returns_400(self):
        response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": "garbage-invalid-token"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_missing_token_returns_400(self):
        response = self.client.post(
            "/authn/unsubscribe-login/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_inactive_member_returns_400(self):
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        token = build_unsubscribe_login_token(self.member)
        response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": token},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_token_older_than_seven_days_returns_400(self):
        issued_at = time() - (8 * 24 * 60 * 60)
        with patch("django.core.signing.time.time", return_value=issued_at):
            token = build_unsubscribe_login_token(self.member)

        response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": token},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["detail"], UNSUBSCRIBE_LOGIN_INVALID)

    def test_token_can_only_be_used_once(self):
        token = build_unsubscribe_login_token(self.member)

        first_response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": token},
            format="json",
        )
        self.assertEqual(first_response.status_code, 200)

        second_response = self.client.post(
            "/authn/unsubscribe-login/",
            {"token": token},
            format="json",
        )
        self.assertEqual(second_response.status_code, 400)
        self.assertEqual(
            second_response.data["detail"], "This unsubscribe link has already been used."
        )
