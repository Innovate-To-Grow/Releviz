"""Scheduling admin registrations."""

from .events import (  # noqa: F401 - register admin
    EventAdmin,
    EventDeletionRecordAdmin,
    EventDuplicationRequestAdmin,
)
from .finalization import (  # noqa: F401 - register admin
    FinalizationRequestAdmin,
    FinalMeetingAdmin,
)
from .participants import (  # noqa: F401 - register admin
    EventInvitationAdmin,
    ParticipantAdmin,
    TemporaryEventSessionAdmin,
    UserEventAdmin,
    WeightAdmin,
)
from .results import (  # noqa: F401 - register admin
    EventResultSnapshotAdmin,
    ScheduleEditRecordAdmin,
)
from .roster import (  # noqa: F401 - register admin
    RosterImportBatchAdmin,
    RosterImportReceiptAdmin,
    RosterImportRowAdmin,
)
