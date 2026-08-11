"""
Login view for user authentication.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security.throttles import LoginRateThrottle
from apps.authn.serializers import LoginSerializer

from ..helpers import build_auth_success_payload


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
        serializer = LoginSerializer(data=request.data)

        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user = serializer.validated_data["user"]

        return Response(
            build_auth_success_payload(user, "Login successful."),
            status=status.HTTP_200_OK,
        )
