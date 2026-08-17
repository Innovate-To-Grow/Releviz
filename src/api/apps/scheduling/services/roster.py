"""Roster reads and organizer edits: annotated queries, filters, and selectors."""

from __future__ import annotations

import math
import uuid

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

from apps.scheduling.models import (
    Event,
    EventInvitation,
    EventResultSnapshot,
    Participant,
    Weight,
)
from apps.scheduling.services.roster_imports import MAX_ROSTER_ROWS, RosterImportError


def roster_queryset(event):
    """Annotate participants with the weight and invitation state the roster shows."""

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


def parse_boolean_query(value, label):
    normalized = str(value if value is not None else "").strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise RosterImportError(f"{label} must be true or false.")


def parse_weight(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise RosterImportError("weight must be between 0 and 1.") from exc
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1:
        raise RosterImportError("weight must be between 0 and 1.")
    return parsed


def apply_roster_filters(queryset, params):
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
        queryset = queryset.filter(
            submitted=parse_boolean_query(params.get("submitted"), "submitted")
        )
    if params.get("included") not in {None, ""}:
        queryset = queryset.filter(
            roster_included=parse_boolean_query(params.get("included"), "included")
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


def roster_stats(queryset) -> dict:
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


def participant_identifiers(value):
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
        participant_pk, member_id = participant_identifiers(value)
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


def participant_for_path(event, participant_id, *, lock=False):
    queryset = Participant.objects.select_related("member").filter(event=event)
    if lock:
        queryset = queryset.select_for_update()
    participant_pk, member_id = participant_identifiers(participant_id)
    identity = Q()
    if participant_pk is not None:
        identity |= Q(pk=participant_pk)
    if member_id is not None:
        identity |= Q(member_id=member_id)
    if not identity:
        return None
    return queryset.filter(identity).first()


def bulk_selector(queryset, data):
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
