from contextlib import nullcontext
from unittest.mock import Mock, call, patch

from django.core.management.base import CommandError
from django.test import SimpleTestCase

from apps.core.management.commands.migrate_safely import MIGRATION_LOCK_ID, Command


class FakeCursor:
    def __init__(self, result):
        self.result = result
        self.execute = Mock()

    def fetchone(self):
        return [self.result]


class FakeConnection:
    def __init__(self, vendor, lock_results=()):
        self.vendor = vendor
        self.lock_results = iter(lock_results)
        self.cursors = []
        self.close = Mock()

    def cursor(self):
        cursor = FakeCursor(next(self.lock_results))
        self.cursors.append(cursor)
        return nullcontext(cursor)


class MigrateSafelyTests(SimpleTestCase):
    def options(self, **overrides):
        return {
            "database": "default",
            "interactive": False,
            "verbosity": 1,
            "lock_timeout_seconds": 300.0,
            **overrides,
        }

    def test_cli_arguments(self):
        options = (
            Command()
            .create_parser("manage.py", "migrate_safely")
            .parse_args(
                [
                    "--noinput",
                    "--database",
                    "replica",
                    "--lock-timeout-seconds",
                    "12.5",
                ]
            )
        )

        self.assertFalse(options.interactive)
        self.assertEqual(options.database, "replica")
        self.assertEqual(options.lock_timeout_seconds, 12.5)

    @patch("apps.core.management.commands.migrate_safely.call_command")
    @patch("apps.core.management.commands.migrate_safely.connections")
    def test_non_postgres_runs_migrate_without_lock(self, connections, call_command):
        connection = FakeConnection("sqlite")
        connections.__getitem__.return_value = connection

        Command().handle(**self.options())

        call_command.assert_called_once_with(
            "migrate",
            database="default",
            interactive=False,
            verbosity=1,
        )
        connection.close.assert_not_called()

    @patch("apps.core.management.commands.migrate_safely.call_command")
    @patch("apps.core.management.commands.migrate_safely.connections")
    def test_postgres_acquires_lock_runs_migrate_and_closes_connection(
        self, connections, call_command
    ):
        connection = FakeConnection("postgresql", [True])
        connections.__getitem__.return_value = connection

        Command().handle(**self.options(database="replica", interactive=True, verbosity=2))

        connection.cursors[0].execute.assert_called_once_with(
            "SELECT pg_try_advisory_lock(%s)",
            [MIGRATION_LOCK_ID],
        )
        call_command.assert_called_once_with(
            "migrate",
            database="replica",
            interactive=True,
            verbosity=2,
        )
        connection.close.assert_called_once_with()

    @patch("apps.core.management.commands.migrate_safely.time.sleep")
    @patch(
        "apps.core.management.commands.migrate_safely.time.monotonic",
        side_effect=[10.0, 10.25],
    )
    @patch("apps.core.management.commands.migrate_safely.call_command")
    @patch("apps.core.management.commands.migrate_safely.connections")
    def test_postgres_waits_for_lock(self, connections, call_command, monotonic, sleep):
        connection = FakeConnection("postgresql", [False, True])
        connections.__getitem__.return_value = connection

        Command().handle(**self.options(lock_timeout_seconds=0.5))

        self.assertEqual(monotonic.call_count, 2)
        sleep.assert_called_once_with(0.25)
        call_command.assert_called_once()
        connection.close.assert_called_once_with()

    @patch("apps.core.management.commands.migrate_safely.time.sleep")
    @patch(
        "apps.core.management.commands.migrate_safely.time.monotonic",
        side_effect=[10.0, 10.5],
    )
    @patch("apps.core.management.commands.migrate_safely.call_command")
    @patch("apps.core.management.commands.migrate_safely.connections")
    def test_postgres_lock_timeout_closes_connection(
        self, connections, call_command, monotonic, sleep
    ):
        connection = FakeConnection("postgresql", [False])
        connections.__getitem__.return_value = connection

        with self.assertRaisesMessage(CommandError, "Timed out"):
            Command().handle(**self.options(lock_timeout_seconds=0.5))

        self.assertEqual(monotonic.mock_calls, [call(), call()])
        sleep.assert_not_called()
        call_command.assert_not_called()
        connection.close.assert_called_once_with()

    @patch("apps.core.management.commands.migrate_safely.connections")
    def test_rejects_nonpositive_timeout_before_opening_connection(self, connections):
        with self.assertRaisesMessage(CommandError, "greater than zero"):
            Command().handle(**self.options(lock_timeout_seconds=0))

        connections.__getitem__.assert_not_called()
