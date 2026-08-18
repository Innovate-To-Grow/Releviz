"""Production settings tests for the current API deployment contract."""

import importlib
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

PROD_ENV = {
    "DJANGO_SECRET_KEY": "test-secret-key",
    "DJANGO_ALLOWED_HOSTS": "api.example.com",
    "FRONTEND_URL": "https://app.example.com",
    "BACKEND_URL": "https://api.example.com",
    "DJANGO_FIELD_ENCRYPTION_KEY": "test-field-key",
    "METRICS_BEARER_TOKEN": "test-metrics-token",
    "DB_NAME": "releviz_prod",
    "DB_USER": "releviz_user",
    "DB_PASSWORD": "releviz_password",
    "DB_HOST": "db.example.com",
}


def reload_prod_settings():
    import config.settings.production as prod_settings

    return importlib.reload(prod_settings)


class ProductionSettingsTests(SimpleTestCase):
    def test_valid_environment_builds_current_database_storage_and_security_settings(self):
        with patch.dict("os.environ", PROD_ENV, clear=True):
            settings = reload_prod_settings()

        self.assertEqual(
            settings.DATABASES["default"],
            {
                "ENGINE": "django.db.backends.postgresql",
                "NAME": "releviz_prod",
                "USER": "releviz_user",
                "PASSWORD": "releviz_password",
                "HOST": "db.example.com",
                "PORT": "5432",
                "CONN_MAX_AGE": 60,
                "CONN_HEALTH_CHECKS": True,
                "OPTIONS": {"sslmode": "require"},
            },
        )
        self.assertEqual(
            settings.STORAGES["staticfiles"]["BACKEND"],
            "whitenoise.storage.CompressedManifestStaticFilesStorage",
        )
        self.assertTrue(settings.SECURE_SSL_REDIRECT)
        self.assertTrue(settings.SESSION_COOKIE_SECURE)
        self.assertEqual(settings.AUTH_REFRESH_COOKIE_SAMESITE, "None")

    def test_current_environment_overrides_are_parsed(self):
        env = {
            **PROD_ENV,
            "DJANGO_ALLOWED_HOSTS": "api.example.com, internal.example.com ",
            "CORS_ALLOWED_ORIGINS": "https://one.example, https://two.example",
            "CSRF_TRUSTED_ORIGINS": "https://one.example",
            "DB_ENGINE": "django.db.backends.sqlite3",
            "DB_PORT": "6432",
            "DB_CONN_MAX_AGE": "10",
            "DB_SSLMODE": "verify-full",
            "ENABLE_LEGACY_API_PREFIX": "1",
            "REQUIRE_ENCRYPTED_PASSWORDS": "0",
            "USE_SES_EMAIL_PROVIDER": "0",
            "DJANGO_SECURE_SSL_REDIRECT": "0",
            "EMAIL_BACKEND": "django.core.mail.backends.locmem.EmailBackend",
            "DEFAULT_FROM_EMAIL": "sender@example.com",
        }
        with patch.dict("os.environ", env, clear=True):
            settings = reload_prod_settings()

        self.assertEqual(settings.ALLOWED_HOSTS, ["api.example.com", "internal.example.com"])
        self.assertEqual(
            settings.CORS_ALLOWED_ORIGINS,
            ["https://one.example", "https://two.example"],
        )
        self.assertEqual(settings.CSRF_TRUSTED_ORIGINS, ["https://one.example"])
        self.assertEqual(settings.DATABASES["default"]["ENGINE"], "django.db.backends.sqlite3")
        self.assertEqual(settings.DATABASES["default"]["PORT"], "6432")
        self.assertEqual(settings.DATABASES["default"]["CONN_MAX_AGE"], 10)
        self.assertEqual(settings.DATABASES["default"]["OPTIONS"], {"sslmode": "verify-full"})
        self.assertTrue(settings.ENABLE_LEGACY_API_PREFIX)
        self.assertFalse(settings.REQUIRE_ENCRYPTED_PASSWORDS)
        self.assertFalse(settings.USE_SES_EMAIL_PROVIDER)
        self.assertFalse(settings.SECURE_SSL_REDIRECT)
        self.assertEqual(settings.DEFAULT_FROM_EMAIL, "sender@example.com")

    def test_terminal_email_mode_is_rejected(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "PRINT_EMAILS_TO_TERMINAL": "1"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "PRINT_EMAILS_TO_TERMINAL cannot be enabled in production.",
            ):
                reload_prod_settings()

    def test_required_secret_key_is_rejected_when_missing(self):
        env = {key: value for key, value in PROD_ENV.items() if key != "DJANGO_SECRET_KEY"}
        with patch.dict("os.environ", env, clear=True):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "DJANGO_SECRET_KEY must be set in production.",
            ):
                reload_prod_settings()

    def test_allowed_hosts_must_contain_a_host(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "DJANGO_ALLOWED_HOSTS": " , "},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "DJANGO_ALLOWED_HOSTS must include at least one host.",
            ):
                reload_prod_settings()

    def test_feedback_retention_must_be_an_integer(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "FEEDBACK_SUBMISSION_RETENTION_DAYS": "invalid"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "FEEDBACK_SUBMISSION_RETENTION_DAYS must be a positive integer.",
            ):
                reload_prod_settings()

    def test_feedback_retention_must_be_positive(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "FEEDBACK_SUBMISSION_RETENTION_DAYS": "0"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "FEEDBACK_SUBMISSION_RETENTION_DAYS must be a positive integer.",
            ):
                reload_prod_settings()

    def test_feedback_retention_accepts_positive_days(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "FEEDBACK_SUBMISSION_RETENTION_DAYS": "30"},
            clear=True,
        ):
            settings = reload_prod_settings()

        self.assertEqual(settings.FEEDBACK_SUBMISSION_RETENTION.days, 30)

    def test_proxy_cidr_hops_must_be_an_integer(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "AUTH_TRUSTED_PROXY_CIDR_HOPS": "invalid"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "AUTH_TRUSTED_PROXY_CIDR_HOPS must be a non-negative integer.",
            ):
                reload_prod_settings()

    def test_proxy_cidr_hops_must_be_nonnegative(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "AUTH_TRUSTED_PROXY_CIDR_HOPS": "-1"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "AUTH_TRUSTED_PROXY_CIDR_HOPS must be a non-negative integer.",
            ):
                reload_prod_settings()

    def test_proxy_cidr_hops_require_cidrs(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "AUTH_TRUSTED_PROXY_CIDR_HOPS": "1"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "AUTH_TRUSTED_PROXY_CIDRS is required when AUTH_TRUSTED_PROXY_CIDR_HOPS is set.",
            ):
                reload_prod_settings()

    def test_multiple_trusted_proxies_require_cidrs(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "AUTH_TRUSTED_PROXY_COUNT": "2"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "AUTH_TRUSTED_PROXY_CIDRS is required when AUTH_TRUSTED_PROXY_COUNT exceeds one.",
            ):
                reload_prod_settings()

    def test_proxy_cidrs_must_be_valid_networks(self):
        with patch.dict(
            "os.environ",
            {**PROD_ENV, "AUTH_TRUSTED_PROXY_CIDRS": "not-a-network"},
            clear=True,
        ):
            with self.assertRaisesMessage(
                ImproperlyConfigured,
                "AUTH_TRUSTED_PROXY_CIDRS must contain valid IPv4 or IPv6 networks.",
            ):
                reload_prod_settings()

    def test_valid_proxy_network_configuration_is_preserved(self):
        with patch.dict(
            "os.environ",
            {
                **PROD_ENV,
                "AUTH_TRUSTED_PROXY_COUNT": "2",
                "AUTH_TRUSTED_PROXY_CIDR_HOPS": "1",
                "AUTH_TRUSTED_PROXY_CIDRS": "10.0.0.0/8,2001:db8::/32",
            },
            clear=True,
        ):
            settings = reload_prod_settings()

        self.assertEqual(settings.AUTH_TRUSTED_PROXY_COUNT, 2)
        self.assertEqual(settings.AUTH_TRUSTED_PROXY_CIDR_HOPS, 1)
        self.assertEqual(settings.AUTH_TRUSTED_PROXY_CIDRS, ["10.0.0.0/8", "2001:db8::/32"])
