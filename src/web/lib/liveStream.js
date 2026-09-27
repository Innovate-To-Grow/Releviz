// Server-pushed change notifications for the organizer workspace. The API's
// `GET /events/stream` is a Server-Sent Events response: `ready` once the
// server is listening for the event, `changed` whenever something about it
// was written, and `reconnect` when the client should open a fresh stream
// (the server ends one when its access token is about to expire). A quiet
// stream carries a `: ping` comment every twenty seconds, so one that stays
// silent much longer than that is treated as lost even when the socket has
// not said so, as after a laptop sleeps, the Wi-Fi changes, or a NAT entry
// expires. A server that cannot serve a stream at all, or already serves as
// many as it should, answers 204 No Content with a `Retry-After` in seconds,
// and the workspace polls until then. The browser cannot use `EventSource`
// here because the request carries a bearer token, so the body is read with
// `fetch` and a `ReadableStream` instead. Nothing in this module touches the
// DOM, and it runs unchanged under Node.

// A reconnect frame this soon after opening means the server is turning
// streams over faster than it should (a token that will not refresh, say),
// so the client waits its backoff instead of reopening at once.
const RECONNECT_AT_ONCE_MS = 5000;
// A connection that lasted this long shows the server is healthy again, so
// the backoff starts over from the initial wait once it ends.
const STABLE_CONNECTION_MS = 30000;
// Bounds on the `Retry-After` a declined stream may ask for, in seconds.
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 900;
const STREAM_CONTENT_TYPE = "text/event-stream";

function ignore() {}

/**
 * Parses the text/event-stream wire format incrementally. `push` takes the
 * next piece of text (a chunk may end in the middle of a line, which is kept
 * for the next push) and returns the messages it completed: the event name
 * (`message` when the server named none), the data with several data lines
 * joined by newlines, and the last `id` and `retry` the stream has sent.
 * Comment lines are dropped, and a blank line dispatches only when the block
 * named an event or carried data.
 */
export function createEventStreamParser() {
  let pending = "";
  let event = "";
  let data = null;
  let id = null;
  let retry = null;

  const handleLine = (line, messages) => {
    if (line === "") {
      if (event || data !== null) {
        messages.push({
          event: event || "message",
          data: data ?? "",
          id,
          retry,
        });
      }
      event = "";
      data = null;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data")
      data = data === null ? value : `${data}\n${value}`;
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  };

  return {
    push(text) {
      pending += text;
      // A trailing carriage return may be the first half of a CRLF pair whose
      // second half is in the next chunk, so it waits there.
      const tail = pending.endsWith("\r") ? "\r" : "";
      const lines = pending
        .slice(0, pending.length - tail.length)
        .split(/\r\n|\n|\r/);
      pending = lines.pop() + tail;
      const messages = [];
      for (const line of lines) handleLine(line, messages);
      return messages;
    },
  };
}

/**
 * Holds one event stream open for as long as the caller wants it, reopening
 * it whenever it drops. `open(signal)` fetches the stream and resolves to
 * the raw `Response`; `onOpen` fires on the server's `ready` frame and
 * `onChange` on each `changed` frame. `onDown(reason)` says the connection
 * was lost and will be retried after a backoff (doubling from
 * `backoffMs.initial` up to `backoffMs.max`, with a quarter of jitter
 * either way): a rejected open, a 408, any 5xx (a load balancer's 503
 * included), a 200 that is not an event stream, a body that ends or fails,
 * and an attempt that hears nothing for `idleMs` (no response, no chunk, no
 * ping) all count as down. `onUnavailable` says the server declined: a 204
 * or 429 is retried once its `Retry-After` seconds (kept within a second
 * and fifteen minutes, or `unavailableMs` without a usable one) have
 * passed, a 401, 403, or 404 ends the attempts for good, and any other 4xx
 * is retried after `unavailableMs`, since a server that refuses the request
 * as made will not change its mind within seconds. Returns `close`, after
 * which no callback is called again.
 */
export function connectLiveStream({
  open,
  onOpen,
  onChange,
  onDown,
  onUnavailable,
  backoffMs = { initial: 1000, max: 30000 },
  unavailableMs = 300000,
  idleMs = 50000,
  now = () => Date.now(),
  random = Math.random,
}) {
  let closed = false;
  let controller = null;
  let reader = null;
  let timer = null;
  let idleTimer = null;
  let wake = ignore;
  let backoff = backoffMs.initial;

  // Once closed, a read that settles late (WebKit rejects a pending read
  // with a TypeError rather than an AbortError), an answer that arrived
  // just before the close, or a chunk that was already on its way must
  // change nothing, so every callback passes through here.
  const emit = (callback, ...args) => {
    if (!closed) callback(...args);
  };

  // The timer and the clock are looked up at call time so that fake timers
  // in tests take effect.
  const sleep = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });

  // The wait before the next attempt after a failure: the current backoff
  // with a quarter of jitter either way, so tabs cut off together do not
  // return together; the backoff then doubles, up to the cap.
  const backoffWait = () => {
    const ms = Math.round(backoff * (0.75 + random() * 0.5));
    backoff = Math.min(backoff * 2, backoffMs.max);
    return ms;
  };

  const down = (reason) => {
    emit(onDown, reason);
    return backoffWait();
  };

  // How long a declined stream keeps the client away: the `Retry-After`
  // header's seconds, kept within reason, or the default when the header
  // is missing or is not a whole number of seconds.
  const retryAfterWait = (response) => {
    const header = response.headers.get("retry-after") || "";
    if (!/^\d+$/.test(header)) return unavailableMs;
    const seconds = Number(header);
    return (
      Math.min(Math.max(seconds, RETRY_AFTER_MIN_S), RETRY_AFTER_MAX_S) * 1000
    );
  };

  // The watchdog: a connection that went half-open leaves a pending open or
  // read waiting forever, and meanwhile the caller would go on believing the
  // stream is up. The server pings every twenty seconds, so an attempt that
  // hears nothing for `idleMs` is ended by `onIdle` and counts as down. It
  // is armed as the request goes out, and once the stream is open every
  // chunk, pings included, arms it afresh.
  const armIdle = (onIdle) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, idleMs);
  };

  // Reads one open stream until it ends ("ended"), fails or goes silent
  // ("interrupted"), or asks for a fresh one ("reconnect").
  const consume = async (response) => {
    const current = response.body.getReader();
    reader = current;
    const decoder = new TextDecoder();
    const parser = createEventStreamParser();
    let idle = false;
    // Cancelling settles the pending read, as done or (in some engines) as
    // an error, and the flag makes a done read an interruption rather than
    // an end the server chose.
    const stall = () => {
      idle = true;
      current.cancel().catch(ignore);
    };
    try {
      armIdle(stall);
      for (;;) {
        const { done, value } = await current.read();
        if (done) return idle ? "interrupted" : "ended";
        armIdle(stall);
        const text = decoder.decode(value, { stream: true });
        for (const message of parser.push(text)) {
          if (message.event === "ready") emit(onOpen);
          else if (message.event === "changed") emit(onChange);
          else if (message.event === "reconnect") {
            current.cancel().catch(ignore);
            return "reconnect";
          }
        }
      }
    } catch {
      return "interrupted";
    } finally {
      clearTimeout(idleTimer);
      reader = null;
    }
  };

  // One attempt: resolves to the wait before the next one in milliseconds,
  // or to null when there is to be no next one.
  const attempt = async () => {
    const aborter = new AbortController();
    controller = aborter;
    let response = null;
    // An open that hangs (a request sent down a connection that is already
    // dead, say) is aborted by the watchdog, and fetch rejects on the abort.
    armIdle(() => aborter.abort());
    try {
      response = await open(aborter.signal);
    } catch {
      // A rejected open is reported as down below, like any other failure.
    } finally {
      clearTimeout(idleTimer);
    }
    if (!response) return down("unreachable");
    const { status } = response;
    if (status === 401 || status === 403 || status === 404) {
      emit(onUnavailable);
      return null;
    }
    if (status === 204 || status === 429) {
      emit(onUnavailable);
      return retryAfterWait(response);
    }
    // The server refused the request as made, which it will go on doing,
    // so asking again every few seconds would only add load. A 408 is the
    // exception: the request was too slow, which a retry can fix.
    if (status >= 400 && status < 500 && status !== 408) {
      emit(onUnavailable);
      return unavailableMs;
    }
    if (status !== 200) return down(`HTTP ${status}`);
    const type = response.headers.get("content-type") || "";
    if (!response.body || !type.includes(STREAM_CONTENT_TYPE)) {
      return down("not an event stream");
    }
    const openedAt = now();
    const outcome = await consume(response);
    const lived = now() - openedAt;
    if (lived >= STABLE_CONNECTION_MS) backoff = backoffMs.initial;
    if (outcome !== "reconnect") return down(outcome);
    return lived >= RECONNECT_AT_ONCE_MS ? 0 : backoffWait();
  };

  const run = async () => {
    while (!closed) {
      const waitMs = await attempt();
      if (waitMs === null || closed) return;
      if (waitMs > 0) await sleep(waitMs);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      reader?.cancel().catch(ignore);
      controller.abort();
      wake();
    },
  };
}
