from django.urls import path

from apps.core.views.maintenance import MaintenanceBypassView

app_name = "core"

urlpatterns = [
    path("maintenance/bypass/", MaintenanceBypassView.as_view(), name="maintenance-bypass"),
]
