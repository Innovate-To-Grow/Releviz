import hashlib
import hmac
import ipaddress
import logging
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.throttling import BaseThrottle
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from apps.authn.models import AuthRateLimitBucket, AuthSession, EmailAuthChallenge
from apps.messaging.models import EmailDeliveryJob

logger = logging.getLogger("releviz.security")


def normalize_security_identity(value: str) -> str:
    return str(value or "").strip().lower()


def client_ip(request) -> str:
    trusted_proxy_count = max(int(getattr(settings, "AUTH_TRUSTED_PROXY_COUNT", 0)), 0)
    forwarded = [
        item.strip()
        for item in str(request.META.get("HTTP_X_FORWARDED_FOR", "")).split(",")
        if item.strip()
    ]
    candidate = (
        forwarded[-trusted_proxy_count]
        if trusted_proxy_count and len(forwarded) >= trusted_proxy_count
        else str(request.META.get("REMOTE_ADDR", "") or "")
    )
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


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after: int = 0


def _seconds(value, default: int) -> int:
    try:
        return max(int(value), 1)
    except (TypeError, ValueError):
        return default


def _limit_config(setting_name: str, scope: str, dimension: str):
    scopes = getattr(settings, setting_name, {})
    config = scopes.get(scope, {}).get(dimension)
    if not config:
        return None
    return {
        "limit": _seconds(config.get("limit"), 1),
        "window": _seconds(config.get("window"), 60),
        "block": _seconds(config.get("block"), _seconds(config.get("window"), 60)),
    }


@transaction.atomic
def _consume_bucket(
    *,
    scope: str,
    dimension: str,
    raw_key: str,
    config: dict,
    block_at_limit: bool,
    cost: int = 1,
) -> RateLimitDecision:
    now = timezone.now()
    key_hash = _key_hash(scope, dimension, raw_key)
    bucket, created = AuthRateLimitBucket.objects.get_or_create(
        scope=f"{scope}:{dimension}",
        key_hash=key_hash,
        defaults={"window_started_at": now},
    )
    if not created:
        bucket = AuthRateLimitBucket.objects.select_for_update().get(pk=bucket.pk)

    if bucket.blocked_until and bucket.blocked_until > now:
        decision = RateLimitDecision(
            allowed=False,
            retry_after=max(int((bucket.blocked_until - now).total_seconds()), 1),
        )
        logger.warning(
            "auth_rate_limit_blocked",
            extra={
                "auth_scope": scope,
                "auth_dimension": dimension,
                "auth_key": key_hash[:16],
                "retry_after": decision.retry_after,
            },
        )
        return decision

    window_ends = bucket.window_started_at + timedelta(seconds=config["window"])
    if window_ends <= now:
        bucket.request_count = 0
        bucket.window_started_at = now
        bucket.blocked_until = None

    bucket.request_count += max(int(cost), 1)
    threshold_reached = (
        bucket.request_count >= config["limit"]
        if block_at_limit
        else bucket.request_count > config["limit"]
    )
    if threshold_reached:
        bucket.blocked_until = now + timedelta(seconds=config["block"])
    bucket.save(
        update_fields=[
            "request_count",
            "window_started_at",
            "blocked_until",
            "updated_at",
        ]
    )
    if threshold_reached:
        logger.warning(
            "auth_rate_limit_threshold_reached",
            extra={
                "auth_scope": scope,
                "auth_dimension": dimension,
                "auth_key": key_hash[:16],
                "retry_after": config["block"],
            },
        )
        return RateLimitDecision(allowed=False, retry_after=config["block"])
    return RateLimitDecision(allowed=True)


def consume_request_rate_limit(
    scope: str,
    request,
    identity: str = "",
    *,
    cost: int = 1,
) -> RateLimitDecision:
    dimensions = [("ip", client_ip(request))]
    normalized_identity = normalize_security_identity(identity)
    if normalized_identity:
        dimensions.append(("identity", normalized_identity))

    for dimension, raw_key in dimensions:
        config = _limit_config("AUTH_RATE_LIMITS", scope, dimension)
        if config is None:
            continue
        decision = _consume_bucket(
            scope=scope,
            dimension=dimension,
            raw_key=raw_key,
            config=config,
            block_at_limit=False,
            cost=cost,
        )
        if not decision.allowed:
            return decision
    return RateLimitDecision(allowed=True)


def _failure_dimensions(email: str, request):
    normalized = normalize_security_identity(email)
    ip_value = client_ip(request)
    return [
        ("identity", normalized),
        ("pair", f"{normalized}|{ip_value}"),
    ]


def password_login_allowed(email: str, request) -> RateLimitDecision:
    now = timezone.now()
    for dimension, raw_key in _failure_dimensions(email, request):
        config = _limit_config("AUTH_FAILURE_LIMITS", "password_login", dimension)
        if config is None:
            continue
        bucket = AuthRateLimitBucket.objects.filter(
            scope=f"password_login_failure:{dimension}",
            key_hash=_key_hash("password_login_failure", dimension, raw_key),
            blocked_until__gt=now,
        ).first()
        if bucket is not None:
            return RateLimitDecision(
                allowed=False,
                retry_after=max(int((bucket.blocked_until - now).total_seconds()), 1),
            )
    return RateLimitDecision(allowed=True)


def record_password_login_failure(email: str, request) -> None:
    for dimension, raw_key in _failure_dimensions(email, request):
        config = _limit_config("AUTH_FAILURE_LIMITS", "password_login", dimension)
        if config is None:
            continue
        _consume_bucket(
            scope="password_login_failure",
            dimension=dimension,
            raw_key=raw_key,
            config=config,
            block_at_limit=True,
        )


def clear_password_login_failures(email: str, request) -> None:
    filters = []
    for dimension, raw_key in _failure_dimensions(email, request):
        filters.append(
            (
                f"password_login_failure:{dimension}",
                _key_hash("password_login_failure", dimension, raw_key),
            )
        )
    for scope, key_hash in filters:
        AuthRateLimitBucket.objects.filter(scope=scope, key_hash=key_hash).delete()


def prune_auth_security_state(*, now=None) -> dict:
    now = now or timezone.now()
    bucket_cutoff = now - settings.AUTH_RATE_LIMIT_BUCKET_RETENTION
    session_cutoff = now - settings.AUTH_SESSION_RECORD_RETENTION
    expired_challenge_ids = list(
        EmailAuthChallenge.objects.filter(
            status=EmailAuthChallenge.Status.PENDING,
            expires_at__lte=now,
        ).values_list("pk", flat=True)
    )
    expired_challenges = EmailAuthChallenge.objects.filter(pk__in=expired_challenge_ids).update(
        status=EmailAuthChallenge.Status.EXPIRED, updated_at=now
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
    deleted_buckets = AuthRateLimitBucket.objects.filter(updated_at__lt=bucket_cutoff).delete()[0]
    deleted_sessions = AuthSession.objects.filter(
        Q(expires_at__lt=session_cutoff)
        | Q(revoked_at__isnull=False, revoked_at__lt=session_cutoff)
    ).delete()[0]
    deleted_tokens = OutstandingToken.objects.filter(expires_at__lte=now).delete()[0]
    return {
        "rateLimitBuckets": deleted_buckets,
        "sessions": deleted_sessions,
        "outstandingTokens": deleted_tokens,
        "authChallenges": expired_challenges,
        "authEmailJobs": canceled_auth_jobs,
    }


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


class AuthRateThrottle(BaseThrottle):
    def __init__(self):
        self.retry_after = 0

    def allow_request(self, request, view):
        scope = getattr(view, "auth_rate_scope", "")
        if not scope:
            return True
        methods = getattr(view, "auth_rate_methods", None)
        if methods is not None and request.method not in methods:
            return True
        identity_getter = getattr(view, "get_auth_rate_identity", None)
        if callable(identity_getter):
            identity = identity_getter(request)
        else:
            identity = request.data.get("email", "") if hasattr(request, "data") else ""
        decision = consume_request_rate_limit(scope, request, identity)
        self.retry_after = decision.retry_after
        return decision.allowed

    def wait(self):
        return self.retry_after or None
