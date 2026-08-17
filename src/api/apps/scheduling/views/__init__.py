"""Scheduling app views export.

Grouped by resource: ``events``, ``participants``, ``invitations``,
``finalization``, ``roster``, ``temporary_access``, plus the ``health`` probes
and the ``operations`` delivery endpoints.
"""

from .events import (
    DashboardEventsView,
    EventDuplicateView,
    EventLifecycleView,
    EventResultsView,
    EventsView,
)
from .finalization import (
    EventFinalCalendarView,
    EventFinalizationPreviewView,
    EventFinalizationView,
)
from .health import health_live, health_ready
from .invitations import EventInvitationOpenView, EventInvitationsView, EventRemindersView
from .operations import DeliveryRequestView
from .participants import (
    ManagedParticipantView,
    ParticipantsView,
    ParticipantUnhideView,
    ParticipantUpdateView,
    WeightsView,
)
from .roster import (
    RosterBulkView,
    RosterImportCollectionView,
    RosterImportCommitView,
    RosterImportDetailView,
    RosterImportRowsView,
    RosterParticipantScheduleView,
    RosterParticipantView,
    RosterView,
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
    # Health
    "health_live",
    "health_ready",
    # Events
    "DashboardEventsView",
    "EventDuplicateView",
    "EventLifecycleView",
    "EventResultsView",
    "EventsView",
    # Participants
    "ManagedParticipantView",
    "ParticipantUnhideView",
    "ParticipantUpdateView",
    "ParticipantsView",
    "WeightsView",
    # Invitations
    "EventInvitationOpenView",
    "EventInvitationsView",
    "EventRemindersView",
    # Finalization
    "EventFinalCalendarView",
    "EventFinalizationPreviewView",
    "EventFinalizationView",
    # Roster
    "RosterBulkView",
    "RosterImportCollectionView",
    "RosterImportCommitView",
    "RosterImportDetailView",
    "RosterImportRowsView",
    "RosterParticipantScheduleView",
    "RosterParticipantView",
    "RosterView",
    # Temporary access
    "TemporaryAccessLogoutView",
    "TemporaryAccessParticipantView",
    "TemporaryAccessRequestCodeView",
    "TemporaryAccessSessionView",
    "TemporaryAccessUpgradeRegistrationView",
    "TemporaryAccessVerifyView",
    # Operations
    "DeliveryRequestView",
]
