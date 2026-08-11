"""SMS-channel verification for the password create/change/reset flows.

The email password flows verify a code and then mint a one-time ``verification_token``
that the confirm step consumes via the channel-blind ``consume_verification_token``.
This module gives the SMS channel the same shape: it reuses the existing SMS OTP
infrastructure to verify the code, then mints a VERIFIED ``EmailAuthChallenge`` row
(``channel="sms"``) carrying the token — so the confirm endpoints stay unchanged.
"""

from __future__ import annotations

from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from apps.authn.models.security import EmailAuthChallenge
from apps.authn.services.email.challenges import CHALLENGE_TTL, _random_token
from apps.authn.services.sms import (
    PhoneVerificationInvalid,
    PhoneVerificationThrottled,
    start_phone_verification,
)
from apps.authn.services.sms.sns_verify import _check_phone_verification


def _password_context(*, member, purpose: str) -> str:
    return f"{purpose}:{member.pk}"


def request_sms_password_code(*, member, e164: str, purpose: str) -> str:
    """Send a durable SMS OTP for a password flow and return its challenge ID."""
    result = start_phone_verification(
        e164,
        purpose=purpose,
        member=member,
        context_identifier=_password_context(member=member, purpose=purpose),
    )
    challenge_id = result.get("challenge_id") if isinstance(result, dict) else None
    if not challenge_id:
        from apps.authn.services.sms import PhoneVerificationDeliveryError

        raise PhoneVerificationDeliveryError("SMS provider did not return a challenge identifier.")
    return str(challenge_id)


def verify_sms_password_code_and_mint(
    *,
    member,
    purpose: str,
    e164: str,
    code: str,
    challenge_id=None,
) -> str:
    """Verify an SMS OTP and mint a verification token for ``purpose``.

    Returns the plaintext token (only its hash is stored). Raises
    ``PhoneVerificationInvalid`` / ``PhoneVerificationThrottled`` from the OTP layer
    when the code is wrong, expired, reused, or over-attempted — in which case no
    token row is created.
    """
    token, outcome = _verify_sms_password_code_and_mint(
        member=member,
        purpose=purpose,
        e164=e164,
        code=code,
        challenge_id=challenge_id,
    )
    # Raise only after the transaction commits so invalid-attempt counters and
    # expiry state remain durable.
    if outcome == "throttled":
        raise PhoneVerificationThrottled("Too many failed attempts. Please request a new code.")
    if token is None:
        raise PhoneVerificationInvalid("Verification code is invalid or has expired.")
    return token


@transaction.atomic
def _verify_sms_password_code_and_mint(
    *,
    member,
    purpose: str,
    e164: str,
    code: str,
    challenge_id=None,
) -> tuple[str | None, str]:
    challenge, outcome = _check_phone_verification(
        phone_number=e164,
        code=code,
        challenge_id=challenge_id,
        purpose=purpose,
        member=member,
        context_identifier=_password_context(member=member, purpose=purpose),
        consume=True,
    )
    if challenge is None:
        return None, outcome

    token = _mint_sms_verification_token(
        member=member,
        purpose=purpose,
        e164=e164,
    )
    return token, "approved"


@transaction.atomic
def _mint_sms_verification_token(*, member, purpose: str, e164: str) -> str:
    # Supersede any earlier unconsumed SMS challenge for this member+purpose so only
    # the freshest token is consumable (mirrors the email flow's expire-on-issue).
    EmailAuthChallenge.objects.filter(
        member=member,
        purpose=purpose,
        channel=EmailAuthChallenge.Channel.SMS,
        status__in=[EmailAuthChallenge.Status.PENDING, EmailAuthChallenge.Status.VERIFIED],
    ).update(status=EmailAuthChallenge.Status.EXPIRED, updated_at=timezone.now())

    token = _random_token()
    now = timezone.now()
    EmailAuthChallenge.objects.create(
        member=member,
        purpose=purpose,
        channel=EmailAuthChallenge.Channel.SMS,
        target_phone=e164,
        target_email="",
        code_hash="",
        verification_token_hash=make_password(token),
        verified_at=now,
        expires_at=now + CHALLENGE_TTL,
        status=EmailAuthChallenge.Status.VERIFIED,
    )
    return token
