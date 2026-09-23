"""Event endpoints."""

from .activity import EventActivityView
from .crud import EventDuplicateView, EventsView
from .dashboard import DashboardEventsView
from .lifecycle import EventLifecycleView
from .results import EventResultsView

__all__ = [
    "DashboardEventsView",
    "EventActivityView",
    "EventDuplicateView",
    "EventLifecycleView",
    "EventResultsView",
    "EventsView",
]
