import time

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import DEFAULT_DB_ALIAS, connections

MIGRATION_LOCK_ID = 7_424_864_934_339_177_119


class Command(BaseCommand):
    help = "Apply migrations while holding a PostgreSQL advisory lock."

    def add_arguments(self, parser):
        parser.add_argument(
            "--noinput",
            action="store_false",
            dest="interactive",
            help="Do not prompt for input.",
        )
        parser.add_argument("--database", default=DEFAULT_DB_ALIAS)
        parser.add_argument("--lock-timeout-seconds", type=float, default=300.0)

    def handle(self, *args, **options):
        database = options["database"]
        interactive = options["interactive"]
        verbosity = options["verbosity"]
        timeout_seconds = options["lock_timeout_seconds"]
        if timeout_seconds <= 0:
            raise CommandError("--lock-timeout-seconds must be greater than zero.")

        connection = connections[database]
        if connection.vendor != "postgresql":
            self._migrate(database, interactive, verbosity)
            return

        try:
            self._acquire_postgres_lock(connection, timeout_seconds)
            self.stdout.write("Acquired PostgreSQL migration lock.")
            self._migrate(database, interactive, verbosity)
        finally:
            connection.close()

    def _migrate(self, database, interactive, verbosity):
        call_command(
            "migrate",
            database=database,
            interactive=interactive,
            verbosity=verbosity,
        )

    def _acquire_postgres_lock(self, connection, timeout_seconds):
        deadline = time.monotonic() + timeout_seconds
        while True:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_LOCK_ID])
                acquired = cursor.fetchone()[0]
            if acquired:
                return

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandError(
                    "Timed out waiting for the PostgreSQL migration lock. "
                    "Another deployment may still be migrating."
                )
            time.sleep(min(1.0, remaining))
