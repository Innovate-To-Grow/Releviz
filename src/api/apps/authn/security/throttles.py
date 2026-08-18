"""Database-backed throttle classes for authentication endpoints."""

from rest_framework.throttling import BaseThrottle

from .helpers import consume_request_rate_limit


class DurableAuthThrottle(BaseThrottle):
    """Apply a shared limiter across every web and worker process."""

    scope = ""

    def __init__(self):
        self.retry_after = 0

    def get_identity(self, request) -> str:
        user = getattr(request, "user", None)
        if user is not None and getattr(user, "is_authenticated", False):
            return str(user.pk)
        data = request.data if hasattr(request, "data") else {}
        return str(data.get("identifier") or data.get("email") or "")

    def allow_request(self, request, view):
        scope = getattr(view, "auth_rate_scope", self.scope)
        if not scope:
            return True
        decision = consume_request_rate_limit(
            scope,
            request,
            self.get_identity(request),
        )
        self.retry_after = decision.retry_after
        return decision.allowed

    def wait(self):
        return self.retry_after or None


class ContactEmailCreateThrottle(DurableAuthThrottle):
    """Throttle creation of contact email addresses per IP and member."""

    scope = "contact_email_create"


class LoginRateThrottle(DurableAuthThrottle):
    """Throttle password and token-exchange login endpoints."""

    scope = "password_login"


class EmailCodeRequestThrottle(DurableAuthThrottle):
    """Throttle verification-code delivery by IP and target/member."""

    scope = "code_request"


class EmailCodeVerifyThrottle(DurableAuthThrottle):
    """Throttle verification-code attempts by IP and target/member."""

    scope = "code_verify"


class EmailCodeUserRequestThrottle(EmailCodeRequestThrottle):
    """Authenticated form of the durable code-request throttle."""
