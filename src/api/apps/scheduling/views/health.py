"""Liveness and readiness probes for the load balancer and container platform."""

import logging

from django.db import DatabaseError, connection
from django.utils.cache import patch_cache_control
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

logger = logging.getLogger(__name__)


@api_view(["GET"])
@permission_classes([AllowAny])
def health_live(request):
    response = Response({"ok": True})
    patch_cache_control(response, no_store=True)
    return response


@api_view(["GET"])
@permission_classes([AllowAny])
def health_ready(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError:
        logger.warning("readiness_check_failed", exc_info=True)
        response = Response(
            {"ok": False, "checks": {"database": "unavailable"}},
            status=503,
        )
    else:
        response = Response({"ok": True, "checks": {"database": "ok"}})
    patch_cache_control(response, no_store=True)
    return response
