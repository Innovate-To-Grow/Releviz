"""Record that an invitation link was opened."""

import uuid

from django.utils.cache import patch_cache_control
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.services.invitations import mark_invitation_opened


class EventInvitationOpenView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        code = str(request.data.get("code") or "").strip()
        try:
            access_token = uuid.UUID(str(request.data.get("token") or ""))
        except (ValueError, TypeError, AttributeError):
            access_token = None
        if code and access_token:
            mark_invitation_opened(event_code=code, access_token=access_token)
        response = Response(status=204)
        patch_cache_control(response, private=True, no_store=True)
        return response
