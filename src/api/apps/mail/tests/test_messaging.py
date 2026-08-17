import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet
from django.contrib.admin.sites import AdminSite
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from unfold.enums import ActionVariant

from apps.core.models import AWSCredentialConfig
from apps.mail.admin import (
    EmailProviderConfigAdmin,
    EmailProviderConfigForm,
    TestEmailForm,
)
from apps.mail.email_templates import brand_site_url, render_branded_email
from apps.mail.models import EmailMessageLog, EmailProviderConfig
from apps.mail.services import (
    EmailAttachment,
    EmailDeliveryError,
    _message,
    active_provider_config,
    frontend_url,
    send_email_message,
)


class MessagingTests(TestCase):
    @override_settings(FRONTEND_URL="https://releviz.com")
    def test_branded_email_template_uses_public_logo_and_escapes_content(self):
        html = render_branded_email(
            title="Branded message",
            paragraphs=("Safe <script>alert('no')</script>",),
            details=(("Event", "Planning & review"),),
            code="123456",
            cta_label="Open Releviz",
            cta_url="https://releviz.com/dashboard",
        )

        self.assertEqual(brand_site_url(), "https://releviz.com")
        self.assertIn('src="https://releviz.com/brand/releviz-logo.png"', html)
        self.assertIn("123456", html)
        self.assertIn("https://releviz.com/dashboard", html)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    @override_settings(FRONTEND_URL="https://releviz.com")
    def test_plain_email_automatically_receives_branded_html_fallback(self):
        send_email_message(
            subject="Fallback message",
            body="Plain text remains available.",
            recipients=["fallback@example.com"],
            message_type=EmailMessageLog.MessageType.TEST,
        )

        message = mail.outbox[-1]
        self.assertEqual(message.body, "Plain text remains available.")
        self.assertEqual(message.alternatives[0].mimetype, "text/html")
        self.assertIn("https://releviz.com/brand/releviz-logo.png", message.alternatives[0].content)
        self.assertIn("Plain text remains available.", message.alternatives[0].content)

    def test_message_builder_supports_plain_text_only(self):
        message = _message(
            subject="Plain message",
            body="Plain text only.",
            recipients=["plain@example.com"],
            from_email="no-reply@releviz.com",
        )

        self.assertEqual(message.body, "Plain text only.")
        self.assertEqual(message.alternatives, [])

    def test_crypto_uses_raw_and_derived_keys_and_rejects_bad_tokens(self):
        from apps.core.services.aws.crypto import decrypt_secret, encrypt_secret

        raw_key = Fernet.generate_key().decode("ascii")
        with override_settings(FIELD_ENCRYPTION_KEY=raw_key):
            encrypted = encrypt_secret("ses-secret")
            self.assertNotEqual(encrypted, "ses-secret")
            self.assertEqual(decrypt_secret(encrypted), "ses-secret")

        with override_settings(FIELD_ENCRYPTION_KEY="plain development key"):
            encrypted = encrypt_secret("derived-secret")
            self.assertEqual(decrypt_secret(encrypted), "derived-secret")
        self.assertEqual(decrypt_secret("not-a-fernet-token"), "")
        self.assertEqual(encrypt_secret(""), "")

    def test_provider_model_form_and_active_selection(self):
        first = EmailProviderConfig.objects.create(
            name="First",
            from_email="first@example.com",
        )
        second = EmailProviderConfig.objects.create(
            name="Second",
            from_email="second@example.com",
        )
        inactive = EmailProviderConfig.objects.create(
            name="Inactive",
            is_active=False,
            from_email="inactive@example.com",
        )
        first.refresh_from_db()
        self.assertFalse(first.is_active)
        self.assertIn("inactive", str(inactive))
        self.assertEqual(active_provider_config(), second)
        self.assertIn("active", str(second))

        form = EmailProviderConfigForm(
            data={
                "name": "Updated",
                "is_active": "on",
                "from_email": "updated@example.com",
                "reply_to_email": "reply@example.com",
            },
            instance=second,
        )
        self.assertTrue(form.is_valid(), form.errors)
        updated = form.save()
        self.assertEqual(updated.from_email, "updated@example.com")
        self.assertEqual(updated.reply_to_email, "reply@example.com")

    def test_admin_displays_only_active_aws_credentials(self):
        inactive = AWSCredentialConfig.objects.create(
            name="Inactive credentials",
            access_key_id="AKIAINACTIVE1234",
            default_region="us-west-1",
        )
        active = AWSCredentialConfig.objects.create(
            name="Production AWS",
            is_active=True,
            access_key_id="AKIAACTIVE5678",
            default_region="us-east-2",
        )
        active.set_secret_access_key("test-secret")
        active.save()
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())

        rendered = str(model_admin.active_aws_credentials(None))

        self.assertIn("Production AWS", rendered)
        self.assertIn("•••• 5678", rendered)
        self.assertIn("us-east-2", rendered)
        self.assertIn("Configured", rendered)
        self.assertNotIn(inactive.name, rendered)
        self.assertNotIn(active.access_key_id, rendered)

    def test_admin_explains_when_no_aws_credentials_are_active(self):
        AWSCredentialConfig.objects.create(
            name="Inactive credentials",
            access_key_id="AKIAINACTIVE1234",
        )
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())

        rendered = str(model_admin.active_aws_credentials(None))

        self.assertIn("No active AWS Credentials", rendered)
        self.assertIn("Open AWS Credentials", rendered)

    def test_frontend_url_and_django_backend_delivery_with_logs(self):
        with override_settings(FRONTEND_URL="", BACKEND_URL=""):
            self.assertEqual(frontend_url("/event", code="A B"), "/event?code=A+B")
        with override_settings(FRONTEND_URL="https://app.example.com/"):
            self.assertEqual(
                frontend_url("/event", code="ABC123"),
                "https://app.example.com/event?code=ABC123",
            )

        attachment = EmailAttachment("availability.ics", "BEGIN:VCALENDAR", "text/calendar")
        send_email_message(
            subject="Hello",
            body="Plain body",
            html_body="<p>Plain body</p>",
            recipients=[" User@Example.com "],
            message_type=EmailMessageLog.MessageType.TEST,
            attachments=[attachment],
        )
        self.assertEqual(mail.outbox[0].to, ["user@example.com"])
        self.assertEqual(mail.outbox[0].attachments[0][0], "availability.ics")
        log = EmailMessageLog.objects.get()
        self.assertEqual(str(log), "test to user@example.com [sent]")

        with self.assertRaisesMessage(EmailDeliveryError, "At least one recipient"):
            send_email_message(
                subject="No one",
                body="Body",
                recipients=[" "],
                message_type=EmailMessageLog.MessageType.TEST,
            )

    def test_delivery_failures_are_logged(self):
        with patch("apps.mail.services.EmailMultiAlternatives.send", return_value=0):
            with self.assertRaisesMessage(EmailDeliveryError, "did not send"):
                send_email_message(
                    subject="Zero",
                    body="Body",
                    recipients=["zero@example.com"],
                    message_type=EmailMessageLog.MessageType.TEST,
                )
        self.assertEqual(
            EmailMessageLog.objects.get(recipient="zero@example.com").status,
            EmailMessageLog.Status.FAILED,
        )

        with patch(
            "apps.mail.services.EmailMultiAlternatives.send",
            side_effect=RuntimeError("smtp down"),
        ):
            with self.assertRaisesMessage(EmailDeliveryError, "smtp down"):
                send_email_message(
                    subject="Crash",
                    body="Body",
                    recipients=["crash@example.com"],
                    message_type=EmailMessageLog.MessageType.TEST,
                )
        self.assertEqual(
            EmailMessageLog.objects.get(recipient="crash@example.com").error,
            "smtp down",
        )

    def test_ses_provider_success_and_configuration_errors(self):
        from apps.core.services.aws.credentials import AwsCredentials

        config = EmailProviderConfig.objects.create(
            from_email="sender@example.com",
            reply_to_email="reply@example.com",
        )

        mock_creds = AwsCredentials(
            access_key_id="AKIASES",
            secret_access_key="secret",
            region="us-east-2",
        )
        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            ses_client = Mock()
            ses_client.send_raw_email.return_value = {"MessageId": "ses-123"}
            fake_boto3 = SimpleNamespace(client=Mock(return_value=ses_client))
            with patch.dict(sys.modules, {"boto3": fake_boto3}):
                with patch(
                    "apps.core.services.aws.credentials.resolve_aws_credentials",
                    return_value=mock_creds,
                ):
                    message_id = send_email_message(
                        subject="SES",
                        body="Body",
                        recipients=["ses@example.com"],
                        message_type=EmailMessageLog.MessageType.TEST,
                        provider_config=config,
                    )
        self.assertEqual(message_id, "ses-123")
        fake_boto3.client.assert_called_once_with(
            "ses",
            region_name="us-east-2",
            aws_access_key_id="AKIASES",
            aws_secret_access_key="secret",
        )
        self.assertEqual(
            EmailMessageLog.objects.get(recipient="ses@example.com").provider_message_id,
            "ses-123",
        )

        # Test credential error when resolve_aws_credentials raises
        from apps.core.services.aws.credentials import AwsCredentialsError

        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            with patch(
                "apps.core.services.aws.credentials.resolve_aws_credentials",
                side_effect=AwsCredentialsError("not configured"),
            ):
                with self.assertRaisesMessage(
                    EmailDeliveryError, "AWS SES credentials are not configured"
                ):
                    send_email_message(
                        subject="Bad SES",
                        body="Body",
                        recipients=["bad-ses@example.com"],
                        message_type=EmailMessageLog.MessageType.TEST,
                        provider_config=config,
                    )

        # Test no active email provider config
        EmailProviderConfig.objects.update(is_active=False)
        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            with patch(
                "apps.core.services.aws.credentials.resolve_aws_credentials",
                return_value=mock_creds,
            ):
                with self.assertRaisesMessage(
                    EmailDeliveryError, "No active AWS SES email provider"
                ):
                    send_email_message(
                        subject="No config",
                        body="Body",
                        recipients=["missing-config@example.com"],
                        message_type=EmailMessageLog.MessageType.TEST,
                    )

    def test_test_email_form_defaults_to_active_provider_sender(self):
        config = EmailProviderConfig.objects.create(from_email="sender@example.com")

        form = TestEmailForm()

        self.assertEqual(form.fields["recipient"].initial, config.from_email)
        self.assertIn("w-full", form.fields["recipient"].widget.attrs["class"])

    def test_test_email_action_opens_a_dedicated_dark_mode_safe_page(self):
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())

        action_config = model_admin.get_unfold_action("send_test_email")

        self.assertIsNone(action_config.dialog)
        self.assertEqual(action_config.variant, ActionVariant.DEFAULT)

    def test_admin_test_email_action_updates_test_status(self):
        config = EmailProviderConfig.objects.create(from_email="sender@example.com")
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())
        request = RequestFactory().post(
            "/admin/mail/emailproviderconfig/send-test-email/",
            {"recipient": "recipient@example.com"},
        )
        request.user = Mock(has_perm=Mock(return_value=True))

        with patch("apps.mail.admin.send_email_message") as send_email:
            with patch.object(model_admin, "message_user") as message_user:
                response = model_admin.send_test_email(request)

        self.assertEqual(response.status_code, 302)
        send_email.assert_called_once_with(
            subject="Releviz email delivery test",
            body="This is a Releviz AWS SES delivery test.",
            recipients=["recipient@example.com"],
            message_type=EmailMessageLog.MessageType.TEST,
            provider_config=config,
        )
        config.refresh_from_db()
        self.assertIsNotNone(config.last_tested_at)
        self.assertEqual(config.last_error, "")
        message_user.assert_called_once()

    def test_admin_test_email_action_records_delivery_error(self):
        config = EmailProviderConfig.objects.create(from_email="sender@example.com")
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())
        request = RequestFactory().post(
            "/admin/mail/emailproviderconfig/send-test-email/",
            {"recipient": "recipient@example.com"},
        )
        request.user = Mock(has_perm=Mock(return_value=True))

        with patch(
            "apps.mail.admin.send_email_message",
            side_effect=EmailDeliveryError("bad credentials"),
        ):
            with patch.object(model_admin, "message_user"):
                response = model_admin.send_test_email(request)

        self.assertEqual(response.status_code, 302)
        config.refresh_from_db()
        self.assertEqual(config.last_error, "bad credentials")
