"""List event participants and join an event."""

from django.conf import settings
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event, Participant, UserEvent
from apps.scheduling.payloads import api_participant
from apps.scheduling.permissions import can_join_event, visible_participants_for_user
from apps.scheduling.services.availability import default_availability
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.invitations import mark_invitation_for_member
from apps.scheduling.services.results import mark_event_results_dirty
from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import private_response
from ..roster.helpers import page_payload, pagination
from ..roster.queries import apply_roster_filters, participant_summary, roster_queryset


class ParticipantsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        include_hidden = (
            request.query_params.get("includeHidden") == "true"
            and event.organizer_id == request.user.pk
        )
        participants = visible_participants_for_user(
            event,
            request.user,
            include_hidden=include_hidden,
        )
        if participants is None:
            return Response(
                {"error": "You must join this event before viewing participants"},
                status=403,
            )
        is_organizer = event.organizer_id == request.user.pk
        if is_organizer:
            try:
                page, page_size = pagination(request)
                roster = roster_queryset(event)
                if not include_hidden:
                    roster = roster.filter(hidden=False)
                roster = apply_roster_filters(roster, request.query_params)
            except RosterImportError as exc:
                return Response({"error": str(exc)}, status=exc.status_code)
            total = roster.count()
            offset = (page - 1) * page_size
            return private_response(
                {
                    "participants": [
                        participant_summary(participant)
                        for participant in roster[offset : offset + page_size]
                    ],
                    "pagination": page_payload(
                        page=page,
                        page_size=page_size,
                        total=total,
                    ),
                    "scheduleDataIncluded": False,
                }
            )
        own_participant = next(
            (
                participant
                for participant in participants
                if participant.member_id == request.user.pk
            ),
            None,
        )
        return private_response(
            {
                "participants": (
                    [api_participant(own_participant)] if own_participant is not None else []
                ),
                "scheduleDataIncluded": own_participant is not None,
            }
        )

    @transaction.atomic
    def post(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.select_for_update().filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_join_event(event, request.user):
            return Response(
                {"error": "This event is limited to invited participants"},
                status=403,
            )
        write_error = response_write_error(event)
        if write_error:
            return Response({"error": write_error}, status=409)

        participant_limit = getattr(settings, "EVENT_MAX_PARTICIPANTS", 1000)
        if (
            not event.participants.filter(member=request.user).exists()
            and event.participants.count() >= participant_limit
        ):
            return Response(
                {"error": f"This event can have at most {participant_limit} participants"},
                status=409,
            )

        name = request.user.display_name().strip()
        if not name:
            return Response({"error": "Name is required"}, status=400)
        if len(name) > 100:
            return Response({"error": "Name too long (max 100)"}, status=400)

        participant, created = Participant.objects.get_or_create(
            event=event,
            member=request.user,
            defaults={
                "participant_name": name,
                "availability_inperson": default_availability(event),
                "availability_virtual": default_availability(event),
            },
        )
        if participant.participant_name != name:
            participant.participant_name = name
            participant.save(update_fields=["participant_name", "updated_at"])

        if event.organizer_id != request.user.pk:
            UserEvent.objects.get_or_create(member=request.user, event=event, role="participant")
        mark_invitation_for_member(event=event, member=request.user)
        if created:
            mark_event_results_dirty(event)

        return Response(
            {"participant": api_participant(participant)},
            status=201 if created else 200,
        )
