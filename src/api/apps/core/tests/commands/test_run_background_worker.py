import signal
from io import StringIO
from types import SimpleNamespace
from unittest.mock import call, patch

from django.test import SimpleTestCase, TestCase

from apps.core.management.commands import run_background_worker
from apps.core.models import BackgroundJob
from apps.core.services.background_jobs import enqueue_job


class RunBackgroundWorkerCommandTests(SimpleTestCase):
    def _run_once(self, *, purged_row_count=0, batch_size=10):
        command = run_background_worker.Command(stdout=StringIO())
        with patch.object(
            run_background_worker,
            "purge_retired_auth_keypairs",
            return_value=purged_row_count,
        ) as purge:
            command.handle(
                once=True,
                batch_size=batch_size,
                poll_seconds=0.25,
                stale_minutes=10,
                key_purge_seconds=3600,
            )
        return purge

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(run_background_worker, "worker_metrics", return_value={"heartbeat": 1})
    @patch.object(run_background_worker, "claim_jobs", return_value=[])
    @patch.object(run_background_worker, "recover_stale_jobs")
    def test_worker_runs_retired_key_purge_maintenance(
        self,
        _recover,
        _claim,
        _metrics,
        _publish,
    ):
        with self.assertLogs(run_background_worker.logger, level="INFO") as logs:
            purge = self._run_once(purged_row_count=2)

        purge.assert_called_once_with()
        self.assertEqual(
            logs.output,
            [
                "INFO:apps.core.management.commands.run_background_worker:Purged retired RSA keypair rows"
            ],
        )

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(
        run_background_worker,
        "worker_metrics",
        side_effect=RuntimeError("metrics unavailable"),
    )
    @patch.object(run_background_worker, "claim_jobs", return_value=[])
    @patch.object(run_background_worker, "recover_stale_jobs")
    def test_metrics_failure_does_not_terminate_once_cycle(
        self,
        _recover,
        _claim,
        _metrics,
        publish,
    ):
        self._run_once()

        publish.assert_not_called()

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(
        run_background_worker,
        "worker_metrics",
        return_value={"heartbeat": 1},
    )
    @patch.object(run_background_worker, "process_claimed_job")
    @patch.object(
        run_background_worker,
        "claim_jobs",
        side_effect=[
            [SimpleNamespace(pk=1)],
            [SimpleNamespace(pk=2)],
        ],
    )
    @patch.object(run_background_worker, "recover_stale_jobs")
    def test_job_boundary_failure_does_not_skip_remaining_batch(
        self,
        _recover,
        _claim,
        process,
        _metrics,
        _publish,
    ):
        process.side_effect = [RuntimeError("mirror unavailable"), True]

        self._run_once(batch_size=2)

        self.assertEqual(
            process.call_args_list,
            [call(SimpleNamespace(pk=1)), call(SimpleNamespace(pk=2))],
        )
        self.assertEqual(_claim.call_args_list, [call(batch_size=1), call(batch_size=1)])

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(
        run_background_worker,
        "worker_metrics",
        return_value={"heartbeat": 1},
    )
    @patch.object(run_background_worker, "process_claimed_job")
    @patch.object(
        run_background_worker,
        "claim_jobs",
        side_effect=[[SimpleNamespace(pk=1)], []],
    )
    @patch.object(run_background_worker, "recover_stale_jobs")
    def test_empty_single_job_claim_stops_the_current_batch(
        self,
        _recover,
        claim,
        process,
        _metrics,
        _publish,
    ):
        self._run_once(batch_size=5)

        process.assert_called_once_with(SimpleNamespace(pk=1))
        self.assertEqual(claim.call_args_list, [call(batch_size=1), call(batch_size=1)])

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(
        run_background_worker,
        "worker_metrics",
        return_value={"heartbeat": 1},
    )
    @patch.object(run_background_worker, "claim_jobs")
    @patch.object(
        run_background_worker,
        "recover_stale_jobs",
        side_effect=RuntimeError("database temporarily unavailable"),
    )
    def test_maintenance_failure_does_not_terminate_cycle(
        self,
        _recover,
        claim,
        _metrics,
        publish,
    ):
        self._run_once()

        claim.assert_not_called()
        publish.assert_called_once_with({"heartbeat": 1})


class RunBackgroundWorkerShutdownTests(TestCase):
    def test_sigterm_does_not_claim_unstarted_jobs_or_consume_attempts(self):
        first, _created = enqueue_job(kind="test.echo", dedupe_key="shutdown-first", payload={})
        second, _created = enqueue_job(kind="test.echo", dedupe_key="shutdown-second", payload={})
        installed_handlers = {}

        def install_handler(signum, handler):
            installed_handlers[signum] = handler

        def stop_after_current_job(_job):
            installed_handlers[signal.SIGTERM](signal.SIGTERM, None)

        command = run_background_worker.Command(stdout=StringIO())
        with (
            patch.object(run_background_worker.signal, "signal", side_effect=install_handler),
            patch.object(run_background_worker, "purge_retired_auth_keypairs", return_value=0),
            patch.object(run_background_worker, "recover_stale_jobs"),
            patch.object(run_background_worker, "worker_metrics", return_value={"heartbeat": 1}),
            patch.object(run_background_worker, "publish_worker_metrics"),
            patch(
                "apps.core.services.background_jobs.worker.get_handler",
                return_value=stop_after_current_job,
            ),
        ):
            command.handle(
                once=True,
                batch_size=2,
                poll_seconds=0.25,
                stale_minutes=10,
                key_purge_seconds=3600,
            )

        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.status, BackgroundJob.Status.SUCCEEDED)
        self.assertEqual(first.attempts, 1)
        self.assertEqual(second.status, BackgroundJob.Status.PENDING)
        self.assertEqual(second.attempts, 0)
