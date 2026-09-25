"""Create, rename, and delete an event's participant groups."""

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.response import Response

from apps.scheduling.models import Participant, Weight
from apps.scheduling.services.roster_groups import create_group, delete_group, rename_group
from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import PrivateAPIView
from .helpers import error_response, event_for_organizer, mark_results_dirty, roster_write_error
from .queries import group_stats, roster_queryset


def _group_payload(event):
    return group_stats(event, roster_queryset(event))


def _group_entry(groups, group):
    # Every group has a stats entry, including an empty one.
    return next(entry for entry in groups if entry["id"] == group.pk)


def _group_for_path(event, group_id):
    return event.participant_groups.select_for_update().filter(pk=group_id).first()


class RosterGroupsView(PrivateAPIView):
    def get(self, request):
        event, error = event_for_organizer(request)
        if error:
            return error
        return Response({"groups": _group_payload(event)})

    def post(self, request):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
                if write_error:
                    return write_error
                group = create_group(event=event, name=request.data.get("name"))
                groups = _group_payload(event)
        except RosterImportError as exc:
            return error_response(exc)
        return Response({"group": _group_entry(groups, group), "groups": groups}, status=201)


class RosterGroupView(PrivateAPIView):
    def patch(self, request, group_id):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
                if write_error:
                    return write_error
                group = _group_for_path(event, group_id)
                if group is None:
                    return Response({"error": "Group not found"}, status=404)
                group = rename_group(group=group, name=request.data.get("name"))
                groups = _group_payload(event)
        except RosterImportError as exc:
            return error_response(exc)
        return Response({"group": _group_entry(groups, group), "groups": groups})

    def delete(self, request, group_id):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
                if write_error:
                    return write_error
                group = _group_for_path(event, group_id)
                if group is None:
                    return Response({"error": "Group not found"}, status=404)
                delete_group(group=group)
                groups = _group_payload(event)
        except RosterImportError as exc:
            return error_response(exc)
        return Response({"groups": groups})


def _include_only(event, group) -> tuple[int, int]:
    """Include the group's people and leave everyone else out of the results.

    Returns ``(included, changed)``: how many people the group holds and how
    many rows changed. Weights are untouched, so ticking everyone back in
    restores the earlier results exactly.
    """

    members = set(
        event.participants.filter(Q(groups=group) | Q(all_groups=True)).values_list("pk", flat=True)
    )
    participants = list(Participant.objects.select_for_update().filter(event=event).order_by("pk"))
    weights = {
        weight.participant_id: weight
        for weight in Weight.objects.select_for_update().filter(event=event)
    }
    now = timezone.now()
    new_weights = []
    changed_weights = []
    changed_participants = []
    for participant in participants:
        target = participant.pk in members
        weight = weights.get(participant.pk)
        if weight is None:
            # A person without a weight row counts as included.
            if target:
                continue
            new_weights.append(Weight(event=event, participant=participant, included=False))
        elif weight.included == target:
            continue
        else:
            weight.included = target
            weight.updated_at = now
            changed_weights.append(weight)
        participant.version += 1
        # bulk_update skips auto_now, so stamp the edit by hand.
        participant.updated_at = now
        changed_participants.append(participant)
    if new_weights:
        Weight.objects.bulk_create(new_weights)
    if changed_weights:
        Weight.objects.bulk_update(changed_weights, ["included", "updated_at"])
    if changed_participants:
        Participant.objects.bulk_update(changed_participants, ["version", "updated_at"])
    return len(members), len(changed_participants)


class RosterGroupIncludeOnlyView(PrivateAPIView):
    """Count one group alone, so its best meeting times show in the results."""

    def post(self, request, group_id):
        with transaction.atomic():
            event, error = event_for_organizer(request, lock=True)
            if error:
                return error
            write_error = roster_write_error(event)
            if write_error:
                return write_error
            group = _group_for_path(event, group_id)
            if group is None:
                return Response({"error": "Group not found"}, status=404)
            included, changed = _include_only(event, group)
            revision = mark_results_dirty(event) if changed else event.results_revision
            groups = _group_payload(event)
        return Response(
            {
                "includedCount": included,
                "updatedCount": changed,
                "resultsRevision": revision,
                "groups": groups,
            }
        )
