const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { expect } = require("@playwright/test");
const {
  PYTHON_BIN,
  ROOT,
  apiJson,
  createEvent,
  newRunId,
  readSession,
  registerAccount,
  runDjangoJson,
} = require("./releviz");

// The organizer's Participants section (one list, the person and add panels,
// the selection bar, the import sheet, and the two-step email dialog every
// send goes through), plus API seeding and reads for the people on an event
// and runtime CSV/XLSX fixtures for imports.

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The workspace and its delivery card keep themselves current on their own
// (changes pushed over the event stream, with polling as the fallback), so a
// wait for a change they pick up needs more than the default expect timeout.
const LIVE_SYNC_TIMEOUT_MS = 20_000;

// The Participants section's counts line under its heading.
function participantSummary(page) {
  return page.locator("#organizer-roster .panel__description");
}

// The section's header actions (Email, Import, + Add person). The empty
// state repeats some of these names, so the header is addressed on its own.
function participantActions(page) {
  return page.getByRole("group", { name: "Participant actions" });
}

function participantRow(page, text) {
  return page.locator("tr.participants-row", { hasText: text });
}

// Waits for a toast in the Participants section, then dismisses it so a
// later toast with the same words is the only match. Toasts sit under an
// open drawer or dialog, so the close is dispatched rather than clicked.
async function expectToast(page, text) {
  const toast = page
    .getByRole("region", { name: "Notifications" })
    .locator(".participants-toast", { hasText: text });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss" }).dispatchEvent("click");
  await expect(toast).toHaveCount(0);
}

// One line of the email preview's envelope (From, To, Subject, Attachments).
function emailField(dialog, term) {
  return dialog
    .locator(".email-preview__field")
    .filter({
      has: dialog.page().locator("dt").getByText(term, { exact: true }),
    })
    .locator("dd");
}

// Every email the organizer sends goes through one two-step dialog. Step 1
// (Review) says who gets it and shows the email the first of them receives:
// the envelope, the HTML part in a sandboxed frame (no scripts, inert
// links), and the plain-text part, both with a stand-in for that person's
// private link. `expected` lists the summary lines, the envelope, the
// rendered email's heading and call-to-action link, and text in the
// plain-text part. Nothing has been sent at this point. Returns the envelope
// as shown, to compare with the email that is delivered later.
async function reviewEmail(dialog, expected) {
  await expect(dialog.getByText("Step 1 of 2: Review")).toBeVisible();
  await expect(
    dialog.getByText("Check what people will receive before anything is sent."),
  ).toBeVisible();
  for (const line of expected.summary || []) {
    await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  }
  await expect(emailField(dialog, "From")).not.toBeEmpty();
  await expect(emailField(dialog, "To")).toContainText(expected.to);
  await expect(emailField(dialog, "Subject")).toHaveText(expected.subject);
  if (expected.attachments) {
    await expect(emailField(dialog, "Attachments")).toHaveText(
      expected.attachments,
    );
  }
  const frame = dialog.locator('iframe[title="Email preview"]');
  await expect(frame).toHaveAttribute("sandbox", "");
  const rendered = frame.contentFrame();
  await expect(
    rendered.getByRole("heading", { name: expected.heading }),
  ).toBeVisible();
  if (expected.link) {
    const link = rendered.getByRole("link", {
      name: expected.link.name,
      exact: true,
    });
    await expect(link).toHaveAttribute("href", expected.link.href);
  }
  await dialog.getByRole("tab", { name: "Plain text" }).click();
  const plainText = dialog.locator(".email-preview__text");
  await expect(plainText).toBeVisible();
  for (const part of expected.text || []) {
    await expect(plainText).toContainText(part);
  }
  await dialog.getByRole("tab", { name: "Email", exact: true }).click();
  await expect(frame).toBeVisible();
  return {
    from: (await emailField(dialog, "From").textContent()).trim(),
    to: (await emailField(dialog, "To").textContent()).trim(),
    subject: (await emailField(dialog, "Subject").textContent()).trim(),
    text: await plainText.textContent(),
  };
}

// The line of an email's plain-text part that starts with `label`.
function textLine(text, label) {
  return text.split(/\r?\n/).find((line) => line.startsWith(label)) || null;
}

// Step 2 (Confirm) of the email dialog: Continue moves focus to the
// confirmation question, so a second Enter can't send by accident. Returns
// the send button, which the caller clicks once it is ready to see the
// request.
async function continueToConfirm(dialog, question, sendLabel) {
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByText("Step 2 of 2: Confirm")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: question })).toBeFocused();
  const send = dialog.getByRole("button", { name: sendLabel, exact: true });
  await expect(send).toBeEnabled();
  return send;
}

// A header of a delivered email, with folded lines joined.
function emailHeader(message, name) {
  const prefix = `${name.toLowerCase()}:`;
  const line = message
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .find((entry) => entry.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

// The preview showed what the recipient got: the delivered email has the
// same sender and subject, and goes to the address the preview named (shown
// as `Name <address>` when the person's name is known).
function expectDeliveredAsPreviewed(message, envelope, recipient) {
  expect(emailHeader(message, "From")).toBe(envelope.from);
  expect(emailHeader(message, "Subject")).toBe(envelope.subject);
  expect(emailHeader(message, "To")).toBe(recipient);
  const shownAddress = envelope.to.includes("<")
    ? envelope.to.slice(envelope.to.indexOf("<") + 1, -1)
    : envelope.to;
  expect(shownAddress).toBe(recipient);
}

async function openAddPanel(page) {
  await participantActions(page)
    .getByRole("button", { name: "+ Add person" })
    .click();
  const panel = page.getByRole("dialog", { name: "Add a person" });
  await expect(panel).toBeVisible();
  return panel;
}

// Adds one person from the open add panel without inviting them. The panel
// stays open, cleared for the next person.
async function addPerson(panel, name, email) {
  await panel.getByRole("textbox", { name: "Full name" }).fill(name);
  await panel.getByRole("textbox", { name: "Email" }).fill(email);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    panel.getByText(`${name} was added. No invitation was sent.`),
  ).toBeVisible();
}

// The row's name opens the person panel.
async function openPersonPanel(page, name) {
  await participantRow(page, name)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  const panel = page.getByRole("dialog", { name, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

// Registers one organizer through the UI (one email round trip) and creates
// an API event named after `label`.
async function startOrganizerEvent({ page, request }, label, overrides = {}) {
  const runId = newRunId();
  const organizerEmail = `${label}-${runId}@example.com`;
  await registerAccount(page, organizerEmail, "Rory", "Roster");
  const token = (await readSession(page)).access;
  const event = await createEvent(request, token, {
    name: `${label} ${runId}`,
    ...overrides,
  });
  return {
    runId,
    organizerEmail,
    organizerName: "Rory Roster",
    token,
    event,
  };
}

// Opens the organizer workspace and waits for the Participants section.
async function gotoParticipants(page, event) {
  await page.goto(`/event?code=${event.code}`);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
  await expect(participantSummary(page)).toBeVisible();
}

// The import sheet walks through Source, Columns, Review and Done; this is
// the step it is on.
function importStep(sheet) {
  return sheet.locator('ol[aria-label="Import steps"] [aria-current="step"]');
}

async function openImportSheet(page) {
  await participantActions(page)
    .getByRole("button", { name: "Import", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Import participants" });
  await expect(sheet).toBeVisible();
  await expect(importStep(sheet)).toHaveText("Source");
  return sheet;
}

// Pastes spreadsheet rows on the Source step and continues to Columns.
async function pasteParticipantRows(sheet, text) {
  await sheet.getByRole("tab", { name: "Paste from a spreadsheet" }).click();
  await sheet.getByLabel("Pasted participant rows").fill(text);
  await sheet.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(importStep(sheet)).toHaveText("Columns");
}

// Chooses a CSV or XLSX file on the Source step and continues to Columns.
// `file` is a path or a Playwright file payload ({ name, mimeType, buffer }).
async function uploadParticipantFile(sheet, file) {
  await sheet.getByRole("tab", { name: "Upload a file" }).click();
  await sheet.getByLabel("CSV or XLSX file").setInputFiles(file);
  await sheet.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(importStep(sheet)).toHaveText("Columns");
}

// The Columns step's select for one field (Name, Email, Group, ...).
function importColumnSelect(sheet, field) {
  return sheet.getByRole("combobox", {
    name: `Column for ${field}`,
    exact: true,
  });
}

// Validates the mapped rows and waits for the Review step's row table.
async function previewImportRows(sheet) {
  await sheet.getByRole("button", { name: "Preview rows" }).click();
  await expect(importStep(sheet)).toHaveText("Review");
  await expect(
    sheet.getByRole("region", { name: "Imported rows awaiting review" }),
  ).toBeVisible();
}

// One row of the Review step's table, by its spreadsheet row number (the
// header is row 1, so the first person is row 2).
function importRow(sheet, rowNumber) {
  return sheet
    .getByRole("region", { name: "Imported rows awaiting review" })
    .getByRole("row")
    .filter({
      has: sheet
        .page()
        .getByLabel(`Name for row ${rowNumber}`, { exact: true }),
    });
}

// Tab-separated rows, so ";" or "," inside a group cell never changes the
// delimiter the import sniffs.
function tsv(rows) {
  return rows.map((row) => row.join("\t")).join("\n");
}

// One page (up to 100 people) of the organizer's participant listing, with
// `query` as extra listing filters (search, group, submitted, included,
// invitationStatus, accountAccess, page, pageSize).
async function rosterEntries(request, eventCode, token, query = {}) {
  const params = new URLSearchParams({
    code: eventCode,
    pageSize: "100",
    ...query,
  });
  const roster = await apiJson(
    request,
    "GET",
    `/events/roster?${params}`,
    token,
  );
  expect(roster.response.status()).toBe(200);
  return roster.payload;
}

// Every listed participant keyed by their lower-cased email (people without
// one share the "" key, so only the last of them is kept).
async function rosterByEmail(request, eventCode, token) {
  const payload = await rosterEntries(request, eventCode, token);
  return new Map(
    payload.participants.map((entry) => [
      String(entry.email || "").toLowerCase(),
      entry,
    ]),
  );
}

// Adds one person the way the add panel does. The API sends an invitation
// unless told otherwise, so `sendInvitation` is always explicit here.
async function addPersonApi(
  request,
  eventCode,
  token,
  {
    name,
    email = "",
    phone = "",
    organizerManaged = false,
    sendInvitation = false,
  },
) {
  const created = await apiJson(
    request,
    "POST",
    `/events/participants/managed?code=${eventCode}`,
    token,
    {
      name,
      email,
      phone,
      organizerManaged,
      sendInvitation,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect([200, 201], JSON.stringify(created.payload)).toContain(
    created.response.status(),
  );
  return created.payload;
}

// Submits an all-available response on behalf of a listed participant (an
// entry from rosterEntries / rosterByEmail).
async function submitOnBehalf(request, token, event, entry) {
  const schedule = await apiJson(
    request,
    "GET",
    `/events/roster/${entry.id}/schedule?code=${event.code}`,
    token,
  );
  expect(schedule.response.status()).toBe(200);
  const version =
    schedule.payload.schedule?.version ?? schedule.payload.participant?.version;
  const allOnes = Array(event.slotCount).fill(1);
  const updated = await apiJson(
    request,
    "PUT",
    `/events/participants/update?code=${event.code}&participantId=${entry.memberId}`,
    token,
    {
      availabilityInperson: allOnes,
      availabilityVirtual: allOnes,
      submitted: 1,
      expectedVersion: version,
    },
  );
  expect(updated.response.status(), JSON.stringify(updated.payload)).toBe(200);
}

// Sends (or with `preview`, only reviews) invitations through the API.
// `selection` is an array of participant ids (roster ids or member UUIDs),
// or a listing filter object such as `{ all: true }` or
// `{ invitationStatus: "not_sent" }`. A send answers 202 with
// `{ deliveryRequest, requestedCount, queuedCount, skippedCount, willSend,
// skipped: { alreadyInvited, noEmail, organizer, inFlight }, idempotent }`;
// a preview answers 200 with `{ preview, requestedCount, willSend, skipped,
// email, ... }` and sends nothing.
async function sendInvitationsApi(
  request,
  eventCode,
  token,
  selection,
  { resend = false, preview = false } = {},
) {
  const target = Array.isArray(selection)
    ? { participantIds: selection }
    : { filter: selection };
  const sent = await apiJson(
    request,
    "POST",
    `/events/roster/invitations?code=${eventCode}`,
    token,
    preview
      ? { ...target, resend, preview: true }
      : { ...target, resend, idempotencyKey: crypto.randomUUID() },
  );
  expect(sent.response.status(), JSON.stringify(sent.payload)).toBe(
    preview ? 200 : 202,
  );
  return sent.payload;
}

// Waits for a person's invitationStatus in the listing ("not_sent", "sent"
// once the email worker has sent it, "accepted").
async function waitForInvitationStatus(
  request,
  eventCode,
  token,
  email,
  status,
) {
  await expect
    .poll(
      async () =>
        (await rosterByEmail(request, eventCode, token)).get(
          email.toLowerCase(),
        )?.invitationStatus,
      { timeout: 20_000 },
    )
    .toBe(status);
}

// A latestEmailFor predicate for this event's temporary-access invitation.
function invitationEmail(eventCode) {
  return (body) =>
    body.includes("Share your availability") &&
    body.includes(`/temp-access?code=${eventCode}`);
}

// How many invitation email jobs this event has queued for `email`.
function invitationJobCount(eventCode, email) {
  return runDjangoJson(
    `
from apps.mail.models import EmailDeliveryJob

print(json.dumps(EmailDeliveryJob.objects.filter(
    event__code=data["code"],
    message_type="invitation",
    recipient__iexact=data["email"],
).count()))
`,
    { code: eventCode, email },
  );
}

// Holds the workspace's live sync so the participant list cannot silently
// reload, e.g. during a version-conflict check. Every live-sync pass reads
// the activity digest first, so a held digest request stalls the pass (and
// any pass pushed after it waits behind it); a new event stream is held too,
// so a reconnect cannot bring in a fresh one. A stream that was already
// open stays open. Resolves once a digest request is held (any earlier pass
// has finished by then) and returns the function that releases everything.
async function freezeLiveSync(page) {
  const held = [];
  const pattern = /\/events\/(?:stream|activity)\?/;
  const handler = (route) => {
    held.push(route);
  };
  await page.route(pattern, handler);
  const heldDigests = () =>
    held.filter((route) => route.request().url().includes("/events/activity?"))
      .length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(heldDigests, { timeout: 20_000 }).toBeGreaterThan(0);
  return async () => {
    await page.unroute(pattern, handler);
    for (const route of held) await route.continue().catch(() => {});
  };
}

// Records `${method} ${url}` for matching requests, to prove an action sent
// nothing.
function requestRecorder(page, predicate) {
  const entries = [];
  page.on("request", (request) => {
    if (predicate(request))
      entries.push(`${request.method()} ${request.url()}`);
  });
  return {
    entries,
    clear() {
      entries.length = 0;
    },
  };
}

function csvBuffer(text, { bom = false } = {}) {
  return Buffer.from(`${bom ? "﻿" : ""}${text}`, "utf8");
}

const XLSX_SCRIPT = `
import base64
import io
import json
import sys

from openpyxl import Workbook

workbook = Workbook()
workbook.remove(workbook.active)
for sheet in json.loads(sys.argv[1]):
    worksheet = workbook.create_sheet(sheet["name"])
    for row in sheet["rows"]:
        worksheet.append(row)
buffer = io.BytesIO()
workbook.save(buffer)
sys.stdout.write(base64.b64encode(buffer.getvalue()).decode("ascii"))
`;

// Builds an XLSX workbook at runtime (openpyxl is a backend dependency), so
// no binary fixture is committed. `sheets` is `[{ name, rows: [[...]] }]`.
// Cells must not start with "=".
function xlsxBuffer(sheets) {
  const encoded = execFileSync(
    PYTHON_BIN,
    ["-c", XLSX_SCRIPT, JSON.stringify(sheets)],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src/api") },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return Buffer.from(encoded.trim(), "base64");
}

module.exports = {
  LIVE_SYNC_TIMEOUT_MS,
  XLSX_MIME,
  addPerson,
  addPersonApi,
  continueToConfirm,
  csvBuffer,
  emailField,
  emailHeader,
  expectDeliveredAsPreviewed,
  expectToast,
  freezeLiveSync,
  gotoParticipants,
  importColumnSelect,
  importRow,
  importStep,
  invitationEmail,
  invitationJobCount,
  openAddPanel,
  openImportSheet,
  openPersonPanel,
  participantActions,
  participantRow,
  participantSummary,
  pasteParticipantRows,
  previewImportRows,
  requestRecorder,
  reviewEmail,
  rosterByEmail,
  rosterEntries,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  textLine,
  tsv,
  uploadParticipantFile,
  waitForInvitationStatus,
  xlsxBuffer,
};
