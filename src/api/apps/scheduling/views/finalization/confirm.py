"""Read and confirm the final meeting of an event."""

import uuid

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.payloads import api_event, api_final_meeting
from apps.scheduling.services.finalization import (
    FinalizationError,
    confirm_final_meeting,
    final_delivery_summary,
)

from ..helpers import parse_aware_timestamp, private_response


class EventFinalizationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response(
                {"error": "Only the organizer can view finalization details"},
                status=403,
            )
        meeting = getattr(event, "final_meeting", None)
        if meeting is None:
            return Response({"error": "No final meeting has been confirmed"}, status=404)
        return private_response(
            {
                "event": api_event(event),
                "finalMeeting": api_final_meeting(meeting, include_attendance=True),
                "delivery": final_delivery_summary(event, meeting),
            }
        )

    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        expected_version = request.data.get("expectedVersion")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            return Response({"error": "expectedVersion is required"}, status=428)
        try:
            idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "idempotencyKey must be a UUID"}, status=400)
        starts_at, error = parse_aware_timestamp(request.data.get("startsAt"), "startsAt")
        if error:
            return error
        ends_at, error = parse_aware_timestamp(request.data.get("endsAt"), "endsAt")
        if error:
            return error

        try:
            result = confirm_final_meeting(
                event_code=code,
                organizer=request.user,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                starts_at=starts_at,
                ends_at=ends_at,
                channel=str(request.data.get("channel") or "").strip(),
                location=str(request.data.get("location") or ""),
            )
        except FinalizationError as exc:
            return private_response({"error": str(exc)}, status=exc.status_code)

        result["event"].refresh_from_db()
        result["meeting"].refresh_from_db()
        return private_response(
            {
                "event": api_event(result["event"]),
                "finalMeeting": api_final_meeting(
                    result["meeting"],
                    include_attendance=True,
                ),
                "delivery": final_delivery_summary(result["event"], result["meeting"]),
                "deliveryRequestId": str(result["deliveryRequest"].pk),
                "idempotent": result["idempotent"],
            },
            status=202,
        )
