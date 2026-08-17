"""Request and verify a temporary access code."""

import logging

from rest_framework.exceptions import Throttled
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.security import (
    client_ip,
    consume_request_rate_limit,
    enforce_cookie_request_origin,
    security_log_key,
)
from apps.scheduling.services.temporary_access import (
    request_temporary_access_code,
    set_temporary_session_cookie,
    temporary_access_rate_identity,
    verify_temporary_access_code,
)

from ..helpers import temp_private_response
from .helpers import temp_access_payload

logger = logging.getLogger(__name__)
security_logger = logging.getLogger("releviz.security")


class TemporaryAccessRequestCodeView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        event_code = str(request.data.get("code") or "").strip()
        invitation_token = str(request.data.get("invitationToken") or "").strip()
        identity = temporary_access_rate_identity(event_code, invitation_token)
        quota = consume_request_rate_limit(
            "temp_access_code_request",
            request,
            identity,
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)
        try:
            request_temporary_access_code(
                event_code=event_code,
                access_token=invitation_token,
            )
        except Exception:
            # Do not reveal whether the event, invitation, or temporary account
            # exists. Operational failures remain visible in server logs.
            logger.exception("temporary_access_code_request_failed")
        return temp_private_response(
            {"message": ("If this access link is valid, a verification code has been sent.")},
            status=202,
        )


class TemporaryAccessVerifyView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        # This response sets the event-scoped HttpOnly cookie, so apply the
        # same login-CSRF protection used by every other cookie mutation.
        enforce_cookie_request_origin(request)
        event_code = str(request.data.get("code") or "").strip()
        invitation_token = str(request.data.get("invitationToken") or "").strip()
        verification_code = str(request.data.get("verificationCode") or "").strip()
        identity = temporary_access_rate_identity(event_code, invitation_token)
        quota = consume_request_rate_limit(
            "temp_access_code_verify",
            request,
            identity,
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)
        try:
            credential = verify_temporary_access_code(
                event_code=event_code,
                access_token=invitation_token,
                code=verification_code,
                request=request,
            )
        except DRFValidationError:
            credential = None
        if credential is None:
            security_logger.warning(
                "temporary_access_code_verification_failed",
                extra={
                    "auth_key": security_log_key(identity),
                    "auth_scope": "temp_access_code_verify",
                    "ip_address": client_ip(request),
                },
            )
            return temp_private_response(
                {"error": "Invalid or expired verification code."},
                status=400,
            )
        response = temp_private_response(temp_access_payload(credential.session))
        set_temporary_session_cookie(response, credential)
        return response
