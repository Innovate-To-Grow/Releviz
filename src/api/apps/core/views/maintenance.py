"""Maintenance-mode bypass endpoint."""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.models import SiteMaintenanceControl


class MaintenanceBypassView(APIView):
    """Verify a bypass password to skip maintenance mode."""

    permission_classes = [AllowAny]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        password = request.data.get("password", "")
        if not password:
            return Response({"success": False, "error": "Password is required."}, status=status.HTTP_400_BAD_REQUEST)

        config = SiteMaintenanceControl.load()

        if not config.is_maintenance:
            return Response(
                {"success": False, "error": "Maintenance mode is not active."}, status=status.HTTP_400_BAD_REQUEST
            )

        if not config.bypass_password:
            return Response(
                {"success": False, "error": "Bypass is not configured."}, status=status.HTTP_400_BAD_REQUEST
            )

        if config.check_bypass_password(password):
            return Response({"success": True})

        return Response({"success": False, "error": "Incorrect password."}, status=status.HTTP_403_FORBIDDEN)
