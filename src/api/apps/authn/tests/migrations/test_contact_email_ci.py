from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class ContactEmailCaseInsensitiveMigrationTests(TransactionTestCase):
    migrate_from = ("authn", "0004_authratelimitbucket")
    migrate_to = ("authn", "0005_contactemail_case_insensitive_unique")

    def setUp(self):
        super().setUp()
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        self.old_apps = self.executor.loader.project_state([self.migrate_from]).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_migration_trims_and_lowercases_existing_addresses(self):
        ContactEmail = self.old_apps.get_model("authn", "ContactEmail")
        contact = ContactEmail.objects.create(email_address="  Mixed.Case@Example.COM  ")

        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_to])
        migrated_apps = self.executor.loader.project_state([self.migrate_to]).apps
        migrated_contact = migrated_apps.get_model("authn", "ContactEmail").objects.get(
            pk=contact.pk
        )

        self.assertEqual(migrated_contact.email_address, "mixed.case@example.com")

    def test_migration_aborts_without_changing_case_only_duplicates(self):
        ContactEmail = self.old_apps.get_model("authn", "ContactEmail")
        first = ContactEmail.objects.create(email_address="Duplicate@Example.com")
        second = ContactEmail.objects.create(email_address="duplicate@example.com")

        self.executor = MigrationExecutor(connection)
        with self.assertRaisesMessage(
            RuntimeError,
            "Resolve duplicate addresses after trimming and lowercasing",
        ):
            self.executor.migrate([self.migrate_to])

        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.email_address, "Duplicate@Example.com")
        self.assertEqual(second.email_address, "duplicate@example.com")

        # Restore a migratable state for tearDown.
        second.delete()
