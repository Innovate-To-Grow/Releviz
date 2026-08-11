"""The 0016 data migration repairs primary-email inconsistencies idempotently."""

import importlib

from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase

from apps.authn.models import ContactEmail

Member = get_user_model()

_migration = importlib.import_module("apps.authn.migrations.0016_backfill_primary_email")
forwards = _migration.forwards

PRIMARY_CONSTRAINT = "one_primary_email_per_member"


def _run_migration():
    forwards(global_apps, connection.schema_editor())


class BackfillPrimaryEmailMigrationTests(TestCase):
    # noinspection PyPep8Naming,PyAttributeOutsideInit
    def setUp(self):
        self.member = Member.objects.create_user(is_active=True, first_name="M", last_name="One")

    def test_member_without_primary_gets_one_promoted(self):
        # No primary; one verified email should be promoted (verified preferred).
        ContactEmail.objects.create(
            member=self.member, email_address="old-other@example.com", email_type="other", verified=False
        )
        verified = ContactEmail.objects.create(
            member=self.member, email_address="verified@example.com", email_type="secondary", verified=True
        )

        _run_migration()

        verified.refresh_from_db()
        self.assertEqual(verified.email_type, "primary")
        self.assertEqual(ContactEmail.objects.filter(member=self.member, email_type="primary").count(), 1)

    def test_member_without_primary_or_verified_uses_oldest(self):
        oldest = ContactEmail.objects.create(
            member=self.member, email_address="oldest@example.com", email_type="other", verified=False
        )
        ContactEmail.objects.create(
            member=self.member, email_address="newer@example.com", email_type="other", verified=False
        )

        _run_migration()

        oldest.refresh_from_db()
        self.assertEqual(oldest.email_type, "primary")

    def test_multiple_primaries_are_repaired_deterministically(self):
        # The partial unique constraint normally forbids two primaries. Django
        # implements a *conditional* UniqueConstraint as a partial unique index, so
        # drop the index to construct the legacy inconsistency the migration repairs.
        with connection.cursor() as cursor:
            cursor.execute(f"DROP INDEX IF EXISTS {PRIMARY_CONSTRAINT}")

        unverified_primary = ContactEmail.objects.create(
            member=self.member, email_address="p1@example.com", email_type="primary", verified=False
        )
        verified_primary = ContactEmail.objects.create(
            member=self.member, email_address="p2@example.com", email_type="primary", verified=True
        )

        _run_migration()

        verified_primary.refresh_from_db()
        unverified_primary.refresh_from_db()
        self.assertEqual(verified_primary.email_type, "primary")  # verified kept
        self.assertNotEqual(unverified_primary.email_type, "primary")  # other demoted
        self.assertEqual(ContactEmail.objects.filter(member=self.member, email_type="primary").count(), 1)

    def test_migration_is_idempotent(self):
        ContactEmail.objects.create(
            member=self.member, email_address="a@example.com", email_type="secondary", verified=True
        )
        _run_migration()
        _run_migration()  # second run must be a no-op
        self.assertEqual(ContactEmail.objects.filter(member=self.member, email_type="primary").count(), 1)
