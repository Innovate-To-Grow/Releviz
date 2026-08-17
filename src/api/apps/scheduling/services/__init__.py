"""
Scheduling business logic. Views stay thin; every rule lives in one module here.

Import the module you need (``from apps.scheduling.services.slots import ...``)
rather than re-exporting from this package: several modules depend on each other,
and eager re-exports here would turn those into import cycles.

====================  ==========================================================
Module                What it owns
====================  ==========================================================
``aggregation``       Response classification and weighted result totals
``calendar``          iCalendar (.ics) attachment generation
``deliveries``        Invitation/reminder delivery requests and job enqueueing
``emails``            Subject and body copy for scheduling emails
``event_management``  Event create/update/duplicate/delete with idempotency
``finalization``      Final-meeting normalization, confirmation, cancelation
``invitations``       Invitation records, roster onboarding, status marking
``lifecycle``         Event status transitions and write-window checks
``recommendations``   Ranked meeting-time suggestions
``result_snapshots``  Revisioned result snapshots and the recompute worker
``roster``            Roster queries, filters, and organizer edits
``roster_imports``    Staged CSV/XLSX/paste import preview and commit
``slots``             Slot geometry, availability arrays, timezone folds
``temp_access``       Temporary event sessions for invited participants
====================  ==========================================================
"""
