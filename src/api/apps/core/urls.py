from django.urls import path

from apps.core.middleware import csp_report
from apps.core.views.maintenance import MaintenanceBypassView

app_name = "core"

urlpatterns = [
    path("csp-report/", csp_report, name="csp-report"),
    path("maintenance/bypass/", MaintenanceBypassView.as_view(), name="maintenance-bypass"),
]
