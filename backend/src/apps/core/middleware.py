"""Request correlation and privacy-safe request telemetry."""

import logging
import time
import uuid

from django.conf import settings

from apps.core.logging import request_id_context

logger = logging.getLogger("releviz.requests")

ALB_HEALTH_CHECK_USER_AGENT = "ELB-HealthChecker/2.0"
ALB_HEALTH_CHECK_PATHS = frozenset(
    {
        "/api/health",
        "/api/health/live",
        "/api/health/ready",
    }
)


class AlbHealthCheckHostMiddleware:
    """Normalize only ALB health probes before Django validates the Host header.

    Application Load Balancer probes IP targets with the target's private IP in
    ``Host`` and over the target group's HTTP connection. Production must keep
    a strict ``ALLOWED_HOSTS`` list and HTTPS redirects for normal requests, so
    only the ALB's exact user agent on the public health endpoints is normalized.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        is_alb_probe = (
            request.path in ALB_HEALTH_CHECK_PATHS
            and request.META.get("HTTP_USER_AGENT") == ALB_HEALTH_CHECK_USER_AGENT
        )
        if is_alb_probe:
            canonical_host = next(
                (
                    host
                    for host in settings.ALLOWED_HOSTS
                    if host and host != "*" and not host.startswith(".")
                ),
                "",
            )
            if canonical_host:
                request.META["HTTP_HOST"] = canonical_host
                request.META["HTTP_X_FORWARDED_PROTO"] = "https"
        return self.get_response(request)


def _request_id(request) -> str:
    candidate = request.headers.get("X-Request-ID", "")
    try:
        return str(uuid.UUID(candidate))
    except (ValueError, AttributeError):
        return str(uuid.uuid4())


def _route(request) -> str:
    match = getattr(request, "resolver_match", None)
    route = getattr(match, "route", None)
    if route is None:
        return "<unresolved>"
    return f"/{route}" if route else "/"


class RequestObservabilityMiddleware:
    """Correlate requests without logging URLs, bodies, headers, or identities."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = _request_id(request)
        request.request_id = request_id
        context_token = request_id_context.set(request_id)
        started_at = time.monotonic()
        try:
            response = self.get_response(request)
            response["X-Request-ID"] = request_id
            status_code = response.status_code
            level = logging.ERROR if status_code >= 500 else logging.INFO
            logger.log(
                level,
                "request_completed",
                extra={
                    "method": request.method,
                    "path": _route(request),
                    "status_code": status_code,
                    "duration_ms": round((time.monotonic() - started_at) * 1000, 3),
                },
            )
            return response
        finally:
            request_id_context.reset(context_token)

    def process_exception(self, request, exception):
        logger.error(
            "request_exception",
            extra={
                "method": request.method,
                "path": _route(request),
                "exception_type": type(exception).__name__,
            },
            exc_info=(type(exception), exception, exception.__traceback__),
        )
        return None
