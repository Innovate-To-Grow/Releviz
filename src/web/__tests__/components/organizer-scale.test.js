/**
 * @jest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useState } from "react";

jest.mock("@/components/auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@/components/event/CreateEventClient", () => ({
  __esModule: true,
  default: ({ initialEvent, onSaved, onCancel }) => (
    <div>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        onClick={() =>
          onSaved({
            event: {
              ...initialEvent,
              name: "Updated workspace event",
              version: initialEvent.version + 1,
            },
            responsesReset: 0,
          })
        }
      >
        Save changes
      </button>
      <button
        type="button"
        onClick={() =>
          onSaved({
            event: { ...initialEvent, version: initialEvent.version + 1 },
            responsesReset: 2,
          })
        }
      >
        Save and reset responses
      </button>
    </div>
  ),
}));
jest.mock("@/components/schedule/OrganizerPanels", () => ({
  OrganizerHeader: ({ event, controls, live }) => (
    <header>
      <h2>{event.name}</h2>
      <span data-testid="organizer-header-event-status">{event.status}</span>
      {live && (
        <p data-testid="live-sync" data-updated={live.updatedAt ? "yes" : "no"}>
          {live.error || "Live"}
        </p>
      )}
      <div role="group" aria-label="Workspace actions">
        {controls}
      </div>
    </header>
  ),
  ManagedScheduleDrawer: () => null,
}));
jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  downloadFinalCalendar: jest.fn(),
  fetchDeliveryRequest: jest.fn(),
  fetchEvent: jest.fn(),
  fetchEventActivity: jest.fn(),
  fetchEventResults: jest.fn(),
  openEventStream: jest.fn(),
  previewDeliveryRetry: jest.fn(),
  previewEventLifecycle: jest.fn(),
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
  updateEvent: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));
jest.mock("@/lib/api/participants", () => ({
  createManagedParticipant: jest.fn(),
  updateParticipant: jest.fn(),
}));
jest.mock("@/lib/api/roster", () => ({
  cancelRosterImport: jest.fn(),
  commitRosterImport: jest.fn(),
  configureRosterImport: jest.fn(),
  createRosterGroup: jest.fn(),
  createRosterImport: jest.fn(),
  deleteRosterGroup: jest.fn(),
  fetchRoster: jest.fn(),
  fetchRosterGroups: jest.fn(),
  fetchRosterImportRows: jest.fn(),
  fetchRosterSchedule: jest.fn(),
  patchRosterBulk: jest.fn(),
  patchRosterParticipant: jest.fn(),
  renameRosterGroup: jest.fn(),
  sendRosterInvitations: jest.fn(),
}));
jest.mock("@/lib/liveStream", () => ({ connectLiveStream: jest.fn() }));

import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import OrganizerScaleView from "@/components/schedule/OrganizerScaleView";
import {
  LIVE_REFRESH_BACKSTOP_PACE,
  LIVE_REFRESH_FASTEST_MS,
  LIVE_REFRESH_IDLE_PACE,
} from "@/lib/liveRefresh";
import { connectLiveStream } from "@/lib/liveStream";
import {
  confirmFinalMeeting,
  fetchDeliveryRequest,
  fetchEvent,
  fetchEventActivity,
  fetchEventResults,
  openEventStream,
  previewEventLifecycle,
  previewFinalMeeting,
  sendReminders,
  updateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { createManagedParticipant } from "@/lib/api/participants";
import {
  commitRosterImport,
  configureRosterImport,
  createRosterImport,
  fetchRoster,
  fetchRosterImportRows,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
  sendRosterInvitations,
} from "@/lib/api/roster";

// The event streams the workspace opened in the current test, oldest
// first: the fake connection records the handlers it was given so a test
// can push the server's frames, and its `close` is a spy. Nothing is pushed
// unless a test does it, so the workspace polls as it would without a
// server that streams.
let streams = [];

const organizer = { id: "organizer-1", displayName: "Organizer" };
const event = {
  code: "BIG1000",
  name: "Campus scheduling",
  organizerUserId: organizer.id,
  status: "active",
  version: 2,
  accessMode: "invite_only",
  meetingDurationMinutes: 60,
  resultsRevision: 3,
  slotMinutes: 30,
  slotCount: 2,
  mode: "mixed",
  timezone: "UTC",
  location: "Room 1",
  blockedSlots: {},
  slotGroups: [
    {
      key: "2026-08-20",
      slots: [
        {
          index: 0,
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T09:30:00Z",
        },
        {
          index: 1,
          startsAt: "2026-08-20T09:30:00Z",
          endsAt: "2026-08-20T10:00:00Z",
        },
      ],
    },
  ],
};

// The digest that matches the default roster, results, and event mocks, so
// a live-sync pass finds nothing to reload unless a test moves a section.
const rosterActivity = {
  total: 1,
  submitted: 0,
  changedAt: "2026-08-20T07:00:00Z",
};
// The default listing: one temporary participant in Faculty, nobody invited
// yet, and the whole-list counts the header and the Email menu read.
function rosterListing(extra = {}) {
  return {
    participants: [
      {
        id: "roster-1",
        memberId: "member-1",
        name: "Ada Faculty",
        email: "ada@example.com",
        group: "Faculty",
        groups: [{ id: 11, name: "Faculty" }],
        allGroups: false,
        weight: 0.8,
        included: true,
        submitted: false,
        accountAccess: "temporary",
        canOrganizerEditAvailability: true,
        invitationStatus: "not_sent",
        version: 1,
      },
    ],
    pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
    stats: {
      total: 1,
      submitted: 0,
      notSubmitted: 1,
      included: 1,
      excluded: 0,
      groups: [
        { id: 11, name: "Faculty", count: 1, weight: 0.8, included: true },
      ],
    },
    overall: {
      total: 1,
      submitted: 0,
      notSubmitted: 1,
      included: 1,
      excluded: 0,
      notInvited: 1,
      sending: 0,
      failed: 0,
      noEmail: 0,
      remindable: 1,
    },
    activity: rosterActivity,
    ...extra,
  };
}

const baseActivity = {
  event: { version: 2, status: "active", resultsRevision: 3 },
  results: {
    status: "fresh",
    requestedRevision: 3,
    computedRevision: 3,
    generatedAt: "2026-08-20T08:00:00Z",
  },
  roster: rosterActivity,
};

function activityWith({ event: eventPart, results, roster } = {}) {
  return {
    event: { ...baseActivity.event, ...eventPart },
    results: { ...baseActivity.results, ...results },
    roster: { ...baseActivity.roster, ...roster },
  };
}

const rosterImportRecord = {
  id: "import-1",
  status: "preview",
  sourceType: "paste",
  worksheets: [
    {
      name: "Pasted data",
      rowCount: 1,
      columnCount: 2,
      headers: ["name", "email"],
    },
  ],
  selectedWorksheet: "Pasted data",
  headerRow: 1,
  headers: ["name", "email"],
  // The server suggests the mapping from the headers on create.
  columnMapping: { name: 0, email: 1 },
  defaults: { weight: 1, included: true },
  summary: { total: 1, selected: 1, valid: 1, invalid: 0, conflicts: 0 },
};

function mockRosterImportPreview() {
  createRosterImport.mockResolvedValue({ import: rosterImportRecord });
  configureRosterImport.mockResolvedValue({ import: rosterImportRecord });
  fetchRosterImportRows.mockResolvedValue({
    import: rosterImportRecord,
    rows: [
      {
        id: "row-1",
        rowNumber: 2,
        name: "Ada",
        email: "ada@example.com",
        group: "",
        weight: 1,
        included: true,
        selected: true,
        valid: true,
        duplicate: "unique",
        errors: [],
      },
    ],
    pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
  });
}

async function openPastedRosterPreview() {
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
  await userEvent.click(
    screen.getByRole("tab", { name: "Paste from a spreadsheet" }),
  );
  fireEvent.change(screen.getByLabelText("Pasted participant rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview rows" }),
  );
  expect(
    await screen.findByDisplayValue("ada@example.com"),
  ).toBeInTheDocument();
}

function renderView(setEvent = jest.fn(), currentEvent = event) {
  return {
    setEvent,
    ...render(
      <EventContext.Provider
        value={{ event: currentEvent, setEvent, numSlots: 2 }}
      >
        <OrganizerScaleView />
      </EventContext.Provider>,
    ),
  };
}

// Stores the event like the page does, so lifecycle and finalization
// responses re-render the whole workspace.
function StatefulWorkspace({ initialEvent }) {
  const [currentEvent, setEvent] = useState(initialEvent);
  return (
    <EventContext.Provider
      value={{ event: currentEvent, setEvent, numSlots: 2 }}
    >
      <OrganizerScaleView />
    </EventContext.Provider>
  );
}

// Four 30-minute slots on one date; a 60-minute meeting spans two of them.
const calendarEvent = {
  ...event,
  slotCount: 4,
  meetingDurationMinutes: 60,
  slotGroups: [
    {
      key: "date:2026-08-20",
      label: "2026-08-20",
      date: "2026-08-20",
      slots: [
        ["09:00", "09:30"],
        ["09:30", "10:00"],
        ["10:00", "10:30"],
        ["10:30", "11:00"],
      ].map(([localStart, localEnd], index) => ({
        index,
        localStart,
        localEnd,
        startDayOffset: 0,
        endDayOffset: 0,
        startsAt: `2026-08-20T${localStart}:00Z`,
        endsAt: `2026-08-20T${localEnd}:00Z`,
      })),
    },
  ],
};

// Results, review, and confirmation replies for picking slots 1-2 of
// `calendarEvent` on the calendar and finalizing them.
function mockCalendarWindowFlow() {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 3,
    computedRevision: 3,
    generatedAt: "2026-08-01T00:00:00Z",
    results: {
      countedResponseTotal: 4,
      channels: {
        inperson: {
          weighted: [0.75, 0.5, 1, 0.25],
          unweighted: [0.7, 0.6, 0.9, 0.3],
        },
      },
      recommendations: [],
    },
  });
  previewFinalMeeting.mockResolvedValue({
    attendance: {
      availableParticipantTotal: 2,
      partialParticipantTotal: 1,
      unavailableParticipantTotal: 1,
      unansweredParticipantTotal: 0,
      excludedParticipantTotal: 0,
    },
    recipientCount: 0,
    email: null,
    sample: null,
  });
  confirmFinalMeeting.mockResolvedValue({
    event: {
      ...calendarEvent,
      status: "finalized",
      version: 3,
      finalMeeting: {
        startsAt: "2026-08-20T09:30:00Z",
        endsAt: "2026-08-20T10:30:00Z",
        channel: "inperson",
        location: "Room 1",
      },
    },
    finalMeeting: { attendance: { availableParticipantTotal: 2 } },
    deliveryRequest: null,
  });
}

// The Time Table's blocked-times editor also renders `data-cell-idx` cells,
// so calendar cells are looked up inside the meeting calendar's grid.
// The recommended times sit inside the Finalize step: open Finalize first
// when it is closed, then toggle the list through its own summary.
async function toggleRecommendedTimes() {
  const finalize = document.getElementById("organizer-finalize");
  if (!finalize.open)
    await userEvent.click(finalize.querySelector(":scope > summary"));
  await userEvent.click(
    document.querySelector("#organizer-recommended-times > summary"),
  );
}

function calendarCell(index) {
  return screen
    .getByRole("grid", { name: /^Meeting time calendar/ })
    .querySelector(`[data-cell-idx="${index}"]`);
}

// Finalizes through the email review: Finalize meeting opens it, Continue
// reaches the second confirmation, and `sendLabel` confirms.
async function finalizeThroughReview(sendLabel = "Finalize meeting") {
  // The attendance is read as soon as a time is picked; Finalize waits for it.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Finalize meeting" }),
    ).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Finalize meeting" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "Finalize meeting",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "Continue" }),
  );
  await userEvent.click(
    within(review).getByRole("button", { name: sendLabel }),
  );
}

// Opens the Add a person side panel from the Participants header.
async function openAddPersonPanel() {
  await screen.findByText("Ada Faculty");
  const rosterSection = document.getElementById("organizer-roster");
  await userEvent.click(
    within(rosterSection).getByRole("button", { name: "+ Add person" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Add a person" });
  return {
    section: rosterSection,
    dialog,
    name: within(dialog).getByRole("textbox", { name: /^Full name/ }),
    email: within(dialog).getByRole("textbox", { name: /^Email/ }),
    submit: within(dialog).getByRole("button", { name: "Add" }),
    send: within(dialog).getByRole("button", {
      name: "Add and send invitation",
    }),
  };
}

describe("scaled organizer workspace", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    streams = [];
    connectLiveStream.mockImplementation((handlers) => {
      const stream = { handlers, close: jest.fn() };
      streams.push(stream);
      return stream;
    });
    window.history.replaceState({}, "", "/event?code=BIG1000");
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.matchMedia = jest.fn().mockReturnValue({ matches: false });
    HTMLElement.prototype.scrollIntoView = jest.fn();
    global.IntersectionObserver = class IntersectionObserver {
      constructor(callback) {
        this.callback = callback;
      }

      observe(target) {
        this.callback([{ isIntersecting: true, target }]);
      }

      unobserve() {}

      disconnect() {}
    };
    useAuth.mockReturnValue({
      user: organizer,
      loading: false,
      getToken: jest.fn().mockResolvedValue("token"),
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("request-key") },
    });
    fetchRoster.mockResolvedValue(rosterListing());
    fetchEventActivity.mockResolvedValue(baseActivity);
    patchRosterParticipant.mockResolvedValue({
      participant: { id: "roster-1", included: false, version: 2 },
      resultsRevision: 4,
    });
    patchRosterBulk.mockResolvedValue({
      updatedCount: 1,
      matchedCount: 1,
      resultsRevision: 4,
    });
    // Only Ada's schedule is known; asking for anyone else (the add panel
    // looking up a person the listing does not show) fails.
    fetchRosterSchedule.mockImplementation((_code, participantId) =>
      participantId === "roster-1" || participantId === "member-1"
        ? Promise.resolve({
            participant: {
              id: "roster-1",
              memberId: "member-1",
              name: "Ada Faculty",
              accountAccess: "temporary",
              version: 1,
            },
            schedule: {
              availabilityInperson: [0, 1],
              availabilityVirtual: [1, 0],
              submitted: false,
              version: 1,
            },
          })
        : Promise.reject(
            Object.assign(new Error("Participant not found"), { status: 404 }),
          ),
    );
    createManagedParticipant.mockResolvedValue({
      participant: {
        id: "manual-1",
        memberId: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
        accountAccess: "temporary",
        canOrganizerEditAvailability: true,
        invitationStatus: "not_sent",
        version: 1,
      },
      created: true,
      memberCreated: true,
      // Adding never emails: invitations are reviewed and sent afterwards.
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    // The invitation review for one person, then the send it confirms.
    sendRosterInvitations.mockImplementation((_code, options) =>
      Promise.resolve(
        options.preview
          ? {
              preview: true,
              requestedCount: 1,
              willSend: 1,
              skipped: {
                alreadyInvited: 0,
                noEmail: 0,
                organizer: 0,
                inFlight: 0,
              },
              email: {
                from: "noreply@releviz.local",
                replyTo: "",
                to: "Manual Person <manual@example.com>",
                subject: "You're invited to Big event",
                html: "<!doctype html><p>Pick your times</p>",
                text: "Pick your times",
                attachments: [],
              },
              sample: { name: "Manual Person", email: "manual@example.com" },
            }
          : {
              queuedCount: 1,
              skipped: {},
              deliveryRequest: {
                id: "manual-delivery",
                operation: "invitation",
                recipientCount: 1,
                delivery: { total: 1, pending: 1, sent: 0 },
              },
            },
      ),
    );
    fetchEventResults.mockResolvedValue({
      status: "fresh",
      requestedRevision: 3,
      computedRevision: 3,
      generatedAt: "2026-08-20T08:00:00Z",
      results: {
        recommendations: [
          {
            rank: 1,
            label: "Thursday 9:00 AM",
            channel: "inperson",
            suggestedStartsAt: "2026-08-20T09:00:00Z",
            suggestedEndsAt: "2026-08-20T10:00:00Z",
            weightedAvailability: 0.9,
            unweightedAvailability: 0.8,
            fullyAvailableParticipantTotal: 700,
          },
        ],
      },
    });
    fetchEvent.mockResolvedValue({ event: { ...event, version: 3 } });
  });

  test("shows the loading state while organizer authentication is unresolved", () => {
    useAuth.mockReturnValue({ user: null, loading: true, getToken: jest.fn() });
    renderView();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders every organizer section in one ordered workspace", async () => {
    const { setEvent } = renderView();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Campus scheduling",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("organizer-header-event-status"),
    ).toHaveTextContent("active");
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);

    // Event facts first, then the calendar picker with its confirmation step
    // inside it, then the roster that feeds them.
    const sectionIds = [
      "organizer-overview",
      "organizer-results",
      "organizer-roster",
    ];
    const labels = ["Overview", "Time Table", "Participants"];

    labels.forEach((label, index) => {
      expect(document.getElementById(sectionIds[index])).toHaveAccessibleName(
        label,
      );
    });
    const sectionNav = screen.getByRole("navigation", {
      name: "Workspace sections",
    });
    const sectionLinks = within(sectionNav).getAllByRole("link");
    expect(sectionLinks).toHaveLength(sectionIds.length);
    labels.forEach((label, index) => {
      expect(sectionLinks[index]).toHaveAccessibleName(label);
      expect(sectionLinks[index]).toHaveAttribute(
        "href",
        `#${sectionIds[index]}`,
      );
      expect(sectionLinks[index]).not.toHaveAttribute("aria-current");
    });
    expect(
      Array.from(document.querySelectorAll(".organizer-workspace-section")).map(
        (section) => section.id,
      ),
    ).toEqual(sectionIds);
    expect(
      Array.from(
        document.querySelector(".organizer-workspace-sections").children,
      ).map((section) => section.id),
    ).toEqual(sectionIds);
    expect(
      screen.getByRole("grid", { name: /Meeting time calendar/ }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryAllByRole("tabpanel")).toHaveLength(0);

    const workspaceActions = screen.getByRole("group", {
      name: "Workspace actions",
    });
    expect(
      within(workspaceActions).getByRole("region", {
        name: "Event controls",
      }),
    ).toBeInTheDocument();
    // The workspace keeps itself current: nothing on the page refreshes it
    // by hand.
    expect(
      screen.queryByRole("button", { name: /refresh/i }),
    ).not.toBeInTheDocument();
    // Finalize lives inside the Time Table section, as a step under the
    // calendar that stays closed until a time is picked.
    const resultsSection = document.getElementById("organizer-results");
    expect(resultsSection).toContainElement(
      document.getElementById("organizer-finalize"),
    );
    expect(
      within(resultsSection).getByRole("heading", {
        level: 4,
        name: "Finalize",
      }),
    ).toBeInTheDocument();
    expect(document.getElementById("organizer-finalize")).not.toHaveAttribute(
      "open",
    );

    const overviewSection = document.getElementById("organizer-overview");
    expect(overviewSection).toHaveAccessibleName("Overview");
    expect(
      within(overviewSection).getByRole("heading", {
        level: 3,
        name: "Overview",
      }),
    ).toBeInTheDocument();
    expect(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();
    expect(
      within(overviewSection).queryByRole("link", { name: "Edit event" }),
    ).not.toBeInTheDocument();
    // The blocked-times step belongs to the Time Table, not the Overview. It
    // starts closed, and its paint surface is the meeting calendar itself:
    // one grid, no second "Blocked times" grid.
    const blockedTimes = resultsSection.querySelector(
      "details.organizer-blocked-times",
    );
    expect(blockedTimes).not.toHaveAttribute("open");
    expect(within(resultsSection).getAllByRole("grid")).toHaveLength(1);
    expect(
      screen.queryByRole("grid", { name: "Blocked times" }),
    ).not.toBeInTheDocument();
    // Its tools appear only while it is open.
    expect(
      screen.queryByRole("region", { name: "Blocked times tools" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save blocked times" }),
    ).not.toBeInTheDocument();
    expect(
      within(overviewSection).queryByRole("heading", {
        name: "Blocked times",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(overviewSection).getByRole("button", {
        name: "Show all details",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(overviewSection).queryByText("Availability interval"),
    ).not.toBeInTheDocument();
    expect(
      within(overviewSection).queryByRole("region", {
        name: "Event controls",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(overviewSection).queryByRole("button", {
        name: "Queue reminders",
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(overviewSection).getByRole("button", {
        name: "Show all details",
      }),
    );
    expect(
      within(overviewSection).getByRole("button", { name: "Hide details" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(overviewSection).getByText("Availability interval"),
    ).toBeInTheDocument();
    expect(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();

    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    );
    expect(
      within(overviewSection).getByRole("heading", { name: "Edit event" }),
    ).toBeInTheDocument();
    expect(within(overviewSection).getByText("Schedule")).toBeInTheDocument();
    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Cancel" }),
    );
    expect(
      within(overviewSection).queryByRole("heading", { name: "Edit event" }),
    ).not.toBeInTheDocument();
    expect(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    ).toBeEnabled();

    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    );
    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Save changes" }),
    );
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: event.code,
        name: "Updated workspace event",
        version: event.version + 1,
      }),
    );
  });

  test.each(["roster", "results"])(
    "scrolls to a directly linked %s section",
    async (section) => {
      window.history.replaceState(
        {},
        "",
        `/event?code=BIG1000#organizer-${section}`,
      );
      renderView();

      await waitFor(() =>
        expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
          behavior: "auto",
          block: "start",
        }),
      );
      expect(HTMLElement.prototype.scrollIntoView.mock.contexts).toContain(
        document.getElementById(`organizer-${section}`),
      );
    },
  );

  test("disables the overview edit action when a final meeting is confirmed", async () => {
    renderView(jest.fn(), {
      ...event,
      status: "closed",
      finalMeeting: { id: "final-1" },
    });
    await screen.findByText("Ada Faculty");

    const overviewSection = document.getElementById("organizer-overview");
    expect(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    ).toBeDisabled();
  });

  test("a passed deadline is changed in place, from the controls and from the Participants notice", async () => {
    renderView(jest.fn(), {
      ...event,
      responseDeadline: "2020-01-01T00:00:00Z",
    });
    await screen.findByText("Ada Faculty");

    const controls = screen.getByRole("region", { name: "Event controls" });
    expect(
      within(controls).getByText(
        "The response deadline has passed, so people can no longer respond.",
      ),
    ).toBeInTheDocument();
    const overviewSection = document.getElementById("organizer-overview");
    const rosterSection = document.getElementById("organizer-roster");
    expect(
      within(overviewSection).queryByRole("heading", { name: "Edit event" }),
    ).not.toBeInTheDocument();

    // The Participants notice brings the organizer to the Overview's editor
    // instead of leaving the workspace.
    HTMLElement.prototype.scrollIntoView.mockClear();
    await userEvent.click(
      within(rosterSection).getByRole("button", { name: "Change deadline" }),
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(HTMLElement.prototype.scrollIntoView.mock.contexts).toContain(
      overviewSection,
    );
    expect(
      await within(overviewSection).findByRole("heading", {
        name: "Edit event",
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Cancel" }),
    );
    expect(
      within(overviewSection).queryByRole("heading", { name: "Edit event" }),
    ).not.toBeInTheDocument();

    // So does the sentence in the controls.
    await userEvent.click(
      within(controls).getByRole("button", { name: "Change deadline" }),
    );
    expect(
      await within(overviewSection).findByRole("heading", {
        name: "Edit event",
      }),
    ).toBeInTheDocument();
  });

  test("reports when the roster cannot be re-read after a reset", async () => {
    renderView();
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    fetchRoster.mockRejectedValueOnce(new Error(""));

    const overviewSection = document.getElementById("organizer-overview");
    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    );
    await userEvent.click(
      within(overviewSection).getByRole("button", {
        name: "Save and reset responses",
      }),
    );

    expect(
      await screen.findByText(
        "The event was saved, but the participant list could not be refreshed.",
      ),
    ).toHaveAttribute("role", "alert");
  });

  test("validates required add-person fields and invalid email locally", async () => {
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.click(add.submit);
    expect(
      await within(add.dialog).findByText("Full name is required."),
    ).toBeInTheDocument();
    expect(
      within(add.dialog).getByText("Email address is required."),
    ).toBeInTheDocument();
    expect(createManagedParticipant).not.toHaveBeenCalled();

    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "not-an-email");
    await userEvent.click(add.submit);
    expect(
      await within(add.dialog).findByText("Enter a valid email address."),
    ).toBeInTheDocument();
    expect(createManagedParticipant).not.toHaveBeenCalled();
    await userEvent.click(add.send);
    expect(
      within(add.dialog).getByText("Enter a valid email address."),
    ).toBeInTheDocument();
    expect(createManagedParticipant).not.toHaveBeenCalled();
  });

  test("adds a person without emailing them and keeps the panel open for the next one", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "manual-1",
        memberId: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
        accountAccess: "temporary",
        canOrganizerEditAvailability: true,
        invitationStatus: "not_sent",
        version: 1,
      },
      created: true,
      memberCreated: true,
      idempotent: false,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "manual@example.com");
    await userEvent.click(add.submit);

    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        event.code,
        {
          name: "Manual Person",
          email: "manual@example.com",
          phone: "",
          organizerManaged: false,
          idempotencyKey: "request-key",
          sendInvitation: false,
        },
        "token",
      ),
    );
    expect(await within(add.dialog).findByRole("status")).toHaveTextContent(
      "Manual Person was added. No invitation was sent.",
    );
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    // The fields clear for the next person and the panel stays open.
    expect(add.name).toHaveValue("");
    expect(add.email).toHaveValue("");
    expect(
      screen.getByRole("dialog", { name: "Add a person" }),
    ).toBeInTheDocument();
  });

  test("adds an active invitee and invites them only after the email is reviewed", async () => {
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "manual@example.com");
    await userEvent.click(add.send);

    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        event.code,
        {
          name: "Manual Person",
          email: "manual@example.com",
          phone: "",
          organizerManaged: false,
          idempotencyKey: "request-key",
          sendInvitation: false,
        },
        "token",
      ),
    );
    const review = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    expect(
      await within(review).findByText("1 will get an invitation now"),
    ).toBeInTheDocument();
    expect(review).toHaveTextContent("Manual Person <manual@example.com>");
    expect(within(add.dialog).getByRole("status")).toHaveTextContent(
      "Manual Person was added. No invitation was sent.",
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Send 1 invitation" }),
    );
    expect(await within(add.dialog).findByRole("status")).toHaveTextContent(
      "Manual Person was added and their invitation is queued.",
    );
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("does not claim a new invitation when the participant already exists", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
        invitationStatus: "sent",
      },
      created: false,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "manual@example.com");
    await userEvent.click(add.send);

    expect(await within(add.dialog).findByRole("status")).toHaveTextContent(
      "Manual Person is already on the list, so nothing was added.",
    );
    // They were invited already, so there is nothing to review or send.
    expect(
      screen.queryByRole("dialog", { name: "Send invitations" }),
    ).not.toBeInTheDocument();
    expect(sendRosterInvitations).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
  });

  test("reviews the invitation of an archived participant brought back", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "manual-1",
        name: "Returning Person",
        email: "returning@example.com",
      },
      created: false,
      restored: true,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Returning Person");
    await userEvent.type(add.email, "returning@example.com");
    await userEvent.click(add.send);

    const review = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    await within(review).findByText("1 will get an invitation now");
    await userEvent.click(
      within(review).getByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Send 1 invitation" }),
    );
    expect(await within(add.dialog).findByRole("status")).toHaveTextContent(
      "Returning Person was added and their invitation is queued.",
    );
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("disables the add buttons while the person is being added", async () => {
    let resolveCreate;
    createManagedParticipant.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "manual@example.com");

    fireEvent.click(add.send);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledTimes(1),
    );
    expect(add.send).toBeDisabled();
    expect(add.submit).toBeDisabled();
    fireEvent.click(add.send);
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    resolveCreate({
      participant: {
        id: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
      },
      created: true,
      autoInvitedCount: 0,
    });
    await waitFor(() => expect(add.send).toBeEnabled());
  });

  test("adds a person the organizer manages without typing an email", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "managed-1",
        memberId: "managed-1",
        name: "Managed Person",
        email: "organizer@example.com",
        phone: "+1 555 010 0199",
        accountAccess: "temporary",
        organizerManaged: true,
        canOrganizerEditAvailability: true,
        invitationStatus: "not_sent",
        version: 1,
      },
      created: true,
      restored: false,
      memberCreated: true,
      autoInvitedCount: 0,
      deliveryRequest: {
        id: "managed-delivery",
        operation: "invitation",
        recipientCount: 0,
        delivery: { total: 0, pending: 0, sent: 0 },
      },
    });
    renderView();
    const add = await openAddPersonPanel();
    const managed = within(add.dialog).getByRole("checkbox", {
      name: "They have no email. I'll enter their schedule.",
    });
    expect(managed).not.toBeChecked();
    expect(managed).toHaveAccessibleDescription(
      "Blank = filed under your account email. They are never emailed.",
    );

    await userEvent.click(managed);
    expect(managed).toBeChecked();
    // No address is asked for, and nobody is emailed.
    expect(
      within(add.dialog).queryByRole("textbox", { name: /^Email/ }),
    ).not.toBeInTheDocument();
    expect(
      within(add.dialog).queryByRole("button", {
        name: "Add and send invitation",
      }),
    ).not.toBeInTheDocument();

    await userEvent.type(add.name, "Managed Person");
    await userEvent.type(
      within(add.dialog).getByRole("textbox", { name: /^Phone/ }),
      "+1 555 010 0199",
    );
    fetchRoster.mockResolvedValueOnce(
      rosterListing({
        participants: [
          {
            id: "managed-1",
            memberId: "managed-1",
            name: "Managed Person",
            email: "organizer@example.com",
            phone: "+1 555 010 0199",
            group: "",
            groups: [],
            weight: 1,
            included: true,
            submitted: false,
            accountAccess: "temporary",
            organizerManaged: true,
            canOrganizerEditAvailability: true,
            invitationStatus: "not_sent",
            version: 1,
          },
        ],
      }),
    );
    await userEvent.click(add.submit);

    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        event.code,
        {
          name: "Managed Person",
          email: "",
          phone: "+1 555 010 0199",
          organizerManaged: true,
          idempotencyKey: "request-key",
          sendInvitation: false,
        },
        "token",
      ),
    );
    expect(await within(add.dialog).findByRole("status")).toHaveTextContent(
      "Managed Person was added.",
    );
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(add.dialog).getByRole("button", { name: "Done" }),
    );
    const row = (
      await screen.findByRole("rowheader", { name: /Managed Person/ })
    ).closest("tr");
    // The row never shows the organizer's own address as theirs.
    expect(row).not.toHaveTextContent("organizer@example.com");
    expect(row).toHaveTextContent("No email · you enter their schedule");
    expect(within(row).getByText("No email")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Edit schedule" }),
    ).toBeEnabled();
  });

  test("shows the server hint when the organizer's own address is typed without the checkbox", async () => {
    createManagedParticipant.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'That is one of your own addresses. Check "No email of their own" to add a person you manage.',
        ),
        { status: 409, errorCode: "organizer_own_email" },
      ),
    );
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Managed Person");
    await userEvent.type(add.email, "organizer@example.com");
    await userEvent.click(add.send);

    expect(await within(add.dialog).findByRole("alert")).toHaveTextContent(
      'That is one of your own addresses. Check "No email of their own" to add a person you manage.',
    );
    expect(createManagedParticipant).toHaveBeenCalledWith(
      event.code,
      expect.objectContaining({ organizerManaged: false, phone: "" }),
      "token",
    );
    // The typed values stay for a corrected retry.
    expect(add.name).toHaveValue("Managed Person");
    expect(add.email).toHaveValue("organizer@example.com");
  });

  test("keeps add values and reuses the idempotency key after a failed request", async () => {
    createManagedParticipant
      .mockRejectedValueOnce(new Error("delivery service unavailable"))
      .mockResolvedValueOnce({
        participant: {
          id: "manual-1",
          name: "Manual Person",
          email: "manual@example.com",
        },
        created: true,
        autoInvitedCount: 1,
        deliveryRequest: {
          id: "manual-delivery-retry",
          recipientCount: 1,
          delivery: { total: 1, pending: 1, sent: 0 },
        },
      });
    renderView();
    const add = await openAddPersonPanel();
    await userEvent.type(add.name, "Manual Person");
    await userEvent.type(add.email, "manual@example.com");
    await userEvent.click(add.send);

    expect(await within(add.dialog).findByRole("alert")).toHaveTextContent(
      "delivery service unavailable",
    );
    expect(add.name).toHaveValue("Manual Person");
    expect(add.email).toHaveValue("manual@example.com");
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    await userEvent.click(add.send);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledTimes(2),
    );
    expect(createManagedParticipant.mock.calls[0][1].idempotencyKey).toBe(
      "request-key",
    );
    expect(createManagedParticipant.mock.calls[1][1].idempotencyKey).toBe(
      "request-key",
    );
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("discards malformed persisted delivery progress", async () => {
    const key = `releviz.delivery-request.${event.code}`;
    window.sessionStorage.setItem(key, "not-json");
    renderView();
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
  });

  test("clears persisted delivery progress when a reminder run queues no recipients", async () => {
    const key = `releviz.delivery-request.${event.code}`;
    window.sessionStorage.setItem(key, JSON.stringify({ id: "old-request" }));
    // An older preview reply without the reminders flag: the event's own
    // setting stands in for it.
    sendReminders
      .mockResolvedValueOnce({ preview: true, wouldEnqueue: 1 })
      .mockResolvedValueOnce({ recipientCount: 0 });
    renderView(jest.fn(), { ...event, remindersEnabled: true });
    await screen.findByText("Ada Faculty");
    await userEvent.click(screen.getByRole("button", { name: "Email" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Send reminders (1)…" }),
    );
    const review = await screen.findByRole("dialog", {
      name: "Send reminders",
    });
    await userEvent.click(
      within(review).getByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Send 1 reminder" }),
    );
    await waitFor(() =>
      expect(sendReminders).toHaveBeenLastCalledWith(
        event.code,
        { idempotencyKey: "request-key" },
        "token",
      ),
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(await screen.findByText("Queued 0 reminders.")).toBeInTheDocument();
  });

  test("keeps a closed roster searchable but blocks every mutation control", async () => {
    renderView(jest.fn(), { ...event, status: "closed" });
    await screen.findByText("Ada Faculty");

    expect(
      screen.getByText(
        "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add person" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Email" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search participants")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /^Group: Everyone/ }),
    ).toBeEnabled();
    expect(
      screen.getByLabelText("Select everyone on this page"),
    ).toBeDisabled();
    expect(screen.getByLabelText("Select Ada Faculty")).toBeDisabled();
    // Schedules can still be looked at; the drawer itself is read-only.
    expect(screen.getByRole("button", { name: "Edit schedule" })).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Ada Faculty" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Remove from event…" }),
    ).toBeDisabled();
  });

  test("turns a genuinely empty roster into a focused invitation state", async () => {
    fetchRoster.mockResolvedValueOnce(
      rosterListing({
        participants: [],
        pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
        stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
        overall: { total: 0, submitted: 0, notSubmitted: 0 },
      }),
    );

    renderView();

    expect(
      await screen.findByRole("heading", { name: "No participants yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add people one at a time or import a list. Nobody is emailed until you invite them.",
      ),
    ).toBeInTheDocument();
    // The header keeps its actions; the empty state repeats them.
    expect(
      screen.getAllByRole("button", { name: "+ Add person" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Import a spreadsheet" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Search participants"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Selected people" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rows per page")).not.toBeInTheDocument();
  });

  test("does not render pagination for a one-participant roster", async () => {
    renderView();

    const rosterSection = document.getElementById("organizer-roster");
    expect(
      await within(rosterSection).findByText("Ada Faculty"),
    ).toBeInTheDocument();
    expect(
      within(rosterSection).queryByLabelText("Rows per page"),
    ).not.toBeInTheDocument();
    expect(
      within(rosterSection).queryByRole("button", { name: "Previous" }),
    ).not.toBeInTheDocument();
    expect(
      within(rosterSection).queryByRole("button", { name: "Next" }),
    ).not.toBeInTheDocument();
  });

  test("keeps filters useful when they return no matches and clears them together", async () => {
    const populatedRoster = rosterListing();
    const emptyFilteredRoster = rosterListing({
      participants: [],
      pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
      stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
    });
    fetchRoster
      .mockReset()
      .mockResolvedValueOnce(populatedRoster)
      .mockResolvedValueOnce(emptyFilteredRoster)
      .mockResolvedValue(populatedRoster);

    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("Search participants"),
      "nobody",
    );
    const noMatch = await screen.findByRole("heading", {
      name: "No matching participants.",
    });
    expect(screen.getByLabelText("Search participants")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /^Group: Everyone/ }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Remove filter Search: nobody" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Rows per page")).not.toBeInTheDocument();

    await userEvent.click(
      within(noMatch.closest(".empty-state")).getByRole("button", {
        name: "Clear all",
      }),
    );
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    expect(screen.getByLabelText("Search participants")).toHaveValue("");
    expect(
      screen.queryByRole("list", { name: "Active filters" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({
          page: 1,
          search: "",
          group: "",
          submitted: "",
          invitationStatus: "",
          included: "",
        }),
        "token",
      ),
    );
  });

  test("loads a paginated roster and changes one row from its menu without full schedules", async () => {
    renderView();

    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    expect(fetchRosterSchedule).not.toHaveBeenCalled();
    expect(fetchRoster).toHaveBeenCalledWith(
      event.code,
      expect.objectContaining({ page: 1, pageSize: 50 }),
      "token",
    );
    const rosterSection = document.getElementById("organizer-roster");
    expect(
      within(rosterSection).getByRole("group", { name: "Participant actions" }),
    ).toBeInTheDocument();
    const table = within(rosterSection).getByRole("table", {
      name: "Participants",
    });
    ["Name", "Groups", "Response", "Invitation"].forEach((column) => {
      expect(
        within(table).getByRole("columnheader", { name: column }),
      ).toBeInTheDocument();
    });
    const row = within(table)
      .getByRole("rowheader", { name: /Ada Faculty/ })
      .closest("tr");
    expect(row).toHaveAttribute("data-roster-participant-id", "roster-1");
    expect(row).toHaveTextContent("Faculty");
    expect(row).toHaveTextContent("Weight 0.8");
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for Ada Faculty" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { included: false, expectedVersion: 1 },
        "token",
      ),
    );
    expect(
      await screen.findByText("Ada Faculty is left out of the results."),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("Search participants"),
      "ada@example.com",
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({
          page: 1,
          pageSize: 50,
          search: "ada@example.com",
        }),
        "token",
      ),
    );

    await userEvent.click(
      within(row).getByRole("button", { name: "Edit schedule" }),
    );
    await waitFor(() =>
      expect(fetchRosterSchedule).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        "token",
      ),
    );
  });

  test("applies group weight and counting through one bulk patch from the groups panel", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /^Group: Everyone/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Manage groups…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Groups" });
    fireEvent.change(within(dialog).getByLabelText("Weight for Faculty"), {
      target: { value: "0.4" },
    });
    fireEvent.blur(within(dialog).getByLabelText("Weight for Faculty"));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          group: "Faculty",
          updates: { weight: 0.4 },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
    await userEvent.click(
      within(dialog).getByLabelText("Count Faculty in the results"),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        event.code,
        {
          group: "Faculty",
          updates: { included: false },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
  });

  test("sets a weight for the selected people from the selection bar", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Select Ada Faculty"));
    expect(
      screen.getByRole("region", { name: "Selected people" }),
    ).toHaveTextContent("1 selected");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Set weight…" }),
    );
    const weightDialog = await screen.findByRole("dialog", {
      name: "Set weight",
    });
    fireEvent.change(within(weightDialog).getByLabelText("Weight"), {
      target: { value: "0.25" },
    });
    await userEvent.click(
      within(weightDialog).getByRole("button", { name: "Apply" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        event.code,
        {
          participantIds: ["roster-1"],
          updates: { weight: 0.25 },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
    expect(
      await screen.findByText("Set weight 0.25 for 1 person."),
    ).toBeInTheDocument();
  });

  test("uses an explicit all selector when everyone matching is selected", async () => {
    fetchRoster.mockResolvedValue(
      rosterListing({
        pagination: { page: 1, pageSize: 1, total: 2, pages: 2 },
      }),
    );
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    await userEvent.click(
      screen.getByLabelText("Select everyone on this page"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Select all 2 matching" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    await userEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Apply to 2 people?" }),
      ).getByRole("button", { name: "Apply" }),
    );

    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          filter: { all: true },
          updates: { included: false },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
  });

  test("recovers the latest durable delivery request from the roster response", async () => {
    fetchRoster.mockResolvedValueOnce(
      rosterListing({
        participants: [],
        pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
        stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
        overall: { total: 0, submitted: 0, notSubmitted: 0 },
        latestDeliveryRequest: {
          id: "recovered-delivery",
          operation: "invitation",
          delivery: { total: 3, pending: 2, sent: 1 },
        },
      }),
    );
    renderView();
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("2 queued");
  });

  test("restores durable delivery progress after a browser refresh and lets it be dismissed", async () => {
    window.sessionStorage.setItem(
      `releviz.delivery-request.${event.code}`,
      JSON.stringify({
        id: "stored-delivery",
        operation: "final_confirmation",
        delivery: { total: 5, sent: 5 },
      }),
    );
    renderView();
    const card = await screen.findByLabelText("Event delivery progress");
    expect(card).toHaveTextContent("Complete");
    await userEvent.click(
      within(card).getByRole("button", { name: "Dismiss" }),
    );
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    expect(
      window.sessionStorage.getItem(`releviz.delivery-request.${event.code}`),
    ).toBeNull();
  });

  test("keeps a dismissed run away when the roster lists it again, until a new run starts", async () => {
    const requestKey = `releviz.delivery-request.${event.code}`;
    const dismissedKey = `releviz.delivery-request.${event.code}.dismissed`;
    const finished = {
      id: "finished-run",
      operation: "invitation",
      delivery: { total: 3, sent: 3 },
    };
    // The listing names the most recent run whatever its state, on every
    // load.
    fetchRoster.mockResolvedValue(
      rosterListing({ latestDeliveryRequest: finished }),
    );
    const { unmount } = renderView();
    const card = await screen.findByLabelText("Event delivery progress");
    expect(card).toHaveTextContent("Complete");
    await userEvent.click(
      within(card).getByRole("button", { name: "Dismiss" }),
    );
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(dismissedKey)).toBe("finished-run");

    // A search reloads the roster, which still carries the finished run.
    fireEvent.change(screen.getByLabelText("Search participants"), {
      target: { value: "ada" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({ search: "ada" }),
        "token",
      ),
    );
    await screen.findByText(/^Showing 1 of 1 people/);
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(requestKey)).toBeNull();

    // The dismissal outlives the page.
    unmount();
    renderView();
    await screen.findByText("Ada Faculty");
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();

    // A new run has a new id and shows.
    fetchRoster.mockResolvedValue(
      rosterListing({
        latestDeliveryRequest: {
          id: "new-run",
          operation: "invitation",
          delivery: { total: 1, pending: 1, sent: 0 },
        },
      }),
    );
    fireEvent.change(screen.getByLabelText("Search participants"), {
      target: { value: "ada" },
    });
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
    expect(window.sessionStorage.getItem(requestKey)).toContain("new-run");
  });

  test("dismisses a run that carries no id without remembering it", async () => {
    window.sessionStorage.setItem(
      `releviz.delivery-request.${event.code}`,
      JSON.stringify({
        operation: "invitation",
        delivery: { total: 1, sent: 1 },
      }),
    );
    renderView();
    const card = await screen.findByLabelText("Event delivery progress");
    await userEvent.click(
      within(card).getByRole("button", { name: "Dismiss" }),
    );
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
    expect(
      window.sessionStorage.getItem(
        `releviz.delivery-request.${event.code}.dismissed`,
      ),
    ).toBeNull();
  });

  test("jumps from the delivery card to the people whose invitation failed", async () => {
    window.sessionStorage.setItem(
      `releviz.delivery-request.${event.code}`,
      JSON.stringify({
        id: "stored-delivery",
        operation: "invitation",
        delivery: { total: 2, sent: 1, permanentFailure: 1 },
      }),
    );
    renderView();
    await screen.findByText("Ada Faculty");
    const card = await screen.findByLabelText("Event delivery progress");
    await userEvent.click(
      within(card).getByRole("button", { name: "Show failed" }),
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({ invitationStatus: "failed", page: 1 }),
        "token",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove filter Invitation: Failed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Participants" })).toHaveFocus();
  });

  test("saves a person's weight from their panel without touching anything else", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: { id: "roster-1", weight: 0.35, included: true, version: 2 },
      resultsRevision: 4,
    });
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Ada Faculty/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Ada Faculty" });
    fireEvent.change(within(dialog).getByLabelText(/^Weight/), {
      target: { value: "0.35" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { weight: 0.35, expectedVersion: 1 },
        "token",
      ),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  test("saves a person's phone from their panel and shows it on the row", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: {
        id: "roster-1",
        phone: "+1 (555) 010-0199",
        included: true,
        version: 2,
      },
      resultsRevision: 4,
    });
    renderView();
    expect(await screen.findByLabelText("Search participants")).toHaveAttribute(
      "placeholder",
      "Search name, email, phone or group",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Ada Faculty/ }));
    const dialog = await screen.findByRole("dialog", { name: "Ada Faculty" });
    const phone = within(dialog).getByLabelText(/^Phone/);
    expect(phone).toHaveValue("");
    fireEvent.change(phone, { target: { value: "+1 (555) 010-0199" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { phone: "+1 (555) 010-0199", expectedVersion: 1 },
        "token",
      ),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    const row = screen
      .getByRole("rowheader", { name: /Ada Faculty/ })
      .closest("tr");
    expect(row).toHaveTextContent("ada@example.com · +1 (555) 010-0199");
  });

  test("refuses a bad phone locally and keeps a server refusal in the panel", async () => {
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Enter a valid phone number."), { status: 400 }),
    );
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Ada Faculty/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Ada Faculty" });
    const phone = within(dialog).getByLabelText(/^Phone/);
    fireEvent.change(phone, { target: { value: "call me" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Enter a phone number with 7 to 32 digits.",
      ),
    ).toBeInTheDocument();
    expect(patchRosterParticipant).not.toHaveBeenCalled();

    fireEvent.change(phone, { target: { value: "+1 555 010 0199" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Enter a valid phone number.",
    );
    // The typed value stays for a corrected retry.
    expect(phone).toHaveValue("+1 555 010 0199");
  });

  test("changes a person's groups through the picker and keeps the draft when refused", async () => {
    let refuse;
    patchRosterParticipant.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Ada Faculty/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Ada Faculty" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "+ Add to group" }),
    );
    const picker = await screen.findByRole("dialog", {
      name: "Groups for Ada Faculty",
    });
    expect(within(picker).getByLabelText("Faculty")).toBeChecked();
    await userEvent.click(within(picker).getByLabelText("Faculty"));
    await userEvent.click(
      within(picker).getByRole("button", { name: "Apply" }),
    );
    expect(
      await within(
        within(dialog).getByRole("list", { name: "Groups" }),
      ).findByText("No group"),
    ).toBeInTheDocument();
    expect(patchRosterParticipant).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { removeGroupIds: [11], expectedVersion: 1 },
        "token",
      ),
    );
    await act(async () => {
      refuse(Object.assign(new Error("Not now"), { status: 400 }));
    });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Not now",
    );
    // The refused change stays as a draft to retry or discard.
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(
      within(within(dialog).getByRole("list", { name: "Groups" })).getByText(
        "No group",
      ),
    ).toBeInTheDocument();
  });

  test("serializes rapid changes to one roster row with the latest version", async () => {
    let resolveFirst;
    patchRosterParticipant
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        participant: {
          id: "roster-1",
          included: true,
          version: 3,
        },
        resultsRevision: 5,
      });
    renderView();
    const row = (
      await screen.findByRole("rowheader", { name: /Ada Faculty/ })
    ).closest("tr");
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for Ada Faculty" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(1),
    );

    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for Ada Faculty" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    expect(patchRosterParticipant).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst({
        participant: {
          id: "roster-1",
          included: false,
          version: 2,
        },
        resultsRevision: 4,
      });
    });

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(2),
    );
    // The second click meant "leave out" too (the row still said so), and
    // it goes out against the version the first change came back with.
    expect(patchRosterParticipant.mock.calls[1][2]).toEqual({
      included: false,
      expectedVersion: 2,
    });
  });

  test("pastes, maps, previews, and merges a roster import, then reviews its invitations", async () => {
    mockRosterImportPreview();
    commitRosterImport.mockResolvedValue({
      autoInvitedCount: 0,
      deliveryRequest: null,
      receipt: {
        mode: "merge",
        importedCount: 1,
        createdCount: 1,
        updatedCount: 0,
        resultsRevision: 4,
      },
      addedParticipantIds: ["roster-9"],
      importedParticipantIds: ["roster-9"],
    });
    renderView();
    await screen.findByText("Ada Faculty");
    await openPastedRosterPreview();
    expect(configureRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-1",
      expect.objectContaining({ columnMapping: { name: "0", email: "1" } }),
      "token",
    );
    // The import itself never emails anyone.
    expect(
      screen.queryByLabelText(
        "Email invitations to the people this import adds",
      ),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Import 1 person" }),
    );

    await waitFor(() =>
      expect(commitRosterImport).toHaveBeenCalledWith(
        event.code,
        "import-1",
        {
          mode: "merge",
          idempotencyKey: "request-key",
          sendInvitations: false,
        },
        "token",
      ),
    );
    // The sheet stays open on its Done step; its review hands the people
    // it added to the invitation dialog and reports the import's outcome.
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Review and send invitations (1)…",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Import participants" }),
    ).not.toBeInTheDocument();
    expect(
      (
        await screen.findByText(
          "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
        )
      ).closest("[role]"),
    ).toHaveAttribute("role", "status");
    const review = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    expect(sendRosterInvitations).toHaveBeenCalledWith(
      event.code,
      { participantIds: ["roster-9"], preview: true, resend: false },
      "token",
    );
    await within(review).findByText("1 will get an invitation now");
    await userEvent.click(
      within(review).getByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Send 1 invitation" }),
    );
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("requires the exact event code before a destructive roster rebuild", async () => {
    mockRosterImportPreview();
    const rebuiltEvent = {
      ...event,
      status: "active",
      version: event.version + 1,
    };
    commitRosterImport.mockResolvedValue({
      event: rebuiltEvent,
      receipt: {
        mode: "rebuild",
        importedCount: 1,
        createdCount: 1,
        updatedCount: 0,
        resultsRevision: 4,
      },
    });
    const { setEvent } = renderView();
    await screen.findByText("Ada Faculty");
    await openPastedRosterPreview();
    await userEvent.click(
      screen.getByRole("radio", { name: /Replace the whole list/ }),
    );

    const rebuildButton = screen.getByRole("button", {
      name: "Replace the list with 1 person",
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Rebuilding clears schedules, invitations, and pending delivery. Everyone starts as Not sent and gets no reminders until you send invitations, which you can review once the import is done.",
    );
    expect(rebuildButton).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Rebuild confirmation code"),
      "BIG100",
    );
    expect(rebuildButton).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Rebuild confirmation code"),
      "0",
    );
    expect(rebuildButton).toBeEnabled();
    await userEvent.click(rebuildButton);

    await waitFor(() =>
      expect(commitRosterImport).toHaveBeenCalledWith(
        event.code,
        "import-1",
        {
          mode: "rebuild",
          confirmationCode: event.code,
          idempotencyKey: "request-key",
          sendInvitations: false,
        },
        "token",
      ),
    );
    expect(setEvent).toHaveBeenCalledWith(rebuiltEvent);
    expect(
      await screen.findByText(
        "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Event delivery progress"),
    ).not.toBeInTheDocument();
  });

  test("shows snapshot freshness and finalizes a chosen continuous recommendation", async () => {
    previewFinalMeeting.mockResolvedValue({
      attendance: {
        availableParticipantTotal: 700,
        partialParticipantTotal: 100,
        unavailableParticipantTotal: 50,
        unansweredParticipantTotal: 150,
        excludedParticipantTotal: 0,
      },
      recipientCount: 2,
      email: {
        from: "noreply@releviz.local",
        replyTo: "",
        to: "Ada Faculty <ada@example.com>",
        subject: "Big event is confirmed",
        html: "<!doctype html><p>See you Thursday</p>",
        text: "See you Thursday",
        attachments: ["meeting.ics"],
      },
      sample: { name: "Ada Faculty", email: "ada@example.com" },
    });
    confirmFinalMeeting.mockResolvedValue({
      event: {
        ...event,
        status: "finalized",
        version: 3,
        finalMeeting: {
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T10:00:00Z",
          channel: "inperson",
          location: "Room 1",
        },
      },
      finalMeeting: { attendance: { availableParticipantTotal: 700 } },
      deliveryRequest: {
        id: "final-9",
        operation: "final_confirmation",
        delivery: { total: 2, pending: 2 },
      },
    });
    const setEvent = jest.fn();
    renderView(setEvent, { ...event, status: "active" });
    expect(
      await screen.findByText(/Results are current at revision 3/),
    ).toBeInTheDocument();
    await toggleRecommendedTimes();
    await userEvent.click(
      screen.getByRole("button", { name: /choose this time/i }),
    );
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Thursday 9:00 AM",
    );
    // The chosen recommendation lives in the Finalize step: the step and
    // the list stay open, and the chip keeps focus.
    expect(document.getElementById("organizer-finalize")).toHaveAttribute(
      "open",
    );
    expect(
      document.getElementById("organizer-recommended-times"),
    ).toHaveAttribute("open");
    const chosen = screen.getByRole("button", { name: /selected time/i });
    expect(chosen).toBeVisible();
    expect(chosen).toHaveFocus();
    // The attendance is read as soon as the time is picked.
    expect(await screen.findByText("700")).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "Finalize meeting" }),
    );
    // The confirmation email is reviewed before anything is finalized.
    const review = await screen.findByRole("dialog", {
      name: "Finalize meeting",
    });
    expect(review).toHaveTextContent(
      "2 invited people will receive the confirmation and a calendar invitation.",
    );
    expect(review).toHaveTextContent("Big event is confirmed");
    expect(confirmFinalMeeting).not.toHaveBeenCalled();
    await userEvent.click(
      within(review).getByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      within(review).getByRole("button", {
        name: "Finalize and send 2 emails",
      }),
    );

    await waitFor(() =>
      expect(confirmFinalMeeting).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T10:00:00Z",
          expectedVersion: 2,
          idempotencyKey: "request-key",
        }),
        "token",
      ),
    );
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "finalized" }),
    );
    // Invitation delivery shows in the workspace banner like every other run.
    const banner = await screen.findByLabelText("Event delivery progress");
    expect(banner).toHaveTextContent("Final confirmation delivery");
    expect(banner).toHaveTextContent("2 queued");
    expect(
      screen.queryByLabelText("Finalization delivery progress"),
    ).not.toBeInTheDocument();
  });

  test("keeps the names the end-to-end flow queries unique across the workspace", async () => {
    previewFinalMeeting.mockResolvedValue({
      attendance: {
        availableParticipantTotal: 700,
        partialParticipantTotal: 100,
        unavailableParticipantTotal: 50,
        unansweredParticipantTotal: 150,
        excludedParticipantTotal: 0,
        participants: [
          {
            participantId: "member-1",
            name: "Grace Faculty",
            status: "available",
            minimumAvailability: 1,
          },
        ],
      },
      recipientCount: 0,
      email: null,
      sample: null,
    });
    renderView(jest.fn(), { ...event, status: "active" });
    await screen.findByText(/Results are current at revision 3/);

    // Playwright's getByRole("heading", { name }) is a substring match, so
    // only the panel title and the Finalize step may mention them.
    expect(screen.getAllByRole("heading", { name: /time table/i })).toEqual([
      screen.getByRole("heading", { level: 3, name: "Time Table" }),
    ]);
    expect(screen.queryAllByRole("heading", { name: /results/i })).toEqual([]);
    expect(screen.getAllByRole("heading", { name: /finali[sz]/i })).toEqual([
      screen.getByRole("heading", { level: 4, name: "Finalize" }),
    ]);
    expect(
      screen.getByText("Group availability for a 60-minute meeting.", {
        exact: false,
      }),
    ).toBeInTheDocument();

    // The pick buttons live in the recommended times only (inside Finalize,
    // no landmark of their own); the calendar itself exposes exactly one tab
    // stop and no buttons.
    const rail = document.querySelector("details.organizer-recommended-times");
    expect(
      screen.queryByRole("complementary", { name: "Recommended times" }),
    ).not.toBeInTheDocument();
    const chooseButtons = screen.getAllByRole("button", {
      name: /choose this time/i,
    });
    expect(chooseButtons).toHaveLength(1);
    chooseButtons.forEach((button) => expect(rail).toContainElement(button));
    const grid = screen.getByRole("grid", { name: /^Meeting time calendar/ });
    expect(within(grid).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(grid)
        .getAllByRole("gridcell")
        .filter((gridcell) => gridcell.tabIndex === 0),
    ).toHaveLength(1);
    expect(screen.queryByText("Available", { exact: true })).toBeNull();

    await toggleRecommendedTimes();
    await userEvent.click(chooseButtons[0]);
    const chosen = screen.getByRole("button", { name: /selected time/i });
    expect(chosen).toHaveAttribute("aria-pressed", "true");
    expect(rail).toHaveAttribute("open");
    expect(chosen).toBeVisible();
    // The chip keeps focus, and revealing the chosen window scrolls the
    // calendar, never the page: the organizer is already in Finalize.
    expect(chosen).toHaveFocus();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    await screen.findByText("Attendance review is current for this candidate.");
    // The attendance tile is the only element whose whole text is "Available":
    // the per-person table spells out "Fully available" instead.
    expect(screen.getAllByText("Available", { exact: true })).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Attendance by person" }))
        .getByRole("rowheader", { name: "Grace Faculty" })
        .closest("tr"),
    ).toHaveTextContent("Fully available");
    expect(
      screen.getAllByRole("heading", { name: /time table/i }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("heading", { name: /finali[sz]/i }),
    ).toHaveLength(1);
  });

  test("refreshes the roster when a saved edit reset responses", async () => {
    renderView();
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    fetchRoster.mockClear();
    fetchEventResults.mockClear();

    const overviewSection = document.getElementById("organizer-overview");
    await userEvent.click(
      within(overviewSection).getByRole("button", { name: "Edit event" }),
    );
    await userEvent.click(
      within(overviewSection).getByRole("button", {
        name: "Save and reset responses",
      }),
    );

    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(1));
    expect(fetchRoster).toHaveBeenCalledWith(
      event.code,
      expect.objectContaining({ page: 1 }),
      "token",
    );
    await waitFor(() => expect(fetchEventResults).toHaveBeenCalledTimes(1));
  });

  test("keeps the ranked list and the empty Finalize step collapsed under the calendar", async () => {
    renderView();
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);

    const finalizeSection = document.getElementById("organizer-finalize");
    expect(finalizeSection).toHaveTextContent("No time selected yet");
    expect(
      within(finalizeSection).queryByRole("button", {
        name: "Browse results",
      }),
    ).not.toBeInTheDocument();
    // Two steps stack under the calendar, both closed: Blocked times
    // (nearest the surface it paints), then Finalize, which holds the
    // recommended times.
    const stack = finalizeSection.closest(".time-table__sections");
    expect(stack).not.toBeNull();
    expect(Array.from(stack.children).map((step) => step.id)).toEqual([
      "organizer-blocked-times",
      "organizer-finalize",
    ]);
    expect(
      document
        .getElementById("organizer-results")
        .querySelector(".meeting-calendar + .time-table__sections"),
    ).toBe(stack);
    const rail = document.querySelector("details.organizer-recommended-times");
    expect(finalizeSection).toContainElement(rail);
    expect(rail).not.toHaveAttribute("open");
    expect(finalizeSection).not.toHaveAttribute("open");
    expect(
      document.querySelector("details.organizer-blocked-times"),
    ).not.toHaveAttribute("open");
    // While the recommended times are closed the calendar outlines none and
    // its legend does not mention them.
    expect(document.querySelector(".meeting-calendar__block--rank")).toBeNull();
    expect(screen.queryByText("Recommended time")).not.toBeInTheDocument();

    // Opening them means opening Finalize first.
    await toggleRecommendedTimes();
    expect(finalizeSection).toHaveAttribute("open");
    expect(rail).toHaveAttribute("open");
    expect(screen.getByText("Recommended time")).toBeInTheDocument();

    await toggleRecommendedTimes();
    expect(rail).not.toHaveAttribute("open");
    expect(finalizeSection).toHaveAttribute("open");
    expect(screen.queryByText("Recommended time")).not.toBeInTheDocument();
  });

  test("saving blocked times painted on the Time Table re-reads the results and clears the pick", async () => {
    mockCalendarWindowFlow();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));
    const savedEvent = {
      ...calendarEvent,
      version: 3,
      blockedSlots: { "date:2026-08-20": [3] },
      slotGroups: calendarEvent.slotGroups.map((group) => ({
        ...group,
        slots: group.slots.map((slot) => ({
          ...slot,
          blocked: slot.index === 3,
        })),
      })),
    };
    updateEvent.mockResolvedValue({ event: savedEvent, responsesReset: 0 });

    try {
      render(<StatefulWorkspace initialEvent={calendarEvent} />);
      await screen.findByText(/Results are current/);
      fetchEventResults.mockClear();
      const finalizeSection = () =>
        document.getElementById("organizer-finalize");
      const grid = () =>
        screen.getByRole("grid", { name: /^Meeting time calendar/ });
      const selectedBlock = () =>
        document.querySelector(".meeting-calendar__block--selected");

      await userEvent.click(calendarCell(1));
      expect(finalizeSection()).toHaveTextContent("Custom window");
      expect(finalizeSection()).toHaveAttribute("open");
      expect(selectedBlock()).not.toBeNull();

      // Opening Blocked times turns the calendar into the paint surface: the
      // pick's outline steps aside while the pick itself stays.
      const blockedTimes = document
        .getElementById("organizer-results")
        .querySelector("details.organizer-blocked-times");
      expect(blockedTimes).not.toHaveAttribute("open");
      expect(blockedTimes).toHaveTextContent("0 slots blocked");
      await userEvent.click(blockedTimes.querySelector("summary"));
      expect(blockedTimes).toHaveAttribute("open");
      expect(grid()).toHaveAccessibleName(/, marking blocked times$/);
      expect(selectedBlock()).toBeNull();
      expect(finalizeSection()).toHaveTextContent("Custom window");

      fireEvent.pointerDown(calendarCell(3), {
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
      });
      expect(calendarCell(3)).toHaveAttribute("data-blocked-paint", "true");
      expect(finalizeSection()).toHaveTextContent("Custom window");
      // The tools sit in a bar under the calendar, not in the step.
      const paintBar = screen.getByRole("region", {
        name: "Blocked times tools",
      });
      expect(paintBar.previousElementSibling).toHaveClass("meeting-calendar");
      await userEvent.click(
        within(paintBar).getByRole("button", { name: "Save blocked times" }),
      );

      await waitFor(() =>
        expect(updateEvent).toHaveBeenCalledWith(
          event.code,
          { blockedSlots: { "date:2026-08-20": [3] }, expectedVersion: 2 },
          "token",
        ),
      );
      expect(
        await within(paintBar).findByText("Blocked times saved."),
      ).toBeInTheDocument();
      // The workspace stored the event, re-read the results, and dropped the
      // pick; the step stays open and keeps painting.
      await waitFor(() => expect(fetchEventResults).toHaveBeenCalledTimes(1));
      expect(calendarCell(3)).toHaveAttribute("data-blocked-paint", "true");
      expect(finalizeSection()).toHaveTextContent("No time selected yet");
      expect(finalizeSection()).toHaveAttribute("open");
      expect(blockedTimes).toHaveTextContent("1 slots blocked");
      expect(blockedTimes).toHaveAttribute("open");

      // Closing the step hands the calendar back: the saved block is greyed.
      await userEvent.click(blockedTimes.querySelector("summary"));
      expect(blockedTimes).not.toHaveAttribute("open");
      expect(grid().getAttribute("aria-label")).not.toMatch(
        /marking blocked times/,
      );
      expect(grid().querySelector("[data-blocked-paint]")).toBeNull();
      expect(calendarCell(3)).toHaveAttribute("data-blocked-slot", "true");
      expect(calendarCell(3)).toHaveAttribute("aria-disabled", "true");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("picks a custom window on the calendar and finalizes it", async () => {
    mockCalendarWindowFlow();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));

    try {
      const setEvent = jest.fn();
      renderView(setEvent, calendarEvent);
      await screen.findByText(/Results are current/);

      // The step re-keys on every new selection, so query it fresh.
      const finalizeSection = () =>
        document.getElementById("organizer-finalize");
      expect(finalizeSection()).toHaveTextContent("No time selected yet");
      expect(screen.queryByText("Custom window")).not.toBeInTheDocument();

      const cell = calendarCell(1);
      expect(cell).toHaveAttribute("data-state", "startable");
      expect(cell).not.toHaveAttribute("aria-disabled");
      await userEvent.click(cell);

      expect(finalizeSection()).toHaveTextContent("Custom window");
      expect(finalizeSection()).toHaveTextContent("In person");
      expect(finalizeSection()).toHaveTextContent(/9:30/);
      // The estimate is the lowest per-slot share across slots 1 and 2.
      expect(finalizeSection()).toHaveTextContent(
        "Up to 50% weighted · 60% unweighted across this window (its lowest slot; people must be free for all of it).",
      );
      expect(finalizeSection()).toHaveAttribute("open");
      expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
      });
      expect(cell).toHaveAttribute("aria-selected", "true");
      expect(calendarCell(2)).toHaveAttribute("aria-selected", "true");
      expect(calendarCell(0)).not.toHaveAttribute("aria-selected");

      // The attendance is read as soon as the window is picked.
      await waitFor(() =>
        expect(previewFinalMeeting).toHaveBeenCalledWith(
          event.code,
          {
            startsAt: "2026-08-20T09:30:00Z",
            endsAt: "2026-08-20T10:30:00Z",
            channel: "inperson",
          },
          "token",
        ),
      );
      expect(
        await screen.findByRole("group", { name: "Attendance review" }),
      ).toBeInTheDocument();

      // Nobody was invited by email: finalizing goes ahead without email.
      // The email is asked for with the location as it stands at the click.
      await finalizeThroughReview();
      expect(previewFinalMeeting).toHaveBeenLastCalledWith(
        event.code,
        {
          startsAt: "2026-08-20T09:30:00Z",
          endsAt: "2026-08-20T10:30:00Z",
          channel: "inperson",
          location: "Room 1",
        },
        "token",
      );
      await waitFor(() =>
        expect(confirmFinalMeeting).toHaveBeenCalledWith(
          event.code,
          expect.objectContaining({
            startsAt: "2026-08-20T09:30:00Z",
            endsAt: "2026-08-20T10:30:00Z",
            channel: "inperson",
            expectedVersion: 2,
            idempotencyKey: "request-key",
          }),
          "token",
        ),
      );
      expect(setEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: "finalized" }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("reactivating a finalized event clears the previously chosen window", async () => {
    mockCalendarWindowFlow();
    previewEventLifecycle.mockResolvedValue({
      cancellation: {
        recipientCount: 2,
        email: {
          from: "noreply@releviz.local",
          replyTo: "",
          to: "Ada Faculty <ada@example.com>",
          subject: "Big event was canceled",
          html: "<!doctype html><p>Canceled</p>",
          text: "Canceled",
          attachments: ["meeting.ics"],
        },
        sample: { name: "Ada Faculty", email: "ada@example.com" },
      },
    });
    updateEventLifecycle.mockResolvedValue({
      event: {
        ...calendarEvent,
        status: "active",
        version: 4,
        finalMeeting: null,
      },
      cancellationDeliveryRequestId: "cancel-1",
      cancellationEnqueued: 2,
    });
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));

    try {
      render(<StatefulWorkspace initialEvent={calendarEvent} />);
      await screen.findByText(/Results are current/);
      const finalizeSection = () =>
        document.getElementById("organizer-finalize");
      const headerStatus = () =>
        screen.getByTestId("organizer-header-event-status");

      await userEvent.click(calendarCell(1));
      expect(finalizeSection()).toHaveTextContent("Custom window");
      await screen.findByRole("group", { name: "Attendance review" });
      await finalizeThroughReview();
      await waitFor(() =>
        expect(headerStatus()).toHaveTextContent("finalized"),
      );
      expect(finalizeSection()).toHaveTextContent("Download calendar (.ics)");
      // The finalizing button left with the review: focus lands on the
      // confirmed meeting's Download, not on the page.
      expect(
        screen.getByRole("button", { name: "Download calendar (.ics)" }),
      ).toHaveFocus();
      // Picking is locked: no lists in Finalize, and the calendar draws the
      // confirmed meeting alone and ignores clicks.
      expect(document.getElementById("organizer-recommended-times")).toBeNull();
      expect(document.getElementById("organizer-other-times")).toBeNull();
      expect(
        document.querySelector(".meeting-calendar__block--selected"),
      ).toBeNull();
      expect(
        document.querySelector(".meeting-calendar__block--confirmed"),
      ).toHaveTextContent("Confirmed");
      await userEvent.click(calendarCell(0));
      expect(calendarCell(0)).not.toHaveAttribute("aria-selected");
      expect(finalizeSection()).toHaveTextContent("Download calendar (.ics)");
      expect(
        screen.getByText(
          "The meeting is finalized. Reactivate the event to collect new responses.",
        ),
      ).toBeInTheDocument();

      // Reopening tells the confirmation's recipients the meeting is
      // canceled, so their email is reviewed first.
      await userEvent.click(
        screen.getByRole("button", { name: "Reactivate event" }),
      );
      const review = await screen.findByRole("dialog", {
        name: "Reopen scheduling",
      });
      expect(previewEventLifecycle).toHaveBeenCalledWith(
        event.code,
        { status: "active", responseDeadline: calendarEvent.responseDeadline },
        "token",
      );
      expect(review).toHaveTextContent(
        "2 people who received the confirmation will be told the meeting is canceled.",
      );
      expect(updateEventLifecycle).not.toHaveBeenCalled();
      await userEvent.click(
        within(review).getByRole("button", { name: "Continue" }),
      );
      await userEvent.click(
        within(review).getByRole("button", {
          name: "Reopen and send 2 emails",
        }),
      );

      await waitFor(() =>
        expect(updateEventLifecycle).toHaveBeenCalledWith(
          event.code,
          expect.objectContaining({ status: "active", expectedVersion: 3 }),
          "token",
        ),
      );
      await waitFor(() => expect(headerStatus()).toHaveTextContent("active"));
      expect(
        await screen.findByLabelText("Event delivery progress"),
      ).toHaveTextContent("Final cancellation delivery");
      // The old pick is gone: the step is back to its empty state, and stays
      // open rather than folding away under the organizer.
      expect(finalizeSection()).toHaveTextContent("No time selected yet");
      expect(finalizeSection()).toHaveAttribute("open");
      // Nothing is recommended in this snapshot, so the prompt points at the
      // calendar and Other times only.
      expect(finalizeSection()).toHaveTextContent(
        "Pick a time on the calendar, or choose one under Other times above.",
      );
      expect(screen.queryByText("Custom window")).not.toBeInTheDocument();
      expect(screen.queryByText(/Recommended #/)).not.toBeInTheDocument();
      expect(calendarCell(1)).not.toHaveAttribute("aria-selected");
      // Picking is back: the lists return (closed) and a click picks again.
      expect(
        document.getElementById("organizer-other-times"),
      ).not.toHaveAttribute("open");
      await userEvent.click(calendarCell(0));
      expect(finalizeSection()).toHaveTextContent("Custom window");
      expect(
        screen.getAllByText("This event is active and accepting responses."),
      ).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("switches the calendar channel when a virtual result is chosen", async () => {
    fetchEventResults.mockResolvedValue({
      status: "fresh",
      requestedRevision: 3,
      computedRevision: 3,
      generatedAt: "2026-08-20T08:00:00Z",
      results: {
        recommendations: [
          {
            rank: 1,
            label: "Thursday 9:00 AM online",
            channel: "virtual",
            groupKey: "2026-08-20",
            slotIndices: [0, 1],
            suggestedStartsAt: "2026-08-20T09:00:00Z",
            suggestedEndsAt: "2026-08-20T10:00:00Z",
            weightedAvailability: 0.9,
            unweightedAvailability: 0.8,
            fullyAvailableParticipantTotal: 700,
          },
        ],
      },
    });
    renderView();
    await screen.findByText(/Results are current at revision 3/);

    const channelGroup = screen.getByRole("group", {
      name: "Meeting channel",
    });
    expect(
      within(channelGroup).getByRole("button", { name: "In person" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(channelGroup).getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "false");

    await toggleRecommendedTimes();
    await userEvent.click(
      screen.getByRole("button", { name: /choose this time/i }),
    );

    expect(
      within(channelGroup).getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(channelGroup).getByRole("button", { name: "In person" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: /selected time/i }),
    ).toHaveAttribute("aria-pressed", "true");
    const finalizeSection = document.getElementById("organizer-finalize");
    expect(finalizeSection).toHaveAttribute("open");
    expect(finalizeSection).toHaveTextContent("Thursday 9:00 AM online");
    expect(finalizeSection).toHaveTextContent("Virtual");
    expect(finalizeSection).toHaveTextContent("Recommended #1");
    expect(finalizeSection).not.toHaveTextContent("In person");
    expect(
      document.getElementById("organizer-recommended-times"),
    ).toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: /selected time/i }),
    ).toHaveFocus();
  });

  test("selects a legacy recommendation without moving the page", async () => {
    fetchEventResults.mockResolvedValueOnce({
      status: "fresh",
      requestedRevision: 3,
      computedRevision: 3,
      results: {
        recommendations: [
          {
            rank: 1,
            label: "Legacy result",
            channel: "virtual",
            startsAt: "2026-08-20T09:00:00Z",
            endsAt: "2026-08-20T10:00:00Z",
            weightedAvailability: 0.8,
            unweightedAvailability: 0.7,
            fullyAvailableParticipantTotal: 600,
          },
        ],
      },
    });
    renderView();

    await screen.findByText("Legacy result");
    await toggleRecommendedTimes();
    await userEvent.click(
      screen.getByRole("button", { name: /choose this time/i }),
    );

    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Legacy result",
    );
  });

  test("a time chosen under Other times is selected without moving focus or the page", async () => {
    mockCalendarWindowFlow();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));
    try {
      renderView(jest.fn(), calendarEvent);
      await screen.findByText(/Results are current/);
      const finalize = document.getElementById("organizer-finalize");
      await userEvent.click(finalize.querySelector(":scope > summary"));
      const other = document.getElementById("organizer-other-times");
      await userEvent.click(other.querySelector(":scope > summary"));
      const firstTime = within(
        other.querySelector(".ranked-chips"),
      ).getAllByRole("button")[0];
      await userEvent.click(firstTime);

      expect(finalize).toHaveTextContent("Custom window");
      // The chip turns pressed and keeps focus; the list stays open.
      expect(firstTime).toHaveAttribute("aria-pressed", "true");
      expect(firstTime).toHaveFocus();
      expect(other).toHaveAttribute("open");
      expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
      // The calendar shows the pick too.
      expect(calendarCell(0)).toHaveAttribute("aria-selected", "true");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("with the calendar pinned, a calendar pick focuses Finalize without a manual scroll", async () => {
    mockCalendarWindowFlow();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));
    const originalStyle = window.getComputedStyle;
    // Stylesheets do not load in jsdom: report the pinned calendar sticky.
    const styleSpy = jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, ...rest) => {
        const style = originalStyle(element, ...rest);
        return element.matches?.(".meeting-results--pinned > .meeting-calendar")
          ? { ...style, position: "sticky" }
          : style;
      });
    try {
      renderView(jest.fn(), calendarEvent);
      await screen.findByText(/Results are current/);
      const finalize = document.getElementById("organizer-finalize");
      await userEvent.click(finalize.querySelector(":scope > summary"));
      const other = document.getElementById("organizer-other-times");
      await userEvent.click(other.querySelector(":scope > summary"));
      expect(document.querySelector(".meeting-results")).toHaveClass(
        "meeting-results--picking",
      );

      await userEvent.click(calendarCell(1));
      expect(finalize).toHaveTextContent("Custom window");
      // The page's scroll-padding keeps clear of the pinned calendar, so a
      // plain focus does the scrolling.
      expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
      expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      styleSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  test("a calendar pick brings Finalize into view, honoring reduced motion", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    mockCalendarWindowFlow();
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-01T00:00:00Z"));
    try {
      renderView(jest.fn(), calendarEvent);
      await screen.findByText(/Results are current/);
      await userEvent.click(calendarCell(1));

      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "nearest",
      });
      // The pick's own content, not the whole step (the Recommended times
      // above it can make the step taller than the screen).
      expect(HTMLElement.prototype.scrollIntoView.mock.contexts).toContain(
        document.querySelector("#organizer-finalize .finalize-block__body"),
      );
      expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
    } finally {
      nowSpy.mockRestore();
    }
  });

  describe("live sync", () => {
    // The pace eases off after each quiet pass, from the fastest (3 s)
    // through these waits to the slowest (15 s), and snaps back on activity.
    const FASTEST = LIVE_REFRESH_FASTEST_MS;
    const EASED = [4500, 6750, 10125, 15000];

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      delete document.visibilityState;
      jest.useRealTimers();
    });

    async function renderLiveWorkspace(
      setEvent = jest.fn(),
      currentEvent = event,
    ) {
      const view = renderView(setEvent, currentEvent);
      await screen.findByText("Ada Faculty");
      await screen.findByText(/Results are current at revision 3/);
      fetchEvent.mockClear();
      fetchRoster.mockClear();
      fetchEventResults.mockClear();
      fetchEventActivity.mockClear();
      return view;
    }

    async function tick(ms = FASTEST) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }

    function setTabVisibility(state) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    }

    // While the server pushes, the poll only checks once a minute.
    const BACKSTOP = LIVE_REFRESH_BACKSTOP_PACE.fastestMs;

    // Pushes one of the server's frames into the newest stream, inside act
    // so the workspace's reaction to it settles.
    async function pushFrame(name, ...args) {
      await act(async () => {
        streams.at(-1).handlers[name](...args);
      });
    }

    test("loads a new response into every section on its own and keeps the pick", async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const { setEvent } = await renderLiveWorkspace();
      await user.click(
        screen.getByRole("button", { name: /choose this time/i }),
      );
      const finalize = document.getElementById("organizer-finalize");
      expect(finalize).toHaveTextContent("Thursday 9:00 AM");
      expect(screen.getByTestId("live-sync")).toHaveTextContent("Live");
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "no",
      );

      // Ada submits: the digest moves for the event revision, the roster,
      // and the (now recomputing) results.
      const moved = {
        ...rosterActivity,
        submitted: 1,
        changedAt: "2026-08-20T09:00:00Z",
      };
      fetchEventActivity.mockResolvedValue(
        activityWith({
          event: { resultsRevision: 4 },
          results: { status: "refreshing", requestedRevision: 4 },
          roster: moved,
        }),
      );
      fetchRoster.mockResolvedValue({
        participants: [
          {
            id: "roster-1",
            memberId: "member-1",
            name: "Ada Faculty",
            email: "ada@example.com",
            group: "Faculty",
            weight: 0.8,
            included: true,
            submitted: true,
            accountAccess: "temporary",
            canOrganizerEditAvailability: true,
            invitationStatus: "submitted",
            version: 2,
          },
        ],
        pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
        stats: {
          total: 1,
          submitted: 1,
          notSubmitted: 0,
          included: 1,
          excluded: 0,
          groups: [{ name: "Faculty", count: 1 }],
        },
        activity: moved,
      });
      fetchEventResults.mockResolvedValue({
        status: "refreshing",
        requestedRevision: 4,
        computedRevision: 3,
        generatedAt: "2026-08-20T08:00:00Z",
        results: {
          recommendations: [
            {
              rank: 1,
              label: "Thursday 9:00 AM",
              channel: "inperson",
              suggestedStartsAt: "2026-08-20T09:00:00Z",
              suggestedEndsAt: "2026-08-20T10:00:00Z",
              weightedAvailability: 0.95,
              unweightedAvailability: 0.9,
              fullyAvailableParticipantTotal: 701,
            },
          ],
        },
      });

      await tick();
      await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(1));
      expect(fetchEventActivity).toHaveBeenCalledWith(event.code, "token");
      expect(fetchRoster).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({ page: 1, pageSize: 50 }),
        "token",
      );
      expect(
        await screen.findByText(/Results are updating for revision 4/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/· 1 submitted · 0 not submitted ·/),
      ).toBeInTheDocument();
      // Only the revision moved, so the event is patched rather than re-read.
      expect(fetchEvent).not.toHaveBeenCalled();
      expect(setEvent).toHaveBeenCalledWith({ ...event, resultsRevision: 4 });
      // The organizer's pick and the silent nature of the pass both hold.
      expect(finalize).toHaveTextContent("Thursday 9:00 AM");
      expect(
        screen.queryByText("Loading participants…"),
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveAttribute(
          "data-updated",
          "yes",
        ),
      );
      expect(screen.getByTestId("live-sync")).toHaveTextContent("Live");
    });

    test("leaves every section alone while the digest matches what is shown", async () => {
      const { setEvent } = await renderLiveWorkspace();
      await tick();
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // A quiet pass eases the pace off, so the next one waits longer.
      await tick(EASED[0]);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      expect(fetchEvent).not.toHaveBeenCalled();
      expect(fetchRoster).not.toHaveBeenCalled();
      expect(fetchEventResults).not.toHaveBeenCalled();
      expect(setEvent).not.toHaveBeenCalled();
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "no",
      );

      // A digest without a revision does not touch the event either.
      fetchEventActivity.mockResolvedValue({
        ...baseActivity,
        event: { version: 2, status: "active" },
      });
      await tick(EASED[1]);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      expect(setEvent).not.toHaveBeenCalled();
    });

    test("re-reads the event when it changed in another session and tolerates an event-less reply", async () => {
      const { setEvent } = await renderLiveWorkspace();
      fetchEventActivity.mockResolvedValue(
        activityWith({ event: { version: 3 } }),
      );
      fetchEvent.mockResolvedValueOnce({ event: { ...event, version: 3 } });
      await tick();
      await waitFor(() =>
        expect(setEvent).toHaveBeenCalledWith(
          expect.objectContaining({ code: event.code, version: 3 }),
        ),
      );
      expect(fetchEvent).toHaveBeenCalledWith(event.code, "token");
      expect(fetchRoster).not.toHaveBeenCalled();
      expect(fetchEventResults).not.toHaveBeenCalled();

      setEvent.mockClear();
      fetchEvent.mockResolvedValueOnce({});
      await tick();
      await waitFor(() => expect(fetchEvent).toHaveBeenCalledTimes(2));
      expect(setEvent).not.toHaveBeenCalled();
    });

    test("skips a hidden tab and catches up the moment it is shown again", async () => {
      await renderLiveWorkspace();
      setTabVisibility("hidden");
      await tick();
      await tick();
      expect(fetchEventActivity).not.toHaveBeenCalled();
      // Going hidden (again) is not a trigger.
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetchEventActivity).not.toHaveBeenCalled();

      setTabVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      // The pace then continues from the catch-up pass, which found nothing.
      await tick(EASED[0] - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
    });

    test("reports a failed pass in the header and recovers on the next one", async () => {
      await renderLiveWorkspace();
      fetchEventActivity.mockRejectedValueOnce(new Error("offline"));
      await tick();
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent(
          "New responses could not be loaded automatically (offline).",
        ),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // A section that fails to re-read is reported the same way.
      fetchEventActivity.mockResolvedValueOnce(
        activityWith({ roster: { submitted: 1 } }),
      );
      fetchRoster.mockRejectedValueOnce(new Error(""));
      // A failed pass eases the pace off like a quiet one.
      await tick(EASED[0]);
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent(
          "New responses could not be loaded automatically.",
        ),
      );
      // The roster keeps what it showed; nothing was replaced by an error.
      expect(screen.getByText("Ada Faculty")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // The next clean pass clears the notice even though nothing changed.
      await tick(EASED[1]);
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent("Live"),
      );
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "no",
      );
    });

    test("never overlaps its own passes", async () => {
      await renderLiveWorkspace();
      // A pass still waiting on the digest is not doubled by a catch-up.
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await tick();
      await waitFor(() => expect(releaseActivity).toBeDefined());
      setTabVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await act(async () => {
        releaseActivity(baseActivity);
      });
      expect(fetchRoster).not.toHaveBeenCalled();
      // The catch-up it was asked for runs once it is done: exactly one
      // follow-up read of the digest, and the pace continues from that.
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      await tick(FASTEST);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      await tick(EASED[0]);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
    });

    test("waits for a section's first load before comparing it", async () => {
      let releaseRoster;
      fetchRoster.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRoster = resolve;
          }),
      );
      // Results never land in this test: the panel keeps polling its own
      // initial refreshing state, and there is nothing on screen to compare.
      fetchEventResults.mockImplementation(() => new Promise(() => {}));
      renderView();
      await waitFor(() => expect(releaseRoster).toBeDefined());
      fetchEventActivity.mockResolvedValue(
        activityWith({
          results: { computedRevision: 9 },
          roster: { submitted: 1 },
        }),
      );
      await tick();
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // Neither section has anything on screen to compare, so the pass
      // changes nothing and the roster is not re-read on top of its pending
      // first load.
      expect(fetchRoster).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "no",
      );

      await act(async () => {
        releaseRoster({
          participants: [],
          pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
          stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
          activity: rosterActivity,
        });
      });
      // Once the roster is on screen, the next pass compares and reloads it.
      fetchRoster.mockResolvedValue({
        participants: [],
        pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
        stats: { total: 1, submitted: 1, notSubmitted: 0, groups: [] },
        activity: { ...rosterActivity, submitted: 1 },
      });
      await tick(EASED[0]);
      await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveAttribute(
          "data-updated",
          "yes",
        ),
      );
    });

    test("eases off while nothing changes and snaps back when a response arrives", async () => {
      await renderLiveWorkspace();
      await tick();
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // Each quiet pass waits longer for the next, down to the slowest pace.
      for (const [index, wait] of EASED.entries()) {
        await tick(wait - 1);
        expect(fetchEventActivity).toHaveBeenCalledTimes(index + 1);
        await tick(1);
        await waitFor(() =>
          expect(fetchEventActivity).toHaveBeenCalledTimes(index + 2),
        );
      }
      await tick(EASED.at(-1));
      await waitFor(() =>
        expect(fetchEventActivity).toHaveBeenCalledTimes(EASED.length + 2),
      );

      // A response arrives: the pass that loads it brings the next one close
      // behind it again.
      fetchEventActivity.mockResolvedValue(
        activityWith({ event: { resultsRevision: 4 } }),
      );
      await tick(EASED.at(-1));
      await waitFor(() =>
        expect(fetchEventActivity).toHaveBeenCalledTimes(EASED.length + 3),
      );
      await tick(FASTEST - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(EASED.length + 3);
      await tick(1);
      await waitFor(() =>
        expect(fetchEventActivity).toHaveBeenCalledTimes(EASED.length + 4),
      );
    });

    test("checks at once when the window regains focus or the network returns", async () => {
      await renderLiveWorkspace();
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      // The pace restarts from the catch-up pass, which found nothing.
      await tick(EASED[0] - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
    });

    test("keeps the pace up while the organizer is working in the page", async () => {
      await renderLiveWorkspace();
      await tick();
      await tick(EASED[0]);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      // The next pass is 6.75 s out; a click pulls it in to the fastest pace.
      await tick(1000);
      await act(async () => {
        document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      await tick(FASTEST - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      // A pass already close by keeps its slot, but the pace after it
      // restarts from the fastest: 4.5 s rather than 6.75 s.
      await tick(2000);
      await act(async () => {
        document.dispatchEvent(new Event("keydown", { bubbles: true }));
      });
      await tick(EASED[0] - 2000 - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(4));
      await tick(EASED[0] - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(4);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(5));
    });

    test("polls a closed event at the idle pace, with no live line", async () => {
      fetchEventActivity.mockResolvedValue(
        activityWith({ event: { status: "closed" } }),
      );
      renderView(jest.fn(), { ...event, status: "closed" });
      await screen.findByText("Ada Faculty");
      fetchEventActivity.mockClear();
      fetchEvent.mockClear();
      expect(screen.queryByTestId("live-sync")).not.toBeInTheDocument();
      // Responses cannot arrive, so the first check waits 15 s rather than
      // 3 s, and each quiet one waits half again as long, up to a minute.
      const { fastestMs } = LIVE_REFRESH_IDLE_PACE;
      await tick(FASTEST * 2);
      expect(fetchEventActivity).not.toHaveBeenCalled();
      await tick(fastestMs - FASTEST * 2);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      await tick(fastestMs * 1.5 - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      expect(fetchEvent).not.toHaveBeenCalled();
      expect(screen.queryByTestId("live-sync")).not.toBeInTheDocument();
    });

    test("notices a reactivation made in another session and switches to the live pace", async () => {
      // The first idle pass fails: a closed event shows no live line, so the
      // paused notice stays out of sight until a clean pass clears it.
      fetchEventActivity
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(activityWith({ event: { version: 3 } }));
      render(
        <StatefulWorkspace initialEvent={{ ...event, status: "closed" }} />,
      );
      await screen.findByText("Ada Faculty");
      fetchEventActivity.mockClear();
      fetchEvent.mockClear();
      const { fastestMs } = LIVE_REFRESH_IDLE_PACE;
      await tick(fastestMs);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("live-sync")).not.toBeInTheDocument();
      // The failed pass eases off, so the next one is 22.5 s out. It finds
      // the event at a newer version and re-reads it: the event is active.
      await tick(fastestMs * 1.5);
      await waitFor(() =>
        expect(fetchEvent).toHaveBeenCalledWith(event.code, "token"),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("organizer-header-event-status"),
        ).toHaveTextContent("active"),
      );
      // The live line is back and clean, and the next check is 3 s out.
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent("Live"),
      );
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "yes",
      );
      fetchEventActivity.mockClear();
      await tick(FASTEST);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
    });

    test("opens the event stream while the tab is visible and closes it on unmount", async () => {
      const { unmount } = await renderLiveWorkspace();
      expect(connectLiveStream).toHaveBeenCalledTimes(1);
      // The connection fetches this event's stream with the signal it is
      // handed, so closing can abort the request.
      const { signal } = new AbortController();
      streams[0].handlers.open(signal);
      expect(openEventStream).toHaveBeenCalledWith(event.code, { signal });
      expect(streams[0].close).not.toHaveBeenCalled();
      unmount();
      expect(streams[0].close).toHaveBeenCalledTimes(1);
      expect(connectLiveStream).toHaveBeenCalledTimes(1);
    });

    test("runs one catch-up pass when the stream opens, then only a backstop check a minute later", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // The live pace would check again 3 s on; the backstop waits a minute,
      // and a quiet check does not ease it off any further.
      await tick(BACKSTOP - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      await tick(BACKSTOP - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      expect(screen.getByTestId("live-sync")).toHaveTextContent("Live");
    });

    test("runs one pass per change frame and coalesces a change that arrives mid-pass", async () => {
      // A delivery run still in progress reads on the same pushed changes.
      window.sessionStorage.setItem(
        `releviz.delivery-request.${event.code}`,
        JSON.stringify({
          id: "stored-delivery",
          operation: "invitation",
          delivery: { total: 5, pending: 1, sent: 4 },
        }),
      );
      fetchDeliveryRequest.mockResolvedValue({
        deliveryRequest: {
          id: "stored-delivery",
          operation: "invitation",
          delivery: { total: 5, pending: 1, sent: 4 },
        },
      });
      await renderLiveWorkspace();
      await screen.findByLabelText("Event delivery progress");
      // The stream opening is one catch-up pass, and one catch-up read of
      // the run.
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(fetchDeliveryRequest).toHaveBeenCalledTimes(1),
      );

      // A change: one pass, and the delivery card reads at once too.
      await pushFrame("onChange");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(fetchDeliveryRequest).toHaveBeenCalledTimes(2),
      );

      // Two more changes arrive while the pass for a third is still waiting
      // on the digest: together they are worth one more pass after it, not
      // two, and not a concurrent one.
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await pushFrame("onChange");
      await waitFor(() => expect(releaseActivity).toBeDefined());
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
      await pushFrame("onChange");
      await pushFrame("onChange");
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
      await act(async () => {
        releaseActivity(baseActivity);
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(4));
      // Then nothing until the backstop; the card read on every change.
      await tick(FASTEST * 2);
      expect(fetchEventActivity).toHaveBeenCalledTimes(4);
      expect(fetchDeliveryRequest).toHaveBeenCalledTimes(5);
    });

    test("a delivery run in progress is read at once whenever the stream opens", async () => {
      // A run restored on page load may have moved while the page was away,
      // and one may move while the stream is down: the card catches up the
      // moment the stream is up rather than at the backstop a minute on.
      window.sessionStorage.setItem(
        `releviz.delivery-request.${event.code}`,
        JSON.stringify({
          id: "stored-delivery",
          operation: "invitation",
          delivery: { total: 5, pending: 3, sent: 2 },
        }),
      );
      fetchDeliveryRequest.mockResolvedValue({
        deliveryRequest: {
          id: "stored-delivery",
          operation: "invitation",
          delivery: { total: 5, pending: 1, sent: 4 },
        },
      });
      await renderLiveWorkspace();
      const card = await screen.findByLabelText("Event delivery progress");
      expect(card).toHaveTextContent("2 sent");
      await pushFrame("onOpen");
      await waitFor(() => expect(card).toHaveTextContent("4 sent"));
      expect(fetchDeliveryRequest).toHaveBeenCalledTimes(1);

      // The stream drops and the last emails go out before it is back.
      fetchDeliveryRequest.mockResolvedValue({
        deliveryRequest: {
          id: "stored-delivery",
          operation: "invitation",
          delivery: { total: 5, sent: 5 },
        },
      });
      await pushFrame("onDown", "ended");
      await pushFrame("onOpen");
      await waitFor(() => expect(card).toHaveTextContent("5 sent"));
      expect(fetchDeliveryRequest).toHaveBeenCalledTimes(2);
      expect(card).toHaveTextContent("Complete");
    });

    test("a change pushed during a trigger pass still gets its own pass", async () => {
      await renderLiveWorkspace();
      // The window regains focus while the stream is still opening, and the
      // catch-up pass waits on the digest ...
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(releaseActivity).toBeDefined());
      // ... the stream opens meanwhile, which hands the pace to a fresh
      // backstop scheduler, and a change is pushed: the pass it asks for
      // finds the first one still running and is put off ...
      await pushFrame("onOpen");
      await pushFrame("onChange");
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      // ... until that one is done, and then runs exactly once.
      await act(async () => {
        releaseActivity(baseActivity);
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      await tick(FASTEST * 2);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
    });

    test("a wake that reaches a new scheduler during the old one's pass runs right after it", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // The window regains focus, and that pass waits on the digest ...
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(releaseActivity).toBeDefined());
      // ... when the stream drops, which hands the pace to a fresh
      // live-pace scheduler, and the network returning wakes that one: its
      // pass finds the first one still running and is put off ...
      await pushFrame("onDown", "interrupted");
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      // ... until that one is done, and then runs exactly once.
      await act(async () => {
        releaseActivity(baseActivity);
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      await tick(FASTEST);
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
    });

    test("a stream that opens during a poll pass gets its catch-up pass right after it", async () => {
      await renderLiveWorkspace();
      // A poll pass waits on the digest ...
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await tick(FASTEST);
      await waitFor(() => expect(releaseActivity).toBeDefined());
      // ... when the stream opens. The pass was reading before the server
      // started listening, so a write in between is only caught by the
      // catch-up pass, which must survive the poll scheduler being swapped
      // for the backstop one while it waits.
      await pushFrame("onOpen");
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await act(async () => {
        releaseActivity(baseActivity);
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      // Exactly one, and then the backstop.
      await tick(FASTEST * 2);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
    });

    test("a change pushed during a pass just before the stream drops gets its pass right after it", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // A change's pass waits on the digest ...
      let releaseActivity;
      fetchEventActivity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseActivity = resolve;
          }),
      );
      await pushFrame("onChange");
      await waitFor(() => expect(releaseActivity).toBeDefined());
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      // ... when another change arrives and the stream ends right behind
      // it, which swaps the backstop scheduler for one at the live pace.
      await act(async () => {
        streams.at(-1).handlers.onChange();
        streams.at(-1).handlers.onDown("ended");
      });
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      // The change is read as soon as the running pass is done, not at the
      // new scheduler's first turn, and only once.
      await act(async () => {
        releaseActivity(baseActivity);
      });
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      await tick(FASTEST);
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
    });

    test("falls back to the live pace while the stream is down and returns to the backstop when it reopens", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // The stream drops: the next check is 3 s out rather than a minute.
      await pushFrame("onDown", "ended");
      await tick(FASTEST - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      // It reopens: one catch-up pass, then the backstop again.
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      await tick(BACKSTOP - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(4));
      // The server declining the stream hands the pace back the same way.
      await pushFrame("onUnavailable");
      await tick(FASTEST - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(4);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(5));
      // A second report of the same state changes nothing: the quiet check
      // eased the pace off, and it stays eased off.
      await pushFrame("onDown", "interrupted");
      await tick(EASED[0] - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(5);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(6));
    });

    test("a pushed pass that fails is retried seconds later, not at the backstop a minute on", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      // A change is pushed while a deploy drains the task that would serve
      // the digest, so its pass fails and the header says so.
      fetchEventActivity.mockRejectedValueOnce(new Error("Bad gateway"));
      await pushFrame("onChange");
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("live-sync")).toHaveTextContent(
        "New responses could not be loaded automatically (Bad gateway).",
      );
      // The pass is tried again at the live pace's first backoff, 4.5 s on.
      await tick(EASED[0] - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(2);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      // It gets through, which clears the notice, and the next check is the
      // backstop's a minute on.
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent("Live"),
      );
      await tick(BACKSTOP - 1);
      expect(fetchEventActivity).toHaveBeenCalledTimes(3);
      await tick(1);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(4));
    });

    test("closes the stream while the tab is hidden and reconnects when it is shown", async () => {
      await renderLiveWorkspace();
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(1));
      setTabVisibility("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(streams[0].close).toHaveBeenCalledTimes(1);
      expect(connectLiveStream).toHaveBeenCalledTimes(1);
      // Nothing is read while hidden, at either pace.
      await tick(BACKSTOP);
      expect(fetchEventActivity).toHaveBeenCalledTimes(1);
      // Shown again: a fresh stream, and the usual catch-up pass at once.
      setTabVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(connectLiveStream).toHaveBeenCalledTimes(2);
      expect(streams[1].close).not.toHaveBeenCalled();
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(2));
      // Until the fresh stream is open the poll runs at the live pace ...
      await tick(EASED[0]);
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(3));
      // ... and once it is, at the backstop again.
      await pushFrame("onOpen");
      await waitFor(() => expect(fetchEventActivity).toHaveBeenCalledTimes(4));
      await tick(FASTEST * 2);
      expect(fetchEventActivity).toHaveBeenCalledTimes(4);
    });

    test("ignores frames after the workspace is gone", async () => {
      const { unmount } = await renderLiveWorkspace();
      unmount();
      expect(streams[0].close).toHaveBeenCalledTimes(1);
      // Frames that were already on their way when the stream was closed.
      await pushFrame("onOpen");
      await pushFrame("onChange");
      await pushFrame("onDown", "ended");
      await pushFrame("onUnavailable");
      await tick(BACKSTOP);
      expect(fetchEventActivity).not.toHaveBeenCalled();
    });
  });

  test("shows the previous snapshot while a newer result revision is refreshing", async () => {
    fetchEventResults.mockResolvedValueOnce({
      status: "refreshing",
      requestedRevision: 4,
      computedRevision: 3,
      generatedAt: "2026-08-20T08:00:00Z",
      results: {
        recommendations: [
          {
            rank: 1,
            label: "Previous best window",
            channel: "virtual",
            suggestedStartsAt: "2026-08-20T09:00:00Z",
            suggestedEndsAt: "2026-08-20T10:00:00Z",
            weightedAvailability: 0.7,
            unweightedAvailability: 0.6,
            fullyAvailableParticipantTotal: 600,
          },
        ],
      },
    });
    renderView();

    expect(
      await screen.findByText(/Results are updating for revision 4/),
    ).toHaveTextContent("Showing the last successful snapshot meanwhile");
    // Named once in the collapsed summary and once in the list itself.
    // Named in the collapsed summary, on the chip, and in the detail line.
    expect(screen.getAllByText(/Previous best window/)).toHaveLength(3);
  });
});
