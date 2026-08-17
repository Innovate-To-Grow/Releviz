"""
Security utility functions extracted from the old security.py.

Rate-limiting functions that depend on the (deleted) AuthRateLimitBucket model
are no-ops. Restore that model before re-enabling rate limiting.
"""

import hashlib
import hmac
import ipaddress
import logging
from datetime import timedelta
from urllib.parse import urlsplit

from django.conf import settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.throttling import BaseThrottle

logger = logging.getLogger("releviz.security")


# ---------------------------------------------------------------------------
# Pure utility functions — no model dependencies
# ---------------------------------------------------------------------------


def normalize_security_identity(value: str) -> str:
    return str(value or "").strip().lower()


def client_ip(request) -> str:
    trusted_proxy_count = max(int(getattr(settings, "AUTH_TRUSTED_PROXY_COUNT", 0)), 0)
    trusted_cidr_hops = max(int(getattr(settings, "AUTH_TRUSTED_PROXY_CIDR_HOPS", 0)), 0)
    forwarded = [
        item.strip()
        for item in str(request.META.get("HTTP_X_FORWARDED_FOR", "")).split(",")
        if item.strip()
    ]
    configured_cidrs = getattr(settings, "AUTH_TRUSTED_PROXY_CIDRS", [])
    if isinstance(configured_cidrs, str):
        configured_cidrs = configured_cidrs.split(",")
    trusted_networks = []
    for value in configured_cidrs:
        try:
            trusted_networks.append(ipaddress.ip_network(str(value).strip(), strict=False))
        except ValueError:
            continue

    if trusted_cidr_hops and forwarded and trusted_networks:
        candidate_index = len(forwarded) - 1
        remaining_proxy_hops = trusted_cidr_hops
        while remaining_proxy_hops > 0 and candidate_index >= 0:
            try:
                proxy_address = ipaddress.ip_address(forwarded[candidate_index])
            except ValueError:
                break
            if not any(proxy_address in network for network in trusted_networks):
                break
            candidate_index -= 1
            remaining_proxy_hops -= 1
        candidate = forwarded[candidate_index] if candidate_index >= 0 else ""
    elif trusted_proxy_count and len(forwarded) >= trusted_proxy_count:
        candidate = forwarded[-trusted_proxy_count]
    else:
        candidate = str(request.META.get("REMOTE_ADDR", "") or "")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return "unknown"


def request_user_agent(request) -> str:
    value = str(request.META.get("HTTP_USER_AGENT", "") or "").strip()
    return value[:255]


def _key_hash(scope: str, dimension: str, raw_key: str) -> str:
    message = f"{scope}:{dimension}:{raw_key}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()


def security_log_key(value: str) -> str:
    return _key_hash("security_log", "identity", normalize_security_identity(value))[:16]


def enforce_cookie_request_origin(request) -> None:
    origin = str(request.META.get("HTTP_ORIGIN", "") or "").rstrip("/")
    if not origin:
        return
    configured = {
        str(value).rstrip("/")
        for value in [
            getattr(settings, "FRONTEND_URL", ""),
            getattr(settings, "BACKEND_URL", ""),
            *getattr(settings, "CSRF_TRUSTED_ORIGINS", []),
        ]
        if value
    }
    request_origin = urlsplit(request.build_absolute_uri("/"))
    configured.add(f"{request_origin.scheme}://{request_origin.netloc}".rstrip("/"))
    if origin not in configured:
        logger.warning(
            "auth_cookie_origin_rejected",
            extra={"origin": origin, "request_host": request.get_host()},
        )
        raise PermissionDenied("Request origin is not allowed.")


# ---------------------------------------------------------------------------
# Stub rate-limiting — AuthRateLimitBucket model was removed.
# Re-enable by restoring the model and the _consume_bucket logic.
# ---------------------------------------------------------------------------


class RateLimitDecision:
    """Stub decision — always allows the request."""

    def __init__(self, allowed: bool = True, retry_after: int = 0):
        self.allowed = allowed
        self.retry_after = retry_after


def consume_request_rate_limit(scope, request, identity="", *, cost=1):
    """Stub — the AuthRateLimitBucket model has been deleted."""
    logger.debug(
        "auth_rate_limit_bypassed",
        extra={
            "auth_scope": scope,
            "auth_identity": security_log_key(identity) if identity else "anonymous",
        },
    )
    return RateLimitDecision(allowed=True)


def revoke_all_refresh_sessions(member) -> int:
    """Blacklist every outstanding refresh token owned by *member*.

    Changing or resetting a password promises to sign out every device. Access
    tokens already fail on their password-hash claim, but refresh tokens keep
    working until they are blacklisted, so a stolen session would survive the
    very action taken to shut it out.
    """
    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken,
        OutstandingToken,
    )

    revoked = 0
    for token in OutstandingToken.objects.filter(user=member):
        _, created = BlacklistedToken.objects.get_or_create(token=token)
        revoked += int(created)
    return revoked


def prune_auth_security_state(*, now=None) -> dict:
    """Prune retained auth state after the legacy rate/session models were removed."""
    from django.apps import apps
    from django.db.models import Q
    from django.utils import timezone
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    from apps.authn.models import EmailAuthChallenge
    from apps.mail.models import EmailDeliveryJob

    now = now or timezone.now()
    session_retention = getattr(
        settings,
        "AUTH_SESSION_RECORD_RETENTION",
        timedelta(days=30),
    )
    session_cutoff = now - session_retention
    expired_challenge_ids = list(
        EmailAuthChallenge.objects.filter(
            status=EmailAuthChallenge.Status.PENDING,
            expires_at__lte=now,
        ).values_list("pk", flat=True)
    )
    expired_challenges = EmailAuthChallenge.objects.filter(pk__in=expired_challenge_ids).update(
        status=EmailAuthChallenge.Status.EXPIRED,
        updated_at=now,
    )
    canceled_auth_jobs = EmailDeliveryJob.objects.filter(
        auth_challenge_id__in=expired_challenge_ids,
        status__in=[
            EmailDeliveryJob.Status.PENDING,
            EmailDeliveryJob.Status.PROCESSING,
            EmailDeliveryJob.Status.RETRY,
        ],
    ).update(
        status=EmailDeliveryJob.Status.CANCELED,
        last_error="Authentication challenge expired before delivery.",
        locked_at=None,
        lock_token=None,
        updated_at=now,
    )
    TemporaryEventSession = apps.get_model("scheduling", "TemporaryEventSession")
    deleted_temp_sessions = TemporaryEventSession.objects.filter(
        Q(expires_at__lt=session_cutoff)
        | Q(revoked_at__isnull=False, revoked_at__lt=session_cutoff)
    ).delete()[0]
    deleted_tokens = OutstandingToken.objects.filter(expires_at__lte=now).delete()[0]
    return {
        "rateLimitBuckets": 0,
        "sessions": 0,
        "temporaryEventSessions": deleted_temp_sessions,
        "outstandingTokens": deleted_tokens,
        "authChallenges": expired_challenges,
        "authEmailJobs": canceled_auth_jobs,
    }


class AuthRateThrottle(BaseThrottle):
    """Stub — the AuthRateLimitBucket model has been deleted."""

    def __init__(self):
        self.retry_after = 0

    def allow_request(self, request, view):
        return True

    def wait(self):
        return self.retry_after or None
