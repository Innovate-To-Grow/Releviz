from django.apps import AppConfig
from django.contrib.admin.apps import AdminConfig


class RelevizAdminConfig(AdminConfig):
    default_site = "apps.core.admin_site.RelevizAdminSite"


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
