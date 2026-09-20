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
  OrganizerHeader: ({ event, onRefresh, refreshing, controls, live }) => (
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
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
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
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
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
  createRosterImport: jest.fn(),
  fetchRoster: jest.fn(),
  fetchRosterImportRows: jest.fn(),
  fetchRosterSchedule: jest.fn(),
  patchRosterBulk: jest.fn(),
  patchRosterParticipant: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import OrganizerScaleView from "@/components/schedule/OrganizerScaleView";
import {
  confirmFinalMeeting,
  fetchDeliveryRequest,
  fetchEvent,
  fetchEventActivity,
  fetchEventResults,
  previewFinalMeeting,
  sendReminders,
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
} from "@/lib/api/roster";

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
  columnMapping: {},
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
  await userEvent.click(screen.getByRole("button", { name: "Import roster" }));
  await userEvent.click(screen.getByRole("tab", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to mapping" }),
  );
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

async function openInvitePersonForm() {
  await screen.findByText("Ada Faculty");
  const rosterSection = document.getElementById("organizer-roster");
  await userEvent.click(
    within(rosterSection).getByRole("button", { name: "Invite person" }),
  );
  return {
    section: rosterSection,
    name: within(rosterSection).getByRole("textbox", { name: "Full name" }),
    email: within(rosterSection).getByRole("textbox", {
      name: "Email address",
    }),
    submit: within(rosterSection).getByRole("button", {
      name: "Add and send invitation",
    }),
  };
}

describe("scaled organizer workspace", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    window.history.replaceState({}, "", "/event?code=BIG1000");
    window.sessionStorage.clear();
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
        groups: [{ name: "Faculty", count: 1 }],
      },
      activity: rosterActivity,
    });
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
    fetchRosterSchedule.mockResolvedValue({
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
    });
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
      autoInvitedCount: 1,
      deliveryRequest: {
        id: "manual-delivery",
        operation: "invitation",
        recipientCount: 1,
        delivery: { total: 1, pending: 1, sent: 0 },
      },
    });
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
    const labels = ["Overview", "Results", "Roster"];

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
    expect(
      within(workspaceActions).getByRole("button", { name: "Refresh" }),
    ).toBeInTheDocument();
    // The header's Refresh is the only refresh control on the page.
    expect(screen.getAllByRole("button", { name: /refresh/i })).toEqual([
      within(workspaceActions).getByRole("button", { name: "Refresh" }),
    ]);
    // Finalize lives inside the results section, beside the calendar.
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

  test("refreshes the event, roster, and results as one workspace", async () => {
    const setEvent = jest.fn();
    renderView(setEvent);
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    fetchEvent.mockClear();
    fetchRoster.mockClear();
    fetchEventResults.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Workspace updated.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(fetchEvent).toHaveBeenCalledWith(event.code, "token");
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(fetchEventResults).toHaveBeenCalledTimes(1);
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: event.code, version: 3 }),
    );
  });

  test("ignores a second refresh while one is in flight and tolerates an event-less reply", async () => {
    const setEvent = jest.fn();
    let releaseEvent;
    fetchEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEvent = resolve;
        }),
    );
    renderView(setEvent);
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    fetchEvent.mockClear();
    fetchRoster.mockClear();

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await userEvent.click(refresh);
    expect(refresh).toBeDisabled();
    await waitFor(() => expect(releaseEvent).toBeDefined());
    // A second press during the first run is a no-op.
    fireEvent.click(refresh);
    expect(fetchEvent).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseEvent({});
    });
    expect(await screen.findByText("Workspace updated.")).toBeInTheDocument();
    expect(setEvent).not.toHaveBeenCalled();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
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
        "The event was saved, but the roster could not be refreshed.",
      ),
    ).toHaveAttribute("role", "alert");
  });

  test("reports a partial workspace refresh without discarding successful data", async () => {
    renderView();
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    fetchEventResults.mockRejectedValueOnce(new Error("results unavailable"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(
        "Unable to refresh results. Other workspace sections were updated.",
      ),
    ).toHaveAttribute("role", "alert");
  });

  test("reports a workspace refresh when authentication fails", async () => {
    const getToken = jest.fn().mockResolvedValue("token");
    useAuth.mockReturnValue({ user: organizer, loading: false, getToken });
    renderView();
    await screen.findByText("Ada Faculty");
    await screen.findByText(/Results are current at revision 3/);
    getToken.mockRejectedValueOnce(new Error(""));

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("Unable to refresh this workspace."),
    ).toHaveAttribute("role", "alert");
  });

  test("validates required invite fields and invalid email locally", async () => {
    renderView();
    const invite = await openInvitePersonForm();
    const form = invite.submit.closest("form");

    fireEvent.submit(form);
    expect(
      await screen.findByText("Full name is required."),
    ).toBeInTheDocument();
    expect(screen.getByText("Email address is required.")).toBeInTheDocument();
    expect(createManagedParticipant).not.toHaveBeenCalled();

    await userEvent.type(invite.name, "Manual Person");
    await userEvent.type(invite.email, "not-an-email");
    fireEvent.submit(form);
    expect(
      await screen.findByText("Enter a valid email address."),
    ).toBeInTheDocument();
    expect(createManagedParticipant).not.toHaveBeenCalled();
  });

  test("adds an active invitee and queues its invitation atomically", async () => {
    renderView();
    const invite = await openInvitePersonForm();
    await userEvent.type(invite.name, "Manual Person");
    await userEvent.type(invite.email, "manual@example.com");
    await userEvent.click(invite.submit);

    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        event.code,
        {
          name: "Manual Person",
          email: "manual@example.com",
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
    expect(await within(invite.section).findByRole("status")).toHaveTextContent(
      /^Manual Person is ready to respond\. Their invitation was queued\.$/,
    );
    expect(
      within(invite.section).queryByRole("heading", {
        name: "Invite someone to respond",
      }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");

    await userEvent.click(
      within(invite.section).getByRole("button", { name: "Invite person" }),
    );
    expect(
      within(invite.section).queryByRole("status"),
    ).not.toBeInTheDocument();

    const reopenedForm = within(invite.section)
      .getByRole("button", { name: "Add and send invitation" })
      .closest("form");
    fireEvent.submit(reopenedForm);

    expect(
      await within(invite.section).findByText("Full name is required."),
    ).toBeInTheDocument();
    expect(
      within(invite.section).getByText("Email address is required."),
    ).toBeInTheDocument();
    expect(
      within(invite.section).queryByText(
        "Manual Person is ready to respond. Their invitation was queued.",
      ),
    ).not.toBeInTheDocument();
  });

  test("does not claim a new invitation when the participant already exists", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
      },
      created: false,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    renderView();
    const invite = await openInvitePersonForm();
    await userEvent.type(invite.name, "Manual Person");
    await userEvent.type(invite.email, "manual@example.com");
    await userEvent.click(invite.submit);

    expect(await within(invite.section).findByRole("status")).toHaveTextContent(
      /^Manual Person is already on this roster\. No new invitation was sent\.$/,
    );
    expect(
      within(invite.section).queryByRole("heading", {
        name: "Invite someone to respond",
      }),
    ).not.toBeInTheDocument();
  });

  test("confirms the invitation when an archived participant is restored", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "manual-1",
        name: "Returning Person",
        email: "returning@example.com",
      },
      created: false,
      restored: true,
      autoInvitedCount: 1,
      deliveryRequest: {
        id: "restored-delivery",
        operation: "invitation",
        recipientCount: 1,
        delivery: { total: 1, pending: 1, sent: 0 },
      },
    });
    renderView();
    const invite = await openInvitePersonForm();
    await userEvent.type(invite.name, "Returning Person");
    await userEvent.type(invite.email, "returning@example.com");
    await userEvent.click(invite.submit);

    expect(await within(invite.section).findByRole("status")).toHaveTextContent(
      "Returning Person is ready to respond. Their invitation was queued.",
    );
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("disables invite submission while the person is being added", async () => {
    let resolveCreate;
    createManagedParticipant.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderView();
    const invite = await openInvitePersonForm();
    await userEvent.type(invite.name, "Manual Person");
    await userEvent.type(invite.email, "manual@example.com");

    fireEvent.click(invite.submit);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledTimes(1),
    );
    expect(invite.submit).toBeDisabled();
    fireEvent.click(invite.submit);
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    resolveCreate({
      participant: {
        id: "manual-1",
        name: "Manual Person",
        email: "manual@example.com",
      },
      created: true,
      autoInvitedCount: 1,
    });
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledTimes(1),
    );
  });

  test("keeps invite values and reuses the idempotency key after a failed request", async () => {
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
    const invite = await openInvitePersonForm();
    await userEvent.type(invite.name, "Manual Person");
    await userEvent.type(invite.email, "manual@example.com");
    await userEvent.click(invite.submit);

    expect(await within(invite.section).findByRole("alert")).toHaveTextContent(
      "delivery service unavailable",
    );
    expect(invite.name).toHaveValue("Manual Person");
    expect(invite.email).toHaveValue("manual@example.com");
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    await userEvent.click(invite.submit);
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
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  });

  test("clears persisted delivery progress when a request queues no recipients", async () => {
    const key = `releviz.delivery-request.${event.code}`;
    window.sessionStorage.setItem(key, JSON.stringify({ id: "old-request" }));
    sendReminders.mockResolvedValue({ recipientCount: 0 });
    renderView();
    await userEvent.click(
      screen.getByRole("button", { name: "Queue reminders" }),
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  });

  test("keeps a closed roster searchable but blocks every mutation control", async () => {
    renderView(jest.fn(), { ...event, status: "closed" });
    await screen.findByText("Ada Faculty");

    expect(screen.getByRole("note")).toHaveTextContent(
      "This roster is read-only while responses are closed",
    );
    expect(
      screen.queryByRole("button", { name: "Invite person" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import roster" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Bulk roster actions"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search roster")).toBeEnabled();
    expect(screen.getByLabelText("Filter by group")).toBeEnabled();
    expect(screen.getByLabelText("Select all on page")).toBeDisabled();
    expect(screen.getByLabelText("Select Ada Faculty")).toBeDisabled();
    expect(screen.getByLabelText("Group for Ada Faculty")).toBeDisabled();
    expect(screen.getByLabelText("Weight for Ada Faculty")).toBeDisabled();
    expect(screen.getByLabelText("Include Ada Faculty")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit schedule" }),
    ).toBeDisabled();
  });

  test("turns a genuinely empty roster into a focused invitation state", async () => {
    fetchRoster.mockResolvedValueOnce({
      participants: [],
      pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
      stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
    });

    renderView();

    expect(
      await screen.findByRole("heading", { name: "No participants yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Invite someone or import a roster to start collecting availability.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Invite person" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Import roster" }),
    ).toHaveLength(1);
    expect(screen.queryByLabelText("Search roster")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Bulk roster actions"),
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
    const populatedRoster = {
      participants: [
        {
          id: "roster-1",
          memberId: "member-1",
          name: "Ada Faculty",
          email: "ada@example.com",
          group: "Faculty",
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
        groups: [{ name: "Faculty", count: 1 }],
      },
    };
    const emptyFilteredRoster = {
      participants: [],
      pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
      stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
    };
    fetchRoster
      .mockReset()
      .mockResolvedValueOnce(populatedRoster)
      .mockResolvedValueOnce(emptyFilteredRoster)
      .mockResolvedValue(populatedRoster);

    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search roster"), "nobody");
    expect(
      await screen.findByRole("heading", { name: "No matching participants" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search roster")).toBeEnabled();
    expect(screen.getByLabelText("Filter by group")).toBeEnabled();
    expect(
      screen.queryByLabelText("Bulk roster actions"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rows per page")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    expect(screen.getByLabelText("Search roster")).toHaveValue("");
    expect(screen.getByLabelText("Filter by group")).toHaveValue("");
    expect(screen.getByLabelText("Filter by response")).toHaveValue("");
    expect(screen.getByLabelText("Filter by invitation")).toHaveValue("");
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({
          page: 1,
          search: "",
          group: "",
          submitted: "",
          invitationStatus: "",
        }),
        "token",
      ),
    );
  });

  test("loads a paginated roster and patches one row without full schedules", async () => {
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
      within(rosterSection).getByRole("group", { name: "Roster actions" }),
    ).toBeInTheDocument();
    const table = within(rosterSection).getByRole("table", {
      name: "Roster participants",
    });
    expect(
      within(table).getByRole("columnheader", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Status" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("rowheader", { name: /Ada Faculty/ }),
    ).toBeInTheDocument();
    const row = within(table)
      .getByRole("rowheader", { name: /Ada Faculty/ })
      .closest("tr");
    expect(row).toHaveAttribute("data-roster-participant-id", "roster-1");
    await userEvent.click(within(row).getByLabelText("Include Ada Faculty"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { included: false, expectedVersion: 1 },
        "token",
      ),
    );

    await userEvent.type(
      screen.getByLabelText("Search roster"),
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

  test("applies group weight and inclusion changes through one bulk patch", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    const bulk = screen.getByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    await userEvent.selectOptions(
      within(bulk).getByLabelText("Bulk update scope"),
      "group",
    );
    await userEvent.selectOptions(
      within(bulk).getByLabelText("Bulk update group"),
      "Faculty",
    );
    await userEvent.click(within(bulk).getByLabelText("Apply bulk weight"));
    fireEvent.change(within(bulk).getByLabelText("Bulk weight"), {
      target: { value: "0.4" },
    });
    await userEvent.click(
      within(bulk).getByLabelText("Apply bulk included status"),
    );
    await userEvent.click(within(bulk).getByLabelText("Bulk included"));
    await userEvent.click(
      within(bulk).getByRole("button", { name: "Apply update" }),
    );

    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          group: "Faculty",
          updates: { weight: 0.4, included: false },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
  });

  test("bulk updates require an explicit field and omit fields the organizer did not choose", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    const bulk = screen.getByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    await userEvent.click(screen.getByLabelText("Select Ada Faculty"));

    await userEvent.click(
      within(bulk).getByRole("button", { name: "Apply update" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a group, weight, included status, or a combination",
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();

    await userEvent.click(within(bulk).getByLabelText("Apply bulk weight"));
    fireEvent.change(within(bulk).getByLabelText("Bulk weight"), {
      target: { value: "0.25" },
    });
    await userEvent.click(
      within(bulk).getByRole("button", { name: "Apply update" }),
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
  });

  test("uses an explicit all selector for an unfiltered bulk update", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    const bulk = screen.getByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    await userEvent.selectOptions(
      within(bulk).getByLabelText("Bulk update scope"),
      "filter",
    );
    await userEvent.click(
      within(bulk).getByLabelText("Apply bulk included status"),
    );
    await userEvent.click(within(bulk).getByLabelText("Bulk included"));
    await userEvent.click(
      within(bulk).getByRole("button", { name: "Apply update" }),
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
    fetchRoster.mockResolvedValueOnce({
      participants: [],
      pagination: { page: 1, pageSize: 50, total: 0, pages: 0 },
      stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
      latestDeliveryRequest: {
        id: "recovered-delivery",
        operation: "invitation",
        delivery: { total: 3, pending: 2, sent: 1 },
      },
    });
    renderView();
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("2 queued");
  });

  test("restores durable delivery progress after a browser refresh", async () => {
    window.sessionStorage.setItem(
      `releviz.delivery-request.${event.code}`,
      JSON.stringify({
        id: "stored-delivery",
        operation: "final_confirmation",
        delivery: { total: 5, pending: 1, sent: 4 },
      }),
    );
    renderView();
    expect(
      await screen.findByLabelText("Event delivery progress"),
    ).toHaveTextContent("1 queued");
  });

  test("individual weight updates preserve included status", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: { id: "roster-1", weight: 0.35, included: true, version: 2 },
      resultsRevision: 4,
    });
    renderView();
    const weight = await screen.findByLabelText("Weight for Ada Faculty");
    fireEvent.change(weight, { target: { value: "0.35" } });
    fireEvent.blur(weight);

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { weight: 0.35, expectedVersion: 1 },
        "token",
      ),
    );
  });

  test("rolls an inline roster draft back when the server rejects it", async () => {
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Group is not allowed"), { status: 400 }),
    );
    renderView();
    const group = await screen.findByLabelText("Group for Ada Faculty");
    fireEvent.change(group, { target: { value: "Invalid group" } });
    expect(group).toHaveValue("Invalid group");
    fireEvent.blur(group);

    expect(await screen.findByText("Group is not allowed")).toBeInTheDocument();
    await waitFor(() => expect(group).toHaveValue("Faculty"));
  });

  test("serializes rapid updates to one roster row with the latest version", async () => {
    let resolveGroupUpdate;
    patchRosterParticipant
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGroupUpdate = resolve;
          }),
      )
      .mockResolvedValueOnce({
        participant: {
          id: "roster-1",
          group: "Research",
          included: false,
          version: 3,
        },
        resultsRevision: 5,
      });
    renderView();
    const group = await screen.findByLabelText("Group for Ada Faculty");
    fireEvent.change(group, { target: { value: "Research" } });
    fireEvent.blur(group);
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(1),
    );

    await userEvent.click(screen.getByLabelText("Include Ada Faculty"));
    expect(patchRosterParticipant).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveGroupUpdate({
        participant: {
          id: "roster-1",
          group: "Research",
          included: true,
          version: 2,
        },
        resultsRevision: 4,
      });
    });

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(2),
    );
    expect(patchRosterParticipant.mock.calls[1][2]).toEqual({
      included: false,
      expectedVersion: 2,
    });
  });

  test("pastes, maps, previews, and merges a roster import", async () => {
    mockRosterImportPreview();
    commitRosterImport.mockResolvedValue({
      autoInvitedCount: 1,
      deliveryRequest: {
        id: "import-delivery",
        recipientCount: 1,
        delivery: { total: 1, pending: 1 },
      },
      receipt: {
        importedCount: 1,
        createdCount: 1,
        updatedCount: 0,
        resultsRevision: 4,
      },
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
    await userEvent.click(
      screen.getByRole("button", {
        name: "Merge roster and invite new people",
      }),
    );

    await waitFor(() =>
      expect(commitRosterImport).toHaveBeenCalledWith(
        event.code,
        "import-1",
        { mode: "merge", idempotencyKey: "request-key" },
        "token",
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Import roster" }),
    ).toBeInTheDocument();
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
      screen.getByRole("radio", { name: /Rebuild the roster/ }),
    );

    const rebuildButton = screen.getByRole("button", {
      name: "Rebuild roster and send invitations",
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "sends a new invitation to every imported participant",
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
        },
        "token",
      ),
    );
    expect(setEvent).toHaveBeenCalledWith(rebuiltEvent);
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
    await userEvent.click(
      screen.getByRole("button", { name: "Choose this time" }),
    );
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Thursday 9:00 AM",
    );
    expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
    await userEvent.click(
      screen.getByRole("button", { name: "Review attendance" }),
    );
    expect(await screen.findByText("700")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Finalize meeting" }),
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
    });
    renderView(jest.fn(), { ...event, status: "active" });
    await screen.findByText(/Results are current at revision 3/);

    // Playwright's getByRole("heading", { name }) is a substring match, so
    // only the panel title and the Finalize step may mention them.
    expect(screen.getAllByRole("heading", { name: /results/i })).toEqual([
      screen.getByRole("heading", { level: 3, name: "Results" }),
    ]);
    expect(screen.getAllByRole("heading", { name: /finali[sz]/i })).toEqual([
      screen.getByRole("heading", { level: 4, name: "Finalize" }),
    ]);
    expect(
      screen.getByText("Top continuous windows for a 60-minute meeting.", {
        exact: false,
      }),
    ).toBeInTheDocument();

    // The pick buttons live in the ranked rail only; the calendar itself
    // exposes exactly one tab stop and no buttons.
    const rail = screen.getByRole("complementary", { name: "Ranked windows" });
    const chooseButtons = screen.getAllByRole("button", {
      name: "Choose this time",
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

    await userEvent.click(chooseButtons[0]);
    expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Selected time" }),
    ).toHaveAttribute("aria-pressed", "true");
    // Revealing the chosen window scrolls the calendar, never the page:
    // the only page scroll nudges the Finalize step into view if needed.
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
    );
    expect(HTMLElement.prototype.scrollIntoView.mock.contexts).toEqual([
      document.getElementById("organizer-finalize"),
    ]);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Review attendance" }),
    );
    await screen.findByText("Attendance review is current for this candidate.");
    // The attendance tile is the only element whose whole text is "Available":
    // the per-person table spells out "Fully available" instead.
    expect(screen.getAllByText("Available", { exact: true })).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Attendance by person" }))
        .getByRole("rowheader", { name: "Grace Faculty" })
        .closest("tr"),
    ).toHaveTextContent("Fully available · 100%");
    expect(screen.getAllByRole("heading", { name: /results/i })).toHaveLength(
      1,
    );
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

  test("keeps the empty Finalize step beside the calendar with no jump button", async () => {
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
    expect(finalizeSection.closest(".meeting-results__side")).not.toBeNull();
    // The ranked list beside it starts collapsed.
    const rail = screen.getByRole("complementary", { name: "Ranked windows" });
    expect(rail.querySelector("details")).not.toHaveAttribute("open");
  });

  test("the header refresh also re-reads visible delivery progress", async () => {
    const key = `releviz.delivery-request.${event.code}`;
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        id: "delivery-9",
        operation: "reminder",
        delivery: { total: 3, sent: 3 },
      }),
    );
    fetchDeliveryRequest.mockResolvedValue({
      id: "delivery-9",
      operation: "reminder",
      delivery: { total: 3, sent: 2, permanentFailure: 1 },
    });
    renderView();
    await screen.findByText("Ada Faculty");
    const progress = await screen.findByLabelText("Event delivery progress");
    expect(progress).toHaveTextContent("Complete");
    expect(
      within(progress).queryByRole("button", { name: /refresh/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(fetchDeliveryRequest).toHaveBeenCalledWith("delivery-9", "token"),
    );
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
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

      const cell = document.querySelector('[data-cell-idx="1"]');
      expect(cell).toHaveAttribute("data-state", "startable");
      expect(cell).not.toHaveAttribute("aria-disabled");
      await userEvent.click(cell);

      expect(finalizeSection()).toHaveTextContent("Custom window");
      expect(finalizeSection()).toHaveTextContent("In person");
      expect(finalizeSection()).toHaveTextContent(/9:30/);
      // The estimate is the lowest per-slot share across slots 1 and 2.
      expect(finalizeSection()).toHaveTextContent(
        "At least 50% weighted · 60% unweighted across this window (lowest slot). Exact attendance counts appear after Review attendance.",
      );
      expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
      expect(cell).toHaveAttribute("aria-selected", "true");
      expect(document.querySelector('[data-cell-idx="2"]')).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(document.querySelector('[data-cell-idx="0"]')).not.toHaveAttribute(
        "aria-selected",
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Review attendance" }),
      );
      await waitFor(() =>
        expect(previewFinalMeeting).toHaveBeenCalledWith(
          event.code,
          {
            startsAt: "2026-08-20T09:30:00Z",
            endsAt: "2026-08-20T10:30:00Z",
            channel: "inperson",
            location: "Room 1",
          },
          "token",
        ),
      );
      expect(
        await screen.findByRole("group", { name: "Attendance review" }),
      ).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Finalize meeting" }),
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
    updateEventLifecycle.mockResolvedValue({
      event: {
        ...calendarEvent,
        status: "active",
        version: 4,
        finalMeeting: null,
      },
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

      await userEvent.click(document.querySelector('[data-cell-idx="1"]'));
      expect(finalizeSection()).toHaveTextContent("Custom window");
      await userEvent.click(
        screen.getByRole("button", { name: "Review attendance" }),
      );
      await screen.findByRole("group", { name: "Attendance review" });
      await userEvent.click(
        screen.getByRole("button", { name: "Finalize meeting" }),
      );
      await waitFor(() =>
        expect(headerStatus()).toHaveTextContent("finalized"),
      );
      expect(finalizeSection()).toHaveTextContent("Download calendar (.ics)");
      expect(
        screen.getByText(
          "The meeting is finalized. Reactivate the event to collect new responses.",
        ),
      ).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Reactivate event" }),
      );

      await waitFor(() =>
        expect(updateEventLifecycle).toHaveBeenCalledWith(
          event.code,
          expect.objectContaining({ status: "active", expectedVersion: 3 }),
          "token",
        ),
      );
      await waitFor(() => expect(headerStatus()).toHaveTextContent("active"));
      // The old pick is gone: the step is back to its empty state.
      expect(finalizeSection()).toHaveTextContent("No time selected yet");
      expect(finalizeSection()).toHaveTextContent(
        "Pick a window on the calendar or choose a ranked one.",
      );
      expect(screen.queryByText("Custom window")).not.toBeInTheDocument();
      expect(screen.queryByText(/Ranked #/)).not.toBeInTheDocument();
      expect(document.querySelector('[data-cell-idx="1"]')).not.toHaveAttribute(
        "aria-selected",
      );
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

    await userEvent.click(
      screen.getByRole("button", { name: "Choose this time" }),
    );

    expect(
      within(channelGroup).getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(channelGroup).getByRole("button", { name: "In person" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Selected time" }),
    ).toHaveAttribute("aria-pressed", "true");
    const finalizeSection = document.getElementById("organizer-finalize");
    expect(finalizeSection).toHaveTextContent("Thursday 9:00 AM online");
    expect(finalizeSection).toHaveTextContent("Virtual");
    expect(finalizeSection).toHaveTextContent("Ranked #1");
    expect(finalizeSection).not.toHaveTextContent("In person");
    expect(screen.getByRole("heading", { name: "Finalize" })).toHaveFocus();
  });

  test("selects a legacy recommendation and honors reduced motion", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
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
    await userEvent.click(
      screen.getByRole("button", { name: "Choose this time" }),
    );

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
    });
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Legacy result",
    );
  });

  describe("live sync", () => {
    const LIVE_INTERVAL = 5000;

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

    async function tick(ms = LIVE_INTERVAL) {
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

    test("loads a new response into every section without Refresh and keeps the pick", async () => {
      const { setEvent } = await renderLiveWorkspace();
      await userEvent.click(
        screen.getByRole("button", { name: "Choose this time" }),
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
      expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
        "1 submitted",
      );
      // Only the revision moved, so the event is patched rather than re-read.
      expect(fetchEvent).not.toHaveBeenCalled();
      expect(setEvent).toHaveBeenCalledWith({ ...event, resultsRevision: 4 });
      // The organizer's pick and the silent nature of the pass both hold.
      expect(finalize).toHaveTextContent("Thursday 9:00 AM");
      expect(screen.queryByText("Workspace updated.")).not.toBeInTheDocument();
      expect(screen.queryByText("Loading roster…")).not.toBeInTheDocument();
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
      await tick();
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
      await tick();
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
      // The interval then continues from the catch-up pass.
      await tick(LIVE_INTERVAL - 1);
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
      await tick();
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent(
          "New responses could not be loaded automatically.",
        ),
      );
      // The roster keeps what it showed; nothing was replaced by an error.
      expect(screen.getByText("Ada Faculty")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // The next clean pass clears the notice even though nothing changed.
      await tick();
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveTextContent("Live"),
      );
      expect(screen.getByTestId("live-sync")).toHaveAttribute(
        "data-updated",
        "no",
      );
    });

    test("waits for a manual refresh and never overlaps its own passes", async () => {
      await renderLiveWorkspace();
      let releaseEvent;
      fetchEvent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseEvent = resolve;
          }),
      );
      await act(async () => {
        await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
      });
      await waitFor(() => expect(releaseEvent).toBeDefined());
      await tick();
      expect(fetchEventActivity).not.toHaveBeenCalled();
      await act(async () => {
        releaseEvent({ event: { ...event, version: 2 } });
      });
      expect(await screen.findByText("Workspace updated.")).toBeInTheDocument();
      fetchRoster.mockClear();

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
      await tick();
      await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTestId("live-sync")).toHaveAttribute(
          "data-updated",
          "yes",
        ),
      );
    });

    test("does not poll while responses are closed", async () => {
      renderView(jest.fn(), { ...event, status: "closed" });
      await screen.findByText("Ada Faculty");
      fetchEventActivity.mockClear();
      expect(screen.queryByTestId("live-sync")).not.toBeInTheDocument();
      await tick(LIVE_INTERVAL * 2);
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
    expect(screen.getAllByText(/Previous best window/)).toHaveLength(2);
  });
});
