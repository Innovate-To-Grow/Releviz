"""The Server-Sent Events body of the organizer workspace's event stream."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime

from .broker import get_broker


def sse(event: str, payload) -> bytes:
    """One SSE frame: the event name and a single JSON data line."""

    return f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode()


def stream_deadline(auth, *, max_seconds: float, now: float | None = None) -> float:
    """When the stream must close, as a ``time.monotonic()`` value.

    The access token's expiry wins over the cap so a stream never outlives
    the credential it was opened with; the client refreshes and reopens.
    ``auth`` may be ``None`` or carry no expiry, in which case only the cap
    applies. ``now`` is the wall-clock time to measure the expiry against.
    """

    exp = getattr(auth, "payload", {}).get("exp")
    remaining = max_seconds
    if exp is not None:
        wall_now = time.time() if now is None else now
        remaining = min(exp - wall_now, max_seconds)
    return time.monotonic() + max(0.0, remaining)


async def event_changes(
    event_pk: int,
    *,
    deadline: float,
    heartbeat: float,
    coalesce: float,
    min_interval: float,
    broker=None,
):
    """Yield the frames of one event's stream until the deadline.

    Subscribing happens in here rather than in the view because DRF runs the
    view in a worker thread while this generator runs on the event loop, and
    the subscription's primitives must belong to that loop. The first writes
    are what flush the response headers to the browser; ``retry`` sets its
    own reconnect delay. A change is held for ``coalesce`` seconds, or until
    ``min_interval`` seconds have passed since the previous ``changed`` frame
    when that is later, and never past the deadline. Every change that lands
    while a frame is held joins that frame, so a burst of writes becomes one
    frame and a steady trickle of them, such as a bulk email send, becomes at
    most one frame per ``min_interval`` without losing the last change. The
    first change after ``ready`` waits only ``coalesce``. A quiet stream
    sends a comment line every ``heartbeat`` seconds so that proxies keep it
    open.
    """

    broker = broker or get_broker()
    subscription = broker.subscribe(event_pk)
    # No frame has gone out yet, so the minimum interval cannot hold back the
    # first change and only the coalescing pause applies to it.
    last_changed = float("-inf")
    try:
        yield b"retry: 2000\n\n"
        yield sse("ready", {"eventId": event_pk})
        while (remaining := deadline - time.monotonic()) > 0:
            if await subscription.wait(min(heartbeat, remaining)):
                now = time.monotonic()
                hold = max(coalesce, min_interval - (now - last_changed))
                # A hold cut short by the deadline still sends its frame ahead
                # of ``reconnect``, so the change it carries is never dropped.
                await asyncio.sleep(min(hold, deadline - now))
                # Clearing only after the hold folds every change that arrived
                # during it into this frame instead of starting another hold.
                subscription.clear()
                last_changed = time.monotonic()
                yield sse("changed", {"at": datetime.now(UTC).isoformat()})
            else:
                yield b": ping\n\n"
        yield sse("reconnect", {})
    finally:
        broker.unsubscribe(event_pk, subscription)
