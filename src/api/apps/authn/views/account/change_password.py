"""
Change password view for authenticated users.
"""

import logging

from django.contrib.auth.password_validation import validate_password
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.serializers import ChangePasswordSerializer

logger = logging.getLogger(__name__)


class ChangePasswordView(APIView):
    """
    API endpoint for changing the authenticated user's password.
    POST: Change password with current password verification.
    Accepts optional `refresh` token in body to blacklist the old session.
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

        # Blacklist the provided refresh token so the old session is invalidated
        refresh_token = request.data.get("refresh")
        new_access = None
        new_refresh = None
        if refresh_token:
            try:
                old_token = RefreshToken(refresh_token)
                old_token.blacklist()
                # Issue a fresh token pair so the current session continues
                fresh = RefreshToken.for_user(request.user)
                new_access = str(fresh.access_token)
                new_refresh = str(fresh)
            except TokenError:
                logger.warning(
                    "Unable to invalidate the prior session after account update for member %s", request.user.pk
                )

        response_data = {"message": "Password changed successfully."}
        if new_access and new_refresh:
            response_data["access"] = new_access
            response_data["refresh"] = new_refresh

        return Response(response_data, status=status.HTTP_200_OK)
