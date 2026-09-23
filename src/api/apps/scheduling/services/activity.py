"""A compact digest of everything the organizer workspace shows.

The workspace polls this instead of re-reading the roster and results on a
timer: each section carries the few values that move whenever new information
is collected, so a client only reloads a section when its digest changed.
"""

from __future__ import annotations

from django.db.models import Count, Max, Q

from apps.scheduling.models import Event

from .results import (
    ensure_result_snapshot,
    flush_event_result_invalidations,
    result_snapshot_state,
)


def roster_activity(event: Event) -> dict:
    """Head counts plus the latest write to any person, invitation, or weight.

    Every roster-facing change (joining, drafts, submissions, invitation
    delivery and opens, organizer weight or group edits) bumps one of these
    ``updated_at`` columns, and removals move the totals.
    """

    people = event.participants.aggregate(
        total=Count("pk"),
        submitted=Count("pk", filter=Q(submitted=True)),
        changed_at=Max("updated_at"),
    )
    invitations = event.invitations.aggregate(changed_at=Max("updated_at"))
    weights = event.weights.aggregate(changed_at=Max("updated_at"))
    timestamps = [
        value
        for value in (people["changed_at"], invitations["changed_at"], weights["changed_at"])
        if value is not None
    ]
    changed_at = max(timestamps) if timestamps else None
    return {
        "total": people["total"],
        "submitted": people["submitted"],
        "changedAt": changed_at.isoformat() if changed_at is not None else None,
    }


def event_activity(event: Event) -> dict:
    """Digest the event, its result snapshot, and its roster in one read.

    Pending result invalidations are folded into the revision first, exactly
    as the results endpoint does, so a response that arrived a moment ago is
    already visible as a refreshing snapshot.
    """

    flush_event_result_invalidations(event)
    snapshot = ensure_result_snapshot(event)
    return {
        "event": {
            "version": event.version,
            "status": event.status,
            "resultsRevision": event.results_revision,
        },
        "results": result_snapshot_state(snapshot),
        "roster": roster_activity(event),
    }
