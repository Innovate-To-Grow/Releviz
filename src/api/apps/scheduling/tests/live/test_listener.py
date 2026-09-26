import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from django.test import SimpleTestCase

from apps.scheduling.services.live import listener as listener_module
from apps.scheduling.services.live.listener import (
    CHANNEL,
    PostgresListener,
    listener_connection_kwargs,
    open_listener_connection,
)

# A script item that keeps the notification stream open until it is cancelled,
# which is how a healthy connection behaves.
HOLD = object()

DJANGO_PARAMS = {
    "dbname": "releviz",
    "user": "app",
    "password": "secret",
    "host": "db.internal",
    "port": "5432",
    "sslmode": "require",
    "options": "-c statement_timeout=5000",
    "client_encoding": "UTF8",
    "cursor_factory": object,
    "context": object(),
    "prepare_threshold": None,
}


def fake_connections(params):
    return {"default": SimpleNamespace(get_connection_params=lambda: params)}


class FakeBroker:
    def __init__(self):
        self.published = []
        # Every call in the order it arrived, with ``"all"`` for a resync.
        self.calls = []

    def publish(self, event_pk):
        self.published.append(event_pk)
        self.calls.append(event_pk)

    def publish_all(self):
        self.calls.append("all")


class FakeAsyncConnection:
    """A scripted stand-in for psycopg's async connection.

    ``script`` lists the notification payloads to deliver in order. An
    exception instance is raised from the stream at that point, ``HOLD``
    keeps the stream open, and the stream ends when the list runs out.
    ``listen_error`` is raised from ``execute`` instead, as a ``LISTEN`` the
    server refused would be.
    """

    def __init__(self, script=(), *, listen_error=None):
        self.script = list(script)
        self.listen_error = listen_error
        self.executed = []
        self.closed = False
        self.held = asyncio.Event()

    async def execute(self, sql):
        self.executed.append(sql)
        if self.listen_error is not None:
            raise self.listen_error

    async def close(self):
        self.closed = True

    async def notifies(self):
        for item in self.script:
            if item is HOLD:
                self.held.set()
                await asyncio.Event().wait()
            if isinstance(item, Exception):
                raise item
            yield SimpleNamespace(channel=CHANNEL, payload=item, pid=1)


class FakeConnector:
    """Hands out scripted connections, raising the exceptions listed between them.

    Once the script runs out the next attempt flags ``idle`` and waits until it
    is cancelled, so a test can inspect the listener at a known point.
    """

    def __init__(self, script):
        self.script = list(script)
        self.attempts = 0
        self.idle = asyncio.Event()

    async def __call__(self):
        self.attempts += 1
        if not self.script:
            self.idle.set()
            await asyncio.Event().wait()
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class RecordedSleep:
    def __init__(self):
        self.calls = []

    async def __call__(self, seconds):
        self.calls.append(seconds)


class ListenerConnectionKwargsTests(SimpleTestCase):
    def test_connection_kwargs_strip_the_django_only_keys(self):
        params = dict(DJANGO_PARAMS)
        with patch.object(listener_module, "connections", fake_connections(params)):
            kwargs = listener_connection_kwargs()

        for key in ("cursor_factory", "context", "prepare_threshold"):
            self.assertNotIn(key, kwargs)
        for key in ("dbname", "user", "password", "host", "port", "sslmode", "options"):
            self.assertEqual(kwargs[key], DJANGO_PARAMS[key])
        self.assertEqual(kwargs["client_encoding"], "UTF8")
        # Django's own parameters are copied, never edited in place.
        self.assertEqual(params, DJANGO_PARAMS)

    def test_connection_kwargs_add_keepalives_timeout_and_name(self):
        with patch.object(listener_module, "connections", fake_connections(dict(DJANGO_PARAMS))):
            kwargs = listener_connection_kwargs()

        self.assertEqual(kwargs["application_name"], "releviz-live-listener")
        self.assertEqual(kwargs["connect_timeout"], 10)
        self.assertEqual(kwargs["keepalives"], 1)
        self.assertEqual(kwargs["keepalives_idle"], 30)
        self.assertEqual(kwargs["keepalives_interval"], 10)
        self.assertEqual(kwargs["keepalives_count"], 3)

    async def test_the_default_connector_opens_an_autocommit_psycopg_connection(self):
        connect = AsyncMock(return_value="connection")
        with (
            patch.object(listener_module, "connections", fake_connections(dict(DJANGO_PARAMS))),
            patch("psycopg.AsyncConnection.connect", connect),
        ):
            self.assertEqual(await open_listener_connection(), "connection")

        connect.assert_awaited_once()
        kwargs = connect.await_args.kwargs
        self.assertTrue(kwargs["autocommit"])
        self.assertEqual(kwargs["dbname"], "releviz")
        self.assertEqual(kwargs["sslmode"], "require")
        self.assertEqual(kwargs["application_name"], "releviz-live-listener")
        self.assertNotIn("cursor_factory", kwargs)


class PostgresListenerTests(SimpleTestCase):
    def listener(self, broker, connector, **options):
        sleep = RecordedSleep()
        return PostgresListener(broker, connect=connector, sleep=sleep, **options), sleep

    async def test_listens_and_publishes_integer_payloads(self):
        broker = FakeBroker()
        conn = FakeAsyncConnection(["7", "12"])
        connector = FakeConnector([conn])
        listener, sleep = self.listener(broker, connector)

        with self.assertLogs("releviz.live", level="INFO") as logs:
            listener.start()
            await connector.idle.wait()
            await listener.stop()

        self.assertEqual(conn.executed, ["LISTEN releviz_events"])
        self.assertEqual(broker.published, [7, 12])
        # The first LISTEN resyncs every stream already open, since a write
        # committed before it took effect was never announced to this process.
        self.assertEqual(broker.calls, ["all", 7, 12])
        self.assertTrue(conn.closed)
        # A stream that ends counts as a dropped connection: the listener
        # waits out the backoff and connects again.
        self.assertEqual(sleep.calls, [1.0])
        self.assertEqual(connector.attempts, 2)
        self.assertEqual(logs.output, ["INFO:releviz.live:live_listener_connected"])

    async def test_skips_non_integer_payloads(self):
        broker = FakeBroker()
        connector = FakeConnector([FakeAsyncConnection(["7", "seven", "8"])])
        listener, _sleep = self.listener(broker, connector)

        with self.assertLogs("releviz.live", level="WARNING") as logs:
            listener.start()
            await connector.idle.wait()
            await listener.stop()

        self.assertEqual(broker.published, [7, 8])
        self.assertEqual(logs.output, ["WARNING:releviz.live:live_listener_ignored_payload"])

    async def test_reconnects_with_backoff_and_resyncs_after_recovery(self):
        broker = FakeBroker()
        dropped = FakeAsyncConnection(["3", ConnectionResetError("socket closed")])
        recovered = FakeAsyncConnection(["9"])
        connector = FakeConnector([dropped, OSError("connection refused"), recovered])
        listener, sleep = self.listener(broker, connector)

        with self.assertLogs("releviz.live", level="INFO") as logs:
            listener.start()
            await connector.idle.wait()
            await listener.stop()

        self.assertEqual(broker.published, [3, 9])
        # Each successful LISTEN, the first and the recovered one, resyncs the
        # streams; a failed attempt has nothing new to report.
        self.assertEqual(broker.calls, ["all", 3, "all", 9])
        self.assertTrue(dropped.closed)
        self.assertTrue(recovered.closed)
        self.assertEqual(recovered.executed, ["LISTEN releviz_events"])
        # The backoff doubles across the two failures and starts over once the
        # recovered connection is listening again.
        self.assertEqual(sleep.calls, [1.0, 2.0, 1.0])
        self.assertEqual(
            [record.getMessage() for record in logs.records],
            [
                "live_listener_connected",
                "live_listener_reconnecting",
                "live_listener_reconnecting",
                "live_listener_reconnected",
            ],
        )
        self.assertEqual([record.retry_after for record in logs.records[1:3]], [1.0, 2.0])
        self.assertEqual(
            [record.exc_info[0] for record in logs.records[1:3]],
            [ConnectionResetError, OSError],
        )

    async def test_a_first_connection_that_fails_resyncs_once_listen_succeeds(self):
        broker = FakeBroker()
        refused = FakeAsyncConnection(listen_error=RuntimeError("permission denied"))
        listening = FakeAsyncConnection(["5"])
        connector = FakeConnector([refused, OSError("connection refused"), listening])
        listener, sleep = self.listener(broker, connector)

        with self.assertLogs("releviz.live", level="INFO") as logs:
            listener.start()
            await connector.idle.wait()
            await listener.stop()

        # Streams opened while the first attempts failed have sent ``ready``
        # with nothing listening, so the LISTEN that finally works wakes them
        # all once, before the first notification it delivers.
        self.assertEqual(broker.calls, ["all", 5])
        self.assertEqual(refused.executed, ["LISTEN releviz_events"])
        self.assertTrue(refused.closed)
        self.assertTrue(listening.closed)
        self.assertEqual(sleep.calls, [1.0, 2.0, 1.0])
        # No LISTEN had succeeded before, so the one that does is a first
        # connection rather than a reconnect.
        self.assertEqual(
            [record.getMessage() for record in logs.records],
            [
                "live_listener_reconnecting",
                "live_listener_reconnecting",
                "live_listener_connected",
            ],
        )
        self.assertEqual(
            [record.exc_info[0] for record in logs.records[:2]], [RuntimeError, OSError]
        )

    async def test_backoff_caps_at_max(self):
        broker = FakeBroker()
        connector = FakeConnector([OSError("connection refused")] * 5)
        listener, sleep = self.listener(broker, connector, initial_backoff=0.5, max_backoff=2.0)

        with self.assertLogs("releviz.live", level="WARNING") as logs:
            listener.start()
            await connector.idle.wait()
            await listener.stop()

        self.assertEqual(sleep.calls, [0.5, 1.0, 2.0, 2.0, 2.0])
        self.assertEqual(len(logs.records), 5)
        # No LISTEN ever succeeded, so nothing was published or resynced.
        self.assertEqual(broker.calls, [])

    async def test_stop_cancels_and_closes(self):
        broker = FakeBroker()
        conn = FakeAsyncConnection(["4", HOLD])
        connector = FakeConnector([conn])
        listener, sleep = self.listener(broker, connector)

        listener.start()
        await conn.held.wait()
        self.assertEqual(broker.published, [4])
        self.assertFalse(conn.closed)

        await listener.stop()

        self.assertTrue(conn.closed)
        self.assertEqual(sleep.calls, [])
        self.assertEqual(connector.attempts, 1)
        # Stopping again once the task is gone is harmless.
        await listener.stop()
        await asyncio.sleep(0)
        self.assertEqual(connector.attempts, 1)
