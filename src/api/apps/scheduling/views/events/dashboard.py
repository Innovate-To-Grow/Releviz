"""Dashboard listing of organized and joined events."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import UserEvent
from apps.scheduling.payloads import api_event


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
