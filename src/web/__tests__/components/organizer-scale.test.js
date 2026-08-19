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
    </div>
  ),
}));
jest.mock("@/components/schedule/OrganizerPanels", () => ({
  OrganizerHeader: ({ event, onRefresh, refreshing, controls }) => (
    <header>
      <h2>{event.name}</h2>
      <span data-testid="organizer-header-event-status">{event.status}</span>
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
  fetchEvent,
  fetchEventResults,
  previewFinalMeeting,
  sendReminders,
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
    });
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

    const sectionIds = [
      "organizer-overview",
      "organizer-roster",
      "organizer-results",
      "organizer-finalize",
    ];
    const labels = ["Overview", "Roster", "Results", "Finalize"];

    labels.forEach((label, index) => {
      expect(document.getElementById(sectionIds[index])).toHaveAccessibleName(
        label,
      );
    });
    expect(
      screen.queryByRole("navigation", { name: "Organizer sections" }),
    ).not.toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("main > section")).map(
        (section) => section.id,
      ),
    ).toEqual(sectionIds);
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

  test.each(["roster", "results", "finalize"])(
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
    expect(screen.getByLabelText("Weight for Faculty group")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Apply Weight to Faculty group",
      }),
    ).toBeDisabled();
    within(
      screen.getByRole("group", {
        name: "Quick Weight for Faculty group",
      }),
    )
      .getAllByRole("button")
      .forEach((button) => expect(button).toBeDisabled());
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
    const rosterWorkspace = screen.getByRole("region", {
      name: "Roster management",
    });
    expect(
      within(rosterWorkspace).queryByRole("region", { name: "Roster groups" }),
    ).not.toBeInTheDocument();
    expect(
      within(rosterWorkspace).queryByRole("table"),
    ).not.toBeInTheDocument();
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
    const rosterWorkspace = within(rosterSection).getByRole("region", {
      name: "Roster management",
    });
    const groupsPane = within(rosterWorkspace).getByRole("region", {
      name: "Roster groups",
    });
    const peoplePane = within(rosterWorkspace).getByRole("region", {
      name: "Roster people",
    });
    expect(rosterWorkspace.children[0]).toBe(groupsPane);
    expect(rosterWorkspace.children[1]).toBe(peoplePane);
    expect(peoplePane).toContainElement(
      within(rosterSection).getByRole("search", { name: "Roster filters" }),
    );
    expect(peoplePane).toContainElement(
      within(rosterSection).getByLabelText("Bulk roster actions"),
    );
    expect(peoplePane).toContainElement(
      within(rosterSection).getByRole("region", { name: "Roster entries" }),
    );
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
    fireEvent.click(within(bulk).getByText("Edit multiple people"));
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

  test("shows roster groups and applies Weight directly to a whole group", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    const groupsRegion = screen.getByRole("region", {
      name: "Roster groups",
    });
    expect(
      within(groupsRegion).getByRole("heading", {
        name: "Groups",
      }),
    ).toBeInTheDocument();
    expect(within(groupsRegion).getByText("1 group")).toBeInTheDocument();

    const chooser = within(groupsRegion).getByRole("group", {
      name: "Choose a group",
    });
    const facultyChoice = within(chooser).getByRole("button", {
      name: "Faculty 1 person",
    });
    expect(facultyChoice).toHaveAttribute("aria-pressed", "true");
    expect(
      within(groupsRegion).getAllByLabelText(/^Weight for .* group$/),
    ).toHaveLength(1);

    const facultyGroup = within(groupsRegion).getByRole("group", {
      name: "Faculty group",
    });
    expect(within(facultyGroup).getByText("1 person")).toBeInTheDocument();
    const input = within(facultyGroup).getByLabelText(
      "Weight for Faculty group",
    );
    const apply = within(facultyGroup).getByRole("button", {
      name: "Apply Weight to Faculty group",
    });
    expect(input).toHaveValue(null);
    expect(apply).toBeDisabled();

    fireEvent.change(input, { target: { value: "0.4" } });
    expect(apply).toBeEnabled();
    await userEvent.click(apply);

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
    expect(await within(groupsRegion).findByRole("status")).toHaveTextContent(
      "Faculty Weight set to 0.4 for 1 person",
    );
    expect(input).toHaveValue(null);
  });

  test("offers human-readable Weight presets for a selected group", async () => {
    renderView();
    const groupsRegion = await screen.findByRole("region", {
      name: "Roster groups",
    });
    const facultyGroup = within(groupsRegion).getByRole("group", {
      name: "Faculty group",
    });
    const halfWeight = within(facultyGroup).getByRole("button", {
      name: "0.5× Half",
    });
    const input = within(facultyGroup).getByLabelText(
      "Weight for Faculty group",
    );
    const apply = within(facultyGroup).getByRole("button", {
      name: "Apply Weight to Faculty group",
    });

    await userEvent.click(halfWeight);
    expect(halfWeight).toHaveAttribute("aria-pressed", "true");
    expect(input).toHaveValue(0.5);
    expect(apply).toBeEnabled();
    await userEvent.click(apply);

    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          group: "Faculty",
          updates: { weight: 0.5 },
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
  });

  test("keeps Weight drafts attached to the group they belong to", async () => {
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
      pagination: { page: 1, pageSize: 50, total: 3, pages: 1 },
      stats: {
        total: 3,
        submitted: 0,
        notSubmitted: 3,
        groups: [
          { name: "Faculty", count: 1 },
          { name: "Research", count: 2 },
        ],
      },
    });
    renderView();

    const groupsRegion = await screen.findByRole("region", {
      name: "Roster groups",
    });
    const chooser = within(groupsRegion).getByRole("group", {
      name: "Choose a group",
    });
    const facultyChoice = within(chooser).getByRole("button", {
      name: "Faculty 1 person",
    });
    const researchChoice = within(chooser).getByRole("button", {
      name: "Research 2 people",
    });

    fireEvent.change(
      within(groupsRegion).getByLabelText("Weight for Faculty group"),
      { target: { value: "0.4" } },
    );
    await userEvent.click(researchChoice);
    expect(facultyChoice).toHaveAttribute("aria-pressed", "false");
    expect(researchChoice).toHaveAttribute("aria-pressed", "true");
    expect(
      within(groupsRegion).getByRole("group", { name: "Research group" }),
    ).toBeInTheDocument();
    expect(
      within(groupsRegion).getByLabelText("Weight for Research group"),
    ).toHaveValue(null);
    expect(within(groupsRegion).getAllByRole("spinbutton")).toHaveLength(1);

    fireEvent.change(
      within(groupsRegion).getByLabelText("Weight for Research group"),
      { target: { value: "0.7" } },
    );
    await userEvent.click(facultyChoice);
    expect(
      within(groupsRegion).getByLabelText("Weight for Faculty group"),
    ).toHaveValue(0.4);
  });

  test("coalesces case variants into one group card and count", async () => {
    fetchRoster.mockResolvedValueOnce({
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
      pagination: { page: 1, pageSize: 50, total: 3, pages: 1 },
      stats: {
        total: 3,
        submitted: 0,
        notSubmitted: 3,
        groups: [
          { name: "Faculty", count: 1 },
          { name: "faculty", count: 2 },
        ],
      },
    });
    renderView();

    const groupsRegion = await screen.findByRole("region", {
      name: "Roster groups",
    });
    const facultyGroups = within(groupsRegion).getAllByRole("group", {
      name: "Faculty group",
    });
    expect(facultyGroups).toHaveLength(1);
    expect(within(facultyGroups[0]).getByText("3 people")).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: "Faculty" })).toHaveLength(1);
  });

  test("keeps a failed group Weight draft available for retry", async () => {
    patchRosterBulk.mockRejectedValueOnce(new Error("Temporary update outage"));
    renderView();
    const groupsRegion = await screen.findByRole("region", {
      name: "Roster groups",
    });
    const facultyGroup = within(groupsRegion).getByRole("group", {
      name: "Faculty group",
    });
    const input = within(facultyGroup).getByLabelText(
      "Weight for Faculty group",
    );
    fireEvent.change(input, { target: { value: "0.65" } });
    await userEvent.click(
      within(facultyGroup).getByRole("button", {
        name: "Apply Weight to Faculty group",
      }),
    );

    expect(await within(facultyGroup).findByRole("alert")).toHaveTextContent(
      "Temporary update outage",
    );
    expect(input).toHaveValue(0.65);
  });

  test("validates a direct group Weight before sending it", async () => {
    renderView();
    const facultyGroup = await screen.findByRole("group", {
      name: "Faculty group",
    });
    fireEvent.change(
      within(facultyGroup).getByLabelText("Weight for Faculty group"),
      { target: { value: "1.25" } },
    );
    fireEvent.submit(facultyGroup);

    expect(await within(facultyGroup).findByRole("alert")).toHaveTextContent(
      "Enter a Weight from 0 to 1",
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();
  });

  test("requires clear filters before changing an entire group Weight", async () => {
    renderView();
    await screen.findByText("Ada Faculty");
    const unfilteredRoster = await fetchRoster.mock.results[0].value;

    await userEvent.type(screen.getByLabelText("Search roster"), "Ada");
    const groupsRegion = screen.getByRole("region", {
      name: "Roster groups",
    });
    expect(within(groupsRegion).getByText(/hidden by filters/)).toBeVisible();
    expect(
      within(groupsRegion).queryByLabelText("Weight for Faculty group"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({ search: "Ada" }),
        "token",
      ),
    );

    let resolveAllGroups;
    fetchRoster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAllGroups = resolve;
        }),
    );

    await userEvent.click(
      within(groupsRegion).getByRole("button", { name: "Show all groups" }),
    );
    expect(within(groupsRegion).getByRole("status")).toHaveTextContent(
      "Loading all groups",
    );
    expect(
      within(groupsRegion).queryByLabelText("Weight for Faculty group"),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(resolveAllGroups).toEqual(expect.any(Function)));

    await act(async () => {
      resolveAllGroups(unfilteredRoster);
    });
    expect(
      await within(groupsRegion).findByLabelText("Weight for Faculty group"),
    ).toBeEnabled();
  });

  test("bulk updates require an explicit field and omit fields the organizer did not choose", async () => {
    renderView();
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    const bulk = screen.getByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Edit multiple people"));
    await userEvent.click(screen.getByLabelText("Select Ada Faculty"));

    await userEvent.click(
      within(bulk).getByRole("button", { name: "Apply update" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose weight, included status, or both",
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
    fireEvent.click(within(bulk).getByText("Edit multiple people"));
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

  test("refreshes group cards after an individual moves groups", async () => {
    const facultyParticipant = {
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
    };
    const researchParticipant = {
      ...facultyParticipant,
      group: "Research",
      version: 2,
    };
    fetchRoster
      .mockResolvedValueOnce({
        participants: [facultyParticipant],
        pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
        stats: {
          total: 1,
          submitted: 0,
          notSubmitted: 1,
          groups: [{ name: "Faculty", count: 1 }],
        },
      })
      .mockResolvedValueOnce({
        participants: [researchParticipant],
        pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
        stats: {
          total: 1,
          submitted: 0,
          notSubmitted: 1,
          groups: [{ name: "Research", count: 1 }],
        },
      });
    patchRosterParticipant.mockResolvedValueOnce({
      participant: researchParticipant,
      resultsRevision: 4,
    });
    renderView();
    const groupInput = await screen.findByLabelText("Group for Ada Faculty");
    fireEvent.change(groupInput, { target: { value: "Research" } });
    fireEvent.blur(groupInput);

    expect(
      await screen.findByRole("group", { name: "Research group" }),
    ).toHaveTextContent("1 person");
    expect(
      screen.queryByRole("group", { name: "Faculty group" }),
    ).not.toBeInTheDocument();
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
      deliveryRequest: null,
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
      block: "start",
    });
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Legacy result",
    );
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
    expect(screen.getByText(/Previous best window/)).toBeInTheDocument();
  });
});
