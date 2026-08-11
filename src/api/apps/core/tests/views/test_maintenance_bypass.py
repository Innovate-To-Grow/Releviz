"""Tests for the MaintenanceBypassView."""

from django.test import TestCase

from apps.core.models import SiteMaintenanceControl


class MaintenanceBypassViewTest(TestCase):
    URL = "/maintenance/bypass/"

    def test_missing_password_returns_400(self):
        response = self.client.post(self.URL, data={}, content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_not_in_maintenance_returns_400(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=False)
        response = self.client.post(self.URL, data={"password": "abc"}, content_type="application/json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("not active", response.json()["error"])

    def test_bypass_not_configured_returns_400(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, bypass_password="")
        response = self.client.post(self.URL, data={"password": "abc"}, content_type="application/json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("not configured", response.json()["error"])

    def test_wrong_password_returns_403(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, bypass_password="correct")
        response = self.client.post(self.URL, data={"password": "wrong"}, content_type="application/json")

        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.json()["success"])

    def test_correct_password_returns_200(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, bypass_password="secret123")
        response = self.client.post(self.URL, data={"password": "secret123"}, content_type="application/json")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])

    def test_legacy_plaintext_password_still_works(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=True, bypass_password="secret123")
        SiteMaintenanceControl.objects.filter(pk=1).update(bypass_password="legacy-secret")

        response = self.client.post(self.URL, data={"password": "legacy-secret"}, content_type="application/json")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
