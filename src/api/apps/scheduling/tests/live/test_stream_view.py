import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

from django.test import AsyncClient, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from apps.authn.tests.helpers import create_member, token_for
from apps.scheduling.models import Event
from apps.scheduling.services.live import availability
from apps.scheduling.services.live.broker import get_broker, reset_broker
from apps.scheduling.services.live.listener import PostgresListener
from apps.scheduling.services.live.stream import event_changes, sse
from apps.scheduling.views.events import stream as stream_view
from apps.scheduling.views.events.stream import release_request_db_connection


def postgres():
    """Make the availability check see PostgreSQL whatever database the tests run on."""

    return patch.object(availability, "connection", SimpleNamespace(vendor="postgresql"))


class StreamSpy:
    """Stand in for the view's ``event_changes`` and keep every generator it built.

    Django's async test client wraps ``streaming_content`` in a closer of its
    own that never reaches the generator inside, so a test that wants the
    stream to unsubscribe has to close the generator itself.
    """

    def __init__(self):
        self.calls = []
        self.generators = []

    def __call__(self, *args, **kwargs):
        generator = event_changes(*args, **kwargs)
        self.calls.append((args, kwargs))
        self.generators.append(generator)
        return generator

    async def close(self):
        for generator in self.generators:
            await generator.aclose()


class EventStreamViewTests(TestCase):
    def setUp(self):
        reset_broker()
        self.addCleanup(reset_broker)
        self.organizer = create_member("stream-organizer@example.com")
        self.other = create_member("stream-other@example.com")
        self.event = Event.objects.create(
            code="STREAM",
            name="Stream",
            organizer=self.organizer,
            mode="inperson",
            start_minutes=9 * 60,
            end_minutes=10 * 60,
            slot_minutes=30,
            meeting_duration_minutes=30,
            days=[1],
        )
        self.client = APIClient()
        self.async_client = AsyncClient()
        # Django's async client only turns per-request headers into ASGI
        # scope headers, so the headers the browser sends travel with every
        # call: the bearer token and the event-stream Accept header, which
        # default content negotiation would refuse with a 406.
        self.organizer_headers = {
            "Authorization": f"Bearer {token_for(self.organizer)}",
            "Accept": "text/event-stream",
        }

    def authenticate(self, member):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_for(member)}")

    def assertDeclined(self, response, *, reason, retry_after):
        """A decline is an empty 204 that names the reason and when to try again.

        A 204 is a success, so the load balancer's 5xx alarm and Django's
        error log stay quiet while the client falls back to polling.
        """

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertNotIn("Content-Type", response)
        self.assertEqual(response["Retry-After"], retry_after)
        self.assertEqual(response["X-Live-Stream-Unavailable"], reason)
        self.assertIn("no-store", response["Cache-Control"])

    async def organizer_stream_request(self):
        return await self.async_client.get(
            "/events/stream", {"code": "STREAM"}, headers=self.organizer_headers
        )

    @asynccontextmanager
    async def open_stream(self, spy=None):
        """Open the organizer's stream on the ASGI client and close its generator after."""

        spy = spy or StreamSpy()
        # The shared broker would start the real listener on the first
        # subscription; on SQLite that means psycopg trying to connect.
        with (
            postgres(),
            patch.object(PostgresListener, "start", autospec=True),
            patch.object(stream_view, "event_changes", spy),
        ):
            try:
                yield await self.organizer_stream_request()
            finally:
                await spy.close()

    def test_code_is_required(self):
        self.authenticate(self.organizer)
        response = self.client.get("/events/stream")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"error": "code is required"})

    def test_an_unknown_code_is_not_found(self):
        self.authenticate(self.organizer)
        response = self.client.get("/events/stream?code=NOPE")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data, {"error": "Event not found"})

    def test_refusals_are_json_even_when_the_client_asks_for_an_event_stream(self):
        self.authenticate(self.organizer)
        response = self.client.get("/events/stream?code=NOPE", HTTP_ACCEPT="text/event-stream")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"error": "Event not found"})

    def test_a_non_organizer_is_forbidden(self):
        self.assertEqual(self.client.get("/events/stream?code=STREAM").status_code, 401)

        self.authenticate(self.other)
        response = self.client.get("/events/stream?code=STREAM")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.data,
            {"error": "You do not have permission to view event activity"},
        )

    @override_settings(LIVE_STREAM_ENABLED=False)
    async def test_the_kill_switch_answers_204_with_a_retry_after(self):
        with postgres():
            response = await self.organizer_stream_request()

        self.assertDeclined(response, reason="Live updates are disabled", retry_after="300")

    def test_a_cross_origin_client_can_read_why_and_when_to_retry(self):
        # The workspace calls the API from another origin, so the decline's
        # headers only reach it when CORS exposes them.
        self.authenticate(self.organizer)
        with postgres():
            response = self.client.get(
                "/events/stream?code=STREAM", HTTP_ORIGIN="http://localhost:3000"
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response["Access-Control-Allow-Origin"], "http://localhost:3000")
        exposed = {
            name.strip().lower() for name in response["Access-Control-Expose-Headers"].split(",")
        }
        self.assertLessEqual({"retry-after", "x-live-stream-unavailable"}, exposed)

    def test_a_wsgi_client_is_declined(self):
        self.authenticate(self.organizer)
        with postgres():
            response = self.client.get("/events/stream?code=STREAM")

        self.assertDeclined(response, reason="Live updates need the ASGI server", retry_after="300")

    async def test_a_database_other_than_postgresql_is_declined(self):
        # The suite runs on SQLite or PostgreSQL, so the vendor is pinned
        # rather than read off whichever backend is in use.
        with patch.object(availability, "connection", SimpleNamespace(vendor="sqlite")):
            response = await self.organizer_stream_request()

        self.assertDeclined(response, reason="Live updates need PostgreSQL", retry_after="300")

    async def test_a_decline_is_not_logged_as_an_error(self):
        # Django logs every 5xx on ``django.request`` at ERROR, which reaches
        # Sentry; a 204 decline must not, however often the client retries.
        with (
            override_settings(LIVE_STREAM_ENABLED=False),
            postgres(),
            self.assertNoLogs("django.request", level="WARNING"),
        ):
            response = await self.organizer_stream_request()

        self.assertEqual(response.status_code, 204)

    @override_settings(LIVE_STREAM_MAX_SUBSCRIBERS=1)
    async def test_the_subscriber_cap_answers_204_with_a_short_retry(self):
        async with self.open_stream() as response:
            content = response.streaming_content
            await anext(content)
            self.assertEqual(get_broker().subscriber_count, 1)

            with postgres():
                refused = await self.organizer_stream_request()

            self.assertDeclined(refused, reason="Live updates are busy", retry_after="60")
            # The stream that was already open is not affected.
            self.assertEqual(await anext(content), sse("ready", {"eventId": self.event.pk}))
            self.assertEqual(get_broker().subscriber_count, 1)

    @override_settings(
        LIVE_STREAM_HEARTBEAT_SECONDS=7,
        LIVE_STREAM_COALESCE_SECONDS=0.1,
        LIVE_STREAM_MIN_INTERVAL_SECONDS=1.5,
    )
    async def test_stream_headers_and_first_frames(self):
        spy = StreamSpy()
        async with self.open_stream(spy) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Content-Type"], "text/event-stream")
            self.assertEqual(response["X-Accel-Buffering"], "no")
            self.assertIn("no-store", response["Cache-Control"])
            self.assertIn("Authorization", response["Vary"])
            # The body subscribes when the server starts sending it, not when
            # the view returns.
            self.assertEqual(get_broker().subscriber_count, 0)

            content = response.streaming_content
            self.assertEqual(await anext(content), b"retry: 2000\n\n")
            self.assertEqual(await anext(content), sse("ready", {"eventId": self.event.pk}))
            self.assertEqual(get_broker().subscriber_count, 1)

            [(args, kwargs)] = spy.calls
            self.assertEqual(args, (self.event.pk,))
            self.assertEqual(kwargs["heartbeat"], 7)
            self.assertEqual(kwargs["coalesce"], 0.1)
            self.assertEqual(kwargs["min_interval"], 1.5)
            # The ten-minute access token, not the fifteen-minute cap, sets
            # the deadline, so the stream never outlives its credential.
            self.assertAlmostEqual(kwargs["deadline"] - time.monotonic(), 10 * 60, delta=5)
        self.assertEqual(get_broker().subscriber_count, 0)

    @override_settings(LIVE_STREAM_HEARTBEAT_SECONDS=0.05, LIVE_STREAM_COALESCE_SECONDS=0)
    async def test_a_changed_frame_follows_a_published_change(self):
        async with self.open_stream() as response:
            content = response.streaming_content
            await anext(content)
            await anext(content)

            get_broker().publish(self.event.pk)
            frame = await anext(content)

            self.assertTrue(frame.startswith(b"event: changed\ndata: "))
            self.assertIn("at", json.loads(frame.split(b"data: ", 1)[1]))

    @override_settings(LIVE_STREAM_HEARTBEAT_SECONDS=0.01)
    async def test_a_ping_keeps_a_quiet_stream_open(self):
        async with self.open_stream() as response:
            content = response.streaming_content
            await anext(content)
            await anext(content)
            self.assertEqual(await anext(content), b": ping\n\n")


class ReleaseRequestDbConnectionTests(SimpleTestCase):
    def test_releases_the_connection_outside_an_atomic_block(self):
        with patch.object(stream_view, "connection") as connection:
            connection.in_atomic_block = False
            release_request_db_connection()
        connection.close.assert_called_once_with()

    def test_leaves_the_connection_alone_inside_an_atomic_block(self):
        with patch.object(stream_view, "connection") as connection:
            connection.in_atomic_block = True
            release_request_db_connection()
        connection.close.assert_not_called()
