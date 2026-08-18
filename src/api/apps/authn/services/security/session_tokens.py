"""Issue access tokens that are bound to one durable refresh session."""

from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

SESSION_REFRESH_JTI_CLAIM = "session_refresh_jti"


def issue_session_refresh_token(member) -> RefreshToken:
    """Create a refresh token whose access tokens identify this exact session."""
    refresh = RefreshToken.for_user(member)
    refresh_jti = str(refresh[api_settings.JTI_CLAIM])
    refresh[SESSION_REFRESH_JTI_CLAIM] = refresh_jti
    # ``for_user`` records the token before custom claims are added. Persist the
    # signed final form so session inspection and incident response see exactly
    # the credential that was issued.
    OutstandingToken.objects.filter(user=member, jti=refresh_jti).update(token=str(refresh))
    return refresh


def bind_access_to_refresh(access_token, refresh_token) -> str:
    """Re-sign an access token with the actual JTI of its returned refresh token."""
    refresh = RefreshToken(str(refresh_token), verify=False)
    access = AccessToken(str(access_token), verify=False)
    access[SESSION_REFRESH_JTI_CLAIM] = str(refresh[api_settings.JTI_CLAIM])
    return str(access)
