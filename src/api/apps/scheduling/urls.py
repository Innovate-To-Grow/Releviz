from django.urls import path

from apps.scheduling import operations_views, roster_views, views

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
    path(
        "events/participants/managed",
        views.ManagedParticipantView.as_view(),
        name="api-managed-participant",
    ),
    path("events/participants", views.ParticipantsView.as_view(), name="api-participants"),
    path(
        "events/temp-access/request-code",
        views.TemporaryAccessRequestCodeView.as_view(),
        name="api-temp-access-request-code",
    ),
    path(
        "events/temp-access/verify",
        views.TemporaryAccessVerifyView.as_view(),
        name="api-temp-access-verify",
    ),
    path(
        "events/temp-access/session",
        views.TemporaryAccessSessionView.as_view(),
        name="api-temp-access-session",
    ),
    path(
        "events/temp-access/upgrade-registration",
        views.TemporaryAccessUpgradeRegistrationView.as_view(),
        name="api-temp-access-upgrade-registration",
    ),
    path(
        "events/temp-access/participant",
        views.TemporaryAccessParticipantView.as_view(),
        name="api-temp-access-participant",
    ),
    path(
        "events/temp-access/logout",
        views.TemporaryAccessLogoutView.as_view(),
        name="api-temp-access-logout",
    ),
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
    path("events/launch", operations_views.EventLaunchView.as_view(), name="api-event-launch"),
    path(
        "events/delivery-requests/<uuid:request_id>",
        operations_views.DeliveryRequestView.as_view(),
        name="api-event-delivery-request",
    ),
    path(
        "events/roster-imports/<uuid:import_id>/rows",
        roster_views.RosterImportRowsView.as_view(),
        name="api-roster-import-rows",
    ),
    path(
        "events/roster-imports/<uuid:import_id>/commit",
        roster_views.RosterImportCommitView.as_view(),
        name="api-roster-import-commit",
    ),
    path(
        "events/roster-imports/<uuid:import_id>",
        roster_views.RosterImportDetailView.as_view(),
        name="api-roster-import-detail",
    ),
    path(
        "events/roster-imports",
        roster_views.RosterImportCollectionView.as_view(),
        name="api-roster-imports",
    ),
    path("events/roster/bulk", roster_views.RosterBulkView.as_view(), name="api-roster-bulk"),
    path(
        "events/roster/<uuid:participant_id>/schedule",
        roster_views.RosterParticipantScheduleView.as_view(),
        name="api-roster-participant-schedule",
    ),
    path(
        "events/roster/<uuid:participant_id>",
        roster_views.RosterParticipantView.as_view(),
        name="api-roster-participant",
    ),
    path("events/roster", roster_views.RosterView.as_view(), name="api-roster"),
    path("events/results", views.EventResultsView.as_view(), name="api-event-results"),
    path("events/weights", views.WeightsView.as_view(), name="api-weights"),
    path("events/duplicate", views.EventDuplicateView.as_view(), name="api-event-duplicate"),
    path("events", views.EventsView.as_view(), name="api-events"),
]
