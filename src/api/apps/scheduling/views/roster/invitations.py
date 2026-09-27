"""Send invitations to selected roster participants."""

import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from rest_framework.exceptions import Throttled
from rest_framework.response import Response

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.scheduling.payloads import email_delivery_request_payload
from apps.scheduling.services.invitations import EventEmailRequestError, send_roster_invitations
from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import PrivateAPIView
from .helpers import error_response, event_for_organizer, roster_write_error
from .selectors import invitation_selection


def _flag(data, name) -> bool:
    value = data.get(name, False)
    if not isinstance(value, bool):
        raise RosterImportError(f"{name} must be a boolean.")
    return value


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
                participant_ids, roster_filter = invitation_selection(request.data)
                resend = _flag(request.data, "resend")
                if _flag(request.data, "preview"):
                    # What a send would do: the same selection and skip rules,
                    # nothing written and no recipient quota spent.
                    return Response(
                        send_roster_invitations(
                            event=event,
                            organizer=request.user,
                            participant_ids=participant_ids,
                            roster_filter=roster_filter,
                            resend=resend,
                            preview=True,
                        )
                    )
                try:
                    idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
                except (TypeError, ValueError, AttributeError) as exc:
                    raise RosterImportError("idempotencyKey must be a UUID") from exc

                def charge_recipients(count):
                    # Charged once the recipients are known, so a send that
                    # skips most of its selection costs only what it queues;
                    # a replay never reaches here.
                    quota = consume_request_rate_limit(
                        "invitation_recipient",
                        request,
                        str(request.user.pk),
                        cost=count,
                    )
                    if not quota.allowed:
                        raise Throttled(wait=quota.retry_after)

                result = send_roster_invitations(
                    event=event,
                    organizer=request.user,
                    participant_ids=participant_ids,
                    roster_filter=roster_filter,
                    resend=resend,
                    idempotency_key=idempotency_key,
                    charge_recipients=charge_recipients,
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
                "willSend": result["willSend"],
                "skipped": result["skipped"],
                "idempotent": delivery_result["idempotent"],
            },
            status=202,
        )
