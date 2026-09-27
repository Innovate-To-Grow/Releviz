"""Refuse oversized request bodies before Django reads them."""

import json

TOO_LARGE_BODY = json.dumps({"error": "Request body too large"}).encode()
TOO_LARGE_HEADERS = [
    (b"content-type", b"application/json"),
    (b"content-length", str(len(TOO_LARGE_BODY)).encode()),
    # The client may still be sending a body nobody will read, so the server
    # closes the connection after the answer instead of draining the rest.
    (b"connection", b"close"),
]


def declared_length(scope) -> int | None:
    """Return the request's ``Content-Length`` when it is a number, else None.

    A malformed value is the server's to reject, and the byte count in the
    middleware still applies to whatever body arrives.
    """

    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def send_too_large(send) -> None:
    await send({"type": "http.response.start", "status": 413, "headers": TOO_LARGE_HEADERS})
    await send({"type": "http.response.body", "body": TOO_LARGE_BODY})


async def answer_lifespan(receive, send) -> None:
    """Complete the server's startup and shutdown handshake on Django's behalf.

    Django has nothing to run at either point. Messages the lifespan spec does
    not define are ignored so an unexpected one cannot end the handshake early.
    """

    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            await send({"type": "lifespan.shutdown.complete"})
            return


class RequestBodyLimitMiddleware:
    """ASGI middleware that answers 413 once a request body passes ``max_bytes``.

    Django's ASGI handler reads the whole body into a temporary file, spilling
    to disk past ``FILE_UPLOAD_MAX_MEMORY_SIZE``, before it resolves the URL or
    runs any middleware or authentication, so without a cap here anyone could
    fill a worker's memory or the task's disk with one request to any path. A
    declared ``Content-Length`` over the cap is refused without calling the
    app. Otherwise every body chunk is counted, which also catches chunked
    uploads and a ``Content-Length`` that understates the body: past the cap
    the middleware answers 413 and hands the app ``http.disconnect``, which
    makes Django abandon the read without sending a response of its own.
    Django reads the whole body before it responds, so the 413 is always the
    first response on the request.

    The lifespan scope is answered here instead of reaching Django. uvicorn
    sends one when each worker boots, and Django's handler raises ValueError
    for it. uvicorn only logs that, but Sentry's Django integration wraps the
    handler and would report it as an unhandled error on every worker boot.
    Websocket and any other scopes still pass through untouched.
    """

    def __init__(self, app, *, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await answer_lifespan(receive, send)
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = declared_length(scope)
        if length is not None and length > self.max_bytes:
            await send_too_large(send)
            return

        received = 0
        refused = False

        async def limited_receive():
            nonlocal received, refused
            if refused:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    refused = True
                    await send_too_large(send)
                    return {"type": "http.disconnect"}
            return message

        await self.app(scope, limited_receive, send)
