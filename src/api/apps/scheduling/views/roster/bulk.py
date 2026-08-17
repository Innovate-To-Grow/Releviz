"""Bulk roster edits."""

import hashlib
import json
import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from rest_framework.response import Response

from apps.scheduling.models import Participant, RosterBulkUpdateReceipt, Weight
from apps.scheduling.services.roster_imports import MAX_ROSTER_ROWS, RosterImportError

from ..helpers import PrivateAPIView
from .helpers import (
    error_response,
    event_for_organizer,
    mark_results_dirty,
    parse_weight,
    participant_identity_query,
    roster_write_error,
)
from .queries import apply_roster_filters, boolean_query, roster_queryset


def _bulk_selector(queryset, data):
    has_selector = False
    participant_ids = data.get("participantIds")
    if participant_ids is not None:
        has_selector = True
        if not isinstance(participant_ids, list) or not participant_ids:
            raise RosterImportError("participantIds must be a non-empty array.")
        if len(participant_ids) > MAX_ROSTER_ROWS:
            raise RosterImportError(
                f"participantIds may contain at most {MAX_ROSTER_ROWS} entries."
            )
        queryset = queryset.filter(participant_identity_query(participant_ids))
    if "group" in data:
        has_selector = True
        group_name = str(data.get("group") or "").strip()
        if group_name:
            queryset = queryset.filter(group_name__iexact=group_name)
        else:
            queryset = queryset.filter(Q(group_name__isnull=True) | Q(group_name=""))
    if "filter" in data:
        has_selector = True
        filter_data = data.get("filter")
        if not isinstance(filter_data, dict):
            raise RosterImportError("filter must be an object.")
        allowed_filters = {
            "all",
            "search",
            "group",
            "submitted",
            "included",
            "invitationStatus",
            "accountAccess",
        }
        unknown_filters = set(filter_data) - allowed_filters
        if unknown_filters:
            raise RosterImportError(f"Unknown roster filter: {sorted(unknown_filters)[0]}.")
        if not filter_data:
            raise RosterImportError("filter must contain a roster filter or explicit all=true.")
        if "all" in filter_data and filter_data.get("all") is not True:
            raise RosterImportError("filter.all must be true when provided.")
        queryset = apply_roster_filters(queryset, filter_data)
    if not has_selector:
        raise RosterImportError("Choose participantIds, group, or filter for a bulk update.")
    return queryset


class RosterBulkView(PrivateAPIView):
    def patch(self, request):
        try:
            with transaction.atomic():
                event, error = event_for_organizer(request, lock=True)
                if error:
                    return error
                write_error = roster_write_error(event)
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

                selected = _bulk_selector(roster_queryset(event), request.data)
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
                    boolean_query(updates.get("included"), "included")
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
                return error_response(exc)
            return Response({"error": "A participant id is invalid."}, status=400)
        return Response(
            {
                "updatedCount": len(changed_participants),
                "matchedCount": len(participants),
                "resultsRevision": revision,
                "idempotent": False,
            }
        )
