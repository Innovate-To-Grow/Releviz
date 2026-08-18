import sys
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, PropertyMock, patch

from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectionClosedError,
    EndpointConnectionError,
    ParamValidationError,
    ReadTimeoutError,
)
from django.db import IntegrityError, connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.core.models import BackgroundJob, DeliveryRateLimit
from apps.core.services.aws.provider_outcomes import (
    PROVIDER_OUTCOME_PERMANENT,
    PROVIDER_OUTCOME_TRANSIENT,
    PROVIDER_OUTCOME_UNCERTAIN,
    ProviderDeliveryError,
    classify_aws_send_failure,
)
from apps.core.services.background_jobs import (
    handlers,
    metrics,
    queue,
    rate_limit,
    recovery,
    registry,
)
from apps.core.services.background_jobs.queue import enqueue_job
from apps.core.services.background_jobs.worker import (
    JobClaimLost,
    PermanentJobError,
    TransientJobError,
    UncertainJobError,
    _exception_chain,
    _is_known_transient,
    claim_jobs,
    process_claimed_job,
)


class ProviderOutcomeTests(SimpleTestCase):
    def test_client_errors_are_classified_by_code_and_status(self):
        transient_code = ClientError(
            {
                "Error": {"Code": "ThrottlingException"},
                "ResponseMetadata": {"HTTPStatusCode": 400},
            },
            "SendEmail",
        )
        transient_status = ClientError(
            {
                "Error": {"Code": "Unknown"},
                "ResponseMetadata": {"HTTPStatusCode": 503},
            },
            "SendEmail",
        )
        permanent = ClientError(
            {
                "Error": {"Code": "MessageRejected"},
                "ResponseMetadata": {"HTTPStatusCode": 400},
            },
            "SendEmail",
        )

        self.assertEqual(
            classify_aws_send_failure(transient_code, provider="SES")[0],
            PROVIDER_OUTCOME_TRANSIENT,
        )
        self.assertEqual(
            classify_aws_send_failure(transient_status, provider="SES")[0],
            PROVIDER_OUTCOME_TRANSIENT,
        )
        self.assertEqual(
            classify_aws_send_failure(permanent, provider="SES")[0],
            PROVIDER_OUTCOME_PERMANENT,
        )

    def test_transport_validation_and_unknown_errors_are_classified(self):
        cases = (
            (
                EndpointConnectionError(endpoint_url="https://ses.example"),
                PROVIDER_OUTCOME_TRANSIENT,
            ),
            (ParamValidationError(report="invalid"), PROVIDER_OUTCOME_PERMANENT),
            (ReadTimeoutError(endpoint_url="https://ses.example"), PROVIDER_OUTCOME_UNCERTAIN),
            (ConnectionClosedError(endpoint_url="https://ses.example"), PROVIDER_OUTCOME_UNCERTAIN),
            (BotoCoreError(), PROVIDER_OUTCOME_UNCERTAIN),
            (RuntimeError("unknown"), PROVIDER_OUTCOME_UNCERTAIN),
        )

        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                outcome, message = classify_aws_send_failure(error, provider="SES")
                self.assertEqual(outcome, expected)
                self.assertIn("SES", message)


class BackgroundJobHandlerTests(SimpleTestCase):
    def test_provider_errors_map_to_worker_error_types(self):
        cases = (
            (PROVIDER_OUTCOME_TRANSIENT, TransientJobError),
            (PROVIDER_OUTCOME_PERMANENT, PermanentJobError),
            (PROVIDER_OUTCOME_UNCERTAIN, UncertainJobError),
        )
        for outcome, expected_type in cases:
            with self.subTest(outcome=outcome):
                error = ProviderDeliveryError("sanitized", outcome=outcome)
                mapped = handlers._provider_job_error(error)
                self.assertIsInstance(mapped, expected_type)
                self.assertEqual(str(mapped), "sanitized")

    @patch("apps.authn.services.email.send_email.send_notification_email")
    def test_notification_handler_marks_provider_call_and_accepts_success(self, send):
        job = SimpleNamespace(payload={"recipient": "owner@example.com"})
        job.begin_provider_call = Mock(return_value=True)

        def invoke_callback(**kwargs):
            kwargs["before_provider_call"]()
            return True

        send.side_effect = invoke_callback
        handlers.send_notification_email_job(job)
        job.begin_provider_call.assert_called_once_with()

    @patch("apps.authn.services.email.send_email.send_notification_email")
    def test_notification_handler_rejects_lost_claim(self, send):
        job = SimpleNamespace(payload={}, begin_provider_call=Mock(return_value=False))
        send.side_effect = lambda **kwargs: kwargs["before_provider_call"]()

        with self.assertRaises(JobClaimLost):
            handlers.send_notification_email_job(job)

    @patch("apps.authn.services.email.send_email.send_notification_email", return_value=False)
    def test_notification_handler_requires_confirmed_delivery(self, _send):
        job = SimpleNamespace(payload={}, begin_provider_call=Mock(return_value=True))
        with self.assertRaisesMessage(RuntimeError, "did not confirm"):
            handlers.send_notification_email_job(job)

    @patch("apps.authn.services.email.send_email.send_notification_email")
    def test_notification_handler_converts_provider_errors(self, send):
        job = SimpleNamespace(payload={}, begin_provider_call=Mock(return_value=True))
        for outcome, expected_type in (
            (PROVIDER_OUTCOME_TRANSIENT, TransientJobError),
            (PROVIDER_OUTCOME_PERMANENT, PermanentJobError),
            (PROVIDER_OUTCOME_UNCERTAIN, UncertainJobError),
        ):
            with self.subTest(outcome=outcome):
                send.side_effect = ProviderDeliveryError("sanitized", outcome=outcome)
                with self.assertRaises(expected_type):
                    handlers.send_notification_email_job(job)


class BackgroundJobServiceEdgeTests(TestCase):
    @override_settings(BACKGROUND_JOBS_ENABLED=False)
    def test_jobs_enabled_reflects_setting(self):
        self.assertFalse(queue.jobs_enabled())
        with override_settings(BACKGROUND_JOBS_ENABLED=True):
            self.assertTrue(queue.jobs_enabled())

    def test_enqueue_validates_identity_and_payload(self):
        for kwargs in (
            {"kind": "", "dedupe_key": "key", "payload": {}},
            {"kind": "kind", "dedupe_key": "", "payload": {}},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                enqueue_job(**kwargs)
        with self.assertRaises(TypeError):
            enqueue_job(kind="kind", dedupe_key="key", payload=[])

    def test_explicit_notification_dedupe_key_and_nonterminal_retry(self):
        job, _ = queue.enqueue_notification_email(
            recipient="owner@example.com",
            subject="Notice",
            template="notice.html",
            context={},
            dedupe_key="explicit",
        )
        self.assertEqual(job.dedupe_key, "explicit")
        self.assertFalse(queue.retry_job(job))

    def test_begin_provider_call_is_single_use_and_string_representations_are_stable(self):
        job, _ = enqueue_job(kind="test.delivery", dedupe_key="single-use", payload={})
        job = claim_jobs()[0]
        self.assertTrue(job.begin_provider_call())
        self.assertFalse(job.begin_provider_call())
        self.assertEqual(str(job), "test.delivery:single-use [processing]")

        limiter = DeliveryRateLimit.objects.create(provider="ses")
        self.assertEqual(str(limiter), f"ses: {limiter.next_available_at.isoformat()}")

    def test_claim_uses_select_for_update_when_database_supports_it(self):
        job = SimpleNamespace(
            status=BackgroundJob.Status.PENDING,
            claim_token=None,
            claimed_at=None,
            provider_call_started_at=None,
            attempts=0,
            last_error="old",
            new_claim_token=Mock(return_value="claim-token"),
            save=Mock(),
        )
        queryset = MagicMock()
        queryset.order_by.return_value = queryset
        queryset.select_for_update.return_value = queryset
        queryset.__getitem__.return_value = [job]
        feature_type = type(connection.features)
        with (
            patch.object(BackgroundJob.objects, "filter", return_value=queryset),
            patch.object(
                feature_type, "has_select_for_update", new_callable=PropertyMock
            ) as has_lock,
            patch.object(
                feature_type,
                "has_select_for_update_skip_locked",
                new_callable=PropertyMock,
            ) as skip_locked,
        ):
            has_lock.return_value = True
            skip_locked.return_value = False
            self.assertEqual(len(claim_jobs()), 1)
        queryset.select_for_update.assert_called_once_with(skip_locked=False)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_transient_failure_exhausts_max_attempts(self, get_handler):
        get_handler.return_value = lambda _job: (_ for _ in ()).throw(
            TransientJobError("still unavailable")
        )
        job, _ = enqueue_job(kind="test", dedupe_key="exhausted", payload={}, max_attempts=1)

        self.assertFalse(process_claimed_job(claim_jobs()[0]))
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)

    @patch("apps.core.services.background_jobs.worker.get_handler", return_value=lambda _job: None)
    def test_completion_lost_claim_does_not_overwrite_new_state(self, _handler):
        job, _ = enqueue_job(kind="test", dedupe_key="lost-success", payload={})
        claimed = claim_jobs()[0]
        BackgroundJob.objects.filter(pk=job.pk).update(status=BackgroundJob.Status.FAILED)

        self.assertTrue(process_claimed_job(claimed))
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.FAILED)

    @patch("apps.core.services.background_jobs.worker.get_handler")
    def test_failure_lost_claim_does_not_overwrite_new_state(self, get_handler):
        get_handler.return_value = lambda _job: (_ for _ in ()).throw(RuntimeError("boom"))
        job, _ = enqueue_job(kind="test", dedupe_key="lost-failure", payload={})
        claimed = claim_jobs()[0]
        BackgroundJob.objects.filter(pk=job.pk).update(status=BackgroundJob.Status.SUCCEEDED)

        self.assertFalse(process_claimed_job(claimed))
        job.refresh_from_db()
        self.assertEqual(job.status, BackgroundJob.Status.SUCCEEDED)

    def test_exception_chain_stops_at_cycles_and_provider_shape_is_defensive(self):
        first = RuntimeError("first")
        second = RuntimeError("second")
        first.__cause__ = second
        second.__cause__ = first
        self.assertEqual(list(_exception_chain(first)), [first, second])

        class APIError(Exception):
            response = SimpleNamespace(status_code="503")

        self.assertFalse(_is_known_transient(APIError("bad status type")))
        self.assertFalse(_is_known_transient(RuntimeError("permanent")))
        self.assertTrue(_is_known_transient(TimeoutError("temporary")))

    def test_recovery_targets_cover_every_resolved_state_and_fallback(self):
        base = SimpleNamespace(
            attempts=1,
            max_attempts=2,
            can_retry_after_claim=False,
            provider_call_started_at=timezone.now(),
        )
        expected = {
            BackgroundJob.Status.SUCCEEDED: BackgroundJob.Status.SUCCEEDED,
            BackgroundJob.Status.RETRY: BackgroundJob.Status.RETRY,
            BackgroundJob.Status.FAILED: BackgroundJob.Status.FAILED,
            BackgroundJob.Status.UNCERTAIN: BackgroundJob.Status.UNCERTAIN,
            None: BackgroundJob.Status.UNCERTAIN,
        }
        for resolved, expected_status in expected.items():
            with (
                self.subTest(resolved=resolved),
                patch.object(recovery, "resolve_stale_job_state", return_value=resolved),
            ):
                self.assertEqual(recovery._recovery_target(base)[0], expected_status)

        retryable = SimpleNamespace(
            attempts=2,
            max_attempts=2,
            can_retry_after_claim=True,
            provider_call_started_at=None,
        )
        with patch.object(recovery, "resolve_stale_job_state", return_value=None):
            self.assertEqual(recovery._recovery_target(retryable)[0], BackgroundJob.Status.FAILED)

    def test_recovery_handles_empty_and_disappeared_jobs(self):
        self.assertEqual(
            recovery.recover_stale_jobs(stale_after=timedelta(minutes=1)),
            {"completed": 0, "retried": 0, "failed": 0, "uncertain": 0},
        )
        self.assertIsNone(recovery._recover_stale_job(job_id=999999, cutoff=timezone.now()))

    @patch.object(
        recovery,
        "_recover_stale_job",
        side_effect=[None, BackgroundJob.Status.RETRY],
    )
    @patch.object(recovery.BackgroundJob.objects, "filter")
    def test_recovery_counts_multiple_stale_jobs(self, filter_jobs, recover_job):
        filter_jobs.return_value.values_list.return_value = [1, 2]

        counts = recovery.recover_stale_jobs(stale_after=timedelta(minutes=1))

        self.assertEqual(counts["retried"], 1)
        self.assertEqual(recover_job.call_count, 2)

    def test_registry_unknown_and_optional_handlers(self):
        with self.assertRaises(LookupError):
            registry.get_handler("unknown.kind")
        self.assertIs(
            registry.get_handler("authn.notification_email"), handlers.send_notification_email_job
        )

        job = SimpleNamespace(kind="test.optional")
        state_handler = Mock()
        stale_resolver = Mock(return_value=BackgroundJob.Status.SUCCEEDED)
        registry._STATE_HANDLER_LOADERS[job.kind] = lambda: state_handler
        registry._STALE_RESOLVER_LOADERS[job.kind] = lambda: stale_resolver
        try:
            registry.notify_job_state(job)
            self.assertEqual(registry.resolve_stale_job_state(job), BackgroundJob.Status.SUCCEEDED)
        finally:
            registry._STATE_HANDLER_LOADERS.pop(job.kind)
            registry._STALE_RESOLVER_LOADERS.pop(job.kind)
        state_handler.assert_called_once_with(job)
        stale_resolver.assert_called_once_with(job)

    def test_rate_configuration_and_reservations_cover_boundaries(self):
        for config in (
            object(),
            SimpleNamespace(ses_max_send_rate="bad"),
            SimpleNamespace(ses_max_send_rate=float("inf")),
            SimpleNamespace(ses_max_send_rate=-1),
        ):
            self.assertEqual(rate_limit.configured_ses_rate(config), 0.0)
        self.assertEqual(
            rate_limit.configured_ses_rate(SimpleNamespace(ses_max_send_rate="2.5")), 2.5
        )
        self.assertEqual(rate_limit.reserve_delivery_slot("ses", 0), 0.0)

    @patch("apps.core.services.background_jobs.rate_limit.DeliveryRateLimit.objects")
    def test_rate_limit_recovers_from_concurrent_row_creation(self, objects):
        now = timezone.now()
        limiter = SimpleNamespace(next_available_at=now, save=Mock())
        queryset = Mock()
        queryset.get.side_effect = [DeliveryRateLimit.DoesNotExist, limiter]
        objects.select_for_update.return_value = queryset
        objects.create.side_effect = IntegrityError("concurrent insert")

        self.assertEqual(rate_limit.reserve_delivery_slot("ses", 2, now=now), 0.0)
        limiter.save.assert_called_once()

    @patch("apps.core.services.background_jobs.rate_limit.reserve_delivery_slot", return_value=0)
    @patch("apps.core.services.background_jobs.rate_limit.time.sleep")
    def test_wait_for_delivery_slot_skips_zero_delay(self, sleep, _reserve):
        self.assertEqual(rate_limit.wait_for_delivery_slot("ses", 1), 0)
        sleep.assert_not_called()

    @patch("apps.core.services.background_jobs.rate_limit.reserve_delivery_slot", return_value=0.25)
    @patch("apps.core.services.background_jobs.rate_limit.time.sleep")
    def test_wait_for_delivery_slot_sleeps_for_positive_delay(self, sleep, _reserve):
        self.assertEqual(rate_limit.wait_for_delivery_slot("ses", 1), 0.25)
        sleep.assert_called_once_with(0.25)


class BackgroundJobMetricsTests(SimpleTestCase):
    @override_settings(BACKGROUND_JOB_METRICS_NAMESPACE="")
    def test_publish_metrics_is_disabled_without_namespace(self):
        metrics.publish_worker_metrics({})

    @override_settings(
        BACKGROUND_JOB_METRICS_NAMESPACE="Releviz/Worker",
        AWS_S3_REGION_NAME="us-east-1",
    )
    def test_publish_metrics_emits_all_values(self):
        client = Mock()
        boto3 = SimpleNamespace(client=Mock(return_value=client))
        values = {
            "heartbeat": 1,
            "queue_depth": 2,
            "oldest_job_age_seconds": 3,
            "failed_jobs": 4,
            "uncertain_jobs": 5,
            "uncertain_email_jobs": 6,
        }
        with patch.dict(sys.modules, {"boto3": boto3}):
            metrics.publish_worker_metrics(values)

        boto3.client.assert_called_once_with("cloudwatch", region_name="us-east-1")
        payload = client.put_metric_data.call_args.kwargs
        self.assertEqual(payload["Namespace"], "Releviz/Worker")
        self.assertEqual(len(payload["MetricData"]), 6)

    @override_settings(BACKGROUND_JOB_METRICS_NAMESPACE="Releviz/Worker")
    @patch("apps.core.services.background_jobs.metrics.logger.exception")
    def test_publish_metrics_contains_provider_failures(self, log_exception):
        boto3 = SimpleNamespace(client=Mock(side_effect=RuntimeError("unavailable")))
        with patch.dict(sys.modules, {"boto3": boto3}):
            metrics.publish_worker_metrics({})
        log_exception.assert_called_once()
