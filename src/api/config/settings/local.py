"""Local development settings."""

import os

from .base import *  # noqa: F403

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", SECRET_KEY)  # noqa: F405
DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]

extra_hosts = os.environ.get("EXTRA_ALLOWED_HOSTS", "")
if extra_hosts:
    ALLOWED_HOSTS += [host.strip() for host in extra_hosts.split(",") if host.strip()]

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:4000")
CORS_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4000",
    "http://127.0.0.1:4000",
]
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",  # noqa: F405
    }
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "releviz-local",
    }
}
