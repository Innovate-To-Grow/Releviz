"""Root URL configuration."""

from django.contrib import admin
from django.urls import include, path

from apps.authn.views_admin_login import AdminLoginView

admin.site.site_title = "Scheduler Admin"
admin.site.site_header = "Scheduler"
admin.site.index_title = "Welcome to Scheduler Admin"

urlpatterns = [
    path("admin/login/", AdminLoginView.as_view(), name="admin-login"),
    path("admin/", admin.site.urls),
    path("authn/", include("apps.authn.urls")),
    path("api/", include("apps.scheduling.urls")),
]
