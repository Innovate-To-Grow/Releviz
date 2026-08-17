"""Read the published result snapshot for an event."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.permissions import can_view_event_results
from apps.scheduling.services.result_snapshots import serialize_result_snapshot
from apps.scheduling.views.helpers import private_response


class EventResultsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_view_event_results(event, request.user):
            return Response(
                {"error": "You do not have permission to view event results"},
                status=403,
            )
        return private_response(serialize_result_snapshot(event))
