"""Event CRUD, duplication, lifecycle transitions, and the organizer dashboard."""

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.mail.models import EmailDeliveryRequest
from apps.scheduling.models import Event, UserEvent
from apps.scheduling.permissions import can_access_event
from apps.scheduling.serializers import api_event
from apps.scheduling.services.event_management import (
    EventManagementError,
    create_event,
    delete_event,
    duplicate_event,
    update_event,
)
from apps.scheduling.services.finalization import cancel_active_final_meeting
from apps.scheduling.services.lifecycle import LifecycleError, transition_event
from apps.scheduling.views.helpers import private_response


def event_management_error_response(exc):
    payload = {"error": str(exc), **exc.extra}
    if exc.event is not None:
        payload["event"] = api_event(exc.event)
    return private_response(payload, status=exc.status_code)


class EventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_related("final_meeting").filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_access_event(event, request.user):
            return Response({"error": "Event not found"}, status=404)
        return private_response({"event": api_event(event)})

    def post(self, request):
        try:
            event = create_event(organizer=request.user, data=request.data)
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response({"event": api_event(event)}, status=201)

    def put(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = update_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "event": api_event(result.event),
                "responsesReset": result.responses_reset,
                "idempotent": result.idempotent,
            }
        )

    def delete(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = delete_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "deletedCode": result.code,
                "idempotent": result.idempotent,
            }
        )


class EventDuplicateView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        try:
            result = duplicate_event(
                organizer=request.user,
                code=code,
                data=request.data,
            )
        except EventManagementError as exc:
            return event_management_error_response(exc)
        return private_response(
            {
                "event": api_event(result.event),
                "idempotent": result.idempotent,
            },
            status=200 if result.idempotent else 201,
        )


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
        deadline = event.response_deadline
        if "responseDeadline" in request.data:
            raw_deadline = request.data.get("responseDeadline")
            if raw_deadline is None or raw_deadline == "":
                deadline = None
            else:
                deadline = parse_datetime(str(raw_deadline))
                if deadline is None:
                    return Response(
                        {"error": "responseDeadline must be an ISO datetime"},
                        status=400,
                    )
                if timezone.is_naive(deadline):
                    deadline = timezone.make_aware(deadline)

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
            cancellation_jobs = cancel_active_final_meeting(event)
            cancellation_request = (
                EmailDeliveryRequest.objects.filter(
                    event=event,
                    operation=EmailDeliveryRequest.Operation.FINAL_CANCELLATION,
                )
                .order_by("-created_at")
                .first()
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


class DashboardEventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        links = UserEvent.objects.select_related("event").filter(member=request.user)
        organized = []
        participating = []
        for link in links:
            if link.role == "organizer":
                organized.append(api_event(link.event, include_slot_groups=False))
            else:
                participating.append(api_event(link.event, include_slot_groups=False))
        return Response({"organized": organized, "participating": participating})
