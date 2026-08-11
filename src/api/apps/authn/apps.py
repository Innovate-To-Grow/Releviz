from django.apps import AppConfig


class AuthnConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.authn"
    label = "authn"

    # noinspection PyMethodMayBeStatic
    def ready(self):
        try:
            from . import signals  # noqa: F401
        except ImportError:
            pass
