"""Read and end a temporary event session."""

import logging

from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.security import enforce_cookie_request_origin
from apps.scheduling.services.temporary_access import (
    clear_temporary_session_cookie,
    temporary_session_from_request,
)

from ..helpers import temp_private_response
from .helpers import inactive_session_response, temp_access_payload

security_logger = logging.getLogger("releviz.security")


class TemporaryAccessSessionView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)
        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="read_session",
            )
        return temp_private_response(temp_access_payload(session))


class TemporaryAccessLogoutView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        enforce_cookie_request_origin(request)
        session = temporary_session_from_request(
            request,
            update_last_seen=False,
        )
        if session is not None:
            session.revoke()
            security_logger.info(
                "temporary_event_session_revoked",
                extra={
                    "temporary_session_id": str(session.pk),
                    "member_id": str(session.member_id),
                },
            )
        response = temp_private_response(status=204)
        clear_temporary_session_cookie(response)
        return response
