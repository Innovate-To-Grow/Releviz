"""
Tests for admin login via email verification code and password.
"""

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.http import HttpResponse
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.models import ContactEmail
from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.challenges import (
    AuthChallengeDeliveryError,
    AuthChallengeInvalid,
    AuthChallengeThrottled,
)
from apps.authn.views.admin.login_helpers import (
    LAST_ADMIN_LOGIN_COOKIE_NAME,
    set_last_admin_login_cookie,
)

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


def _create_expired_challenge(member, email, code="123456"):
    return EmailAuthChallenge.objects.create(
        member=member,
        purpose=PURPOSE,
        target_email=email,
        code_hash=make_password(code),
        expires_at=timezone.now() - timedelta(minutes=1),
        max_attempts=5,
        status=EmailAuthChallenge.Status.EXPIRED,
        last_sent_at=timezone.now() - timedelta(minutes=11),
    )


def _last_admin_cookie_value(member):
    response = HttpResponse()
    set_last_admin_login_cookie(response, member)
    return response.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME].value


@override_settings(ROOT_URLCONF="config.urls")
class AdminLoginViewTest(TestCase):
    # noinspection PyPep8Naming
    def setUp(self):
        self.staff = Member.objects.create_user(
            password="testpass123",
            is_staff=True,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.staff,
            email_address="admin@example.com",
            email_type="primary",
            verified=True,
        )
        self.non_staff = Member.objects.create_user(
            password="testpass123",
            is_staff=False,
            is_active=True,
        )
        ContactEmail.objects.create(
            member=self.non_staff,
            email_address="regular@example.com",
            email_type="primary",
            verified=True,
        )

    # ── GET requests ────────────────────────────────────────────────

    def test_get_shows_email_form(self):
        resp = self.client.get(LOGIN_URL)
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')
        self.assertContains(resp, "Send verification code")

    def test_get_without_last_admin_cookie_hides_last_signed_in_summary(self):
        resp = self.client.get(LOGIN_URL)
        self.assertEqual(resp.status_code, 200)
        self.assertNotContains(resp, "Last signed in")

    def test_get_with_last_admin_cookie_shows_member_summary(self):
        self.staff.first_name = "Ada"
        self.staff.last_name = "Lovelace"
        self.staff.save(update_fields=["first_name", "last_name"])
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = _last_admin_cookie_value(self.staff)

        resp = self.client.get(LOGIN_URL)

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Last signed in")
        self.assertContains(resp, "Ada Lovelace")
        self.assertContains(resp, 'name="password"')
        self.assertContains(resp, "Send verification code instead")
        self.assertNotContains(resp, "admin@example.com")
        self.assertNotContains(resp, 'name="email"')

    def test_get_with_tampered_last_admin_cookie_ignores_summary(self):
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = "tampered-cookie"

        resp = self.client.get(LOGIN_URL)

        self.assertEqual(resp.status_code, 200)
        self.assertNotContains(resp, "Last signed in")

    def test_get_different_account_with_last_admin_cookie_shows_email_form(self):
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = _last_admin_cookie_value(self.staff)

        resp = self.client.get(LOGIN_URL + "?step=email&different=1")

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')
        self.assertNotContains(resp, "Last signed in")
        self.assertNotContains(resp, "admin@example.com")

    def test_get_with_ineligible_last_admin_cookie_ignores_summary(self):
        inactive_staff = Member.objects.create_user(
            password="testpass123",
            first_name="Inactive",
            last_name="Admin",
            is_staff=True,
            is_active=False,
        )
        for member in (inactive_staff, self.non_staff):
            with self.subTest(member=member.pk):
                self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = _last_admin_cookie_value(member)

                resp = self.client.get(LOGIN_URL)

                self.assertEqual(resp.status_code, 200)
                self.assertNotContains(resp, "Last signed in")

    def test_authenticated_staff_redirects(self):
        self.client.force_login(self.staff)
        resp = self.client.get(LOGIN_URL)
        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)

    def test_authenticated_staff_post_redirects(self):
        """POST while already authenticated should redirect, not process the form."""
        self.client.force_login(self.staff)
        resp = self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)

    def test_get_code_step_without_session_shows_email_form(self):
        """Directly visiting the code step without session state falls back to email form."""
        resp = self.client.get(LOGIN_URL)
        self.assertContains(resp, 'name="email"')
        self.assertNotContains(resp, 'name="code"')

    # ── email step ──────────────────────────────────────────────────

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_post_valid_email_sends_code(self, mock_issue):
        resp = self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(resp.status_code, 200)
        mock_issue.assert_called_once()
        call_kwargs = mock_issue.call_args.kwargs
        self.assertEqual(call_kwargs["member"], self.staff)
        self.assertEqual(call_kwargs["purpose"], PURPOSE)
        self.assertEqual(call_kwargs["target_email"], "admin@example.com")
        # Should show code form
        self.assertContains(resp, 'name="code"')
        self.assertContains(resp, "Verify and sign in")
        # Session should be on code step
        self.assertEqual(self.client.session.get("admin_login_step"), "code")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_post_email_case_insensitive(self, mock_issue):
        """Email lookup should be case-insensitive."""
        resp = self.client.post(LOGIN_URL, {"email": "ADMIN@Example.COM"})
        self.assertEqual(resp.status_code, 200)
        mock_issue.assert_called_once()

    def test_post_non_staff_email_shows_error(self):
        resp = self.client.post(LOGIN_URL, {"email": "regular@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Unable to send verification code")
        # Should still show email form
        self.assertContains(resp, 'name="email"')
        # No challenge created
        self.assertEqual(EmailAuthChallenge.objects.filter(purpose=PURPOSE).count(), 0)

    def test_post_unknown_email_shows_error(self):
        resp = self.client.post(LOGIN_URL, {"email": "unknown@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Unable to send verification code")

    def test_post_empty_email_shows_error(self):
        """Empty email should fail form validation."""
        resp = self.client.post(LOGIN_URL, {"email": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')

    def test_post_invalid_email_format_shows_error(self):
        """Malformed email should fail form validation."""
        resp = self.client.post(LOGIN_URL, {"email": "not-an-email"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')

    def test_unverified_email_shows_error(self):
        """Staff member with unverified email cannot receive a verification code."""
        unverified_staff = Member.objects.create_user(
            password="testpass123", is_staff=True, is_active=True
        )
        ContactEmail.objects.create(
            member=unverified_staff,
            email_address="unverified@example.com",
            email_type="primary",
            verified=False,
        )
        resp = self.client.post(LOGIN_URL, {"email": "unverified@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Unable to send verification code")

    def test_inactive_staff_email_shows_error(self):
        """Inactive staff member should not be able to request a code."""
        inactive_staff = Member.objects.create_user(
            password="testpass123", is_staff=True, is_active=False
        )
        ContactEmail.objects.create(
            member=inactive_staff,
            email_address="inactive@example.com",
            email_type="primary",
            verified=True,
        )
        resp = self.client.post(LOGIN_URL, {"email": "inactive@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Unable to send verification code")

    def test_staff_with_no_contact_email_shows_error(self):
        """Staff member without any ContactEmail cannot log in via email code."""
        Member.objects.create_user(password="testpass123", is_staff=True, is_active=True)
        # No ContactEmail created
        resp = self.client.post(LOGIN_URL, {"email": "nocontact@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Unable to send verification code")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_throttled_shows_error(self, mock_issue):
        mock_issue.side_effect = AuthChallengeThrottled("Too many codes requested.")
        resp = self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Too many codes requested")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_delivery_failure_shows_error(self, mock_issue):
        mock_issue.side_effect = AuthChallengeDeliveryError("Failed to send verification email.")
        resp = self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Failed to send verification code")
        # Should stay on email form so user can retry
        self.assertContains(resp, 'name="email"')

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_delivery_failure_does_not_advance_to_code_step(self, mock_issue):
        """When email delivery fails, session should NOT move to 'code' step."""
        mock_issue.side_effect = AuthChallengeDeliveryError("boom")
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertNotEqual(self.client.session.get("admin_login_step"), "code")

    # ── code step ───────────────────────────────────────────────────

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_post_valid_code_logs_in(self, mock_issue):
        # Step 1: submit email
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        # Create a pending challenge
        challenge = _create_pending_challenge(self.staff, "admin@example.com", code="654321")

        # Step 2: submit code
        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(LOGIN_URL, {"code": "654321"})

        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)
        # User should be authenticated
        resp2 = self.client.get("/admin/")
        self.assertEqual(resp2.status_code, 200)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_post_valid_code_sets_last_admin_cookie(self, mock_issue):
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        challenge = _create_pending_challenge(self.staff, "admin@example.com", code="654321")

        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(LOGIN_URL, {"code": "654321"})

        self.assertIn(LAST_ADMIN_LOGIN_COOKIE_NAME, resp.cookies)
        cookie = resp.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME]
        self.assertEqual(cookie["path"], "/admin/")
        self.assertTrue(cookie["httponly"])

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_post_valid_code_clears_session(self, mock_issue):
        """Session login state should be cleaned up after successful code verification."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(self.client.session.get("admin_login_step"), "code")

        challenge = _create_pending_challenge(self.staff, "admin@example.com", code="654321")
        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            self.client.post(LOGIN_URL, {"code": "654321"})

        self.assertNotIn("admin_login_step", self.client.session)
        self.assertNotIn("admin_login_email", self.client.session)
        self.assertNotIn("admin_login_member_id", self.client.session)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_post_invalid_code_shows_error(self, mock_issue):
        # Step 1
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        # Step 2 with invalid code
        with patch(
            "apps.authn.views.admin.login.verify_email_code",
            side_effect=AuthChallengeInvalid("bad"),
        ):
            resp = self.client.post(LOGIN_URL, {"code": "000000"})

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Verification code is invalid or has expired", count=1)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_invalid_code_stays_on_code_step(self, mock_issue):
        """After entering a wrong code the user should still be on the code step, not kicked to email."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        with patch(
            "apps.authn.views.admin.login.verify_email_code",
            side_effect=AuthChallengeInvalid("bad"),
        ):
            resp = self.client.post(LOGIN_URL, {"code": "000000"})

        self.assertContains(resp, 'name="code"')
        self.assertEqual(self.client.session.get("admin_login_step"), "code")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_short_code_fails_validation(self, mock_issue):
        """Code shorter than 6 digits should fail form validation."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        resp = self.client.post(LOGIN_URL, {"code": "123"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="code"')

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_code_step_without_session_redirects_to_email(self, mock_issue):
        """Submitting a code without prior email step should reset to email form."""
        # Directly POST a code without going through email step first
        resp = self.client.post(LOGIN_URL, {"code": "123456"})
        self.assertEqual(resp.status_code, 200)
        # Should show email form since no session state
        self.assertContains(resp, 'name="email"')

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_staff_deactivated_between_steps_shows_error(self, mock_issue):
        """If member loses staff status between email and code step, access is denied."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        challenge = _create_pending_challenge(self.staff, "admin@example.com", code="654321")

        # Deactivate staff between steps
        self.staff.is_staff = False
        self.staff.save()

        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(LOGIN_URL, {"code": "654321"})

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "You do not have access to the admin panel")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_member_deactivated_between_steps_shows_error(self, mock_issue):
        """If member becomes inactive between email and code step, access is denied."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        challenge = _create_pending_challenge(self.staff, "admin@example.com", code="654321")

        self.staff.is_active = False
        self.staff.save()

        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(LOGIN_URL, {"code": "654321"})

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "You do not have access to the admin panel")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_code_step_hides_last_admin_summary(self, mock_issue):
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = _last_admin_cookie_value(self.staff)

        resp = self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="code"')
        self.assertNotContains(resp, "Last signed in")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_remembered_admin_can_request_code_without_email_display(self, mock_issue):
        self.staff.first_name = "Ada"
        self.staff.last_name = "Lovelace"
        self.staff.save(update_fields=["first_name", "last_name"])
        self.client.cookies[LAST_ADMIN_LOGIN_COOKIE_NAME] = _last_admin_cookie_value(self.staff)

        resp = self.client.post(LOGIN_URL, {"action": "remembered_code"})

        self.assertEqual(resp.status_code, 200)
        mock_issue.assert_called_once()
        call_kwargs = mock_issue.call_args.kwargs
        self.assertEqual(call_kwargs["member"], self.staff)
        self.assertEqual(call_kwargs["purpose"], PURPOSE)
        self.assertEqual(call_kwargs["target_email"], "admin@example.com")
        self.assertContains(resp, 'name="code"')
        self.assertContains(resp, "A verification code has been sent to Ada Lovelace.")
        self.assertContains(resp, "We sent a 6-digit code to Ada Lovelace.")
        self.assertNotContains(resp, "admin@example.com")
        self.assertEqual(self.client.session.get("admin_login_step"), "code")
        self.assertTrue(self.client.session.get("admin_login_hide_email"))

    # ── resend ──────────────────────────────────────────────────────

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_resend_action(self, mock_issue):
        # Step 1
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        # Resend
        mock_issue.reset_mock()
        resp = self.client.post(LOGIN_URL, {"action": "resend"})
        self.assertEqual(resp.status_code, 200)
        mock_issue.assert_called_once()
        self.assertContains(resp, "A new verification code has been sent")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_resend_delivery_failure_shows_message(self, mock_issue):
        # Step 1: submit email successfully
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        # Resend fails
        mock_issue.reset_mock()
        mock_issue.side_effect = AuthChallengeDeliveryError("Failed to send verification email.")
        resp = self.client.post(LOGIN_URL, {"action": "resend"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Failed to send verification code")

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_resend_throttled_shows_message(self, mock_issue):
        """Resend that hits rate limit shows the throttle message, not an error page."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        mock_issue.reset_mock()
        mock_issue.side_effect = AuthChallengeThrottled(
            "Please wait before requesting another code."
        )
        resp = self.client.post(LOGIN_URL, {"action": "resend"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Please wait before requesting another code")
        # Should still show code form
        self.assertContains(resp, 'name="code"')

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_resend_with_deleted_member_resets_to_email(self, mock_issue):
        """If the member is deleted between steps, resend should reset to email form."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        # Delete the member
        self.staff.delete()

        mock_issue.reset_mock()
        resp = self.client.post(LOGIN_URL, {"action": "resend"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')
        mock_issue.assert_not_called()

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    def test_resend_with_demoted_member_resets_to_email(self, mock_issue):
        """If the member loses staff status, resend should reset to email form."""
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})

        self.staff.is_staff = False
        self.staff.save()

        mock_issue.reset_mock()
        resp = self.client.post(LOGIN_URL, {"action": "resend"})
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')
        mock_issue.assert_not_called()

    # ── navigation and redirects ────────────────────────────────────

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_step_email_query_resets_flow(self, mock_issue):
        # Step 1 → code step
        self.client.post(LOGIN_URL, {"email": "admin@example.com"})
        self.assertEqual(self.client.session.get("admin_login_step"), "code")

        # Reset via ?step=email
        resp = self.client.get(LOGIN_URL + "?step=email")
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'name="email"')
        self.assertNotIn("admin_login_step", self.client.session)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_next_redirect_parameter(self, mock_issue):
        # Step 1
        url = LOGIN_URL + "?next=/admin/cms/cmspage/"
        self.client.post(url, {"email": "admin@example.com"})

        challenge = _create_pending_challenge(self.staff, "admin@example.com")

        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(url, {"code": "123456"})

        self.assertRedirects(resp, "/admin/cms/cmspage/", fetch_redirect_response=False)

    @patch("apps.authn.views.admin.login.issue_email_challenge")
    # noinspection PyUnusedLocal
    def test_next_rejects_external_urls(self, mock_issue):
        url = LOGIN_URL + "?next=https://evil.com"
        self.client.post(url, {"email": "admin@example.com"})

        challenge = _create_pending_challenge(self.staff, "admin@example.com")

        with patch("apps.authn.views.admin.login.verify_email_code", return_value=challenge):
            resp = self.client.post(url, {"code": "123456"})

        # Should redirect to /admin/ instead of external URL
        self.assertRedirects(resp, "/admin/", fetch_redirect_response=False)
