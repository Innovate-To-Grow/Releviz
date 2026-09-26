"""The one ``LISTEN`` connection per worker process that feeds the broker."""

from __future__ import annotations

import asyncio
import logging

from django.db import connections

logger = logging.getLogger("releviz.live")

CHANNEL = "releviz_events"
# Django hands psycopg its own cursor class, adapter context and prepared
# statement policy; a plain listening connection must not receive them.
DJANGO_ONLY_CONNECTION_KEYS = ("cursor_factory", "context", "prepare_threshold")


def listener_connection_kwargs() -> dict:
    """Connection parameters for a plain psycopg connection to the default database.

    Everything Django would send, including ``sslmode`` and ``options``, passes
    through minus the Django-only keys. Keepalives make a silent network
    failure surface within about a minute instead of leaving a dead socket
    that never delivers another notification.
    """

    params = dict(connections["default"].get_connection_params())
    for key in DJANGO_ONLY_CONNECTION_KEYS:
        params.pop(key, None)
    params.update(
        application_name="releviz-live-listener",
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=3,
    )
    return params


async def open_listener_connection():
    """Open the autocommit connection ``LISTEN`` needs to take effect at once."""

    # psycopg is only needed on PostgreSQL, so it is imported when a
    # connection is actually opened rather than when the package loads.
    import psycopg

    return await psycopg.AsyncConnection.connect(**listener_connection_kwargs(), autocommit=True)


class PostgresListener:
    """Keep one ``LISTEN`` connection open and publish every payload it receives."""

    def __init__(
        self,
        broker,
        *,
        connect=None,
        sleep=asyncio.sleep,
        initial_backoff: float = 1.0,
        max_backoff: float = 30.0,
    ):
        self._broker = broker
        self._connect = connect or open_listener_connection
        self._sleep = sleep
        self._initial_backoff = initial_backoff
        self._max_backoff = max_backoff
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(
            self.run(), name="releviz-live-listener"
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def run(self) -> None:
        """Listen until cancelled, reconnecting with exponential backoff.

        Notifications sent while no ``LISTEN`` was in effect are gone, so every
        successful ``LISTEN`` wakes every subscription and each stream resyncs
        from the digest, exactly as a browser does after its own reconnect.
        That includes the first one: the stream that starts the listener has
        already sent ``ready`` before the connection is up, and so has any
        stream opened while a first attempt was failing and backing off, so a
        write committed in that gap would otherwise never be pushed. A wake-up
        with nothing behind it costs each stream one digest pass. Cancellation
        is not an ``Exception`` and passes straight through to ``stop``.
        """

        backoff = self._initial_backoff
        connected_before = False
        while True:
            conn = None
            try:
                conn = await self._connect()
                await conn.execute("LISTEN releviz_events")
                logger.info(
                    "live_listener_reconnected" if connected_before else "live_listener_connected"
                )
                connected_before = True
                self._broker.publish_all()
                backoff = self._initial_backoff
                async for notify in conn.notifies():
                    self._publish(notify.payload)
            except Exception:
                logger.warning(
                    "live_listener_reconnecting",
                    exc_info=True,
                    extra={"retry_after": backoff},
                )
            finally:
                if conn is not None:
                    await conn.close()
            await self._sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    def _publish(self, payload: str) -> None:
        # The trigger sends the event's primary key; anything else on the
        # channel is not ours to act on.
        try:
            event_pk = int(payload)
        except ValueError:
            logger.warning("live_listener_ignored_payload")
            return
        self._broker.publish(event_pk)
