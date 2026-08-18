from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone

from apps.authn.models import EmailAuthChallenge
from apps.authn.tests.helpers import create_member
from apps.core.models import AWSCredentialConfig
from apps.core.services.aws.crypto import encrypt_secret
from apps.mail.admin import EmailDeliveryJobAdmin, EmailProviderConfigAdmin, TestEmailForm
from apps.mail.models import EmailDeliveryJob, EmailMessageLog, EmailProviderConfig
from apps.mail.services import _delivery_content, dispatch_email_job, enqueue_email_job


@override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
class MailAdminEdgeTests(TestCase):
    def setUp(self):
        self.model_admin = EmailProviderConfigAdmin(EmailProviderConfig, AdminSite())
        self.factory = RequestFactory()

    def test_form_without_active_provider_has_no_default_recipient(self):
        self.assertIsNone(TestEmailForm().fields["recipient"].initial)

    def test_aws_status_badge_covers_complete_and_incomplete_credentials(self):
        incomplete = AWSCredentialConfig.objects.create(name="Incomplete", is_active=True)
        self.assertEqual(
            self.model_admin.aws_credentials_status(None),
            ("Not configured", "warning"),
        )

        incomplete.access_key_id = "AKIA12345678"
        incomplete.set_secret_access_key("secret")
        incomplete.save()
        self.assertEqual(
            self.model_admin.aws_credentials_status(None),
            ("Configured", "success"),
        )

    @patch.object(EmailProviderConfigAdmin, "message_user")
    def test_post_without_active_provider_redirects_with_error(self, message_user):
        request = self.factory.post(
            "/admin/mail/emailproviderconfig/send-test-email/",
            {"recipient": "recipient@example.com"},
        )
        request.user = Mock(has_perm=Mock(return_value=True))

        response = self.model_admin.send_test_email(request)

        self.assertEqual(response.status_code, 302)
        self.assertIn("No active Email Provider", message_user.call_args.args[1])

    def test_get_renders_test_email_form_context(self):
        request = self.factory.get("/admin/mail/emailproviderconfig/send-test-email/")
        request.user = Mock(is_active=True, is_staff=True, has_perm=Mock(return_value=True))

        response = self.model_admin.send_test_email(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.template_name,
            "admin/mail/emailproviderconfig/send_test_email.html",
        )
        self.assertIsInstance(response.context_data["form"], TestEmailForm)
        self.assertContains(response, 'name="csrfmiddlewaretoken"')

    @patch.object(EmailDeliveryJobAdmin, "message_user")
    @patch.object(EmailDeliveryJobAdmin, "log_change")
    def test_uncertain_delivery_manual_retry_is_admin_audited(self, log_change, message_user):
        member = create_member("uncertain-admin@example.com")
        job, _created = enqueue_email_job(
            idempotency_key="uncertain-admin-retry",
            message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            recipient="uncertain-admin@example.com",
            subject="Alert",
            body="Body",
            message_id="<uncertain-admin-retry@releviz.local>",
            member=member,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            status=EmailDeliveryJob.Status.UNCERTAIN,
            attempt_count=job.max_attempts,
            provider_call_started_at=timezone.now(),
        )
        request = self.factory.post("/admin/mail/emaildeliveryjob/")
        request.user = member
        model_admin = EmailDeliveryJobAdmin(EmailDeliveryJob, AdminSite())

        model_admin.retry_uncertain_deliveries(
            request,
            EmailDeliveryJob.objects.filter(pk=job.pk),
        )

        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.RETRY)
        self.assertGreater(job.max_attempts, job.attempt_count)
        log_change.assert_called_once()
        message_user.assert_called_once()

    @patch("apps.mail.admin.retry_uncertain_email_job", return_value=False)
    @patch.object(EmailDeliveryJobAdmin, "message_user")
    @patch.object(EmailDeliveryJobAdmin, "log_change")
    def test_uncertain_delivery_admin_skips_claim_lost_race(
        self,
        log_change,
        message_user,
        _retry,
    ):
        member = create_member("uncertain-admin-race@example.com")
        job, _created = enqueue_email_job(
            idempotency_key="uncertain-admin-race",
            message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            recipient="uncertain-admin-race@example.com",
            subject="Alert",
            body="Body",
            message_id="<uncertain-admin-race@releviz.local>",
            member=member,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(status=EmailDeliveryJob.Status.UNCERTAIN)
        request = self.factory.post("/admin/mail/emaildeliveryjob/")
        request.user = member
        model_admin = EmailDeliveryJobAdmin(EmailDeliveryJob, AdminSite())

        model_admin.retry_uncertain_deliveries(
            request,
            EmailDeliveryJob.objects.filter(pk=job.pk),
        )

        log_change.assert_not_called()
        message_user.assert_called_once()


@override_settings(FIELD_ENCRYPTION_KEY="unit-test-encryption-key")
class MailDeliveryEdgeTests(TestCase):
    def test_encrypted_delivery_content_allows_blank_html(self):
        job = SimpleNamespace(
            content_encrypted=True,
            body=encrypt_secret("Plain body"),
            html_body="",
        )

        self.assertEqual(_delivery_content(job), ("Plain body", ""))

    @patch("apps.mail.services.send_email_message", return_value="provider-message-id")
    def test_pending_auth_challenge_is_sent_and_delivery_window_is_refreshed(self, _send):
        member = create_member("challenge-owner@example.com")
        original_expiry = timezone.now() + timedelta(minutes=1)
        challenge = EmailAuthChallenge.objects.create(
            member=member,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="challenge-owner@example.com",
            code_hash="hash",
            expires_at=original_expiry,
        )
        job, _created = enqueue_email_job(
            idempotency_key="active-auth-challenge",
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            recipient=challenge.target_email,
            subject="Verification code",
            body="Code",
            message_id="<active-auth-challenge@releviz.local>",
            member=member,
            auth_challenge=challenge,
        )

        result = dispatch_email_job(job.pk)

        self.assertEqual(
            result,
            {"attempted": True, "status": EmailDeliveryJob.Status.SENT},
        )
        challenge.refresh_from_db()
        self.assertIsNotNone(challenge.last_sent_at)
        self.assertGreater(challenge.expires_at, original_expiry)
