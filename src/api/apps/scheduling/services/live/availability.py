"""Whether this process can serve a live event stream at all."""

from __future__ import annotations

from django.conf import settings
from django.core.handlers.asgi import ASGIRequest
from django.db import connection


def live_stream_available(django_request) -> str | None:
    """Return why a stream cannot be served here, or ``None`` when it can.

    The checks run cheapest first. The kill switch is a plain setting. The
    request class tells the servers apart: under WSGI Django collects an async
    streaming body in full before sending a byte, so a stream would never
    reach the browser. Only PostgreSQL delivers the ``LISTEN`` notifications
    the stream is fed from, and ``connection.vendor`` reads that off the
    backend class without opening a connection.
    """

    if not settings.LIVE_STREAM_ENABLED:
        return "Live updates are disabled"
    if not isinstance(django_request, ASGIRequest):
        return "Live updates need the ASGI server"
    if connection.vendor != "postgresql":
        return "Live updates need PostgreSQL"
    return None
