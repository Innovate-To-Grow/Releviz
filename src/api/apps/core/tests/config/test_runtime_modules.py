"""Coverage and smoke tests for executable Django configuration modules."""

import importlib
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings


class RuntimeConfigurationModuleTests(SimpleTestCase):
    def test_asgi_and_wsgi_entrypoints_initialize(self):
        import config.asgi as asgi
        import config.wsgi as wsgi

        self.assertIsNotNone(importlib.reload(asgi).application)
        self.assertIsNotNone(importlib.reload(wsgi).application)

    def test_local_settings_accept_extra_hosts(self):
        import config.settings.local as local_settings

        with patch.dict("os.environ", {"EXTRA_ALLOWED_HOSTS": "dev.example, preview.example"}):
            reloaded = importlib.reload(local_settings)
        self.assertIn("dev.example", reloaded.ALLOWED_HOSTS)
        self.assertIn("preview.example", reloaded.ALLOWED_HOSTS)

        with patch.dict("os.environ", {"EXTRA_ALLOWED_HOSTS": ""}):
            importlib.reload(local_settings)

    def test_postgres_and_e2e_settings_import_with_overrides(self):
        import config.settings.e2e as e2e_settings
        import config.settings.test_postgres as postgres_settings

        env = {
            "DB_ENGINE": "django.db.backends.postgresql",
            "DB_NAME": "coverage_db",
            "DB_USER": "coverage_user",
            "DB_PASSWORD": "coverage_password",
            "DB_HOST": "postgres.example",
            "DB_PORT": "5439",
            "DB_TEST_NAME": "coverage_test_db",
            "FRONTEND_URL": "http://frontend.example",
            "BACKEND_URL": "http://backend.example",
            "EMAIL_FILE_PATH": "/tmp/releviz-coverage-mail",
        }
        with patch.dict("os.environ", env):
            postgres = importlib.reload(postgres_settings)
            e2e = importlib.reload(e2e_settings)

        self.assertEqual(postgres.DATABASES["default"]["NAME"], "coverage_db")
        self.assertEqual(postgres.DATABASES["default"]["TEST"]["NAME"], "coverage_test_db")
        self.assertEqual(
            e2e.CORS_ALLOWED_ORIGINS,
            [env["FRONTEND_URL"], env["BACKEND_URL"]],
        )
        self.assertEqual(e2e.EMAIL_FILE_PATH, "/tmp/releviz-coverage-mail")

    def test_legacy_url_prefix_branch_is_importable(self):
        import config.urls as urls

        try:
            with override_settings(ENABLE_LEGACY_API_PREFIX=True):
                reloaded = importlib.reload(urls)
                self.assertTrue(
                    any(str(pattern.pattern).startswith("api/") for pattern in reloaded.urlpatterns)
                )
        finally:
            with override_settings(ENABLE_LEGACY_API_PREFIX=False):
                importlib.reload(urls)
