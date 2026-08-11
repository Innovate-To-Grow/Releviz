"""
Signed auto-login tokens for email unsubscribe / preference management.

Follows the same pattern as event/services/ticket_assets.py.
"""

from hashlib import sha256

from django.core import signing
from django.core.cache import cache

def build_frontend_absolute_url(path: str) -> str:
    """Build an absolute frontend URL from a path."""
    from django.conf import settings

    base = getattr(settings, "FRONTEND_URL", "").rstrip("/")
    if not base:
        base = getattr(settings, "BACKEND_URL", "").rstrip("/")
    return f"{base}{path}"

_UNSUBSCRIBE_LOGIN_SALT = "email-unsubscribe-login"
_UNSUBSCRIBE_LOGIN_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


class UnsubscribeLoginTokenError(ValueError):
    """Base error for unsubscribe login token validation."""


class UnsubscribeLoginTokenAlreadyUsed(UnsubscribeLoginTokenError):
    """Raised when an unsubscribe login token has already been consumed."""


class UnsubscribeLoginTokenInvalid(UnsubscribeLoginTokenError):
    """Raised when an unsubscribe login token is invalid or not usable."""


def _consume_one_time_token(token: str) -> bool:
    token_digest = sha256(token.encode("utf-8")).hexdigest()
    # Replay protection depends on cache retention; a cache flush or eviction resets this used-token marker.
    return cache.add(f"authn:unsubscribe-login-used:{token_digest}", True, timeout=_UNSUBSCRIBE_LOGIN_MAX_AGE)


def build_unsubscribe_login_token(member) -> str:
    """Create a signed token that allows one-click login for email preference management."""
    return signing.dumps({"member_id": str(member.pk)}, salt=_UNSUBSCRIBE_LOGIN_SALT, compress=True)


def get_member_from_unsubscribe_token(token: str):
    """Validate an unsubscribe login token and return the associated Member."""
    from apps.authn.models import Member

    try:
        payload = signing.loads(token, salt=_UNSUBSCRIBE_LOGIN_SALT, max_age=_UNSUBSCRIBE_LOGIN_MAX_AGE)
        member_id = payload["member_id"]
    except signing.BadSignature as exc:
        raise UnsubscribeLoginTokenInvalid("Invalid or expired login link.") from exc

    try:
        member = Member.objects.get(pk=member_id, is_active=True)
    except Member.DoesNotExist as exc:
        raise UnsubscribeLoginTokenInvalid("Account not found.") from exc

    if not _consume_one_time_token(token):
        raise UnsubscribeLoginTokenAlreadyUsed("This unsubscribe link has already been used.")

    return member


def build_unsubscribe_url(member) -> str:
    """Build the full frontend URL for the unsubscribe auto-login page."""
    token = build_unsubscribe_login_token(member)
    return build_frontend_absolute_url(f"/unsubscribe-login#token={token}")
