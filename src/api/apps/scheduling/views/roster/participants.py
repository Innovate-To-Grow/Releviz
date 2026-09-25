"""Edit a single roster participant."""

from django.db import transaction
from rest_framework.response import Response

from apps.scheduling.models import Weight
from apps.scheduling.services.invitations import ManagedParticipantError, normalize_phone
from apps.scheduling.services.roster_groups import (
    MAX_GROUPS_PER_CELL,
    parse_group_cell,
    set_participant_groups,
    validate_group_names,
)
from apps.scheduling.services.roster_imports import RosterImportError
from apps.scheduling.services.roster_people import change_participant_email, remove_participant

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
GROUP_KEYS = ("group", "groupName", "groups", "allGroups", "addGroupIds", "removeGroupIds")
DELETED_GROUP_MESSAGE = "This group was deleted in another session."


def _group_name_list(value) -> list[str]:
    """Validate a ``groups`` array; duplicate spellings keep the first one."""

    if not isinstance(value, list) or not all(isinstance(name, str) for name in value):
        raise RosterImportError("groups must be an array of group names.")
    return validate_group_names(value)


def _group_id_list(data, key) -> list[int]:
    value = data.get(key)
    if (
        not isinstance(value, list)
        or len(value) > MAX_GROUPS_PER_CELL
        or not all(isinstance(item, int) and not isinstance(item, bool) for item in value)
    ):
        raise RosterImportError(f"{key} must be an array of group ids.")
    return value


def _toggled_names(event, data, names) -> list[str]:
    """Apply ``addGroupIds`` then ``removeGroupIds`` to a list of group names.

    The roster's per-group checkboxes send these. An id names a group that
    exists: adding to one deleted in another session is refused rather than
    recreating it, while removing from it is already done.
    """

    add_ids = _group_id_list(data, "addGroupIds") if "addGroupIds" in data else []
    remove_ids = _group_id_list(data, "removeGroupIds") if "removeGroupIds" in data else []
    found = dict(
        event.participant_groups.filter(pk__in=[*add_ids, *remove_ids]).values_list("pk", "name")
    )
    if any(group_id not in found for group_id in add_ids):
        raise RosterImportError(DELETED_GROUP_MESSAGE, status_code=409)
    held = {name.lower() for name in names}
    for group_id in add_ids:
        if found[group_id].lower() not in held:
            held.add(found[group_id].lower())
            names = [*names, found[group_id]]
    dropped = {found[group_id].lower() for group_id in remove_ids if group_id in found}
    return [name for name in names if name.lower() not in dropped]


def _requested_groups(event, data, participant) -> tuple[bool, list[str]]:
    """Resolve the ``(all_groups, names)`` target from the body without writing.

    A cell (``group``/``groupName``) replaces the current state; ``groups``
    then overrides the names and ``allGroups`` the flag; ``addGroupIds`` and
    ``removeGroupIds`` finally adjust single memberships.
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
    if "addGroupIds" in data or "removeGroupIds" in data:
        names = _toggled_names(event, data, names)
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
                    all_groups, group_names = _requested_groups(event, request.data, participant)
                if "phone" in request.data:
                    try:
                        phone = normalize_phone(request.data.get("phone"))
                    except ManagedParticipantError as exc:
                        raise RosterImportError(str(exc)) from exc
                    if participant.contact_phone != phone:
                        participant.contact_phone = phone
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

                # The address moves the row to another account, so it is the
                # first write, after every other field has been validated.
                email_changed = "email" in request.data and change_participant_email(
                    event=event,
                    participant=participant,
                    organizer=request.user,
                    email=request.data.get("email"),
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
                    participant.save(
                        update_fields=[
                            "participant_name",
                            "contact_phone",
                            "version",
                            "updated_at",
                        ]
                    )
                # Results never read groups, so only a weight edit or a move to
                # another account dirties them.
                revision = (
                    mark_results_dirty(event)
                    if weight_changed or email_changed
                    else event.results_revision
                )
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

    def delete(self, request, participant_id):
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
                remove_participant(event=event, participant=participant)
                revision = mark_results_dirty(event)
        except RosterImportError as exc:
            return error_response(exc)
        return Response(
            {
                "deleted": True,
                "resultsRevision": revision,
                "groups": group_stats(event, roster_queryset(event)),
            }
        )
