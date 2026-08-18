"""Lookup, pagination, and write-guard helpers for the roster views."""

import math
import uuid

from django.db.models import Q
from rest_framework.response import Response

from apps.scheduling.models import (
    Event,
    EventResultSnapshot,
    Participant,
    RosterImportBatch,
)
from apps.scheduling.services.events import response_write_error
from apps.scheduling.services.roster_imports import RosterImportError


def error_response(exc: RosterImportError):
    return Response({"error": str(exc), **exc.extra}, status=exc.status_code)


def event_for_organizer(request, *, lock=False):
    code = str(request.query_params.get("code") or "").strip().upper()
    if not code:
        return None, Response({"error": "code is required"}, status=400)
    query = Event.objects.select_for_update() if lock else Event.objects
    event = query.filter(code=code).first()
    if event is None:
        return None, Response({"error": "Event not found"}, status=404)
    if event.organizer_id != request.user.pk:
        return None, Response(
            {"error": "Only the organizer can manage the roster"},
            status=403,
        )
    return event, None


def roster_write_error(event):
    write_error = response_write_error(event)
    if write_error:
        return Response({"error": write_error}, status=409)
    return None


def batch_for_event(event, import_id):
    return RosterImportBatch.objects.filter(pk=import_id, event=event).first()


def pagination(request, *, default=50, maximum=100):
    try:
        page = int(request.query_params.get("page", 1))
        page_size = int(request.query_params.get("pageSize", default))
    except (TypeError, ValueError) as exc:
        raise RosterImportError("page and pageSize must be positive integers.") from exc
    if page < 1 or page_size < 1 or page_size > maximum:
        raise RosterImportError(
            f"page must be positive and pageSize must be between 1 and {maximum}."
        )
    return page, page_size


def page_payload(*, page, page_size, total):
    return {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "pages": math.ceil(total / page_size) if total else 0,
    }


def participant_for_path(event, participant_id, *, lock=False):
    queryset = Participant.objects.select_related("member").filter(event=event)
    if lock:
        queryset = queryset.select_for_update()
    participant_pk, member_id = _participant_identifiers(participant_id)
    identity = Q()
    if participant_pk is not None:
        identity |= Q(pk=participant_pk)
    if member_id is not None:
        identity |= Q(member_id=member_id)
    if not identity:
        return None
    return queryset.filter(identity).first()


def _participant_identifiers(value):
    normalized = str(value or "").strip()
    participant_pk = int(normalized) if normalized.isdecimal() else None
    try:
        member_id = uuid.UUID(normalized)
    except (ValueError, TypeError, AttributeError):
        member_id = None
    return participant_pk, member_id


def participant_identity_query(values):
    participant_pks = []
    member_ids = []
    for value in values:
        participant_pk, member_id = _participant_identifiers(value)
        if participant_pk is None and member_id is None:
            raise RosterImportError("A participant id is invalid.")
        if participant_pk is not None:
            participant_pks.append(participant_pk)
        if member_id is not None:
            member_ids.append(member_id)
    identity = Q()
    if participant_pks:
        identity |= Q(pk__in=participant_pks)
    if member_ids:
        identity |= Q(member_id__in=member_ids)
    return identity


def parse_weight(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise RosterImportError("weight must be between 0 and 1.") from exc
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1:
        raise RosterImportError("weight must be between 0 and 1.")
    return parsed


def mark_results_dirty(event: Event) -> int:
    event.results_revision += 1
    event.save(update_fields=["results_revision", "updated_at"])
    EventResultSnapshot.objects.update_or_create(
        event=event,
        defaults={
            "requested_revision": event.results_revision,
            "status": EventResultSnapshot.Status.REFRESHING,
            "last_error": "",
        },
    )
    return event.results_revision
