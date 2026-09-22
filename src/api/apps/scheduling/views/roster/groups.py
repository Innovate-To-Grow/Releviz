"""Create, rename, and delete an event's participant groups."""

from django.db import transaction
from rest_framework.response import Response

from apps.scheduling.services.roster_groups import create_group, delete_group, rename_group
from apps.scheduling.services.roster_imports import RosterImportError

from ..helpers import PrivateAPIView
from .helpers import error_response, event_for_organizer, roster_write_error
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
