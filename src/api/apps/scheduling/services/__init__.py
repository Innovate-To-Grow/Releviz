"""Scheduling app services.

The layer is grouped by domain; import from the subpackage that owns the
behaviour, for example ``from apps.scheduling.services.invitations import
upsert_and_send_invitations``.

- ``availability`` – shape and validation of availability arrays
- ``events`` – configuration, lifecycle, and write operations for events
- ``fingerprints`` – stable hashes for idempotent requests
- ``finalization`` – confirming and canceling the final meeting
- ``ics`` – iCalendar attachments
- ``invitations`` – invitation delivery, reminders, and status
- ``results`` – aggregation, recommendations, and result snapshots
- ``roster_imports`` – roster preview, validation, and commit
- ``slots`` – slot geometry for an event
- ``temporary_access`` – event-scoped temporary sessions
"""

from . import (
    availability,
    events,
    finalization,
    fingerprints,
    ics,
    invitations,
    results,
    roster_imports,
    slots,
    temporary_access,
)

__all__ = [
    "availability",
    "events",
    "finalization",
    "fingerprints",
    "ics",
    "invitations",
    "results",
    "roster_imports",
    "slots",
    "temporary_access",
]
