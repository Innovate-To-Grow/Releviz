"""Exchange an admin-issued impersonation token for JWT credentials."""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.models import ImpersonationToken
from apps.authn.security import enforce_cookie_request_origin
from apps.authn.security.throttles import LoginRateThrottle

from ..helpers import auth_success_response, build_auth_success_payload

logger = logging.getLogger(__name__)


class ImpersonateLoginView(APIView):
    """Exchange a one-time impersonation token for JWT credentials."""

    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    # noinspection PyMethodMayBeStatic
    def post(self, request):
        enforce_cookie_request_origin(request)
        token = request.data.get("token", "").strip()
        if not token:
            return Response({"detail": "Token is required."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            impersonation = ImpersonationToken.objects.select_related("member", "created_by").get(
                token=token
            )
        except ImpersonationToken.DoesNotExist:
            return Response(
                {"detail": "Invalid impersonation link."}, status=status.HTTP_400_BAD_REQUEST
            )

        if not impersonation.try_mark_used():
            impersonation.refresh_from_db(fields=["is_used", "expires_at"])
            detail = (
                "This impersonation link has already been used."
                if impersonation.is_used
                else "This impersonation link has expired."
            )
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

        logger.info(
            "Admin %s (%s) impersonated member %s (%s)",
            impersonation.created_by.id,
            impersonation.created_by.get_primary_email(),
            impersonation.member.id,
            impersonation.member.get_primary_email(),
        )

        payload = build_auth_success_payload(
            impersonation.member, "Impersonation login successful."
        )
        return auth_success_response(
            payload,
            request=request,
            response_status=status.HTTP_200_OK,
        )
