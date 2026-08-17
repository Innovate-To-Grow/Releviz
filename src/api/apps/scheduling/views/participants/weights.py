"""Read participant weights."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.payloads import api_weight

from ..helpers import private_response


class WeightsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can view weights"}, status=403)
        weights = event.weights.select_related("participant", "participant__member").all()
        return private_response({"weights": [api_weight(weight) for weight in weights]})

    def put(self, request):
        return Response(
            {
                "error": (
                    "Bulk weight replacement was removed. Use PATCH /events/roster/{id} "
                    "or PATCH /events/roster/bulk."
                )
            },
            status=405,
        )
