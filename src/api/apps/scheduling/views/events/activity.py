"""Read the change digest the organizer workspace polls for new responses."""

from rest_framework.response import Response

from apps.scheduling.models import Event
from apps.scheduling.permissions import can_view_event_results
from apps.scheduling.services.activity import event_activity

from ..helpers import PrivateAPIView


class EventActivityView(PrivateAPIView):
    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_view_event_results(event, request.user):
            return Response(
                {"error": "You do not have permission to view event activity"},
                status=403,
            )
        return Response(event_activity(event))
