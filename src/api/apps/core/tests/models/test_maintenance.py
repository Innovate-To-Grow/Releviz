"""Tests for the SiteMaintenanceControl singleton model."""

from django.contrib.auth.hashers import identify_hasher
from django.test import TestCase

from apps.core.models import SiteMaintenanceControl


class SiteMaintenanceControlModelTest(TestCase):
    def test_load_creates_singleton(self):
        config = SiteMaintenanceControl.load()
        self.assertEqual(config.pk, 1)
        self.assertFalse(config.is_maintenance)

    def test_load_returns_existing(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, message="Down")
        config = SiteMaintenanceControl.load()

        self.assertTrue(config.is_maintenance)
        self.assertEqual(config.message, "Down")

    def test_save_enforces_pk_one(self):
        obj = SiteMaintenanceControl(pk=42, is_maintenance=True)
        obj.save()

        self.assertEqual(obj.pk, 1)
        self.assertEqual(SiteMaintenanceControl.objects.count(), 1)

    def test_str_on(self):
        config = SiteMaintenanceControl(is_maintenance=True)
        self.assertEqual(str(config), "Maintenance Mode: ON")

    def test_str_off(self):
        config = SiteMaintenanceControl(is_maintenance=False)
        self.assertEqual(str(config), "Maintenance Mode: OFF")

    def test_save_hashes_bypass_password(self):
        config = SiteMaintenanceControl(is_maintenance=True, bypass_password="secret123")
        config.save()

        self.assertNotEqual(config.bypass_password, "secret123")
        identify_hasher(config.bypass_password)
        self.assertTrue(config.check_bypass_password("secret123"))

    def test_check_bypass_password_supports_legacy_plaintext_values(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, bypass_password="secret123")
        SiteMaintenanceControl.objects.filter(pk=1).update(bypass_password="legacy-secret")

        config = SiteMaintenanceControl.load()
        self.assertTrue(config.check_bypass_password("legacy-secret"))

    def test_check_hashed_password_uses_django_hasher(self):
        """A stored hash routes through check_password (not constant-time compare)."""
        from django.contrib.auth.hashers import make_password

        from apps.core.models.base.web import _looks_like_password_hash

        config = SiteMaintenanceControl(is_maintenance=True)
        config.bypass_password = make_password("hashed-secret")
        # Saving again must NOT re-hash an already-hashed value.
        config.save()
        self.assertTrue(_looks_like_password_hash(config.bypass_password))
        self.assertTrue(config.check_bypass_password("hashed-secret"))
        self.assertFalse(config.check_bypass_password("wrong"))

    def test_check_bypass_password_empty_returns_false(self):
        config = SiteMaintenanceControl(is_maintenance=True, bypass_password="")
        self.assertFalse(config.check_bypass_password("anything"))

    def test_looks_like_password_hash_false_for_empty(self):
        from apps.core.models.base.web import _looks_like_password_hash

        self.assertFalse(_looks_like_password_hash(""))
