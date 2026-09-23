"""Send invitations to selected roster participants."""

import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from rest_framework.exceptions import Throttled
from rest_framework.response import Response

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.mail.models import EmailDeliveryRequest
from apps.scheduling.payloads import email_delivery_request_payload
from apps.scheduling.services.invitations import EventEmailRequestError, send_roster_invitations
from apps.scheduling.services.roster_imports import MAX_ROSTER_ROWS, RosterImportError

from ..helpers import PrivateAPIView
from .helpers import error_response, event_for_organizer, roster_write_error


class RosterInvitationsView(PrivateAPIView):
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "invitation_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    def post(self, request):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
                if write_error:
                    return write_error
                participant_ids = request.data.get("participantIds")
                if not isinstance(participant_ids, list) or not participant_ids:
                    raise RosterImportError("participantIds must be a non-empty array.")
                if len(participant_ids) > MAX_ROSTER_ROWS:
                    raise RosterImportError(
                        f"participantIds may contain at most {MAX_ROSTER_ROWS} entries."
                    )
                resend = request.data.get("resend", False)
                if not isinstance(resend, bool):
                    raise RosterImportError("resend must be a boolean.")
                try:
                    idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
                except (TypeError, ValueError, AttributeError) as exc:
                    raise RosterImportError("idempotencyKey must be a UUID") from exc

                is_replay = EmailDeliveryRequest.objects.filter(
                    event=event,
                    operation=EmailDeliveryRequest.Operation.INVITATION,
                    idempotency_key=idempotency_key,
                ).exists()
                if not is_replay:
                    quota = consume_request_rate_limit(
                        "invitation_recipient",
                        request,
                        str(request.user.pk),
                        cost=len(participant_ids),
                    )
                    if not quota.allowed:
                        raise Throttled(wait=quota.retry_after)

                result = send_roster_invitations(
                    event=event,
                    organizer=request.user,
                    participant_ids=participant_ids,
                    resend=resend,
                    idempotency_key=idempotency_key,
                )
        except EventEmailRequestError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)
        except (RosterImportError, ValidationError, ValueError) as exc:
            if isinstance(exc, RosterImportError):
                return error_response(exc)
            return Response({"error": "A participant id is invalid."}, status=400)
        delivery_result = result["deliveryResult"]
        return Response(
            {
                "deliveryRequest": email_delivery_request_payload(
                    delivery_result["request"],
                    jobs=delivery_result["jobs"],
                ),
                "requestedCount": result["requestedCount"],
                "queuedCount": result["queuedCount"],
                "skippedCount": result["skippedCount"],
                "idempotent": delivery_result["idempotent"],
            },
            status=202,
        )
