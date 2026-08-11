"""
Custom throttle classes for auth endpoints.
"""

from rest_framework.throttling import AnonRateThrottle, UserRateThrottle


class ContactEmailCreateThrottle(UserRateThrottle):
    """Throttle for adding contact emails: 5 requests per hour."""

    scope = "contact_email_create"


class LoginRateThrottle(AnonRateThrottle):
    """Throttle for login endpoints: 10 requests per minute."""

    scope = "login"


class EmailCodeRequestThrottle(AnonRateThrottle):
    """Throttle for verification code request endpoints."""

    scope = "email_code_request"


class EmailCodeVerifyThrottle(AnonRateThrottle):
    """Throttle for verification code and token confirmation endpoints."""

    scope = "email_code_verify"


class PhoneCodeRequestThrottle(UserRateThrottle):
    """Per-authenticated-user cap on SMS verification-code sends.

    Each send spends real AWS SNS budget on a caller-supplied destination, and
    the service-level cap is per destination number (bypassable by rotating
    numbers). An ``AnonRateThrottle`` is a no-op for authenticated callers, so a
    ``UserRateThrottle`` is required to bound toll-fraud / SMS pumping.
    """

    scope = "phone_code_request"


class PhoneAuthCodeRequestThrottle(AnonRateThrottle):
    """Per-IP cap on the PUBLIC passwordless phone-auth SMS request endpoint.

    Each request can spend real AWS SNS budget on a caller-supplied destination.
    The service-level cap in ``sns_verify`` is per destination number (bypassable
    by rotating numbers), and ``PhoneCodeRequestThrottle`` is a ``UserRateThrottle``
    that is a no-op for the anonymous callers this endpoint serves — so a dedicated
    anon (per-IP) throttle is required to bound toll-fraud / SMS pumping.
    """

    scope = "phone_auth_code_request"


class EmailCodeUserRequestThrottle(UserRateThrottle):
    """Per-authenticated-user cap on email verification-code sends.

    The shared ``EmailCodeRequestThrottle`` is an ``AnonRateThrottle`` whose key
    is ``None`` for authenticated requests, so on an ``IsAuthenticated`` resend
    endpoint it never throttles — letting a logged-in caller bomb an
    attacker-supplied address (and burn SES budget). This per-user throttle
    actually applies.
    """

    scope = "email_code_user_request"
