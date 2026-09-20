"""Edit a single roster participant."""

from django.db import transaction
from rest_framework.response import Response

from apps.scheduling.models import Weight
from apps.scheduling.services.roster_groups import (
    parse_group_cell,
    set_participant_groups,
    validate_group_name,
)
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
from .queries import boolean_query, group_stats, participant_summary, roster_queryset

# Any of these keys in the body rewrites the person's memberships.
GROUP_KEYS = ("group", "groupName", "groups", "allGroups")


def _group_name_list(value) -> list[str]:
    """Validate a ``groups`` array; duplicate spellings keep the first one."""

    if not isinstance(value, list) or not all(isinstance(name, str) for name in value):
        raise RosterImportError("groups must be an array of group names.")
    names = []
    seen = set()
    for name in value:
        normalized = validate_group_name(name)
        key = normalized.lower()
        if key not in seen:
            seen.add(key)
            names.append(normalized)
    return names


def _requested_groups(data, participant) -> tuple[bool, list[str]]:
    """Resolve the ``(all_groups, names)`` target from the body without writing.

    A cell (``group``/``groupName``) replaces the current state; ``groups``
    then overrides the names and ``allGroups`` the flag.
    """

    if "group" in data or "groupName" in data:
        all_groups, names = parse_group_cell(data.get("group", data.get("groupName")))
    else:
        all_groups = participant.all_groups
        names = [group.name for group in participant.groups.all()]
    if "groups" in data:
        names = _group_name_list(data.get("groups"))
    if "allGroups" in data:
        all_groups = boolean_query(data.get("allGroups"), "allGroups")
    return all_groups, names


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

                # Validate every field before the first write.
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
                groups_supplied = any(key in request.data for key in GROUP_KEYS)
                if groups_supplied:
                    all_groups, group_names = _requested_groups(request.data, participant)

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

                if groups_supplied:
                    # Persists ``all_groups`` and the memberships itself.
                    changed |= set_participant_groups(
                        participant=participant,
                        all_groups=all_groups,
                        names=group_names,
                    )
                if weight_changed:
                    weight.weight = new_weight
                    weight.included = new_included
                    weight.save()

                if changed or weight_changed:
                    participant.version += 1
                    participant.save(update_fields=["participant_name", "version", "updated_at"])
                # Results never read groups, so only a weight edit dirties them.
                revision = mark_results_dirty(event) if weight_changed else event.results_revision
                enriched = roster_queryset(event).get(pk=participant.pk)
        except RosterImportError as exc:
            return error_response(exc)
        return Response(
            {
                "participant": participant_summary(enriched),
                "resultsRevision": revision,
                # A weight or group edit changes what the groups share.
                "groups": group_stats(event, roster_queryset(event)),
            }
        )
