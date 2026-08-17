"""Organizer-facing roster: list, inspect one row, edit one row, or edit in bulk."""

from __future__ import annotations

import hashlib
import json
import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from rest_framework.response import Response

from apps.scheduling.models import Participant, RosterBulkUpdateReceipt, Weight
from apps.scheduling.serializers import delivery_request_status_payload, participant_summary
from apps.scheduling.services.roster import (
    apply_roster_filters,
    bulk_selector,
    mark_results_dirty,
    parse_boolean_query,
    parse_weight,
    participant_for_path,
    roster_queryset,
    roster_stats,
)
from apps.scheduling.services.roster_imports import RosterImportError
from apps.scheduling.views.helpers import (
    PrivateAPIView,
    page_payload,
    parse_pagination,
    roster_error_response,
    roster_event_for_organizer,
    roster_write_error_response,
)


def _latest_delivery_request(event) -> dict | None:
    # Managed-participant idempotency records may intentionally contain zero
    # recipients when the person is already visible in the roster.  Those
    # receipts must not hide the most recent real delivery (including a failed
    # delivery that still needs an organizer retry).
    request_record = (
        event.email_delivery_requests.filter(recipient_count__gt=0).order_by("-created_at").first()
    )
    if request_record is None:
        return None
    return delivery_request_status_payload(request_record)


class RosterView(PrivateAPIView):
    def get(self, request):
        event, error = roster_event_for_organizer(request)
        if error:
            return error
        try:
            page, page_size = parse_pagination(request)
            queryset = apply_roster_filters(roster_queryset(event), request.query_params)
        except RosterImportError as exc:
            return roster_error_response(exc)
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
                "latestDeliveryRequest": _latest_delivery_request(event),
            }
        )


class RosterParticipantScheduleView(PrivateAPIView):
    def get(self, request, participant_id):
        event, error = roster_event_for_organizer(request)
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


class RosterParticipantView(PrivateAPIView):
    def patch(self, request, participant_id):
        try:
            with transaction.atomic():
                event, error = roster_event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error_response(event)
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
                        parse_boolean_query(request.data.get("included"), "included")
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
            return roster_error_response(exc)
        return Response(
            {
                "participant": participant_summary(enriched),
                "resultsRevision": revision,
            }
        )


class RosterBulkView(PrivateAPIView):
    def patch(self, request):
        try:
            with transaction.atomic():
                event, error = roster_event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error_response(event)
                if write_error:
                    return write_error
                allowed_request_fields = {
                    "participantIds",
                    "group",
                    "filter",
                    "updates",
                    "idempotencyKey",
                }
                unknown_request_fields = set(request.data) - allowed_request_fields
                if unknown_request_fields:
                    raise RosterImportError(
                        f"Unknown bulk request field: {sorted(unknown_request_fields)[0]}."
                    )
                try:
                    idempotency_key = uuid.UUID(str(request.data.get("idempotencyKey") or ""))
                except (TypeError, ValueError, AttributeError) as exc:
                    raise RosterImportError("idempotencyKey must be a UUID.") from exc
                fingerprint_payload = {
                    key: request.data.get(key)
                    for key in ("participantIds", "group", "filter", "updates")
                    if key in request.data
                }
                request_fingerprint = hashlib.sha256(
                    json.dumps(
                        fingerprint_payload,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode()
                ).hexdigest()
                previous = RosterBulkUpdateReceipt.objects.filter(
                    event=event,
                    idempotency_key=idempotency_key,
                ).first()
                if previous is not None:
                    if previous.request_fingerprint != request_fingerprint:
                        raise RosterImportError(
                            "This idempotency key was used for a different bulk update.",
                            status_code=409,
                        )
                    return Response(
                        {
                            "updatedCount": previous.updated_count,
                            "matchedCount": previous.matched_count,
                            "resultsRevision": previous.results_revision,
                            "idempotent": True,
                        }
                    )
                updates = request.data.get("updates")
                if not isinstance(updates, dict) or not updates:
                    raise RosterImportError("updates must be a non-empty object.")
                allowed_updates = {"group", "groupName", "weight", "included"}
                unknown = set(updates) - allowed_updates
                if unknown:
                    raise RosterImportError(f"Unknown bulk update field: {sorted(unknown)[0]}.")

                selected = bulk_selector(roster_queryset(event), request.data)
                selected_ids = list(selected.values_list("pk", flat=True))
                participants = list(
                    Participant.objects.select_for_update()
                    .filter(event=event, pk__in=selected_ids)
                    .order_by("pk")
                )
                group_supplied = "group" in updates or "groupName" in updates
                new_group = None
                if group_supplied:
                    group_name = str(updates.get("group", updates.get("groupName")) or "").strip()
                    if len(group_name) > 100:
                        raise RosterImportError("group is too long (max 100).")
                    new_group = group_name or None
                weight_supplied = "weight" in updates
                included_supplied = "included" in updates
                new_weight = parse_weight(updates.get("weight")) if weight_supplied else None
                new_included = (
                    parse_boolean_query(updates.get("included"), "included")
                    if included_supplied
                    else None
                )

                weights = {
                    weight.participant_id: weight
                    for weight in Weight.objects.select_for_update().filter(
                        event=event,
                        participant_id__in=selected_ids,
                    )
                }
                changed_participants = []
                new_weights = []
                changed_weights = []
                results_changed = False
                for participant in participants:
                    participant_changed = False
                    if group_supplied and participant.group_name != new_group:
                        participant.group_name = new_group
                        participant_changed = True
                    if weight_supplied or included_supplied:
                        weight = weights.get(participant.pk)
                        weight_is_new = weight is None
                        if weight_is_new:
                            weight = Weight(event=event, participant=participant)
                        candidate_weight = new_weight if weight_supplied else float(weight.weight)
                        candidate_included = (
                            new_included if included_supplied else bool(weight.included)
                        )
                        if (
                            weight_is_new
                            or float(weight.weight) != candidate_weight
                            or weight.included != candidate_included
                        ):
                            weight.weight = candidate_weight
                            weight.included = candidate_included
                            (new_weights if weight_is_new else changed_weights).append(weight)
                            results_changed = True
                            participant_changed = True
                    if participant_changed:
                        participant.version += 1
                        changed_participants.append(participant)

                if changed_participants:
                    Participant.objects.bulk_update(
                        changed_participants,
                        ["group_name", "version", "updated_at"],
                    )
                if new_weights:
                    Weight.objects.bulk_create(new_weights)
                if changed_weights:
                    Weight.objects.bulk_update(
                        changed_weights,
                        ["weight", "included", "updated_at"],
                    )
                revision = mark_results_dirty(event) if results_changed else event.results_revision
                RosterBulkUpdateReceipt.objects.create(
                    event=event,
                    idempotency_key=idempotency_key,
                    request_fingerprint=request_fingerprint,
                    matched_count=len(participants),
                    updated_count=len(changed_participants),
                    results_revision=revision,
                )
        except (RosterImportError, ValidationError, ValueError) as exc:
            if isinstance(exc, RosterImportError):
                return roster_error_response(exc)
            return Response({"error": "A participant id is invalid."}, status=400)
        return Response(
            {
                "updatedCount": len(changed_participants),
                "matchedCount": len(participants),
                "resultsRevision": revision,
                "idempotent": False,
            }
        )
