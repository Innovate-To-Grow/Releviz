"""PostgreSQL-backed test settings."""

import os

from .test import *  # noqa: F403

DATABASES = {
    "default": {
        "ENGINE": os.environ.get("DB_ENGINE", "django.db.backends.postgresql"),
        "NAME": os.environ.get("DB_NAME", "releviz_test"),
        "USER": os.environ.get("DB_USER", "releviz"),
        "PASSWORD": os.environ.get("DB_PASSWORD", "releviz"),
        "HOST": os.environ.get("DB_HOST", "127.0.0.1"),
        "PORT": os.environ.get("DB_PORT", "5433"),
        "TEST": {"NAME": os.environ.get("DB_TEST_NAME", "test_releviz")},
    }
}
