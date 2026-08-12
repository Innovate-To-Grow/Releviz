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
            return clear_refresh_cookie(
                Response(
                    {"detail": "Invalid or already-blacklisted token."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            )
        return clear_refresh_cookie(Response(status=status.HTTP_204_NO_CONTENT))
