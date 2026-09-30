"""Existing administrators converge without changing ordinary or inactive accounts."""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class UnifiedAdministratorMigrationTests(TransactionTestCase):
    migrate_from = ("authn", "0005_contactemail_case_insensitive_unique")
    migrate_to = ("authn", "0006_unify_administrator_role")

    def setUp(self):
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        self.old_apps = executor.loader.project_state([self.migrate_from]).apps
        self.addCleanup(self._restore_latest_schema)

    @staticmethod
    def _restore_latest_schema():
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_existing_roles_merge_and_preserve_account_state(self):
        OldMember = self.old_apps.get_model("authn", "Member")
        cases = []
        for is_staff, is_superuser in ((False, False), (True, False), (False, True), (True, True)):
            for is_active in (False, True):
                member = OldMember.objects.create(
                    is_staff=is_staff,
                    is_superuser=is_superuser,
                    is_active=is_active,
                    admin_apps=["scheduling"],
                    access_level="temporary" if not (is_staff or is_superuser) else "full",
                )
                cases.append((member, is_staff or is_superuser))

        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        Member = executor.loader.project_state([self.migrate_to]).apps.get_model("authn", "Member")
        for original, is_admin in cases:
            with self.subTest(is_staff=original.is_staff, is_superuser=original.is_superuser):
                migrated = Member.objects.get(pk=original.pk)
                self.assertEqual(migrated.is_staff, is_admin)
                self.assertEqual(migrated.is_superuser, is_admin)
                self.assertEqual(migrated.is_active, original.is_active)
                self.assertEqual(migrated.access_level, original.access_level)
                self.assertEqual(migrated.admin_apps, original.admin_apps)
        self.assertEqual(Member.objects.count(), len(cases))
