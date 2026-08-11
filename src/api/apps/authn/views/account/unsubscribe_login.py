"""
Auto-login view for email unsubscribe / preference management.
"""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.constants import UNSUBSCRIBE_LOGIN_ALREADY_USED, UNSUBSCRIBE_LOGIN_INVALID
from apps.authn.security.throttles import LoginRateThrottle
from apps.authn.services.account.unsubscribe import (
    UnsubscribeLoginTokenAlreadyUsed,
    UnsubscribeLoginTokenInvalid,
    get_member_from_unsubscribe_token,
)
logger = logging.getLogger(__name__)


def _send_unsubscribe_confirmation(member, event_token):
    """Best-effort confirmation email after unsubscribe."""
    logger.info(
        "Unsubscribe confirmation email skipped (mail service not available).",
        extra={"member_id": str(member.pk), "event_token": event_token},
    )


class UnsubscribeAutoLoginView(APIView):
    """Consume an unsubscribe-email token without granting an auth session."""

    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        token = request.data.get("token", "").strip()
        if not token:
            return Response({"detail": "Token is required."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            member = get_member_from_unsubscribe_token(token)
        except UnsubscribeLoginTokenAlreadyUsed:
            detail = UNSUBSCRIBE_LOGIN_ALREADY_USED
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)
        except UnsubscribeLoginTokenInvalid:
            detail = UNSUBSCRIBE_LOGIN_INVALID
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

        primary = member.get_primary_contact_email()
        if primary and primary.subscribe:
            primary.subscribe = False
            primary.save(update_fields=["subscribe"])
            _send_unsubscribe_confirmation(member, token)

        return Response(
            {"message": "You have been unsubscribed.", "unsubscribed": True},
            status=status.HTTP_200_OK,
        )
