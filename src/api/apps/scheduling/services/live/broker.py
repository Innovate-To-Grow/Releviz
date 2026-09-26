"""In-process fan-out of change notifications to the open event streams.

One broker lives per worker process. It keeps a set of subscriptions per
event and wakes the matching ones when the listener reports a change. The
broker creates no asyncio primitive until the first subscription arrives,
because the module is imported in the DRF worker thread while the streams
run on the server's event loop, and a primitive must belong to that loop.
"""

from __future__ import annotations

import asyncio


class Subscription:
    """One open stream's wake-up flag for a single event.

    Built only inside ``ChangeBroker.subscribe``, which the stream generator
    calls on the event loop, so the event binds to the loop that waits on it.
    """

    def __init__(self):
        self._event = asyncio.Event()

    async def wait(self, timeout: float) -> bool:
        """Block until notified or ``timeout`` seconds pass; ``False`` on the timeout."""

        try:
            await asyncio.wait_for(self._event.wait(), timeout)
        except TimeoutError:
            return False
        return True

    def clear(self) -> None:
        self._event.clear()

    def notify(self) -> None:
        self._event.set()


def _default_listener_factory(broker: ChangeBroker):
    # Imported here so this module stays free of Django's database imports and
    # the broker can be exercised on its own.
    from .listener import PostgresListener

    return PostgresListener(broker)


class ChangeBroker:
    """Route change notifications for an event to the streams watching it."""

    def __init__(self, listener_factory=None):
        self._listener_factory = listener_factory or _default_listener_factory
        self._loop = None
        self._subscriptions: dict[int, set[Subscription]] = {}
        self._subscriber_count = 0
        self._listener = None

    def _bind(self) -> None:
        """Tie the broker to the running loop, starting over when it changed.

        A server process has one loop for its whole life, but every async test
        gets a fresh one; subscriptions and the listener task from a previous
        loop can never be used again, so they are dropped rather than kept.
        """

        loop = asyncio.get_running_loop()
        if loop is not self._loop:
            self._loop = loop
            self._subscriptions = {}
            self._subscriber_count = 0
            self._listener = None

    def subscribe(self, event_pk: int) -> Subscription:
        """Register a stream for ``event_pk``, waking the listener if needed."""

        self._bind()
        subscription = Subscription()
        self._subscriptions.setdefault(event_pk, set()).add(subscription)
        self._subscriber_count += 1
        if self._listener is None:
            self._listener = self._listener_factory(self)
            self._listener.start()
        return subscription

    def unsubscribe(self, event_pk: int, subscription: Subscription) -> None:
        subscriptions = self._subscriptions.get(event_pk, set())
        # Only a subscription that was actually registered leaves the count,
        # so leaving twice, or after a loop change dropped it, cannot take the
        # count below the streams that are really open.
        if subscription in subscriptions:
            subscriptions.remove(subscription)
            self._subscriber_count -= 1
        if not subscriptions:
            self._subscriptions.pop(event_pk, None)

    def publish(self, event_pk: int) -> None:
        """Wake every stream watching ``event_pk``."""

        for subscription in self._subscriptions.get(event_pk, ()):
            subscription.notify()

    def publish_all(self) -> None:
        """Wake every stream, used each time the listener starts listening.

        Nothing sent before a ``LISTEN`` took effect was heard, so every open
        stream resyncs from the digest rather than trust that nothing changed.
        """

        for subscriptions in self._subscriptions.values():
            for subscription in subscriptions:
                subscription.notify()

    @property
    def subscriber_count(self) -> int:
        """How many streams are open in this process.

        The view reads this from DRF's worker thread while the event loop adds
        and removes subscriptions. Walking the dictionary from that thread can
        fail with "dictionary changed size during iteration" when a key comes
        or goes mid-walk, whereas reading one int is atomic, and a count that
        is a moment stale is fine for a soft cap.
        """

        return self._subscriber_count


_broker: ChangeBroker | None = None


def get_broker() -> ChangeBroker:
    """The process-wide broker, created on first use."""

    global _broker
    if _broker is None:
        _broker = ChangeBroker()
    return _broker


def reset_broker() -> None:
    """Forget the process-wide broker so the next call builds a fresh one."""

    global _broker
    _broker = None
