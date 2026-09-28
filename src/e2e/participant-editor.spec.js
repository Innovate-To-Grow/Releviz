const fs = require("node:fs/promises");
const { expect, test } = require("@playwright/test");
const {
  BACKEND_URL,
  apiJson,
  createEvent,
  eventState,
  finalizeViaApi,
  freshResults,
  latestEmailFor,
  latestVerificationCode,
  newAccountContext,
  newRunId,
  ownResponse,
  readSession,
  recomputeEventResults,
  registerAccount,
  registerAccountViaApi,
  runDjangoJson,
  runDjangoScript,
  setLifecycleViaApi,
  slotIndex,
  submitResponse,
  tempAccessSessionState,
  temporaryAccessPathFromEmail,
  updateEventViaApi,
} = require("./helpers/releviz");
const {
  attendanceTile,
  chooseRecommendedTime,
  detailItem,
  joinEventInBrowser,
  reviewAttendance,
  updateRoutePattern,
  waitForAutosave,
  wakeLiveSync,
} = require("./helpers/workspace");
const {
  LIVE_SYNC_TIMEOUT_MS,
  addPersonApi,
  gotoParticipants,
  invitationEmail,
  participantRow,
  rosterEntries,
  submitOnBehalf,
  waitForInvitationStatus,
} = require("./helpers/participants");
const { DAY_MS, icsUtc, isoDate } = require("./helpers/time");

// The participant side of an event: the Join page and its refusals, the
// join API's limits, the schedule editor (brushes, input methods, channels,
// organizer blocks), submitting and withdrawing, Refresh and the locks the
// event lifecycle and deadline put on a response, the confirmed meeting and
// its calendar file, the temporary-access editor, and who may change a
// response. Organizers and fixtures are seeded through the API; the browser
// drives the participant behaviour under test.

// An active event cannot be saved with a past deadline, so a passed deadline
// is written straight to this test's own event, as if the time had come.
function expireDeadline(code) {
  runDjangoScript(
    `
from datetime import timedelta

from django.utils import timezone

from apps.scheduling.models import Event

updated = Event.objects.filter(code=data["code"]).update(
    response_deadline=timezone.now() - timedelta(minutes=1)
)
assert updated == 1, updated
`,
    { code },
  );
}

// The next POST /events/participants (a join) for this event.
function joinResponse(page, code) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/events/participants?code=${code}`),
  );
}

// Finalizes an event through the API around one submitted managed response
// and returns its confirmed meeting.
async function finalizeWithOneResponse(request, token, event, email) {
  const mon10 = slotIndex(event, "weekday:1", "10:00");
  await submitResponse(request, token, event, {
    name: "Ada Answer",
    email,
    inperson: [mon10, mon10 + 1],
  });
  const results = await freshResults(request, token, event.code);
  await finalizeViaApi(request, token, event.code, results.recommendations[0], {
    location: "Board Room",
  });
  const meeting = (await eventState(request, token, event.code)).finalMeeting;
  expect(meeting).not.toBeNull();
  return meeting;
}

// Formats an instant the way the web app does (toLocaleString in the
// browser's locale), so expectations follow whatever locale the browser uses.
async function browserDateTime(page, value, timeZone, options = {}) {
  return page.evaluate(
    ([instant, zone, extra]) =>
      new Date(instant).toLocaleString([], { timeZone: zone, ...extra }),
    [value, timeZone, options],
  );
}

test.describe("Joining an event", () => {
  test("the Join page shows the event details and the participant header, and copies the share link", async ({
    browser,
    browserName,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `join-org-${runId}@example.com`,
      "Jo",
      "Organizer",
    );
    const firstDate = isoDate(Date.now() + 20 * DAY_MS);
    const secondDate = isoDate(Date.now() + 21 * DAY_MS);
    const deadline = new Date(Date.now() + 10 * DAY_MS).toISOString();
    // A virtual, specific-date evening window that runs past midnight in
    // New York. A virtual event keeps no location, whatever the form sent.
    const event = await createEvent(request, organizer.access, {
      name: `Late call ${runId}`,
      mode: "virtual",
      location: "Dropped Room",
      daySelectionType: "specific_dates",
      specificDates: [secondDate, firstDate],
      startTime: "22:00",
      endTime: "02:00",
      slotMinutes: 30,
      timezone: "America/New_York",
      responseDeadline: deadline,
      accessMode: "open_link",
    });
    expect(event.crossesMidnight).toBe(true);

    // The clipboard can be read back only where the browser grants it.
    const context = await browser.newContext(
      browserName === "chromium"
        ? { permissions: ["clipboard-read", "clipboard-write"] }
        : {},
    );
    const page = await context.newPage();
    await registerAccount(
      page,
      `join-pat-${runId}@example.com`,
      "Pat",
      "Pending",
    );
    // Every engine records what the page hands the clipboard, so the copied
    // link is checked everywhere, not only where it can be read back.
    await page.addInitScript(() => {
      window.__relevizCopied = [];
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      const original =
        typeof clipboard.writeText === "function"
          ? clipboard.writeText.bind(clipboard)
          : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.__relevizCopied.push(text);
          if (original) await original(text);
        },
      });
    });
    await page.goto(`/event?code=${event.code}`);
    await expect(
      page.getByRole("heading", { name: "Join Event" }),
    ).toBeVisible();

    const expectedDetails = [
      ["Event", event.name],
      ["Meeting type", "Virtual"],
      ["Availability window", "10:00 PM - 2:00 AM (next day)"],
      ["Availability interval", "30 minutes"],
      ["Response days", `${firstDate}, ${secondDate}`],
      ["Timezone", "America/New_York"],
      ["Location", "N/A"],
      ["Event code", event.code],
      ["Status", "Active"],
      [
        "Response Deadline",
        await browserDateTime(page, deadline, "America/New_York", {
          timeZoneName: "short",
        }),
      ],
    ];
    for (const [label, value] of expectedDetails) {
      await expect(detailItem(page, label), label).toHaveText(value);
    }
    // Nothing is confirmed yet.
    await expect(detailItem(page, "Final Start")).toHaveCount(0);

    // The header names the event and the person's role.
    const header = page.getByRole("navigation", { name: "Event" });
    await expect(
      header.getByRole("heading", { level: 1, name: event.name }),
    ).toBeVisible();
    await expect(
      header.getByText(`#${event.code}`, { exact: true }),
    ).toBeVisible();
    await expect(
      header.getByText("Participant", { exact: true }),
    ).toBeVisible();
    await expect(header.getByText("Organizer", { exact: true })).toHaveCount(0);

    const copy = header.getByRole("button", { name: "Copy share link" });
    await copy.click();
    await expect(
      header.getByRole("button", { name: "Link copied" }),
    ).toBeVisible();
    const shareUrl = `${new URL(page.url()).origin}/event?code=${event.code}`;
    expect(await page.evaluate(() => window.__relevizCopied)).toEqual([
      shareUrl,
    ]);
    if (browserName === "chromium") {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        shareUrl,
      );
    }
    // The confirmation reverts after two seconds.
    await expect(copy).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Link copied" }),
    ).toHaveCount(0);
    await context.close();
  });

  test("a closed, archived, finalized or past-deadline event refuses the join and keeps the Join page", async ({
    page,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `locked-join-org-${runId}@example.com`,
      "Lou",
      "Organizer",
    );
    const token = organizer.access;
    const open = { accessMode: "open_link" };
    const closed = await createEvent(request, token, {
      ...open,
      name: `Closed join ${runId}`,
    });
    await setLifecycleViaApi(request, token, closed.code, "closed");
    const archived = await createEvent(request, token, {
      ...open,
      name: `Archived join ${runId}`,
    });
    await setLifecycleViaApi(request, token, archived.code, "archived");
    const finalized = await createEvent(request, token, {
      ...open,
      name: `Finalized join ${runId}`,
    });
    const meeting = await finalizeWithOneResponse(
      request,
      token,
      finalized,
      `locked-join-ada-${runId}@example.com`,
    );
    const lapsed = await createEvent(request, token, {
      ...open,
      name: `Lapsed join ${runId}`,
    });
    expireDeadline(lapsed.code);

    await registerAccount(
      page,
      `locked-join-pat-${runId}@example.com`,
      "Pat",
      "Late",
    );
    const participantToken = (await readSession(page)).access;

    const cases = [
      [closed, "Closed", "Responses cannot change while the event is closed."],
      [
        archived,
        "Archived",
        "Responses cannot change while the event is archived.",
      ],
      [
        finalized,
        "Finalized",
        "Responses cannot change while the event is finalized.",
      ],
      [lapsed, "Active", "The response deadline has passed."],
    ];
    for (const [event, status, message] of cases) {
      await page.goto(`/event?code=${event.code}`);
      await expect(
        page.getByRole("heading", { name: "Join Event" }),
      ).toBeVisible();
      await expect(detailItem(page, "Status")).toHaveText(status);
      const refused = joinResponse(page, event.code);
      await page.getByRole("button", { name: "Join as Pat Late" }).click();
      const response = await refused;
      expect(response.status()).toBe(409);
      expect((await response.json()).error).toBe(message);
      await expect(page.locator(".participant-error")).toHaveText(
        `Failed to join: ${message}`,
      );
      // The editor never opens and nobody was added.
      await expect(
        page.getByRole("heading", { name: "Join Event" }),
      ).toBeVisible();
      await expect(page.getByText(/Welcome,/)).toHaveCount(0);
      await expect(
        page.getByRole("grid", { name: "Availability" }),
      ).toHaveCount(0);
      const mine = await apiJson(
        request,
        "GET",
        `/events/participants?code=${event.code}`,
        participantToken,
      );
      expect(mine.response.status()).toBe(403);
    }

    // A visitor to the finalized event sees the confirmed meeting before
    // joining, in the event's timezone (UTC here).
    await page.goto(`/event?code=${finalized.code}`);
    await expect(detailItem(page, "Final Start")).toHaveText(
      await browserDateTime(page, meeting.startsAt, "UTC"),
    );
    await expect(detailItem(page, "Final End")).toHaveText(
      await browserDateTime(page, meeting.endsAt, "UTC"),
    );
    await expect(detailItem(page, "Final Method")).toHaveText(
      "In-Person · Board Room",
    );
    await expect(detailItem(page, "Location")).toHaveText("Calendar Room");
    await expect(detailItem(page, "Meeting type")).toHaveText("In-Person");
    await expect(detailItem(page, "Response days")).toHaveText(
      "Mon, Tue, Wed, Thu, Fri",
    );
  });

  test("the join API caps the participants, validates the display name and refreshes it on a re-join", async ({
    browserName,
    request,
  }) => {
    // The cap needs a full event, so this seeds a thousand rows; the checks
    // are API-level and browser-independent.
    test.skip(
      browserName !== "chromium",
      "API-level and seeds a full event; one browser is enough",
    );
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `cap-org-${runId}@example.com`,
      "Cap",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Join limits ${runId}`,
      accessMode: "open_link",
    });
    const join = (token) =>
      apiJson(
        request,
        "POST",
        `/events/participants?code=${event.code}`,
        token,
      );

    // A first join creates the row (201). Renaming the account renames the
    // row straight away, and a re-join returns the same row (200) with any
    // name that drifted from the account's (a row first claimed by saving
    // keeps the organizer's name) refreshed.
    const annEmail = `cap-ann-${runId}@example.com`;
    const ann = await registerAccountViaApi(request, annEmail, "Ann", "Able");
    let joined = await join(ann.access);
    expect(joined.response.status()).toBe(201);
    expect(joined.payload.participant.name).toBe("Ann Able");
    const renamed = await apiJson(
      request,
      "PATCH",
      "/authn/profile/",
      ann.access,
      {
        first_name: "Annie",
      },
    );
    expect(renamed.response.status()).toBe(200);
    const annRow = async () =>
      (
        await rosterEntries(request, event.code, organizer.access)
      ).participants.find((entry) => entry.email === annEmail);
    expect((await annRow()).name).toBe("Annie Able");
    runDjangoScript(
      `
from apps.scheduling.models import Participant

Participant.objects.filter(event__code=data["code"], member_id=data["id"]).update(
    participant_name="Ann From Sales"
)
`,
      { code: event.code, id: ann.user.id },
    );
    expect((await annRow()).name).toBe("Ann From Sales");
    joined = await join(ann.access);
    expect(joined.response.status()).toBe(200);
    expect(joined.payload.participant).toMatchObject({
      id: ann.user.id,
      name: "Annie Able",
    });

    // A display name over 100 characters is refused.
    const longFirst = "Bartholomew".padEnd(60, "x");
    const longLast = "Longname".padEnd(50, "y");
    const long = await registerAccountViaApi(
      request,
      `cap-long-${runId}@example.com`,
      longFirst,
      longLast,
    );
    joined = await join(long.access);
    expect(joined.response.status()).toBe(400);
    expect(joined.payload.error).toBe("Name too long (max 100)");

    // An account with no name and no primary email has no display name.
    const blank = await registerAccountViaApi(
      request,
      `cap-blank-${runId}@example.com`,
      "Blank",
      "Name",
    );
    runDjangoScript(
      `
from apps.authn.models import ContactEmail, Member

Member.objects.filter(pk=data["id"]).update(first_name="", last_name="")
ContactEmail.objects.filter(member_id=data["id"]).update(email_type="secondary")
`,
      { id: blank.user.id },
    );
    joined = await join(blank.access);
    expect(joined.response.status()).toBe(400);
    expect(joined.payload.error).toBe("Name is required");
    runDjangoScript(
      `
from apps.authn.models import ContactEmail, Member

Member.objects.filter(pk=data["id"]).update(first_name="Blank", last_name="Name")
ContactEmail.objects.filter(member_id=data["id"]).update(email_type="primary")
`,
      { id: blank.user.id },
    );

    // Fill the event to the cap with this test's own placeholder rows; the
    // finally removes them even if seeding stops half way.
    try {
      const seeded = runDjangoJson(
        `
from django.conf import settings

from apps.authn.models import Member
from apps.scheduling.models import Event, Participant

event = Event.objects.get(code=data["code"])
limit = settings.EVENT_MAX_PARTICIPANTS
missing = limit - event.participants.count()
members = Member.objects.bulk_create(
    [
        Member(
            first_name=f"Seat {index}",
            last_name=data["runId"],
            access_level="temporary",
            password="!",
        )
        for index in range(missing)
    ]
)
Participant.objects.bulk_create(
    [
        Participant(event=event, member=member, participant_name=member.first_name)
        for member in members
    ]
)
print(json.dumps({"limit": limit, "count": event.participants.count()}))
`,
        { code: event.code, runId },
      );
      expect(seeded.count).toBe(seeded.limit);
      const dan = await registerAccountViaApi(
        request,
        `cap-dan-${runId}@example.com`,
        "Dan",
        "Door",
      );
      joined = await join(dan.access);
      expect(joined.response.status()).toBe(409);
      expect(joined.payload.error).toBe(
        `This event can have at most ${seeded.limit} participants`,
      );
      // Someone already on the event can still re-join a full event.
      joined = await join(ann.access);
      expect(joined.response.status()).toBe(200);
    } finally {
      runDjangoScript(
        `
from apps.authn.models import Member

Member.objects.filter(last_name=data["runId"], access_level="temporary").delete()
`,
        { runId },
      );
    }
  });
});

// Paints, copies or fills, then waits for the autosave PUT it triggers and
// returns the request body it sent.
async function saved(page, action) {
  const save = waitForAutosave(page);
  await action();
  return (await save).request().postDataJSON();
}

// Drags one pointer stroke from the first cell through the others (all
// within a few rows, so one scroll shows them together).
async function dragAcross(page, cells) {
  await cells[cells.length - 1].scrollIntoViewIfNeeded();
  await cells[0].scrollIntoViewIfNeeded();
  const centre = async (cell) => {
    const box = await cell.boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const [startX, startY] = await centre(cells[0]);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const cell of cells.slice(1)) {
    const [x, y] = await centre(cell);
    await page.mouse.move(x, y, { steps: 4 });
  }
  await page.mouse.up();
}

test.describe("Participant schedule editor", () => {
  test("paints If needed by click, drag, Space and fill, moves the tab stop from the keyboard, and counts as Partial", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `brush-org-${runId}@example.com`,
      "Bea",
      "Organizer",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `If needed ${runId}`,
      accessMode: "open_link",
      startingAvailability: "busy",
    });
    const at = (day, time) => slotIndex(event, `weekday:${day}`, time);

    const participant = await newAccountContext(
      browser,
      `brush-pat-${runId}@example.com`,
      "Pat",
      "Partial",
    );
    const ppage = participant.page;
    await joinEventInBrowser(ppage, event.code, "Pat Partial");
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
    const brush = ppage.getByRole("group", { name: "Availability status" });
    const ifNeeded = brush.getByRole("button", {
      name: "If needed",
      exact: true,
    });
    // Shown once every queued autosave has gone through.
    const draftSaved = ppage.getByText(
      "Draft saved. Submit when you are ready.",
    );

    // A Busy start pre-selects Available; If needed is the third level.
    await expect(
      brush.getByRole("button", { name: "Available", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await ifNeeded.click();
    await expect(ifNeeded).toHaveAttribute("aria-pressed", "true");
    const applyIfNeeded = ppage.getByRole("button", {
      name: "Apply If needed to all",
    });
    await expect(applyIfNeeded).toBeVisible();

    // A click paints half availability, with its own glyph and label.
    const mon9 = at(1, "09:00");
    let body = await saved(ppage, () => cell(mon9).click());
    expect(body.availabilityInperson[mon9]).toBe(0.5);
    await expect(cell(mon9)).toHaveAttribute("data-availability", "partial");
    await expect(cell(mon9)).toHaveAttribute("aria-selected", "true");
    await expect(cell(mon9)).toHaveAttribute(
      "aria-label",
      "Mon, 9:00 AM – 9:30 AM, availability 0.5",
    );
    await expect(cell(mon9).locator(".schedule-grid-cell__glyph")).toHaveText(
      "◐",
    );

    // One drag stroke paints every cell it passes over, and nothing else.
    const stroke = ["09:00", "09:30", "10:00", "10:30"].map((time) =>
      at(2, time),
    );
    await saved(ppage, () =>
      dragAcross(
        ppage,
        stroke.map((index) => cell(index)),
      ),
    );
    await expect(draftSaved).toBeVisible();
    const painted = new Set([mon9, ...stroke]);
    expect(
      (
        await ownResponse(request, participant.token, event.code)
      ).availabilityInperson.map(Number),
    ).toEqual(
      Array.from({ length: event.slotCount }, (_, index) =>
        painted.has(index) ? 0.5 : 0,
      ),
    );
    for (const index of stroke) {
      await expect(cell(index)).toHaveAttribute("data-availability", "partial");
    }
    await expect(cell(at(2, "11:00"))).toHaveAttribute(
      "data-availability",
      "busy",
    );

    // The keyboard moves one roving tab stop around the grid.
    const tabStops = grid.locator("[data-cell-idx][tabindex='0']");
    await expect(tabStops).toHaveCount(1);
    await cell(at(3, "10:00")).focus();
    const moves = [
      ["ArrowDown", at(3, "10:30")],
      ["ArrowUp", at(3, "10:00")],
      ["ArrowLeft", at(2, "10:00")],
      ["ArrowRight", at(3, "10:00")],
      ["Home", at(1, "10:00")],
      ["End", at(5, "10:00")],
      ["Control+Home", at(1, "09:00")],
      ["Control+End", at(5, "16:30")],
    ];
    for (const [key, target] of moves) {
      await ppage.keyboard.press(key);
      await expect(cell(target), key).toBeFocused();
      await expect(cell(target)).toHaveAttribute("tabindex", "0");
      await expect(tabStops).toHaveCount(1);
    }
    // Space paints the focused cell.
    const fri1630 = at(5, "16:30");
    body = await saved(ppage, () => ppage.keyboard.press("Space"));
    expect(body.availabilityInperson[fri1630]).toBe(0.5);
    await expect(cell(fri1630)).toHaveAttribute("data-availability", "partial");

    // "Apply If needed to all" fills every slot with 0.5.
    body = await saved(ppage, () => applyIfNeeded.click());
    expect(body.availabilityInperson).toEqual(Array(event.slotCount).fill(0.5));
    const stored = await ownResponse(request, participant.token, event.code);
    expect(stored.availabilityInperson.map(Number)).toEqual(
      Array(event.slotCount).fill(0.5),
    );
    await ppage.getByRole("button", { name: "Submit Availability" }).click();
    await expect(ppage.getByText("Schedule submitted.")).toBeVisible();
    await participant.context.close();

    // The organizer's attendance review counts the person as Partial.
    recomputeEventResults(event.code);
    await page.goto(`/event?code=${event.code}`);
    await chooseRecommendedTime(page, 0);
    await reviewAttendance(page);
    await expect(attendanceTile(page, "Partial")).toHaveText("1");
    await expect(attendanceTile(page, "Available")).toHaveText("0");
    await expect(attendanceTile(page, "Unavailable")).toHaveText("0");
  });

  test("edits mixed In person and Virtual schedules with tabs, copy and replace", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `mixed-org-${runId}@example.com`,
      "Olga",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Hybrid editor ${runId}`,
      mode: "mixed",
      location: "Hybrid Room",
      accessMode: "open_link",
    });
    const allAvailable = Array(event.slotCount).fill(1);
    const allBusy = Array(event.slotCount).fill(0);
    const participant = await newAccountContext(
      browser,
      `mixed-pat-${runId}@example.com`,
      "Pat",
      "Painter",
    );
    const ppage = participant.page;
    const stored = () => ownResponse(request, participant.token, event.code);

    // Two tabs, In person first; both channels start all Available.
    await joinEventInBrowser(ppage, event.code, "Pat Painter");
    const tabs = ppage.getByRole("tablist", { name: "Schedule channel" });
    const inTab = tabs.getByRole("tab", { name: "In person" });
    const vTab = tabs.getByRole("tab", { name: "Virtual" });
    await expect(inTab).toHaveAttribute("aria-selected", "true");
    await expect(vTab).toHaveAttribute("aria-selected", "false");
    const panel = ppage.getByRole("tabpanel", { name: "In person" });
    await expect(
      panel.getByRole("heading", { level: 4, name: "In-Person", exact: true }),
    ).toBeVisible();
    const inGrid = ppage.getByRole("grid", { name: "In-Person", exact: true });
    const vGrid = ppage.getByRole("grid", { name: "Virtual", exact: true });
    await expect(inGrid).toBeVisible();
    await expect(vGrid).toHaveCount(0);
    const copyToVirtual = ppage.getByRole("button", {
      name: "Copy In-Person to Virtual",
    });
    // Both channels match, so there is nothing to copy; nothing is blocked,
    // so the editor shows no legend.
    await expect(copyToVirtual).toBeDisabled();
    await expect(
      ppage.getByRole("list", { name: "Availability legend" }),
    ).toHaveCount(0);

    // Busy over the first In person slot changes only that channel.
    let body = await saved(ppage, () =>
      inGrid.locator('[data-cell-idx="0"]').click(),
    );
    expect(body.availabilityInperson[0]).toBe(0);
    expect(body.availabilityVirtual).toEqual(allAvailable);
    await expect(copyToVirtual).toBeEnabled();

    // Virtual is untouched, so the copy lands without asking and the editor
    // moves to the channel it just filled.
    body = await saved(ppage, () => copyToVirtual.click());
    expect(body.availabilityVirtual).toEqual(body.availabilityInperson);
    await expect(vTab).toHaveAttribute("aria-selected", "true");
    await expect(vGrid).toBeVisible();
    await expect(
      ppage.getByRole("button", { name: "Copy Virtual to In-Person" }),
    ).toBeDisabled();

    // A Virtual-only paint makes the schedules differ again.
    body = await saved(ppage, () =>
      vGrid.locator('[data-cell-idx="1"]').click(),
    );
    expect(body.availabilityVirtual[1]).toBe(0);
    expect(body.availabilityInperson[1]).toBe(1);

    // The tabs follow the arrow keys, Home and End, and take focus.
    await vTab.focus();
    for (const [key, tab] of [
      ["ArrowLeft", inTab],
      ["ArrowRight", vTab],
      ["Home", inTab],
      ["End", vTab],
      ["ArrowDown", inTab],
      ["ArrowUp", vTab],
    ]) {
      await ppage.keyboard.press(key);
      await expect(tab, key).toHaveAttribute("aria-selected", "true");
      await expect(tab).toBeFocused();
    }
    await inTab.click();
    await expect(inGrid).toBeVisible();

    // Copying over the painted Virtual schedule asks first; Cancel keeps it.
    await copyToVirtual.click();
    const replace = ppage.getByRole("alertdialog", {
      name: "Replace Virtual availability?",
    });
    await expect(replace).toHaveAccessibleDescription(
      "This copies every In-Person value and replaces the current Virtual schedule.",
    );
    await replace.getByRole("button", { name: "Cancel" }).click();
    await expect(replace).toHaveCount(0);
    // A copy would have moved to the Virtual tab and made the two schedules
    // match (disabling the copy button); neither happened.
    await expect(inTab).toHaveAttribute("aria-selected", "true");
    await expect(copyToVirtual).toBeEnabled();
    let response = await stored();
    expect(response.availabilityVirtual[1]).toBe(0);
    expect(response.availabilityVirtual[0]).toBe(0);

    // Replace schedule copies it over and shows the Virtual tab.
    await copyToVirtual.click();
    body = await saved(ppage, () =>
      replace.getByRole("button", { name: "Replace schedule" }).click(),
    );
    expect(body.availabilityVirtual).toEqual(body.availabilityInperson);
    await expect(vTab).toHaveAttribute("aria-selected", "true");
    response = await stored();
    expect(response.availabilityVirtual[0]).toBe(0);
    expect(response.availabilityVirtual[1]).toBe(1);

    // Apply to all fills both channels of a mixed event.
    body = await saved(ppage, () =>
      ppage.getByRole("button", { name: "Apply Busy to all" }).click(),
    );
    expect(body.availabilityInperson).toEqual(allBusy);
    expect(body.availabilityVirtual).toEqual(allBusy);
    response = await stored();
    expect(response.availabilityInperson).toEqual(allBusy);
    expect(response.availabilityVirtual).toEqual(allBusy);
    await participant.context.close();
  });

  test("edits a virtual-only schedule around organizer-blocked slots", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `virtual-org-${runId}@example.com`,
      "Vera",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Virtual editor ${runId}`,
      mode: "virtual",
      location: "",
      accessMode: "open_link",
      blockedSlots: { "weekday:1": [0] },
    });
    const blocked = slotIndex(event, "weekday:1", "09:00");
    const mon930 = slotIndex(event, "weekday:1", "09:30");
    const mon10 = slotIndex(event, "weekday:1", "10:00");
    const allAvailable = Array(event.slotCount).fill(1);
    const participant = await newAccountContext(
      browser,
      `virtual-pat-${runId}@example.com`,
      "Pat",
      "Remote",
    );
    const ppage = participant.page;
    await joinEventInBrowser(ppage, event.code, "Pat Remote");

    // One grid, no channel tabs, virtual swatches on the brush.
    const grid = ppage.getByRole("grid", { name: "Availability", exact: true });
    await expect(grid).toBeVisible();
    await expect(
      ppage.getByRole("tablist", { name: "Schedule channel" }),
    ).toHaveCount(0);
    const brush = ppage.getByRole("group", { name: "Availability status" });
    await expect(brush.locator(".availability-swatch--virtual")).toHaveCount(3);
    await expect(ppage.getByText("Times shown in UTC")).toBeVisible();

    // The organizer's block is grey-striped, inert, explained and listed.
    await expect(
      ppage.getByRole("note").filter({
        hasText:
          "Grey striped times are blocked by the organizer and do not apply to this event.",
      }),
    ).toBeVisible();
    const legend = ppage.getByRole("list", { name: "Availability legend" });
    await expect(legend.getByRole("listitem")).toHaveText(["Blocked"]);
    const blockedCell = grid.locator(`[data-cell-idx="${blocked}"]`);
    await expect(blockedCell).toHaveAttribute("data-blocked", "true");
    await expect(blockedCell).toHaveAttribute("aria-disabled", "true");
    await expect(blockedCell).toHaveAttribute(
      "aria-label",
      "Mon, 9:00 AM – 9:30 AM, blocked for this event",
    );
    await expect(blockedCell).not.toHaveAttribute("tabindex");
    await expect(blockedCell).not.toHaveAttribute("data-availability");
    // The roving tab stop starts on the first open cell, and arrows skip the
    // block.
    const firstOpen = grid.locator(`[data-cell-idx="${mon930}"]`);
    await expect(firstOpen).toHaveAttribute("tabindex", "0");
    await firstOpen.focus();
    await ppage.keyboard.press("ArrowUp");
    await expect(firstOpen).toBeFocused();

    // Joining seeded both arrays at the starting level, the block too.
    const joined = await ownResponse(request, participant.token, event.code);
    expect(joined.availabilityVirtual).toEqual(allAvailable);
    expect(joined.availabilityInperson).toEqual(allAvailable);

    // A click on the block paints nothing; a stroke that ends on it paints
    // only the open cells, and only the virtual array changes.
    await blockedCell.click({ force: true });
    await saved(ppage, () =>
      dragAcross(ppage, [
        grid.locator(`[data-cell-idx="${mon10}"]`),
        firstOpen,
        blockedCell,
      ]),
    );
    await expect(
      ppage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    const stroked = await ownResponse(request, participant.token, event.code);
    expect(stroked.availabilityVirtual).toEqual(
      allAvailable.map((value, index) =>
        index === mon10 || index === mon930 ? 0 : value,
      ),
    );
    expect(stroked.availabilityInperson).toEqual(allAvailable);
    await expect(blockedCell).not.toHaveAttribute("data-availability");

    // Fills leave the block at 0 and skip the in-person array.
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Apply Busy to all" }).click(),
    );
    const body = await saved(ppage, () =>
      ppage.getByRole("button", { name: "Mark all Available" }).click(),
    );
    const expected = allAvailable.map((value, index) =>
      index === blocked ? 0 : value,
    );
    expect(body.availabilityVirtual).toEqual(expected);
    const stored = await ownResponse(request, participant.token, event.code);
    expect(stored.availabilityVirtual).toEqual(expected);
    expect(stored.availabilityInperson).toEqual(allAvailable);
    await participant.context.close();
  });
});

// Every control that changes a response is disabled and the grid is
// read-only (no tab stops, no selection state) behind the locked notice.
async function expectLocked(ppage, message) {
  await expect(ppage.locator(".participant-locked-notice")).toHaveText(message);
  await expect(ppage.locator(".participant-locked-notice")).toHaveRole(
    "status",
  );
  const brush = ppage.getByRole("group", { name: "Availability status" });
  for (const name of ["Busy", "If needed", "Available"]) {
    await expect(
      brush.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    ppage.getByRole("button", { name: /^Apply .+ to all$/ }),
  ).toBeDisabled();
  await expect(
    ppage.getByRole("button", { name: /^Mark all / }),
  ).toBeDisabled();
  await expect(
    ppage.getByRole("button", { name: /^(Submit|Update) Availability$/ }),
  ).toBeDisabled();
  const grid = ppage.getByRole("grid", { name: "Availability" });
  await expect(grid).toHaveAttribute("aria-readonly", "true");
  await expect(grid.locator("[data-cell-idx][tabindex]")).toHaveCount(0);
  await expect(grid.locator("[data-cell-idx][aria-selected]")).toHaveCount(0);
}

// Stops the page's timers where they are, so a queued autosave (700 ms)
// cannot fire by itself: only an explicit flush can save the draft. Returns
// the function that lets time run again.
async function holdPageTimers(page) {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  return () => page.clock.resume();
}

function isParticipantUpdate(request) {
  return request.method() === "PUT" && updateRoutePattern.test(request.url());
}

test.describe("Submitting and refreshing a response", () => {
  test("Submit saves the pending draft first and marks the response Submitted; a later edit withdraws it", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `submit-org-${runId}@example.com`,
      "Sol",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Submit ${runId}`,
    });
    const email = `submit-sue-${runId}@example.com`;
    const participant = await newAccountContext(
      browser,
      email,
      "Sue",
      "Submit",
    );
    await addPersonApi(request, event.code, token, {
      name: "Sue Submit",
      email,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, event.code, token, email, "sent");
    const invitation = async () =>
      (
        await apiJson(
          request,
          "GET",
          `/events/invitations?code=${event.code}`,
          token,
        )
      ).payload.invitations.find((entry) => entry.email === email);
    const reminderTargets = async () => {
      const preview = await apiJson(
        request,
        "POST",
        `/events/reminders?code=${event.code}`,
        token,
        { preview: true },
      );
      expect(preview.response.status()).toBe(200);
      return preview.payload.eligible;
    };
    const countedResponses = async () =>
      (await freshResults(request, token, event.code)).countedResponseTotal;
    expect(await reminderTargets()).toBe(1);

    const ppage = participant.page;
    await ppage.goto(`/event?code=${event.code}`);
    const heading = ppage.getByRole("heading", {
      level: 2,
      name: /Welcome, Sue Submit/,
    });
    await expect(heading).toContainText("Draft");
    await expect(heading).not.toContainText("Submitted");
    const submit = ppage.getByRole("button", { name: "Submit Availability" });
    const update = ppage.getByRole("button", { name: "Update Availability" });
    await expect(submit).toBeEnabled();
    await expect(update).toHaveCount(0);
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
    const puts = [];
    ppage.on("request", (sent) => {
      if (isParticipantUpdate(sent)) puts.push(sent.postDataJSON());
    });

    // With the page's timers held, the paint stays a pending draft until
    // Submit saves it and then submits.
    const resumeTimers = await holdPageTimers(ppage);
    await cell(0).click();
    await expect(cell(0)).toHaveAttribute("aria-selected", "false");
    await expect(ppage.getByText("Saving draft…")).toBeVisible();
    expect(puts).toHaveLength(0);
    const submitted = ppage.waitForResponse(
      (response) =>
        isParticipantUpdate(response.request()) &&
        response.request().postDataJSON().submitted === 1,
    );
    await submit.click();
    expect((await submitted).status()).toBe(200);
    await resumeTimers();
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ submitted: 0 });
    expect(puts[0].availabilityInperson[0]).toBe(0);
    expect(puts[1]).toEqual({
      submitted: 1,
      expectedVersion: expect.any(Number),
    });

    // The header, the status line and the button all say Submitted.
    await expect(ppage.getByText("Schedule submitted.")).toBeVisible();
    await expect(heading).toContainText("Submitted");
    await expect(heading).not.toContainText("Draft");
    await expect(update).toBeEnabled();
    await expect(submit).toHaveCount(0);
    let stored = await ownResponse(request, participant.token, event.code);
    expect(stored.submitted).toBe(1);
    expect(stored.availabilityInperson[0]).toBe(0);
    let sent = await invitation();
    expect(sent.status).toBe("submitted");
    expect(sent.submittedAt).toBeTruthy();
    expect(await reminderTargets()).toBe(0);
    expect(await countedResponses()).toBe(1);

    // Painting again turns the response back into a draft: it drops out of
    // the results and reminders target the person again.
    const withdrawn = await saved(ppage, () => cell(1).click());
    expect(withdrawn.submitted).toBe(0);
    await expect(
      ppage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    await expect(heading).toContainText("Draft");
    await expect(submit).toBeEnabled();
    await expect(update).toHaveCount(0);
    stored = await ownResponse(request, participant.token, event.code);
    expect(stored.submitted).toBe(0);
    expect(stored.availabilityInperson.slice(0, 2)).toEqual([0, 0]);
    sent = await invitation();
    expect(sent.status).toBe("draft_saved");
    expect(sent.draftSavedAt).toBeTruthy();
    expect(await reminderTargets()).toBe(1);
    expect(await countedResponses()).toBe(0);

    // A draft that cannot be saved blocks the submit.
    const failDraft = (route) =>
      route.request().method() === "PUT" &&
      route.request().postDataJSON()?.submitted === 0
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary outage" }),
          })
        : route.fallback();
    const draftRefused = () =>
      ppage.waitForResponse(
        (response) =>
          isParticipantUpdate(response.request()) && response.status() === 503,
      );
    await ppage.route(updateRoutePattern, failDraft);
    let refused = draftRefused();
    await cell(2).click();
    await refused;
    await expect(
      ppage.getByRole("alert").filter({ hasText: "Temporary outage" }),
    ).toBeVisible();
    refused = draftRefused();
    await submit.click();
    await refused;
    await expect(ppage.locator(".participant-error")).toHaveText(
      "Save the draft successfully before submitting.",
    );
    await expect(heading).toContainText("Draft");
    // The page never asked the server to submit the unsaved draft.
    expect(puts.filter((sent) => sent.submitted === 1)).toHaveLength(1);
    await ppage.unroute(updateRoutePattern, failDraft);
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Retry save" }).click(),
    );
    await expect(
      ppage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();

    // A submit the server refuses reports why.
    await setLifecycleViaApi(request, token, event.code, "closed");
    const lockedSubmit = ppage.waitForResponse(
      (response) =>
        isParticipantUpdate(response.request()) &&
        response.request().postDataJSON().submitted === 1,
    );
    await submit.click();
    const locked = await lockedSubmit;
    expect(locked.status()).toBe(409);
    expect(await locked.json()).toEqual({
      error: "Responses cannot change while the event is closed.",
      errorCode: "participant_response_locked",
    });
    await expect(ppage.locator(".participant-error")).toHaveText(
      "Failed to submit: Responses cannot change while the event is closed.",
    );
    await expect(heading).toContainText("Draft");
    stored = await ownResponse(request, participant.token, event.code);
    expect(stored.submitted).toBe(0);
    expect(stored.availabilityInperson.slice(0, 3)).toEqual([0, 0, 0]);
    await participant.context.close();
  });

  test("Refresh saves the draft first, then picks up a new starting level, a response changed elsewhere, and the closed and archived locks", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `refresh-org-${runId}@example.com`,
      "Rae",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Refresh ${runId}`,
      accessMode: "open_link",
    });
    const participant = await newAccountContext(
      browser,
      `refresh-pat-${runId}@example.com`,
      "Pat",
      "Refresh",
    );
    const ppage = participant.page;
    await joinEventInBrowser(ppage, event.code, "Pat Refresh");
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
    const brush = ppage.getByRole("group", { name: "Availability status" });
    const refresh = ppage.getByRole("button", { name: "Refresh", exact: true });
    const traffic = [];
    ppage.on("request", (sent) => {
      const url = new URL(sent.url());
      traffic.push(`${sent.method()} ${url.pathname}`);
    });

    // A paint still waiting for its autosave is saved before the re-read.
    const resumeTimers = await holdPageTimers(ppage);
    await cell(0).click();
    await expect(ppage.getByText("Saving draft…")).toBeVisible();
    expect(traffic).not.toContain("PUT /events/participants/update");
    const eventRead = ppage.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/events?code=${event.code}`),
    );
    await refresh.click();
    await eventRead;
    await resumeTimers();
    await expect(
      ppage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    const saveAt = traffic.indexOf("PUT /events/participants/update");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(traffic.indexOf("GET /events", saveAt)).toBeGreaterThan(saveAt);
    let stored = await ownResponse(request, participant.token, event.code);
    expect(stored.availabilityInperson[0]).toBe(0);

    // The organizer switches to a Busy start: Refresh flips the brush and the
    // fill buttons, and keeps this painted response.
    await expect(
      brush.getByRole("button", { name: "Busy", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await updateEventViaApi(request, token, event.code, {
      startingAvailability: "busy",
    });
    await refresh.click();
    await expect(
      brush.getByRole("button", { name: "Available", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      ppage.getByRole("button", { name: "Mark all Busy" }),
    ).toBeVisible();
    await expect(
      ppage.getByRole("button", { name: "Apply Available to all" }),
    ).toBeVisible();
    await expect(
      ppage.getByText(
        "Choose a status, then click or drag across the times below.",
      ),
    ).toBeVisible();
    await expect(cell(0)).toHaveAttribute("aria-selected", "false");
    await expect(cell(1)).toHaveAttribute("aria-selected", "true");

    // A change saved in another session shows after Refresh.
    const changed = [...stored.availabilityInperson];
    changed[5] = 0;
    const elsewhere = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${event.code}&participantId=${stored.id}`,
      participant.token,
      { availabilityInperson: changed, expectedVersion: stored.version },
    );
    expect(elsewhere.response.status()).toBe(200);
    await expect(cell(5)).toHaveAttribute("aria-selected", "true");
    await refresh.click();
    await expect(cell(5)).toHaveAttribute("aria-selected", "false");

    // Closing and archiving lock the editor after a Refresh; the server
    // refuses the write as well.
    await setLifecycleViaApi(request, token, event.code, "closed");
    await refresh.click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is closed.",
    );
    await setLifecycleViaApi(request, token, event.code, "archived");
    await refresh.click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is archived.",
    );
    stored = await ownResponse(request, participant.token, event.code);
    const archivedWrite = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${event.code}&participantId=${stored.id}`,
      participant.token,
      { submitted: 1, expectedVersion: stored.version },
    );
    expect(archivedWrite.response.status()).toBe(409);
    expect(archivedWrite.payload).toEqual({
      error: "Responses cannot change while the event is archived.",
      errorCode: "participant_response_locked",
    });

    // Reactivating unlocks the editor with the response intact.
    await setLifecycleViaApi(request, token, event.code, "active");
    await refresh.click();
    await expect(ppage.locator(".participant-locked-notice")).toHaveCount(0);
    await expect(grid).not.toHaveAttribute("aria-readonly");
    await expect(
      ppage.getByRole("button", { name: "Submit Availability" }),
    ).toBeEnabled();
    await expect(
      brush.getByRole("button", { name: "If needed", exact: true }),
    ).toBeEnabled();
    await expect(cell(0)).toHaveAttribute("aria-selected", "false");
    await expect(cell(5)).toHaveAttribute("aria-selected", "false");
    await expect(cell(1)).toHaveAttribute("aria-selected", "true");
    await expect(grid.locator("[data-cell-idx][tabindex='0']")).toHaveCount(1);
    await participant.context.close();
  });
});

// GET events/finalization/calendar with a bearer token.
function finalCalendar(request, token, code) {
  return apiJson(
    request,
    "GET",
    `/events/finalization/calendar?code=${code}`,
    token,
  );
}

test.describe("The confirmed meeting", () => {
  test("a joined participant sees the confirmed meeting, also once archived, and downloads its calendar, which only people on the event may fetch", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `final-org-${runId}@example.com`,
      "Flo",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Final ${runId}`,
      accessMode: "open_link",
      location: "Board Room",
    });
    const { code } = event;

    // Fay joins in the browser; Quinn joins and is later hidden; Ines is
    // invited by email before she has an account; Uma is unrelated.
    const fay = await newAccountContext(
      browser,
      `final-fay-${runId}@example.com`,
      "Fay",
      "Final",
    );
    await joinEventInBrowser(fay.page, code, "Fay Final");
    await fay.page.getByRole("button", { name: "Submit Availability" }).click();
    await expect(fay.page.getByText("Schedule submitted.")).toBeVisible();
    const quinn = await registerAccountViaApi(
      request,
      `final-quinn-${runId}@example.com`,
      "Quinn",
      "Hidden",
    );
    const quinnJoin = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      quinn.access,
    );
    expect(quinnJoin.response.status()).toBe(201);
    const hidden = await apiJson(
      request,
      "DELETE",
      `/events/participants/update?code=${code}&participantId=${quinn.user.id}`,
      token,
    );
    expect(hidden.response.status()).toBe(200);
    const inesEmail = `final-ines-${runId}@example.com`;
    const invited = await apiJson(
      request,
      "POST",
      `/events/invitations?code=${code}`,
      token,
      { emails: [inesEmail], idempotencyKey: crypto.randomUUID() },
    );
    expect(invited.response.status()).toBe(202);
    const ines = await registerAccountViaApi(
      request,
      inesEmail,
      "Ines",
      "Invitee",
    );
    const uma = await registerAccountViaApi(
      request,
      `final-uma-${runId}@example.com`,
      "Uma",
      "Unrelated",
    );

    // Nothing is confirmed yet.
    let calendar = await finalCalendar(request, token, code);
    expect(calendar.response.status()).toBe(404);
    expect(calendar.payload.error).toBe(
      "No active final meeting has been confirmed",
    );

    const results = await freshResults(request, token, code);
    await finalizeViaApi(request, token, code, results.recommendations[0], {
      location: "Board Room",
    });
    const meeting = (await eventState(request, token, code)).finalMeeting;
    expect(meeting).not.toBeNull();

    // The joined view locks, lists the meeting in the event's zone (UTC),
    // and downloads the calendar file.
    const ppage = fay.page;
    await ppage.goto(`/event?code=${code}`);
    await expect(ppage.getByText(/Welcome, Fay Final/)).toBeVisible();
    await expectLocked(
      ppage,
      "Responses are locked while this event is finalized.",
    );
    const confirmed = ppage.locator("dl[aria-label='Confirmed meeting']");
    await expect(confirmed.locator("dt")).toHaveText([
      "Final Start",
      "Final End",
      "Final Method",
    ]);
    const meetingCards = [
      await browserDateTime(ppage, meeting.startsAt, "UTC"),
      await browserDateTime(ppage, meeting.endsAt, "UTC"),
      "In-Person · Board Room",
    ];
    await expect(confirmed.locator("dd")).toHaveText(meetingCards);
    const download = ppage.getByRole("button", {
      name: "Download calendar (.ics)",
    });
    const pending = ppage.waitForEvent("download");
    await download.click();
    const file = await pending;
    expect(file.suggestedFilename()).toBe(`releviz-${code}-final.ics`);
    const body = await fs.readFile(await file.path(), "utf8");
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(`UID:${meeting.calendarUid}`);
    expect(body).toContain(`DTSTART:${icsUtc(meeting.startsAt)}`);
    expect(body).toContain(`DTEND:${icsUtc(meeting.endsAt)}`);

    // The organizer, a visible participant and an invitee matched by their
    // verified email may fetch the file; an unrelated account and a hidden
    // participant may not.
    const inesInvitation = (
      await apiJson(request, "GET", `/events/invitations?code=${code}`, token)
    ).payload.invitations.find((entry) => entry.email === inesEmail);
    expect(inesInvitation.memberId).toBeNull();
    for (const [who, bearer] of [
      ["organizer", token],
      ["participant", fay.token],
      ["invitee", ines.access],
    ]) {
      calendar = await finalCalendar(request, bearer, code);
      expect(calendar.response.status(), who).toBe(200);
      expect(calendar.response.headers()["content-disposition"]).toBe(
        `attachment; filename="releviz-${code}-final.ics"`,
      );
      expect(calendar.payload).toContain(`UID:${meeting.calendarUid}`);
    }
    for (const [who, bearer] of [
      ["unrelated", uma.access],
      ["hidden participant", quinn.access],
    ]) {
      calendar = await finalCalendar(request, bearer, code);
      expect(calendar.response.status(), who).toBe(403);
      expect(calendar.payload.error).toBe(
        "You do not have access to this calendar invitation",
      );
    }

    // Archiving keeps the meeting on people's calendars: after a Refresh the
    // page is locked as archived, still lists it, and the file is served.
    await setLifecycleViaApi(request, token, code, "archived");
    await ppage.getByRole("button", { name: "Refresh", exact: true }).click();
    await expectLocked(
      ppage,
      "Responses are locked while this event is archived.",
    );
    await expect(confirmed.locator("dd")).toHaveText(meetingCards);
    await expect(download).toBeEnabled();
    calendar = await finalCalendar(request, fay.token, code);
    expect(calendar.response.status()).toBe(200);
    expect(calendar.payload).toContain(`UID:${meeting.calendarUid}`);

    // Reactivating cancels the meeting: the file is gone for everyone, a
    // stale page's download reports it, and Refresh clears the meeting.
    await setLifecycleViaApi(request, token, code, "active");
    for (const bearer of [token, fay.token]) {
      calendar = await finalCalendar(request, bearer, code);
      expect(calendar.response.status()).toBe(404);
      expect(calendar.payload.error).toBe(
        "No active final meeting has been confirmed",
      );
    }
    await download.click();
    await expect(
      ppage.getByRole("alert").filter({ hasText: "We couldn't download" }),
    ).toHaveText(
      "We couldn't download the calendar invitation: No active final meeting has been confirmed",
    );
    await ppage.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(ppage.locator(".participant-locked-notice")).toHaveCount(0);
    await expect(confirmed).toHaveCount(0);
    await expect(download).toHaveCount(0);
    await fay.context.close();
  });
});

test.describe("Leaving the editor and the deadline", () => {
  test("a draft that cannot be saved keeps the person on the page for a link, Back and a real unload", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `guard-org-${runId}@example.com`,
      "Gil",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Guard ${runId}`,
      accessMode: "open_link",
    });
    const participant = await newAccountContext(
      browser,
      `guard-pat-${runId}@example.com`,
      "Pat",
      "Guard",
    );
    const ppage = participant.page;
    // The dashboard comes first, so Back has somewhere to go.
    await joinEventInBrowser(ppage, event.code, "Pat Guard");
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const cell = (index) => grid.locator(`[data-cell-idx="${index}"]`);
    const outage = (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary outage" }),
          })
        : route.fallback();
    const refusedSave = () =>
      ppage.waitForResponse(
        (response) =>
          isParticipantUpdate(response.request()) && response.status() === 503,
      );
    const failed = ppage
      .getByRole("alert")
      .filter({ hasText: "Temporary outage" });
    const onEvent = new RegExp(`/event\\?code=${event.code}$`);

    await ppage.route(updateRoutePattern, outage);
    let refused = refusedSave();
    await cell(0).click();
    await refused;
    await expect(failed).toBeVisible();

    // An in-app link tries to save first, fails, and stays.
    refused = refusedSave();
    await ppage.getByRole("link", { name: "Releviz", exact: true }).click();
    await refused;
    await expect(failed).toBeVisible();
    await expect(ppage).toHaveURL(onEvent);
    await expect(ppage.getByText(/Welcome, Pat Guard/)).toBeVisible();

    // So does Back.
    refused = refusedSave();
    await ppage.goBack();
    await refused;
    await expect(failed).toBeVisible();
    await expect(ppage).toHaveURL(onEvent);
    await expect(ppage.getByText(/Welcome, Pat Guard/)).toBeVisible();

    // Closing the tab raises the browser's own leave prompt; staying keeps
    // the page and its unsaved paint.
    const prompt = ppage.waitForEvent("dialog");
    await ppage.close({ runBeforeUnload: true });
    const dialog = await prompt;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    await expect(ppage.getByText(/Welcome, Pat Guard/)).toBeVisible();
    await expect(cell(0)).toHaveAttribute("aria-selected", "false");

    // Once the save goes through, the same link leaves at once.
    await ppage.unroute(updateRoutePattern, outage);
    await saved(ppage, () =>
      ppage.getByRole("button", { name: "Retry save" }).click(),
    );
    const stored = await ownResponse(request, participant.token, event.code);
    expect(stored.availabilityInperson[0]).toBe(0);
    await ppage.getByRole("link", { name: "Releviz", exact: true }).click();
    await expect(ppage).not.toHaveURL(/\/event\?/);
    await participant.context.close();
  });

  test("the editor locks itself when the deadline passes, and the server refuses late writes", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `deadline-org-${runId}@example.com`,
      "Dee",
      "Organizer",
    );
    const event = await createEvent(request, organizer.access, {
      name: `Deadline ${runId}`,
      accessMode: "open_link",
      responseDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const participant = await newAccountContext(
      browser,
      `deadline-pat-${runId}@example.com`,
      "Pat",
      "Late",
    );
    const ppage = participant.page;
    // The page's clock is controlled from before it loads, so the deadline
    // timer it sets can be run forward instead of waited for.
    await ppage.clock.install();
    await joinEventInBrowser(ppage, event.code, "Pat Late");
    const grid = ppage.getByRole("grid", { name: "Availability" });

    // A draft is left unsaved by an outage.
    const outage = (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary outage" }),
          })
        : route.fallback();
    await ppage.route(updateRoutePattern, outage);
    const refused = ppage.waitForResponse(
      (response) =>
        isParticipantUpdate(response.request()) && response.status() === 503,
    );
    await grid.locator('[data-cell-idx="0"]').click();
    await refused;
    await ppage.unroute(updateRoutePattern, outage);
    await expect(ppage.locator(".participant-locked-notice")).toHaveCount(0);

    // The deadline passes: the editor locks on its own, and the pending
    // draft can no longer be saved.
    await ppage.clock.fastForward("01:00:05");
    await expectLocked(ppage, "The response deadline has passed.");
    const puts = [];
    ppage.on("request", (sent) => {
      if (isParticipantUpdate(sent)) puts.push(sent.url());
    });
    await ppage.getByRole("button", { name: "Retry save" }).click();
    await expect(
      ppage.getByRole("alert").filter({ hasText: "Responses are locked" }),
    ).toContainText("Responses are locked, so this draft could not be saved.");
    expect(puts).toEqual([]);

    // Once the deadline has really passed, the server refuses the write.
    expireDeadline(event.code);
    const stored = await ownResponse(request, participant.token, event.code);
    expect(stored.availabilityInperson[0]).toBe(1);
    const late = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${event.code}&participantId=${stored.id}`,
      participant.token,
      { submitted: 1, expectedVersion: stored.version },
    );
    expect(late.response.status()).toBe(409);
    expect(late.payload).toEqual({
      error: "The response deadline has passed.",
      errorCode: "participant_response_locked",
    });
    await participant.context.close();
  });
});

// A roster listing entry for one address.
async function rosterEntry(request, code, token, email) {
  const listing = await rosterEntries(request, code, token, { search: email });
  const entry = listing.participants.find(
    (participant) => participant.email === email.toLowerCase(),
  );
  expect(entry, email).toBeTruthy();
  return entry;
}

// Includes or excludes someone from the results, as the person panel does.
async function setIncluded(request, code, token, email, included) {
  const entry = await rosterEntry(request, code, token, email);
  const patched = await apiJson(
    request,
    "PATCH",
    `/events/roster/${entry.id}?code=${code}`,
    token,
    { included, expectedVersion: entry.version },
  );
  expect(patched.response.status(), JSON.stringify(patched.payload)).toBe(200);
}

test.describe("Who may change a response", () => {
  test("a participant cannot rename, regroup or reorder themselves, touch another row or their email, or save without a version; an excluded one cannot save", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `rules-org-${runId}@example.com`,
      "Rex",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Response rules ${runId}`,
      accessMode: "open_link",
    });
    const { code } = event;
    const other = await addPersonApi(request, code, token, {
      name: "Otto Other",
      email: `rules-otto-${runId}@example.com`,
    });
    const email = `rules-pat-${runId}@example.com`;
    const participant = await newAccountContext(browser, email, "Pat", "Rules");
    const ppage = participant.page;
    await joinEventInBrowser(ppage, code, "Pat Rules");
    const mine = await ownResponse(request, participant.token, code);
    const schedule = [...mine.availabilityInperson];
    schedule[0] = 0;
    const put = (participantId, body) =>
      apiJson(
        request,
        "PUT",
        `/events/participants/update?code=${code}&participantId=${participantId}`,
        participant.token,
        body,
      );

    const refusals = [
      [
        "rename",
        mine.id,
        { name: "Pat Renamed", expectedVersion: mine.version },
        403,
        "participant_update_forbidden",
        "Only the organizer can rename a temporary participant",
      ],
      [
        "group",
        mine.id,
        { groupName: "Team A" },
        403,
        "participant_update_forbidden",
        "Only the organizer can update participant groups",
      ],
      [
        "order",
        mine.id,
        { sortOrder: 3 },
        403,
        "participant_update_forbidden",
        "Only the organizer can reorder participants",
      ],
      [
        "another person's availability",
        other.participant.id,
        { availabilityInperson: schedule, expectedVersion: 1 },
        403,
        "participant_update_forbidden",
        "Only participants can change their own availability",
      ],
      [
        "another person's row",
        other.participant.id,
        {},
        403,
        "participant_update_forbidden",
        "You do not have permission to update this participant",
      ],
      [
        "email",
        mine.id,
        {
          availabilityInperson: schedule,
          expectedVersion: mine.version,
          email: `rules-new-${runId}@example.com`,
        },
        400,
        "participant_email_immutable",
        "Participant email cannot be changed.",
      ],
      [
        "contact email",
        mine.id,
        { contactEmail: `rules-new-${runId}@example.com` },
        400,
        "participant_email_immutable",
        "Participant email cannot be changed.",
      ],
      [
        "no version",
        mine.id,
        { availabilityInperson: schedule },
        428,
        "participant_version_required",
        "expectedVersion is required",
      ],
    ];
    for (const [what, id, body, status, errorCode, error] of refusals) {
      const refused = await put(id, body);
      expect(refused.response.status(), what).toBe(status);
      expect(refused.payload, what).toEqual({ error, errorCode });
    }
    // Nothing changed.
    const after = await ownResponse(request, participant.token, code);
    expect(after).toMatchObject({
      name: "Pat Rules",
      version: mine.version,
      availabilityInperson: mine.availabilityInperson,
    });

    // The organizer leaves Pat out of the results: a paint fails to save
    // and says why, and the API refuses it too.
    await setIncluded(request, code, token, email, false);
    const grid = ppage.getByRole("grid", { name: "Availability" });
    const refusedSave = ppage.waitForResponse(
      (response) =>
        isParticipantUpdate(response.request()) && response.status() === 403,
    );
    await grid.locator('[data-cell-idx="0"]').click();
    const excluded = await refusedSave;
    expect(await excluded.json()).toEqual({
      error: "Excluded participants cannot change availability",
      errorCode: "participant_excluded",
    });
    const failure = ppage.getByRole("alert").filter({
      hasText: "Excluded participants cannot change availability",
    });
    await expect(failure).toBeVisible();
    await expect(
      failure.getByRole("button", { name: "Retry save" }),
    ).toBeVisible();
    const current = await ownResponse(request, participant.token, code);
    const direct = await put(mine.id, {
      availabilityInperson: schedule,
      expectedVersion: current.version,
    });
    expect(direct.response.status()).toBe(403);
    expect(direct.payload.errorCode).toBe("participant_excluded");

    // Counting only a group Pat is not in leaves Pat out in the same way.
    await setIncluded(request, code, token, email, true);
    expect((await rosterEntry(request, code, token, email)).included).toBe(
      true,
    );
    const grouped = await apiJson(
      request,
      "PUT",
      `/events/participants/update?code=${code}&participantId=${other.participant.id}`,
      token,
      { groupName: "Team A" },
    );
    expect(grouped.response.status()).toBe(200);
    const groups = await apiJson(
      request,
      "GET",
      `/events/roster/groups?code=${code}`,
      token,
    );
    const team = groups.payload.groups.find((group) => group.name === "Team A");
    const countOnly = await apiJson(
      request,
      "POST",
      `/events/roster/groups/${team.id}/include-only?code=${code}`,
      token,
      {},
    );
    expect(countOnly.response.status()).toBe(200);
    expect(countOnly.payload.includedCount).toBe(1);
    expect((await rosterEntry(request, code, token, email)).included).toBe(
      false,
    );
    const leftOut = await ownResponse(request, participant.token, code);
    const countOnlyWrite = await put(mine.id, {
      availabilityInperson: schedule,
      expectedVersion: leftOut.version,
    });
    expect(countOnlyWrite.response.status()).toBe(403);
    expect(countOnlyWrite.payload).toEqual({
      error: "Excluded participants cannot change availability",
      errorCode: "participant_excluded",
    });
    expect(
      (await ownResponse(request, participant.token, code))
        .availabilityInperson,
    ).toEqual(mine.availabilityInperson);
    await participant.context.close();
  });

  test("an organizer-added full account is theirs to fill in until the person saves, joins, or has answered before", async ({
    browser,
    page,
    request,
  }) => {
    const runId = newRunId();
    await registerAccount(
      page,
      `claim-org-${runId}@example.com`,
      "Cleo",
      "Organizer",
    );
    const token = (await readSession(page)).access;
    const event = await createEvent(request, token, {
      name: `Claims ${runId}`,
      accessMode: "open_link",
    });
    const { code } = event;
    const organizerPut = (memberId, body) =>
      apiJson(
        request,
        "PUT",
        `/events/participants/update?code=${code}&participantId=${memberId}`,
        token,
        body,
      );
    const expectOwned = async (email) => {
      const entry = await rosterEntry(request, code, token, email);
      expect(entry.canOrganizerEditAvailability, email).toBe(false);
      const denied = await organizerPut(entry.memberId, {
        availabilityInperson: Array(event.slotCount).fill(0),
        expectedVersion: entry.version,
      });
      expect(denied.response.status(), email).toBe(403);
      expect(denied.payload.errorCode).toBe("organizer_edit_participant_owned");
    };

    // Fern has an account; the organizer adds and invites her, then submits
    // for her. That is not her accepting the invitation.
    const fernEmail = `claim-fern-${runId}@example.com`;
    const fern = await newAccountContext(browser, fernEmail, "Fern", "Full");
    await addPersonApi(request, code, token, {
      name: "Fern Full",
      email: fernEmail,
      sendInvitation: true,
    });
    await waitForInvitationStatus(request, code, token, fernEmail, "sent");
    await submitOnBehalf(
      request,
      token,
      event,
      await rosterEntry(request, code, token, fernEmail),
    );
    let entry = await rosterEntry(request, code, token, fernEmail);
    expect(entry).toMatchObject({
      submitted: true,
      canOrganizerEditAvailability: true,
      invitationStatus: "sent",
    });
    const fernInvitation = async () =>
      (
        await apiJson(request, "GET", `/events/invitations?code=${code}`, token)
      ).payload.invitations.find(
        (invitation) => invitation.email === fernEmail,
      );
    let invitation = await fernInvitation();
    expect(invitation).toMatchObject({
      status: "submitted",
      acceptedAt: null,
      joinedAt: null,
    });
    await gotoParticipants(page, event);
    const fernRow = participantRow(page, "Fern Full");
    await expect(
      fernRow.getByRole("button", { name: "Edit schedule" }),
    ).toBeVisible();

    // Fern opens the event and changes a slot in her browser: the response
    // is hers now, and the organizer's list says so without a reload.
    await fern.page.goto(`/event?code=${code}`);
    await expect(fern.page.getByText(/Welcome, Fern Full/)).toBeVisible();
    // Opening her response is not answering it.
    entry = await rosterEntry(request, code, token, fernEmail);
    expect(entry.canOrganizerEditAvailability).toBe(true);
    await saved(fern.page, () =>
      fern.page
        .getByRole("grid", { name: "Availability" })
        .locator('[data-cell-idx="0"]')
        .click(),
    );
    await wakeLiveSync(page);
    await expect(fernRow.getByText("Answers themselves")).toBeVisible({
      timeout: LIVE_SYNC_TIMEOUT_MS,
    });
    await expect(
      fernRow.getByRole("button", { name: "Edit schedule" }),
    ).toHaveCount(0);
    await expectOwned(fernEmail);
    invitation = await fernInvitation();
    expect(invitation.acceptedAt).toBeTruthy();
    expect(invitation.status).toBe("draft_saved");
    entry = await rosterEntry(request, code, token, fernEmail);
    expect(entry.invitationStatus).toBe("accepted");
    await fern.context.close();

    // Rhea is added without an invitation and joins by herself: the join
    // returns her existing row and claims it.
    const rheaEmail = `claim-rhea-${runId}@example.com`;
    const rhea = await registerAccountViaApi(
      request,
      rheaEmail,
      "Rhea",
      "Joiner",
    );
    await addPersonApi(request, code, token, {
      name: "Rhea Joiner",
      email: rheaEmail,
    });
    entry = await rosterEntry(request, code, token, rheaEmail);
    expect(entry.canOrganizerEditAvailability).toBe(true);
    const rheaJoin = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      rhea.access,
    );
    expect(rheaJoin.response.status()).toBe(200);
    await expectOwned(rheaEmail);

    // Seth joined on his own, but his row lost its claim (as rows written by
    // an older release did). No organizer invitation links his row, so he
    // must have joined by himself: the organizer's write is refused and the
    // claim is restored.
    const sethEmail = `claim-seth-${runId}@example.com`;
    const seth = await registerAccountViaApi(
      request,
      sethEmail,
      "Seth",
      "Self",
    );
    const sethJoin = await apiJson(
      request,
      "POST",
      `/events/participants?code=${code}`,
      seth.access,
    );
    expect(sethJoin.response.status()).toBe(201);
    const claimOf = (memberId) =>
      runDjangoJson(
        `
from apps.scheduling.models import Participant

participant = Participant.objects.get(event__code=data["code"], member_id=data["member"])
print(json.dumps(participant.response_claimed_at is not None))
`,
        { code, member: memberId },
      );
    expect(claimOf(seth.user.id)).toBe(true);
    runDjangoScript(
      `
from apps.scheduling.models import Participant

Participant.objects.filter(event__code=data["code"], member_id=data["member"]).update(
    response_claimed_at=None
)
`,
      { code, member: seth.user.id },
    );
    entry = await rosterEntry(request, code, token, sethEmail);
    expect(entry.canOrganizerEditAvailability).toBe(true);
    const fallback = await organizerPut(entry.memberId, {
      availabilityInperson: Array(event.slotCount).fill(0),
      expectedVersion: entry.version,
    });
    expect(fallback.response.status()).toBe(403);
    expect(fallback.payload.errorCode).toBe("organizer_edit_participant_owned");
    expect(claimOf(seth.user.id)).toBe(true);
    await expectOwned(sethEmail);
    expect(
      (await ownResponse(request, seth.access, code)).availabilityInperson,
    ).toEqual(sethJoin.payload.participant.availabilityInperson);
  });
});

// Adds and invites a new address (a temporary identity), then opens the
// emailed link in a fresh context and verifies the emailed code. Returns the
// temporary page, its context and the address.
async function openTemporaryAccess(
  browser,
  request,
  token,
  event,
  email,
  name,
) {
  const invitedAt = Date.now() - 1000;
  await addPersonApi(request, event.code, token, {
    name,
    email,
    sendInvitation: true,
  });
  const invitation = await latestEmailFor(
    email,
    invitedAt,
    invitationEmail(event.code),
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const codeRequestedAt = Date.now() - 1000;
  await page.goto(temporaryAccessPathFromEmail(invitation));
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const accessCode = await latestVerificationCode(
    email,
    codeRequestedAt,
    "temp_event_access",
  );
  await page.getByLabel("Verification code").fill(accessCode);
  await page.getByRole("button", { name: "Verify and open schedule" }).click();
  await expect(page.getByRole("heading", { name: event.name })).toBeVisible();
  await expect(page.getByText(`You are responding as ${name}`)).toBeVisible();
  return { context, page };
}

// PUT events/temp-access/participant with the temporary page's own cookie.
function tempAccessPut(page, code, body) {
  return page.evaluate(
    async ({ url, data }) => {
      const response = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: response.status, payload: await response.json() };
    },
    {
      url: `${BACKEND_URL}/events/temp-access/participant?code=${code}`,
      data: body,
    },
  );
}

function isTempAccessSave(request) {
  return (
    request.method() === "PUT" &&
    request.url().includes("/events/temp-access/participant?")
  );
}

// The temporary page's lock notice, grid and controls.
async function expectTempLocked(tpage, message) {
  await expect(
    tpage.getByRole("status").filter({ hasText: message }),
  ).toHaveText(message);
  await expect(
    tpage.getByRole("grid", { name: "Availability" }),
  ).toHaveAttribute("aria-readonly", "true");
  await expect(
    tpage.getByRole("button", { name: /^(Submit|Update) availability$/ }),
  ).toBeDisabled();
  await expect(
    tpage.getByRole("button", { name: "Apply to all" }),
  ).toBeDisabled();
  await expect(
    tpage
      .getByRole("group", { name: "Availability status" })
      .getByRole("button", { name: "Available", exact: true }),
  ).toBeDisabled();
}

test.describe("Temporary access editor", () => {
  test("honours organizer blocks and the deadline, and the temp endpoint guards the email, the version and exclusion", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `temp-rules-org-${runId}@example.com`,
      "Tom",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Temporary rules ${runId}`,
      startingAvailability: "busy",
      blockedSlots: { "weekday:1": [0] },
      responseDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { code } = event;
    const blocked = slotIndex(event, "weekday:1", "09:00");
    const mon930 = slotIndex(event, "weekday:1", "09:30");
    const email = `temp-rules-tia-${runId}@example.com`;
    const { context, page: tpage } = await openTemporaryAccess(
      browser,
      request,
      token,
      event,
      email,
      "Tia Temporary",
    );
    const grid = tpage.getByRole("grid", { name: "Availability" });

    // The block is explained, listed and inert.
    await expect(
      tpage.getByRole("note").filter({
        hasText:
          "Grey striped times are blocked by the organizer and do not apply to this event.",
      }),
    ).toBeVisible();
    await expect(
      tpage
        .getByRole("list", { name: "Availability legend" })
        .getByRole("listitem"),
    ).toHaveText(["Blocked"]);
    const blockedCell = grid.locator(`[data-cell-idx="${blocked}"]`);
    await expect(blockedCell).toHaveAttribute("data-blocked", "true");
    await expect(blockedCell).toHaveAttribute("aria-disabled", "true");
    await expect(blockedCell).not.toHaveAttribute("tabindex");

    // A click on the block paints nothing: the next save, from an open cell,
    // still has the block at its Busy start.
    await expect(
      tpage
        .getByRole("group", { name: "Availability status" })
        .getByRole("button", { name: "Available", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await blockedCell.click({ force: true });
    const painted = tpage.waitForResponse((response) =>
      isTempAccessSave(response.request()),
    );
    await grid.locator(`[data-cell-idx="${mon930}"]`).click();
    const paint = (await painted).request().postDataJSON();
    expect(paint.availabilityInperson[blocked]).toBe(0);
    expect(paint.availabilityInperson[mon930]).toBe(1);

    // Apply to all leaves the block at 0.
    const filled = tpage.waitForResponse((response) =>
      isTempAccessSave(response.request()),
    );
    await tpage.getByRole("button", { name: "Apply to all" }).click();
    const fill = await filled;
    expect(fill.status()).toBe(200);
    const expected = Array.from({ length: event.slotCount }, (_, index) =>
      index === blocked ? 0 : 1,
    );
    expect(fill.request().postDataJSON().availabilityInperson).toEqual(
      expected,
    );
    const { participant } = await fill.json();
    expect(participant.availabilityInperson).toEqual(expected);
    await expect(
      tpage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();

    // The endpoint refuses an email change and a write without a version.
    for (const [what, body, status, errorCode, error] of [
      [
        "email",
        {
          availabilityInperson: expected,
          expectedVersion: participant.version,
          email: `temp-rules-new-${runId}@example.com`,
        },
        400,
        "participant_email_immutable",
        "Participant email cannot be changed.",
      ],
      [
        "contact email",
        { contactEmail: `temp-rules-new-${runId}@example.com` },
        400,
        "participant_email_immutable",
        "Participant email cannot be changed.",
      ],
      [
        "no version",
        { availabilityInperson: expected },
        428,
        "participant_version_required",
        "expectedVersion is required",
      ],
    ]) {
      const refused = await tempAccessPut(tpage, code, body);
      expect(refused.status, what).toBe(status);
      expect(refused.payload, what).toEqual({ error, errorCode });
    }

    // Left out of the results, the page locks with the server's reason.
    await setIncluded(request, code, token, email, false);
    await tpage
      .getByRole("group", { name: "Availability status" })
      .getByRole("button", { name: "Busy", exact: true })
      .click();
    const refusedSave = tpage.waitForResponse((response) =>
      isTempAccessSave(response.request()),
    );
    await grid.locator(`[data-cell-idx="${mon930}"]`).click();
    expect((await refusedSave).status()).toBe(403);
    await expectTempLocked(
      tpage,
      "Excluded participants cannot change availability",
    );
    // The local paint is replaced by the saved response.
    await expect(grid.locator(`[data-cell-idx="${mon930}"]`)).toHaveAttribute(
      "data-availability",
      "free",
    );
    const excluded = await tempAccessPut(tpage, code, {
      availabilityInperson: expected,
      expectedVersion: participant.version,
    });
    expect(excluded.status).toBe(403);
    expect(excluded.payload).toEqual({
      error: "Excluded participants cannot change availability",
      errorCode: "participant_excluded",
    });

    // Included again, a reload unlocks the page. Its clock is controlled
    // from that load on, so the deadline timer can be run forward.
    await setIncluded(request, code, token, email, true);
    await tpage.clock.install();
    await tpage.reload();
    await expect(grid).not.toHaveAttribute("aria-readonly");
    await expect(
      tpage.getByRole("button", { name: "Submit availability" }),
    ).toBeEnabled();
    await tpage.clock.fastForward("01:00:05");
    await expectTempLocked(tpage, "The response deadline has passed.");
    await context.close();
  });

  test("a temporary participant withdraws a submitted response by painting, the temp endpoint refuses writes while the event is closed, archived or past its deadline, and the page shows the confirmed meeting", async ({
    browser,
    request,
  }) => {
    const runId = newRunId();
    const organizer = await registerAccountViaApi(
      request,
      `temp-lock-org-${runId}@example.com`,
      "Tam",
      "Organizer",
    );
    const token = organizer.access;
    const event = await createEvent(request, token, {
      name: `Temporary locks ${runId}`,
    });
    const { code } = event;
    const email = `temp-lock-tia-${runId}@example.com`;
    const { context, page: tpage } = await openTemporaryAccess(
      browser,
      request,
      token,
      event,
      email,
      "Tia Locked",
    );
    const grid = tpage.getByRole("grid", { name: "Availability" });
    const invitationStatus = async () =>
      (
        await apiJson(request, "GET", `/events/invitations?code=${code}`, token)
      ).payload.invitations.find((entry) => entry.email === email).status;

    // Submitting marks the response Submitted; painting afterwards turns it
    // back into a draft, and the invitation follows.
    const submitSave = tpage.waitForResponse(
      (response) =>
        isTempAccessSave(response.request()) &&
        response.request().postDataJSON().submitted === 1,
    );
    await tpage.getByRole("button", { name: "Submit availability" }).click();
    expect((await submitSave).status()).toBe(200);
    await expect(tpage.getByText("Schedule submitted.")).toBeVisible();
    const yourSchedule = tpage.getByRole("region", { name: "Your schedule" });
    await expect(
      yourSchedule.getByText("Submitted", { exact: true }),
    ).toBeVisible();
    await expect(
      tpage.getByRole("button", { name: "Update availability" }),
    ).toBeEnabled();
    expect(await invitationStatus()).toBe("submitted");
    const withdrawSave = tpage.waitForResponse((response) =>
      isTempAccessSave(response.request()),
    );
    await grid.locator('[data-cell-idx="0"]').click();
    const withdrawn = await withdrawSave;
    expect(withdrawn.status()).toBe(200);
    expect(withdrawn.request().postDataJSON().submitted).toBe(0);
    expect((await withdrawn.json()).participant.submitted).toBe(0);
    await expect(
      tpage.getByText("Draft saved. Submit when you are ready."),
    ).toBeVisible();
    await expect(
      yourSchedule.getByText("Submitted", { exact: true }),
    ).toHaveCount(0);
    await expect(
      tpage.getByRole("button", { name: "Submit availability" }),
    ).toBeEnabled();
    expect(await invitationStatus()).toBe("draft_saved");
    const session = await tempAccessSessionState(tpage, code);
    expect(session.status).toBe(200);
    const write = () =>
      tempAccessPut(tpage, code, {
        availabilityInperson: Array(event.slotCount).fill(0),
        expectedVersion: session.payload.participant.version,
      });

    // Closed behind the page's back: the next save is refused, and the
    // page locks with the server's reason.
    await setLifecycleViaApi(request, token, code, "closed");
    const refusedSave = tpage.waitForResponse((response) =>
      isTempAccessSave(response.request()),
    );
    await grid.locator('[data-cell-idx="1"]').click();
    const refused = await refusedSave;
    expect(refused.status()).toBe(409);
    await expectTempLocked(
      tpage,
      "Responses cannot change while the event is closed.",
    );
    let locked = await write();
    expect(locked.status).toBe(409);
    expect(locked.payload).toEqual({
      error: "Responses cannot change while the event is closed.",
      errorCode: "event_responses_locked",
    });
    await tpage.reload();
    await expectTempLocked(
      tpage,
      "Responses are locked while this event is closed.",
    );
    await setLifecycleViaApi(request, token, code, "archived");
    locked = await write();
    expect(locked.status).toBe(409);
    expect(locked.payload).toEqual({
      error: "Responses cannot change while the event is archived.",
      errorCode: "event_responses_locked",
    });
    await tpage.reload();
    await expectTempLocked(
      tpage,
      "Responses are locked while this event is archived.",
    );

    // Active again, but past the deadline.
    await setLifecycleViaApi(request, token, code, "active");
    expireDeadline(code);
    const late = await write();
    expect(late.status).toBe(409);
    expect(late.payload).toEqual({
      error: "The response deadline has passed.",
      errorCode: "event_responses_locked",
    });
    await tpage.reload();
    await expectTempLocked(tpage, "The response deadline has passed.");

    // Finalized: the page lists the confirmed meeting.
    await updateEventViaApi(request, token, code, {
      responseDeadline: new Date(Date.now() + DAY_MS).toISOString(),
    });
    const meeting = await finalizeWithOneResponse(
      request,
      token,
      event,
      `temp-lock-ada-${runId}@example.com`,
    );
    await tpage.reload();
    await expectTempLocked(
      tpage,
      "Responses are locked while this event is finalized.",
    );
    await expect(detailItem(tpage, "Status")).toHaveText("Finalized");
    await expect(detailItem(tpage, "Final Start")).toHaveText(
      await browserDateTime(tpage, meeting.startsAt, "UTC"),
    );
    await expect(detailItem(tpage, "Final End")).toHaveText(
      await browserDateTime(tpage, meeting.endsAt, "UTC"),
    );
    await expect(detailItem(tpage, "Final Method")).toHaveText(
      "In-Person · Board Room",
    );
    await context.close();
  });
});
