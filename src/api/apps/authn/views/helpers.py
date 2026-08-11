"""
Shared helpers for auth API responses.
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.constants import VERIFICATION_THROTTLED
from apps.authn.services import (
    AuthChallengeDeliveryError,
    AuthChallengeThrottled,
    PhoneVerificationDeliveryError,
    PhoneVerificationThrottled,
)


def build_auth_success_payload(
    member,
    message: str,
    *,
    next_step: str | None = None,
    requires_profile_completion: bool | None = None,
) -> dict:
    resolved_requires_profile_completion = (
        bool(requires_profile_completion)
        if requires_profile_completion is not None
        else bool(getattr(member, "requires_profile_completion", False))
    )
    resolved_next_step = next_step or ("complete_profile" if resolved_requires_profile_completion else "account")
    refresh = RefreshToken.for_user(member)
    payload = {
        "message": message,
        "access": str(refresh.access_token),
        "refresh": str(refresh),
        "user": {
            "member_uuid": str(member.member_uuid),
            "email": member.get_primary_email(),
            "phone": member.get_primary_phone(),
            "is_staff": member.is_staff,
        },
        "next_step": resolved_next_step,
        "requires_profile_completion": resolved_requires_profile_completion,
    }
    return payload


def challenge_error_response(exc: Exception) -> Response:
    if isinstance(exc, AuthChallengeThrottled):
        return Response({"detail": VERIFICATION_THROTTLED}, status=status.HTTP_429_TOO_MANY_REQUESTS)
    if isinstance(exc, AuthChallengeDeliveryError):
        return Response({"detail": "Failed to send verification email."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    if isinstance(exc, PhoneVerificationThrottled):
        return Response({"detail": VERIFICATION_THROTTLED}, status=status.HTTP_429_TOO_MANY_REQUESTS)
    if isinstance(exc, PhoneVerificationDeliveryError):
        return Response({"detail": "Failed to send verification SMS."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    raise exc
