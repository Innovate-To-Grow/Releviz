import uuid

from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication

from apps.authn.models import AuthSession


class SessionJWTAuthentication(JWTAuthentication):
    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        raw_session_id = validated_token.get("session_id")
        try:
            session_id = uuid.UUID(str(raw_session_id))
        except (TypeError, ValueError, AttributeError) as exc:
            raise AuthenticationFailed("Session is invalid.", code="session_invalid") from exc

        session_exists = AuthSession.objects.filter(
            pk=session_id,
            member=user,
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
        ).exists()
        if not session_exists:
            raise AuthenticationFailed("Session is no longer active.", code="session_revoked")
        return user
