"""Shared helpers for auth API responses and refresh-session cookies."""

from django.conf import settings
from django.utils.cache import patch_vary_headers
from rest_framework import status
from rest_framework.response import Response

from apps.authn.constants import VERIFICATION_THROTTLED
from apps.authn.security import enforce_cookie_request_origin
from apps.authn.serializers import ProfileSerializer
from apps.authn.services import (
    AuthChallengeDeliveryError,
    AuthChallengeThrottled,
)
from apps.authn.services.security import issue_session_refresh_token


def _refresh_cookie_options() -> dict:
    """Return the single cookie policy shared by login, refresh, and logout."""
    return {
        "path": settings.AUTH_REFRESH_COOKIE_PATH,
        "secure": settings.AUTH_REFRESH_COOKIE_SECURE,
        "httponly": True,
        "samesite": settings.AUTH_REFRESH_COOKIE_SAMESITE,
    }


def get_refresh_token_from_request(request) -> str:
    """Read a refresh token from a legacy JSON body or the HttpOnly cookie."""
    body_token = request.data.get("refresh", "")
    if isinstance(body_token, str) and body_token.strip():
        return body_token.strip()
    cookie_token = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME, "")
    return cookie_token.strip() if isinstance(cookie_token, str) else ""


def set_refresh_cookie(response: Response, refresh_token: str) -> Response:
    """Persist a refresh token where frontend JavaScript cannot read it."""
    max_age = int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds())
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        refresh_token,
        max_age=max_age,
        **_refresh_cookie_options(),
    )
    response["Cache-Control"] = "private, no-store"
    patch_vary_headers(response, ["Cookie", "Origin"])
    return response


def clear_refresh_cookie(response: Response) -> Response:
    """Expire the refresh cookie using the same scope used when it was set."""
    response.delete_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        samesite=settings.AUTH_REFRESH_COOKIE_SAMESITE,
    )
    response["Cache-Control"] = "private, no-store"
    patch_vary_headers(response, ["Cookie", "Origin"])
    return response


def build_session_payload(member) -> dict:
    """Serialize the frontend's authenticated-session bootstrap state."""
    user = dict(ProfileSerializer(instance=member).data)
    user["is_staff"] = member.is_staff
    requires_profile_completion = bool(member.requires_profile_completion)
    return {
        "user": user,
        "next_step": "complete_profile" if requires_profile_completion else "account",
        "requires_profile_completion": requires_profile_completion,
    }


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
    resolved_next_step = next_step or (
        "complete_profile" if resolved_requires_profile_completion else "account"
    )
    refresh = issue_session_refresh_token(member)
    payload = {
        "message": message,
        "access": str(refresh.access_token),
        "refresh": str(refresh),
        **build_session_payload(member),
        "next_step": resolved_next_step,
        "requires_profile_completion": resolved_requires_profile_completion,
    }
    return payload


def auth_success_response(
    payload: dict,
    *,
    request=None,
    response_status=status.HTTP_200_OK,
) -> Response:
    """Return an auth payload while moving its refresh token into an HttpOnly cookie."""
    if request is not None:
        enforce_cookie_request_origin(request)
    response_payload = dict(payload)
    refresh_token = response_payload.pop("refresh")
    response = Response(response_payload, status=response_status)
    return set_refresh_cookie(response, refresh_token)


def challenge_error_response(exc: Exception) -> Response:
    if isinstance(exc, AuthChallengeThrottled):
        return Response(
            {"detail": VERIFICATION_THROTTLED}, status=status.HTTP_429_TOO_MANY_REQUESTS
        )
    if isinstance(exc, AuthChallengeDeliveryError):
        return Response(
            {"detail": "Failed to send verification email."},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    raise exc
