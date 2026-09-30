"""Open a temporary event session from a private invitation link."""

import logging

from rest_framework.exceptions import Throttled
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.security import (
    client_ip,
    consume_request_rate_limit,
    enforce_cookie_request_origin,
    security_log_key,
)
from apps.scheduling.services.temporary_access import (
    open_temporary_access,
    set_temporary_session_cookie,
    temporary_access_rate_identity,
)

from ..helpers import temp_private_response
from .helpers import temp_access_payload

security_logger = logging.getLogger("releviz.security")


class TemporaryAccessOpenView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        # This response sets the event-scoped HttpOnly cookie, so apply the
        # same login-CSRF protection used by every other cookie mutation.
        enforce_cookie_request_origin(request)
        event_code = str(request.data.get("code") or "").strip()
        invitation_token = str(request.data.get("invitationToken") or "").strip()
        identity = temporary_access_rate_identity(event_code, invitation_token)
        quota = consume_request_rate_limit("temp_access_open", request, identity)
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)
        opening = open_temporary_access(
            event_code=event_code,
            access_token=invitation_token,
            request=request,
        )
        if opening is None:
            security_logger.warning(
                "temporary_access_open_rejected",
                extra={
                    "auth_key": security_log_key(identity),
                    "auth_scope": "temp_access_open",
                    "ip_address": client_ip(request),
                },
            )
            # One body for every cause, so a link reveals nothing about the
            # event, the address it was sent to, or the account behind it.
            return temp_private_response(
                {
                    "error": "This invitation link is not active.",
                    "errorCode": "temp_invitation_inactive",
                },
                status=404,
            )
        response = temp_private_response(temp_access_payload(opening.session))
        if opening.credential is not None:
            set_temporary_session_cookie(response, opening.credential)
        return response
