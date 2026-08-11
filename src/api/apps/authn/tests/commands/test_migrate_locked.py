from unittest.mock import patch

from django.core.management.base import CommandError
from django.core.management.commands.migrate import Command as MigrateCommand
from django.test import SimpleTestCase

from apps.authn.management import migrate_locked


class _Cursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params):
        self.connection.calls.append((sql, params))
        self.connection.last_sql = sql

    def fetchone(self):
        if "pg_try_advisory_lock" in self.connection.last_sql:
            return (self.connection.acquire_results.pop(0),)
        return (self.connection.release_result,)


class _Connection:
    vendor = "postgresql"
    connection = object()

    def __init__(self, acquire_results=(True,), release_result=True):
        self.acquire_results = list(acquire_results)
        self.release_result = release_result
        self.calls = []
        self.last_sql = ""

    def cursor(self):
        return _Cursor(self)


class MigrateLockedCommandTests(SimpleTestCase):
    def test_acquires_lock_runs_migrate_and_releases(self):
        connection = _Connection()
        command = migrate_locked.Command()

        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            patch.object(MigrateCommand, "handle", return_value="migrated") as migrate,
        ):
            result = command.handle(database="default", lock_timeout_seconds=0)

        self.assertEqual(result, "migrated")
        migrate.assert_called_once_with(database="default")
        self.assertIn("pg_try_advisory_lock", connection.calls[0][0])
        self.assertIn("pg_advisory_unlock", connection.calls[-1][0])

    def test_releases_lock_when_migrate_fails(self):
        connection = _Connection()
        command = migrate_locked.Command()

        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            patch.object(MigrateCommand, "handle", side_effect=RuntimeError("migration failed")),
            self.assertRaisesRegex(RuntimeError, "migration failed"),
        ):
            command.handle(database="default", lock_timeout_seconds=0)

        self.assertIn("pg_advisory_unlock", connection.calls[-1][0])

    def test_times_out_without_running_migrations(self):
        connection = _Connection(acquire_results=(False,))
        command = migrate_locked.Command()

        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            patch.object(MigrateCommand, "handle") as migrate,
            self.assertRaisesMessage(CommandError, "Timed out waiting 0s"),
        ):
            command.handle(database="default", lock_timeout_seconds=0)

        migrate.assert_not_called()

    def test_rejects_non_postgresql_database(self):
        connection = _Connection()
        connection.vendor = "sqlite"
        command = migrate_locked.Command()

        with (
            patch.object(migrate_locked, "connections", {"default": connection}),
            self.assertRaisesMessage(CommandError, "requires PostgreSQL"),
        ):
            command.handle(database="default", lock_timeout_seconds=0)
