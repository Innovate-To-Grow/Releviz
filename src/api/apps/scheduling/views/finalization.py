"""Preview, confirm, and download the calendar invite for the final meeting time."""

import uuid

from django.http import HttpResponse
from django.utils import timezone
from django.utils.cache import patch_cache_control, patch_vary_headers
from django.utils.dateparse import parse_datetime
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authn.models import ContactEmail
from apps.scheduling.models import Event
from apps.scheduling.serializers import api_event, api_final_meeting
from apps.scheduling.services.calendar import final_meeting_ics
from apps.scheduling.services.finalization import (
    FinalizationError,
    build_attendance_review,
    confirm_final_meeting,
    final_delivery_summary,
    normalize_final_time,
)
from apps.scheduling.views.helpers import private_response


def parse_aware_timestamp(value, label: str):
    if not isinstance(value, str):
        return None, Response({"error": f"{label} must be an ISO datetime"}, status=400)
    parsed = parse_datetime(value)
    if parsed is None:
        return None, Response({"error": f"{label} must be an ISO datetime"}, status=400)
    if timezone.is_naive(parsed):
        return None, Response(
            {"error": f"{label} must include an explicit UTC offset"},
            status=400,
        )
    return parsed, None


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


class EventFinalCalendarView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        member_emails = ContactEmail.objects.filter(
            member=request.user,
            verified=True,
        ).values_list("email_address", flat=True)
        authorized = (
            event.organizer_id == request.user.pk
            or event.participants.filter(member=request.user, hidden=False).exists()
            or event.invitations.filter(member=request.user).exists()
            or event.invitations.filter(email__in=member_emails).exists()
        )
        if not authorized:
            return Response(
                {"error": "You do not have access to this calendar invitation"},
                status=403,
            )
        meeting = getattr(event, "final_meeting", None)
        if meeting is None or not meeting.active:
            return Response({"error": "No active final meeting has been confirmed"}, status=404)
        attachment = final_meeting_ics(event, meeting)
        response = HttpResponse(attachment.content, content_type=attachment.mimetype)
        response["Content-Disposition"] = f'attachment; filename="{attachment.filename}"'
        patch_cache_control(response, private=True, no_store=True)
        patch_vary_headers(response, ["Authorization"])
        return response
