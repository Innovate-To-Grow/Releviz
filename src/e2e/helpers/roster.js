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

// Seeding, API reads and locators for the organizer roster (RosterPanel,
// RosterGroups, RosterImportWizard, RosterPersonDialog).

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Registers one organizer (one email round trip) and creates an API event.
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

async function gotoRoster(page, event) {
  await page.goto(`/event?code=${event.code}`);
  await expect(
    page.getByRole("heading", { level: 2, name: event.name }),
  ).toBeVisible();
  await expect(page.getByLabel("Roster summary")).toBeVisible();
}

// Tab-separated rows, so ";" or "," inside a group cell never changes the
// delimiter the import sniffs.
function tsv(rows) {
  return rows.map((row) => row.join("\t")).join("\n");
}

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

// Every roster entry keyed by its lower-cased email.
async function rosterByEmail(request, eventCode, token) {
  const payload = await rosterEntries(request, eventCode, token);
  return new Map(
    payload.participants.map((entry) => [
      String(entry.email || "").toLowerCase(),
      entry,
    ]),
  );
}

// Adds one person the way the Add person form does. The API sends an
// invitation unless told otherwise, so `sendInvitation` is always explicit.
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

// Submits an all-available response on behalf of a roster entry.
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

async function sendInvitationsApi(
  request,
  eventCode,
  token,
  participantIds,
  { resend = false } = {},
) {
  const sent = await apiJson(
    request,
    "POST",
    `/events/roster/invitations?code=${eventCode}`,
    token,
    { participantIds, resend, idempotencyKey: crypto.randomUUID() },
  );
  expect(sent.response.status(), JSON.stringify(sent.payload)).toBe(202);
  return sent.payload;
}

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

// A roster table row by its exact display name, so "Person 1" never matches
// "Person 10".
function rosterRow(page, name) {
  return page
    .locator("tr.roster-table__row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

function groupRow(page, name) {
  return page
    .getByRole("region", { name: "Roster groups" })
    .locator(`[data-roster-group="${name === "" ? "__ungrouped__" : name}"]`);
}

function rosterStatus(page) {
  return page.locator(".roster-panel__message--status");
}

// The summary spans have no separator, so the whole text is matched at once:
// a substring check for "0 groups" would also match "10 groups".
async function expectRosterSummary(
  page,
  { people, submitted, awaiting, groups },
) {
  const noun = (count, one, many) => (count === 1 ? one : many);
  await expect(page.getByLabel("Roster summary")).toHaveText(
    new RegExp(
      `^\\s*${people} ${noun(people, "person", "people")}\\s*${submitted} submitted\\s*${awaiting} awaiting response\\s*${groups} ${noun(groups, "group", "groups")}\\s*$`,
    ),
  );
}

async function openBulkActions(page) {
  const bulk = page.locator('details[aria-label="Bulk roster actions"]');
  if ((await bulk.getAttribute("open")) === null) {
    await bulk.locator("summary").click();
  }
  await expect(bulk).toHaveAttribute("open", "");
  return bulk;
}

// Holds every live-sync digest request so the roster cannot silently reload
// during a version-conflict check. Resolves once a poll is held (any earlier
// poll has finished by then) and returns a release function.
async function freezeLiveSync(page) {
  const held = [];
  const pattern = /\/events\/activity\?/;
  const handler = (route) => {
    held.push(route);
  };
  await page.route(pattern, handler);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => held.length, { timeout: 20_000 }).toBeGreaterThan(0);
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

async function openImportWizard(page) {
  await page
    .getByRole("button", { name: "Import roster", exact: true })
    .click();
  const wizard = page.getByRole("region", { name: "Import roster" });
  await expect(wizard).toBeVisible();
  return wizard;
}

async function pasteRosterSource(page, wizard, text) {
  await wizard.getByRole("tab", { name: "Paste spreadsheet" }).click();
  await wizard.getByLabel("Pasted roster rows").fill(text);
  await wizard.getByRole("button", { name: "Continue to mapping" }).click();
  await expect(
    page.getByText("Choose a worksheet and map its columns."),
  ).toBeVisible();
}

async function uploadRosterFile(wizard, file) {
  await wizard.getByLabel("CSV or XLSX file").setInputFiles(file);
}

async function previewImportRows(wizard) {
  await wizard.getByRole("button", { name: "Preview rows" }).click();
  await expect(
    wizard.getByRole("region", { name: "Imported rows awaiting review" }),
  ).toBeVisible();
}

// The value of an import summary tile; the anchored label keeps "Valid" from
// matching "Invalid".
function importTile(page, wizard, label) {
  return wizard
    .locator(".metric-tile")
    .filter({
      has: page.locator(".metric-tile__label", {
        hasText: new RegExp(`^${label}$`),
      }),
    })
    .locator(".metric-tile__value");
}

function importRow(page, wizard, rowNumber) {
  return wizard
    .getByRole("region", { name: "Imported rows awaiting review" })
    .getByRole("row")
    .filter({
      has: page.getByLabel(`Name for row ${rowNumber}`, { exact: true }),
    });
}

function mappingSelect(wizard, label) {
  return wizard.getByRole("combobox", { name: label, exact: true });
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
// no binary fixture is committed. Cells must not start with "=".
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
  XLSX_MIME,
  addPersonApi,
  csvBuffer,
  expectRosterSummary,
  freezeLiveSync,
  gotoRoster,
  groupRow,
  importRow,
  importTile,
  invitationEmail,
  invitationJobCount,
  mappingSelect,
  openBulkActions,
  openImportWizard,
  pasteRosterSource,
  previewImportRows,
  requestRecorder,
  rosterByEmail,
  rosterEntries,
  rosterRow,
  rosterStatus,
  sendInvitationsApi,
  startOrganizerEvent,
  submitOnBehalf,
  tsv,
  uploadRosterFile,
  waitForInvitationStatus,
  xlsxBuffer,
};
