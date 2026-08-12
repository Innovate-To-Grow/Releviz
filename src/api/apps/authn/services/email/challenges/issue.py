from __future__ import annotations

import logging
from uuid import UUID

from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.auth_email import normalize_email

from .queries import assert_within_limit, expire_queryset

logger = logging.getLogger(__name__)


@transaction.atomic
def create_challenge_record(
    *,
    member,
    purpose: str,
    target_email: str,
) -> tuple[EmailAuthChallenge, str, list[tuple[UUID, str]]]:
    import apps.authn.services.email.challenges as api

    normalized_email = normalize_email(target_email)
    now = timezone.now()
    assert_within_limit(
        member=member,
        purpose=purpose,
        target_email=normalized_email,
        now=now,
    )
    replaceable = EmailAuthChallenge.objects.filter(
        member=member,
        purpose=purpose,
        target_email__iexact=normalized_email,
        status__in=[
            EmailAuthChallenge.Status.PENDING,
            EmailAuthChallenge.Status.VERIFIED,
        ],
    )
    superseded_states = list(replaceable.values_list("pk", "status"))
    expire_queryset(replaceable)

    code = api._random_code()
    challenge = EmailAuthChallenge.objects.create(
        member=member,
        purpose=purpose,
        target_email=normalized_email,
        code_hash=make_password(code),
        expires_at=now + api.CHALLENGE_TTL,
        max_attempts=5,
        last_sent_at=now,
    )
    return challenge, code, superseded_states


def _restore_superseded_challenges(
    *,
    challenge: EmailAuthChallenge,
    superseded_states: list[tuple[UUID, str]],
) -> None:
    """Restore the previous usable code when delivery of its replacement fails."""
    with transaction.atomic():
        EmailAuthChallenge.objects.filter(pk=challenge.pk).delete()

        # A concurrent request may already have delivered another replacement.
        # In that case the prior codes must stay expired.
        replacement_exists = EmailAuthChallenge.objects.filter(
            member_id=challenge.member_id,
            purpose=challenge.purpose,
            target_email__iexact=challenge.target_email,
            status__in=[
                EmailAuthChallenge.Status.PENDING,
                EmailAuthChallenge.Status.VERIFIED,
            ],
        ).exists()
        if replacement_exists:
            return

        now = timezone.now()
        for challenge_id, previous_status in superseded_states:
            EmailAuthChallenge.objects.filter(
                pk=challenge_id,
                status=EmailAuthChallenge.Status.EXPIRED,
                expires_at__gt=now,
            ).update(status=previous_status, updated_at=now)


def issue_email_challenge(
    *,
    member,
    purpose: str,
    target_email: str,
    link_flow: str | None = None,
    link_source: str | None = None,
    link_event: str | None = None,
    link_next: str | None = None,
    scope_key: str = "",
) -> EmailAuthChallenge:
    # Event-temporary callers still pass their legacy scope identifier. The
    # current challenge schema isolates those codes by purpose and member; keep
    # accepting the keyword while that API is migrated independently.
    del scope_key
    import apps.authn.services.email.challenges as api
    from apps.authn.services.email.send_email import send_verification_email

    challenge, plain_code, superseded_states = create_challenge_record(
        member=member,
        purpose=purpose,
        target_email=target_email,
    )

    try:
        send_verification_email(
            recipient=challenge.target_email,
            code=plain_code,
            purpose=purpose,
            link_flow=link_flow,
            link_source=link_source,
            link_event=link_event,
            link_next=link_next,
        )
    except Exception as exc:
        logger.exception("Failed to send verification email")
        _restore_superseded_challenges(
            challenge=challenge,
            superseded_states=superseded_states,
        )
        raise api.AuthChallengeDeliveryError("Failed to send verification email.") from exc

    return challenge
