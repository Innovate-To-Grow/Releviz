"""Production settings."""

import ipaddress
import os

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(f"{name} must be set in production.")
    return value


def split_csv(name: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


SECRET_KEY = required_env("DJANGO_SECRET_KEY")
DEBUG = False
ALLOWED_HOSTS = split_csv("DJANGO_ALLOWED_HOSTS")
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must include at least one host.")

FRONTEND_URL = required_env("FRONTEND_URL")
BACKEND_URL = required_env("BACKEND_URL")
REQUIRE_ENCRYPTED_PASSWORDS = os.environ.get("REQUIRE_ENCRYPTED_PASSWORDS", "1") != "0"
FIELD_ENCRYPTION_KEY = required_env("DJANGO_FIELD_ENCRYPTION_KEY")
METRICS_BEARER_TOKEN = required_env("METRICS_BEARER_TOKEN")
try:
    feedback_retention_days = int(os.environ.get("FEEDBACK_SUBMISSION_RETENTION_DAYS", "730"))
except ValueError as exc:
    raise ImproperlyConfigured(
        "FEEDBACK_SUBMISSION_RETENTION_DAYS must be a positive integer."
    ) from exc
if feedback_retention_days < 1:
    raise ImproperlyConfigured("FEEDBACK_SUBMISSION_RETENTION_DAYS must be a positive integer.")
FEEDBACK_SUBMISSION_RETENTION = timedelta(days=feedback_retention_days)  # noqa: F405
USE_SES_EMAIL_PROVIDER = os.environ.get("USE_SES_EMAIL_PROVIDER", "1") != "0"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

DATABASES = {
    "default": {
        "ENGINE": os.environ.get("DB_ENGINE", "django.db.backends.postgresql"),
        "NAME": required_env("DB_NAME"),
        "USER": required_env("DB_USER"),
        "PASSWORD": required_env("DB_PASSWORD"),
        "HOST": required_env("DB_HOST"),
        "PORT": os.environ.get("DB_PORT", "5432"),
        "CONN_MAX_AGE": int(os.environ.get("DB_CONN_MAX_AGE", "60")),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {"sslmode": os.environ.get("DB_SSLMODE", "require")},
    }
}

CORS_ALLOWED_ORIGINS = split_csv("CORS_ALLOWED_ORIGINS")
CSRF_TRUSTED_ORIGINS = split_csv("CSRF_TRUSTED_ORIGINS")
CORS_ALLOW_CREDENTIALS = True
AUTH_REFRESH_COOKIE_SECURE = True
TEMP_EVENT_COOKIE_SECURE = True
# Candidate and production Amplify branches call the API from an explicitly
# trusted cross-site origin. Origin validation still protects every
# cookie-authenticated mutation, while SameSite=None allows those reviewed
# deployments to send the event-scoped credential.
TEMP_EVENT_COOKIE_SAMESITE = "None"
ENABLE_LEGACY_API_PREFIX = os.environ.get("ENABLE_LEGACY_API_PREFIX", "0") == "1"
AUTH_TRUSTED_PROXY_COUNT = int(os.environ.get("AUTH_TRUSTED_PROXY_COUNT", "1"))
AUTH_TRUSTED_PROXY_CIDRS = split_csv("AUTH_TRUSTED_PROXY_CIDRS")
try:
    AUTH_TRUSTED_PROXY_CIDR_HOPS = int(os.environ.get("AUTH_TRUSTED_PROXY_CIDR_HOPS", "0"))
except ValueError as exc:
    raise ImproperlyConfigured(
        "AUTH_TRUSTED_PROXY_CIDR_HOPS must be a non-negative integer."
    ) from exc
if AUTH_TRUSTED_PROXY_CIDR_HOPS < 0:
    raise ImproperlyConfigured("AUTH_TRUSTED_PROXY_CIDR_HOPS must be a non-negative integer.")
if AUTH_TRUSTED_PROXY_CIDR_HOPS and not AUTH_TRUSTED_PROXY_CIDRS:
    raise ImproperlyConfigured(
        "AUTH_TRUSTED_PROXY_CIDRS is required when AUTH_TRUSTED_PROXY_CIDR_HOPS is set."
    )
if AUTH_TRUSTED_PROXY_COUNT > 1 and not AUTH_TRUSTED_PROXY_CIDRS:
    raise ImproperlyConfigured(
        "AUTH_TRUSTED_PROXY_CIDRS is required when AUTH_TRUSTED_PROXY_COUNT exceeds one."
    )
try:
    for trusted_proxy_cidr in AUTH_TRUSTED_PROXY_CIDRS:
        ipaddress.ip_network(trusted_proxy_cidr, strict=False)
except ValueError as exc:
    raise ImproperlyConfigured(
        "AUTH_TRUSTED_PROXY_CIDRS must contain valid IPv4 or IPv6 networks."
    ) from exc

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = os.environ.get("DJANGO_SECURE_SSL_REDIRECT", "1") != "0"
SECURE_HSTS_SECONDS = 31_536_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
X_FRAME_OPTIONS = "DENY"

EMAIL_BACKEND = os.environ.get("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "noreply@releviz.local")
