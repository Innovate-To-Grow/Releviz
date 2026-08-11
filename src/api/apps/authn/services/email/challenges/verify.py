from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone

from apps.authn.models.security import EmailAuthChallenge

from .queries import latest_pending_for_input


def verify_email_code(
    *,
    purpose: str,
    target_email: str,
    code: str,
    member=None,
    approved_callback: Callable[[EmailAuthChallenge], Any] | None = None,
) -> Any:
    return verify_email_code_for_purposes(
        purposes=[purpose],
        target_email=target_email,
        code=code,
        member=member,
        approved_callback=approved_callback,
    )


def verify_email_code_for_purposes(
    *,
    purposes: Sequence[str],
    target_email: str,
    code: str,
    member=None,
    approved_callback: Callable[[EmailAuthChallenge], Any] | None = None,
) -> Any:
    # Keep the successful transition and caller completion work in one
    # transaction. Public login/register callers use the callback to lock and
    # update the member/contact and mint JWTs before code consumption can
    # commit. Invalid outcomes leave the block normally, so attempt/expiry
    # changes commit before the public exception is raised below.
    callback_result = None
    with transaction.atomic():
        challenge, _, error = _verify_and_transition_email_code(
            purposes=purposes,
            target_email=target_email,
            code=code,
            target_status=EmailAuthChallenge.Status.CONSUMED,
            member=member,
        )
        if challenge is not None and approved_callback is not None:
            callback_result = approved_callback(challenge)
    if error or challenge is None:
        import apps.authn.services.email.challenges as api

        raise api.AuthChallengeInvalid(error or "Verification code is invalid or has expired.")
    return callback_result if approved_callback is not None else challenge


def verify_email_code_and_mint_token(
    *,
    purpose: str,
    target_email: str,
    code: str,
    member=None,
) -> tuple[EmailAuthChallenge, str]:
    """Verify a code and atomically transition it to a token-bearing state.

    Password/account confirmation flows need a second request after code entry.
    The code check and ``PENDING -> VERIFIED`` transition therefore happen in
    one locked transaction, and the plaintext token is returned only to the
    caller that won the conditional update.
    """
    challenge, verification_token, error = _verify_and_transition_email_code(
        purposes=[purpose],
        target_email=target_email,
        code=code,
        target_status=EmailAuthChallenge.Status.VERIFIED,
        member=member,
    )
    if error or challenge is None or verification_token is None:
        import apps.authn.services.email.challenges as api

        raise api.AuthChallengeInvalid(error or "Verification code is invalid or has expired.")
    return challenge, verification_token


@transaction.atomic
def _verify_and_transition_email_code(
    *,
    purposes: Sequence[str],
    target_email: str,
    code: str,
    target_status: str,
    member=None,
) -> tuple[EmailAuthChallenge | None, str | None, str]:
    # Lock the pending challenge row so concurrent verification attempts serialize.
    # Without the lock, two simultaneous wrong guesses can both read attempts=N and
    # both write N+1 (a lost update that under-counts and weakens brute-force limits),
    # and two simultaneous correct guesses could both succeed. The conditional
    # status update below remains the final one-time-use guard.
    challenge = latest_pending_for_input(purposes=purposes, target_email=target_email, for_update=True)
    if challenge is None:
        return None, None, "Verification code is invalid or has expired."

    if member is not None and challenge.member_id != member.pk:
        return None, None, "Verification code is invalid or has expired."

    if challenge.is_expired or challenge.attempts >= challenge.max_attempts:
        challenge.mark_expired()
        return None, None, "Verification code is invalid or has expired."

    if not check_password(code, challenge.code_hash):
        challenge.attempts += 1
        if challenge.attempts >= challenge.max_attempts:
            challenge.status = EmailAuthChallenge.Status.EXPIRED
        challenge.save(update_fields=["attempts", "status", "updated_at"])
        return None, None, "Verification code is invalid or has expired."

    now = timezone.now()
    update_values = {
        "status": target_status,
        "verified_at": now,
        "updated_at": now,
    }
    verification_token = None
    if target_status == EmailAuthChallenge.Status.VERIFIED:
        import apps.authn.services.email.challenges as api

        verification_token = api._random_token()
        update_values.update(
            verification_token_hash=make_password(verification_token),
            expires_at=now + api.CHALLENGE_TTL,
        )
    elif target_status != EmailAuthChallenge.Status.CONSUMED:
        raise ValueError(f"Unsupported email challenge target status: {target_status}")

    updated = EmailAuthChallenge.objects.filter(
        pk=challenge.pk,
        status=EmailAuthChallenge.Status.PENDING,
        expires_at__gt=now,
    ).update(**update_values)
    if not updated:
        return None, None, "Verification code is invalid or has expired."

    challenge.status = target_status
    challenge.verified_at = now
    if target_status == EmailAuthChallenge.Status.VERIFIED:
        challenge.expires_at = update_values["expires_at"]
    return challenge, verification_token, ""


@transaction.atomic
def mark_challenge_verified(challenge: EmailAuthChallenge) -> str:
    import apps.authn.services.email.challenges as api

    locked = EmailAuthChallenge.objects.select_for_update().filter(pk=challenge.pk).first()
    if locked is None or locked.status != EmailAuthChallenge.Status.PENDING or locked.is_expired:
        raise api.AuthChallengeInvalid("Verification code is invalid or has expired.")

    verification_token = api._random_token()
    now = timezone.now()
    new_expires_at = now + api.CHALLENGE_TTL
    updated = EmailAuthChallenge.objects.filter(
        pk=locked.pk,
        status=EmailAuthChallenge.Status.PENDING,
        expires_at__gt=now,
    ).update(
        status=EmailAuthChallenge.Status.VERIFIED,
        verified_at=now,
        verification_token_hash=make_password(verification_token),
        expires_at=new_expires_at,
        updated_at=now,
    )
    if not updated:
        raise api.AuthChallengeInvalid("Verification code is invalid or has expired.")
    challenge.status = EmailAuthChallenge.Status.VERIFIED
    challenge.verified_at = now
    challenge.expires_at = new_expires_at
    return verification_token


def consume_login_or_registration_challenge(challenge: EmailAuthChallenge):
    import apps.authn.services.email.challenges as api

    # Consume happens in a separate request/transaction from verify, so the
    # select_for_update lock taken during verify is no longer held. Flip the
    # status with a single conditional UPDATE that only matches a still-PENDING
    # row; if two requests both passed verification for the same code, only the
    # first flips it (1 row) and the loser sees 0 rows and is rejected — enforcing
    # one-time use regardless of database backend.
    now = timezone.now()
    updated = EmailAuthChallenge.objects.filter(
        pk=challenge.pk,
        status=EmailAuthChallenge.Status.PENDING,
        expires_at__gt=now,
    ).update(
        status=EmailAuthChallenge.Status.CONSUMED,
        updated_at=now,
    )
    if not updated:
        EmailAuthChallenge.objects.filter(
            pk=challenge.pk,
            status=EmailAuthChallenge.Status.PENDING,
            expires_at__lte=now,
        ).update(status=EmailAuthChallenge.Status.EXPIRED, updated_at=now)
        raise api.AuthChallengeInvalid("Verification code is invalid or has expired.")
    challenge.status = EmailAuthChallenge.Status.CONSUMED


def consume_verification_token(
    *,
    purpose: str,
    verification_token: str,
    member=None,
) -> EmailAuthChallenge:
    challenge = _consume_verification_token(
        purpose=purpose,
        verification_token=verification_token,
        member=member,
    )
    if challenge is None:
        import apps.authn.services.email.challenges as api

        raise api.AuthChallengeInvalid("Verification token is invalid or has expired.")
    return challenge


@transaction.atomic
def _consume_verification_token(
    *,
    purpose: str,
    verification_token: str,
    member=None,
) -> EmailAuthChallenge | None:
    queryset = (
        EmailAuthChallenge.objects.select_for_update()
        .filter(
            purpose=purpose,
            status=EmailAuthChallenge.Status.VERIFIED,
        )
        .order_by("-verified_at", "-created_at")
    )
    if member is not None:
        queryset = queryset.filter(member=member)

    # No arbitrary cap: the candidate set is tightly scoped (purpose + VERIFIED +
    # member) and at most one row can match a given token hash. A prior [:10] slice
    # could silently reject a valid token when >10 verified challenges existed for
    # the member/purpose.
    now = timezone.now()
    for challenge in queryset:
        if challenge.expires_at <= now:
            challenge.mark_expired()
            continue
        token_hash = challenge.verification_token_hash
        if token_hash and check_password(verification_token, token_hash):
            updated = EmailAuthChallenge.objects.filter(
                pk=challenge.pk,
                status=EmailAuthChallenge.Status.VERIFIED,
                expires_at__gt=now,
            ).update(
                status=EmailAuthChallenge.Status.CONSUMED,
                updated_at=now,
            )
            if updated:
                challenge.status = EmailAuthChallenge.Status.CONSUMED
                return challenge

    return None
