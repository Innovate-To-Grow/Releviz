"""Restore a hidden participant."""

from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event
from apps.scheduling.payloads import api_participant
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.results import request_event_results_recompute


class ParticipantUnhideView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def put(self, request):
        code = request.query_params.get("code", "")
        participant_id = request.query_params.get("participantId", "")
        if not code or not participant_id:
            return Response({"error": "code and participantId are required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if event.organizer_id != request.user.pk:
            return Response({"error": "Only the organizer can unhide participants"}, status=403)
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)
        participant = (
            event.participants.select_related("event", "member")
            .filter(member_id=participant_id)
            .first()
        )
        if participant is None:
            return Response({"error": "Participant not found"}, status=404)
        participant.hidden = False
        participant.version += 1
        participant.save(update_fields=["hidden", "version", "updated_at"])
        request_event_results_recompute(event)
        return Response({"participant": api_participant(participant)})
