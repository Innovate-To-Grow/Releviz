import hashlib
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import connection


def build_database_manifest(db_connection=connection) -> dict:
    if db_connection.vendor != "postgresql":
        raise CommandError("database_manifest requires PostgreSQL.")
    tables = sorted(db_connection.introspection.table_names())
    table_entries = []
    overall_digest = hashlib.sha256()
    with db_connection.cursor() as cursor:
        for table in tables:
            quoted_table = db_connection.ops.quote_name(table)
            cursor.execute(
                f"SELECT row_to_json(source_row)::text AS row_json "
                f"FROM {quoted_table} AS source_row ORDER BY row_json"
            )
            table_digest = hashlib.sha256()
            row_count = 0
            while rows := cursor.fetchmany(1000):
                for (row_json,) in rows:
                    encoded = row_json.encode("utf-8")
                    table_digest.update(len(encoded).to_bytes(8, "big"))
                    table_digest.update(encoded)
                    row_count += 1
            entry = {
                "name": table,
                "rows": row_count,
                "sha256": table_digest.hexdigest(),
            }
            table_entries.append(entry)
            overall_digest.update(f"{entry['name']}\0{entry['rows']}\0{entry['sha256']}\n".encode())
    return {
        "schemaVersion": 1,
        "databaseVendor": db_connection.vendor,
        "tableCount": len(table_entries),
        "overallSha256": overall_digest.hexdigest(),
        "tables": table_entries,
    }


class Command(BaseCommand):
    help = "Emit a privacy-safe exact row manifest for a PostgreSQL database."

    def handle(self, *args, **options):
        self.stdout.write(json.dumps(build_database_manifest(), sort_keys=True))
