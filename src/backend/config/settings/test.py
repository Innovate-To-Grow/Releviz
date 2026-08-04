"""Test settings."""

from .local import *  # noqa: F403

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
EMAIL_WORKER_CONCURRENCY = 1

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "releviz-tests",
    }
}

LOGGING["root"]["level"] = "WARNING"  # noqa: F405

TEST_RUNNER = "config.test_runner.AppTestRunner"
