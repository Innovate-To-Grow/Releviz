from django.urls import path

from apps.scheduling import views

urlpatterns = [
    path("health", views.health_ready, name="api-health"),
    path("health/live", views.health_live, name="api-health-live"),
    path("health/ready", views.health_ready, name="api-health-ready"),
    path("dashboard/events", views.DashboardEventsView.as_view(), name="api-dashboard-events"),
    path(
        "events/participants/update/unhide",
        views.ParticipantUnhideView.as_view(),
        name="api-participant-unhide",
    ),
    path(
        "events/participants/update",
        views.ParticipantUpdateView.as_view(),
        name="api-participant-update",
    ),
    path("events/participants", views.ParticipantsView.as_view(), name="api-participants"),
    path(
        "events/invitations/open",
        views.EventInvitationOpenView.as_view(),
        name="api-event-invitation-open",
    ),
    path("events/invitations", views.EventInvitationsView.as_view(), name="api-event-invitations"),
    path(
        "events/finalization/preview",
        views.EventFinalizationPreviewView.as_view(),
        name="api-event-finalization-preview",
    ),
    path(
        "events/finalization/calendar",
        views.EventFinalCalendarView.as_view(),
        name="api-event-final-calendar",
    ),
    path(
        "events/finalization",
        views.EventFinalizationView.as_view(),
        name="api-event-finalization",
    ),
    path("events/lifecycle", views.EventLifecycleView.as_view(), name="api-event-lifecycle"),
    path("events/reminders", views.EventRemindersView.as_view(), name="api-event-reminders"),
    path("events/results", views.EventResultsView.as_view(), name="api-event-results"),
    path("events/weights", views.WeightsView.as_view(), name="api-weights"),
    path("events/duplicate", views.EventDuplicateView.as_view(), name="api-event-duplicate"),
    path("events", views.EventsView.as_view(), name="api-events"),
]
