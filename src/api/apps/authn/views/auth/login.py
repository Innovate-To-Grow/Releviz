"""
Login view for user authentication.
"""

from rest_framework import status
from rest_framework.exceptions import Throttled
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import (
    clear_password_login_failures,
    enforce_cookie_request_origin,
    password_login_allowed,
    record_password_login_failure,
)
from apps.authn.security.throttles import LoginRateThrottle
from apps.authn.serializers import LoginSerializer

from ..helpers import auth_success_response, build_auth_success_payload


class LoginView(APIView):
    """
    API endpoint for user login.
    Returns JWT access and refresh tokens.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        enforce_cookie_request_origin(request)
        identifier = str(request.data.get("identifier") or request.data.get("email") or "")
        decision = password_login_allowed(identifier, request)
        if not decision.allowed:
            raise Throttled(wait=decision.retry_after)
        serializer = LoginSerializer(data=request.data)

        if not serializer.is_valid():
            record_password_login_failure(identifier, request)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user = serializer.validated_data["user"]
        clear_password_login_failures(identifier, request)

        return auth_success_response(
            build_auth_success_payload(user, "Login successful."),
            request=request,
            response_status=status.HTTP_200_OK,
        )
