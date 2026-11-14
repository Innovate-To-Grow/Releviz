"""Read and end a temporary event session."""

import logging
from collections.abc import Mapping

from rest_framework.exceptions import ParseError, UnsupportedMediaType
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


def _signed_out_event_code(request) -> str:
    """The event a sign-out names, or "" when its body names none.

    A body the API cannot read (malformed JSON, another media type, or JSON
    that is not an object) names no event: the sign-out still succeeds and
    ends whatever session the cookie holds, as it did before it read a body.
    """

    try:
        data = request.data
    except (ParseError, UnsupportedMediaType):
        return ""
    if not isinstance(data, Mapping):
        return ""
    return str(data.get("code") or "").strip()


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
        event_code = _signed_out_event_code(request)
        session = temporary_session_from_request(
            request,
            update_last_seen=False,
        )
        if session is not None and event_code and session.participant.event.code != event_code:
            # Signing out of one event leaves another event's session, and the
            # cookie that holds it, alone.
            return temp_private_response(status=204)
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
