"""Send manual availability reminders."""

import uuid

from rest_framework.exceptions import Throttled
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.security import AuthRateThrottle, consume_request_rate_limit
from apps.mail.models import EmailDeliveryRequest
from apps.mail.services import email_delivery_summary
from apps.scheduling.models import Event
from apps.scheduling.payloads import email_delivery_request_payload
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.invitations import (
    EventEmailRequestError,
    enqueue_manual_reminders,
)


class EventRemindersView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthRateThrottle]
    auth_rate_scope = "reminder_request"
    auth_rate_methods = {"POST"}

    def get_auth_rate_identity(self, request):
        return str(request.user.pk)

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can send reminders"}, status=403)
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)

        recipient_count = (
            event.invitations.filter(first_sent_at__isnull=False)
            .exclude(status="submitted")
            .count()
            if event.reminders_enabled
            else 0
        )
        is_replay = EmailDeliveryRequest.objects.filter(
            event=event,
            operation=EmailDeliveryRequest.Operation.REMINDER,
            idempotency_key=idempotency_key,
        ).exists()
        if recipient_count and not is_replay:
            quota = consume_request_rate_limit(
                "reminder_recipient",
                request,
                str(request.user.pk),
                cost=recipient_count,
            )
            if not quota.allowed:
                raise Throttled(wait=quota.retry_after)

        try:
            result = enqueue_manual_reminders(
                event=event,
                requested_by=request.user,
                idempotency_key=idempotency_key,
            )
        except EventEmailRequestError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)

        delivery = email_delivery_summary(result["jobs"])
        recipient_count = result["request"].recipient_count
        return Response(
            {
                "sent": delivery["sent"],
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
