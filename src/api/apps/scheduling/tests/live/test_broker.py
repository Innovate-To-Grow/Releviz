import asyncio
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.scheduling.services.live.broker import (
    ChangeBroker,
    Subscription,
    get_broker,
    reset_broker,
)
from apps.scheduling.services.live.listener import PostgresListener


class FakeListener:
    def __init__(self, broker):
        self.broker = broker
        self.started = 0

    def start(self):
        self.started += 1


class FakeListenerFactory:
    def __init__(self):
        self.listeners = []

    def __call__(self, broker):
        listener = FakeListener(broker)
        self.listeners.append(listener)
        return listener


class SubscriptionTests(SimpleTestCase):
    async def test_wait_returns_false_on_timeout(self):
        subscription = Subscription()
        self.assertFalse(await subscription.wait(0.01))

    async def test_wait_returns_true_once_notified_until_cleared(self):
        subscription = Subscription()
        subscription.notify()
        self.assertTrue(await subscription.wait(1))
        # The flag stays raised until the stream has acted on it.
        self.assertTrue(await subscription.wait(1))
        subscription.clear()
        self.assertFalse(await subscription.wait(0.01))


class ChangeBrokerTests(SimpleTestCase):
    async def test_subscribe_starts_the_listener_once(self):
        factory = FakeListenerFactory()
        broker = ChangeBroker(listener_factory=factory)
        self.assertEqual(broker.subscriber_count, 0)

        broker.subscribe(1)
        broker.subscribe(1)
        broker.subscribe(2)

        self.assertEqual(len(factory.listeners), 1)
        self.assertIs(factory.listeners[0].broker, broker)
        self.assertEqual(factory.listeners[0].started, 1)
        self.assertEqual(broker.subscriber_count, 3)

    async def test_publish_wakes_only_matching_subscriptions(self):
        broker = ChangeBroker(listener_factory=FakeListenerFactory())
        first = broker.subscribe(1)
        second = broker.subscribe(1)
        other = broker.subscribe(2)

        broker.publish(1)
        # An event nobody watches is simply dropped.
        broker.publish(99)

        self.assertTrue(await first.wait(1))
        self.assertTrue(await second.wait(1))
        self.assertFalse(await other.wait(0.01))

    async def test_publish_all_wakes_every_subscription(self):
        broker = ChangeBroker(listener_factory=FakeListenerFactory())
        subscriptions = [broker.subscribe(1), broker.subscribe(2), broker.subscribe(2)]

        broker.publish_all()

        for subscription in subscriptions:
            self.assertTrue(await subscription.wait(1))

    async def test_unsubscribe_drops_the_count(self):
        broker = ChangeBroker(listener_factory=FakeListenerFactory())
        first = broker.subscribe(1)
        second = broker.subscribe(1)

        broker.unsubscribe(1, first)
        self.assertEqual(broker.subscriber_count, 1)
        broker.publish(1)
        self.assertFalse(await first.wait(0.01))
        self.assertTrue(await second.wait(1))

        broker.unsubscribe(1, second)
        self.assertEqual(broker.subscriber_count, 0)
        # Leaving twice, or after the event has no watchers, is harmless.
        broker.unsubscribe(1, second)
        broker.publish(1)
        self.assertEqual(broker.subscriber_count, 0)

    async def test_the_count_follows_subscribe_and_unsubscribe(self):
        broker = ChangeBroker(listener_factory=FakeListenerFactory())
        first = broker.subscribe(1)
        self.assertEqual(broker.subscriber_count, 1)
        second = broker.subscribe(2)
        third = broker.subscribe(2)
        self.assertEqual(broker.subscriber_count, 3)

        broker.unsubscribe(2, second)
        self.assertEqual(broker.subscriber_count, 2)
        # A second leave of the same subscription does not count again.
        broker.unsubscribe(2, second)
        self.assertEqual(broker.subscriber_count, 2)
        # Nor does a subscription filed under another event, or one the broker
        # never handed out.
        broker.unsubscribe(1, third)
        broker.unsubscribe(3, Subscription())
        self.assertEqual(broker.subscriber_count, 2)

        broker.unsubscribe(1, first)
        broker.unsubscribe(2, third)
        self.assertEqual(broker.subscriber_count, 0)
        broker.unsubscribe(1, first)
        broker.unsubscribe(2, third)
        self.assertEqual(broker.subscriber_count, 0)
        # An event is forgotten once its last watcher leaves.
        self.assertEqual(broker._subscriptions, {})

    def test_the_count_ignores_subscriptions_from_a_previous_loop(self):
        broker = ChangeBroker(listener_factory=FakeListenerFactory())

        async def subscribe_twice():
            return broker.subscribe(1), broker.subscribe(1)

        stale, _ = asyncio.run(subscribe_twice())
        self.assertEqual(broker.subscriber_count, 2)

        async def subscribe_then_leave_with_the_stale_one():
            fresh = broker.subscribe(1)
            # The new loop dropped the old subscriptions and their count.
            self.assertEqual(broker.subscriber_count, 1)
            # A stream from the old loop that closes late does not take the
            # new loop's stream out of the count.
            broker.unsubscribe(1, stale)
            self.assertEqual(broker.subscriber_count, 1)
            broker.unsubscribe(1, fresh)
            self.assertEqual(broker.subscriber_count, 0)

        asyncio.run(subscribe_then_leave_with_the_stale_one())

    def test_the_broker_rebinds_when_the_loop_changes(self):
        factory = FakeListenerFactory()
        broker = ChangeBroker(listener_factory=factory)

        async def subscribe():
            broker.subscribe(1)
            return asyncio.get_running_loop()

        first_loop = asyncio.run(subscribe())
        self.assertEqual(broker.subscriber_count, 1)

        second_loop = asyncio.run(subscribe())
        self.assertIsNot(first_loop, second_loop)
        # The subscription and listener from the closed loop are gone, and a
        # fresh listener runs on the new one.
        self.assertEqual(broker.subscriber_count, 1)
        self.assertEqual(len(factory.listeners), 2)
        self.assertEqual([listener.started for listener in factory.listeners], [1, 1])

    async def test_the_default_listener_is_a_postgres_listener(self):
        broker = ChangeBroker()
        with patch.object(PostgresListener, "start", autospec=True) as start:
            broker.subscribe(1)
        start.assert_called_once()
        self.assertIsInstance(start.call_args.args[0], PostgresListener)


class BrokerSingletonTests(SimpleTestCase):
    def test_get_broker_is_a_singleton_until_reset(self):
        reset_broker()
        self.addCleanup(reset_broker)

        broker = get_broker()
        self.assertIsInstance(broker, ChangeBroker)
        self.assertIs(get_broker(), broker)

        reset_broker()
        self.assertIsNot(get_broker(), broker)
