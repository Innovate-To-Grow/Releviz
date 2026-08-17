"""Upgrade a temporary participant into a full account."""

import logging

from rest_framework.exceptions import Throttled
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView

from apps.authn.models import ContactEmail
from apps.authn.security import consume_request_rate_limit, enforce_cookie_request_origin
from apps.authn.services import start_registration
from apps.mail.services import EmailDeliveryError
from apps.scheduling.services.temporary_access import temporary_session_from_request

from ..helpers import temp_private_response
from .helpers import inactive_session_response

security_logger = logging.getLogger("releviz.security")


class TemporaryAccessUpgradeRegistrationView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        enforce_cookie_request_origin(request)
        event_code = str(request.query_params.get("code") or "").strip()
        if not event_code:
            return temp_private_response({"error": "code is required"}, status=400)

        session = temporary_session_from_request(request, event_code=event_code)
        if session is None:
            return inactive_session_response(
                request,
                event_code=event_code,
                operation="start_upgrade",
            )

        quota = consume_request_rate_limit(
            "register",
            request,
            str(session.member_id),
        )
        if not quota.allowed:
            raise Throttled(wait=quota.retry_after)

        contact = ContactEmail.objects.filter(
            member_id=session.member_id,
            email_type="primary",
            verified=False,
        ).first()
        if contact is None:
            security_logger.warning(
                "temporary_upgrade_registration_identity_unavailable",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            return temp_private_response(
                {"detail": "Unable to start registration."},
                status=409,
            )

        registration_data = request.data.copy()
        # The event-scoped session is the identity authority for an upgrade.
        # Never trust an email supplied by the browser for this operation.
        registration_data["email"] = contact.email_address
        try:
            member = start_registration(
                registration_data,
                _temporary_upgrade_member_id=session.member_id,
            )
        except DRFValidationError as exc:
            return temp_private_response(exc.detail, status=400)
        except EmailDeliveryError:
            security_logger.warning(
                "temporary_upgrade_registration_delivery_failed",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            return temp_private_response(
                {"detail": "Unable to send the verification code."},
                status=503,
            )

        if member.pk != session.member_id:
            security_logger.error(
                "temporary_upgrade_registration_identity_mismatch",
                extra={
                    "event_id": str(session.participant.event_id),
                    "member_id": str(session.member_id),
                    "temporary_session_id": str(session.pk),
                },
            )
            raise RuntimeError("Temporary upgrade registration identity mismatch.")

        security_logger.info(
            "temporary_upgrade_registration_started",
            extra={
                "event_id": str(session.participant.event_id),
                "member_id": str(session.member_id),
                "temporary_session_id": str(session.pk),
            },
        )
        return temp_private_response(
            {
                "message": "Registration started. Check your email for a verification code.",
                "requiresRegistrationDetailsOnVerify": True,
            },
            status=202,
        )
