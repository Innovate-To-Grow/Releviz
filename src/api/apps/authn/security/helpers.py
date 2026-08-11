"""
Security utility functions extracted from the old security.py.

Rate-limiting functions that depend on the (deleted) AuthRateLimitBucket model
are no-ops. Restore that model before re-enabling rate limiting.
"""

import hashlib
import hmac
import ipaddress
import logging
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


class AuthRateThrottle(BaseThrottle):
    """Stub — the AuthRateLimitBucket model has been deleted."""

    def __init__(self):
        self.retry_after = 0

    def allow_request(self, request, view):
        return True

    def wait(self):
        return self.retry_after or None
