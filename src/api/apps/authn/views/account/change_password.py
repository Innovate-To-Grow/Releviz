"""
Change password view for authenticated users.
"""

import logging

from django.contrib.auth.password_validation import validate_password
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import revoke_all_refresh_sessions
from apps.authn.serializers import ChangePasswordSerializer

logger = logging.getLogger(__name__)


class ChangePasswordView(APIView):
    """
    API endpoint for changing the authenticated user's password.
    POST: Change password with current password verification.
    Every session is signed out, so the caller must authenticate again.
    """

    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        """Change the user's password."""
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})

        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # Set new password
        new_password = serializer.validated_data["_decrypted_new_password"]
        validate_password(new_password, user=request.user)
        request.user.set_password(new_password)
        request.user.save()

        # Changing a password signs out every device, including this one, so no
        # replacement token pair is issued.
        revoked = revoke_all_refresh_sessions(request.user)
        logger.info(
            "Revoked %s refresh session(s) after a password change for member %s",
            revoked,
            request.user.pk,
        )

        return Response(
            {"message": "Password changed successfully."},
            status=status.HTTP_200_OK,
        )
