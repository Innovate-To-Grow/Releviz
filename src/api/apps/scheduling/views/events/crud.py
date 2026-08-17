"""Read, create, update, duplicate, and delete events."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.payloads import api_event
from apps.scheduling.permissions import can_access_event
from apps.scheduling.services.events import (
    EventManagementError,
    create_event,
    delete_event,
    duplicate_event,
    update_event,
)

from ..helpers import event_management_error_response, private_response


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
