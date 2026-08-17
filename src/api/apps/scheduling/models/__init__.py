"""
Scheduling app models export.

Aggregates every model so callers can keep importing from
``apps.scheduling.models``. ``default_weekdays`` is re-exported because the
initial migration references it as ``apps.scheduling.models.default_weekdays``.
"""

from .events import Event, EventDeletionRecord, EventDuplicationRequest, default_weekdays
from .finalization import FinalizationRequest, FinalMeeting
from .invitations import EventInvitation, TemporaryEventSession
from .participants import Participant, ScheduleEditRecord, UserEvent, Weight
from .results import EventResultInvalidation, EventResultSnapshot
from .roster import (
    RosterBulkUpdateReceipt,
    RosterImportBatch,
    RosterImportReceipt,
    RosterImportRow,
)

__all__ = [
    # Events
    "Event",
    "EventDeletionRecord",
    "EventDuplicationRequest",
    "default_weekdays",
    # Finalization
    "FinalMeeting",
    "FinalizationRequest",
    # Invitations
    "EventInvitation",
    "TemporaryEventSession",
    # Participants
    "Participant",
    "ScheduleEditRecord",
    "UserEvent",
    "Weight",
    # Results
    "EventResultInvalidation",
    "EventResultSnapshot",
    # Roster
    "RosterBulkUpdateReceipt",
    "RosterImportBatch",
    "RosterImportReceipt",
    "RosterImportRow",
]
