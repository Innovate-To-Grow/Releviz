"""Tests for resetdb_helpers — exercised without mutating the real DB/filesystem."""

import os
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.core.management.commands import resetdb_helpers as helpers


class FakeStyle:
    """Mimics the Django management style object — returns text unchanged."""

    def NOTICE(self, text):
        return text

    def SUCCESS(self, text):
        return text

    def WARNING(self, text):
        return text


class FakeStdout:
    def __init__(self):
        self.lines = []

    def write(self, text):
        self.lines.append(text)

    @property
    def text(self):
        return "\n".join(self.lines)


class FakeCommand:
    """Stand-in for a management Command used by the helper functions."""

    def __init__(self):
        self.stdout = FakeStdout()
        self.style = FakeStyle()
        self.DEV_ADD_ADMIN_USER = True
        self.DEV_DEFAULT_ADMIN_EMAIL = "dev-admin@example.com"
        self.DEV_DEFAULT_ADMIN_PASSWORD = "supersecret"


def _cursor_mock():
    """Build a connection mock whose cursor works as a context manager."""
    cursor = MagicMock()
    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value = cursor
    connection.cursor.return_value.__exit__.return_value = False
    return connection, cursor


class DeleteMigrationFilesTest(TestCase):
    def test_deletes_py_files_and_removes_pycache(self):
        cmd = FakeCommand()
        app_config = MagicMock()
        app_config.path = "/fake/app"
        app_config.label = "fakeapp"

        with (
            patch.object(helpers.apps, "get_app_configs", return_value=[app_config]),
            patch.object(helpers.settings, "BASE_DIR", "/fake"),
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=True
            ),
            patch(
                "apps.core.management.commands.resetdb_helpers.os.listdir",
                return_value=["0001_initial.py", "__init__.py", "__pycache__", "notes.txt"],
            ),
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.isfile", return_value=True
            ),
            patch("apps.core.management.commands.resetdb_helpers.os.remove") as remove,
            patch(
                "apps.core.management.commands.resetdb_helpers._remove_pycache"
            ) as remove_pycache,
        ):
            helpers.delete_migration_files(cmd)

        # Only the real .py migration file (not __init__.py / notes.txt) is removed.
        remove.assert_called_once_with(os.path.join("/fake/app", "migrations", "0001_initial.py"))
        remove_pycache.assert_called_once()
        self.assertIn("Deleted 1 migration file(s).", cmd.stdout.text)

    def test_skips_apps_outside_base_dir(self):
        cmd = FakeCommand()
        outside = MagicMock()
        outside.path = "/somewhere/else"

        with (
            patch.object(helpers.apps, "get_app_configs", return_value=[outside]),
            patch.object(helpers.settings, "BASE_DIR", "/fake"),
            patch("apps.core.management.commands.resetdb_helpers.os.remove") as remove,
        ):
            helpers.delete_migration_files(cmd)

        remove.assert_not_called()
        self.assertIn("Deleted 0 migration file(s).", cmd.stdout.text)

    def test_skips_apps_without_migrations_dir(self):
        cmd = FakeCommand()
        app_config = MagicMock()
        app_config.path = "/fake/app"

        with (
            patch.object(helpers.apps, "get_app_configs", return_value=[app_config]),
            patch.object(helpers.settings, "BASE_DIR", "/fake"),
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=False
            ),
            patch("apps.core.management.commands.resetdb_helpers.os.remove") as remove,
        ):
            helpers.delete_migration_files(cmd)

        remove.assert_not_called()
        self.assertIn("Deleted 0 migration file(s).", cmd.stdout.text)


class ResetVendorTest(TestCase):
    def test_reset_postgresql_runs_schema_sql_and_grants_user(self):
        connection, cursor = _cursor_mock()
        connection.settings_dict = {"USER": "appuser"}

        fake_sql = MagicMock()
        fake_sql.SQL.return_value.format.return_value = "GRANT SQL"
        with patch.dict("sys.modules", {"psycopg": MagicMock(sql=fake_sql)}):
            helpers.reset_postgresql(connection)

        executed = [c.args[0] for c in cursor.execute.call_args_list]
        self.assertIn("DROP SCHEMA public CASCADE;", executed)
        self.assertIn("CREATE SCHEMA public;", executed)
        self.assertIn("GRANT ALL ON SCHEMA public TO public;", executed)
        self.assertIn("GRANT SQL", executed)

    def test_reset_postgresql_without_user_skips_grant(self):
        connection, cursor = _cursor_mock()
        connection.settings_dict = {"USER": ""}

        helpers.reset_postgresql(connection)

        executed = [c.args[0] for c in cursor.execute.call_args_list]
        self.assertEqual(len(executed), 3)  # no per-user grant

    def test_reset_mysql_drops_each_table(self):
        connection, cursor = _cursor_mock()
        connection.ops.quote_name.side_effect = lambda name: f"`{name.replace('`', '``')}`"
        cursor.fetchall.return_value = [("members",), ("events",)]

        helpers.reset_mysql(connection)

        executed = [c.args[0] for c in cursor.execute.call_args_list]
        self.assertIn("SET FOREIGN_KEY_CHECKS = 0;", executed)
        self.assertIn("DROP TABLE IF EXISTS `members` CASCADE;", executed)
        self.assertIn("DROP TABLE IF EXISTS `events` CASCADE;", executed)
        self.assertIn("SET FOREIGN_KEY_CHECKS = 1;", executed)


class ResetSqliteTest(TestCase):
    def test_memory_database_drops_tables(self):
        cmd = FakeCommand()
        connection = MagicMock()
        connection.settings_dict = {"NAME": ":memory:"}

        with patch("apps.core.management.commands.resetdb_helpers.drop_sqlite_tables") as drop:
            helpers.reset_sqlite(cmd, connection)

        drop.assert_called_once_with(connection)
        self.assertIn("Memory database detected.", cmd.stdout.text)

    def test_existing_file_is_deleted(self):
        cmd = FakeCommand()
        connection = MagicMock()
        connection.settings_dict = {"NAME": "/tmp/dev.sqlite3"}

        with (
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=True
            ),
            patch("apps.core.management.commands.resetdb_helpers.os.remove") as remove,
        ):
            helpers.reset_sqlite(cmd, connection)

        connection.close.assert_called_once()
        remove.assert_called_once_with("/tmp/dev.sqlite3")
        self.assertIn("Deleted SQLite file: /tmp/dev.sqlite3", cmd.stdout.text)

    def test_delete_failure_falls_back_to_drop_tables(self):
        cmd = FakeCommand()
        connection = MagicMock()
        connection.settings_dict = {"NAME": "/tmp/dev.sqlite3"}

        with (
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=True
            ),
            patch(
                "apps.core.management.commands.resetdb_helpers.os.remove",
                side_effect=OSError("locked"),
            ),
            patch("apps.core.management.commands.resetdb_helpers.drop_sqlite_tables") as drop,
        ):
            helpers.reset_sqlite(cmd, connection)

        drop.assert_called_once_with(connection)
        self.assertIn("Could not delete SQLite file: locked", cmd.stdout.text)

    def test_missing_file_writes_message(self):
        cmd = FakeCommand()
        connection = MagicMock()
        connection.settings_dict = {"NAME": "/tmp/missing.sqlite3"}

        with patch(
            "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=False
        ):
            helpers.reset_sqlite(cmd, connection)

        self.assertIn("SQLite file not found at /tmp/missing.sqlite3", cmd.stdout.text)

    def test_drop_sqlite_tables_skips_sequence_table(self):
        connection, cursor = _cursor_mock()
        connection.ops.quote_name.side_effect = lambda name: (
            f'"{name.replace(chr(34), chr(34) * 2)}"'
        )
        cursor.fetchall.return_value = [("members",), ("sqlite_sequence",)]

        helpers.drop_sqlite_tables(connection)

        executed = [c.args[0] for c in cursor.execute.call_args_list]
        self.assertIn("PRAGMA foreign_keys = OFF;", executed)
        self.assertIn('DROP TABLE IF EXISTS "members";', executed)
        self.assertNotIn('DROP TABLE IF EXISTS "sqlite_sequence";', executed)
        self.assertIn("PRAGMA foreign_keys = ON;", executed)


class RemovePycacheTest(TestCase):
    def test_removes_existing_pycache(self):
        with (
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=True
            ),
            patch("apps.core.management.commands.resetdb_helpers.shutil.rmtree") as rmtree,
        ):
            helpers._remove_pycache("/fake/app/migrations")

        rmtree.assert_called_once_with(os.path.join("/fake/app/migrations", "__pycache__"))

    def test_noop_when_pycache_absent(self):
        with (
            patch(
                "apps.core.management.commands.resetdb_helpers.os.path.exists", return_value=False
            ),
            patch("apps.core.management.commands.resetdb_helpers.shutil.rmtree") as rmtree,
        ):
            helpers._remove_pycache("/fake/app/migrations")

        rmtree.assert_not_called()


class CreateDefaultAdminTest(TestCase):
    def test_creates_superuser_and_contact_email(self):
        from apps.authn.models import ContactEmail, Member

        cmd = FakeCommand()
        helpers.create_default_admin(cmd)

        member = Member.objects.get(first_name="Dev", last_name="Admin")
        self.assertTrue(member.is_superuser)
        contact = ContactEmail.objects.get(email_address__iexact="dev-admin@example.com")
        self.assertEqual(contact.member, member)
        self.assertTrue(contact.verified)
        self.assertIn("Created admin user:", cmd.stdout.text)

    def test_skips_when_flag_disabled(self):
        from apps.authn.models import Member

        cmd = FakeCommand()
        cmd.DEV_ADD_ADMIN_USER = False
        helpers.create_default_admin(cmd)

        self.assertFalse(Member.objects.filter(first_name="Dev").exists())
        self.assertIn("Skipping admin user creation", cmd.stdout.text)

    def test_skips_when_admin_email_exists(self):
        from apps.authn.models import ContactEmail, Member

        member = Member.objects.create(first_name="X", last_name="Y")
        ContactEmail.objects.create(
            member=member,
            email_address="dev-admin@example.com",
            email_type="primary",
            verified=True,
        )
        cmd = FakeCommand()
        helpers.create_default_admin(cmd)

        self.assertIn("already exists", cmd.stdout.text)
        # No new superuser was created.
        self.assertFalse(Member.objects.filter(first_name="Dev", last_name="Admin").exists())
