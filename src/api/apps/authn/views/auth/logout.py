"""Logout view — blacklists the supplied refresh token."""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.security import enforce_cookie_request_origin

from ..helpers import clear_refresh_cookie, get_refresh_token_from_request

logger = logging.getLogger(__name__)


class LogoutView(APIView):
    """Blacklist the caller's refresh token so it can no longer be used.

    Accepts `AllowAny` so an already-expired access token doesn't block logout.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        enforce_cookie_request_origin(request)
        refresh = get_refresh_token_from_request(request)
        if not refresh:
            return clear_refresh_cookie(Response(status=status.HTTP_204_NO_CONTENT))
        try:
            RefreshToken(refresh).blacklist()
        except TokenError:
            # Logout is an idempotent local-session teardown. An expired,
            # malformed, or already-revoked refresh token has no remaining
            # authority, so clear the browser credential without exposing a
            # token-validity oracle or trapping the client in a signed-in UI.
            logger.info("logout_refresh_already_invalid")
        return clear_refresh_cookie(Response(status=status.HTTP_204_NO_CONTENT))
