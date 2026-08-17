"""Event endpoints."""

from .crud import EventDuplicateView, EventsView
from .dashboard import DashboardEventsView
from .lifecycle import EventLifecycleView
from .results import EventResultsView

__all__ = [
    "DashboardEventsView",
    "EventDuplicateView",
    "EventLifecycleView",
    "EventResultsView",
    "EventsView",
]
