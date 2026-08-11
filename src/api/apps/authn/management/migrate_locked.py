"""Run Django migrations while holding a PostgreSQL session advisory lock."""

import os
import time

from django.core.management.base import CommandError
from django.core.management.commands.migrate import Command as MigrateCommand
from django.db import connections

# Stable, repository-specific 56-bit key derived from ASCII "I2GMIGR".
# PostgreSQL advisory locks are cluster-local and released with the session.
MIGRATION_LOCK_ID = int.from_bytes(b"I2GMIGR", byteorder="big", signed=False)
DEFAULT_LOCK_TIMEOUT_SECONDS = 600
LOCK_POLL_SECONDS = 2


class Command(MigrateCommand):
    help = "Run migrate after acquiring the Innovate-To-Grow PostgreSQL advisory lock."

    def add_arguments(self, parser):
        super().add_arguments(parser)
        parser.add_argument(
            "--lock-timeout-seconds",
            type=int,
            default=int(os.environ.get("MIGRATION_LOCK_TIMEOUT_SECONDS", DEFAULT_LOCK_TIMEOUT_SECONDS)),
            help="Maximum time to wait for another migration task (default: 600 seconds).",
        )

    def handle(self, *args, **options):
        database = options["database"]
        lock_timeout = options.pop("lock_timeout_seconds")
        if lock_timeout < 0:
            raise CommandError("--lock-timeout-seconds must be non-negative.")

        connection = connections[database]
        if connection.vendor != "postgresql":
            raise CommandError(
                "migrate_locked requires PostgreSQL. Use Django's migrate command explicitly for non-production databases."
            )

        deadline = time.monotonic() + lock_timeout
        acquired = False
        while not acquired:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_LOCK_ID])
                acquired = bool(cursor.fetchone()[0])
            if acquired:
                break
            if time.monotonic() >= deadline:
                raise CommandError(f"Timed out waiting {lock_timeout}s for the database migration lock.")
            time.sleep(min(LOCK_POLL_SECONDS, max(0, deadline - time.monotonic())))

        self.stdout.write("Acquired database migration lock.")
        try:
            return super().handle(*args, **options)
        finally:
            # If the connection was lost, PostgreSQL already released the
            # session lock. Otherwise release it explicitly before the task exits.
            if connection.connection is not None:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_LOCK_ID])
                    released = bool(cursor.fetchone()[0])
                if not released:
                    self.stderr.write("Database migration lock was no longer held at release time.")
