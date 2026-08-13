"""Manage the authenticated member's outstanding refresh sessions."""

from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.authn.security import enforce_cookie_request_origin, request_user_agent

from ..helpers import clear_refresh_cookie, get_refresh_token_from_request


def _current_refresh_jti(request) -> str:
    refresh = get_refresh_token_from_request(request)
    if not refresh:
        return ""
    try:
        return str(RefreshToken(refresh, verify=False).get("jti", ""))
    except Exception:  # noqa: BLE001 - an invalid cookie simply is not current
        return ""


def _live_tokens(member):
    return OutstandingToken.objects.filter(
        user=member,
        expires_at__gt=timezone.now(),
        blacklistedtoken__isnull=True,
    ).order_by("-created_at", "-pk")


class AuthSessionsView(APIView):
    """List or revoke JWT refresh sessions owned by the current member."""

    permission_classes = [IsAuthenticated]

    # noinspection PyMethodMayBeStatic
    def get(self, request):
        current_jti = _current_refresh_jti(request)
        current_agent = request_user_agent(request)
        sessions = [
            {
                "id": str(token.pk),
                "current": token.jti == current_jti,
                "userAgent": current_agent if token.jti == current_jti else "Releviz session",
                "lastSeenAt": token.created_at or token.expires_at,
                "ipAddress": "",
            }
            for token in _live_tokens(request.user)
        ]
        return Response({"sessions": sessions}, status=status.HTTP_200_OK)

    def delete(self, request):
        enforce_cookie_request_origin(request)
        current_jti = _current_refresh_jti(request)
        revoke_all = request.data.get("all") is True
        session_id = str(request.data.get("sessionId", "")).strip()

        tokens = _live_tokens(request.user)
        if not revoke_all:
            if not session_id.isdigit():
                return Response(
                    {"detail": "A valid session ID is required."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            tokens = tokens.filter(pk=int(session_id))

        selected = list(tokens)
        if not revoke_all and not selected:
            return Response(
                {"detail": "Session was not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        current_revoked = revoke_all or any(token.jti == current_jti for token in selected)
        for token in selected:
            BlacklistedToken.objects.get_or_create(token=token)

        response = Response(
            {"revoked": len(selected), "currentRevoked": current_revoked},
            status=status.HTTP_200_OK,
        )
        return clear_refresh_cookie(response) if current_revoked else response
