from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta
from math import ceil

from django.utils import timezone

from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.auth_email import normalize_email


def expire_queryset(queryset):
    queryset.exclude(status=EmailAuthChallenge.Status.EXPIRED).update(
        status=EmailAuthChallenge.Status.EXPIRED,
        updated_at=timezone.now(),
    )


def get_latest_pending(*, purpose: str, target_email: str):
    return (
        EmailAuthChallenge.objects.filter(
            purpose=purpose,
            target_email__iexact=target_email,
            status=EmailAuthChallenge.Status.PENDING,
        )
        .order_by("-created_at")
        .first()
    )


def get_latest_pending_for_purposes(
    *,
    purposes: Sequence[str],
    target_email: str,
    for_update: bool = False,
):
    queryset = EmailAuthChallenge.objects.filter(
        purpose__in=purposes,
        target_email__iexact=target_email,
        status=EmailAuthChallenge.Status.PENDING,
    )
    if for_update:
        # Lock the row so concurrent verification attempts serialize, preventing
        # lost attempt-counter increments and double-verification (no-op on SQLite,
        # effective on PostgreSQL in production).
        queryset = queryset.select_for_update()
    return queryset.order_by("-created_at").first()


def assert_within_limit(*, member, purpose: str, target_email: str, now):
    import apps.authn.services.email.challenges as api

    cutoff = now - timedelta(hours=1)
    recent_challenges = EmailAuthChallenge.objects.filter(
        member=member,
        purpose=purpose,
        target_email__iexact=target_email,
        created_at__gt=cutoff,
    )
    sent_count = recent_challenges.count()
    if sent_count >= api.MAX_CHALLENGES_PER_HOUR:
        # Enough earlier sends must leave the rolling hour before another code
        # can be requested, even if the cap has been reduced since those sends.
        oldest_retained = recent_challenges.order_by("-created_at")[api.MAX_CHALLENGES_PER_HOUR - 1]
        retry_after = max(
            ceil((oldest_retained.created_at + timedelta(hours=1) - now).total_seconds()),
            1,
        )
        raise api.AuthChallengeThrottled(
            "Too many verification codes requested. Please try again later.",
            retry_after=retry_after,
        )

    latest = get_latest_pending(purpose=purpose, target_email=target_email)
    if latest and latest.last_sent_at and now - latest.last_sent_at < api.RESEND_COOLDOWN:
        raise api.AuthChallengeThrottled(
            "Please wait before requesting another code.",
            retry_after=max(
                ceil((latest.last_sent_at + api.RESEND_COOLDOWN - now).total_seconds()), 1
            ),
        )


def latest_pending_for_input(
    *, purposes: Sequence[str], target_email: str, for_update: bool = False
):
    return get_latest_pending_for_purposes(
        purposes=purposes,
        target_email=normalize_email(target_email),
        for_update=for_update,
    )
