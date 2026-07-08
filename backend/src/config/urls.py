"""Root URL configuration."""

from django.contrib import admin
from django.urls import include, path

from apps.authn.views_admin_login import AdminLoginView

admin.site.site_title = "Releviz Admin"
admin.site.site_header = "Releviz Admin"
admin.site.index_title = "Operations"

urlpatterns = [
    path("admin/login/", AdminLoginView.as_view(), name="admin-login"),
    path("admin/", admin.site.urls),
    path("authn/", include("apps.authn.urls")),
    path("api/", include("apps.scheduling.urls")),
]
