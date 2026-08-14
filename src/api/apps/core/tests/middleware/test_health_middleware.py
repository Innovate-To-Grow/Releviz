"""Tests for HealthCheckMiddleware responses and maintenance status."""

import json
from unittest.mock import patch

from django.db import DatabaseError
from django.test import TestCase

from apps.core.models import SiteMaintenanceControl


class HealthCheckMiddlewareTest(TestCase):
    HEALTH_URL = "/health/"
    LIVEZ_URL = "/livez/"
    READYZ_URL = "/readyz/"

    def test_returns_200_and_ok_status(self):
        response = self.client.get(self.HEALTH_URL)
        self.assertEqual(response.status_code, 200)

        data = json.loads(response.content)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["database"], "ok")
        self.assertFalse(data["maintenance"])

    def test_returns_json_content_type(self):
        response = self.client.get(self.HEALTH_URL)
        self.assertEqual(response["Content-Type"], "application/json")

    def test_maintenance_mode_returns_200_with_maintenance_status(self):
        SiteMaintenanceControl.objects.create(
            pk=1,
            is_maintenance=True,
            message="Scheduled downtime",
        )
        response = self.client.get(self.HEALTH_URL)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data["status"], "maintenance")
        self.assertTrue(data["maintenance"])
        self.assertEqual(data["maintenance_message"], "Scheduled downtime")

    def test_maintenance_off_returns_ok_status(self):
        SiteMaintenanceControl.objects.create(pk=1, is_maintenance=False)
        response = self.client.get(self.HEALTH_URL)

        data = json.loads(response.content)
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["maintenance"])

    def test_livez_does_not_require_database(self):
        with patch("django.db.connection.cursor", side_effect=DatabaseError("db down")):
            response = self.client.get(self.LIVEZ_URL)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data, {"status": "ok"})

    def test_readyz_returns_200_and_ok_status(self):
        response = self.client.get(self.READYZ_URL)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["database"], "ok")

    def test_readyz_returns_503_when_database_unavailable(self):
        with patch("django.db.connection.cursor", side_effect=DatabaseError("db down")):
            response = self.client.get(self.READYZ_URL)

        self.assertEqual(response.status_code, 503)
        data = json.loads(response.content)
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["database"], "unavailable")

    def test_health_returns_503_when_database_unavailable(self):
        with patch("django.db.connection.cursor", side_effect=DatabaseError("db down")):
            response = self.client.get(self.HEALTH_URL)

        self.assertEqual(response.status_code, 503)
        data = json.loads(response.content)
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["database"], "unavailable")

    def test_non_health_path_passes_through(self):
        response = self.client.get("/")
        self.assertNotEqual(response["Content-Type"], "application/json")

    def test_maintenance_load_failure_logs_but_returns_ok(self):
        """If the DB probe succeeds but loading maintenance config fails, return ok."""
        with (
            patch.object(
                SiteMaintenanceControl, "load", side_effect=DatabaseError("config table gone")
            ),
            patch("apps.core.middleware.health.logger.exception") as exc_log,
        ):
            response = self.client.get(self.HEALTH_URL)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        # DB probe passed -> status stays ok; maintenance flag unchanged.
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["maintenance"])
        exc_log.assert_called_once()
