import asyncio
import json
import time
from contextlib import aclosing
from datetime import datetime
from itertools import pairwise
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.scheduling.services.live import stream as stream_module
from apps.scheduling.services.live.broker import ChangeBroker
from apps.scheduling.services.live.stream import event_changes, sse, stream_deadline


class FakeListener:
    def __init__(self, broker):
        self.broker = broker

    def start(self):
        pass


class SseFrameTests(SimpleTestCase):
    def test_sse_frames_carry_the_event_name_and_json_payload(self):
        self.assertEqual(sse("ready", {"eventId": 7}), b'event: ready\ndata: {"eventId": 7}\n\n')
        self.assertEqual(sse("reconnect", {}), b"event: reconnect\ndata: {}\n\n")


class StreamDeadlineTests(SimpleTestCase):
    def test_deadline_prefers_token_expiry(self):
        auth = SimpleNamespace(payload={"exp": 1_000_060})
        before = time.monotonic()
        self.assertAlmostEqual(
            stream_deadline(auth, max_seconds=900, now=1_000_000) - before, 60, delta=0.5
        )

    def test_deadline_falls_back_to_the_cap_without_a_token(self):
        before = time.monotonic()
        self.assertAlmostEqual(stream_deadline(None, max_seconds=900) - before, 900, delta=0.5)
        # A token without an expiry claim behaves the same way.
        self.assertAlmostEqual(
            stream_deadline(SimpleNamespace(payload={}), max_seconds=900) - before,
            900,
            delta=0.5,
        )
        # A cap shorter than the token's remaining life wins.
        auth = SimpleNamespace(payload={"exp": 1_000_600})
        self.assertAlmostEqual(
            stream_deadline(auth, max_seconds=120, now=1_000_000) - before, 120, delta=0.5
        )

    def test_an_expired_token_ends_the_stream_at_once(self):
        auth = SimpleNamespace(payload={"exp": time.time() - 10})
        self.assertLessEqual(stream_deadline(auth, max_seconds=900), time.monotonic())


class StreamTestCase(SimpleTestCase):
    """Builds streams for event 7 on a broker of its own, with fast defaults."""

    def setUp(self):
        self.broker = ChangeBroker(listener_factory=FakeListener)

    def frames(self, **overrides):
        options = {
            "deadline": time.monotonic() + 60,
            "heartbeat": 5,
            "coalesce": 0,
            "min_interval": 0,
            "broker": self.broker,
        }
        options.update(overrides)
        return event_changes(7, **options)

    async def skip_opening(self, frames):
        """Consume the ``retry`` and ``ready`` frames every stream starts with."""

        await anext(frames)
        await anext(frames)

    async def collect(self, frames):
        return [frame async for frame in frames]


class EventChangesTests(StreamTestCase):
    async def test_first_frames_are_retry_and_ready(self):
        async with aclosing(self.frames()) as frames:
            self.assertEqual(await anext(frames), b"retry: 2000\n\n")
            self.assertEqual(await anext(frames), b'event: ready\ndata: {"eventId": 7}\n\n')
            self.assertEqual(self.broker.subscriber_count, 1)

    async def test_changed_frame_after_publish_coalesces_bursts(self):
        async with aclosing(self.frames(heartbeat=0.05, coalesce=0.05)) as frames:
            await anext(frames)
            await anext(frames)

            self.broker.publish(7)
            self.broker.publish(7)
            pending = asyncio.ensure_future(anext(frames))
            # A change that lands inside the coalescing pause joins the burst.
            await asyncio.sleep(0.01)
            self.broker.publish(7)
            frame = await pending

            self.assertTrue(frame.startswith(b"event: changed\ndata: "))
            payload = json.loads(frame.split(b"data: ", 1)[1])
            self.assertEqual(datetime.fromisoformat(payload["at"]).utcoffset().total_seconds(), 0)
            # The burst produced one frame and the stream is quiet again.
            self.assertEqual(await anext(frames), b": ping\n\n")

    async def test_ping_on_heartbeat_timeout(self):
        async with aclosing(self.frames(heartbeat=0.01)) as frames:
            await anext(frames)
            await anext(frames)
            self.assertEqual(await anext(frames), b": ping\n\n")
            # A change after a ping still gets its own frame.
            self.broker.publish(7)
            self.assertTrue((await anext(frames)).startswith(b"event: changed\n"))

    async def test_reconnect_frame_at_the_deadline(self):
        async with aclosing(self.frames(deadline=time.monotonic() + 0.05, heartbeat=10)) as frames:
            collected = [frame async for frame in frames]

        self.assertEqual(collected[0], b"retry: 2000\n\n")
        self.assertEqual(collected[1], b'event: ready\ndata: {"eventId": 7}\n\n')
        # The wait is capped at the time left, so the heartbeat never
        # outlives the deadline.
        self.assertGreaterEqual(len(collected), 4)
        self.assertEqual(set(collected[2:-1]), {b": ping\n\n"})
        self.assertEqual(collected[-1], b"event: reconnect\ndata: {}\n\n")
        self.assertEqual(self.broker.subscriber_count, 0)

    async def test_a_deadline_already_past_reconnects_without_waiting(self):
        async with aclosing(self.frames(deadline=time.monotonic() - 1)) as frames:
            collected = [frame async for frame in frames]

        self.assertEqual(
            collected,
            [
                b"retry: 2000\n\n",
                b'event: ready\ndata: {"eventId": 7}\n\n',
                b"event: reconnect\ndata: {}\n\n",
            ],
        )

    async def test_unsubscribes_when_closed(self):
        frames = self.frames()
        async with aclosing(frames):
            await anext(frames)
            self.assertEqual(self.broker.subscriber_count, 1)
        self.assertEqual(self.broker.subscriber_count, 0)

    async def test_uses_the_shared_broker_by_default(self):
        with patch.object(stream_module, "get_broker", return_value=self.broker):
            stream = event_changes(
                7, deadline=time.monotonic() + 60, heartbeat=5, coalesce=0, min_interval=0
            )
            async with aclosing(stream) as frames:
                await anext(frames)
                self.assertEqual(self.broker.subscriber_count, 1)
        self.assertEqual(self.broker.subscriber_count, 0)


class EventChangesMinimumIntervalTests(StreamTestCase):
    """Spacing between ``changed`` frames, with real but short intervals.

    Scheduling delays only ever make a hold longer, so the lower bounds on the
    gaps between frames allow a few milliseconds for timer rounding and the
    upper bounds are loose enough for a slow runner.
    """

    MIN_INTERVAL = 0.2
    SLACK = 0.01

    def spaced(self, **overrides):
        return self.frames(**{"min_interval": self.MIN_INTERVAL, "heartbeat": 0.5, **overrides})

    async def test_the_first_change_after_ready_waits_only_for_the_coalescing_pause(self):
        async with aclosing(self.spaced(min_interval=30)) as frames:
            await self.skip_opening(frames)
            self.broker.publish(7)
            # Measuring the interval from ``ready`` would hold this frame for
            # thirty seconds.
            frame = await asyncio.wait_for(anext(frames), 2)

        self.assertTrue(frame.startswith(b"event: changed\n"))

    async def test_a_burst_after_a_frame_becomes_one_frame_after_the_minimum_interval(self):
        async with aclosing(self.spaced()) as frames:
            await self.skip_opening(frames)
            self.broker.publish(7)
            self.assertTrue((await anext(frames)).startswith(b"event: changed\n"))
            first_sent = time.monotonic()

            self.broker.publish(7)
            self.broker.publish(7)
            pending = asyncio.ensure_future(anext(frames))
            await asyncio.sleep(0.05)
            self.broker.publish(7)
            frame = await pending
            gap = time.monotonic() - first_sent

            self.assertTrue(frame.startswith(b"event: changed\n"))
            self.assertGreaterEqual(gap, self.MIN_INTERVAL - self.SLACK)
            # Every change of the burst rode in that one frame.
            self.assertEqual(await anext(frames), b": ping\n\n")

    async def test_a_change_while_a_frame_is_held_goes_out_in_exactly_that_frame(self):
        async with aclosing(self.spaced()) as frames:
            await self.skip_opening(frames)
            self.broker.publish(7)
            await anext(frames)

            self.broker.publish(7)
            pending = asyncio.ensure_future(anext(frames))
            await asyncio.sleep(self.MIN_INTERVAL / 2)
            # The frame for the previous change is still being held when this
            # one lands, so the frame that follows covers it.
            self.assertFalse(pending.done())
            self.broker.publish(7)
            frame = await pending

            self.assertTrue(frame.startswith(b"event: changed\n"))
            # The change was neither dropped nor sent a second time.
            self.assertEqual(await anext(frames), b": ping\n\n")

            # A change after that frame gets a frame of its own.
            self.broker.publish(7)
            self.assertTrue((await anext(frames)).startswith(b"event: changed\n"))

    async def test_a_steady_trickle_is_spaced_out_and_its_last_change_still_goes_out(self):
        async def trickle():
            # Like the email worker's bulk send: a change every few
            # milliseconds for longer than a single hold.
            for _ in range(20):
                self.broker.publish(7)
                last_published = time.monotonic()
                await asyncio.sleep(0.02)
            return last_published

        async with aclosing(self.spaced()) as frames:
            await self.skip_opening(frames)
            writer = asyncio.ensure_future(trickle())
            sent = []
            while (frame := await anext(frames)) != b": ping\n\n":
                self.assertTrue(frame.startswith(b"event: changed\n"))
                sent.append(time.monotonic())

        self.assertTrue(writer.done())
        # The first change went out at once and the rest were held, so twenty
        # changes arrived as a few frames spaced at least the minimum apart
        # rather than as one frame per change.
        self.assertGreaterEqual(len(sent), 2)
        gaps = [later - earlier for earlier, later in pairwise(sent)]
        self.assertGreaterEqual(min(gaps), self.MIN_INTERVAL - self.SLACK)
        # The trailing change is covered by a frame sent after it.
        self.assertGreater(sent[-1], writer.result())

    async def test_a_hold_never_runs_past_the_deadline(self):
        stream = self.spaced(deadline=time.monotonic() + 0.5, min_interval=30)
        async with aclosing(stream) as frames:
            await self.skip_opening(frames)
            self.broker.publish(7)
            await anext(frames)
            self.broker.publish(7)
            # The thirty-second hold is cut short at the deadline.
            collected = await asyncio.wait_for(self.collect(frames), 3)

        self.assertEqual(len(collected), 2)
        self.assertTrue(collected[0].startswith(b"event: changed\n"))
        self.assertEqual(collected[1], b"event: reconnect\ndata: {}\n\n")
