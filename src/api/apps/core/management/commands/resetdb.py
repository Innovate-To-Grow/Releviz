"""
Reset the local database and regenerate migrations.

Usage (DEV ONLY):
    This will delete all data from the database and re-run migrations.
    It is intended for development environments only.
    It is not recommended for production use.
    python manage.py resetdb --force --confirm RESET_DB

Options:
    --force                 Acknowledge the destructive nature of this command.
    --confirm RESET_DB      Required confirmation string.
    --database ALIAS        Database alias to reset (default: "default").
    --keep-migrations       Keep existing migration files; only reset the database.
    --allow-production      Allow running even when DEBUG is False.
"""

import os

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from .resetdb_helpers import (
    create_default_admin,
    delete_migration_files,
    reset_mysql,
    reset_postgresql,
    reset_sqlite,
    seed_archive_data,
)


class Command(BaseCommand):
    help = "Resets database and migration files, then recreates everything (DEV ONLY)."
    DEV_ADD_ADMIN_USER = True
    DEV_DEFAULT_ADMIN_USERNAME = os.environ.get("DEV_ADMIN_USERNAME", "admin")
    DEV_DEFAULT_ADMIN_EMAIL = os.environ.get("DEV_ADMIN_EMAIL", "admin@localhost")
    DEV_DEFAULT_ADMIN_PASSWORD = os.environ.get("DEV_ADMIN_PASSWORD", "changeme")

    # noinspection PyMethodMayBeStatic
    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="Acknowledge the destructive nature of this command.")
        parser.add_argument("--confirm", type=str, help='Required confirmation string. Must be "RESET_DB".')
        parser.add_argument(
            "--database", default=DEFAULT_DB_ALIAS, help=f'The database to reset. Defaults to "{DEFAULT_DB_ALIAS}".'
        )
        parser.add_argument(
            "--keep-migrations", action="store_true", help="Keep existing migration files (only reset database)."
        )
        parser.add_argument("--allow-production", action="store_true", help="Allow running even if DEBUG is False.")

    # noinspection PyUnusedLocal
    def handle(self, *args, **options):
        db_alias = options["database"]
        force = options["force"]
        confirm = options["confirm"]
        allow_production = options["allow_production"]
        keep_migrations = options["keep_migrations"]
        if not settings.DEBUG and not allow_production:
            raise CommandError("Command restricted to DEBUG=True. Use --allow-production to override.")
        if not force or confirm != "RESET_DB":
            raise CommandError("Destructive command requires --force and --confirm RESET_DB.")
        if not settings.DEBUG and allow_production:
            self.stdout.write(self.style.WARNING("*** WARNING: RUNNING RESETDB IN PRODUCTION ENVIRONMENT ***"))

        connection = connections[db_alias]
        self.stdout.write(self.style.NOTICE("=" * 60))
        self.stdout.write(self.style.NOTICE("DATABASE RESET"))
        self.stdout.write(self.style.NOTICE("=" * 60))
        self.stdout.write(f"  Vendor: {connection.vendor}")
        self.stdout.write(f"  Database: {connection.settings_dict.get('NAME')}")
        self.stdout.write("")

        if not keep_migrations:
            delete_migration_files(self)
        self.stdout.write(self.style.NOTICE("Resetting database..."))
        try:
            if connection.vendor == "postgresql":
                reset_postgresql(connection)
            elif connection.vendor == "mysql":
                reset_mysql(connection)
            elif connection.vendor == "sqlite":
                reset_sqlite(self, connection)
            else:
                raise CommandError(f"Unsupported database vendor: {connection.vendor}")
        except Exception as exc:
            raise CommandError(f"Error during database reset: {exc}") from exc

        self.stdout.write(self.style.SUCCESS("Database cleared."))
        self.stdout.write(self.style.NOTICE("Creating migrations..."))
        call_command("makemigrations", interactive=False)
        self.stdout.write(self.style.SUCCESS("Migrations created."))
        self.stdout.write(self.style.NOTICE("Applying migrations..."))
        call_command("migrate", database=db_alias, interactive=False)
        self.stdout.write(self.style.SUCCESS("Migrations applied."))
        create_default_admin(self)
        self.stdout.write(self.style.NOTICE("Seeding service configs..."))
        call_command("seed_service_configs")
        self.stdout.write(self.style.NOTICE("Seeding archive data (CMS pages, menus, footer)..."))
        seed_archive_data(self)
        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write(self.style.SUCCESS("DATABASE RESET COMPLETE"))
        self.stdout.write(self.style.SUCCESS("=" * 60))
