"""
Registration view for user signup.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security.throttles import EmailCodeRequestThrottle
from apps.authn.serializers import RegisterSerializer

from ..helpers import challenge_error_response


class RegisterView(APIView):
    """
    API endpoint for user registration.
    Creates or updates an inactive user and sends a verification code.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailCodeRequestThrottle]
    auth_rate_scope = "register"

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        serializer = RegisterSerializer(data=request.data)

        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        try:
            serializer.save()
        except Exception as exc:  # noqa: BLE001
            return challenge_error_response(exc)

        return Response(
            {
                "message": "Registration started. Check your email for a verification code.",
                "next_step": "verify_code",
            },
            status=status.HTTP_202_ACCEPTED,
        )
