"""End-to-end test settings."""

import os
from pathlib import Path

from .test_postgres import *  # noqa: F403

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://127.0.0.1:3000")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:4000")
CORS_ALLOWED_ORIGINS = [FRONTEND_URL, BACKEND_URL]
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS

EMAIL_FILE_PATH = os.environ.get("EMAIL_FILE_PATH", str(Path("/tmp") / "releviz-e2e-mail"))
EMAIL_BACKEND = "django.core.mail.backends.filebased.EmailBackend"
PRINT_EMAILS_TO_TERMINAL = False
# No SES credentials exist in E2E, so verification codes must reach the file sink
# the browser tests read.
AUTH_EMAIL_DJANGO_BACKEND_FALLBACK = True
REQUIRE_ENCRYPTED_PASSWORDS = True

# A browser run drives many requests and verification codes through one address.
# Keep those flows practical while retaining finite, shared limits so an exposed
# E2E service cannot become an unthrottled endpoint.
_E2E_THROTTLE_RATE = "1000/minute"
_E2E_DURABLE_LIMIT = {"limit": 1000, "window": 60, "block": 60}

AUTH_RATE_LIMITS = {  # noqa: F405
    scope: {dimension: dict(_E2E_DURABLE_LIMIT) for dimension in dimensions}
    for scope, dimensions in AUTH_RATE_LIMITS.items()  # noqa: F405
}
AUTH_FAILURE_LIMITS = {  # noqa: F405
    scope: {dimension: dict(_E2E_DURABLE_LIMIT) for dimension in dimensions}
    for scope, dimensions in AUTH_FAILURE_LIMITS.items()  # noqa: F405
}

REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"] = [  # noqa: F405
    "rest_framework.throttling.AnonRateThrottle",
    "rest_framework.throttling.UserRateThrottle",
]
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"] = {  # noqa: F405
    scope: _E2E_THROTTLE_RATE
    for scope in {
        *REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],  # noqa: F405
        "anon",
        "user",
    }
}
