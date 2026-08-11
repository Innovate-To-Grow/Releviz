"""Normalize ALB health check probe Host headers for ALLOWED_HOSTS validation."""

from django.conf import settings

ALB_HEALTH_CHECK_USER_AGENT = "ELB-HealthChecker/2.0"
ALB_HEALTH_CHECK_PATHS = frozenset(
    {
        "/health",
        "/health/live",
        "/health/ready",
    }
)
LEGACY_ALB_HEALTH_CHECK_PATHS = frozenset(f"/api{path}" for path in ALB_HEALTH_CHECK_PATHS)


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
        is_health_check_path = request.path in ALB_HEALTH_CHECK_PATHS or (
            settings.ENABLE_LEGACY_API_PREFIX and request.path in LEGACY_ALB_HEALTH_CHECK_PATHS
        )
        is_alb_probe = (
            is_health_check_path
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
