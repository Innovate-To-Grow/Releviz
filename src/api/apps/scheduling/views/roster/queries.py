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

from apps.authn.models import ContactEmail
from apps.mail.models import EmailDeliveryJob, EmailMessageLog
from apps.scheduling.models import EventInvitation, Participant, TemporaryEventSession, Weight
from apps.scheduling.payloads.delivery import delivery_request_status_payload
from apps.scheduling.payloads.participants import participant_memberships
from apps.scheduling.permissions import organizer_may_edit_response
from apps.scheduling.services.invitations.reminders import reminder_candidates
from apps.scheduling.services.roster_imports import RosterImportError
from apps.scheduling.services.roster_people import email_change_allowed

UNGROUPED_FILTER = "__ungrouped__"
# Where the latest invitation email stands: still to be sent, or given up on.
DELIVERY_QUEUED = "queued"
DELIVERY_FAILED = "failed"


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
            roster_invitation_id=Subquery(invitation_query.values("pk")[:1]),
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
            # When the latest invitation email went out (the first one when
            # an older send recorded only that).
            roster_invitation_sent_at=Subquery(
                invitation_query.values(sent_at=Coalesce("last_sent_at", "first_sent_at"))[:1],
                output_field=DateTimeField(),
            ),
            # Whether the person ever opened a temporary link session.
            roster_signed_in=Exists(
                TemporaryEventSession.objects.filter(participant_id=OuterRef("pk"))
            ),
        )
    )
    # Accounts created with an email code keep their address only as a
    # primary contact email (Member.get_primary_email), so that is the last
    # resort for someone without an invitation, such as the organizer's own
    # row.
    primary_contact = ContactEmail.objects.filter(
        member_id=OuterRef("member_id"), email_type="primary"
    ).order_by("created_at")
    # The newest invitation email for the person's latest invitation, reduced
    # to whether it is still to be sent or was given up on; a delivered,
    # uncertain, or canceled one leaves the value null.
    latest_invitation_job = (
        EmailDeliveryJob.objects.filter(
            invitation_id=OuterRef("roster_invitation_id"),
            message_type=EmailMessageLog.MessageType.INVITATION,
        )
        .annotate(
            delivery=Case(
                When(
                    status__in=EmailDeliveryJob.IN_FLIGHT_STATUSES,
                    then=Value(DELIVERY_QUEUED),
                ),
                When(
                    status=EmailDeliveryJob.Status.PERMANENT_FAILURE,
                    then=Value(DELIVERY_FAILED),
                ),
                default=Value(None),
                output_field=CharField(),
            )
        )
        .order_by("-created_at", "-pk")
    )
    return queryset.annotate(
        roster_email=Coalesce(
            NullIf("contact_email", Value("")),
            "roster_invitation_email",
            NullIf("member__email", Value("")),
            Subquery(primary_contact.values("email_address")[:1], output_field=CharField()),
            Value(""),
            output_field=CharField(),
        ),
        roster_invitation_status=Case(
            When(roster_invitation_first_sent__isnull=True, then=Value("not_sent")),
            When(roster_invitation_accepted__isnull=False, then=Value("accepted")),
            default=Value("sent"),
            output_field=CharField(),
        ),
        roster_invitation_delivery=Subquery(
            latest_invitation_job.values("delivery")[:1],
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
# ``invitationStatus`` values that select on the delivery state instead.
INVITATION_DELIVERY_FILTERS = {DELIVERY_QUEUED, DELIVERY_FAILED}


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
    if invitation_status in INVITATION_DELIVERY_FILTERS:
        queryset = queryset.filter(roster_invitation_delivery=invitation_status)
    elif invitation_status:
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
    is_organizer = participant.member_id == participant.event.organizer_id
    invitation_sent_at = getattr(participant, "roster_invitation_sent_at", None)
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
        # The organizer's own row: they answer for themselves under their account.
        "isOrganizer": is_organizer,
        "canOrganizerEditEmail": email_change_allowed(
            participant,
            invitation_accepted=getattr(participant, "roster_invitation_accepted", None)
            is not None,
            has_session=bool(getattr(participant, "roster_signed_in", False)),
        ),
        "invitationStatus": getattr(participant, "roster_invitation_status", "not_sent"),
        # "queued" while an invitation email waits to go out, "failed" once
        # delivery was given up on, otherwise null.
        "invitationDelivery": getattr(participant, "roster_invitation_delivery", None),
        "invitationSentAt": invitation_sent_at.isoformat() if invitation_sent_at else None,
        "version": participant.version,
    }


def _group_entry(group_id, name, member_ids, weights, included) -> dict:
    # The weight and the included flag shared by everyone counted in the
    # group, each ``None`` when they differ (or nobody is counted).
    shared = {weights[pk] for pk in member_ids}
    shared_included = {included[pk] for pk in member_ids}
    return {
        "id": group_id,
        "name": name,
        "count": len(member_ids),
        "weight": float(shared.pop()) if len(shared) == 1 else None,
        "included": shared_included.pop() if len(shared_included) == 1 else None,
    }


def group_stats(event, queryset) -> list[dict]:
    """Every group of the event with its head count and what its members share.

    Groups are listed in name order, empty ones included. A person counts
    once in each group they belong to, and someone flagged ``all_groups``
    counts in every group. When anyone belongs to no group at all, an
    ungrouped row (``id`` and ``name`` empty) closes the list.
    """

    weights = {}
    included = {}
    everywhere = set()
    for row in queryset.values("pk", "roster_weight", "roster_included", "all_groups"):
        weights[row["pk"]] = row["roster_weight"]
        included[row["pk"]] = bool(row["roster_included"])
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
        _group_entry(group.pk, group.name, members[group.pk] | everywhere, weights, included)
        for group in event.participant_groups.all()
    ]
    ungrouped = set(weights) - everywhere - set().union(*members.values())
    if ungrouped:
        stats.append(_group_entry(None, "", ungrouped, weights, included))
    return stats


def roster_totals(queryset, **counts) -> dict:
    """Head counts of ``queryset`` in one query.

    Always the five shared keys (``total``, ``submitted``, ``notSubmitted``,
    ``included``, ``excluded``); ``counts`` adds further ``Count`` aggregates
    under their own names.
    """

    totals = queryset.aggregate(
        total=Count("pk"),
        submitted=Count("pk", filter=Q(submitted=True)),
        included=Count("pk", filter=Q(roster_included=True)),
        **counts,
    )
    return {
        **totals,
        "notSubmitted": totals["total"] - totals["submitted"],
        "excluded": totals["total"] - totals["included"],
    }


def roster_stats(event, queryset, *, groups_queryset=None) -> dict:
    totals = roster_totals(queryset)
    # Totals follow the active filters; the group list always describes the
    # whole roster so organizers can manage groups while a filter is on.
    groups = group_stats(event, queryset if groups_queryset is None else groups_queryset)
    return {
        "total": totals["total"],
        "submitted": totals["submitted"],
        "notSubmitted": totals["notSubmitted"],
        "included": totals["included"],
        "excluded": totals["excluded"],
        "groups": groups,
    }


def not_invited_query(event) -> Q:
    """Rows a plain send (no resend) would queue an invitation for right now."""

    return (
        Q(roster_invitation_status="not_sent", organizer_managed=False)
        & ~Q(member_id=event.organizer_id)
        & ~Q(roster_email="")
        & (
            Q(roster_invitation_delivery__isnull=True)
            | Q(roster_invitation_delivery=DELIVERY_FAILED)
        )
    )


def roster_overall(event, queryset) -> dict:
    """Whole-roster counts for the header summary and the email menu.

    ``queryset`` is the unfiltered roster. ``remindable`` counts the
    invitations a reminder run would consider whether or not reminders are
    enabled; those are invitation rows, so ``total`` does not bound them.
    """

    totals = roster_totals(
        queryset,
        notInvited=Count("pk", filter=not_invited_query(event)),
        sending=Count("pk", filter=Q(roster_invitation_delivery=DELIVERY_QUEUED)),
        failed=Count("pk", filter=Q(roster_invitation_delivery=DELIVERY_FAILED)),
        noEmail=Count("pk", filter=Q(organizer_managed=True)),
    )
    return {
        "total": totals["total"],
        "submitted": totals["submitted"],
        "notSubmitted": totals["notSubmitted"],
        "included": totals["included"],
        "excluded": totals["excluded"],
        "notInvited": totals["notInvited"],
        "sending": totals["sending"],
        "failed": totals["failed"],
        "noEmail": totals["noEmail"],
        "remindable": reminder_candidates(event).count(),
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
