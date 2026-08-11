"""Logout view — blacklists the supplied refresh token."""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

logger = logging.getLogger(__name__)


class LogoutView(APIView):
    """Blacklist the caller's refresh token so it can no longer be used.

    Accepts `AllowAny` so an already-expired access token doesn't block logout.
    """

    permission_classes = [AllowAny]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        refresh = request.data.get("refresh", "")
        if not isinstance(refresh, str) or not refresh.strip():
            return Response({"detail": "Refresh token is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            RefreshToken(refresh).blacklist()
        except TokenError:
            return Response({"detail": "Invalid or already-blacklisted token."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(status=status.HTTP_204_NO_CONTENT)
