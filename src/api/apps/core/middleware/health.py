import json
import logging

from django.http import HttpResponse

logger = logging.getLogger(__name__)


class HealthCheckMiddleware:
    """Health endpoints that bypass ALLOWED_HOSTS for ALB probes.

    `/livez/` checks only that the app process can respond. `/readyz/` and
    `/health/` check database readiness. `/health/` keeps the frontend-facing
    maintenance payload for backward compatibility.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/livez/":
            return self._json_response({"status": "ok"})
        if request.path in {"/readyz/", "/health/"}:
            return self._readiness_response()
        return self.get_response(request)

    def _readiness_response(self):
        # Import here to avoid circular imports.
        from django.db import DatabaseError, connection

        from apps.core.models import SiteMaintenanceControl

        health_status = {
            "status": "ok",
            "database": "ok",
            "maintenance": False,
            "maintenance_message": "",
        }

        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        except (DatabaseError, OSError) as e:
            logger.warning("Health check database probe failed: %s", e)
            health_status["status"] = "error"
            health_status["database"] = "unavailable"
            return self._json_response(health_status, status=503)

        try:
            config = SiteMaintenanceControl.load()
            if config.is_maintenance:
                health_status["status"] = "maintenance"
                health_status["maintenance"] = True
                health_status["maintenance_message"] = config.message
        except (DatabaseError, OSError):
            logger.exception("Failed to load SiteMaintenanceControl configuration during health check")

        return self._json_response(health_status)

    @staticmethod
    def _json_response(payload, *, status=200):
        return HttpResponse(json.dumps(payload), content_type="application/json", status=status)
