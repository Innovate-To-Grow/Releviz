"""Root URL configuration."""

from django.conf import settings
from django.contrib import admin
from django.urls import include, path

from apps.authn.views import AdminLoginView

admin.site.site_title = "Releviz Admin"
admin.site.site_header = "Releviz"
admin.site.index_title = "Welcome to Releviz Admin"

urlpatterns = [
    path("admin/login/", AdminLoginView.as_view(), name="admin-login"),
    path("admin/", admin.site.urls),
    path("authn/", include("apps.authn.urls")),
    path("", include("apps.core.urls")),
    path("", include("apps.scheduling.urls")),
]

# The first production release on the API subdomain keeps the previous prefix
# long enough for the already-deployed frontend rollback points to remain
# usable. The protected deployment workflow disables this compatibility route
# after the new Amplify and ECS frontend artifacts pass production smoke tests.
if settings.ENABLE_LEGACY_API_PREFIX:
    urlpatterns += [
        path("api/", include("apps.core.urls")),
        path("api/", include("apps.scheduling.urls")),
    ]
