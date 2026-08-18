"""Roster listing and per-participant schedule reads."""

from rest_framework.response import Response

from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import PrivateAPIView
from .helpers import (
    error_response,
    event_for_organizer,
    page_payload,
    pagination,
    participant_for_path,
)
from .queries import (
    apply_roster_filters,
    latest_delivery_request,
    participant_summary,
    roster_queryset,
    roster_stats,
)


class RosterView(PrivateAPIView):
    def get(self, request):
        event, error = event_for_organizer(request)
        if error:
            return error
        try:
            page, page_size = pagination(request)
            queryset = apply_roster_filters(roster_queryset(event), request.query_params)
        except RosterImportError as exc:
            return error_response(exc)
        stats = roster_stats(queryset)
        offset = (page - 1) * page_size
        participants = list(
            queryset.order_by("sort_order", "created_at")[offset : offset + page_size]
        )
        return Response(
            {
                "participants": [participant_summary(item) for item in participants],
                "pagination": page_payload(
                    page=page,
                    page_size=page_size,
                    total=stats["total"],
                ),
                "stats": stats,
                "latestDeliveryRequest": latest_delivery_request(event),
            }
        )


class RosterParticipantScheduleView(PrivateAPIView):
    def get(self, request, participant_id):
        event, error = event_for_organizer(request)
        if error:
            return error
        participant = participant_for_path(event, participant_id)
        if participant is None:
            return Response({"error": "Participant not found"}, status=404)
        enriched = roster_queryset(event).get(pk=participant.pk)
        return Response(
            {
                "participant": participant_summary(enriched),
                "schedule": {
                    "availabilityInperson": participant.availability_inperson,
                    "availabilityVirtual": participant.availability_virtual,
                    "submitted": participant.submitted,
                    "version": participant.version,
                },
            }
        )
