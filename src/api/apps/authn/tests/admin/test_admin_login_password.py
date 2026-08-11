"""
Tests for admin login via email verification code and password.
"""

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.views.admin.login_helpers import LAST_ADMIN_LOGIN_COOKIE_NAME

Member = get_user_model()
LOGIN_URL = "/admin/login/"
PURPOSE = EmailAuthChallenge.Purpose.ADMIN_LOGIN


def _create_pending_challenge(member, email, code="123456"):
    return EmailAuthChallenge.objects.create(
        member=member,
        purpose=PURPOSE,
        target_email=email,
        code_hash=make_password(code),
        expires_at=timezone.now() + timedelta(minutes=10),
        max_attempts=5,
        last_sent_at=timezone.now(),
    )


@override_settings(ROOT_URLCONF="config.routing.urls")
class AdminPasswordLoginTest(TestCase):
    # noinspection PyPep8Naming
    def setUp(self):
        cache.clear()
        self.staff = Member.objects.create_user(
            password="testpass123",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.staff, email_address="admin@example.com", email_type="primary", verified=True
        )
        self.non_staff = Member.objects.create_user(
            password="testpass123",
            is_staff=False,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.non_staff, email_address="regular@example.com", email_type="primary", verified=True
        )

    # noinspection PyPep8Naming,PyMethodMayBeStatic
    def tearDown(self):
        cache.clear()

    def test_get_password_mode_shows_password_form(self):
        resp = self.client.get(LOGIN_URL + "?mode=password")
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="password"')
        self.assertContains(resp, 'name="mode"')
        self.assertContains(resp, "Sign In")

    def test_post_password_valid_credentials_logs_in(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )
        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)
        # User should be authenticated
        resp2 = self.client.get("/admin/")
        self.assertEqual(resp2.status_code, 200)

    def test_post_password_valid_credentials_sets_last_admin_cookie(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )

        self.assertIn(LAST_ADMIN_LOGIN_COOKIE_NAME, resp.cookies)
        cookie = resp.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME]
        self.assertEqual(cookie["path"], "/admin/")
        self.assertTrue(cookie["httponly"])

    def test_password_login_cookie_can_render_next_login_summary(self):
        self.staff.first_name = "Ada"
        self.staff.last_name = "Lovelace"
        self.staff.organization = "Analytical Engines"
        self.staff.save(update_fields=["first_name", "last_name", "organization"])
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )
        cookie_value = resp.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME].value
        self.client.logout()
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = cookie_value

        resp = self.client.get(LOGIN_URL + "?mode=password")

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Last signed in")
        self.assertContains(resp, "Ada Lovelace")
        self.assertContains(resp, "Analytical Engines")
        self.assertContains(resp, 'name="password"')
        self.assertContains(resp, "Send verification code instead")
        self.assertNotContains(resp, "admin@example.com")
        self.assertNotContains(resp, 'name="email"')

    def test_remembered_admin_password_login_without_email(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )
        cookie_value = resp.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME].value
        self.client.logout()
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = cookie_value

        resp = self.client.post(LOGIN_URL, {"mode": "password", "remembered_admin": "1", "password": "testpass123"})

        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)

    def test_remembered_admin_wrong_password_keeps_email_hidden(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )
        cookie_value = resp.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME].value
        self.client.logout()
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = cookie_value

        resp = self.client.post(LOGIN_URL, {"mode": "password", "remembered_admin": "1", "password": "wrongpass"})

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Invalid password", count=1)
        self.assertNotContains(resp, "admin@example.com")
        self.assertNotContains(resp, 'name="email"')

    def test_post_password_wrong_password_shows_error(self):
        resp = self.client.post(LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "wrongpass"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Invalid email or password", count=1)

    def test_post_password_unknown_email_shows_error(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "unknown@example.com", "password": "testpass123"}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Invalid email or password")

    def test_post_password_non_staff_shows_error(self):
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "regular@example.com", "password": "testpass123"}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Invalid email or password")

    def test_post_password_inactive_user_shows_error(self):
        self.staff.is_active = False
        self.staff.save()
        resp = self.client.post(
            LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "testpass123"}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Invalid email or password")

    def test_password_next_redirect(self):
        url = LOGIN_URL + "?next=/admin/cms/cmspage/"
        resp = self.client.post(url, {"mode": "password", "email": "admin@example.com", "password": "testpass123"})
        self.assertRedirects(resp, "/admin/cms/cmspage/", fetch_redirect_response=False)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_password_mode_clears_email_code_session(self, mock_issue):
        # Start email-code flow
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(self.client.session.get("admin_login_step"), "code")

        # Switch to password mode
        resp = self.client.get(LOGIN_URL + "?mode=password")
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="password"')
        self.assertNotIn("admin_login_step", self.client.session)

    def test_toggle_link_on_email_step(self):
        resp = self.client.get(LOGIN_URL)
        self.assertContains(resp, "Sign in with password instead")

    def test_toggle_link_on_password_step(self):
        resp = self.client.get(LOGIN_URL + "?mode=password")
        self.assertContains(resp, "Sign in with email code instead")

    def test_password_rate_limit(self):
        for _ in range(10):
            self.client.post(LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "wrongpass"})

        # 11th attempt should be throttled
        resp = self.client.post(LOGIN_URL, {"mode": "password", "email": "admin@example.com", "password": "wrongpass"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Too many login attempts")
