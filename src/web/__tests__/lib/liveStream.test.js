/**
 * @jest-environment node
 */

import { connectLiveStream, createEventStreamParser } from "@/lib/liveStream";

// Captured before any test installs fake timers, so the suite can let the
// stream machinery's promises settle without advancing the fake clock.
const realSetImmediate = setImmediate;

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

const STREAM_HEADERS = { "content-type": "text/event-stream" };

// An event-stream response whose body the test feeds by hand.
function openStream({ cancel = () => {} } = {}) {
  const encoder = new TextEncoder();
  const source = { cancel: jest.fn(cancel) };
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel: source.cancel,
  });
  return {
    response: new Response(stream, { status: 200, headers: STREAM_HEADERS }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error) => controller.error(error),
    cancelled: () => source.cancel.mock.calls.length,
  };
}

// A fake fetch that hands out `responses` in order (an Error rejects, and a
// function is called for its response), stays pending once they run out,
// and rejects like fetch does when its signal is aborted.
function fakeOpen(...responses) {
  const signals = [];
  const open = jest.fn(
    (signal) =>
      new Promise((resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () =>
          reject(new DOMException("The user aborted a request.", "AbortError")),
        );
        if (responses.length === 0) return;
        const next = responses.shift();
        if (next instanceof Error) reject(next);
        else resolve(typeof next === "function" ? next() : next);
      }),
  );
  return { open, signals };
}

function handlers() {
  return {
    onOpen: jest.fn(),
    onChange: jest.fn(),
    onDown: jest.fn(),
    onUnavailable: jest.fn(),
  };
}

async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  await settle();
}

describe("event stream parser", () => {
  test("parses fields, comments, multi-line data, and lines split across chunks", () => {
    const parser = createEventStreamParser();
    // A comment block and a retry alone dispatch nothing, but the retry is
    // remembered for the messages that follow.
    expect(parser.push(": ping\n\nretry: 2000\n\n")).toEqual([]);
    expect(parser.push('event: ready\ndata: {"eventId": 7}\n\n')).toEqual([
      { event: "ready", data: '{"eventId": 7}', id: null, retry: 2000 },
    ]);
    // Data alone is a "message"; data lines join with newlines; a value
    // loses one leading space and no more; a field without a colon has an
    // empty value; unknown fields and an invalid retry are ignored.
    expect(
      parser.push(
        "data: first\ndata:  second\ndata\nid: 5\nretry: soon\nfoo: bar\n\n",
      ),
    ).toEqual([
      { event: "message", data: "first\n second\n", id: "5", retry: 2000 },
    ]);
    // An event without data still dispatches, with empty data.
    expect(parser.push("event: reconnect\n\n")).toEqual([
      { event: "reconnect", data: "", id: "5", retry: 2000 },
    ]);
    expect(parser.push("retry: 10\ndata:x\n\n")).toEqual([
      { event: "message", data: "x", id: "5", retry: 10 },
    ]);
    // A line split across chunks waits for its end, and so does a CRLF pair
    // split between chunks; a lone carriage return ends a line too.
    expect(parser.push("event: chan")).toEqual([]);
    expect(parser.push("ged\r\ndata: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\r\n")).toEqual([
      { event: "changed", data: "a\nb", id: "5", retry: 10 },
    ]);
    expect(parser.push("data: c\r\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([
      { event: "message", data: "c", id: "5", retry: 10 },
    ]);
  });
});

describe("live stream connection", () => {
  let live = null;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    live?.close();
    live = null;
    jest.useRealTimers();
  });

  test("reports ready and each change", async () => {
    const stream = openStream();
    const { open } = fakeOpen(stream.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    expect(open).toHaveBeenCalledTimes(1);
    await settle();

    stream.send('retry: 2000\n\nevent: ready\ndata: {"eventId": 7}\n\n');
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(1);
    expect(on.onChange).not.toHaveBeenCalled();

    stream.send('event: changed\ndata: {"at": "t1"}\n\n: ping\n\n');
    await settle();
    expect(on.onChange).toHaveBeenCalledTimes(1);
    // A frame split across chunks is one change, and frames the client does
    // not know are ignored.
    stream.send("event: chan");
    stream.send('ged\ndata: {"at": "t2"}\n\nevent: other\ndata: {}\n\n');
    await settle();
    expect(on.onChange).toHaveBeenCalledTimes(2);
    expect(on.onOpen).toHaveBeenCalledTimes(1);
    expect(on.onDown).not.toHaveBeenCalled();
    expect(on.onUnavailable).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("reconnects at once on a reconnect frame after a connection that lasted, else after the backoff", async () => {
    const first = openStream();
    const second = openStream();
    const third = openStream();
    const { open } = fakeOpen(first.response, second.response, third.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on, random: () => 0.5 });
    await settle();
    first.send("event: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(1);

    // Six seconds in, the server asks for a fresh stream: the old body is
    // cancelled and the new request goes out at once, with no "down".
    await advance(6000);
    first.send("event: reconnect\ndata: {}\n\n");
    await settle();
    expect(first.cancelled()).toBe(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(on.onDown).not.toHaveBeenCalled();
    second.send("event: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(2);

    // A reconnect after only a second waits the current backoff instead.
    await advance(1000);
    second.send("event: reconnect\ndata: {}\n\n");
    await settle();
    expect(second.cancelled()).toBe(1);
    expect(open).toHaveBeenCalledTimes(2);
    await advance(999);
    expect(open).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(3);
    expect(on.onDown).not.toHaveBeenCalled();
  });

  test("backs off after the body ends, a rejected open, or a read error, caps the wait, and resets after a long connection", async () => {
    const streams = [
      openStream(),
      openStream(),
      openStream(),
      openStream(),
      openStream(),
    ];
    const { open } = fakeOpen(
      streams[0].response,
      new TypeError("Failed to fetch"),
      streams[1].response,
      streams[2].response,
      streams[3].response,
      streams[4].response,
    );
    const on = handlers();
    const random = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(0.5);
    live = connectLiveStream({
      open,
      ...on,
      backoffMs: { initial: 1000, max: 3000 },
      random,
    });
    await settle();

    // The body ends: down, and the first wait is a second less its jitter.
    streams[0].end();
    await settle();
    expect(on.onDown).toHaveBeenLastCalledWith("ended");
    await advance(749);
    expect(open).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(2);

    // The open itself fails: two seconds plus its jitter.
    expect(on.onDown).toHaveBeenLastCalledWith("unreachable");
    await advance(2499);
    expect(open).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(3);

    // A read error: the wait is capped at three seconds now.
    streams[1].fail(new Error("connection reset"));
    await settle();
    expect(on.onDown).toHaveBeenLastCalledWith("interrupted");
    await advance(2999);
    expect(open).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(4);

    // And stays there.
    streams[2].end();
    await settle();
    await advance(2999);
    expect(open).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(5);

    // A connection that lived half a minute puts the backoff back to the
    // initial wait.
    await advance(30000);
    streams[3].end();
    await settle();
    await advance(999);
    expect(open).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(6);
    expect(on.onDown).toHaveBeenCalledTimes(5);
    expect(on.onOpen).not.toHaveBeenCalled();
    expect(on.onUnavailable).not.toHaveBeenCalled();
  });

  test("waits the Retry-After of a 204 or 429, clamped, and unavailableMs without a usable one", async () => {
    const declined = (status, retryAfter) =>
      new Response(null, {
        status,
        headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      });
    const stream = openStream();
    const { open } = fakeOpen(
      () => declined(204, "60"),
      () => declined(204),
      () => declined(204, "0"),
      () => declined(204, "5000"),
      () => declined(204, "Sat, 26 Sep 2026 12:00:00 GMT"),
      () => declined(429, "30"),
      () => declined(429),
      stream.response,
    );
    const on = handlers();
    live = connectLiveStream({ open, ...on, unavailableMs: 5000 });
    await settle();
    expect(on.onUnavailable).toHaveBeenCalledTimes(1);

    const expectNextOpenAfter = async (ms, count) => {
      await advance(ms - 1);
      expect(open).toHaveBeenCalledTimes(count - 1);
      await advance(1);
      expect(open).toHaveBeenCalledTimes(count);
    };
    // The header is in seconds.
    await expectNextOpenAfter(60000, 2);
    // No header: the default.
    await expectNextOpenAfter(5000, 3);
    // Never sooner than a second, never later than fifteen minutes.
    await expectNextOpenAfter(1000, 4);
    await expectNextOpenAfter(900000, 5);
    // A date rather than a number of seconds: the default again.
    await expectNextOpenAfter(5000, 6);
    // A 429 is read the same way, with or without the header, and this time
    // the stream is there.
    await expectNextOpenAfter(30000, 7);
    await expectNextOpenAfter(5000, 8);
    expect(on.onUnavailable).toHaveBeenCalledTimes(7);

    stream.send("event: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(1);
    expect(on.onDown).not.toHaveBeenCalled();
    expect(on.onUnavailable).toHaveBeenCalledTimes(7);
  });

  test.each([400, 405, 406, 409, 410, 413, 415, 422])(
    "waits unavailableMs after a %i, whatever its Retry-After, without counting it as down",
    async (status) => {
      const stream = openStream();
      const { open } = fakeOpen(
        () => new Response(null, { status, headers: { "Retry-After": "1" } }),
        stream.response,
      );
      const on = handlers();
      live = connectLiveStream({ open, ...on, unavailableMs: 5000 });
      await settle();
      expect(on.onUnavailable).toHaveBeenCalledTimes(1);
      await advance(4999);
      expect(open).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(open).toHaveBeenCalledTimes(2);
      stream.send("event: ready\ndata: {}\n\n");
      await settle();
      expect(on.onOpen).toHaveBeenCalledTimes(1);
      expect(on.onUnavailable).toHaveBeenCalledTimes(1);
      expect(on.onDown).not.toHaveBeenCalled();
    },
  );

  test.each([401, 403, 404])("stops for good after a %i", async (status) => {
    const { open } = fakeOpen(new Response(null, { status }));
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    await settle();
    expect(on.onUnavailable).toHaveBeenCalledTimes(1);
    await advance(3600000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(on.onUnavailable).toHaveBeenCalledTimes(1);
    expect(on.onDown).not.toHaveBeenCalled();
  });

  test("a 200 that is not an event stream counts as down, as do a 408 and every 5xx", async () => {
    const { open } = fakeOpen(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200 },
        ),
      () => new Response(null, { status: 200, headers: STREAM_HEADERS }),
      () => new Response(null, { status: 408 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 502 }),
      () => new Response(null, { status: 503 }),
    );
    const on = handlers();
    live = connectLiveStream({
      open,
      ...on,
      backoffMs: { initial: 100, max: 100 },
      random: () => 0.5,
    });
    await settle();
    for (let count = 2; count <= 8; count += 1) {
      await advance(100);
      expect(open).toHaveBeenCalledTimes(count);
    }
    expect(on.onDown.mock.calls).toEqual([
      ["not an event stream"],
      ["not an event stream"],
      ["not an event stream"],
      ["HTTP 408"],
      ["HTTP 500"],
      ["HTTP 502"],
      ["HTTP 503"],
    ]);
    expect(on.onOpen).not.toHaveBeenCalled();
    expect(on.onUnavailable).not.toHaveBeenCalled();
  });

  test("close aborts a pending open and never retries", async () => {
    const { open, signals } = fakeOpen();
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    expect(signals[0].aborted).toBe(false);
    live.close();
    expect(signals[0].aborted).toBe(true);
    await advance(60000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(on.onDown).not.toHaveBeenCalled();
    expect(on.onUnavailable).not.toHaveBeenCalled();
  });

  test("close cancels the reader and silences a chunk that was already on its way", async () => {
    const stream = openStream({
      cancel: () => {
        throw new Error("already gone");
      },
    });
    const { open } = fakeOpen(stream.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on, random: () => 0.5 });
    await settle();
    stream.send("event: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(1);

    // The chunk resolves the pending read before close runs, and the
    // source's own cancel failing is nobody's concern.
    stream.send("event: changed\ndata: {}\n\n");
    live.close();
    expect(stream.cancelled()).toBe(1);
    await settle();
    await advance(60000);
    expect(on.onChange).not.toHaveBeenCalled();
    expect(on.onDown).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("close just after a declined answer arrives silences its callback", async () => {
    // The open has resolved, but the attempt has not yet looked at it when
    // the caller closes.
    const { open } = fakeOpen(
      new Response(null, { status: 204, headers: { "Retry-After": "1" } }),
    );
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    live.close();
    await settle();
    await advance(60000);
    expect(on.onUnavailable).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("close during a backoff wait ends the retries", async () => {
    const stream = openStream();
    const { open } = fakeOpen(stream.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on, random: () => 0.5 });
    await settle();
    stream.end();
    await settle();
    expect(on.onDown).toHaveBeenCalledTimes(1);
    await advance(500);
    live.close();
    await advance(60000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("a stream that goes silent is down after idleMs and reopens after the backoff", async () => {
    const first = openStream();
    const second = openStream();
    const { open } = fakeOpen(first.response, second.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on, random: () => 0.5 });
    await settle();
    first.send("retry: 2000\n\nevent: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(1);

    // Nothing more arrives, not even a ping, as when the connection went
    // half-open. Fifty seconds of that and the read is cancelled.
    await advance(49999);
    expect(first.cancelled()).toBe(0);
    expect(on.onDown).not.toHaveBeenCalled();
    await advance(1);
    expect(first.cancelled()).toBe(1);
    expect(on.onDown.mock.calls).toEqual([["interrupted"]]);

    // It lasted longer than half a minute, so the wait is the initial one.
    await advance(999);
    expect(open).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(2);
    second.send("event: ready\ndata: {}\n\n");
    await settle();
    expect(on.onOpen).toHaveBeenCalledTimes(2);
    expect(on.onDown).toHaveBeenCalledTimes(1);
  });

  test("pings keep a quiet stream alive past idleMs", async () => {
    const stream = openStream();
    const { open } = fakeOpen(stream.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    await settle();
    stream.send("event: ready\ndata: {}\n\n");
    await settle();

    // A minute and a half of pings and nothing else is a healthy stream.
    for (let i = 0; i < 3; i += 1) {
      await advance(30000);
      stream.send(": ping\n\n");
      await settle();
    }
    expect(on.onDown).not.toHaveBeenCalled();
    expect(stream.cancelled()).toBe(0);

    // The wait restarts from the last ping.
    await advance(49999);
    expect(on.onDown).not.toHaveBeenCalled();
    await advance(1);
    expect(on.onDown).toHaveBeenLastCalledWith("interrupted");
    expect(stream.cancelled()).toBe(1);
    expect(on.onChange).not.toHaveBeenCalled();
  });

  test("a replacement stream that stays silent after a reconnect frame is down after idleMs", async () => {
    // A proxy that buffers the new response holds its bytes back, so the
    // workspace would otherwise go on trusting a stream that says nothing.
    const first = openStream();
    const second = openStream();
    const { open } = fakeOpen(first.response, second.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on, idleMs: 10000 });
    await settle();
    first.send("event: ready\ndata: {}\n\n");
    await settle();
    await advance(6000);
    first.send("event: reconnect\ndata: {}\n\n");
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(on.onDown).not.toHaveBeenCalled();

    await advance(9999);
    expect(on.onDown).not.toHaveBeenCalled();
    await advance(1);
    expect(on.onDown).toHaveBeenLastCalledWith("interrupted");
    expect(second.cancelled()).toBe(1);
    expect(on.onOpen).toHaveBeenCalledTimes(1);
  });

  test("an open that hangs is aborted after idleMs and counts as down", async () => {
    const { open, signals } = fakeOpen();
    const on = handlers();
    live = connectLiveStream({ open, ...on, random: () => 0.5 });
    await advance(49999);
    expect(signals[0].aborted).toBe(false);
    await advance(1);
    expect(signals[0].aborted).toBe(true);
    expect(on.onDown.mock.calls).toEqual([["unreachable"]]);
    await advance(999);
    expect(open).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
  });

  test("close clears the watchdog, which never fires afterwards", async () => {
    const stream = openStream();
    const { open } = fakeOpen(stream.response);
    const on = handlers();
    live = connectLiveStream({ open, ...on });
    await settle();
    stream.send("event: ready\ndata: {}\n\n");
    await settle();
    await advance(20000);
    expect(jest.getTimerCount()).toBe(1);

    // No timer is left even before the cancelled read has settled.
    live.close();
    expect(jest.getTimerCount()).toBe(0);
    expect(stream.cancelled()).toBe(1);
    await settle();
    await advance(3600000);
    expect(stream.cancelled()).toBe(1);
    expect(on.onDown).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
