from io import StringIO
from unittest.mock import MagicMock, call, patch

from django.core.exceptions import ValidationError
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings

from apps.core.management.commands import run_background_worker


class RunBackgroundWorkerEdgeTests(SimpleTestCase):
    def _options(self, **overrides):
        options = {
            "once": True,
            "batch_size": 1,
            "poll_seconds": 0,
            "stale_minutes": 0,
            "key_purge_seconds": 0,
        }
        options.update(overrides)
        return options

    def test_command_parser_registers_worker_options(self):
        command = run_background_worker.Command(stdout=StringIO())
        parser = command.create_parser("manage.py", "run_background_worker")

        options = vars(
            parser.parse_args(
                [
                    "--once",
                    "--batch-size",
                    "4",
                    "--poll-seconds",
                    "2",
                    "--stale-minutes",
                    "3",
                    "--key-purge-seconds",
                    "600",
                ]
            )
        )

        self.assertTrue(options["once"])
        self.assertEqual(options["batch_size"], 4)
        self.assertEqual(options["poll_seconds"], 2)
        self.assertEqual(options["stale_minutes"], 3)
        self.assertEqual(options["key_purge_seconds"], 600)

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(run_background_worker, "worker_metrics", return_value={})
    @patch.object(run_background_worker, "claim_jobs", return_value=[])
    @patch.object(run_background_worker, "recover_stale_jobs")
    @patch.object(
        run_background_worker,
        "purge_retired_auth_keypairs",
        side_effect=RuntimeError("key store unavailable"),
    )
    def test_key_purge_failure_is_contained(self, _purge, _recover, _claim, _metrics, _publish):
        command = run_background_worker.Command(stdout=StringIO())

        with self.assertLogs(run_background_worker.logger, level="ERROR") as logs:
            command.handle(**self._options())

        self.assertIn("Retired RSA key purge failed", logs.output[0])

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(run_background_worker, "worker_metrics", return_value={})
    @patch.object(
        run_background_worker,
        "claim_jobs",
        side_effect=RuntimeError("database unavailable"),
    )
    @patch.object(run_background_worker, "recover_stale_jobs")
    @patch.object(run_background_worker, "purge_retired_auth_keypairs", return_value=0)
    def test_claim_failure_is_contained(self, _purge, _recover, _claim, _metrics, _publish):
        command = run_background_worker.Command(stdout=StringIO())

        with self.assertLogs(run_background_worker.logger, level="ERROR") as logs:
            command.handle(**self._options())

        self.assertIn("maintenance/claim cycle failed", logs.output[0])

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(run_background_worker, "worker_metrics", return_value={})
    @patch.object(run_background_worker, "claim_jobs", return_value=[])
    @patch.object(run_background_worker, "recover_stale_jobs")
    @patch.object(run_background_worker, "purge_retired_auth_keypairs", return_value=0)
    def test_continuous_worker_polls_until_signal_and_skips_early_key_repurge(
        self,
        purge,
        _recover,
        _claim,
        _metrics,
        _publish,
    ):
        handlers = {}
        sleep_calls = 0

        def install_handler(signum, handler):
            handlers[signum] = handler

        def sleep_then_stop(_seconds):
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls == 2:
                handlers[run_background_worker.signal.SIGTERM](None, None)

        command = run_background_worker.Command(stdout=StringIO())
        with (
            patch.object(run_background_worker.signal, "signal", side_effect=install_handler),
            patch.object(run_background_worker.time, "monotonic", side_effect=[0, 1]),
            patch.object(run_background_worker.time, "sleep", side_effect=sleep_then_stop) as sleep,
        ):
            command.handle(**self._options(once=False))

        self.assertEqual(sleep.call_args_list, [call(0.25), call(0.25)])
        purge.assert_called_once_with()

    @patch.object(run_background_worker, "publish_worker_metrics")
    @patch.object(run_background_worker, "worker_metrics", return_value={})
    @patch.object(run_background_worker, "recover_stale_jobs")
    @patch.object(run_background_worker, "purge_retired_auth_keypairs", return_value=0)
    def test_continuous_worker_rechecks_stop_after_processing_a_job(
        self,
        _purge,
        _recover,
        _metrics,
        _publish,
    ):
        handlers = {}
        job = MagicMock(pk=1)

        def install_handler(signum, handler):
            handlers[signum] = handler

        def process_then_stop(_job):
            handlers[run_background_worker.signal.SIGTERM](None, None)

        command = run_background_worker.Command(stdout=StringIO())
        with (
            patch.object(run_background_worker.signal, "signal", side_effect=install_handler),
            patch.object(run_background_worker, "claim_jobs", return_value=[job]),
            patch.object(
                run_background_worker,
                "process_claimed_job",
                side_effect=process_then_stop,
            ),
            patch.object(run_background_worker.time, "sleep") as sleep,
        ):
            command.handle(**self._options(once=False))

        sleep.assert_not_called()


class SeedAdminE2EEdgeTests(TestCase):
    def test_all_identity_arguments_are_required(self):
        with self.assertRaisesMessage(CommandError, "are required"):
            call_command(
                "seed_admin_e2e",
                "--yes",
                email=" ",
                password="safe-test-password",
                nonstaff_email="nonstaff@example.com",
                action_email="action@example.com",
            )

    @patch(
        "apps.core.management.commands.seed_admin_e2e.validate_password",
        side_effect=[None, ValidationError("weak nonstaff password")],
    )
    def test_nonstaff_password_validation_failure_is_reported(self, _validate):
        with self.assertRaisesMessage(CommandError, "Refusing weak E2E nonstaff password"):
            call_command(
                "seed_admin_e2e",
                "--yes",
                email="admin@example.com",
                password="safe-test-password",
                nonstaff_email="nonstaff@example.com",
                action_email="action@example.com",
            )


class ResetDBEdgeTests(SimpleTestCase):
    @override_settings(DEBUG=True)
    def test_keep_migrations_skips_migration_file_deletion(self):
        connection = MagicMock(vendor="sqlite", settings_dict={"NAME": "test"})
        with (
            patch("apps.core.management.commands.resetdb.connections", {"default": connection}),
            patch("apps.core.management.commands.resetdb.delete_migration_files") as delete,
            patch("apps.core.management.commands.resetdb.reset_sqlite"),
            patch("apps.core.management.commands.resetdb.create_default_admin"),
            patch("apps.core.management.commands.resetdb.call_command"),
        ):
            call_command(
                "resetdb",
                "--force",
                "--confirm=RESET_DB",
                "--keep-migrations",
                stdout=StringIO(),
            )

        delete.assert_not_called()
