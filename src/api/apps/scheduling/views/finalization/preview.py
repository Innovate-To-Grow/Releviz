"""Preview attendance for a proposed final meeting time."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.services.finalization import (
    FinalizationError,
    build_attendance_review,
    normalize_final_time,
)

from ..helpers import parse_aware_timestamp, private_response


class EventFinalizationPreviewView(APIView):
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
                {"error": "Only the organizer can review a final meeting time"},
                status=403,
            )
        if event.status not in {Event.Status.ACTIVE, Event.Status.CLOSED}:
            return Response(
                {"error": f"An event cannot be finalized while it is {event.status}."},
                status=409,
            )
        starts_at, error = parse_aware_timestamp(request.data.get("startsAt"), "startsAt")
        if error:
            return error
        ends_at, error = parse_aware_timestamp(request.data.get("endsAt"), "endsAt")
        if error:
            return error
        try:
            normalized = normalize_final_time(
                event,
                starts_at=starts_at,
                ends_at=ends_at,
                channel=str(request.data.get("channel") or "").strip(),
                location=str(request.data.get("location") or ""),
            )
        except FinalizationError as exc:
            return Response({"error": str(exc)}, status=exc.status_code)
        return private_response(
            {
                "eventVersion": event.version,
                "proposedMeeting": {
                    "startsAt": normalized["starts_at"].isoformat(),
                    "endsAt": normalized["ends_at"].isoformat(),
                    "timezone": event.timezone,
                    "channel": normalized["channel"],
                    "location": normalized["location"],
                },
                "attendance": build_attendance_review(event, normalized),
            }
        )
