import uuid
from datetime import timedelta
from io import StringIO
from threading import Event as StopEvent
from unittest.mock import patch

from django.core import mail
from django.core.management import CommandError, call_command
from django.test import TestCase
from django.utils import timezone

from apps.authn.models import EmailAuthChallenge
from apps.authn.tests.helpers import create_member
from apps.core.services.aws.crypto import decrypt_secret
from apps.core.services.aws.provider_outcomes import (
    PROVIDER_OUTCOME_PERMANENT,
    PROVIDER_OUTCOME_TRANSIENT,
    PROVIDER_OUTCOME_UNCERTAIN,
)
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.mail.services import (
    EmailAttachment,
    EmailDeliveryError,
    _begin_email_provider_call,
    _DispatchRateLimiter,
    _safe_log_each,
    dispatch_due_email_jobs,
    dispatch_email_job,
    email_delivery_summary,
    enqueue_email_job,
    retry_uncertain_email_job,
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

    def test_message_log_failure_is_isolated_from_delivery_state(self):
        with (
            patch(
                "apps.mail.services._log_each",
                side_effect=RuntimeError("message log unavailable"),
            ),
            self.assertLogs("apps.mail.services", level="ERROR") as logs,
        ):
            _safe_log_each(
                recipients=["recipient@example.com"],
                subject="Subject",
                message_type=EmailMessageLog.MessageType.INVITATION,
                status=EmailMessageLog.Status.FAILED,
            )

        self.assertTrue(any("email_message_log_failed" in line for line in logs.output))

    def test_invitation_and_reminder_jobs_are_canceled_if_event_is_not_active(self):
        invitation = EventInvitation.objects.create(
            event=self.event,
            email="inactive-event@example.com",
            invited_by=self.event.organizer,
        )
        jobs = []
        for message_type in (
            EmailMessageLog.MessageType.INVITATION,
            EmailMessageLog.MessageType.REMINDER,
        ):
            job, _created = enqueue_email_job(
                idempotency_key=f"inactive-{message_type}-{uuid.uuid4()}",
                message_type=message_type,
                recipient=invitation.email,
                subject="Subject",
                body="Body",
                message_id=f"<inactive-{message_type}-{uuid.uuid4()}@releviz.local>",
                event=self.event,
                invitation=invitation,
            )
            jobs.append(job)
        self.event.status = Event.Status.CLOSED
        self.event.save(update_fields=["status", "updated_at"])

        for job in jobs:
            result = dispatch_email_job(job.pk)
            self.assertEqual(
                result,
                {"attempted": False, "status": EmailDeliveryJob.Status.CANCELED},
            )
            job.refresh_from_db()
            self.assertEqual(job.status, EmailDeliveryJob.Status.CANCELED)
            self.assertEqual(job.last_error, "The event is no longer active.")

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

    def test_final_cancellation_dependencies_and_exhausted_claims_are_safe(self):
        recipient = "calendar-dependency@example.com"
        event_id = self.event.event_id
        now = timezone.now()
        predecessor, _created = enqueue_email_job(
            idempotency_key=f"final-confirmation:{event_id}:0:{recipient}",
            message_type=EmailMessageLog.MessageType.FINAL_CONFIRMATION,
            recipient=recipient,
            subject="Confirmed",
            body="request",
            message_id="<dependency-confirmation@releviz.local>",
            event=self.event,
        )
        predecessor.status = EmailDeliveryJob.Status.PROCESSING
        predecessor.attempt_count = 1
        predecessor.locked_at = now
        predecessor.lock_token = uuid.uuid4()
        predecessor.save(
            update_fields=[
                "status",
                "attempt_count",
                "locked_at",
                "lock_token",
                "updated_at",
            ]
        )
        cancellation, _created = enqueue_email_job(
            idempotency_key=f"final-cancellation:{event_id}:1:{recipient}",
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION,
            recipient=recipient,
            subject="Canceled",
            body="cancel",
            message_id="<dependency-cancellation@releviz.local>",
            event=self.event,
        )

        waiting = dispatch_email_job(cancellation.pk, now=now)
        self.assertEqual(waiting["attempted"], False)
        cancellation.refresh_from_db()
        self.assertEqual(cancellation.status, EmailDeliveryJob.Status.PENDING)
        self.assertEqual(cancellation.next_attempt_at, now + timedelta(seconds=5))

        predecessor.status = EmailDeliveryJob.Status.RETRY
        predecessor.save(update_fields=["status", "updated_at"])
        canceled = dispatch_email_job(cancellation.pk, now=now + timedelta(seconds=5))
        self.assertEqual(canceled, {"attempted": False, "status": "canceled"})
        cancellation.refresh_from_db()
        self.assertIn("preceding calendar request", cancellation.last_error)

        for key in (
            "final-cancellation:malformed",
            f"final-cancellation:{event_id}:not-a-sequence:recipient@example.com",
        ):
            malformed, _created = enqueue_email_job(
                idempotency_key=key,
                message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION,
                recipient=f"malformed-{uuid.uuid4()}@example.com",
                subject="Malformed dependency",
                body="cancel",
                message_id=f"<{uuid.uuid4()}@releviz.local>",
                event=self.event,
            )
            self.assertEqual(
                dispatch_email_job(malformed.pk)["status"],
                EmailDeliveryJob.Status.SENT,
            )

        missing, _created = enqueue_email_job(
            idempotency_key=(f"final-cancellation:{event_id}:1:missing-predecessor@example.com"),
            message_type=EmailMessageLog.MessageType.FINAL_CANCELLATION,
            recipient="missing-predecessor@example.com",
            subject="Missing dependency",
            body="cancel",
            message_id="<missing-dependency@releviz.local>",
            event=self.event,
        )
        self.assertEqual(dispatch_email_job(missing.pk)["status"], "canceled")

        with patch("apps.mail.services.logger.error") as log_terminal_failure:
            for position, last_error in enumerate(("", "previous failure")):
                exhausted, _created = self.enqueue(
                    recipient=f"exhausted-{position}@example.com",
                    max_attempts=1,
                )
                exhausted.attempt_count = exhausted.max_attempts
                exhausted.last_error = last_error
                exhausted.save(update_fields=["attempt_count", "last_error", "updated_at"])
                result = dispatch_email_job(exhausted.pk)
                self.assertEqual(result["attempted"], False)
                self.assertEqual(result["status"], EmailDeliveryJob.Status.PERMANENT_FAILURE)
                exhausted.refresh_from_db()
                self.assertEqual(
                    exhausted.last_error,
                    last_error or "Maximum delivery attempts reached.",
                )

        self.assertEqual(log_terminal_failure.call_count, 2)
        for call in log_terminal_failure.call_args_list:
            self.assertEqual(call.args[0], "email_delivery_failed")
            self.assertEqual(
                call.kwargs["extra"]["status"],
                EmailDeliveryJob.Status.PERMANENT_FAILURE,
            )

    def test_confirmed_transient_retry_success_and_permanent_failure(self):
        retry_job, _ = self.enqueue(recipient="retry@example.com", max_attempts=2)
        now = timezone.now() + timedelta(seconds=1)
        with patch(
            "apps.mail.services.send_email_message",
            side_effect=EmailDeliveryError(
                "provider unavailable before acceptance",
                outcome=PROVIDER_OUTCOME_TRANSIENT,
            ),
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
            "apps.mail.services.send_email_message",
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

        provider_rejected, _ = self.enqueue(
            recipient="provider-rejected@example.com",
            max_attempts=2,
        )
        with patch(
            "apps.mail.services.send_email_message",
            side_effect=EmailDeliveryError(
                "provider rejected request",
                outcome=PROVIDER_OUTCOME_PERMANENT,
            ),
        ):
            rejected = dispatch_email_job(provider_rejected.pk, now=now)
        self.assertEqual(rejected["status"], EmailDeliveryJob.Status.PERMANENT_FAILURE)

    def test_provider_call_marker_rejects_a_lost_claim(self):
        job, _created = self.enqueue(recipient="lost-claim@example.com")

        with self.assertRaises(EmailDeliveryError) as raised:
            _begin_email_provider_call(
                job.pk,
                token=uuid.uuid4(),
                now=timezone.now(),
            )

        self.assertEqual(raised.exception.outcome, PROVIDER_OUTCOME_UNCERTAIN)

    def test_provider_timeout_is_quarantined_without_automatic_retry(self):
        job, _created = self.enqueue(recipient="uncertain-timeout@example.com")

        with patch(
            "apps.mail.services.EmailMultiAlternatives.send",
            side_effect=TimeoutError("response lost"),
        ):
            result = dispatch_email_job(job.pk)

        self.assertEqual(result["status"], EmailDeliveryJob.Status.UNCERTAIN)
        job.refresh_from_db()
        self.assertIsNotNone(job.provider_call_started_at)
        self.assertIsNone(job.lock_token)
        self.assertEqual(
            dispatch_email_job(job.pk),
            {"attempted": False, "status": EmailDeliveryJob.Status.UNCERTAIN},
        )

    def test_unexpected_dispatch_exception_is_persisted_and_does_not_escape(self):
        job, _created = self.enqueue(recipient="unexpected@example.com", max_attempts=2)
        now = timezone.now() + timedelta(seconds=1)

        with (
            patch(
                "apps.mail.services.send_email_message",
                side_effect=RuntimeError("unexpected provider failure"),
            ),
            self.assertLogs("apps.mail.services", level="ERROR") as logs,
        ):
            result = dispatch_email_job(job.pk, now=now)

        self.assertEqual(result, {"attempted": True, "status": EmailDeliveryJob.Status.RETRY})
        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.RETRY)
        self.assertEqual(job.attempt_count, 1)
        self.assertEqual(job.next_attempt_at, now + timedelta(minutes=1))
        self.assertEqual(job.last_error, "unexpected provider failure")
        self.assertIsNone(job.lock_token)
        self.assertIsNone(job.locked_at)
        self.assertTrue(any("email_delivery_unexpected_failure" in line for line in logs.output))

    def test_lock_token_change_prevents_stale_worker_from_finishing(self):
        success_job, _ = self.enqueue(recipient="success-lock@example.com")

        def change_success_lock(**_kwargs):
            EmailDeliveryJob.objects.filter(pk=success_job.pk).update(lock_token=uuid.uuid4())
            return "provider-id"

        with patch(
            "apps.mail.services.send_email_message",
            side_effect=change_success_lock,
        ):
            success = dispatch_email_job(success_job.pk)
        self.assertEqual(success["status"], EmailDeliveryJob.Status.PROCESSING)

        failure_job, _ = self.enqueue(recipient="failure-lock@example.com")

        def change_failure_lock(**_kwargs):
            EmailDeliveryJob.objects.filter(pk=failure_job.pk).update(lock_token=uuid.uuid4())
            raise EmailDeliveryError("late worker")

        with patch(
            "apps.mail.services.send_email_message",
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

        with patch("apps.mail.services.send_email_message", side_effect=deliver):
            summary = dispatch_due_email_jobs(limit=10, now=now)
        self.assertEqual(
            summary,
            {
                "attempted": 5,
                "sent": 3,
                "retry": 1,
                "permanentFailure": 1,
                "uncertain": 0,
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
            "apps.mail.services.dispatch_email_job",
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

    def test_stale_post_provider_claim_is_uncertain_until_manual_requeue(self):
        job, _created = self.enqueue(recipient="crashed-after-provider@example.com")
        now = timezone.now()
        EmailDeliveryJob.objects.filter(pk=job.pk).update(
            status=EmailDeliveryJob.Status.PROCESSING,
            attempt_count=1,
            locked_at=now - timedelta(minutes=16),
            lock_token=uuid.uuid4(),
            provider_call_started_at=now - timedelta(minutes=16),
        )

        with patch("apps.mail.services.send_email_message") as send:
            summary = dispatch_due_email_jobs(limit=10, now=now)

        send.assert_not_called()
        self.assertEqual(summary["attempted"], 0)
        self.assertEqual(summary["uncertain"], 1)
        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.UNCERTAIN)
        self.assertIn("outcome is uncertain", job.last_error)

        self.assertTrue(retry_uncertain_email_job(job.pk, now=now))
        self.assertFalse(retry_uncertain_email_job(job.pk, now=now))
        job.refresh_from_db()
        self.assertEqual(job.status, EmailDeliveryJob.Status.RETRY)
        self.assertIsNone(job.provider_call_started_at)
        self.assertGreaterEqual(job.max_attempts, 2)

    def test_due_dispatch_isolates_an_unhandled_job_and_continues(self):
        first, _created = self.enqueue(recipient="poisoned@example.com")
        second, _created = self.enqueue(recipient="healthy-after-poison@example.com")

        with (
            patch(
                "apps.mail.services.dispatch_email_job",
                side_effect=[
                    RuntimeError("poisoned job"),
                    {"attempted": True, "status": EmailDeliveryJob.Status.SENT},
                ],
            ) as dispatch,
            self.assertLogs("apps.mail.services", level="ERROR") as logs,
        ):
            summary = dispatch_due_email_jobs(limit=2)

        self.assertEqual(dispatch.call_count, 2)
        self.assertEqual(
            summary,
            {
                "attempted": 1,
                "sent": 1,
                "retry": 0,
                "permanentFailure": 0,
                "uncertain": 0,
                "canceled": 0,
            },
        )
        self.assertTrue(any("email_delivery_job_unhandled" in line for line in logs.output))
        self.assertTrue(EmailDeliveryJob.objects.filter(pk=first.pk).exists())
        self.assertTrue(EmailDeliveryJob.objects.filter(pk=second.pk).exists())

    def test_dispatch_command_validates_limit_and_processes_restart_pending_job(self):
        self.enqueue(recipient="restart@example.com")
        output = StringIO()
        call_command("dispatch_email_jobs", "--limit=10", stdout=output)
        self.assertIn("attempted=1 sent=1", output.getvalue())
        with self.assertRaises(CommandError):
            call_command("dispatch_email_jobs", "--limit=0")
        with self.assertRaises(CommandError):
            call_command("dispatch_email_jobs", "--limit=1001")

    def test_dispatch_supports_concurrency_rate_limiting_and_graceful_watch_stop(self):
        for position in range(3):
            self.enqueue(recipient=f"parallel-{position}@example.com")
        with (
            patch(
                "apps.mail.services.dispatch_email_job",
                return_value={"attempted": True, "status": EmailDeliveryJob.Status.SENT},
            ) as dispatch,
            patch.object(_DispatchRateLimiter, "wait", return_value=True) as wait,
        ):
            summary = dispatch_due_email_jobs(
                limit=10,
                concurrency=2,
                rate_limit_per_second=20,
            )
        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["sent"], 3)
        self.assertEqual(dispatch.call_count, 3)
        self.assertEqual(wait.call_count, 3)

        with self.assertRaisesMessage(ValueError, "concurrency"):
            dispatch_due_email_jobs(concurrency=0)
        with self.assertRaisesMessage(ValueError, "rate_limit_per_second"):
            dispatch_due_email_jobs(rate_limit_per_second=0)

        stop_event = StopEvent()
        stop_event.set()
        self.assertFalse(_DispatchRateLimiter(None).wait(stop_event))
        self.assertFalse(_DispatchRateLimiter(2).wait(stop_event))
        stopped = dispatch_due_email_jobs(limit=10, stop_event=stop_event)
        self.assertEqual(stopped["attempted"], 0)
        with (
            patch("apps.mail.services.time.monotonic", side_effect=[5.0, 5.0]),
            patch("apps.mail.services.time.sleep") as sleep,
        ):
            limiter = _DispatchRateLimiter(2)
            self.assertTrue(limiter.wait())
            self.assertTrue(limiter.wait())
        sleep.assert_called_once_with(0.5)

        command_summary = {
            "attempted": 0,
            "sent": 0,
            "retry": 0,
            "permanentFailure": 0,
            "uncertain": 0,
            "canceled": 0,
        }

        def stop_after_batch(**kwargs):
            kwargs["stop_event"].set()
            return command_summary

        output = StringIO()
        with patch(
            "apps.mail.management.commands.dispatch_email_jobs.dispatch_due_email_jobs",
            side_effect=stop_after_batch,
        ):
            call_command(
                "dispatch_email_jobs",
                "--watch",
                "--poll-interval=0.1",
                "--concurrency=2",
                "--rate-limit=20",
                stdout=output,
            )
        self.assertIn("attempted=0", output.getvalue())

        for argument in ("--concurrency=0", "--concurrency=65", "--rate-limit=-1"):
            with self.subTest(argument=argument), self.assertRaises(CommandError):
                call_command("dispatch_email_jobs", argument)
        with self.assertRaises(CommandError):
            call_command("dispatch_email_jobs", "--poll-interval=0")

    def test_auth_challenge_jobs_cancel_when_inactive_or_expired(self):
        inactive_challenge = EmailAuthChallenge.objects.create(
            member=self.event.organizer,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="job-organizer@example.com",
            code_hash="unused",
            expires_at=timezone.now() + timedelta(minutes=10),
        )
        inactive_job, _created = enqueue_email_job(
            idempotency_key="inactive-auth-challenge",
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            recipient=inactive_challenge.target_email,
            subject="Verification code",
            body="Code",
            message_id="<inactive-auth-challenge@releviz.local>",
            member=self.event.organizer,
            auth_challenge=inactive_challenge,
        )
        inactive_challenge.status = EmailAuthChallenge.Status.CONSUMED
        inactive_challenge.save(update_fields=["status", "updated_at"])
        canceled = dispatch_email_job(inactive_job.pk)
        self.assertEqual(canceled, {"attempted": False, "status": "canceled"})
        inactive_job.refresh_from_db()
        self.assertIn("no longer active", inactive_job.last_error)
        self.assertEqual(email_delivery_summary([inactive_job])["canceled"], 1)

        expired_challenge = EmailAuthChallenge.objects.create(
            member=self.event.organizer,
            purpose=EmailAuthChallenge.Purpose.LOGIN,
            target_email="job-organizer@example.com",
            code_hash="unused",
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        expired_job, _created = enqueue_email_job(
            idempotency_key="expired-auth-challenge",
            message_type=EmailMessageLog.MessageType.VERIFICATION,
            recipient=expired_challenge.target_email,
            subject="Verification code",
            body="Code",
            message_id="<expired-auth-challenge@releviz.local>",
            member=self.event.organizer,
            auth_challenge=expired_challenge,
        )
        summary = dispatch_due_email_jobs(limit=10)
        self.assertEqual(summary["canceled"], 1)
        expired_challenge.refresh_from_db()
        expired_job.refresh_from_db()
        self.assertEqual(expired_challenge.status, EmailAuthChallenge.Status.EXPIRED)
        self.assertEqual(expired_job.status, EmailDeliveryJob.Status.CANCELED)

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
