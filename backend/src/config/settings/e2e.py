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
REQUIRE_ENCRYPTED_PASSWORDS = True
