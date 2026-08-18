"""Response helpers shared by the scheduling API views."""

from django.contrib.auth import get_user_model
from django.utils import timezone
from django.utils.cache import patch_cache_control, patch_vary_headers
from django.utils.dateparse import parse_datetime
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event, ScheduleEditRecord
from apps.scheduling.payloads import api_event, api_participant


class PrivateAPIView(APIView):
    """Authenticated view whose responses are never cached or shared."""

    permission_classes = [IsAuthenticated]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        patch_cache_control(response, private=True, no_store=True)
        patch_vary_headers(response, ["Authorization"])
        return response


def current_member_access_level(member_id) -> str:
    """Read committed account state without joining it into a row-lock query."""

    Member = get_user_model()
    return Member.objects.values_list("access_level", flat=True).get(pk=member_id)


def private_response(data, *, status=200):
    response = Response(data, status=status)
    patch_cache_control(response, private=True, no_store=True)
    patch_vary_headers(response, ["Authorization"])
    return response


def temp_private_response(data=None, *, status=200):
    response = Response(data, status=status)
    patch_cache_control(response, private=True, no_store=True)
    patch_vary_headers(response, ["Cookie", "Origin"])
    return response


def organizer_participant_payload(participant, event):
    invitation = (
        event.invitations.filter(member_id=participant.member_id).order_by("-created_at").first()
    )
    return api_participant(
        participant,
        organizer_private=True,
        invitation=invitation,
    )


def organizer_response_write_error(event) -> str | None:
    """Organizers may fill temporary schedules outside the participant deadline."""

    if event.status != Event.Status.ACTIVE:
        return f"Organizer-entered responses cannot change while the event is {event.status}."
    if hasattr(event, "final_meeting") and event.final_meeting.active:
        return "Reopen the event before changing an organizer-entered response."
    return None


def record_schedule_edit(*, event, participant, actor, source, was_submitted: bool) -> None:
    if participant.submitted:
        action = ScheduleEditRecord.Action.SUBMIT
    elif was_submitted:
        action = ScheduleEditRecord.Action.WITHDRAW
    else:
        action = ScheduleEditRecord.Action.DRAFT
    actor_identifier = getattr(actor, "pk", None)
    actor_reference = None if getattr(actor, "access_level", None) == "temporary" else actor
    ScheduleEditRecord.objects.create(
        event=event,
        participant=participant,
        actor=actor_reference,
        actor_identifier=actor_identifier,
        source=source,
        action=action,
        participant_version=participant.version,
    )


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


def event_management_error_response(exc):
    payload = {"error": str(exc), **exc.extra}
    if exc.event is not None:
        payload["event"] = api_event(exc.event)
    return private_response(payload, status=exc.status_code)
