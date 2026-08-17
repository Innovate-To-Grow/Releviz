"""Shared helpers for the temporary access views."""

import logging

from apps.authn.security import client_ip, security_log_key
from apps.scheduling.payloads import api_event, api_participant
from apps.scheduling.permissions import can_view_event_results
from apps.scheduling.services.results import serialize_result_snapshot
from apps.scheduling.services.temporary_access import (
    clear_temporary_session_cookie,
    temporary_session_member_has_full_access,
)

from ..helpers import temp_private_response

security_logger = logging.getLogger("releviz.security")


def log_temporary_session_denied(request, *, event_code: str, operation: str) -> None:
    security_logger.warning(
        "temporary_event_session_denied",
        extra={
            "auth_key": security_log_key(str(event_code or "").strip().upper()),
            "auth_scope": "temp_event_session",
            "ip_address": client_ip(request),
            "operation": operation,
        },
    )


def temp_access_payload(session):
    event = session.participant.event
    can_view_results = can_view_event_results(event, session.member)
    payload = {
        "event": api_event(event),
        "participant": api_participant(session.participant),
        "email": session.member.get_primary_email(),
        "canViewResults": can_view_results,
        "sessionExpiresAt": session.expires_at.isoformat(),
    }
    if can_view_results:
        snapshot = serialize_result_snapshot(event)
        payload["resultSnapshot"] = snapshot
        payload["results"] = snapshot["results"]
    return payload


def inactive_session_response(request, *, event_code: str, operation: str):
    """Deny an operation whose event-scoped session is gone, and clear the cookie.

    An upgraded account must be told to sign in; every other cause stays
    indistinguishable from an unknown event or invitation.
    """

    log_temporary_session_denied(request, event_code=event_code, operation=operation)
    account_upgraded = temporary_session_member_has_full_access(request, event_code=event_code)
    response = temp_private_response(
        {
            "error": (
                "This account now has full access. Sign in to continue."
                if account_upgraded
                else "Temporary event access is not active."
            ),
            "errorCode": ("temp_account_upgraded" if account_upgraded else "temp_session_inactive"),
        },
        status=403 if account_upgraded else 401,
    )
    clear_temporary_session_cookie(response)
    return response
