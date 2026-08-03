import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet
from django.contrib.admin.sites import AdminSite
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings

from apps.messaging.admin import EmailProviderConfigAdmin, EmailProviderConfigForm
from apps.messaging.crypto import decrypt_secret, encrypt_secret
from apps.messaging.email_templates import brand_site_url, render_branded_email
from apps.messaging.models import EmailMessageLog, EmailProviderConfig
from apps.messaging.services import (
    EmailAttachment,
    EmailDeliveryError,
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

    def test_crypto_uses_raw_and_derived_keys_and_rejects_bad_tokens(self):
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
            aws_access_key_id="AKIAFIRST",
        )
        first.set_secret_access_key("first-secret")
        first.save()
        second = EmailProviderConfig.objects.create(
            name="Second",
            from_email="second@example.com",
            aws_access_key_id="AKIASECOND",
        )
        inactive = EmailProviderConfig.objects.create(
            name="Inactive",
            is_active=False,
            from_email="inactive@example.com",
            aws_access_key_id="AKIAINACTIVE",
        )
        first.refresh_from_db()
        self.assertFalse(first.is_active)
        self.assertIn("inactive", str(inactive))
        self.assertEqual(active_provider_config(), second)
        self.assertIn("active", str(second))
        self.assertEqual(first.get_secret_access_key(), "first-secret")

        form = EmailProviderConfigForm(
            data={
                "name": "Updated",
                "is_active": "on",
                "aws_region": "us-east-1",
                "from_email": "updated@example.com",
                "reply_to_email": "reply@example.com",
                "aws_access_key_id": "AKIAUPDATED",
                "secret_access_key": "updated-secret",
            },
            instance=second,
        )
        self.assertTrue(form.is_valid(), form.errors)
        updated = form.save()
        self.assertEqual(updated.get_secret_access_key(), "updated-secret")

        blank_secret = EmailProviderConfigForm(
            data={
                "name": "Updated",
                "is_active": "on",
                "aws_region": "us-east-1",
                "from_email": "updated@example.com",
                "reply_to_email": "",
                "aws_access_key_id": "AKIAUPDATED",
                "secret_access_key": "",
            },
            instance=updated,
        )
        self.assertTrue(blank_secret.is_valid(), blank_secret.errors)
        self.assertEqual(blank_secret.save(commit=False).get_secret_access_key(), "updated-secret")

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
        with patch("apps.messaging.services.EmailMultiAlternatives.send", return_value=0):
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
            "apps.messaging.services.EmailMultiAlternatives.send",
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
        config = EmailProviderConfig.objects.create(
            from_email="sender@example.com",
            reply_to_email="reply@example.com",
            aws_region="us-east-2",
            aws_access_key_id="AKIASES",
        )
        config.set_secret_access_key("secret")
        config.save()

        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            ses_client = Mock()
            ses_client.send_raw_email.return_value = {"MessageId": "ses-123"}
            fake_boto3 = SimpleNamespace(client=Mock(return_value=ses_client))
            with patch.dict(sys.modules, {"boto3": fake_boto3}):
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

        config.encrypted_secret_access_key = ""
        config.save(update_fields=["encrypted_secret_access_key", "updated_at"])
        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            with self.assertRaisesMessage(EmailDeliveryError, "access key and secret"):
                send_email_message(
                    subject="Bad SES",
                    body="Body",
                    recipients=["bad-ses@example.com"],
                    message_type=EmailMessageLog.MessageType.TEST,
                    provider_config=config,
                )

        EmailProviderConfig.objects.update(is_active=False)
        with override_settings(USE_SES_EMAIL_PROVIDER=True):
            with self.assertRaisesMessage(EmailDeliveryError, "No active AWS SES"):
                send_email_message(
                    subject="No config",
                    body="Body",
                    recipients=["missing-config@example.com"],
                    message_type=EmailMessageLog.MessageType.TEST,
                )

    def test_admin_action_updates_test_status(self):
        config = EmailProviderConfig.objects.create(
            from_email="sender@example.com",
            aws_access_key_id="AKIASES",
        )
        request = RequestFactory().post("/admin/messaging/emailproviderconfig/")
        model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())

        with patch.object(model_admin, "message_user") as message_user:
            model_admin.send_test_email(request, EmailProviderConfig.objects.filter(pk=config.pk))
        config.refresh_from_db()
        self.assertIsNotNone(config.last_tested_at)
        self.assertEqual(config.last_error, "")
        message_user.assert_called_once()

        with patch(
            "apps.messaging.admin.send_email_message",
            side_effect=EmailDeliveryError("bad credentials"),
        ):
            model_admin.send_test_email(request, EmailProviderConfig.objects.filter(pk=config.pk))
        config.refresh_from_db()
        self.assertEqual(config.last_error, "bad credentials")
