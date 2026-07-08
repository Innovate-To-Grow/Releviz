import os
import re
from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from apps.authn.models import ContactEmail


def latest_code() -> str:
    body = mail.outbox[-1].body
    match = re.search(r"\b(\d{6})\b", body)
    assert match is not None
    return match.group(1)


class AuthFlowTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_register_verify_login_and_profile(self):
        res = self.client.post(
            "/authn/register/",
            {
                "email": "ada@example.com",
                "password": "password123",
                "password_confirm": "password123",
                "first_name": "Ada",
                "last_name": "Lovelace",
                "organization": "Scheduler",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 202)

        res = self.client.post(
            "/authn/register/verify-code/",
            {"email": "ada@example.com", "code": latest_code()},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("access", res.data)
        self.assertEqual(res.data["user"]["displayName"], "Ada Lovelace")

        res = self.client.post(
            "/authn/login/",
            {"email": "ada@example.com", "password": "password123"},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        token = res.data["access"]

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        res = self.client.get("/authn/profile/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["user"]["email"], "ada@example.com")

    def test_ensure_default_admin_creates_staff_login(self):
        with patch.dict(
            os.environ,
            {"DJANGO_SUPERUSER_PASSWORD": "password123"},
        ):
            call_command(
                "ensure_default_admin",
                "--yes",
                email="admin@example.com",
                stdout=StringIO(),
            )

        member = get_user_model().objects.get(contact_emails__email_address="admin@example.com")
        self.assertTrue(member.is_staff)
        self.assertTrue(member.is_superuser)
        self.assertTrue(ContactEmail.objects.get(member=member).verified)

        res = self.client.post(
            "/admin/login/",
            {"email": "admin@example.com", "password": "password123"},
        )
        self.assertEqual(res.status_code, 302)
