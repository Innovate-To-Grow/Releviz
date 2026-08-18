from django.utils import timezone
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed

from apps.authn.services.security import SESSION_REFRESH_JTI_CLAIM


def _has_live_refresh_session(member, refresh_jti: str = "") -> bool:
    """Report whether the token's exact refresh session is still usable."""
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    sessions = OutstandingToken.objects.filter(
        user=member,
        expires_at__gt=timezone.now(),
        blacklistedtoken__isnull=True,
    )
    if refresh_jti:
        sessions = sessions.filter(jti=refresh_jti)
    return sessions.exists()


class SessionJWTAuthentication(JWTAuthentication):
    """Reject access tokens as soon as their exact session is revoked."""

    def get_user(self, validated_token):
        member = super().get_user(validated_token)
        # Claim-less access tokens can exist only for the old ten-minute access
        # lifetime after rollout. Keep the former any-live-session behavior for
        # that bounded compatibility window; every newly issued token is bound.
        refresh_jti = str(validated_token.get(SESSION_REFRESH_JTI_CLAIM, "") or "")
        if not _has_live_refresh_session(member, refresh_jti):
            raise AuthenticationFailed(
                "This session has been signed out.",
                code="session_revoked",
            )
        return member
