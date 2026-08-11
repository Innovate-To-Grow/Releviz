"""
Profile view for user information management.
"""

import base64
import logging

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.serializers import ProfileSerializer

logger = logging.getLogger(__name__)

# Magic-byte signatures for allowed image formats
_ALLOWED_SIGNATURES = {
    b"\x89PNG": "png",
    b"\xff\xd8\xff": "jpeg",
    b"GIF8": "gif",
    b"RIFF": "webp",
}


def _validate_image_bytes(data: bytes) -> bool:
    """Validate that file content starts with a known image magic-byte signature."""
    return any(data.startswith(sig) for sig in _ALLOWED_SIGNATURES)


class ProfileView(APIView):
    """
    API endpoint for user profile.
    GET: Retrieve current user's profile.
    PATCH: Update profile (JSON: first_name, last_name, organization;
           multipart: profile_image file).
    """

    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        """Get current user's profile."""
        try:
            serializer = ProfileSerializer(instance=request.user)
            return Response(serializer.data, status=status.HTTP_200_OK)
        except (ValueError, TypeError, AttributeError):
            logger.exception("Profile serialization failed for user %s", request.user.pk)
            return Response(
                {"detail": "Failed to load profile."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

    # noinspection PyMethodMayBeStatic
    def patch(self, request):
        """Update current user's profile."""
        user = request.user

        # Handle multipart form (profile image upload)
        if request.FILES.get("profile_image"):
            file = request.FILES["profile_image"]

            _MAX_SIZE = 5 * 1024 * 1024  # 5 MB
            _ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

            if file.size > _MAX_SIZE:
                return Response(
                    {"detail": "Profile image must be 5 MB or smaller."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            file_content_type = getattr(file, "content_type", "") or ""
            if file_content_type not in _ALLOWED_TYPES:
                return Response(
                    {"detail": "Profile image must be a JPEG, PNG, GIF, or WebP file."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            content = file.read()
            if not _validate_image_bytes(content[:32]):
                return Response(
                    {"detail": "File content does not match an allowed image type (JPEG, PNG, GIF, WebP)."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            b64 = base64.b64encode(content).decode("utf-8")
            user.profile_image = f"data:{file_content_type};base64,{b64}"
            user.save(update_fields=["profile_image", "updated_at"])
            serializer = ProfileSerializer(instance=user)
            return Response(serializer.data, status=status.HTTP_200_OK)

        # Handle JSON body (text fields)
        serializer = ProfileSerializer(instance=user, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_200_OK)
