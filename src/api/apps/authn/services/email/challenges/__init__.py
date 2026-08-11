"""Email verification challenges: issue, verify, consume."""

from __future__ import annotations

import secrets
from datetime import timedelta

from .issue import create_challenge_record as _create_challenge_record
from .issue import issue_email_challenge
from .verify import (
    consume_login_or_registration_challenge,
    consume_verification_token,
    mark_challenge_verified,
    verify_email_code,
    verify_email_code_and_mint_token,
    verify_email_code_for_purposes,
)

CHALLENGE_TTL = timedelta(minutes=10)
RESEND_COOLDOWN = timedelta(seconds=60)
MAX_CHALLENGES_PER_HOUR = 10


class AuthChallengeError(RuntimeError):
    """Base exception for auth challenge failures."""


class AuthChallengeInvalid(AuthChallengeError):
    """Raised when a code or token is invalid."""


class AuthChallengeThrottled(AuthChallengeError):
    """Raised when a code is requested too frequently."""


class AuthChallengeDeliveryError(AuthChallengeError):
    """Raised when the SES send fails."""


def _random_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _random_token() -> str:
    return secrets.token_urlsafe(32)


__all__ = [
    "AuthChallengeDeliveryError",
    "AuthChallengeError",
    "AuthChallengeInvalid",
    "AuthChallengeThrottled",
    "CHALLENGE_TTL",
    "consume_login_or_registration_challenge",
    "consume_verification_token",
    "issue_email_challenge",
    "mark_challenge_verified",
    "MAX_CHALLENGES_PER_HOUR",
    "RESEND_COOLDOWN",
    "verify_email_code",
    "verify_email_code_and_mint_token",
    "verify_email_code_for_purposes",
]
