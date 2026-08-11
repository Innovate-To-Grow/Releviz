import importlib
from datetime import timedelta

from django.apps import apps
from django.test import TestCase
from django.utils import timezone

from apps.core.models import AWSCredentialConfig

normalize_active_configs = importlib.import_module(
    "apps.core.migrations.0028_active_config_invariants"
).normalize_active_configs


class ActiveConfigMigrationTest(TestCase):
    def test_promotes_the_legacy_latest_fallback_when_none_is_active(self):
        older = AWSCredentialConfig.objects.create(name="Older", is_active=False)
        newer = AWSCredentialConfig.objects.create(name="Newer", is_active=False)
        now = timezone.now()
        AWSCredentialConfig.objects.filter(pk=older.pk).update(updated_at=now - timedelta(days=1))
        AWSCredentialConfig.objects.filter(pk=newer.pk).update(updated_at=now)

        normalize_active_configs(apps, None)

        older.refresh_from_db()
        newer.refresh_from_db()
        self.assertFalse(older.is_active)
        self.assertTrue(newer.is_active)
