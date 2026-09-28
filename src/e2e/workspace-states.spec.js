const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  FRONTEND_URL,
  createEvent,
  eventState,
  finalizeViaApi,
  newRunId,
  openBlockedTimes,
  openRecommendedTimes,
  recomputeEventResults,
  registerAccountViaApi,
  runDjangoJson,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  LIVE_SYNC_TIMEOUT_MS,
  freezeLiveSync,
  participantSummary,
} = require("./helpers/participants");
const {
  attendanceTile,
  cellAt,
  chooseRecommendedTime,
  eventControls,
  finalizeCurrentSelection,
  gotoWeekWith,
  overviewDetail,
  overviewTile,
  pickCell,
  reviewAttendance,
  wakeLiveSync,
} = require("./helpers/workspace");
const {
  DAY_MS,
  isoDate,
  nextUsDstDates,
  shortDate,
  weekStartMs,
} = require("./helpers/time");

// The organizer workspace between and around the main flows: live sync
// following other sessions (pushed, polled after a declined or dropped
// stream, paused by a failed pass, held back while the tab is hidden), the
// Time Table's snapshot states, the recommended times' ranking rule and
// empty states, Other times' secondary paths, cells that cannot start a
// meeting, the blocked-times bar, and the header's share link and section
// navigation.
//
// Snapshot states come from the real result snapshot: a test holds its own
// event's snapshot the way the result worker does while computing (a live
// lock the worker leaves alone for RESULT_SNAPSHOT_LOCK_TIMEOUT_SECONDS), or
// marks it failed the way a crashed computation does, and releases it with a
// synchronous recompute. Only the load-error alert, which no server state
// produces, is answered by a route.

const STREAM_ROUTE = /\/events\/stream\?/;
const ACTIVITY_ROUTE = /\/events\/activity\?/;
const RESULTS_ROUTE = /\/events\/results\?/;
// formatInTimezone in the Time Table ("Mon, Oct 5, 2026, 10:00 AM").
const IN_TIMEZONE = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
const RECOMMENDATION_RULE =
  "We recommend times someone can attend for the whole 60 minutes, at least half as available as the best, never overlapping.";
const POINTER_HINT =
  "Point at one to find it on the calendar; click one to select it.";
const DISCARDED_MARKS =
  "Unsaved blocked-time marks were discarded because the event changed.";

// Signs the page's browser context in as a new organizer. The sign-up goes
// through the API on the context's own request client, whose cookie jar the
// pages share, so the workspace opens signed in without the sign-up UI.
async function signInOrganizer(page, label) {
  const runId = newRunId();
  const session = await registerAccountViaApi(
    page.request,
    `${label}-${runId}@example.com`,
    "Wren",
    "Workspace",
  );
  return { runId, token: session.access };
}

async function openWorkspace(page, event) {
  await page.goto(`/event?code=${event.code}`);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
}

function liveBadge(page) {
  return page.locator(".organizer-heading__live-badge");
}

function liveStatus(page) {
  return page.locator(".organizer-heading__live [role='status']");
}

function lifecycleBadge(page) {
  return eventControls(page).locator(".organizer-lifecycle-panel__status");
}

function calendarGrid(page) {
  return page.getByRole("grid", { name: /^Meeting time calendar, / });
}

function recommendedTimes(page) {
  return page.locator("details#organizer-recommended-times");
}

function otherTimes(page) {
  return page.locator("details#organizer-other-times");
}

async function openOtherTimes(page) {
  const finalize = page.locator("details#organizer-finalize");
  if ((await finalize.getAttribute("open")) === null) {
    await finalize.locator("> summary").click();
  }
  await expect(finalize).toHaveAttribute("open", "");
  const other = otherTimes(page);
  if ((await other.getAttribute("open")) === null) {
    await other.locator("> summary").click();
  }
  await expect(other).toHaveAttribute("open", "");
  return other;
}

// A date and time as the browser formats it, so expectations follow the
// engine's own locale data.
function browserDateTime(page, iso, timeZone, options = {}) {
  return page.evaluate(
    ({ value, zone, format }) =>
      new Date(value).toLocaleString([], { timeZone: zone, ...format }),
    { value: iso, zone: timeZone, format: options },
  );
}

// Times (ms) at which the page sent a request matching `pattern`.
function requestTimes(page, pattern) {
  const times = [];
  page.on("request", (request) => {
    if (request.method() !== "OPTIONS" && pattern.test(request.url()))
      times.push(Date.now());
  });
  return times;
}

// Records in the page when each fetch starts and settles (performance.now()),
// so a wait between two requests is measured by the page's own clock and is
// not stretched by the test process being busy (a synchronous Django call
// delays every route handler and request event it reports).
function recordFetches(page) {
  return page.addInitScript(() => {
    const log = [];
    window.__relevizFetches = log;
    const original = window.fetch;
    window.fetch = function recordedFetch(input, init) {
      const entry = {
        url: typeof input === "string" ? input : String(input?.url ?? input),
        start: performance.now(),
        end: null,
        ok: null,
      };
      log.push(entry);
      const result = original.call(window, input, init);
      result.then(
        () => Object.assign(entry, { end: performance.now(), ok: true }),
        () => Object.assign(entry, { end: performance.now(), ok: false }),
      );
      return result;
    };
  });
}

// The recorded fetches whose URL matches `pattern`, oldest first.
function fetchLog(page, pattern) {
  return page.evaluate(
    (source) =>
      (window.__relevizFetches || []).filter((entry) =>
        new RegExp(source).test(entry.url),
      ),
    pattern.source,
  );
}

function pageNow(page) {
  return page.evaluate(() => performance.now());
}

// Answers a request with an API error. Playwright adds the CORS headers a
// cross-origin fulfil needs; a CORS preflight goes on to the server.
function answerWithError(route, status, error) {
  if (route.request().method() === "OPTIONS") return route.fallback();
  return route.fulfill({ status, json: { error } });
}

// Hides or shows the tab the way the browser reports it: visibilityState
// and hidden change, then visibilitychange fires.
async function setDocumentVisibility(page, state) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => next === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// Resolves once the page's open event stream request ends (aborted or
// finished), whichever event the engine reports.
function streamEnded(page) {
  return new Promise((resolve) => {
    const done = (request) => {
      if (!STREAM_ROUTE.test(request.url())) return;
      page.off("requestfailed", done);
      page.off("requestfinished", done);
      resolve(request);
    };
    page.on("requestfailed", done);
    page.on("requestfinished", done);
  });
}

// The results envelope (status, revisions, results) as the API serves it.
// These reads often follow a synchronous Django call, which blocks the test
// process long enough for the backend to close the idle keep-alive socket
// unnoticed; the next request on it fails with ECONNRESET, the one error
// Playwright retries.
async function resultsEnvelope(request, token, code) {
  const response = await request.get(
    `${BACKEND_URL}/events/results?code=${code}`,
    { headers: { Authorization: `Bearer ${token}` }, maxRetries: 2 },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

// Publishes the event's results now and returns them (freshResults, with
// the read above).
async function publishedResults(request, token, code) {
  recomputeEventResults(code);
  return (await resultsEnvelope(request, token, code)).results;
}

// Holds this test's event snapshot as the result worker does while it
// computes: a fresh lock, which the worker leaves alone for 60 s. `dirty`
// also requests a newer revision (as a response arriving would), and
// `empty` drops the published payload (no snapshot has been computed yet).
function holdSnapshot(code, { dirty = false, empty = false } = {}) {
  return runDjangoJson(
    `
import uuid
from django.db import transaction
from django.utils import timezone
from apps.scheduling.models import Event, EventResultSnapshot
from apps.scheduling.services.results.snapshots import mark_event_results_dirty

with transaction.atomic():
    event = Event.objects.select_for_update().get(code=data["code"])
    snapshot, _created = EventResultSnapshot.objects.select_for_update().get_or_create(
        event=event,
        defaults={
            "requested_revision": event.results_revision,
            "computed_revision": 0,
            "status": "refreshing",
            "payload": {},
        },
    )
    snapshot.lock_token = uuid.uuid4()
    snapshot.locked_at = timezone.now()
    snapshot.status = "refreshing"
    if data["empty"]:
        snapshot.payload = {}
        snapshot.computed_revision = 0
        snapshot.completed_at = None
    snapshot.save()
if data["dirty"]:
    mark_event_results_dirty(event)
event.refresh_from_db()
print(json.dumps({"revision": event.results_revision}))
`,
    { code, dirty, empty },
  );
}

// Lets the worker at the held snapshot again and publishes it now.
function releaseSnapshot(code) {
  runDjangoJson(
    `
from apps.scheduling.models import EventResultSnapshot

EventResultSnapshot.objects.filter(event__code=data["code"]).update(
    lock_token=None, locked_at=None
)
print(json.dumps(True))
`,
    { code },
  );
  recomputeEventResults(code);
}

// Records a failed computation of the requested revision, as the worker
// does when building the results raises; the worker retries it only after
// RESULT_FAILURE_RETRY_DELAY_SECONDS (30 s).
function failSnapshot(code, message) {
  runDjangoJson(
    `
from django.utils import timezone
from apps.scheduling.models import Event, EventResultSnapshot

event = Event.objects.get(code=data["code"])
EventResultSnapshot.objects.filter(event=event).update(
    status="failed",
    last_error=data["message"],
    requested_revision=event.results_revision,
    started_at=timezone.now(),
    lock_token=None,
    locked_at=None,
)
print(json.dumps(True))
`,
    { code, message },
  );
}

test.describe("Live sync", () => {
  test("an open workspace follows another session's rename, close, reactivation, finalization and archive, and the Overview details follow along", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "live-follow");
    const event = await createEvent(request, token, {
      name: `Live follow ${runId}`,
    });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada Follow",
      email: `ada-follow-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    const [best] = (await publishedResults(request, token, event.code))
      .recommendations;

    await openWorkspace(page, event);
    await expect(liveBadge(page)).toHaveText("Live");
    await expect(liveStatus(page)).toHaveText(
      "New responses load automatically.",
    );
    await expect(lifecycleBadge(page)).toHaveText("active");
    // The Overview's key tiles, with no confirmed meeting yet.
    const scheduleTile = overviewTile(page, "Schedule");
    await expect(scheduleTile).toContainText("Mon, Tue, Wed, Thu, Fri");
    await expect(scheduleTile).toContainText("9:00 AM - 5:00 PM · UTC");
    await expect(overviewTile(page, "Meeting")).toContainText(
      "In-Person · 60 minutes",
    );
    await expect(overviewTile(page, "Meeting")).toContainText("Calendar Room");
    await expect(overviewTile(page, "Responses")).toContainText("Invite only");
    await expect(overviewTile(page, "Confirmed meeting")).toHaveCount(0);
    await page.getByRole("button", { name: "Show all details" }).click();
    await expect(
      page.getByRole("button", { name: "Hide details" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(overviewDetail(page, "Availability interval")).toHaveText(
      "30 minutes",
    );
    await expect(overviewDetail(page, "Event code")).toHaveText(event.code);
    await expect(overviewDetail(page, "Status")).toHaveText("Active");
    const { resultsRevision } = await eventState(request, token, event.code);
    await expect(overviewDetail(page, "Result revision")).toHaveText(
      String(resultsRevision),
    );

    // A rename in another session is pushed to the header and the heading,
    // with no reload and nothing pressed.
    const renamed = `Live follow ${runId} renamed`;
    await updateEventViaApi(request, token, event.code, { name: renamed });
    await expect(page.locator("h2.organizer-title")).toHaveText(renamed, {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(page.locator("h1.event-header-title")).toHaveText(renamed);
    await expect(page.locator(".organizer-heading__live-time time")).toHaveText(
      /^Updated /,
    );

    // A new response moves the result revision the details show.
    await submitResponse(request, token, event, {
      name: "Ben Follow",
      email: `ben-follow-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    await expect
      .poll(
        async () =>
          Number(await overviewDetail(page, "Result revision").textContent()),
        { timeout: LIVE_SYNC_TIMEOUT_MS },
      )
      .toBeGreaterThan(resultsRevision);

    // Closed elsewhere: the controls, the lifecycle line and the Status
    // detail follow, and the live line (about new responses) leaves.
    await setLifecycleViaApi(request, token, event.code, "closed");
    await expect(lifecycleBadge(page)).toHaveText("closed", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    const controls = eventControls(page);
    await expect(
      controls.getByRole("button", { name: "Reactivate event" }),
    ).toBeVisible();
    await expect(
      controls.getByRole("button", { name: "Close responses" }),
    ).toHaveCount(0);
    await expect(controls.getByText("Responses are now closed.")).toBeVisible();
    await expect(page.locator(".organizer-heading__live")).toHaveCount(0);
    await expect(overviewDetail(page, "Status")).toHaveText("Closed");

    // Reactivated elsewhere.
    await setLifecycleViaApi(request, token, event.code, "active");
    await expect(lifecycleBadge(page)).toHaveText("active", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(liveBadge(page)).toHaveText("Live");
    await expect(
      controls.getByRole("button", { name: "Close responses" }),
    ).toBeVisible();
    await expect(overviewDetail(page, "Status")).toHaveText("Active");

    // Finalized elsewhere: the Confirmed meeting tile, the Finalize step and
    // the calendar show the meeting, and the pickers leave.
    await finalizeViaApi(request, token, event.code, best, {
      location: "Room 5",
    });
    await expect(lifecycleBadge(page)).toHaveText("finalized", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(overviewDetail(page, "Status")).toHaveText("Finalized");
    const { finalMeeting } = await eventState(request, token, event.code);
    const confirmed = overviewTile(page, "Confirmed meeting");
    await expect(confirmed).toContainText(
      `${await browserDateTime(page, finalMeeting.startsAt, "UTC")} - ${await browserDateTime(page, finalMeeting.endsAt, "UTC")}`,
    );
    await expect(confirmed).toContainText("In-Person · Room 5");
    await expect(page.locator("#organizer-finalize > summary")).toContainText(
      `Finalized · ${await browserDateTime(page, finalMeeting.startsAt, "UTC", IN_TIMEZONE)}`,
    );
    await expect(
      page.locator(".meeting-calendar__block--confirmed"),
    ).toBeVisible();
    await expect(recommendedTimes(page)).toHaveCount(0);
    await expect(
      controls.getByText(
        "The meeting is finalized. Reactivate the event to collect new responses.",
      ),
    ).toBeVisible();

    // Archived elsewhere.
    await setLifecycleViaApi(request, token, event.code, "archived");
    await expect(lifecycleBadge(page)).toHaveText("archived", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(controls.getByText("This event is archived.")).toBeVisible();
    await expect(
      controls.getByRole("button", { name: "Archive event" }),
    ).toHaveCount(0);
    await expect(overviewDetail(page, "Status")).toHaveText("Archived");

    // Hide details folds the list away again.
    await page.getByRole("button", { name: "Hide details" }).click();
    await expect(
      page.getByRole("button", { name: "Show all details" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator("dl[aria-label='Additional event details']"),
    ).toHaveCount(0);
  });

  test("a declined stream leaves the workspace polling: the server's 204 decline is honoured, a response arrives by polling, and a closed event is polled at the idle pace", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "live-decline");
    const event = await createEvent(request, token, {
      name: `Live decline ${runId}`,
    });

    // The server's own decline: a WSGI request (Django's test client) to
    // the stream view is turned away with a 204 that says why and when to
    // ask again, and CORS lets the browser read both headers.
    const decline = runDjangoJson(
      `
from rest_framework.test import APIClient

response = APIClient().get(
    "/events/stream",
    {"code": data["code"]},
    HTTP_AUTHORIZATION="Bearer " + data["token"],
    HTTP_HOST="127.0.0.1",
    HTTP_ORIGIN=data["origin"],
)
print(json.dumps({
    "status": response.status_code,
    "headers": {name.lower(): value for name, value in response.headers.items()},
}))
`,
      { code: event.code, token, origin: new URL(FRONTEND_URL).origin },
    );
    expect(decline.status).toBe(204);
    expect(decline.headers["retry-after"]).toBe("300");
    expect(decline.headers["x-live-stream-unavailable"]).toBe(
      "Live updates need the ASGI server",
    );
    expect(decline.headers["access-control-expose-headers"]).toContain(
      "Retry-After",
    );
    expect(decline.headers["access-control-expose-headers"]).toContain(
      "X-Live-Stream-Unavailable",
    );

    // The browser gets that same answer, with Retry-After shortened from
    // 300 s to 2 s so the next attempt shows within the test.
    await recordFetches(page);
    await page.route(STREAM_ROUTE, (route) =>
      route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.fulfill({
            status: decline.status,
            headers: { ...decline.headers, "retry-after": "2" },
          }),
    );
    const digests = requestTimes(page, ACTIVITY_ROUTE);
    await openWorkspace(page, event);
    await expect(liveBadge(page)).toHaveText("Live");
    await expect(participantSummary(page)).toContainText("0 people");

    // A response written elsewhere arrives with no push and no wake: only
    // the adaptive poll of the activity digest can bring it.
    const submittedAt = Date.now();
    await submitResponse(request, token, event, {
      name: "Ada Decline",
      email: `ada-decline-${runId}@example.com`,
      inperson: [slotIndex(event, "weekday:1", "10:00")],
    });
    await expect(participantSummary(page)).toContainText("1 submitted", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    expect(digests.some((at) => at > submittedAt)).toBe(true);

    // The stream is asked for again each time Retry-After has passed: not
    // sooner (the 1 s backoff of a dropped stream), not doubling, and not
    // the five minutes a decline without the header would wait. Each wait
    // runs from one answer to the next attempt, in the page's own time.
    await expect
      .poll(async () => (await fetchLog(page, STREAM_ROUTE)).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(3);
    const attempts = await fetchLog(page, STREAM_ROUTE);
    for (const [index, attempt] of attempts.slice(1, 3).entries()) {
      const wait = attempt.start - attempts[index].end;
      expect(attempts[index].ok, `attempt ${index + 1}`).toBe(true);
      expect(wait, `wait ${index + 1}`).toBeGreaterThanOrEqual(1_950);
      expect(wait, `wait ${index + 1}`).toBeLessThan(2_750);
    }

    // Closed, the event is only checked at the idle pace (15 s at first),
    // where the only change left to notice is a lifecycle change made in
    // another session, such as this reactivation.
    await setLifecycleViaApi(request, token, event.code, "closed");
    await wakeLiveSync(page);
    await expect(lifecycleBadge(page)).toHaveText("closed");
    // The idle pace counts from the pass that saw the close; let that pass
    // (and any check already on its way) finish first.
    await expect
      .poll(() => Date.now() - digests[digests.length - 1])
      .toBeGreaterThan(500);
    const closedSeenAt = Date.now();
    await setLifecycleViaApi(request, token, event.code, "active");
    await expect(lifecycleBadge(page)).toHaveText("active", {
      timeout: 30_000,
    });
    const activeSeenAt = Date.now();
    const idleCheck = digests.find((at) => at > closedSeenAt);
    expect(idleCheck - closedSeenAt).toBeGreaterThanOrEqual(12_000);
    // Active again, it is back at the live pace (3 s at first).
    await expect
      .poll(() => digests.filter((at) => at > activeSeenAt).length, {
        timeout: 6_000,
      })
      .toBeGreaterThan(0);
  });

  test("a dropped stream is retried with a growing backoff while the digest is still polled and a refreshing snapshot is re-read every 2 s, and a retry the network allows opens it again", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "live-drop");
    const event = await createEvent(request, token, {
      name: `Live drop ${runId}`,
    });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    await submitResponse(request, token, event, {
      name: "Ada Drop",
      email: `ada-drop-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    recomputeEventResults(event.code);

    // Every stream attempt fails at the network level until the test lets
    // one through.
    await recordFetches(page);
    let letThrough = false;
    await page.route(STREAM_ROUTE, (route) =>
      letThrough || route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.abort("connectionfailed"),
    );
    await openWorkspace(page, event);
    await expect(
      page.getByText(/Results are current at revision \d+/),
    ).toBeVisible();
    // The snapshot is re-read only while the Time Table is on screen.
    await page.locator("#organizer-results").scrollIntoViewIfNeeded();

    // A newer revision is being computed. A live-sync pass (asked for now,
    // so the rest of the test runs while the stream is still backing off)
    // finds it in the digest, and the panel keeps the last snapshot.
    const { revision } = holdSnapshot(event.code, { dirty: true });
    const wokenAt = await pageNow(page);
    await wakeLiveSync(page);
    await expect(
      page.getByText(
        `Results are updating for revision ${revision}. Showing the last successful snapshot meanwhile.`,
        { exact: true },
      ),
    ).toBeVisible();

    // With nothing pushed, the refreshing snapshot is re-read every 2 s.
    const refreshingSince = await pageNow(page);
    const rereads = async () =>
      (await fetchLog(page, RESULTS_ROUTE))
        .map((entry) => entry.start)
        .filter((start) => start > refreshingSince);
    await expect
      .poll(async () => (await rereads()).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    const [firstReread, secondReread] = await rereads();
    expect(firstReread - refreshingSince).toBeLessThan(3_000);
    expect(secondReread - firstReread).toBeGreaterThanOrEqual(1_500);
    expect(secondReread - firstReread).toBeLessThan(3_000);

    // The digest is still polled on its own, at the live pace (3 s after
    // that pass at the soonest), with no push and no further wake.
    await expect
      .poll(
        async () =>
          (await fetchLog(page, ACTIVITY_ROUTE)).filter(
            (entry) => entry.start > wokenAt + 2_500,
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // The attempts back off 1 s, 2 s, then 4 s, each with a quarter of
    // jitter either way, from one failure to the next try (in the page's
    // own time; the upper bounds allow for a busy page).
    await expect
      .poll(async () => (await fetchLog(page, STREAM_ROUTE)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(4);
    const attempts = await fetchLog(page, STREAM_ROUTE);
    const backoffs = [
      [750, 1_250],
      [1_500, 2_500],
      [3_000, 5_000],
    ];
    for (const [index, [low, high]] of backoffs.entries()) {
      const wait = attempts[index + 1].start - attempts[index].end;
      expect(attempts[index].ok, `attempt ${index + 1}`).toBe(false);
      expect(wait, `wait ${index + 1}`).toBeGreaterThanOrEqual(low - 50);
      expect(wait, `wait ${index + 1}`).toBeLessThan(high + 750);
    }

    // Once the network lets it through, the next attempt opens the stream
    // (the timeout covers even the 30 s cap with its jitter), and the
    // published snapshot is pushed.
    const connected = page.waitForResponse(
      (response) =>
        STREAM_ROUTE.test(response.url()) && response.status() === 200,
      { timeout: 40_000 },
    );
    letThrough = true;
    await connected;
    releaseSnapshot(event.code);
    await expect(
      page.getByText(`Results are current at revision ${revision} ·`),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
  });

  test("a failed live-sync pass pauses live updates with the error, and they resume on their own", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "live-paused");
    const event = await createEvent(request, token, {
      name: `Live paused ${runId}`,
    });
    await openWorkspace(page, event);
    await expect(liveBadge(page)).toHaveText("Live");

    // The digest fails with a 503 in the server's error shape.
    let failing = true;
    await page.route(ACTIVITY_ROUTE, (route) =>
      failing
        ? answerWithError(route, 503, "Activity digest offline")
        : route.fallback(),
    );
    await wakeLiveSync(page);
    await expect(liveBadge(page)).toHaveText("Live updates paused");
    await expect(liveStatus(page)).toHaveText(
      "New responses could not be loaded automatically (Activity digest offline). Retrying automatically.",
    );

    // Nothing is pressed, pushed or focused: the retry curve alone brings
    // it back.
    failing = false;
    await expect(liveBadge(page)).toHaveText("Live", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(liveStatus(page)).toHaveText(
      "New responses load automatically.",
    );

    // And new responses load again.
    await submitResponse(request, token, event, {
      name: "Ada Paused",
      email: `ada-paused-${runId}@example.com`,
      inperson: [slotIndex(event, "weekday:1", "10:00")],
    });
    await expect(participantSummary(page)).toContainText("1 submitted", {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
  });

  test("a hidden tab drops its stream and skips polling; showing it reopens the stream and catches up, and focus or the network returning checks at once", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "live-hidden");
    const event = await createEvent(request, token, {
      name: `Live hidden ${runId}`,
    });
    const streams = requestTimes(page, STREAM_ROUTE);
    const digests = requestTimes(page, ACTIVITY_ROUTE);
    const opened = page.waitForResponse(
      (response) =>
        STREAM_ROUTE.test(response.url()) && response.status() === 200,
    );
    await openWorkspace(page, event);
    await opened;
    await expect(liveBadge(page)).toHaveText("Live");

    const dropped = streamEnded(page);
    await setDocumentVisibility(page, "hidden");
    await dropped;
    const hiddenAt = Date.now();
    const renamed = `Live hidden ${runId} renamed`;
    await updateEventViaApi(request, token, event.code, { name: renamed });
    // With the stream gone the poll runs at the live pace (3 s at first),
    // and a hidden tab skips each turn; nothing reports a skipped turn, so
    // the test waits past one.
    await page.waitForTimeout(4_000);
    expect(digests.filter((at) => at > hiddenAt)).toEqual([]);
    expect(streams.filter((at) => at > hiddenAt)).toEqual([]);
    await expect(page.locator("h2.organizer-title")).toHaveText(event.name);

    // Shown again: a fresh stream and a catch-up pass.
    const reopened = page.waitForResponse(
      (response) =>
        STREAM_ROUTE.test(response.url()) && response.status() === 200,
    );
    await setDocumentVisibility(page, "visible");
    await reopened;
    await expect(page.locator("h2.organizer-title")).toHaveText(renamed, {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });

    // Once the catch-up is over (the stream is up, so the next scheduled
    // check is a minute away), focus and the network returning each check
    // at once.
    await expect
      .poll(() => Date.now() - digests[digests.length - 1], {
        timeout: 10_000,
      })
      .toBeGreaterThan(1_500);
    for (const trigger of ["focus", "online"]) {
      const before = digests.length;
      await page.evaluate(
        (name) => window.dispatchEvent(new Event(name)),
        trigger,
      );
      await expect
        .poll(() => digests.length, { timeout: 5_000, message: trigger })
        .toBeGreaterThan(before);
      await expect
        .poll(() => Date.now() - digests[digests.length - 1], {
          timeout: 10_000,
        })
        .toBeGreaterThan(1_000);
    }
  });
});

test.describe("Time Table snapshot states", () => {
  test("the Time Table shows a first snapshot still being computed, a fresh one, a refreshing and a failed one, and a results load error", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "snapshot-states");
    const event = await createEvent(request, token, {
      name: `Snapshot states ${runId}`,
    });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    const grid = calendarGrid(page);
    const recommended = recommendedTimes(page);
    const panel = page.locator("#organizer-results");

    // No snapshot has been computed yet: the calendar is neutral, the
    // recommended times are being calculated, and a pick has no counts.
    const { revision: firstRevision } = holdSnapshot(event.code, {
      empty: true,
    });
    await openWorkspace(page, event);
    await expect(
      panel.getByText(`Results are updating for revision ${firstRevision}.`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByText(
        "Availability shading appears once the first results snapshot is ready. You can already pick any window.",
      ),
    ).toBeVisible();
    await expect(cellAt(grid, 0, 0)).toHaveAttribute(
      "aria-label",
      /No availability snapshot yet\./,
    );
    await expect(recommended.locator("> summary")).toContainText(
      "Calculating recommendations",
    );
    await openRecommendedTimes(page);
    await expect(
      recommended.getByRole("heading", {
        level: 6,
        name: "Calculating recommendations",
      }),
    ).toBeVisible();
    await expect(
      recommended.getByText(
        "Recommendations will appear here as responses arrive.",
      ),
    ).toBeVisible();
    await gotoWeekWith(page, grid, isoDate(weekStartMs() + 8 * DAY_MS));
    await pickCell(page, cellAt(grid, 2, 0), "Custom window");
    await expect(page.locator(".final-candidate")).toContainText(
      "No responses have been counted yet.",
    );

    // A response arrives and the worker publishes: the fresh banner names
    // the revision and when it was generated.
    await submitResponse(request, token, event, {
      name: "Ada Snapshot",
      email: `ada-snapshot-${runId}@example.com`,
      inperson: [mon10, mon10 + 1],
    });
    releaseSnapshot(event.code);
    const fresh = await resultsEnvelope(request, token, event.code);
    expect(fresh.status).toBe("fresh");
    const generated = await page.evaluate(
      (value) => new Date(value).toLocaleString(),
      fresh.generatedAt,
    );
    await expect(
      panel.getByText(
        `Results are current at revision ${fresh.computedRevision} · generated ${generated}.`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(
      panel.getByText("Availability shading appears", { exact: false }),
    ).toHaveCount(0);
    await expect(recommended.locator("> summary")).toContainText(
      "1 recommended · best Mon 10:00–11:00",
    );

    // A newer revision is being computed: the last snapshot stays listed.
    const { revision } = holdSnapshot(event.code, { dirty: true });
    await expect(
      panel.getByText(
        `Results are updating for revision ${revision}. Showing the last successful snapshot meanwhile.`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(recommended.locator(".ranked-chip")).toHaveCount(1);

    // The computation fails: an alert says so and the snapshot stays.
    failSnapshot(event.code, "Worker crashed");
    await expect(
      panel.getByRole("alert").filter({
        hasText:
          "Result calculation failed. The worker will retry; the last successful snapshot remains visible.",
      }),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(recommended.locator(".ranked-chip")).toHaveCount(1);
    const failed = await resultsEnvelope(request, token, event.code);
    expect(failed).toMatchObject({
      status: "failed",
      lastError: "Worker crashed",
    });
    // The retry succeeds.
    recomputeEventResults(event.code);
    await expect(
      panel.getByText(`Results are current at revision ${revision} ·`),
    ).toBeVisible({ timeout: LIVE_SYNC_TIMEOUT_MS });
    await expect(panel.getByRole("alert")).toHaveCount(0);

    // The results cannot be loaded at all: the panel says why and keeps
    // re-reading every 2 s (while it is on screen) until a load succeeds.
    let failing = true;
    await page.route(RESULTS_ROUTE, (route) =>
      failing
        ? answerWithError(route, 503, "Results are offline")
        : route.fallback(),
    );
    await page.reload();
    await panel.scrollIntoViewIfNeeded();
    const loadError = panel
      .getByRole("alert")
      .filter({ hasText: "Results are offline" });
    await expect(loadError).toBeVisible();
    await expect(
      panel.getByText(`Results are updating for revision`, { exact: false }),
    ).toBeVisible();
    failing = false;
    await expect(loadError).toHaveCount(0, { timeout: 10_000 });
    await expect(
      panel.getByText(`Results are current at revision ${revision} ·`),
    ).toBeVisible();
  });

  test("a weekly recommendation whose suggested date has passed is chosen at its next occurrence", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "stale-weekly");
    const event = await createEvent(request, token, {
      name: `Stale weekly ${runId}`,
    });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    for (const name of ["Ada", "Ben"]) {
      await submitResponse(request, token, event, {
        name: `${name} Stale`,
        email: `${name.toLowerCase()}-stale-${runId}@example.com`,
        inperson: [mon10, mon10 + 1],
      });
    }
    // The snapshot was computed eight days ago and nothing has changed
    // since, so its Monday suggestion is last week's.
    const computedAt = new Date(Date.now() - 8 * DAY_MS).toISOString();
    const published = runDjangoJson(
      `
import time
from datetime import datetime
from apps.scheduling.models import Event
from apps.scheduling.services.results.snapshots import recompute_event_results

event = Event.objects.get(code=data["code"])
now = datetime.fromisoformat(data["now"].replace("Z", "+00:00"))
for _attempt in range(40):
    result = recompute_event_results(event.pk, now=now, force=True)
    if result.get("published"):
        break
    time.sleep(0.25)
print(json.dumps(result))
`,
      { code: event.code, now: computedAt },
    );
    expect(published.published).toBe(true);
    const [stale] = (await resultsEnvelope(request, token, event.code)).results
      .recommendations;
    expect(stale.label).toBe("Mon 10:00–11:00");
    expect(Date.parse(stale.suggestedStartsAt)).toBeLessThan(Date.now());
    // The next Monday 10:00 UTC still ahead at `from`.
    const nextMondayTen = (from) => {
      let start = Date.parse(`${isoDate(from)}T10:00:00Z`);
      while (new Date(start).getUTCDay() !== 1 || start < from) start += DAY_MS;
      return start;
    };

    await openWorkspace(page, event);
    const chosenFrom = Date.now();
    const chip = await chooseRecommendedTime(page, 0);
    await expect(page.locator(".final-candidate__note")).toHaveText(
      "The suggested date has passed; this uses the next occurrence.",
    );
    // The page chose between these two instants; only a choice made right
    // at Monday 10:00 can tell them apart.
    const candidates = [
      ...new Set([nextMondayTen(chosenFrom), nextMondayTen(Date.now())]),
    ];
    const labels = [];
    for (const candidate of candidates) {
      labels.push(
        await browserDateTime(
          page,
          new Date(candidate).toISOString(),
          "UTC",
          IN_TIMEZONE,
        ),
      );
    }
    const timeText = await page.locator(".final-candidate__time").textContent();
    const shown = labels.findIndex((label) => timeText.includes(label));
    expect(shown, `${timeText} names one of ${labels.join(" | ")}`).not.toBe(
      -1,
    );
    const nextStart = candidates[shown];
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(
      calendarGrid(page).getByRole("columnheader", {
        name: shortDate(isoDate(nextStart)),
      }),
    ).toBeVisible();
    // The server accepts the moved instant for the attendance review.
    await reviewAttendance(page);
    await expect(attendanceTile(page, "Available")).toHaveText("2");
  });
});

test.describe("Recommended times", () => {
  test("windows only weight-0 people can attend are left out, and the intro says nothing suits half the group and no other window qualifies", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "ranking-weights");
    const event = await createEvent(request, token, {
      name: `Ranking weights ${runId}`,
    });
    const mon9 = slotIndex(event, "weekday:1", "09:00");
    const tue9 = slotIndex(event, "weekday:2", "09:00");
    const people = [
      { name: "Zed", inperson: [mon9, mon9 + 1], weight: 0 },
      { name: "Amy", inperson: [tue9, tue9 + 1] },
      { name: "Bob", inperson: [] },
      { name: "Cat", inperson: [] },
    ];
    for (const person of people) {
      await submitResponse(request, token, event, {
        ...person,
        name: `${person.name} Ranking`,
        email: `${person.name.toLowerCase()}-ranking-${runId}@example.com`,
      });
    }
    const results = await publishedResults(request, token, event.code);
    expect(results.recommendations.map((entry) => entry.label)).toEqual([
      "Tue 09:00–10:00",
    ]);
    expect(results.recommendationBasis).toMatchObject({
      listEnd: "noMoreWindows",
      qualifyingWindowTotal: 1,
      bestWeightedAvailability: 0.3333,
    });

    await openWorkspace(page, event);
    // Next week, where both windows are still ahead whatever the day is
    // today (the calendar outlines only times that can still start).
    const grid = calendarGrid(page);
    await gotoWeekWith(page, grid, isoDate(weekStartMs() + 9 * DAY_MS));
    await openRecommendedTimes(page);
    const recommended = recommendedTimes(page);
    await expect(recommended.locator(".ranked-chip__title")).toHaveText([
      "Tue 09:00–10:00",
    ]);
    await expect(recommended.locator(".ranked-chip__share")).toHaveText([
      "33% weighted",
    ]);
    await expect(recommended.locator(".ranked-chips__intro")).toHaveText(
      `${RECOMMENDATION_RULE} Every other upcoming time overlaps this one or scores 0% weighted. No time suits even half of the weighted group; this is the closest. ${POINTER_HINT}`,
    );
    // Zed's Monday window is shaded by the unweighted share only and is
    // not outlined; Amy's Tuesday window is.
    await expect(grid.locator(`[data-cell-idx="${mon9}"]`)).toHaveAttribute(
      "aria-label",
      /Weighted 0%, unweighted 25% of 4 responses\./,
    );
    await expect(grid.locator(`[data-cell-idx="${mon9}"]`)).not.toHaveAttribute(
      "aria-label",
      /Inside recommended time/,
    );
    await expect(grid.locator(`[data-cell-idx="${tue9}"]`)).toHaveAttribute(
      "aria-label",
      /Inside recommended time #1\./,
    );
  });

  test("the list stops at ten and says how many qualified, exact ties keep the earliest time first, and pointing at or focusing a time highlights it and fills the detail line", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "ranking-limit");
    const event = await createEvent(request, token, {
      name: `Ranking limit ${runId}`,
    });
    await submitResponse(request, token, event, {
      name: "Ada Limit",
      email: `ada-limit-${runId}@example.com`,
      inperson: Array.from({ length: event.slotCount }, (_, index) => index),
    });
    const results = await publishedResults(request, token, event.code);
    // Every window ties at 100%, so the earliest configured time wins each
    // tie, and a window overlapping a better one is skipped.
    const expected = [
      ...[9, 10, 11, 12, 13, 14, 15, 16].map(
        (hour) =>
          `Mon ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`,
      ),
      "Tue 09:00–10:00",
      "Tue 10:00–11:00",
    ];
    expect(results.recommendations.map((entry) => entry.label)).toEqual(
      expected,
    );
    expect(results.recommendationBasis).toMatchObject({
      listEnd: "limit",
      qualifyingWindowTotal: 40,
    });

    await openWorkspace(page, event);
    // Next week, where every recommended time is still ahead whatever the
    // day is today, so each has its outline on the calendar.
    await gotoWeekWith(
      page,
      calendarGrid(page),
      isoDate(weekStartMs() + 8 * DAY_MS),
    );
    const recommended = recommendedTimes(page);
    await expect(recommended.locator("> summary")).toContainText(
      "10 of 40 recommended · best Mon 09:00–10:00",
    );
    await openRecommendedTimes(page);
    await expect(recommended.locator(".ranked-chip__title")).toHaveText(
      expected,
    );
    await expect(recommended.locator(".ranked-chips__intro")).toHaveText(
      `${RECOMMENDATION_RULE} Showing the top 10 of 40. ${POINTER_HINT}`,
    );

    const detail = recommended.locator(".ranked-chips__detail");
    const detailOf = async (index) => {
      const entry = results.recommendations[index];
      const starts = await browserDateTime(
        page,
        entry.suggestedStartsAt,
        "UTC",
        IN_TIMEZONE,
      );
      const ends = await browserDateTime(
        page,
        entry.suggestedEndsAt,
        "UTC",
        IN_TIMEZONE,
      );
      return `#${index + 1} ${entry.label} · ${starts} – ${ends} · 100% weighted · 100% unweighted · 1 fully available`;
    };
    const highlight = page.locator(".meeting-calendar__block--highlight");
    const chips = recommended.locator(".ranked-chip");
    // Nothing pointed at: the best time is described, nothing emphasized.
    await expect(detail).toHaveText(await detailOf(0));
    await expect(highlight).toHaveCount(0);

    // Pointing at #3 emphasizes its outline and describes it, without
    // choosing it.
    await chips.nth(2).hover();
    await expect(highlight).toHaveCount(1);
    await expect(highlight).toHaveAttribute("data-rank", "3");
    await expect(detail).toHaveText(await detailOf(2));
    await expect(chips.nth(2)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#organizer-finalize > summary")).toContainText(
      "No time selected yet",
    );
    await page.mouse.move(0, 0);
    await expect(highlight).toHaveCount(0);
    await expect(detail).toHaveText(await detailOf(0));

    // Keyboard focus does the same.
    await chips.nth(1).focus();
    await expect(highlight).toHaveAttribute("data-rank", "2");
    await expect(detail).toHaveText(await detailOf(1));
  });

  test("an empty list names its cause: waiting for responses, no time works (also when only weight-0 people are free), and no one who counts has responded", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "ranking-empty");
    const noneWorks =
      "No upcoming 60-minute window has anyone free for all of it. Ask for more availability, unblock times, or shorten the meeting.";
    const cases = [
      {
        key: "waiting",
        status: "waiting_for_submissions",
        people: [],
        hint: "Waiting for responses",
        title: "Waiting for responses",
        body: "Recommendations appear once someone included in the results submits availability.",
      },
      {
        key: "none",
        status: "no_viable_windows",
        people: [{ name: "Ada", times: ["09:00"] }],
        hint: "No time works yet",
        title: "No time works yet",
        body: noneWorks,
      },
      {
        key: "zero",
        status: "no_viable_windows",
        people: [
          { name: "Ada", times: [] },
          { name: "Zed", times: ["09:00", "09:30"], weight: 0 },
        ],
        hint: "No time works yet",
        title: "No time works yet",
        body: "No upcoming 60-minute window has anyone with a weight above 0 free for all of it. Some times suit only people weighted 0, who don't count toward the recommendations. Ask for more availability, unblock times, or shorten the meeting.",
      },
      {
        key: "unweighted",
        status: "no_weighted_responses",
        people: [{ name: "Zed", times: ["09:00", "09:30"], weight: 0 }],
        hint: "No weighted responses yet",
        title: "No one who counts has responded",
        body: "Everyone counted in the results so far has weight 0, so no time is recommended. Recommendations appear once someone with a weight above 0 is counted.",
      },
    ];
    for (const entry of cases) {
      const event = await createEvent(request, token, {
        name: `Ranking empty ${entry.key} ${runId}`,
      });
      for (const person of entry.people) {
        await submitResponse(request, token, event, {
          name: `${person.name} ${entry.key}`,
          email: `${person.name.toLowerCase()}-${entry.key}-${runId}@example.com`,
          inperson: person.times.map((time) =>
            slotIndex(event, "weekday:1", time),
          ),
          weight: person.weight ?? null,
        });
      }
      const results = await publishedResults(request, token, event.code);
      expect(results.recommendations, entry.key).toEqual([]);
      expect(results.recommendationBasis.status, entry.key).toBe(entry.status);

      await openWorkspace(page, event);
      const recommended = recommendedTimes(page);
      await expect(recommended.locator("> summary"), entry.key).toContainText(
        entry.hint,
      );
      await expect(page.locator("#organizer-finalize > summary")).toHaveText(
        /No time selected yet$/,
      );
      await openRecommendedTimes(page);
      await expect(
        recommended.getByRole("heading", { level: 6, name: entry.title }),
        entry.key,
      ).toBeVisible();
      await expect(recommended.locator(".empty-state__body")).toHaveText(
        entry.body,
      );
      await expect(
        page.locator("#organizer-finalize .organizer-empty-state--finalize"),
      ).toContainText(
        "Pick a time on the calendar, or choose one under Other times above.",
      );
    }
  });
});

test.describe("Meeting calendar", () => {
  test("a virtual-only event is virtual throughout the Time Table and is finalized as virtual", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "virtual-only");
    const event = await createEvent(request, token, {
      name: `Virtual only ${runId}`,
      mode: "virtual",
    });
    expect(event).toMatchObject({ mode: "virtual", location: "" });
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    for (const name of ["Ada", "Ben"]) {
      await submitResponse(request, token, event, {
        name: `${name} Virtual`,
        email: `${name.toLowerCase()}-virtual-${runId}@example.com`,
        virtual: [mon10, mon10 + 1],
      });
    }
    const [best] = (await publishedResults(request, token, event.code))
      .recommendations;
    expect(best).toMatchObject({
      channel: "virtual",
      label: "Mon 10:00–11:00",
    });

    await openWorkspace(page, event);
    await expect(overviewTile(page, "Meeting")).toContainText(
      "Virtual · 60 minutes",
    );
    // No channel to switch: the calendar shows the virtual channel in the
    // virtual palette (blue at 100%).
    await expect(page.locator(".meeting-calendar")).toHaveAttribute(
      "data-channel",
      "virtual",
    );
    await expect(
      page.getByRole("group", { name: "Meeting channel" }),
    ).toHaveCount(0);
    // Next week, where Monday 10:00 is still ahead whatever the day is
    // today (the calendar outlines only times that can still start).
    const grid = calendarGrid(page);
    await gotoWeekWith(page, grid, isoDate(weekStartMs() + 8 * DAY_MS));
    await openRecommendedTimes(page);
    const bestCell = grid.locator(`[data-cell-idx="${mon10}"]`);
    await expect(bestCell).toHaveAttribute(
      "aria-label",
      /Weighted 100%, unweighted 100% of 2 responses\..*Inside recommended time #1\./,
    );
    await expect(bestCell).toHaveCSS("background-color", "rgb(158, 197, 254)");
    const recommended = recommendedTimes(page);
    await expect(recommended.locator(".ranked-chip__channel")).toHaveCount(0);
    await expect(
      recommended.locator(".ranked-chips__detail"),
    ).not.toContainText("Virtual");
    const other = await openOtherTimes(page);
    await expect(other.getByRole("group", { name: "Format" })).toHaveCount(0);

    await chooseRecommendedTime(page, 0);
    await expect(page.locator(".final-candidate__channel")).toHaveText(
      "Virtual",
    );
    await finalizeCurrentSelection(page, event.code);
    const { finalMeeting } = await eventState(request, token, event.code);
    expect(finalMeeting.channel).toBe("virtual");
    expect(Date.parse(finalMeeting.startsAt)).toBe(
      Date.parse(best.suggestedStartsAt),
    );
    // With no location given, a virtual meeting is stored as Online.
    expect(finalMeeting.location).toBe("Online");
    await expect(page.locator(".finalized-meeting__meta")).toContainText(
      "Virtual · Online",
    );
    await expect(overviewTile(page, "Confirmed meeting")).toContainText(
      "Virtual · Online",
    );
    await expect(
      page.locator(".meeting-calendar__block--confirmed"),
    ).toBeVisible();
  });

  test("cells that cannot start a meeting say why: a date that has passed, a daylight-saving change, and overnight rows marked +1d", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "cell-states");
    const grid = calendarGrid(page);
    const finalizeSummary = page.locator("#organizer-finalize > summary");

    // Only yesterday is configured: every time has passed, so nothing is
    // recommended and nothing can be picked.
    const yesterday = isoDate(Date.now() - DAY_MS);
    const past = await createEvent(request, token, {
      name: `Past dates ${runId}`,
      daySelectionType: "specific_dates",
      specificDates: [yesterday],
      days: [],
    });
    await submitResponse(request, token, past, {
      name: "Ada Past",
      email: `ada-past-${runId}@example.com`,
      inperson: Array.from({ length: past.slotCount }, (_, index) => index),
    });
    const pastResults = await publishedResults(request, token, past.code);
    expect(pastResults.recommendationBasis.status).toBe("no_future_slots");
    await openWorkspace(page, past);
    const passed = cellAt(grid, 0, 0);
    await expect(passed).toHaveAttribute("data-state", "past");
    await expect(passed).toHaveAttribute("aria-disabled", "true");
    await expect(passed).toHaveAttribute(
      "aria-label",
      /Weighted 100%, unweighted 100% of 1 responses\. This time has passed\.$/,
    );
    await passed.click({ force: true });
    await expect(finalizeSummary).toHaveText(/No time selected yet$/);
    await expect(
      page.getByText(
        "No window can start in this range. Move to another page or edit the event schedule.",
      ),
    ).toBeVisible();
    const recommended = recommendedTimes(page);
    await expect(recommended.locator("> summary")).toContainText(
      "No upcoming times",
    );
    await openRecommendedTimes(page);
    await expect(
      recommended.getByRole("heading", { level: 6, name: "No upcoming times" }),
    ).toBeVisible();
    await expect(recommended.locator(".empty-state__body")).toHaveText(
      "No upcoming open stretch fits a 60-minute meeting: the configured times have passed, are blocked, or leave gaps that are too short.",
    );
    await expect(
      page.locator("#organizer-finalize .organizer-empty-state--finalize"),
    ).toContainText(
      "No upcoming time can start. Edit the event's schedule or unblock times to add one.",
    );
    const other = otherTimes(page);
    await expect(other.locator("> summary")).toContainText(
      "No upcoming open time",
    );
    await openOtherTimes(page);
    await expect(
      other.getByText("No upcoming 60-minute time can start."),
    ).toBeVisible();

    // A weekly Sunday in America/New_York on its next daylight-saving
    // change: 1:00 AM repeats in the fall (ambiguous) and 2:00 AM does not
    // exist in the spring, so those windows cannot start. (A dated event
    // has no such cells: its slots follow real elapsed time, so a change
    // only adds or drops rows.) The next change can be 34 weeks away, just
    // after a spring change, so the calendar is paged a week at a time
    // until it shows, each page confirmed before the next.
    const { springForward, fallBack } = nextUsDstDates();
    const dstDate = [springForward, fallBack].sort()[0];
    const fallsBack = dstDate === fallBack;
    const dst = await createEvent(request, token, {
      name: `DST ${runId}`,
      timezone: "America/New_York",
      days: [0],
      startTime: "00:00",
      endTime: "04:00",
    });
    await openWorkspace(page, dst);
    const dstHeader = grid.getByRole("columnheader", {
      name: shortDate(dstDate),
    });
    const weekShown = page.locator(
      ".meeting-calendar__toolbar .meeting-calendar__range-label",
    );
    for (let week = 0; week < 40 && !(await dstHeader.count()); week += 1) {
      const shown = await weekShown.textContent();
      await page.getByRole("button", { name: "Next week" }).click();
      await expect(weekShown).not.toHaveText(shown);
    }
    await expect(dstHeader).toBeVisible();
    const dstRow = fallsBack ? 2 : 4;
    const broken = cellAt(grid, dstRow, 0);
    await expect(broken).toHaveAttribute("data-state", "dst");
    await expect(broken).toHaveAttribute("aria-disabled", "true");
    await expect(broken).toHaveAttribute(
      "aria-label",
      fallsBack
        ? /That local time is ambiguous because of a daylight-saving change\./
        : /That local time does not exist because of a daylight-saving change\./,
    );
    // The same time a week later is an ordinary Sunday.
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(
      grid.getByRole("columnheader", {
        name: shortDate(isoDate(Date.parse(dstDate) + 7 * DAY_MS)),
      }),
    ).toBeVisible();
    await expect(cellAt(grid, dstRow, 0)).toHaveAttribute(
      "data-state",
      "startable",
    );

    // An overnight date: rows after midnight belong to the next day, and a
    // window across midnight is recommended and picked with +1d.
    const night = isoDate(Date.now() + 3 * DAY_MS);
    const overnight = await createEvent(request, token, {
      name: `Overnight ${runId}`,
      daySelectionType: "specific_dates",
      specificDates: [night],
      days: [],
      startTime: "22:00",
      endTime: "02:00",
    });
    const lateSlot = slotIndex(overnight, `date:${night}`, "23:30");
    await submitResponse(request, token, overnight, {
      name: "Ada Night",
      email: `ada-night-${runId}@example.com`,
      inperson: [lateSlot, lateSlot + 1],
    });
    const [nightBest] = (await publishedResults(request, token, overnight.code))
      .recommendations;
    expect(nightBest.label).toBe(`${night} 23:30–00:30 +1d`);
    await openWorkspace(page, overnight);
    await expect(page.locator(".meeting-calendar")).toHaveClass(
      /meeting-calendar--overnight/,
    );
    await expect(grid.getByRole("rowheader").nth(4)).toHaveText("12:00 AM +1d");
    await expect(cellAt(grid, 4, 0)).toHaveAttribute(
      "aria-label",
      /12:00 AM \+1d – 12:30 AM \+1d/,
    );
    // The last row cannot fit an hour before the day's window ends.
    await expect(cellAt(grid, 7, 0)).toHaveAttribute("data-state", "tail");
    await chooseRecommendedTime(page, 0);
    await expect(page.locator(".final-candidate__title")).toHaveText(
      `${night} 23:30–00:30 +1d`,
    );
    await expect(page.locator(".final-candidate__time")).toContainText(
      `${await browserDateTime(page, nightBest.suggestedStartsAt, "UTC", IN_TIMEZONE)} – ${await browserDateTime(page, nightBest.suggestedEndsAt, "UTC", IN_TIMEZONE)}`,
    );
  });
});

test.describe("Other times", () => {
  test("Other times counts the open times, pages between weeks, moves between time chips by keyboard, and switches format on a hybrid event", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "other-times");
    const weekly = await createEvent(request, token, {
      name: `Other weekly ${runId}`,
    });
    // Mon-Fri 09:00-17:00 UTC, one-hour windows: 15 starts a day, from
    // yesterday (after-midnight times) to four weeks from today, while
    // still ahead.
    const openStarts = (now) => {
      const today = Date.parse(`${isoDate(now)}T00:00:00Z`);
      let count = 0;
      for (let day = today - DAY_MS; day < today + 28 * DAY_MS; day += DAY_MS) {
        const weekday = new Date(day).getUTCDay();
        if (weekday < 1 || weekday > 5) continue;
        for (let row = 0; row < 15; row += 1) {
          if (day + (9 * 60 + row * 30) * 60_000 >= now) count += 1;
        }
      }
      return count;
    };

    await openWorkspace(page, weekly);
    const other = await openOtherTimes(page);
    const summary = other.locator("> summary");
    // The panel's clock is re-read once a minute, so it may lag a start
    // that has just passed.
    await expect
      .poll(async () => {
        const match =
          /(\d+) open times in the next 4 weeks · recommended or not/.exec(
            await summary.textContent(),
          );
        const shown = match ? Number(match[1]) : null;
        return [
          openStarts(Date.now()),
          openStarts(Date.now() - 70_000),
        ].includes(shown);
      })
      .toBe(true);
    await expect(other.locator(".ranked-chips__intro")).toContainText(
      "Any open time in the next 4 weeks, recommended or not (the calendar reaches further).",
    );

    // Earlier and Later days step through the weeks; the ends stay
    // focusable but say they are disabled.
    const stepper = other.getByRole("group", { name: "Week shown" });
    const earlier = stepper.getByRole("button", { name: "Earlier days" });
    const later = stepper.getByRole("button", { name: "Later days" });
    const weekLabel = stepper.locator(".meeting-calendar__range-label");
    const calendarLabel = page.locator(
      ".meeting-calendar__toolbar .meeting-calendar__range-label",
    );
    await expect(earlier).toHaveAttribute("aria-disabled", "true");
    const firstWeek = (await weekLabel.textContent()).trim();
    await later.click();
    await expect(weekLabel).not.toHaveText(firstWeek);
    await expect(earlier).toHaveAttribute("aria-disabled", "false");
    const secondWeek = (await weekLabel.textContent()).trim();
    // The calendar moves with it.
    await expect(calendarLabel).toHaveText(secondWeek);
    await earlier.click();
    await expect(weekLabel).toHaveText(firstWeek);
    await expect(earlier).toHaveAttribute("aria-disabled", "true");
    await earlier.focus();
    await page.keyboard.press("Enter");
    await expect(weekLabel).toHaveText(firstWeek);
    await expect(earlier).toBeFocused();

    // A full day next week: the time chips share one tab stop, and arrows,
    // Home and End move between them without choosing one.
    await later.click();
    await expect(weekLabel).toHaveText(secondWeek);
    const dayChips = other
      .getByRole("group", { name: "Day", exact: true })
      .getByRole("button");
    await dayChips.first().click();
    await expect(dayChips.first()).toHaveAttribute("aria-pressed", "true");
    const times = other
      .getByRole("list", { name: /^Start times on / })
      .getByRole("button");
    await expect(times).toHaveCount(15);
    await expect(times.nth(0)).toHaveAttribute("tabindex", "0");
    await expect(times.nth(1)).toHaveAttribute("tabindex", "-1");
    await times.nth(0).focus();
    const steps = [
      ["ArrowRight", 1],
      ["End", 14],
      ["ArrowDown", 14],
      ["Home", 0],
      ["ArrowUp", 0],
      ["ArrowDown", 1],
      ["ArrowLeft", 0],
    ];
    for (const [key, index] of steps) {
      await page.keyboard.press(key);
      await expect(times.nth(index), key).toBeFocused();
      await expect(times.nth(index), key).toHaveAttribute("tabindex", "0");
    }
    await expect(times.nth(0)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#organizer-finalize > summary")).toHaveText(
      /No time selected yet$/,
    );

    // A hybrid event on two dates: the count has no week horizon, and the
    // Format switch shows each channel's shares (and moves the calendar).
    const dates = [7, 8].map((days) => isoDate(Date.now() + days * DAY_MS));
    const hybrid = await createEvent(request, token, {
      name: `Other hybrid ${runId}`,
      mode: "mixed",
      location: "Studio B / video call",
      daySelectionType: "specific_dates",
      specificDates: dates,
      days: [],
      startTime: "09:00",
      endTime: "11:00",
    });
    const slot = (time) => slotIndex(hybrid, `date:${dates[0]}`, time);
    await submitResponse(request, token, hybrid, {
      name: "Ines Hybrid",
      email: `ines-hybrid-${runId}@example.com`,
      inperson: [slot("09:00"), slot("09:30")],
    });
    await submitResponse(request, token, hybrid, {
      name: "Ben Hybrid",
      email: `ben-hybrid-${runId}@example.com`,
      virtual: [slot("10:00"), slot("10:30")],
    });
    recomputeEventResults(hybrid.code);
    await openWorkspace(page, hybrid);
    const hybridOther = await openOtherTimes(page);
    await expect(hybridOther.locator("> summary")).toContainText(
      "6 open times · recommended or not",
    );
    await expect(hybridOther.locator(".ranked-chips__intro")).toContainText(
      "Any open time the calendar lets you pick, recommended or not.",
    );
    const format = hybridOther.getByRole("group", { name: "Format" });
    const inPerson = format.getByRole("button", { name: "In person" });
    const virtual = format.getByRole("button", { name: "Virtual" });
    const shares = hybridOther.locator(
      ".other-times__chips .ranked-chip__share",
    );
    await expect(inPerson).toHaveAttribute("aria-pressed", "true");
    await expect(shares).toHaveText([
      "50% weighted",
      "0% weighted",
      "0% weighted",
    ]);
    await virtual.click();
    await expect(virtual).toHaveAttribute("aria-pressed", "true");
    await expect(inPerson).toHaveAttribute("aria-pressed", "false");
    await expect(shares).toHaveText([
      "0% weighted",
      "0% weighted",
      "50% weighted",
    ]);
    await expect(page.locator(".meeting-calendar")).toHaveAttribute(
      "data-channel",
      "virtual",
    );
    await expect(
      page
        .getByRole("group", { name: "Meeting channel" })
        .getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("the Time Table clock: a passed start leaves the calendar and Other times on the minute tick, the tick pauses while the tab is hidden, and a time that has just started is refused", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "clock");
    const QUARTER = 15 * 60_000;
    // Four quarter-hour starts, the first 3-18 minutes from now.
    const start = Math.ceil((Date.now() + 3 * 60_000) / QUARTER) * QUARTER;
    const clockTime = (ms) => new Date(ms).toISOString().slice(11, 16);
    const event = await createEvent(request, token, {
      name: `Clock ${runId}`,
      daySelectionType: "specific_dates",
      specificDates: [isoDate(start)],
      days: [],
      startTime: clockTime(start),
      endTime: clockTime(start + 4 * QUARTER),
      slotMinutes: 15,
      meetingDurationMinutes: 15,
    });
    expect(event.slotCount).toBe(4);
    // The page's clock runs on from now; the test moves it forward.
    await page.clock.install();
    const advanceTo = async (target) => {
      const pageNow = await page.evaluate(() => Date.now());
      await page.clock.fastForward(Math.max(0, target - pageNow));
    };

    await openWorkspace(page, event);
    const grid = calendarGrid(page);
    const cell = (row) => cellAt(grid, row, 0);
    await expect(cell(0)).toHaveAttribute("data-state", "startable");
    const other = await openOtherTimes(page);
    const summary = other.locator("> summary");
    await expect(summary).toContainText("4 open times");

    // The first start passes: the minute tick re-reads the clock.
    await advanceTo(start + 30_000);
    await expect(cell(0)).toHaveAttribute("data-state", "past");
    await expect(cell(0)).toHaveAttribute(
      "aria-label",
      /This time has passed\.$/,
    );
    await expect(summary).toContainText("3 open times");

    // While the tab is hidden the tick stops: the second start passes
    // unnoticed until the tab is back and the next tick comes.
    await setDocumentVisibility(page, "hidden");
    await advanceTo(start + QUARTER + 30_000);
    // Nothing reports a tick that did not happen; give one a moment to
    // render if it did.
    await page.waitForTimeout(500);
    await expect(cell(1)).toHaveAttribute("data-state", "startable");
    await setDocumentVisibility(page, "visible");
    await expect(cell(1)).toHaveAttribute("data-state", "startable");
    await page.clock.fastForward(61_000);
    await expect(cell(1)).toHaveAttribute("data-state", "past");
    await expect(summary).toContainText("2 open times");

    // The third start passes between ticks: its chip is still offered, and
    // choosing it is refused, the list catches up, and focus moves on.
    await page.clock.setSystemTime(start + 2 * QUARTER + 20_000);
    const times = other
      .getByRole("list", { name: /^Start times on / })
      .getByRole("button");
    await expect(times).toHaveCount(2);
    await times.first().click();
    const announcement = other.locator("p[role='status']");
    await expect(announcement).toHaveText(
      /^That time has just started\. Pick another one\.\s?$/,
    );
    await expect(times).toHaveCount(1);
    await expect(times.first()).toBeFocused();
    await expect(cell(2)).toHaveAttribute("data-state", "past");
    await expect(page.locator("#organizer-finalize > summary")).toHaveText(
      /No time selected yet$/,
    );
    // The time still ahead is accepted.
    await times.first().click();
    await expect(announcement).toContainText(
      `${clockTime(start + 3 * QUARTER)}–${clockTime(start + 4 * QUARTER)}`,
    );
    await expect(page.locator(".final-candidate")).toContainText(
      "Custom window",
    );
  });
});

test.describe("Blocked times", () => {
  function paintSurface(page) {
    const grid = page.getByRole("grid", {
      name: /^Meeting time calendar, .*, marking blocked times$/,
    });
    return {
      grid,
      cell: (index) => grid.locator(`[data-cell-idx="${index}"]`),
      bar: page.getByRole("region", { name: "Blocked times tools" }),
    };
  }

  test("Clear all opens every slot, and the bar's Close keeps the unsaved marks and returns focus to the step", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "blocked-clear");
    const event = await createEvent(request, token, {
      name: `Blocked clear ${runId}`,
      blockedSlots: { "weekday:1": [0, 1] },
    });
    await openWorkspace(page, event);
    const step = page.locator("details#organizer-blocked-times");
    const summary = step.locator("> summary");
    await expect(summary).toContainText("2 slots blocked");
    await openBlockedTimes(page);
    const { bar, cell } = paintSurface(page);
    await expect(bar).toContainText("2 slots marked");
    await expect(cell(0)).toHaveAttribute("data-blocked-paint", "true");
    await expect(cell(1)).toHaveAttribute("data-blocked-paint", "true");

    await bar.getByRole("button", { name: "Clear all" }).click();
    await expect(bar).toContainText("0 slots marked");
    await expect(cell(0)).toHaveAttribute("data-blocked-paint", "false");
    await expect(cell(1)).toHaveAttribute("data-blocked-paint", "false");
    await expect(summary).toContainText("2 slots blocked · unsaved changes");

    // Close ends painting, keeps the marks unsaved, and puts focus on the
    // step's summary (the button that had it is gone).
    await bar.getByRole("button", { name: "Close", exact: true }).click();
    await expect(step).not.toHaveAttribute("open", "");
    await expect(bar).toHaveCount(0);
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("2 slots blocked · unsaved changes");
    await expect(calendarGrid(page)).not.toHaveAttribute(
      "aria-label",
      /marking blocked times/,
    );
    expect((await eventState(request, token, event.code)).blockedSlots).toEqual(
      { "weekday:1": [0, 1] },
    );

    // Reopened, the marks are still there, and saving stores them.
    await openBlockedTimes(page);
    await expect(bar).toContainText("0 slots marked");
    await expect(cell(0)).toHaveAttribute("data-blocked-paint", "false");
    await bar.getByRole("button", { name: "Save blocked times" }).click();
    await expect(bar.getByText("Blocked times saved.")).toBeVisible();
    await expect(summary).toContainText("0 slots blocked");
    await expect(summary).not.toContainText("unsaved changes");
    await expect
      .poll(
        async () => (await eventState(request, token, event.code)).blockedSlots,
      )
      .toEqual({});
  });

  test("a stale blocked-times save offers Reload latest event, marks overwritten by another session are announced, and a refused save has nothing to reload", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "blocked-conflict");
    const event = await createEvent(request, token, {
      name: `Blocked conflict ${runId}`,
    });
    const tue9 = slotIndex(event, "weekday:2", "09:00");
    const wed9 = slotIndex(event, "weekday:3", "09:00");
    const fri9 = slotIndex(event, "weekday:5", "09:00");
    await openWorkspace(page, event);
    await openBlockedTimes(page);
    const { bar, cell } = paintSurface(page);
    const save = bar.getByRole("button", { name: "Save blocked times" });
    const summary = page.locator("details#organizer-blocked-times > summary");

    await cell(tue9).click();
    await expect(cell(tue9)).toHaveAttribute("data-blocked-paint", "true");
    await expect(bar).toContainText("1 slots marked");

    // Another session saves first while live sync is held, so the save goes
    // out with the old version and is refused.
    const renamed = `Blocked conflict ${runId} renamed`;
    const release = await freezeLiveSync(page);
    try {
      await updateEventViaApi(request, token, event.code, { name: renamed });
      await save.click();
      const failure = bar.getByRole("alert");
      await expect(failure).toHaveText(
        /^The event changed in another session\. Reload and try again\./,
      );
      // Reload latest event takes the newer event and drops the marks,
      // without calling that a loss.
      await failure
        .getByRole("button", { name: "Reload latest event" })
        .click();
      await expect(failure).toHaveCount(0);
      await expect(page.locator("h2.organizer-title")).toHaveText(renamed);
      await expect(bar).toContainText("0 slots marked");
      await expect(cell(tue9)).toHaveAttribute("data-blocked-paint", "false");
      await expect(save).toBeDisabled();
      await expect(bar.getByText(DISCARDED_MARKS)).toHaveCount(0);
    } finally {
      await release();
    }

    // Blocks saved elsewhere replace unsaved marks, and the loss is said.
    await cell(wed9).click();
    await expect(cell(wed9)).toHaveAttribute("data-blocked-paint", "true");
    await updateEventViaApi(request, token, event.code, {
      blockedSlots: { "weekday:5": [0] },
    });
    await expect(bar.getByRole("status")).toHaveText(DISCARDED_MARKS, {
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(cell(fri9)).toHaveAttribute("data-blocked-paint", "true");
    await expect(cell(wed9)).toHaveAttribute("data-blocked-paint", "false");
    await expect(bar).toContainText("1 slots marked");
    await expect(summary).toContainText("1 slots blocked");
    await expect(summary).not.toContainText("unsaved changes");

    // Blocks that leave no room for the meeting are refused by the server;
    // there is nothing newer to reload.
    const wholeDay = await createEvent(request, token, {
      name: `Blocked whole day ${runId}`,
      days: [1],
      meetingDurationMinutes: 480,
    });
    await openWorkspace(page, wholeDay);
    await openBlockedTimes(page);
    const whole = paintSurface(page);
    await whole.cell(5).click();
    await expect(whole.cell(5)).toHaveAttribute("data-blocked-paint", "true");
    await whole.bar.getByRole("button", { name: "Save blocked times" }).click();
    const refused = whole.bar.getByRole("alert");
    await expect(refused).toHaveText(
      "Blocked slots leave no open window for a 480-minute meeting.",
    );
    await expect(
      refused.getByRole("button", { name: "Reload latest event" }),
    ).toHaveCount(0);
    expect(
      (await eventState(request, token, wholeDay.code)).blockedSlots,
    ).toEqual({});
  });
});

test.describe("Workspace header and navigation", () => {
  test("Copy share link copies the event link and confirms it for two seconds, falling back to execCommand when the clipboard refuses", async ({
    browserName,
    context,
    page,
    request,
  }) => {
    // Every engine records what the page hands the clipboard or the copy
    // command; the test can also make the clipboard refuse. The real write
    // still happens where the engine allows it (Chromium, which the test
    // reads back), and an engine that refuses it in automation does not
    // count as the clipboard refusing.
    await page.addInitScript(() => {
      window.__relevizCopied = [];
      window.__relevizClipboardFails = false;
      const clipboard = navigator.clipboard;
      if (clipboard) {
        const original =
          typeof clipboard.writeText === "function"
            ? clipboard.writeText.bind(clipboard)
            : null;
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: async (text) => {
            if (window.__relevizClipboardFails)
              throw new DOMException("Clipboard blocked", "NotAllowedError");
            window.__relevizCopied.push({ via: "clipboard", text });
            if (original) await original(text).catch(() => undefined);
          },
        });
      }
      const execCommand = document.execCommand.bind(document);
      document.execCommand = (command, ...rest) => {
        if (command === "copy") {
          const fields = document.body.querySelectorAll(":scope > input");
          window.__relevizCopied.push({
            via: "execCommand",
            text: fields[fields.length - 1]?.value ?? null,
          });
        }
        try {
          return execCommand(command, ...rest);
        } catch {
          return false;
        }
      };
    });
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    const { runId, token } = await signInOrganizer(page, "share-link");
    const event = await createEvent(request, token, {
      name: `Share link ${runId}`,
    });
    await openWorkspace(page, event);
    const header = page.getByRole("navigation", { name: "Event" });
    await expect(
      header.getByText(`#${event.code}`, { exact: true }),
    ).toBeVisible();
    await expect(header.getByText("Organizer", { exact: true })).toBeVisible();
    const copy = header.getByRole("button", { name: "Copy share link" });
    const copied = header.getByRole("button", { name: "Link copied" });
    const shareUrl = `${new URL(page.url()).origin}/event?code=${event.code}`;

    await copy.click();
    await expect(copied).toBeVisible();
    const copiedAt = Date.now();
    expect(await page.evaluate(() => window.__relevizCopied)).toEqual([
      { via: "clipboard", text: shareUrl },
    ]);
    if (browserName === "chromium") {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        shareUrl,
      );
    }
    await expect(copy).toBeVisible();
    await expect(copied).toHaveCount(0);
    expect(Date.now() - copiedAt).toBeGreaterThanOrEqual(1_500);
    expect(Date.now() - copiedAt).toBeLessThan(5_000);

    // The clipboard refuses: the link is copied from a temporary field,
    // which is removed again.
    await page.evaluate(() => {
      window.__relevizClipboardFails = true;
      window.__relevizCopied = [];
    });
    await copy.click();
    await expect(copied).toBeVisible();
    expect(await page.evaluate(() => window.__relevizCopied)).toEqual([
      { via: "execCommand", text: shareUrl },
    ]);
    await expect(page.locator("body > input")).toHaveCount(0);
    await expect(copy).toBeVisible();
  });

  test("the Workspace sections nav jumps to each section below the sticky nav, and a link with a section hash opens scrolled to it", async ({
    page,
    request,
  }) => {
    const { runId, token } = await signInOrganizer(page, "section-nav");
    const event = await createEvent(request, token, {
      name: `Section nav ${runId}`,
    });
    await openWorkspace(page, event);
    const nav = page.getByRole("navigation", { name: "Workspace sections" });
    // Where a section's top sits, and where the sticky nav ends.
    const layout = (id) =>
      page.evaluate((sectionId) => {
        const navBox = document
          .querySelector("nav[aria-label='Workspace sections']")
          .getBoundingClientRect();
        const section = document.getElementById(sectionId);
        return {
          sectionTop: section.getBoundingClientRect().top,
          navTop: navBox.top,
          navBottom: navBox.bottom,
          scrollY: window.scrollY,
        };
      }, id);

    for (const [label, id, heading] of [
      ["Time Table", "organizer-results", "Time Table"],
      ["Participants", "organizer-roster", "Participants"],
      ["Overview", "organizer-overview", "Overview"],
    ]) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(
        page
          .locator(`#${id}`)
          .getByRole("heading", { level: 3, name: heading }),
      ).toBeInViewport();
      // The section starts below the nav, never under it, and the nav stays
      // on screen.
      await expect
        .poll(
          async () => {
            const box = await layout(id);
            return box.sectionTop >= box.navBottom - 1 && box.navTop >= 0;
          },
          { message: label },
        )
        .toBe(true);
      // The sections below the Overview are reached by scrolling.
      if (id !== "organizer-overview")
        expect((await layout(id)).scrollY, label).toBeGreaterThan(0);
    }

    // A link carrying a section hash opens there.
    await page.goto(`/event?code=${event.code}#organizer-results`);
    await expect(
      page.getByRole("heading", { level: 2, name: event.name }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const box = await layout("organizer-results");
        return (
          box.scrollY > 0 &&
          box.sectionTop >= box.navBottom - 1 &&
          box.sectionTop < 200
        );
      })
      .toBe(true);
    await expect(
      page.getByRole("heading", { level: 3, name: "Time Table" }),
    ).toBeInViewport();
  });
});
