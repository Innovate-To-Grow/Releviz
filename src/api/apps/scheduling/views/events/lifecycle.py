"""Move an event between lifecycle statuses."""

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.mail.models import EmailDeliveryRequest
from apps.scheduling.models import Event
from apps.scheduling.payloads import api_event
from apps.scheduling.services.email_previews import final_cancellation_preview
from apps.scheduling.services.events import LifecycleError, transition_error, transition_event
from apps.scheduling.services.finalization import cancel_active_final_meeting
from apps.scheduling.services.invitations.previews import no_email_preview

from ..helpers import private_response


def _requested_deadline(data, event):
    """The response deadline a lifecycle request asks for, and an error response if malformed.

    Without ``responseDeadline`` the event keeps its own; blank clears it.
    """

    if "responseDeadline" not in data:
        return event.response_deadline, None
    raw_deadline = data.get("responseDeadline")
    if raw_deadline is None or raw_deadline == "":
        return None, None
    deadline = parse_datetime(str(raw_deadline))
    if deadline is None:
        return None, Response({"error": "responseDeadline must be an ISO datetime"}, status=400)
    if timezone.is_naive(deadline):
        deadline = timezone.make_aware(deadline)
    return deadline, None


class EventLifecyclePreviewView(APIView):
    """What a lifecycle change would email, without making it.

    Only reopening a finalized event emails anyone: everyone the confirmed
    meeting's invitation may have reached is told it is canceled.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can change event lifecycle"},
                status=403,
            )
        target_status = str(request.data.get("status") or "").strip()
        deadline, error = _requested_deadline(request.data, event)
        if error:
            return error
        refusal = transition_error(event, target_status, response_deadline=deadline)
        if refusal:
            return private_response({"error": refusal}, status=409)
        reopens = target_status == Event.Status.ACTIVE and event.status != Event.Status.ACTIVE
        cancellation = (
            final_cancellation_preview(event)
            if reopens
            else {"recipientCount": 0, **no_email_preview()}
        )
        return private_response({"cancellation": cancellation})


class EventLifecycleView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can change event lifecycle"},
                status=403,
            )

        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return Response({"error": "expectedVersion is required"}, status=428)

        target_status = str(request.data.get("status") or "").strip()
        deadline, error = _requested_deadline(request.data, event)
        if error:
            return error

        if event.version != expected_version:
            if target_status == event.status and deadline == event.response_deadline:
                return private_response({"event": api_event(event)})
            return private_response(
                {
                    "error": "The event changed in another session. Refresh and try again.",
                    "event": api_event(event),
                },
                status=409,
            )

        if target_status != event.status and target_status != Event.Status.ACTIVE:
            # Wait for in-flight participant writes before closing or archiving.
            # Response writes lock only their own Participant row at scale.
            list(event.participants.select_for_update().order_by("pk").values_list("pk", flat=True))

        try:
            changed_fields = transition_event(
                event,
                target_status,
                response_deadline=deadline,
            )
        except LifecycleError as exc:
            return Response({"error": str(exc)}, status=400)
        if changed_fields:
            event.save(update_fields=changed_fields)
        cancellation_jobs = []
        cancellation_request = None
        if target_status == Event.Status.ACTIVE and "status" in changed_fields:
            cancellations = EmailDeliveryRequest.objects.filter(
                event=event,
                operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
            )
            # Report only the request this reactivation creates. An earlier
            # cancellation's request stays on the event, and handing it back
            # would show a stale delivery for a reactivation that canceled nothing.
            earlier_ids = list(cancellations.values_list("pk", flat=True))
            cancellation_jobs = cancel_active_final_meeting(event)
            cancellation_request = (
                cancellations.exclude(pk__in=earlier_ids).order_by("-created_at").first()
            )
        return private_response(
            {
                "event": api_event(event),
                "cancellationEnqueued": len(cancellation_jobs),
                "cancellationDeliveryRequestId": (
                    str(cancellation_request.pk) if cancellation_request else None
                ),
            },
            status=202 if cancellation_request else 200,
        )
