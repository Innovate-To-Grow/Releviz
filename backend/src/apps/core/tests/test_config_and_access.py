import importlib
import os
import sys
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from apps.core.access import user_can_access_app


class AccessTests(SimpleTestCase):
    def test_user_can_access_app_variants(self):
        class User:
            is_authenticated = False
            is_superuser = False
            admin_apps = []

        user = User()
        self.assertFalse(user_can_access_app(user, "authn"))
        user.is_authenticated = True
        self.assertFalse(user_can_access_app(user, "authn"))
        user.admin_apps = ["authn"]
        self.assertTrue(user_can_access_app(user, "authn"))
        user.is_superuser = True
        self.assertTrue(user_can_access_app(user, "anything"))


class SettingsImportTests(SimpleTestCase):
    def tearDown(self):
        for name in [
            "config.asgi",
            "config.wsgi",
            "config.settings.e2e",
            "config.settings.local",
            "config.settings.production",
            "config.settings.test_postgres",
        ]:
            sys.modules.pop(name, None)

    def test_local_settings_extra_hosts_branch(self):
        sys.modules.pop("config.settings.local", None)
        with patch.dict(os.environ, {"EXTRA_ALLOWED_HOSTS": "example.com, api.example.com"}):
            module = importlib.import_module("config.settings.local")
        self.assertIn("example.com", module.ALLOWED_HOSTS)

    def test_postgres_and_e2e_settings_import_with_env(self):
        with patch.dict(
            os.environ,
            {
                "DB_ENGINE": "django.db.backends.postgresql",
                "DB_NAME": "db",
                "DB_USER": "user",
                "DB_PASSWORD": "pw",
                "DB_HOST": "dbhost",
                "DB_PORT": "5544",
                "DB_TEST_NAME": "test_db",
                "EMAIL_FILE_PATH": "/tmp/maildir",
                "FRONTEND_URL": "http://front.test",
                "BACKEND_URL": "http://back.test",
            },
        ):
            postgres = importlib.import_module("config.settings.test_postgres")
            e2e = importlib.import_module("config.settings.e2e")
        self.assertEqual(postgres.DATABASES["default"]["PORT"], "5544")
        self.assertEqual(e2e.EMAIL_FILE_PATH, "/tmp/maildir")
        self.assertEqual(e2e.CORS_ALLOWED_ORIGINS, ["http://front.test", "http://back.test"])

    def test_production_settings_missing_and_complete_env(self):
        sys.modules.pop("config.settings.production", None)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ImproperlyConfigured):
                importlib.import_module("config.settings.production")

        sys.modules.pop("config.settings.production", None)
        with patch.dict(os.environ, {"DJANGO_SECRET_KEY": "secret"}, clear=True):
            with self.assertRaises(ImproperlyConfigured):
                importlib.import_module("config.settings.production")

        sys.modules.pop("config.settings.production", None)
        env = {
            "DJANGO_SECRET_KEY": "secret",
            "DJANGO_ALLOWED_HOSTS": "example.com, api.example.com",
            "FRONTEND_URL": "https://app.example.com",
            "BACKEND_URL": "https://api.example.com",
            "DB_NAME": "db",
            "DB_USER": "user",
            "DB_PASSWORD": "pw",
            "DB_HOST": "host",
            "DB_PORT": "5439",
            "DB_CONN_MAX_AGE": "7",
            "DB_SSLMODE": "verify-full",
            "CORS_ALLOWED_ORIGINS": "https://app.example.com",
            "CSRF_TRUSTED_ORIGINS": "https://app.example.com",
            "DJANGO_SECURE_SSL_REDIRECT": "0",
            "EMAIL_BACKEND": "django.core.mail.backends.locmem.EmailBackend",
            "DEFAULT_FROM_EMAIL": "releviz@example.com",
            "REQUIRE_ENCRYPTED_PASSWORDS": "0",
            "DJANGO_FIELD_ENCRYPTION_KEY": "test encryption key",
            "METRICS_BEARER_TOKEN": "test-metrics-token",
            "FEEDBACK_SUBMISSION_RETENTION_DAYS": "365",
        }
        for invalid_retention in ["invalid", "0"]:
            sys.modules.pop("config.settings.production", None)
            with patch.dict(
                os.environ,
                {**env, "FEEDBACK_SUBMISSION_RETENTION_DAYS": invalid_retention},
                clear=True,
            ):
                with self.assertRaisesMessage(
                    ImproperlyConfigured,
                    "FEEDBACK_SUBMISSION_RETENTION_DAYS must be a positive integer.",
                ):
                    importlib.import_module("config.settings.production")

        sys.modules.pop("config.settings.production", None)
        with patch.dict(os.environ, env, clear=True):
            module = importlib.import_module("config.settings.production")
        self.assertEqual(module.ALLOWED_HOSTS, ["example.com", "api.example.com"])
        self.assertIn("whitenoise.middleware.WhiteNoiseMiddleware", module.MIDDLEWARE)
        self.assertEqual(
            module.STORAGES["staticfiles"]["BACKEND"],
            "whitenoise.storage.CompressedManifestStaticFilesStorage",
        )
        self.assertFalse(module.REQUIRE_ENCRYPTED_PASSWORDS)
        self.assertEqual(module.DATABASES["default"]["OPTIONS"]["sslmode"], "verify-full")
        self.assertFalse(module.SECURE_SSL_REDIRECT)
        self.assertEqual(module.SECURE_HSTS_SECONDS, 31_536_000)
        self.assertTrue(module.SECURE_HSTS_INCLUDE_SUBDOMAINS)
        self.assertTrue(module.SECURE_HSTS_PRELOAD)
        self.assertTrue(module.USE_SES_EMAIL_PROVIDER)
        self.assertEqual(module.METRICS_BEARER_TOKEN, "test-metrics-token")
        self.assertEqual(module.FEEDBACK_SUBMISSION_RETENTION.days, 365)

    def test_asgi_and_wsgi_imports(self):
        asgi = importlib.import_module("config.asgi")
        wsgi = importlib.import_module("config.wsgi")
        self.assertTrue(callable(asgi.application))
        self.assertTrue(callable(wsgi.application))
