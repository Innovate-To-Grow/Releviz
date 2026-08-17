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
# No SES credentials exist in E2E, so verification codes must reach the file sink
# the browser tests read.
AUTH_EMAIL_DJANGO_BACKEND_FALLBACK = True
REQUIRE_ENCRYPTED_PASSWORDS = True
AUTH_RATE_LIMITS = {}
AUTH_FAILURE_LIMITS = {}

# A browser run drives many verification codes through one address, which the
# production throttles would reject. Clearing the DRF rates keeps the flows
# under test rather than the rate limiter.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_RATES": dict.fromkeys(
        REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],  # noqa: F405
        None,
    ),
}
