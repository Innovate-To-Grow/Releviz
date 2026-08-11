import json
import threading
from datetime import timedelta
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.db import OperationalError, close_old_connections, connection
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from gspread.exceptions import APIError as GspreadAPIError
from requests import Response

from apps.core.models import BackgroundJob, DeliveryRateLimit
from apps.core.services.aws.provider_outcomes import (
    PROVIDER_OUTCOME_TRANSIENT,
    ProviderDeliveryError,
)
from apps.core.services.background_jobs import (
    PermanentJobError,
    TransientJobError,
    claim_jobs,
    enqueue_job,
    enqueue_notification_email,
    process_claimed_job,
    recover_stale_jobs,
    reserve_delivery_slot,
    retry_job,
    worker_metrics,
)


def _gspread_api_error(status_code: int) -> GspreadAPIError:
    response = Response()
    response.status_code = status_code
    response._content = json.dumps(  # noqa: SLF001 - build the response gspread expects.
        {
            "error": {
                "code": status_code,
                "message": "Google Sheets request failed",
                "status": "UNAVAILABLE",
            }
        }
    ).encode()
    return GspreadAPIError(response)


class BackgroundJobQueueTests(TestCase):
    def test_enqueue_is_idempotent_by_kind_and_dedupe_key(self):
        first, created = enqueue_job(
            kind="test.echo",
            dedupe_key="same",
            payload={"value": 1},
        )
        second, created_again = enqueue_job(
            kind="test.echo",
            dedupe_key="same",
            payload={"value": 2},
        )

        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(second.payload, {"value": 1})

    def test_identical_notification_events_are_distinct_jobs(self):
        notification = {
            "recipient": "owner@example.com",
            "subject": "Security notice",
            "template": "notice.html",
            "context": {"account_url": "https://example.com/account"},
        }

        first, _created = enqueue_notification_email(**notification)
        second, _created = enqueue_notification_email(**notification)

        self.assertNotEqual(first.pk, second.pk)
        self.assertNotEqual(first.dedupe_key, second.dedupe_key)

    def test_claim_sets_token_attempt_and_processing_state(self):
        job, _created = enqueue_job(kind="test.echo", dedupe_key="claim", payload={})

        claimed = claim_jobs(batch_size=5)

        self.assertEqual([item.pk for item in claimed], [job.pk])
        claimed_job = claimed[0]
        self.assertEqual(claimed_job.status, BackgroundJob.Status.PROCESSING)
        self.assertEqual(claimed_job.attempts, 1)
        self.assertIsNotNone(claimed_job.claim_token)
        self.assertIsNotNone(claimed_job.claimed_at)
        self.assertEqual(claim_jobs(batch_size=5), [])

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_successful_job_completes(self, get_handler):
        get_handler.return_value = lambda _job: None
        job, _created = enqueue_job(kind="test.echo", dedupe_key="success", payload={})
        claimed = claim_jobs()[0]

        self.assertTrue(process_claimed_job(claimed))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.SUCCEEDED)
        self.assertIsNotNone(job.completed_at)
        self.assertIsNone(job.claim_token)

    @patch(
        "apps.core.services.background_jobs.worker.notify_job_state",
        side_effect=RuntimeError("mirror unavailable"),
    )
    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_state_mirror_failure_does_not_escape_job_boundary(self, get_handler, _notify):
        get_handler.return_value = lambda _job: None
        job, _created = enqueue_job(kind="test.echo", dedupe_key="mirror", payload={})

        self.assertTrue(process_claimed_job(claim_jobs()[0]))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.SUCCEEDED)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_known_transient_failure_uses_exponential_retry(self, get_handler):
        def fail(_job):
            raise TransientJobError("temporary")

        get_handler.return_value = fail
        job, _created = enqueue_job(kind="test.echo", dedupe_key="retry", payload={})
        claimed = claim_jobs()[0]

        self.assertFalse(process_claimed_job(claimed))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.RETRY)
        self.assertGreater(job.available_at, timezone.now())
        self.assertEqual(job.last_error, "temporary")

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_transient_gspread_http_statuses_retry(self, get_handler):
        for status_code in (408, 429, 500, 503, 599):
            with self.subTest(status_code=status_code):
                get_handler.return_value = lambda _job, status=status_code: (_ for _ in ()).throw(
                    _gspread_api_error(status)
                )
                job, _created = enqueue_job(
                    kind="test.sheet",
                    dedupe_key=f"gspread-{status_code}",
                    payload={},
                )

                self.assertFalse(process_claimed_job(claim_jobs(batch_size=1)[0]))

                job.refresh_from_db()
                self.assertEqual(job.status, BackgroundJob.Status.RETRY)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_permanent_gspread_http_status_fails(self, get_handler):
        get_handler.return_value = lambda _job: (_ for _ in ()).throw(_gspread_api_error(400))
        job, _created = enqueue_job(
            kind="test.sheet",
            dedupe_key="gspread-400",
            payload={},
        )

        self.assertFalse(process_claimed_job(claim_jobs()[0]))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)

    @patch(
        "apps.core.services.background_jobs.worker.notify_job_state",
        side_effect=RuntimeError("mirror unavailable"),
    )
    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_failed_state_mirror_does_not_escape_job_boundary(self, get_handler, _notify):
        get_handler.return_value = lambda _job: (_ for _ in ()).throw(TransientJobError("temporary"))
        job, _created = enqueue_job(kind="test.echo", dedupe_key="failed-mirror", payload={})

        self.assertFalse(process_claimed_job(claim_jobs()[0]))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.RETRY)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_provider_failure_is_uncertain_and_not_automatically_retried(self, get_handler):
        def fail(job):
            job.begin_provider_call()
            raise TimeoutError("provider timeout")

        get_handler.return_value = fail
        job, _created = enqueue_job(
            kind="test.delivery",
            dedupe_key="uncertain",
            payload={},
            can_retry_after_claim=False,
        )
        claimed = claim_jobs()[0]

        self.assertFalse(process_claimed_job(claimed))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.UNCERTAIN)
        self.assertIsNotNone(job.completed_at)
        self.assertTrue(retry_job(job))
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.RETRY)

    @patch(
        "apps.core.services.background_jobs.registry.notify_job_state",
        side_effect=OperationalError("domain mirror unavailable"),
    )
    def test_manual_retry_rolls_back_if_domain_mirror_fails(self, _notify):
        job, _created = enqueue_job(
            kind="test.delivery",
            dedupe_key="atomic-manual-retry",
            payload={},
        )
        completed_at = timezone.now()
        BackgroundJob.objects.filter(pk=job.pk).update(
            status=BackgroundJob.Status.UNCERTAIN,
            completed_at=completed_at,
            last_error="Review delivery",
        )
        job.refresh_from_db()

        with self.assertRaisesMessage(OperationalError, "domain mirror unavailable"):
            retry_job(job)

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.UNCERTAIN)
        self.assertEqual(job.completed_at, completed_at)
        self.assertEqual(job.last_error, "Review delivery")
        self.assertEqual(claim_jobs(), [])

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_definitive_transient_provider_rejection_retries_after_call_started(self, get_handler):
        def fail(job):
            job.begin_provider_call()
            raise TransientJobError("provider throttled")

        get_handler.return_value = fail
        job, _created = enqueue_job(
            kind="test.delivery",
            dedupe_key="definitive-transient",
            payload={},
            can_retry_after_claim=False,
        )

        self.assertFalse(process_claimed_job(claim_jobs()[0]))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.RETRY)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_definitive_permanent_provider_rejection_fails_not_uncertain(self, get_handler):
        def fail(job):
            job.begin_provider_call()
            raise PermanentJobError("access denied")

        get_handler.return_value = fail
        job, _created = enqueue_job(
            kind="test.delivery",
            dedupe_key="definitive-permanent",
            payload={},
            can_retry_after_claim=False,
        )

        self.assertFalse(process_claimed_job(claim_jobs()[0]))

        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)

    def test_stale_recovery_retries_safe_jobs_and_quarantines_deliveries(self):
        stale_at = timezone.now() - timedelta(hours=1)
        safe, _created = enqueue_job(
            kind="test.safe",
            dedupe_key="safe",
            payload={},
            can_retry_after_claim=True,
        )
        delivery, _created = enqueue_job(
            kind="test.delivery",
            dedupe_key="delivery",
            payload={},
            can_retry_after_claim=False,
        )
        BackgroundJob.objects.filter(pk=safe.pk).update(
            status=BackgroundJob.Status.PROCESSING,
            claimed_at=stale_at,
            claim_token=BackgroundJob.new_claim_token(),
        )
        BackgroundJob.objects.filter(pk=delivery.pk).update(
            status=BackgroundJob.Status.PROCESSING,
            claimed_at=stale_at,
            claim_token=BackgroundJob.new_claim_token(),
            provider_call_started_at=stale_at,
        )

        result = recover_stale_jobs(stale_after=timedelta(minutes=10))

        self.assertEqual(result, {"completed": 0, "retried": 1, "failed": 0, "uncertain": 1})
        safe.refresh_from_db()
        delivery.refresh_from_db()
        self.assertEqual(safe.status, BackgroundJob.Status.RETRY)
        self.assertEqual(delivery.status, BackgroundJob.Status.UNCERTAIN)

    def test_stale_recovery_fails_job_at_max_attempts(self):
        stale_at = timezone.now() - timedelta(hours=1)
        job, _created = enqueue_job(
            kind="test.safe",
            dedupe_key="exhausted-stale-job",
            payload={},
            max_attempts=1,
        )
        claimed = claim_jobs()[0]
        BackgroundJob.objects.filter(pk=claimed.pk).update(claimed_at=stale_at)

        result = recover_stale_jobs(stale_after=timedelta(minutes=10))

        job.refresh_from_db()
        self.assertEqual(result, {"completed": 0, "retried": 0, "failed": 1, "uncertain": 0})
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)
        self.assertIsNotNone(job.completed_at)
        self.assertIn("Maximum attempts", job.last_error)
        self.assertEqual(claim_jobs(), [])

    def test_recovery_mirror_failure_rolls_back_one_job_without_blocking_next(self):
        stale_at = timezone.now() - timedelta(hours=1)
        broken, _created = enqueue_job(
            kind="test.safe",
            dedupe_key="broken-recovery-mirror",
            payload={},
        )
        healthy, _created = enqueue_job(
            kind="test.safe",
            dedupe_key="healthy-recovery-mirror",
            payload={},
        )
        BackgroundJob.objects.filter(pk__in=[broken.pk, healthy.pk]).update(
            status=BackgroundJob.Status.PROCESSING,
            claimed_at=stale_at,
            claim_token=BackgroundJob.new_claim_token(),
        )

        def mirror(job):
            if job.pk == broken.pk:
                raise OperationalError("mirror database unavailable")

        with patch(
            "apps.core.services.background_jobs.recovery.notify_job_state",
            side_effect=mirror,
        ):
            result = recover_stale_jobs(stale_after=timedelta(minutes=10))

        broken.refresh_from_db()
        healthy.refresh_from_db()
        self.assertEqual(result, {"completed": 0, "retried": 1, "failed": 0, "uncertain": 0})
        self.assertEqual(broken.status, BackgroundJob.Status.PROCESSING)
        self.assertIsNotNone(broken.claim_token)
        self.assertEqual(healthy.status, BackgroundJob.Status.RETRY)
        self.assertIsNone(healthy.claim_token)

    def test_metrics_report_queue_and_terminal_counts(self):
        enqueue_job(kind="test.echo", dedupe_key="pending", payload={})
        failed, _created = enqueue_job(kind="test.echo", dedupe_key="failed", payload={})
        uncertain, _created = enqueue_job(kind="test.echo", dedupe_key="uncertain-metric", payload={})
        BackgroundJob.objects.filter(pk=failed.pk).update(status=BackgroundJob.Status.FAILED)
        BackgroundJob.objects.filter(pk=uncertain.pk).update(status=BackgroundJob.Status.UNCERTAIN)

        metrics = worker_metrics()

        self.assertEqual(metrics["heartbeat"], 1)
        self.assertEqual(metrics["queue_depth"], 1)
        self.assertEqual(metrics["failed_jobs"], 1)
        self.assertEqual(metrics["uncertain_jobs"], 1)

    def test_delivery_rate_slots_enforce_configured_global_throughput(self):
        now = timezone.now()

        first_delay = reserve_delivery_slot("ses-test", 10, now=now)
        second_delay = reserve_delivery_slot("ses-test", 10, now=now)
        third_delay = reserve_delivery_slot(
            "ses-test",
            10,
            now=now + timedelta(milliseconds=50),
        )

        self.assertEqual(first_delay, 0)
        self.assertAlmostEqual(second_delay, 0.1, places=3)
        self.assertAlmostEqual(third_delay, 0.15, places=3)

    def test_delivery_rate_uses_clock_after_database_lock_is_acquired(self):
        stale_time = timezone.now()
        current_time = stale_time + timedelta(seconds=1)
        DeliveryRateLimit.objects.create(
            provider="ses-stale-clock",
            next_available_at=stale_time + timedelta(milliseconds=100),
        )

        with patch(
            "apps.core.services.background_jobs.rate_limit.timezone.now",
            side_effect=[stale_time, current_time, current_time],
        ):
            delay = reserve_delivery_slot("ses-stale-clock", 10)

        limiter = DeliveryRateLimit.objects.get(provider="ses-stale-clock")
        self.assertEqual(delay, 0)
        self.assertEqual(
            limiter.next_available_at,
            current_time + timedelta(milliseconds=100),
        )

    @patch("apps.core.services.background_jobs.handlers._wait_for_ses_slot")
    @patch(
        "apps.authn.services.email.send_email.send_notification_email",
        side_effect=ProviderDeliveryError(
            "SES temporarily rejected the request.",
            outcome=PROVIDER_OUTCOME_TRANSIENT,
        ),
    )
    def test_notification_handler_preserves_definitive_transient_outcome(
        self,
        send_notification,
        wait_for_slot,
    ):
        from apps.core.services.background_jobs.handlers import send_notification_email_job

        job = SimpleNamespace(
            payload={
                "recipient": "owner@example.com",
                "subject": "Security notice",
                "template": "notice.html",
                "context": {},
            },
            begin_provider_call=lambda: True,
        )

        with self.assertRaises(TransientJobError):
            send_notification_email_job(job)

        wait_for_slot.assert_called_once_with()
        self.assertTrue(send_notification.call_args.kwargs["raise_provider_errors"])


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row locking required")
class DeliveryRateLimitConcurrencyTests(TransactionTestCase):
    def test_workers_reserve_distinct_global_slots(self):
        reservation_time = timezone.now()
        barrier = threading.Barrier(2)
        delays = []
        errors = []

        def reserve():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                delays.append(
                    reserve_delivery_slot(
                        "ses-concurrent",
                        10,
                        now=reservation_time,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - surfaced in the test thread.
                errors.append(exc)
            finally:
                close_old_connections()

        threads = [threading.Thread(target=reserve) for _index in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(delays), 2)
        self.assertAlmostEqual(min(delays), 0, places=3)
        self.assertAlmostEqual(max(delays), 0.1, places=3)
