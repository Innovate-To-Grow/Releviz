from django.urls import path

from apps.scheduling import views

urlpatterns = [
    path("health", views.health, name="api-health"),
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
    path("events/weights", views.WeightsView.as_view(), name="api-weights"),
    path("events", views.EventsView.as_view(), name="api-events"),
]
