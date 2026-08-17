"""Edit a single roster participant."""

from django.db import transaction
from rest_framework.response import Response

from apps.scheduling.models import Weight
from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import PrivateAPIView
from .helpers import (
    error_response,
    event_for_organizer,
    mark_results_dirty,
    parse_weight,
    participant_for_path,
    roster_write_error,
)
from .queries import boolean_query, participant_summary, roster_queryset


class RosterParticipantView(PrivateAPIView):
    def patch(self, request, participant_id):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
                if write_error:
                    return write_error
                participant = participant_for_path(event, participant_id, lock=True)
                if participant is None:
                    return Response({"error": "Participant not found"}, status=404)
                expected_version = request.data.get("expectedVersion")
                if isinstance(expected_version, bool) or not isinstance(expected_version, int):
                    return Response({"error": "expectedVersion is required"}, status=428)
                if participant.version != expected_version:
                    enriched = roster_queryset(event).get(pk=participant.pk)
                    return Response(
                        {
                            "error": "The participant changed in another session.",
                            "participant": participant_summary(enriched),
                        },
                        status=409,
                    )

                changed = False
                if "name" in request.data:
                    name = str(request.data.get("name") or "").strip()
                    if not name:
                        raise RosterImportError("name is required.")
                    if len(name) > 100:
                        raise RosterImportError("name is too long (max 100).")
                    if participant.participant_name != name:
                        participant.participant_name = name
                        changed = True
                if "group" in request.data or "groupName" in request.data:
                    group_name = str(
                        request.data.get("group", request.data.get("groupName")) or ""
                    ).strip()
                    if len(group_name) > 100:
                        raise RosterImportError("group is too long (max 100).")
                    normalized_group = group_name or None
                    if participant.group_name != normalized_group:
                        participant.group_name = normalized_group
                        changed = True

                weight = (
                    Weight.objects.select_for_update()
                    .filter(
                        event=event,
                        participant=participant,
                    )
                    .first()
                )
                weight_changed = False
                if "weight" in request.data or "included" in request.data:
                    if weight is None:
                        weight = Weight(event=event, participant=participant)
                    new_weight = (
                        parse_weight(request.data.get("weight"))
                        if "weight" in request.data
                        else float(weight.weight)
                    )
                    new_included = (
                        boolean_query(request.data.get("included"), "included")
                        if "included" in request.data
                        else bool(weight.included)
                    )
                    weight_changed = (
                        weight.pk is None
                        or float(weight.weight) != new_weight
                        or weight.included != new_included
                    )
                    if weight_changed:
                        weight.weight = new_weight
                        weight.included = new_included
                        weight.save()

                if changed or weight_changed:
                    participant.version += 1
                    participant.save(
                        update_fields=[
                            "participant_name",
                            "group_name",
                            "version",
                            "updated_at",
                        ]
                    )
                revision = mark_results_dirty(event) if weight_changed else event.results_revision
                enriched = roster_queryset(event).get(pk=participant.pk)
        except RosterImportError as exc:
            return error_response(exc)
        return Response(
            {
                "participant": participant_summary(enriched),
                "resultsRevision": revision,
            }
        )
