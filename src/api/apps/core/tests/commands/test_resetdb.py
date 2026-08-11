from io import StringIO

from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings


class ResetDBCommandTest(TestCase):
    @override_settings(DEBUG=True)
    def test_missing_flags(self):
        """Test that the command fails without --force and --confirm."""
        out = StringIO()
        with self.assertRaises(CommandError) as cm:
            call_command("resetdb", stdout=out)
        self.assertIn(
            "Destructive command requires --force and --confirm RESET_DB",
            str(cm.exception),
        )

    @override_settings(DEBUG=True)
    def test_wrong_confirm_string(self):
        """Test that the command fails with wrong confirmation string."""
        out = StringIO()
        with self.assertRaises(CommandError) as cm:
            call_command("resetdb", "--force", "--confirm=WRONG", stdout=out)
        self.assertIn(
            "Destructive command requires --force and --confirm RESET_DB",
            str(cm.exception),
        )

    @override_settings(DEBUG=False)
    def test_refuse_in_production(self):
        """Test that the command refuses to run when DEBUG=False."""
        out = StringIO()
        with self.assertRaises(CommandError) as cm:
            call_command("resetdb", "--force", "--confirm=RESET_DB", stdout=out)
        self.assertIn(
            "Command restricted to DEBUG=True. Use --allow-production to override.",
            str(cm.exception),
        )

    @override_settings(DEBUG=False)
    def test_allow_production_flag_bypasses_debug_guard(self):
        """--allow-production must bypass the DEBUG=False guard.

        The destructive helpers (reset_* / delete_migration_files / call_command)
        are patched out so the test stays in dev without mutating the schema.
        """
        from unittest.mock import patch

        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.reset_postgresql"),
            patch("apps.core.management.commands.resetdb.reset_mysql"),
            patch("apps.core.management.commands.resetdb.reset_sqlite"),
            patch("apps.core.management.commands.resetdb.create_default_admin"),
            patch("apps.core.management.commands.resetdb.seed_archive_data"),
            patch("apps.core.management.commands.resetdb.call_command"),
        ):
            out = StringIO()
            # This must not raise CommandError("Command restricted to DEBUG=True").
            call_command(
                "resetdb",
                "--force",
                "--confirm=RESET_DB",
                "--allow-production",
                stdout=out,
            )

    @override_settings(DEBUG=True)
    def test_postgresql_vendor_branch(self):
        """A postgresql connection routes to reset_postgresql."""
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        conn.vendor = "postgresql"
        conn.settings_dict = {"NAME": "devdb"}
        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.connections", {"default": conn}),
            patch("apps.core.management.commands.resetdb.reset_postgresql") as pg,
            patch("apps.core.management.commands.resetdb.reset_mysql") as mysql,
            patch("apps.core.management.commands.resetdb.reset_sqlite") as sqlite,
            patch("apps.core.management.commands.resetdb.create_default_admin"),
            patch("apps.core.management.commands.resetdb.seed_archive_data"),
            patch("apps.core.management.commands.resetdb.call_command"),
        ):
            call_command("resetdb", "--force", "--confirm=RESET_DB", stdout=StringIO())
        pg.assert_called_once_with(conn)
        mysql.assert_not_called()
        sqlite.assert_not_called()

    @override_settings(DEBUG=True)
    def test_mysql_vendor_branch(self):
        """A mysql connection routes to reset_mysql."""
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        conn.vendor = "mysql"
        conn.settings_dict = {"NAME": "devdb"}
        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.connections", {"default": conn}),
            patch("apps.core.management.commands.resetdb.reset_mysql") as mysql,
            patch("apps.core.management.commands.resetdb.create_default_admin"),
            patch("apps.core.management.commands.resetdb.seed_archive_data"),
            patch("apps.core.management.commands.resetdb.call_command"),
        ):
            call_command("resetdb", "--force", "--confirm=RESET_DB", stdout=StringIO())
        mysql.assert_called_once_with(conn)

    @override_settings(DEBUG=True)
    def test_unsupported_vendor_raises(self):
        """An unknown vendor raises CommandError, wrapped by the except handler."""
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        conn.vendor = "oracle"
        conn.settings_dict = {"NAME": "devdb"}
        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.connections", {"default": conn}),
        ):
            with self.assertRaises(CommandError) as cm:
                call_command("resetdb", "--force", "--confirm=RESET_DB", stdout=StringIO())
        self.assertIn("Unsupported database vendor: oracle", str(cm.exception))

    @override_settings(DEBUG=True)
    def test_reset_error_is_wrapped(self):
        """An exception raised during reset is wrapped as CommandError."""
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        conn.vendor = "sqlite"
        conn.settings_dict = {"NAME": "devdb"}
        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.connections", {"default": conn}),
            patch(
                "apps.core.management.commands.resetdb.reset_sqlite",
                side_effect=RuntimeError("disk full"),
            ),
        ):
            with self.assertRaises(CommandError) as cm:
                call_command("resetdb", "--force", "--confirm=RESET_DB", stdout=StringIO())
        self.assertIn("Error during database reset: disk full", str(cm.exception))

    @override_settings(DEBUG=False)
    def test_production_warning_emitted(self):
        """Running with --allow-production under DEBUG=False emits the warning banner."""
        from unittest.mock import MagicMock, patch

        conn = MagicMock()
        conn.vendor = "sqlite"
        conn.settings_dict = {"NAME": "devdb"}
        out = StringIO()
        with (
            patch("apps.core.management.commands.resetdb.delete_migration_files"),
            patch("apps.core.management.commands.resetdb.connections", {"default": conn}),
            patch("apps.core.management.commands.resetdb.reset_sqlite"),
            patch("apps.core.management.commands.resetdb.create_default_admin"),
            patch("apps.core.management.commands.resetdb.seed_archive_data"),
            patch("apps.core.management.commands.resetdb.call_command"),
        ):
            call_command(
                "resetdb",
                "--force",
                "--confirm=RESET_DB",
                "--allow-production",
                stdout=out,
            )
        self.assertIn("RUNNING RESETDB IN PRODUCTION ENVIRONMENT", out.getvalue())
