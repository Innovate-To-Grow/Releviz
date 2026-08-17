from django.utils import timezone
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed


def _has_live_refresh_session(member) -> bool:
    """Report whether *member* still owns a usable refresh session."""
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    return OutstandingToken.objects.filter(
        user=member,
        expires_at__gt=timezone.now(),
        blacklistedtoken__isnull=True,
    ).exists()


class SessionJWTAuthentication(JWTAuthentication):
    """Reject access tokens once every refresh session has been revoked.

    Access tokens are stateless and live for minutes, so blacklisting refresh
    tokens alone would leave "sign out all devices" and account deletion
    cosmetic until the access token expired. Requiring a surviving refresh
    session makes revocation take effect immediately.
    """

    def get_user(self, validated_token):
        member = super().get_user(validated_token)
        if not _has_live_refresh_session(member):
            raise AuthenticationFailed(
                "This session has been signed out.",
                code="session_revoked",
            )
        return member
