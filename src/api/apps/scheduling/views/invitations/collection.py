"""List and send event invitations."""

import uuid

from django.conf import settings
from rest_framework.exceptions import Throttled
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.mail.models import EmailDeliveryRequest
from apps.mail.services import email_delivery_summary
from apps.scheduling.models import Event
from apps.scheduling.payloads import api_invitation, email_delivery_request_payload
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    split_invitation_emails,
    upsert_and_send_invitations,
)

from ..helpers import private_response


class EventInvitationsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "invitation_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    def _event_for_organizer(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return None, Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return None, Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return None, Response(
                {"error": "Only the organizer can manage invitations"},
                status=403,
            )
        return event, None

    def get(self, request):
        event, error = self._event_for_organizer(request)
        if error:
            return error
        invitations = event.invitations.select_related("member").all()
        return private_response(
            {"invitations": [api_invitation(invitation) for invitation in invitations]}
        )

    def post(self, request):
        event, error = self._event_for_organizer(request)
        if error:
            return error
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)
        emails, invalid = split_invitation_emails(request.data.get("emails", []))
        if invalid:
            return Response({"error": f"Invalid email address: {invalid[0]}"}, status=400)
        if not emails:
            return Response({"error": "At least one email address is required"}, status=400)
        if len(emails) > settings.INVITATION_MAX_BATCH_SIZE:
            return Response(
                {
                    "error": (
                        "Too many invitation recipients; "
                        f"send at most {settings.INVITATION_MAX_BATCH_SIZE} at once."
                    )
                },
                status=400,
            )
        message = str(request.data.get("message", "") or "").strip()
        if len(message) > 1000:
            return Response({"error": "message is too long (max 1000)"}, status=400)

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
                cost=len(emails),
            )
            if not quota.allowed:
                raise Throttled(wait=quota.retry_after)

        try:
            result = upsert_and_send_invitations(
                event=event,
                emails=emails,
                invited_by=request.user,
                idempotency_key=idempotency_key,
                message=message,
            )
        except EventEmailRequestError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)

        delivery = email_delivery_summary(result["jobs"])
        recipient_count = result["request"].recipient_count
        return Response(
            {
                "invitations": [api_invitation(invitation) for invitation in result["invitations"]],
                "delivery": delivery,
                "recipientCount": recipient_count,
                "enqueued": result["createdJobCount"],
                "deduplicated": recipient_count - result["createdJobCount"],
                "idempotent": result["idempotent"],
                "deliveryRequestId": str(result["request"].pk),
                "deliveryRequest": email_delivery_request_payload(
                    result["request"],
                    jobs=result["jobs"],
                ),
            },
            status=202,
        )
