"""ASGI config for Releviz."""

import os

from django.conf import settings
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.local")

# get_asgi_application() runs django.setup(). App code is imported only after
# it, so a model import that reaches the middleware package later can never
# run before the app registry is ready.
django_application = get_asgi_application()

from apps.core.middleware import RequestBodyLimitMiddleware  # noqa: E402

# Django's ASGI handler reads the whole request body before it routes the
# request or authenticates anyone, so the size cap has to sit in front of it.
application = RequestBodyLimitMiddleware(
    django_application, max_bytes=settings.REQUEST_BODY_MAX_BYTES
)
