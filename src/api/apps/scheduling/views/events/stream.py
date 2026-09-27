"""Push change notifications to the organizer workspace over Server-Sent Events."""

from django.conf import settings
from django.db import connection
from django.http import StreamingHttpResponse
from rest_framework.negotiation import DefaultContentNegotiation
from rest_framework.response import Response

from apps.scheduling.models import Event
from apps.scheduling.permissions import can_view_event_results
from apps.scheduling.services.live import get_broker, live_stream_available, stream_deadline
from apps.scheduling.services.live.stream import event_changes

from ..helpers import PrivateAPIView


def release_request_db_connection() -> None:
    """Close the request's database connection before the stream body starts.

    The view has run its last query by the time the stream is built, but the
    response then lives for up to the stream cap, and the connection the view
    thread opened would stay pinned to it for that whole time. Inside an
    atomic block the connection is left alone: closing it there would break
    the surrounding transaction, which is how the test suite runs every test.
    """

    if not connection.in_atomic_block:
        connection.close()


def stream_declined(reason: str, *, retry_after: int) -> Response:
    """Tell the client there is no stream here and when to ask again.

    The answer is a 204 so that a decline, which is routine under the kill
    switch, on a server that cannot stream, or at the subscriber cap, neither
    counts as a 5xx on the load balancer nor logs an error on each retry. The
    client reads ``Retry-After`` for how long to poll before it tries the
    stream again, and ``X-Live-Stream-Unavailable`` names the reason.
    """

    return Response(
        status=204,
        headers={"Retry-After": str(retry_after), "X-Live-Stream-Unavailable": reason},
    )


class IgnoreClientContentNegotiation(DefaultContentNegotiation):
    """Answer with the view's first renderer whatever the client accepts.

    The browser asks for ``Accept: text/event-stream``, which no DRF renderer
    offers, so default negotiation would refuse the request with a 406 before
    the view runs. The stream itself is a ``StreamingHttpResponse`` that no
    renderer touches, a decline is a 204 with no body to render, and the
    refusals (400, 403, 404) are JSON either way.
    """

    def select_renderer(self, request, renderers, format_suffix=None):
        return (renderers[0], renderers[0].media_type)


class EventStreamView(PrivateAPIView):
    """Stream change notifications for one event to its organizer.

    The body is a Server-Sent Events stream. It opens with ``retry: 2000`` so
    the browser waits two seconds before reconnecting on its own, then a
    ``ready`` event carrying the event's id, which tells the workspace to run
    one catch-up pass for anything that changed before the stream was up.
    Committed writes to the event then arrive as ``changed`` events, each
    burst folded into one and no two closer together than
    ``LIVE_STREAM_MIN_INTERVAL_SECONDS``. A quiet stream carries a ``: ping``
    comment every heartbeat so proxies keep it open, and a ``reconnect``
    event closes the stream before the access token or the stream cap runs
    out, at which point the client refreshes its token and opens a new one.
    The frames only say that something changed; the workspace compares its
    digest to find out what.

    The body generator never touches the ORM, so the view releases the
    request's database connection before handing the response back. When
    this process cannot serve a stream at all, or already serves as many as
    it should, the answer is a 204 with no body, a ``Retry-After`` that tells
    the client how long to poll before trying the stream again, and an
    ``X-Live-Stream-Unavailable`` header that says why. A decline is an
    expected answer rather than a server fault, and a 503 would count toward
    the load balancer's 5xx alarm and log an error on every client retry.
    """

    content_negotiation_class = IgnoreClientContentNegotiation

    def get(self, request):
        code = request.query_params.get("code", "")
        if not code:
            return Response({"error": "code is required"}, status=400)
        event = Event.objects.filter(code=code).first()
        if event is None:
            return Response({"error": "Event not found"}, status=404)
        if not can_view_event_results(event, request.user):
            return Response(
                {"error": "You do not have permission to view event activity"},
                status=403,
            )
        reason = live_stream_available(request._request)
        if reason:
            return stream_declined(reason, retry_after=300)
        if get_broker().subscriber_count >= settings.LIVE_STREAM_MAX_SUBSCRIBERS:
            return stream_declined("Live updates are busy", retry_after=60)
        release_request_db_connection()
        response = StreamingHttpResponse(
            event_changes(
                event.pk,
                deadline=stream_deadline(
                    request.auth, max_seconds=settings.LIVE_STREAM_MAX_SECONDS
                ),
                heartbeat=settings.LIVE_STREAM_HEARTBEAT_SECONDS,
                coalesce=settings.LIVE_STREAM_COALESCE_SECONDS,
                min_interval=settings.LIVE_STREAM_MIN_INTERVAL_SECONDS,
            ),
            content_type="text/event-stream",
        )
        # Reverse proxies such as nginx buffer response bodies by default,
        # which would hold every frame back until the stream ends.
        response["X-Accel-Buffering"] = "no"
        return response
