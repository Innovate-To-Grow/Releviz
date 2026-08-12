from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from ..helpers import build_session_payload


class SessionView(APIView):
    """Return the authenticated member state used to bootstrap the frontend."""

    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        return Response(
            build_session_payload(request.user),
            status=status.HTTP_200_OK,
        )
