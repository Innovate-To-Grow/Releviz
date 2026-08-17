"""
Scheduling app admin configuration.

One module per model group, mirroring ``apps/scheduling/models``:
- events: Event and its duplication/deletion audit records
- participants: Participant, Weight, UserEvent, ScheduleEditRecord
- invitations: EventInvitation, TemporaryEventSession
- finalization: FinalMeeting, FinalizationRequest
- results: EventResultSnapshot
- roster: roster import batches, rows, and receipts
"""

from .events import (  # noqa: F401 - register admin
    EventAdmin,
    EventDeletionRecordAdmin,
    EventDuplicationRequestAdmin,
)
from .finalization import FinalizationRequestAdmin, FinalMeetingAdmin  # noqa: F401 - register admin
from .invitations import (  # noqa: F401 - register admin
    EventInvitationAdmin,
    TemporaryEventSessionAdmin,
)
from .participants import (  # noqa: F401 - register admin
    ParticipantAdmin,
    ScheduleEditRecordAdmin,
    UserEventAdmin,
    WeightAdmin,
)
from .results import EventResultSnapshotAdmin  # noqa: F401 - register admin
from .roster import (  # noqa: F401 - register admin
    RosterImportBatchAdmin,
    RosterImportReceiptAdmin,
    RosterImportRowAdmin,
)

__all__ = [
    # Events
    "EventAdmin",
    "EventDeletionRecordAdmin",
    "EventDuplicationRequestAdmin",
    # Finalization
    "FinalMeetingAdmin",
    "FinalizationRequestAdmin",
    # Invitations
    "EventInvitationAdmin",
    "TemporaryEventSessionAdmin",
    # Participants
    "ParticipantAdmin",
    "ScheduleEditRecordAdmin",
    "UserEventAdmin",
    "WeightAdmin",
    # Results
    "EventResultSnapshotAdmin",
    # Roster
    "RosterImportBatchAdmin",
    "RosterImportReceiptAdmin",
    "RosterImportRowAdmin",
]
