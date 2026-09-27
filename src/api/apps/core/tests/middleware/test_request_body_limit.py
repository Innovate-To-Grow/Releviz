import json

from django.core.asgi import get_asgi_application
from django.test import SimpleTestCase

from apps.core.middleware.request_body_limit import RequestBodyLimitMiddleware

LIMIT = 10


def http_scope(*headers):
    return {
        "type": "http",
        "method": "POST",
        "path": "/events/roster-imports",
        "query_string": b"",
        "headers": [(b"host", b"testserver"), *headers],
    }


def body(chunk, *, more_body=False):
    return {"type": "http.request", "body": chunk, "more_body": more_body}


class FakeReceive:
    """Hand out queued messages and count how often the app asked."""

    def __init__(self, *messages):
        self.messages = list(messages)
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        return self.messages.pop(0)


class FakeSend:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)


class ReadingApp:
    """Read the whole body like Django does, then answer 200 unless disconnected."""

    def __init__(self, *, extra_receives=0):
        self.called = False
        self.received = []
        self.extra_receives = extra_receives

    async def __call__(self, scope, receive, send):
        self.called = True
        while True:
            message = await receive()
            self.received.append(message)
            if message["type"] == "http.disconnect":
                for _ in range(self.extra_receives):
                    self.received.append(await receive())
                return
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


class PassThroughApp:
    def __init__(self):
        self.calls = []

    async def __call__(self, scope, receive, send):
        self.calls.append((scope, receive, send))


def assert_single_413(test, sent):
    test.assertEqual(
        [message["type"] for message in sent], ["http.response.start", "http.response.body"]
    )
    start, response_body = sent
    test.assertEqual(start["status"], 413)
    headers = dict(start["headers"])
    test.assertEqual(headers[b"content-type"], b"application/json")
    test.assertEqual(headers[b"content-length"], str(len(response_body["body"])).encode())
    test.assertEqual(headers[b"connection"], b"close")
    test.assertEqual(json.loads(response_body["body"]), {"error": "Request body too large"})


class RequestBodyLimitMiddlewareTests(SimpleTestCase):
    async def test_small_body_passes_through_untouched(self):
        messages = [body(b"abc", more_body=True), body(b"defg")]
        receive = FakeReceive(*messages)
        send = FakeSend()
        app = ReadingApp()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"content-length", b"7")), receive, send
        )

        self.assertEqual(len(app.received), 2)
        for received, original in zip(app.received, messages, strict=True):
            self.assertIs(received, original)
        self.assertEqual(messages, [body(b"abc", more_body=True), body(b"defg")])
        self.assertEqual([message.get("status") for message in send.messages], [200, None])
        self.assertEqual(send.messages[1]["body"], b"ok")

    async def test_declared_oversize_length_is_refused_without_calling_the_app(self):
        receive = FakeReceive()
        send = FakeSend()
        app = ReadingApp()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"content-length", b"11")), receive, send
        )

        self.assertFalse(app.called)
        self.assertEqual(receive.calls, 0)
        assert_single_413(self, send.messages)

    async def test_oversize_chunked_body_gets_one_413_and_the_app_sees_a_disconnect(self):
        receive = FakeReceive(body(b"123456", more_body=True), body(b"78901", more_body=True))
        send = FakeSend()
        # Further reads after the refusal must not reach the server again.
        app = ReadingApp(extra_receives=2)

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"transfer-encoding", b"chunked")), receive, send
        )

        self.assertEqual(
            [message["type"] for message in app.received],
            ["http.request", "http.disconnect", "http.disconnect", "http.disconnect"],
        )
        self.assertEqual(receive.calls, 2)
        assert_single_413(self, send.messages)

    async def test_body_exactly_at_the_limit_passes(self):
        messages = [body(b"12345", more_body=True), body(b"67890")]
        receive = FakeReceive(*[dict(message) for message in messages])
        send = FakeSend()
        app = ReadingApp()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"content-length", str(LIMIT).encode())), receive, send
        )

        self.assertEqual(app.received, messages)
        self.assertEqual(send.messages[0]["status"], 200)

    async def test_understated_length_is_still_counted(self):
        receive = FakeReceive(body(b"12345678901"))
        send = FakeSend()
        app = ReadingApp()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"content-length", b"3")), receive, send
        )

        self.assertEqual(app.received, [{"type": "http.disconnect"}])
        assert_single_413(self, send.messages)

    async def test_non_numeric_length_is_left_to_the_server_and_counting_still_applies(self):
        receive = FakeReceive(body(b"x" * (LIMIT + 1)))
        send = FakeSend()
        app = ReadingApp()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            http_scope((b"content-length", b"lots")), receive, send
        )

        self.assertTrue(app.called)
        self.assertEqual(app.received, [{"type": "http.disconnect"}])
        assert_single_413(self, send.messages)

    async def test_server_disconnect_and_empty_messages_pass_through(self):
        # Django keeps listening for the client to go away after the body.
        receive = FakeReceive({"type": "http.request"}, {"type": "http.disconnect"})
        send = FakeSend()
        received = []

        async def app(scope, receive, send):
            received.append(await receive())
            received.append(await receive())

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            {"type": "http", "method": "GET", "path": "/health"}, receive, send
        )

        self.assertEqual(received, [{"type": "http.request"}, {"type": "http.disconnect"}])
        self.assertEqual(send.messages, [])

    async def test_lifespan_startup_and_shutdown_are_answered_without_reaching_the_app(self):
        # Django raises on a lifespan scope, which Sentry reports on every worker boot.
        app = PassThroughApp()
        receive = FakeReceive({"type": "lifespan.startup"}, {"type": "lifespan.shutdown"})
        send = FakeSend()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(
            {"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send
        )

        self.assertEqual(app.calls, [])
        self.assertEqual(receive.calls, 2)
        self.assertEqual(
            send.messages,
            [{"type": "lifespan.startup.complete"}, {"type": "lifespan.shutdown.complete"}],
        )

    async def test_lifespan_messages_outside_the_spec_do_not_end_the_handshake(self):
        app = PassThroughApp()
        receive = FakeReceive({"type": "lifespan.unknown"}, {"type": "lifespan.shutdown"})
        send = FakeSend()

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)({"type": "lifespan"}, receive, send)

        self.assertEqual(app.calls, [])
        self.assertEqual(receive.calls, 2)
        self.assertEqual(send.messages, [{"type": "lifespan.shutdown.complete"}])

    async def test_websocket_scope_passes_straight_through(self):
        app = PassThroughApp()
        receive = FakeReceive()
        send = FakeSend()
        scope = {"type": "websocket", "headers": [(b"content-length", b"999")]}

        await RequestBodyLimitMiddleware(app, max_bytes=LIMIT)(scope, receive, send)

        self.assertEqual(len(app.calls), 1)
        app_scope, app_receive, app_send = app.calls[0]
        self.assertIs(app_scope, scope)
        self.assertIs(app_receive, receive)
        self.assertIs(app_send, send)
        self.assertEqual(receive.calls, 0)
        self.assertEqual(send.messages, [])

    async def test_django_abandons_the_read_and_sends_nothing_of_its_own(self):
        receive = FakeReceive(
            body(b"x" * 6, more_body=True),
            body(b"x" * 6, more_body=True),
        )
        send = FakeSend()

        await RequestBodyLimitMiddleware(get_asgi_application(), max_bytes=LIMIT)(
            http_scope((b"content-type", b"application/json")), receive, send
        )

        self.assertEqual(receive.calls, 2)
        assert_single_413(self, send.messages)
