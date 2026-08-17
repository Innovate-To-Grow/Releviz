"""
Scheduling views export.

One module per endpoint group; ``urls.py`` resolves every name from here.
Shared response helpers live in ``apps.scheduling.views.helpers``.
"""

from .deliveries import DeliveryRequestView
from .events import (
    DashboardEventsView,
    EventDuplicateView,
    EventLifecycleView,
    EventsView,
)
from .finalization import (
    EventFinalCalendarView,
    EventFinalizationPreviewView,
    EventFinalizationView,
)
from .health import health_live, health_ready
from .invitations import (
    EventInvitationOpenView,
    EventInvitationsView,
    EventRemindersView,
)
from .participants import (
    ManagedParticipantView,
    ParticipantsView,
    ParticipantUnhideView,
    ParticipantUpdateView,
    WeightsView,
)
from .results import EventResultsView
from .roster import (
    RosterBulkView,
    RosterParticipantScheduleView,
    RosterParticipantView,
    RosterView,
)
from .roster_imports import (
    RosterImportCollectionView,
    RosterImportCommitView,
    RosterImportDetailView,
    RosterImportRowsView,
)
from .temporary_access import (
    TemporaryAccessLogoutView,
    TemporaryAccessParticipantView,
    TemporaryAccessRequestCodeView,
    TemporaryAccessSessionView,
    TemporaryAccessUpgradeRegistrationView,
    TemporaryAccessVerifyView,
)

__all__ = [
    # Health probes
    "health_live",
    "health_ready",
    # Events
    "DashboardEventsView",
    "EventDuplicateView",
    "EventLifecycleView",
    "EventsView",
    # Participants
    "ManagedParticipantView",
    "ParticipantUnhideView",
    "ParticipantUpdateView",
    "ParticipantsView",
    "WeightsView",
    # Results
    "EventResultsView",
    # Invitations
    "EventInvitationOpenView",
    "EventInvitationsView",
    "EventRemindersView",
    # Temporary access
    "TemporaryAccessLogoutView",
    "TemporaryAccessParticipantView",
    "TemporaryAccessRequestCodeView",
    "TemporaryAccessSessionView",
    "TemporaryAccessUpgradeRegistrationView",
    "TemporaryAccessVerifyView",
    # Finalization
    "EventFinalCalendarView",
    "EventFinalizationPreviewView",
    "EventFinalizationView",
    # Roster
    "RosterBulkView",
    "RosterParticipantScheduleView",
    "RosterParticipantView",
    "RosterView",
    # Roster imports
    "RosterImportCollectionView",
    "RosterImportCommitView",
    "RosterImportDetailView",
    "RosterImportRowsView",
    # Deliveries
    "DeliveryRequestView",
]
