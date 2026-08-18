"""Cookie-backed public token refresh endpoint."""

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.views import TokenRefreshView

from apps.authn.security import AuthRateThrottle, enforce_cookie_request_origin
from apps.authn.services.security import bind_access_to_refresh

from ..helpers import (
    build_session_payload,
    clear_refresh_cookie,
    get_refresh_token_from_request,
    set_refresh_cookie,
)

Member = get_user_model()


class PublicTokenRefreshView(TokenRefreshView):
    """Refresh the browser session from an HttpOnly cookie.

    A JSON ``refresh`` value remains accepted for non-browser/legacy clients,
    but browser JavaScript never needs access to the long-lived credential.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "refresh"

    def post(self, request, *args, **kwargs):
        enforce_cookie_request_origin(request)
        refresh_token = get_refresh_token_from_request(request)
        if not refresh_token:
            response = Response(
                {"detail": "Refresh session is required."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
            return clear_refresh_cookie(response)

        serializer = self.get_serializer(data={"refresh": refresh_token})
        try:
            serializer.is_valid(raise_exception=True)
            rotated_refresh = serializer.validated_data.get("refresh", refresh_token)
            access = bind_access_to_refresh(
                serializer.validated_data["access"],
                rotated_refresh,
            )
            access_token = AccessToken(access)
            member_id = access_token.get(api_settings.USER_ID_CLAIM)
            member = Member.objects.filter(pk=member_id, is_active=True).first()
        except (AuthenticationFailed, TokenError, ObjectDoesNotExist, TypeError, ValueError):
            response = Response(
                {"detail": "Refresh session is invalid or has expired."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
            return clear_refresh_cookie(response)

        if member is None:
            response = Response(
                {"detail": "No active account was found for this session."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
            return clear_refresh_cookie(response)

        response = Response(
            {"access": access, **build_session_payload(member)},
            status=status.HTTP_200_OK,
        )
        return set_refresh_cookie(response, str(rotated_refresh))
