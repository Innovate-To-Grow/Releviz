from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class ActiveStatusMigrationTests(TransactionTestCase):
    migrate_from = ("scheduling", "0001_initial")
    migrate_to = ("scheduling", "0002_event_status_active")

    def setUp(self):
        super().setUp()
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        old_apps = self.executor.loader.project_state([self.migrate_from]).apps
        self.assertFalse(old_apps.get_model("scheduling", "Event").objects.exists())

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_empty_database_migrates_to_active_status_contract(self):
        migrated_apps = self.executor.loader.project_state([self.migrate_to]).apps
        Event = migrated_apps.get_model("scheduling", "Event")
        status_field = Event._meta.get_field("status")
        self.assertEqual(status_field.default, "active")
        self.assertEqual(
            {value for value, _label in status_field.choices},
            {"active", "closed", "finalized", "archived"},
        )
