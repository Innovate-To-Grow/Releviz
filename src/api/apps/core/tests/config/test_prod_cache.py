import importlib
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

PROD_ENV = {
    "DJANGO_SECRET_KEY": "test-secret-key",
    "DJANGO_ALLOWED_HOSTS": "api.example.com",
    "DB_NAME": "itg_prod",
    "DB_USER": "itg_user",
    "DB_PASSWORD": "itg_password",
    "DB_HOST": "db.example.com",
    "AWS_STORAGE_BUCKET_NAME": "itg-static-assets",
    "BACKEND_URL": "https://api.example.com",
}


def reload_prod_settings():
    import config.settings.components.production as production_settings

    import config.settings.production as prod_settings

    importlib.reload(production_settings)
    return importlib.reload(prod_settings)


class ProductionCacheSettingsTests(SimpleTestCase):
    def test_prod_uses_redis_cache_when_configured(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "REDIS_URL": "redis://cache.example.com:6379/0"},
            clear=True,
        ):
            prod_settings = reload_prod_settings()

        self.assertEqual(
            prod_settings.CACHES["default"]["BACKEND"], "django_redis.cache.RedisCache"
        )
        self.assertEqual(
            prod_settings.CACHES["default"]["LOCATION"], "redis://cache.example.com:6379/0"
        )

    def test_prod_uses_file_based_cache_without_redis(self):
        cache_dir = "/tmp/i2g-test-cache"
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "REDIS_URL": "", "DJANGO_CACHE_DIR": cache_dir},
            clear=True,
        ):
            prod_settings = reload_prod_settings()

        self.assertEqual(
            prod_settings.CACHES["default"]["BACKEND"],
            "django.core.cache.backends.filebased.FileBasedCache",
        )
        self.assertEqual(prod_settings.CACHES["default"]["LOCATION"], cache_dir)

    def test_prod_requires_secret_key(self):
        env = {key: value for key, value in PROD_ENV.items() if key != "DJANGO_SECRET_KEY"}
        with patch.dict("os.environ", env, clear=True):
            with self.assertRaisesMessage(
                ImproperlyConfigured, "DJANGO_SECRET_KEY must be set in production."
            ):
                reload_prod_settings()

    def test_prod_staticfiles_overwrite_release_assets(self):
        with patch.dict("os.environ", PROD_ENV, clear=True):
            prod_settings = reload_prod_settings()

        self.assertFalse(prod_settings.STORAGES["default"]["OPTIONS"]["file_overwrite"])
        self.assertTrue(prod_settings.STORAGES["staticfiles"]["OPTIONS"]["file_overwrite"])

    def test_prod_installs_csp_middleware_after_base_initialization(self):
        with patch.dict("os.environ", PROD_ENV, clear=True):
            prod_settings = reload_prod_settings()

        self.assertIn(
            "apps.core.middleware.ContentSecurityPolicyMiddleware", prod_settings.MIDDLEWARE
        )

    def test_prod_csp_enforcement_is_an_explicit_toggle(self):
        with patch.dict(
            "os.environ",
            {
                **PROD_ENV,
                "CSP_REPORT_ONLY": "false",
            },
            clear=True,
        ):
            prod_settings = reload_prod_settings()

        self.assertFalse(prod_settings.CSP_REPORT_ONLY)
        self.assertEqual(prod_settings.CSP_SCRIPT_SOURCES, ("'self'", "https://cdn.jsdelivr.net"))
        self.assertEqual(
            prod_settings.CSP_STYLE_SOURCES, ("'self'", "https://fonts.googleapis.com")
        )
        self.assertEqual(
            prod_settings.CSP_FONT_SOURCES, ("'self'", "data:", "https://fonts.gstatic.com")
        )
        self.assertEqual(
            prod_settings.CSP_CONNECT_SOURCES,
            ("'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"),
        )
