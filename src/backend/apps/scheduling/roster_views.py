from __future__ import annotations

import hashlib
import json
import math
import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import (
    BooleanField,
    Case,
    CharField,
    Count,
    DateTimeField,
    FloatField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce
from django.utils.cache import patch_cache_control, patch_vary_headers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.messaging.models import EmailDeliveryJob
from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultSnapshot,
    Participant,
    RosterBulkUpdateReceipt,
    RosterImportBatch,
    Weight,
)
from apps.scheduling.roster_imports import (
    MAX_ROSTER_ROWS,
    RosterImportError,
    cancel_roster_import,
    commit_roster_import,
    create_roster_import,
    expire_roster_import_preview,
    roster_import_payload,
    roster_import_receipt_payload,
    roster_import_row_payload,
    update_roster_import,
)
from apps.scheduling.utils import api_event


class PrivateAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        patch_cache_control(response, private=True, no_store=True)
        patch_vary_headers(response, ["Authorization"])
        return response


def _error(exc: RosterImportError):
    return Response({"error": str(exc), **exc.extra}, status=exc.status_code)


def _event_for_organizer(request, *, lock=False):
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


def _batch_for_event(event, import_id):
    return RosterImportBatch.objects.filter(pk=import_id, event=event).first()


def _pagination(request, *, default=50, maximum=100):
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


def _page_payload(*, page, page_size, total):
    return {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "pages": math.ceil(total / page_size) if total else 0,
    }


class RosterImportCollectionView(PrivateAPIView):
    def post(self, request):
        event, error = _event_for_organizer(request)
        if error:
            return error
        if event.status in {Event.Status.FINALIZED, Event.Status.ARCHIVED}:
            return Response(
                {"error": "Reopen this event before changing its roster."},
                status=409,
            )
        try:
            batch = create_roster_import(
                event=event,
                created_by=request.user,
                uploaded_file=request.FILES.get("file"),
                pasted_text=request.data.get("pastedText", request.data.get("content")),
                requested_source=str(request.data.get("sourceType") or "").strip().lower(),
            )
        except RosterImportError as exc:
            return _error(exc)
        return Response({"import": roster_import_payload(batch)}, status=201)


class RosterImportDetailView(PrivateAPIView):
    def put(self, request, import_id):
        event, error = _event_for_organizer(request)
        if error:
            return error
        batch = _batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        try:
            batch = update_roster_import(batch=batch, data=request.data)
        except RosterImportError as exc:
            return _error(exc)
        return Response({"import": roster_import_payload(batch)})

    def delete(self, request, import_id):
        event, error = _event_for_organizer(request)
        if error:
            return error
        batch = _batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        if expire_roster_import_preview(batch):
            return Response({"error": "This import preview has expired."}, status=410)
        try:
            batch = cancel_roster_import(batch)
        except RosterImportError as exc:
            return _error(exc)
        return Response({"importId": str(batch.pk), "status": batch.status})


class RosterImportRowsView(PrivateAPIView):
    def get(self, request, import_id):
        event, error = _event_for_organizer(request)
        if error:
            return error
        batch = _batch_for_event(event, import_id)
        if batch is None:
            return Response({"error": "Roster import not found"}, status=404)
        if expire_roster_import_preview(batch):
            return Response({"error": "This import preview has expired."}, status=410)
        try:
            page, page_size = _pagination(request)
        except RosterImportError as exc:
            return _error(exc)
        rows = batch.rows.filter(
            worksheet=batch.selected_worksheet,
            row_number__gt=batch.header_row,
        ).order_by("row_number")
        total = rows.count()
        offset = (page - 1) * page_size
        return Response(
            {
                "import": roster_import_payload(batch),
                "rows": [
                    roster_import_row_payload(row) for row in rows[offset : offset + page_size]
                ],
                "pagination": _page_payload(
                    page=page,
                    page_size=page_size,
                    total=total,
                ),
            }
        )


class RosterImportCommitView(PrivateAPIView):
    def post(self, request, import_id):
        event, error = _event_for_organizer(request)
        if error:
            return error
        try:
            receipt, idempotent = commit_roster_import(
                event=event,
                batch_id=import_id,
                organizer=request.user,
                data=request.data,
            )
        except RosterImportError as exc:
            return _error(exc)
        receipt.event.refresh_from_db()
        return Response(
            {
                "receipt": roster_import_receipt_payload(receipt),
                "idempotent": idempotent,
                "event": api_event(receipt.event),
            },
            status=200 if idempotent else 201,
        )


def _roster_queryset(event):
    weight_query = Weight.objects.filter(
        event=event,
        participant_id=OuterRef("pk"),
    )
    invitation_query = EventInvitation.objects.filter(
        event=event,
        member_id=OuterRef("member_id"),
    ).order_by("-created_at")
    queryset = event.participants.select_related("member").annotate(
        roster_weight=Coalesce(
            Subquery(weight_query.values("weight")[:1], output_field=FloatField()),
            Value(1.0),
            output_field=FloatField(),
        ),
        roster_included=Coalesce(
            Subquery(weight_query.values("included")[:1], output_field=BooleanField()),
            Value(True),
            output_field=BooleanField(),
        ),
        roster_invitation_email=Subquery(
            invitation_query.values("email")[:1],
            output_field=CharField(),
        ),
        roster_invitation_state=Subquery(
            invitation_query.values("status")[:1],
            output_field=CharField(),
        ),
        roster_invitation_first_sent=Subquery(
            invitation_query.values("first_sent_at")[:1],
            output_field=DateTimeField(),
        ),
        roster_invitation_opened=Subquery(
            invitation_query.values("opened_at")[:1],
            output_field=DateTimeField(),
        ),
    )
    return queryset.annotate(
        roster_email=Coalesce(
            "roster_invitation_email",
            "member__email",
            Value(""),
            output_field=CharField(),
        ),
        roster_invitation_status=Case(
            When(submitted=True, then=Value("submitted")),
            When(roster_invitation_first_sent__isnull=True, then=Value("not_sent")),
            When(
                Q(roster_invitation_opened__isnull=False)
                | Q(
                    roster_invitation_state__in=[
                        EventInvitation.Status.OPENED,
                        EventInvitation.Status.JOINED,
                        EventInvitation.Status.DRAFT_SAVED,
                    ]
                ),
                then=Value("opened"),
            ),
            default=Value("invited"),
            output_field=CharField(),
        ),
    )


def _boolean_query(value, label):
    normalized = str(value if value is not None else "").strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise RosterImportError(f"{label} must be true or false.")


def _apply_roster_filters(queryset, params):
    search = str(params.get("search") or "").strip()
    if search:
        queryset = queryset.filter(
            Q(participant_name__icontains=search)
            | Q(group_name__icontains=search)
            | Q(roster_email__icontains=search)
        )
    group = params.get("group")
    if group is not None and str(group) != "":
        group = str(group).strip()
        if group == "__ungrouped__":
            queryset = queryset.filter(Q(group_name__isnull=True) | Q(group_name=""))
        else:
            queryset = queryset.filter(group_name__iexact=group)
    if params.get("submitted") not in {None, ""}:
        queryset = queryset.filter(submitted=_boolean_query(params.get("submitted"), "submitted"))
    if params.get("included") not in {None, ""}:
        queryset = queryset.filter(
            roster_included=_boolean_query(params.get("included"), "included")
        )
    invitation_status = str(params.get("invitationStatus") or "").strip()
    if invitation_status:
        if invitation_status not in {"not_sent", "invited", "opened", "submitted"}:
            raise RosterImportError("invitationStatus is invalid.")
        queryset = queryset.filter(roster_invitation_status=invitation_status)
    account_access = str(params.get("accountAccess") or "").strip()
    if account_access:
        if account_access not in {"temporary", "full"}:
            raise RosterImportError("accountAccess is invalid.")
        queryset = queryset.filter(member__access_level=account_access)
    return queryset


def _participant_summary(participant) -> dict:
    account_access = getattr(participant.member, "access_level", "full")
    return {
        "id": str(participant.pk),
        "participantId": str(participant.pk),
        "memberId": str(participant.member_id),
        "name": participant.participant_name,
        "email": str(getattr(participant, "roster_email", "") or "").lower(),
        "group": participant.group_name or "",
        "weight": float(getattr(participant, "roster_weight", 1.0)),
        "included": bool(getattr(participant, "roster_included", True)),
        "submitted": participant.submitted,
        "accountAccess": account_access,
        "canOrganizerEditAvailability": account_access == "temporary",
        "invitationStatus": getattr(participant, "roster_invitation_status", "not_sent"),
        "version": participant.version,
    }


def _roster_stats(queryset) -> dict:
    totals = queryset.aggregate(
        total=Count("pk"),
        submitted=Count("pk", filter=Q(submitted=True)),
        included=Count("pk", filter=Q(roster_included=True)),
    )
    groups = [
        {
            "name": item["group_name"] or "",
            "count": item["count"],
        }
        for item in queryset.values("group_name").annotate(count=Count("pk")).order_by("group_name")
    ]
    return {
        "total": totals["total"],
        "submitted": totals["submitted"],
        "notSubmitted": totals["total"] - totals["submitted"],
        "included": totals["included"],
        "excluded": totals["total"] - totals["included"],
        "groups": groups,
    }


def _latest_delivery_request(event) -> dict | None:
    request_record = event.email_delivery_requests.order_by("-created_at").first()
    if request_record is None:
        return None
    counts = {
        row["status"]: row["total"]
        for row in request_record.jobs.values("status").annotate(total=Count("pk"))
    }
    return {
        "id": str(request_record.pk),
        "operation": request_record.operation,
        "recipientCount": request_record.recipient_count,
        "enqueued": request_record.created_job_count,
        "createdAt": request_record.created_at.isoformat(),
        "updatedAt": request_record.updated_at.isoformat(),
        "delivery": {
            "total": sum(counts.values()),
            "pending": counts.get(EmailDeliveryJob.Status.PENDING, 0),
            "processing": counts.get(EmailDeliveryJob.Status.PROCESSING, 0),
            "retry": counts.get(EmailDeliveryJob.Status.RETRY, 0),
            "sent": counts.get(EmailDeliveryJob.Status.SENT, 0),
            "permanentFailure": counts.get(EmailDeliveryJob.Status.PERMANENT_FAILURE, 0),
            "canceled": counts.get(EmailDeliveryJob.Status.CANCELED, 0),
        },
    }


class RosterView(PrivateAPIView):
    def get(self, request):
        event, error = _event_for_organizer(request)
        if error:
            return error
        try:
            page, page_size = _pagination(request)
            queryset = _apply_roster_filters(_roster_queryset(event), request.query_params)
        except RosterImportError as exc:
            return _error(exc)
        stats = _roster_stats(queryset)
        offset = (page - 1) * page_size
        participants = list(
            queryset.order_by("sort_order", "created_at")[offset : offset + page_size]
        )
        return Response(
            {
                "participants": [_participant_summary(item) for item in participants],
                "pagination": _page_payload(
                    page=page,
                    page_size=page_size,
                    total=stats["total"],
                ),
                "stats": stats,
                "latestDeliveryRequest": _latest_delivery_request(event),
            }
        )


def _participant_for_path(event, participant_id, *, lock=False):
    queryset = Participant.objects.select_related("member").filter(event=event)
    if lock:
        queryset = queryset.select_for_update()
    return queryset.filter(Q(pk=participant_id) | Q(member_id=participant_id)).first()


class RosterParticipantScheduleView(PrivateAPIView):
    def get(self, request, participant_id):
        event, error = _event_for_organizer(request)
        if error:
            return error
        participant = _participant_for_path(event, participant_id)
        if participant is None:
            return Response({"error": "Participant not found"}, status=404)
        enriched = _roster_queryset(event).get(pk=participant.pk)
        return Response(
            {
                "participant": _participant_summary(enriched),
                "schedule": {
                    "availabilityInperson": participant.availability_inperson,
                    "availabilityVirtual": participant.availability_virtual,
                    "submitted": participant.submitted,
                    "version": participant.version,
                },
            }
        )


def _parse_weight(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise RosterImportError("weight must be between 0 and 1.") from exc
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1:
        raise RosterImportError("weight must be between 0 and 1.")
    return parsed


def _mark_results_dirty(event: Event) -> int:
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


class RosterParticipantView(PrivateAPIView):
    def patch(self, request, participant_id):
        try:
            with transaction.atomic():
                event, error = _event_for_organizer(request, lock=True)
                if error:
                    return error
                if event.status in {Event.Status.FINALIZED, Event.Status.ARCHIVED}:
                    return Response(
                        {"error": "Reopen this event before changing its roster."},
                        status=409,
                    )
                participant = _participant_for_path(event, participant_id, lock=True)
                if participant is None:
                    return Response({"error": "Participant not found"}, status=404)
                expected_version = request.data.get("expectedVersion")
                if isinstance(expected_version, bool) or not isinstance(expected_version, int):
                    return Response({"error": "expectedVersion is required"}, status=428)
                if participant.version != expected_version:
                    enriched = _roster_queryset(event).get(pk=participant.pk)
                    return Response(
                        {
                            "error": "The participant changed in another session.",
                            "participant": _participant_summary(enriched),
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
                        _parse_weight(request.data.get("weight"))
                        if "weight" in request.data
                        else float(weight.weight)
                    )
                    new_included = (
                        _boolean_query(request.data.get("included"), "included")
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
                revision = _mark_results_dirty(event) if weight_changed else event.results_revision
                enriched = _roster_queryset(event).get(pk=participant.pk)
        except RosterImportError as exc:
            return _error(exc)
        return Response(
            {
                "participant": _participant_summary(enriched),
                "resultsRevision": revision,
            }
        )


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
        queryset = queryset.filter(Q(pk__in=participant_ids) | Q(member_id__in=participant_ids))
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
        queryset = _apply_roster_filters(queryset, filter_data)
    if not has_selector:
        raise RosterImportError("Choose participantIds, group, or filter for a bulk update.")
    return queryset


class RosterBulkView(PrivateAPIView):
    def patch(self, request):
        try:
            with transaction.atomic():
                event, error = _event_for_organizer(request, lock=True)
                if error:
                    return error
                if event.status in {Event.Status.FINALIZED, Event.Status.ARCHIVED}:
                    return Response(
                        {"error": "Reopen this event before changing its roster."},
                        status=409,
                    )
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

                selected = _bulk_selector(_roster_queryset(event), request.data)
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
                new_weight = _parse_weight(updates.get("weight")) if weight_supplied else None
                new_included = (
                    _boolean_query(updates.get("included"), "included")
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
                revision = _mark_results_dirty(event) if results_changed else event.results_revision
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
                return _error(exc)
            return Response({"error": "A participant id is invalid."}, status=400)
        return Response(
            {
                "updatedCount": len(changed_participants),
                "matchedCount": len(participants),
                "resultsRevision": revision,
                "idempotent": False,
            }
        )
