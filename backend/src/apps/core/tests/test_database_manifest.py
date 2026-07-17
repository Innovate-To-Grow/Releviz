import hashlib
import json
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import SimpleTestCase

from apps.core.management.commands.database_manifest import build_database_manifest


class FakeCursor:
    def __init__(self, rows_by_table):
        self.rows_by_table = rows_by_table
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query):
        table = next(name for name in self.rows_by_table if f'"{name}"' in query)
        self.rows = list(self.rows_by_table[table])

    def fetchmany(self, size):
        rows, self.rows = self.rows[:size], self.rows[size:]
        return rows


class FakeConnection:
    vendor = "postgresql"

    def __init__(self, rows_by_table):
        self.rows_by_table = rows_by_table
        self.introspection = SimpleNamespace(table_names=lambda: list(rows_by_table))
        self.ops = SimpleNamespace(quote_name=lambda name: f'"{name}"')

    def cursor(self):
        return FakeCursor(self.rows_by_table)


class DatabaseManifestTests(SimpleTestCase):
    def test_manifest_is_deterministic_and_contains_only_counts_and_hashes(self):
        connection = FakeConnection(
            {
                "beta": [],
                "alpha": [('{"id":1,"secret":"not-output"}',), ('{"id":2}',)],
            }
        )
        manifest = build_database_manifest(connection)
        self.assertEqual(manifest["databaseVendor"], "postgresql")
        self.assertEqual(manifest["tableCount"], 2)
        self.assertEqual([entry["name"] for entry in manifest["tables"]], ["alpha", "beta"])
        self.assertEqual(manifest["tables"][0]["rows"], 2)
        self.assertEqual(manifest["tables"][1]["sha256"], hashlib.sha256().hexdigest())
        self.assertNotIn("not-output", json.dumps(manifest))
        self.assertEqual(len(manifest["overallSha256"]), 64)

        empty = build_database_manifest(FakeConnection({}))
        self.assertEqual(empty["tableCount"], 0)
        self.assertEqual(empty["tables"], [])

    def test_manifest_rejects_non_postgresql_databases(self):
        with self.assertRaisesMessage(CommandError, "requires PostgreSQL"):
            build_database_manifest(SimpleNamespace(vendor="sqlite"))

    @patch(
        "apps.core.management.commands.database_manifest.build_database_manifest",
        return_value={"schemaVersion": 1, "tables": []},
    )
    def test_command_emits_sorted_json(self, manifest_mock):
        output = StringIO()
        call_command("database_manifest", stdout=output)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"schemaVersion": 1, "tables": []},
        )
        manifest_mock.assert_called_once_with()
