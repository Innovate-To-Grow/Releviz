from __future__ import annotations

import logging

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
) -> tuple[EmailAuthChallenge, str]:
    import apps.authn.services.email.challenges as api

    normalized_email = normalize_email(target_email)
    now = timezone.now()
    assert_within_limit(
        member=member,
        purpose=purpose,
        target_email=normalized_email,
        now=now,
    )
    expire_queryset(
        EmailAuthChallenge.objects.filter(
            member=member,
            purpose=purpose,
            target_email__iexact=normalized_email,
            status__in=[
                EmailAuthChallenge.Status.PENDING,
                EmailAuthChallenge.Status.VERIFIED,
            ],
        )
    )

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
    return challenge, code


def issue_email_challenge(
    *,
    member,
    purpose: str,
    target_email: str,
    link_flow: str | None = None,
    link_source: str | None = None,
    link_event: str | None = None,
) -> EmailAuthChallenge:
    import apps.authn.services.email.challenges as api
    from apps.authn.services.email.send_email import send_verification_email

    challenge, plain_code = create_challenge_record(
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
        )
    except Exception as exc:
        logger.exception("Failed to send verification email")
        with transaction.atomic():
            EmailAuthChallenge.objects.filter(pk=challenge.pk).delete()
        raise api.AuthChallengeDeliveryError("Failed to send verification email.") from exc

    return challenge
