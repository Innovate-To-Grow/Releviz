"""Response conventions, organizer lookups, and pagination shared by the views."""

from __future__ import annotations

import math

from django.utils.cache import patch_cache_control, patch_vary_headers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.scheduling.models import Event, RosterImportBatch, ScheduleEditRecord
from apps.scheduling.services.lifecycle import response_write_error
from apps.scheduling.services.roster_imports import RosterImportError


def private_response(data, *, status=200):
    """Bearer-authenticated payload: never cached, varies on Authorization."""

    response = Response(data, status=status)
    patch_cache_control(response, private=True, no_store=True)
    patch_vary_headers(response, ["Authorization"])
    return response


def temp_private_response(data=None, *, status=200):
    """Temporary-session payload: authenticated by cookie, so vary on it instead."""

    response = Response(data, status=status)
    patch_cache_control(response, private=True, no_store=True)
    patch_vary_headers(response, ["Cookie", "Origin"])
    return response


class PrivateAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        patch_cache_control(response, private=True, no_store=True)
        patch_vary_headers(response, ["Authorization"])
        return response


def roster_error_response(exc: RosterImportError):
    return Response({"error": str(exc), **exc.extra}, status=exc.status_code)


def roster_event_for_organizer(request, *, lock=False):
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


def roster_write_error_response(event):
    write_error = response_write_error(event)
    if write_error:
        return Response({"error": write_error}, status=409)
    return None


def roster_batch_for_event(event, import_id):
    return RosterImportBatch.objects.filter(pk=import_id, event=event).first()


def parse_pagination(request, *, default=50, maximum=100):
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


def record_schedule_edit(*, event, participant, actor, source, was_submitted: bool) -> None:
    if participant.submitted:
        action = ScheduleEditRecord.Action.SUBMIT
    elif was_submitted:
        action = ScheduleEditRecord.Action.WITHDRAW
    else:
        action = ScheduleEditRecord.Action.DRAFT
    actor_identifier = getattr(actor, "pk", None)
    actor_reference = None if getattr(actor, "access_level", None) == "temporary" else actor
    ScheduleEditRecord.objects.create(
        event=event,
        participant=participant,
        actor=actor_reference,
        actor_identifier=actor_identifier,
        source=source,
        action=action,
        participant_version=participant.version,
    )
