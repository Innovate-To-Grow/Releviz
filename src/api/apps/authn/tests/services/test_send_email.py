"""Tests for authn.services.email.send_email."""

from unittest.mock import MagicMock, patch

from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.authn.services.email.send_email import (
    _render_email_body,
    _send_via_django_backend,
    _send_via_ses,
    send_admin_invitation_email,
    send_notification_email,
    send_verification_email,
)
from apps.core.services.aws.provider_outcomes import (
    PROVIDER_OUTCOME_TRANSIENT,
    ProviderDeliveryError,
)
from apps.mail.models import EmailProviderConfig


class SendViaSesTests(TestCase):
    """Tests for the SES sending path."""

    def test_returns_false_when_source_address_is_empty(self):
        result = _send_via_ses(
            source_address="", recipient="a@b.com", subject="Hi", html_body="<p>Hi</p>"
        )
        self.assertFalse(result)

    @override_settings(PRINT_EMAILS_TO_TERMINAL=True)
    def test_terminal_print_mode_prints_and_skips_ses(self):
        with patch("apps.mail.terminal_output.print") as print_mock:
            result = _send_via_ses(
                source_address="Test <test@example.com>",
                recipient="a@b.com",
                subject="Hi",
                html_body="<p>Code 123456</p>",
            )

        self.assertTrue(result)
        rendered = "\n".join(call.args[0] for call in print_mock.call_args_list)
        self.assertIn("Hi", rendered)
        self.assertIn("a@b.com", rendered)
        self.assertIn("Test <test@example.com>", rendered)
        self.assertIn("Code 123456", rendered)

    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    @patch("apps.authn.services.email.send_email.boto3")
    def test_returns_true_on_success(self, mock_boto3, mock_resolve):
        from apps.core.services.aws.credentials import AwsCredentials

        mock_resolve.return_value = AwsCredentials(
            access_key_id="k", secret_access_key="s", region="us-west-2"
        )
        result = _send_via_ses(
            source_address="Test <test@example.com>",
            recipient="a@b.com",
            subject="Hi",
            html_body="<p>Hi</p>",
        )
        self.assertTrue(result)
        mock_boto3.client.return_value.send_email.assert_called_once()
        self.assertEqual(
            mock_boto3.client.call_args.kwargs["config"].retries["total_max_attempts"],
            1,
        )

    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    @patch("apps.authn.services.email.send_email.boto3")
    def test_uses_active_email_provider_as_source(self, mock_boto3, mock_resolve):
        from apps.core.services.aws.credentials import AwsCredentials

        EmailProviderConfig.objects.create(
            name="Default",
            is_active=True,
            from_email="no-reply@releviz.com",
        )
        mock_resolve.return_value = AwsCredentials(
            access_key_id="k", secret_access_key="s", region="us-west-2"
        )

        result = _send_via_ses(
            recipient="a@b.com",
            subject="Hi",
            html_body="<p>Hi</p>",
        )

        self.assertTrue(result)
        self.assertEqual(
            mock_boto3.client.return_value.send_email.call_args.kwargs["Source"],
            "no-reply@releviz.com",
        )

    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    @patch("apps.authn.services.email.send_email.boto3")
    def test_returns_false_without_active_email_provider(self, mock_boto3, mock_resolve):
        result = _send_via_ses(
            recipient="a@b.com",
            subject="Hi",
            html_body="<p>Hi</p>",
        )

        self.assertFalse(result)
        mock_resolve.assert_not_called()
        mock_boto3.client.assert_not_called()

    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    @patch("apps.authn.services.email.send_email.boto3")
    def test_returns_false_on_client_error(self, mock_boto3, mock_resolve):
        from botocore.exceptions import ClientError

        from apps.core.services.aws.credentials import AwsCredentials

        mock_resolve.return_value = AwsCredentials(
            access_key_id="k", secret_access_key="s", region="us-west-2"
        )
        mock_boto3.client.return_value.send_email.side_effect = ClientError(
            {"Error": {"Code": "MessageRejected", "Message": "boom"}}, "SendEmail"
        )
        result = _send_via_ses(
            source_address="Test <test@example.com>",
            recipient="a@b.com",
            subject="Hi",
            html_body="<p>Hi</p>",
        )
        self.assertFalse(result)

    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    @patch("apps.authn.services.email.send_email.boto3")
    def test_worker_mode_raises_sanitized_transient_error(self, mock_boto3, mock_resolve):
        from botocore.exceptions import ClientError

        from apps.core.services.aws.credentials import AwsCredentials

        mock_resolve.return_value = AwsCredentials(
            access_key_id="k", secret_access_key="s", region="us-west-2"
        )
        mock_boto3.client.return_value.send_email.side_effect = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "secret detail"}},
            "SendEmail",
        )

        with self.assertRaises(ProviderDeliveryError) as raised:
            _send_via_ses(
                source_address="Test <test@example.com>",
                recipient="a@b.com",
                subject="Hi",
                html_body="<p>Hi</p>",
                raise_provider_errors=True,
            )

        self.assertEqual(raised.exception.outcome, PROVIDER_OUTCOME_TRANSIENT)
        self.assertNotIn("secret detail", str(raised.exception))


class SendVerificationEmailTests(TestCase):
    """Tests for the full send_verification_email flow."""

    @override_settings(FRONTEND_URL="https://www.example.com")
    def test_render_body_includes_register_continue_link(self):
        html = _render_email_body(
            recipient="new-user@example.com",
            code="123456",
            purpose="register",
            link_flow="register",
            link_source="register",
        )

        self.assertIn("Continue Registration", html)
        self.assertIn("email-auth-link#flow=register", html)
        self.assertIn("source=register", html)
        self.assertIn("email=new-user%40example.com", html)
        self.assertIn("code=123456", html)
        self.assertIn("Releviz security", html)
        self.assertIn("/brand/releviz-logo.png", html)
        self.assertNotIn("Innovate to Grow", html)

    @override_settings(FRONTEND_URL="https://www.example.com")
    def test_render_body_includes_login_link_for_public_auth(self):
        html = _render_email_body(
            recipient="member@example.com",
            code="123456",
            purpose="login",
            link_flow="auth",
            link_source="login",
        )

        self.assertIn("Sign In to Your Account", html)
        self.assertIn("email-auth-link#flow=auth", html)
        self.assertIn("source=login", html)
        self.assertIn("email=member%40example.com", html)

    @override_settings(FRONTEND_URL="https://www.example.com")
    def test_render_body_includes_event_param_for_event_registration(self):
        html = _render_email_body(
            recipient="member@example.com",
            code="123456",
            purpose="login",
            link_flow="auth",
            link_source="event_registration",
            link_event="fall-showcase",
        )

        self.assertIn("Continue to Event Registration", html)
        self.assertIn("event=fall-showcase", html)

    @override_settings(FRONTEND_URL="https://www.example.com")
    def test_render_body_omits_event_param_when_no_event(self):
        html = _render_email_body(
            recipient="member@example.com",
            code="123456",
            purpose="login",
            link_flow="auth",
            link_source="event_registration",
            link_event="",
        )

        self.assertIn("email-auth-link#flow=auth", html)
        self.assertNotIn("event=", html)

    @override_settings(FRONTEND_URL="https://www.example.com")
    def test_render_body_omits_public_link_for_admin_login(self):
        html = _render_email_body(
            recipient="admin@example.com",
            code="123456",
            purpose="admin_login",
        )

        self.assertNotIn("email-auth-link", html)
        self.assertNotIn("Continue Registration", html)
        self.assertNotIn("Sign In to Your Account", html)

    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=True)
    def test_ses_success_completes(self, mock_ses):
        send_verification_email(recipient="a@b.com", code="123456", purpose="admin_login")
        mock_ses.assert_called_once()

    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_ses_failure_raises(self, mock_ses):
        with self.assertRaises(RuntimeError):
            send_verification_email(recipient="a@b.com", code="123456", purpose="admin_login")
        mock_ses.assert_called_once()


class SendNotificationEmailTests(TestCase):
    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=True)
    def test_notification_sent_via_ses(self, mock_ses):
        send_notification_email(
            recipient="owner@example.com",
            subject="Security notice",
            template="authn/email/email_claim_notification.html",
            context={"account_url": "https://example.com/account"},
        )
        mock_ses.assert_called_once()

    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_notification_logs_when_send_fails(self, mock_ses):
        # Should NOT raise — notification failures are swallowed (logged).
        send_notification_email(
            recipient="owner@example.com",
            subject="Security notice",
            template="authn/email/email_claim_notification.html",
            context={"account_url": ""},
        )
        mock_ses.assert_called_once()


class SendViaSesCredentialErrorTests(TestCase):
    @patch("apps.authn.services.email.send_email.transport.resolve_aws_credentials")
    def test_returns_false_when_credentials_missing(self, mock_resolve):
        from apps.core.services.aws.credentials import AwsCredentialsError

        mock_resolve.side_effect = AwsCredentialsError("no creds")
        result = _send_via_ses(
            source_address="Test <test@example.com>",
            recipient="a@b.com",
            subject="Hi",
            html_body="<p>Hi</p>",
        )
        self.assertFalse(result)


class SendAdminInvitationEmailTests(TestCase):
    """Tests for the admin invitation email flow."""

    def _invitation(self):
        invitation = MagicMock()
        invitation.email = "new-admin@example.com"
        invitation.expires_at = timezone.now() + timezone.timedelta(days=7)
        invitation.invited_by = None
        invitation.message = "Please help manage the spring event."
        invitation.get_acceptance_url.return_value = "https://admin.example.com/authn/invite/token/"
        invitation.get_role_display.return_value = "Admin"
        return invitation

    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_ses_failure_raises(self, mock_ses):
        invitation = self._invitation()

        with self.assertRaises(RuntimeError):
            send_admin_invitation_email(invitation=invitation)

        mock_ses.assert_called_once()

    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=True)
    def test_ses_success_sends_invitation(self, mock_ses):
        send_admin_invitation_email(invitation=self._invitation())

        mock_ses.assert_called_once()


class DjangoBackendFallbackTests(TestCase):
    """The Django email backend stands in wherever SES is deliberately absent."""

    def _invitation(self):
        invitation = MagicMock()
        invitation.email = "new-admin@example.com"
        invitation.expires_at = timezone.now() + timezone.timedelta(days=7)
        invitation.invited_by = None
        invitation.message = "Please help manage the spring event."
        invitation.get_acceptance_url.return_value = "https://admin.example.com/authn/invite/token/"
        invitation.get_role_display.return_value = "Admin"
        return invitation

    def test_disabled_by_default(self):
        self.assertFalse(
            _send_via_django_backend(recipient="a@b.com", subject="Hi", html_body="<p>Hi</p>")
        )

    @override_settings(PRINT_EMAILS_TO_TERMINAL=True)
    def test_terminal_print_mode_bypasses_backend_without_fallback_flag(self):
        with patch("apps.mail.terminal_output.print") as print_mock:
            sent = _send_via_django_backend(
                recipient="a@b.com", subject="Your code", html_body="<p>Code 123456</p>"
            )

        self.assertTrue(sent)
        self.assertEqual(len(mail.outbox), 0)
        rendered = "\n".join(call.args[0] for call in print_mock.call_args_list)
        self.assertIn("Your code", rendered)
        self.assertIn("a@b.com", rendered)
        self.assertIn("Code 123456", rendered)

    @override_settings(PRINT_EMAILS_TO_TERMINAL=True)
    @patch("apps.mail.terminal_output.print")
    def test_verification_email_prints_to_terminal(self, print_mock):
        send_verification_email(recipient="a@b.com", code="123456", purpose="login")

        rendered = "\n".join(call.args[0] for call in print_mock.call_args_list)
        self.assertIn("123456", rendered)
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(AUTH_EMAIL_DJANGO_BACKEND_FALLBACK=True)
    def test_sends_html_and_plain_text_alternatives(self):
        sent = _send_via_django_backend(
            recipient="a@b.com", subject="Your code", html_body="<p>Code 123456</p>"
        )

        self.assertTrue(sent)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.subject, "Your code")
        self.assertEqual(message.to, ["a@b.com"])
        self.assertIn("Code 123456", message.body)
        self.assertEqual(message.alternatives[0][1], "text/html")

    @override_settings(AUTH_EMAIL_DJANGO_BACKEND_FALLBACK=True)
    def test_reports_failure_when_the_backend_sends_nothing(self):
        with patch(
            "apps.authn.services.email.send_email.transport.EmailMultiAlternatives.send",
            return_value=0,
        ):
            self.assertFalse(
                _send_via_django_backend(recipient="a@b.com", subject="Hi", html_body="<p>Hi</p>")
            )

    @override_settings(AUTH_EMAIL_DJANGO_BACKEND_FALLBACK=True)
    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_verification_email_falls_back(self, mock_ses):
        send_verification_email(recipient="a@b.com", code="123456", purpose="login")

        mock_ses.assert_called_once()
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("123456", mail.outbox[0].body)

    @override_settings(AUTH_EMAIL_DJANGO_BACKEND_FALLBACK=True)
    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_notification_email_falls_back(self, mock_ses):
        sent = send_notification_email(
            recipient="a@b.com",
            subject="Notice",
            template="authn/email/email_claim_notification.html",
            context={},
        )

        self.assertTrue(sent)
        mock_ses.assert_called_once()
        self.assertEqual(len(mail.outbox), 1)

    @override_settings(AUTH_EMAIL_DJANGO_BACKEND_FALLBACK=True)
    @patch("apps.authn.services.email.send_email._send_via_ses", return_value=False)
    def test_admin_invitation_email_falls_back(self, mock_ses):
        send_admin_invitation_email(invitation=self._invitation())

        mock_ses.assert_called_once()
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["new-admin@example.com"])
