import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core import mail
from django.core.management import CommandError, call_command
from django.test import TestCase
from django.utils import timezone

from apps.authn.models import EmailAuthChallenge
from apps.authn.services import issue_email_challenge
from apps.authn.tests.helpers import create_member
from apps.messaging.crypto import decrypt_secret
from apps.messaging.models import EmailDeliveryJob, EmailMessageLog
from apps.messaging.services import (
    EmailAttachment,
    EmailDeliveryError,
    dispatch_due_email_jobs,
    dispatch_email_job,
    email_delivery_summary,
    enqueue_email_job,
)
from apps.scheduling.models import Event, EventInvitation


class EmailDeliveryJobTests(TestCase):
    def setUp(self):
        organizer = create_member("job-organizer@example.com")
        self.event = Event.objects.create(
            code="EMAILJOB",
            name="Email Jobs",
            organizer=organizer,
        )

    def enqueue(
        self,
        *,
        key=None,
        recipient="recipient@example.com",
        max_attempts=5,
        body="Body",
        invitation=None,
    ):
        job_key = key or f"job-{uuid.uuid4()}"
        return enqueue_email_job(
            idempotency_key=job_key,
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient=recipient,
            subject="Subject\r\nInjected",
            body=body,
            html_body="<p>Body</p>",
            attachments=[EmailAttachment("meeting.ics", "BEGIN:VCALENDAR", "text/calendar")],
            message_id=f"<{job_key}@releviz.local>",
            event=self.event,
            invitation=invitation,
            max_attempts=max_attempts,
        )

    def test_enqueue_is_idempotent_and_preserves_stable_content(self):
        key = "same-key"
        job, created = self.enqueue(
            key=key,
            recipient=" Recipient@Example.com ",
        )
        self.assertTrue(created)
        self.assertEqual(job.recipient, "recipient@example.com")
        self.assertEqual(job.subject, "Subject Injected")
        self.assertEqual(job.attachments[0]["filename"], "meeting.ics")
        self.assertIn("pending", str(job))
        token = job.new_lock_token()
        self.assertIsInstance(token, uuid.UUID)
        job.lock_token = token
        job.locked_at = timezone.now()
        job.reset_lock()
        self.assertIsNone(job.lock_token)
        self.assertIsNone(job.locked_at)

        repeated, repeated_created = self.enqueue(
            key=key,
            recipient="recipient@example.com",
        )
        self.assertFalse(repeated_created)
        self.assertEqual(repeated.pk, job.pk)
        with self.assertRaisesMessage(ValueError, "different content"):
            self.enqueue(
                key=key,
                recipient="recipient@example.com",
                body="Changed",
            )
        with self.assertRaisesMessage(ValueError, "event or member"):
            enqueue_email_job(
                idempotency_key="ownerless",
                message_type=EmailMessageLog.MessageType.TEST,
                recipient="ownerless@example.com",
                subject="Ownerless",
                body="Body",
                message_id="<ownerless@releviz.local>",
            )
        with self.assertRaisesMessage(ValueError, "requires a recipient"):
            enqueue_email_job(
                idempotency_key="recipientless",
                message_type=EmailMessageLog.MessageType.TEST,
                recipient=" ",
                subject="Recipientless",
                body="Body",
                message_id="<recipientless@releviz.local>",
                event=self.event,
            )

        encrypted, encrypted_created = enqueue_email_job(
            idempotency_key="encrypted",
            message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            recipient="secure@example.com",
            subject="Secure",
            body="Sensitive body",
            html_body="<p>Sensitive body</p>",
            message_id="<encrypted@releviz.local>",
            member=self.event.organizer,
            encrypt_content=True,
        )
        self.assertTrue(encrypted_created)
        self.assertTrue(encrypted.content_encrypted)
        self.assertNotIn("Sensitive body", encrypted.body)
        self.assertEqual(decrypt_secret(encrypted.body), "Sensitive body")
        repeated_encrypted, repeated_encrypted_created = enqueue_email_job(
            idempotency_key="encrypted",
            message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            recipient="secure@example.com",
            subject="Secure",
            body="Sensitive body",
            html_body="<p>Sensitive body</p>",
            message_id="<encrypted@releviz.local>",
            member=self.event.organizer,
            encrypt_content=True,
        )
        self.assertFalse(repeated_encrypted_created)
        self.assertEqual(repeated_encrypted.pk, encrypted.pk)

    def test_successful_dispatch_is_logged_and_not_repeated(self):
        job, _ = self.enqueue()
        result = dispatch_email_job(job.pk)
        self.assertEqual(result, {"attempted": True, "status": EmailDeliveryJob.Status.SENT})
        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.SENT)
        self.assertEqual(job.attempt_count, 1)
        self.assertIsNotNone(job.sent_at)
        self.assertIsNone(job.lock_token)
        self.assertEqual(mail.outbox[0].extra_headers["Message-ID"], job.message_id)
        self.assertEqual(mail.outbox[0].attachments[0][0], "meeting.ics")
        self.assertEqual(len(mail.outbox[0].alternatives), 1)
        self.assertEqual(EmailMessageLog.objects.get().delivery_job, job)

        self.assertEqual(
            dispatch_email_job(job.pk),
            {"attempted": False, "status": EmailDeliveryJob.Status.SENT},
        )
        self.assertEqual(
            dispatch_email_job(uuid.uuid4()),
            {"attempted": False, "status": "missing"},
        )

        invitation = EventInvitation.objects.create(
            event=self.event,
            email="linked@example.com",
            invited_by=self.event.organizer,
        )
        linked_final_job, _ = self.enqueue(
            recipient="linked@example.com",
            invitation=invitation,
        )
        dispatch_email_job(linked_final_job.pk)
        invitation.refresh_from_db()
        self.assertIsNone(invitation.last_sent_at)
        self.assertIsNone(invitation.reminder_sent_at)

    def test_not_due_and_fresh_processing_jobs_are_not_claimed(self):
        job, _ = self.enqueue()
        future = timezone.now() + timedelta(hours=1)
        job.next_attempt_at = future
        job.save(update_fields=["next_attempt_at", "updated_at"])
        self.assertEqual(
            dispatch_email_job(job.pk, now=timezone.now()),
            {"attempted": False, "status": EmailDeliveryJob.Status.PENDING},
        )

        job.status = EmailDeliveryJob.Status.PROCESSING
        job.locked_at = timezone.now()
        job.lock_token = uuid.uuid4()
        job.save(update_fields=["status", "locked_at", "lock_token", "updated_at"])
        self.assertEqual(
            dispatch_email_job(job.pk, now=timezone.now()),
            {"attempted": False, "status": EmailDeliveryJob.Status.PROCESSING},
        )

    def test_timeout_retry_success_and_permanent_failure(self):
        retry_job, _ = self.enqueue(recipient="retry@example.com", max_attempts=2)
        now = timezone.now() + timedelta(seconds=1)
        with patch(
            "apps.messaging.services.EmailMultiAlternatives.send",
            side_effect=TimeoutError("timeout"),
        ):
            first = dispatch_email_job(retry_job.pk, now=now)
        self.assertEqual(first["status"], EmailDeliveryJob.Status.RETRY)
        retry_job.refresh_from_db()
        self.assertEqual(retry_job.attempt_count, 1)
        self.assertEqual(retry_job.next_attempt_at, now + timedelta(minutes=1))
        self.assertEqual(
            dispatch_email_job(retry_job.pk, now=now),
            {"attempted": False, "status": EmailDeliveryJob.Status.RETRY},
        )

        second = dispatch_email_job(
            retry_job.pk,
            now=retry_job.next_attempt_at,
        )
        self.assertEqual(second["status"], EmailDeliveryJob.Status.SENT)
        retry_job.refresh_from_db()
        self.assertEqual(retry_job.attempt_count, 2)
        self.assertEqual(retry_job.last_error, "")

        permanent, _ = self.enqueue(recipient="permanent@example.com", max_attempts=1)
        with patch(
            "apps.messaging.services.send_email_message",
            side_effect=EmailDeliveryError("hard failure"),
        ):
            failed = dispatch_email_job(permanent.pk, now=now)
        self.assertEqual(failed["status"], EmailDeliveryJob.Status.PERMANENT_FAILURE)
        permanent.refresh_from_db()
        self.assertEqual(permanent.last_error, "hard failure")
        self.assertEqual(
            dispatch_email_job(permanent.pk),
            {
                "attempted": False,
                "status": EmailDeliveryJob.Status.PERMANENT_FAILURE,
            },
        )

    def test_lock_token_change_prevents_stale_worker_from_finishing(self):
        success_job, _ = self.enqueue(recipient="success-lock@example.com")

        def change_success_lock(**_kwargs):
            EmailDeliveryJob.objects.filter(pk=success_job.pk).update(lock_token=uuid.uuid4())
            return "provider-id"

        with patch(
            "apps.messaging.services.send_email_message",
            side_effect=change_success_lock,
        ):
            success = dispatch_email_job(success_job.pk)
        self.assertEqual(success["status"], EmailDeliveryJob.Status.PROCESSING)

        failure_job, _ = self.enqueue(recipient="failure-lock@example.com")

        def change_failure_lock(**_kwargs):
            EmailDeliveryJob.objects.filter(pk=failure_job.pk).update(lock_token=uuid.uuid4())
            raise EmailDeliveryError("late worker")

        with patch(
            "apps.messaging.services.send_email_message",
            side_effect=change_failure_lock,
        ):
            failure = dispatch_email_job(failure_job.pk)
        self.assertEqual(failure["status"], EmailDeliveryJob.Status.PROCESSING)

    def test_due_dispatch_handles_partial_failure_and_stale_processes(self):
        sent, _ = self.enqueue(recipient="sent@example.com")
        retry, _ = self.enqueue(recipient="retry-summary@example.com", max_attempts=2)
        permanent, _ = self.enqueue(recipient="permanent-summary@example.com", max_attempts=1)
        stale, _ = self.enqueue(recipient="stale@example.com")
        unlocked, _ = self.enqueue(recipient="unlocked@example.com")
        fresh, _ = self.enqueue(recipient="fresh@example.com")
        now = timezone.now() + timedelta(seconds=1)
        stale.status = EmailDeliveryJob.Status.PROCESSING
        stale.locked_at = now - timedelta(minutes=16)
        stale.lock_token = uuid.uuid4()
        stale.save(update_fields=["status", "locked_at", "lock_token", "updated_at"])
        unlocked.status = EmailDeliveryJob.Status.PROCESSING
        unlocked.locked_at = None
        unlocked.lock_token = uuid.uuid4()
        unlocked.save(update_fields=["status", "locked_at", "lock_token", "updated_at"])
        fresh.status = EmailDeliveryJob.Status.PROCESSING
        fresh.locked_at = now
        fresh.lock_token = uuid.uuid4()
        fresh.save(update_fields=["status", "locked_at", "lock_token", "updated_at"])

        def deliver(**kwargs):
            recipient = kwargs["recipients"][0]
            if recipient == retry.recipient:
                raise EmailDeliveryError("retry")
            if recipient == permanent.recipient:
                raise EmailDeliveryError("permanent")
            return f"provider-{recipient}"

        with patch("apps.messaging.services.send_email_message", side_effect=deliver):
            summary = dispatch_due_email_jobs(limit=10, now=now)
        self.assertEqual(
            summary,
            {
                "attempted": 5,
                "sent": 3,
                "retry": 1,
                "permanentFailure": 1,
                "canceled": 0,
            },
        )
        sent.refresh_from_db()
        stale.refresh_from_db()
        unlocked.refresh_from_db()
        fresh.refresh_from_db()
        self.assertEqual(sent.status, EmailDeliveryJob.Status.SENT)
        self.assertEqual(stale.status, EmailDeliveryJob.Status.SENT)
        self.assertEqual(unlocked.status, EmailDeliveryJob.Status.SENT)
        self.assertEqual(fresh.status, EmailDeliveryJob.Status.PROCESSING)

        pending, _ = self.enqueue(recipient="race@example.com")
        processing_race, _ = self.enqueue(recipient="processing-race@example.com")
        with patch(
            "apps.messaging.services.dispatch_email_job",
            side_effect=[
                {"attempted": False, "status": EmailDeliveryJob.Status.PENDING},
                {"attempted": True, "status": EmailDeliveryJob.Status.PROCESSING},
            ],
        ):
            empty = dispatch_due_email_jobs(limit=2, now=now)
        self.assertEqual(empty["attempted"], 1)
        self.assertEqual(empty["sent"], 0)
        self.assertTrue(EmailDeliveryJob.objects.filter(pk=pending.pk).exists())
        self.assertTrue(EmailDeliveryJob.objects.filter(pk=processing_race.pk).exists())

    def test_dispatch_command_validates_limit_and_processes_restart_pending_job(self):
        self.enqueue(recipient="restart@example.com")
        output = StringIO()
        call_command("dispatch_email_jobs", "--limit=10", stdout=output)
        self.assertIn("attempted=1 sent=1", output.getvalue())
        with self.assertRaises(CommandError):
            call_command("dispatch_email_jobs", "--limit=0")
        with self.assertRaises(CommandError):
            call_command("dispatch_email_jobs", "--limit=1001")

    def test_auth_challenge_jobs_cancel_when_inactive_or_expired(self):
        inactive = issue_email_challenge(
            member=self.event.organizer,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="job-organizer@example.com",
        )
        inactive.challenge.status = EmailAuthChallenge.Status.CONSUMED
        inactive.challenge.save(update_fields=["status", "updated_at"])
        canceled = dispatch_email_job(inactive.delivery_job.pk)
        self.assertEqual(canceled, {"attempted": False, "status": "canceled"})
        inactive.delivery_job.refresh_from_db()
        self.assertIn("no longer active", inactive.delivery_job.last_error)
        self.assertEqual(email_delivery_summary([inactive.delivery_job])["canceled"], 1)

        expired = issue_email_challenge(
            member=self.event.organizer,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="job-organizer@example.com",
        )
        expired.challenge.expires_at = timezone.now() - timedelta(seconds=1)
        expired.challenge.save(update_fields=["expires_at", "updated_at"])
        summary = dispatch_due_email_jobs(limit=10)
        self.assertEqual(summary["canceled"], 1)
        expired.challenge.refresh_from_db()
        expired.delivery_job.refresh_from_db()
        self.assertEqual(expired.challenge.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertEqual(expired.delivery_job.status, EmailDeliveryJob.Status.CANCELED)

    def test_encrypted_content_decryption_failure_is_retryable(self):
        job, _created = enqueue_email_job(
            idempotency_key="bad-encrypted-content",
            message_type=EmailMessageLog.MessageType.LOGIN_ALERT,
            recipient="secure@example.com",
            subject="Secure",
            body="Sensitive",
            message_id="<bad-encrypted-content@releviz.local>",
            member=self.event.organizer,
            encrypt_content=True,
        )
        EmailDeliveryJob.objects.filter(pk=job.pk).update(body="not-valid-ciphertext")
        result = dispatch_email_job(job.pk)
        self.assertEqual(result["status"], EmailDeliveryJob.Status.RETRY)
        job.refresh_from_db()
        self.assertIn("could not be decrypted", job.last_error)
