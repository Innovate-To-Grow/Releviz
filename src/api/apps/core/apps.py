from django.apps import AppConfig


class CoreConfig(AppConfig):
    """Core application for shared utilities and base models."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    label = "core"
