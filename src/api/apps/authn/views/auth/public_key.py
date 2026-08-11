"""
Public key API for RSA encryption.
"""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.services import get_public_key_pem

logger = logging.getLogger(__name__)


class PublicKeyView(APIView):
    """
    API endpoint to retrieve the current public key for password encryption.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    # noinspection PyUnusedLocal
    def get(self, request):
        """
        Get the current public key PEM and key ID.
        The client should use this to encrypt passwords before sending.
        """
        try:
            public_key_pem, key_id = get_public_key_pem()
            return Response(
                {
                    "public_key": public_key_pem,
                    "key_id": key_id,
                },
                status=status.HTTP_200_OK,
            )
        except Exception:
            logger.exception("Failed to retrieve public key")
            return Response(
                {"detail": "Failed to retrieve public key."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
