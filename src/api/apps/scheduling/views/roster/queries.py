"""Roster querysets, filters, and summary payloads."""

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

from apps.scheduling.models import EventInvitation, Weight
from apps.scheduling.payloads.delivery import delivery_request_status_payload
from apps.scheduling.services.roster_imports import RosterImportError


def roster_queryset(event):
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


def boolean_query(value, label):
    normalized = str(value if value is not None else "").strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise RosterImportError(f"{label} must be true or false.")


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
        queryset = queryset.filter(submitted=boolean_query(params.get("submitted"), "submitted"))
    if params.get("included") not in {None, ""}:
        queryset = queryset.filter(
            roster_included=boolean_query(params.get("included"), "included")
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


def participant_summary(participant) -> dict:
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
