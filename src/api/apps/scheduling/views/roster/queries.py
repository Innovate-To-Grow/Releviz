"""Roster querysets, filters, and summary payloads."""

from collections import defaultdict

from django.db.models import (
    BooleanField,
    Case,
    CharField,
    Count,
    DateTimeField,
    Exists,
    FloatField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce, NullIf

from apps.scheduling.models import EventInvitation, Participant, Weight
from apps.scheduling.payloads.delivery import delivery_request_status_payload
from apps.scheduling.payloads.participants import participant_memberships
from apps.scheduling.permissions import organizer_may_edit_response
from apps.scheduling.services.roster_imports import RosterImportError

UNGROUPED_FILTER = "__ungrouped__"


def roster_queryset(event):
    weight_query = Weight.objects.filter(
        event=event,
        participant_id=OuterRef("pk"),
    )
    invitation_query = EventInvitation.objects.filter(
        event=event,
        member_id=OuterRef("member_id"),
    ).order_by("-created_at")
    queryset = (
        event.participants.select_related("member")
        .prefetch_related("groups")
        .annotate(
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
            roster_invitation_first_sent=Subquery(
                invitation_query.values("first_sent_at")[:1],
                output_field=DateTimeField(),
            ),
            roster_invitation_accepted=Subquery(
                invitation_query.values("accepted_at")[:1],
                output_field=DateTimeField(),
            ),
        )
    )
    return queryset.annotate(
        roster_email=Coalesce(
            NullIf("contact_email", Value("")),
            "roster_invitation_email",
            "member__email",
            Value(""),
            output_field=CharField(),
        ),
        roster_invitation_status=Case(
            When(roster_invitation_first_sent__isnull=True, then=Value("not_sent")),
            When(roster_invitation_accepted__isnull=False, then=Value("accepted")),
            default=Value("sent"),
            output_field=CharField(),
        ),
    )


INVITATION_STATUS_ALIASES = {
    "not_sent": "not_sent",
    "sent": "sent",
    "accepted": "accepted",
    "invited": "sent",
    "opened": "sent",
    "submitted": "accepted",
}


def boolean_query(value, label):
    normalized = str(value if value is not None else "").strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise RosterImportError(f"{label} must be true or false.")


def membership_exists(**filters):
    """``Exists`` over the membership rows of the participant being filtered.

    A subquery keeps the roster to one row per person, so counts, aggregates,
    and slicing stay correct however many groups someone belongs to.
    """

    return Exists(
        Participant.groups.through.objects.filter(participant_id=OuterRef("pk"), **filters)
    )


def group_filter(group):
    """Rows matching a ``group`` filter value: a name, or ``__ungrouped__``."""

    if group == UNGROUPED_FILTER:
        return Q(all_groups=False) & ~membership_exists()
    return Q(all_groups=True) | membership_exists(participantgroup__name__iexact=group)


def apply_roster_filters(queryset, params):
    search = str(params.get("search") or "").strip()
    if search:
        queryset = queryset.filter(
            Q(participant_name__icontains=search)
            | Q(roster_email__icontains=search)
            | membership_exists(participantgroup__name__icontains=search)
            | Q(contact_phone__icontains=search)
        )
    group = params.get("group")
    if group is not None and str(group) != "":
        queryset = queryset.filter(group_filter(str(group).strip()))
    if params.get("submitted") not in {None, ""}:
        queryset = queryset.filter(submitted=boolean_query(params.get("submitted"), "submitted"))
    if params.get("included") not in {None, ""}:
        queryset = queryset.filter(
            roster_included=boolean_query(params.get("included"), "included")
        )
    invitation_status = str(params.get("invitationStatus") or "").strip()
    if invitation_status:
        if invitation_status not in INVITATION_STATUS_ALIASES:
            raise RosterImportError("invitationStatus is invalid.")
        queryset = queryset.filter(
            roster_invitation_status=INVITATION_STATUS_ALIASES[invitation_status]
        )
    account_access = str(params.get("accountAccess") or "").strip()
    if account_access:
        if account_access not in {"temporary", "full"}:
            raise RosterImportError("accountAccess is invalid.")
        queryset = queryset.filter(member__access_level=account_access)
    return queryset


def participant_summary(participant) -> dict:
    account_access = getattr(participant.member, "access_level", "full")
    return {
        "id": str(participant.pk),
        "participantId": str(participant.pk),
        "memberId": str(participant.member_id),
        "name": participant.participant_name,
        "email": str(getattr(participant, "roster_email", "") or "").lower(),
        "phone": participant.contact_phone,
        **participant_memberships(participant),
        "weight": float(getattr(participant, "roster_weight", 1.0)),
        "included": bool(getattr(participant, "roster_included", True)),
        "submitted": participant.submitted,
        "accountAccess": account_access,
        "organizerManaged": participant.organizer_managed,
        "canOrganizerEditAvailability": organizer_may_edit_response(participant),
        "invitationStatus": getattr(participant, "roster_invitation_status", "not_sent"),
        "version": participant.version,
    }


def _group_entry(group_id, name, member_ids, weights) -> dict:
    # The weight shared by everyone counted in the group, or ``None`` when
    # they carry different weights (or nobody is counted).
    shared = {weights[pk] for pk in member_ids}
    return {
        "id": group_id,
        "name": name,
        "count": len(member_ids),
        "weight": float(shared.pop()) if len(shared) == 1 else None,
    }


def group_stats(event, queryset) -> list[dict]:
    """Every group of the event with its head count and the weight its members share.

    Groups are listed in name order, empty ones included. A person counts
    once in each group they belong to, and someone flagged ``all_groups``
    counts in every group. When anyone belongs to no group at all, an
    ungrouped row (``id`` and ``name`` empty) closes the list.
    """

    weights = {}
    everywhere = set()
    for row in queryset.values("pk", "roster_weight", "all_groups"):
        weights[row["pk"]] = row["roster_weight"]
        if row["all_groups"]:
            everywhere.add(row["pk"])
    members = defaultdict(set)
    memberships = Participant.groups.through.objects.filter(
        participantgroup__event=event
    ).values_list("participant_id", "participantgroup_id")
    for participant_id, group_id in memberships:
        if participant_id in weights:
            members[group_id].add(participant_id)

    stats = [
        _group_entry(group.pk, group.name, members[group.pk] | everywhere, weights)
        for group in event.participant_groups.all()
    ]
    ungrouped = set(weights) - everywhere - set().union(*members.values())
    if ungrouped:
        stats.append(_group_entry(None, "", ungrouped, weights))
    return stats


def roster_stats(event, queryset, *, groups_queryset=None) -> dict:
    totals = queryset.aggregate(
        total=Count("pk"),
        submitted=Count("pk", filter=Q(submitted=True)),
        included=Count("pk", filter=Q(roster_included=True)),
    )
    # Totals follow the active filters; the group list always describes the
    # whole roster so organizers can manage groups while a filter is on.
    groups = group_stats(event, queryset if groups_queryset is None else groups_queryset)
    return {
        "total": totals["total"],
        "submitted": totals["submitted"],
        "notSubmitted": totals["total"] - totals["submitted"],
        "included": totals["included"],
        "excluded": totals["total"] - totals["included"],
        "groups": groups,
    }


def latest_delivery_request(event) -> dict | None:
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
