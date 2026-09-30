"""Event-scoped temporary access: the private invitation link, sessions, and cookies."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.authn.security import client_ip, request_user_agent, security_log_key
from apps.scheduling.models import EventInvitation, Participant, TemporaryEventSession
from apps.scheduling.services.invitations.status import mark_invitation_opened

security_logger = logging.getLogger("releviz.security")


@dataclass(frozen=True)
class TemporarySessionCredential:
    session: TemporaryEventSession
    cookie_value: str


@dataclass(frozen=True)
class TemporaryAccessOpening:
    """What an opened invitation link leads to.

    ``credential`` is None when the request's own cookie already carried a live
    session for this invitation: the browser keeps the cookie it has.
    """

    session: TemporaryEventSession
    credential: TemporarySessionCredential | None


def temporary_access_rate_identity(event_code: str, access_token) -> str:
    """Canonicalize equivalent link tokens before applying request quotas."""

    normalized_code = str(event_code or "").strip().upper()
    raw_token = str(access_token or "").strip()
    try:
        normalized_token = str(uuid.UUID(raw_token))
    except (TypeError, ValueError, AttributeError):
        normalized_token = f"invalid:{security_log_key(raw_token.lower())}"
    return f"{normalized_code}:{normalized_token}"


def _invitation_and_participant(*, event_code: str, access_token):
    try:
        token = uuid.UUID(str(access_token or ""))
    except (TypeError, ValueError, AttributeError):
        return None, None
    invitation = (
        EventInvitation.objects.select_related("event", "member")
        .filter(event__code=event_code, access_token=token)
        .first()
    )
    if (
        invitation is None
        or invitation.member_id is None
        or invitation.first_sent_at is None
        or getattr(invitation.member, "access_level", "full") != "temporary"
        or not invitation.member.is_active
    ):
        return None, None
    participant = (
        Participant.objects.select_related("event", "member")
        .filter(event=invitation.event, member_id=invitation.member_id)
        .first()
    )
    if participant is None:
        return None, None
    return invitation, participant


@transaction.atomic
def open_temporary_access(
    *, event_code: str, access_token, request
) -> TemporaryAccessOpening | None:
    """Turn a private invitation link into an event-scoped session.

    The link is the credential, so no live temporary invitation means None and
    nothing about why. Opening only records that the link was opened: the
    invitation becomes accepted and joined through the person's own saves.
    """

    invitation, participant = _invitation_and_participant(
        event_code=event_code,
        access_token=access_token,
    )
    if invitation is None:
        return None

    existing = temporary_session_from_request(request, event_code=invitation.event.code)
    if existing is not None and existing.invitation_id == invitation.pk:
        return TemporaryAccessOpening(session=existing, credential=None)

    mark_invitation_opened(
        event_code=invitation.event.code,
        access_token=invitation.access_token,
    )
    raw_secret = secrets.token_urlsafe(32)
    session = TemporaryEventSession.objects.create(
        member=invitation.member,
        participant=participant,
        invitation=invitation,
        secret_hash=hashlib.sha256(raw_secret.encode()).hexdigest(),
        expires_at=timezone.now() + settings.TEMP_EVENT_SESSION_LIFETIME,
        ip_address=client_ip(request),
        user_agent=request_user_agent(request),
    )
    security_logger.info(
        "temporary_event_session_issued",
        extra={
            "event_id": str(invitation.event_id),
            "invitation_id": str(invitation.pk),
            "member_id": str(invitation.member_id),
            "temporary_session_id": str(session.pk),
        },
    )
    return TemporaryAccessOpening(
        session=session,
        credential=TemporarySessionCredential(
            session=session,
            cookie_value=f"{session.pk}.{raw_secret}",
        ),
    )


def temporary_session_from_request(
    request,
    *,
    event_code: str = "",
    update_last_seen: bool = True,
) -> TemporaryEventSession | None:
    cookie_value = str(request.COOKIES.get(settings.TEMP_EVENT_COOKIE_NAME, "") or "")
    session_id, separator, raw_secret = cookie_value.partition(".")
    if not separator or not raw_secret:
        return None
    try:
        parsed_session_id = uuid.UUID(session_id)
    except (TypeError, ValueError, AttributeError):
        return None

    session = (
        TemporaryEventSession.objects.select_related(
            "member",
            "participant",
            "participant__event",
            "invitation",
        )
        .filter(pk=parsed_session_id)
        .first()
    )
    if session is None:
        return None
    supplied_hash = hashlib.sha256(raw_secret.encode()).hexdigest()
    relationship_valid = (
        session.member_id == session.participant.member_id
        and session.invitation.member_id == session.member_id
        and session.invitation.event_id == session.participant.event_id
    )
    event_matches = not event_code or session.participant.event.code == event_code
    account_is_temporary = (
        getattr(session.member, "access_level", "full") == "temporary" and session.member.is_active
    )
    if (
        not session.active
        or not hmac.compare_digest(session.secret_hash, supplied_hash)
        or not relationship_valid
        or not event_matches
        or not account_is_temporary
    ):
        if session.revoked_at is None and not account_is_temporary:
            session.revoke()
        return None

    if update_last_seen:
        session.last_seen_at = timezone.now()
        session.save(update_fields=["last_seen_at", "updated_at"])
    return session


def temporary_session_member_has_full_access(request, *, event_code: str = "") -> bool:
    """Recognize a valid old temp cookie after its member has been upgraded."""

    cookie_value = str(request.COOKIES.get(settings.TEMP_EVENT_COOKIE_NAME, "") or "")
    session_id, separator, raw_secret = cookie_value.partition(".")
    if not separator or not raw_secret:
        return False
    try:
        parsed_session_id = uuid.UUID(session_id)
    except (TypeError, ValueError, AttributeError):
        return False
    session = (
        TemporaryEventSession.objects.select_related(
            "member",
            "participant__event",
            "invitation",
        )
        .filter(pk=parsed_session_id)
        .first()
    )
    if session is None:
        return False
    relationship_valid = (
        session.member_id == session.participant.member_id
        and session.invitation.member_id == session.member_id
        and session.invitation.event_id == session.participant.event_id
    )
    event_matches = not event_code or session.participant.event.code == event_code
    supplied_hash = hashlib.sha256(raw_secret.encode()).hexdigest()
    return bool(
        relationship_valid
        and event_matches
        and hmac.compare_digest(session.secret_hash, supplied_hash)
        and getattr(session.member, "access_level", "full") == "full"
    )


def set_temporary_session_cookie(response, credential: TemporarySessionCredential) -> None:
    max_age = max(
        int((credential.session.expires_at - timezone.now()).total_seconds()),
        0,
    )
    response.set_cookie(
        settings.TEMP_EVENT_COOKIE_NAME,
        credential.cookie_value,
        max_age=max_age,
        httponly=True,
        secure=settings.TEMP_EVENT_COOKIE_SECURE,
        samesite=settings.TEMP_EVENT_COOKIE_SAMESITE,
        path=settings.TEMP_EVENT_COOKIE_PATH,
    )


def clear_temporary_session_cookie(response) -> None:
    response.delete_cookie(
        settings.TEMP_EVENT_COOKIE_NAME,
        path=settings.TEMP_EVENT_COOKIE_PATH,
        samesite=settings.TEMP_EVENT_COOKIE_SAMESITE,
    )
