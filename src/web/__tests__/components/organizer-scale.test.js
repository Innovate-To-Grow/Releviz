/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("@material/web/checkbox/checkbox.js", () => ({}), { virtual: true });
jest.mock("@material/web/slider/slider.js", () => ({}), { virtual: true });
jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), { virtual: true });

jest.mock("@/components/auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@/components/event/EventDetailsGrid", () => ({
  __esModule: true,
  default: ({ event, extraCards = [] }) => (
    <div>
      {event.name}
      {extraCards.map((card) => (
        <span key={card.label}>
          {card.label}: {card.value}
        </span>
      ))}
    </div>
  ),
}));
jest.mock("@/components/schedule/OrganizerPanels", () => ({
  OrganizerHeader: ({ onRefresh }) => (
    <header>
      <h2>Organizer Dashboard</h2>
      <button onClick={onRefresh}>Refresh</button>
    </header>
  ),
  ManagedScheduleDrawer: () => null,
}));
jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  downloadFinalCalendar: jest.fn(),
  fetchDeliveryRequest: jest.fn(),
  fetchEventResults: jest.fn(),
  launchEvent: jest.fn(),
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));
jest.mock("@/lib/api/participants", () => ({ updateParticipant: jest.fn() }));
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
  fetchEventResults,
  launchEvent,
  previewFinalMeeting,
  sendReminders,
} from "@/lib/api/events";
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
  status: "draft",
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
        { index: 0, startsAt: "2026-08-20T09:00:00Z", endsAt: "2026-08-20T09:30:00Z" },
        { index: 1, startsAt: "2026-08-20T09:30:00Z", endsAt: "2026-08-20T10:00:00Z" },
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
  await userEvent.click(screen.getByRole("button", { name: "Paste spreadsheet" }));
  fireEvent.change(screen.getByLabelText("Pasted roster rows"), {
    target: { value: "name\temail\nAda\tada@example.com" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Continue to mapping" }));
  await userEvent.click(await screen.findByRole("button", { name: "Preview rows" }));
  expect(await screen.findByDisplayValue("ada@example.com")).toBeInTheDocument();
}

function renderView(setEvent = jest.fn(), currentEvent = event) {
  return {
    setEvent,
    ...render(
      <EventContext.Provider value={{ event: currentEvent, setEvent, numSlots: 2 }}>
        <OrganizerScaleView />
      </EventContext.Provider>
    ),
  };
}

describe("scaled organizer workspace", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    window.sessionStorage.clear();
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
  });

  test("shows the loading state while organizer authentication is unresolved", () => {
    useAuth.mockReturnValue({ user: null, loading: true, getToken: jest.fn() });
    renderView();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
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
    renderView(jest.fn(), { ...event, status: "open" });
    await userEvent.click(screen.getByRole("button", { name: "Queue reminders" }));
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  });

  test("launches a draft and displays durable delivery progress", async () => {
    launchEvent.mockResolvedValue({
      event: { ...event, status: "open", version: 3 },
      deliveryRequest: {
        id: "delivery-1",
        operation: "invitation",
        recipientCount: 1000,
        delivery: { total: 1000, pending: 1000, sent: 0 },
      },
    });
    const { setEvent } = renderView();

    await userEvent.click(screen.getByRole("button", { name: "Launch and send invitations" }));

    await waitFor(() =>
      expect(launchEvent).toHaveBeenCalledWith(
        event.code,
        {
          expectedVersion: 2,
          idempotencyKey: "request-key",
          selection: { allEligible: true },
        },
        "token"
      )
    );
    expect(setEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }));
    expect(await screen.findByLabelText("Delivery progress")).toHaveTextContent("1000 queued");
  });

  test("launches only selected roster IDs and keeps delivery progress visible in Roster", async () => {
    launchEvent.mockResolvedValue({
      event: { ...event, status: "open", version: 3 },
      deliveryRequest: {
        id: "delivery-selected",
        operation: "invitation",
        recipientCount: 1,
        delivery: { total: 1, pending: 1 },
      },
    });
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await userEvent.click(await screen.findByLabelText("Select Ada Faculty"));
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByText("1 selected in Roster")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Invitation audience"), "selected");
    await userEvent.click(screen.getByRole("button", { name: "Launch and send invitations" }));

    await waitFor(() =>
      expect(launchEvent).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({ selection: { participantIds: ["roster-1"] } }),
        "token"
      )
    );
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByLabelText("Delivery progress")).toHaveTextContent("1 queued");
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await userEvent.selectOptions(screen.getByLabelText("Invitation audience"), "exclude_selected");
    await userEvent.click(screen.getByRole("button", { name: "Launch and send invitations" }));
    await waitFor(() =>
      expect(launchEvent).toHaveBeenLastCalledWith(
        event.code,
        expect.objectContaining({
          selection: { allEligible: true, excludedParticipantIds: ["roster-1"] },
        }),
        "token"
      )
    );
  });

  test("loads a paginated roster and patches one row without full schedules", async () => {
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));

    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    expect(fetchRosterSchedule).not.toHaveBeenCalled();
    expect(fetchRoster).toHaveBeenCalledWith(
      event.code,
      expect.objectContaining({ page: 1, pageSize: 50 }),
      "token"
    );
    const row = document.querySelector('[data-roster-participant-id="roster-1"]');
    await userEvent.click(within(row).getByLabelText("Include Ada Faculty"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { included: false, expectedVersion: 1 },
        "token"
      )
    );

    await userEvent.type(screen.getByLabelText("Search roster"), "ada@example.com");
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({ page: 1, pageSize: 50, search: "ada@example.com" }),
        "token"
      )
    );

    await userEvent.click(within(row).getByRole("button", { name: "Edit schedule" }));
    await waitFor(() =>
      expect(fetchRosterSchedule).toHaveBeenCalledWith(event.code, "roster-1", "token")
    );
  });

  test("applies group weight and inclusion changes through one bulk patch", async () => {
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();

    const bulk = screen.getByText("Bulk weight and inclusion").closest("details");
    fireEvent.click(within(bulk).getByText("Bulk weight and inclusion"));
    await userEvent.selectOptions(within(bulk).getByLabelText("Bulk update scope"), "group");
    await userEvent.selectOptions(within(bulk).getByLabelText("Bulk update group"), "Faculty");
    await userEvent.click(within(bulk).getByLabelText("Apply bulk weight"));
    fireEvent.change(within(bulk).getByLabelText("Bulk weight"), {
      target: { value: "0.4" },
    });
    await userEvent.click(within(bulk).getByLabelText("Apply bulk included status"));
    await userEvent.click(within(bulk).getByLabelText("Bulk included"));
    await userEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));

    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          group: "Faculty",
          updates: { weight: 0.4, included: false },
          idempotencyKey: "request-key",
        },
        "token"
      )
    );
  });

  test("bulk updates require an explicit field and omit fields the organizer did not choose", async () => {
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    const bulk = screen.getByText("Bulk weight and inclusion").closest("details");
    fireEvent.click(within(bulk).getByText("Bulk weight and inclusion"));
    await userEvent.click(screen.getByLabelText("Select Ada Faculty"));

    await userEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose weight, included status, or both"
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();

    await userEvent.click(within(bulk).getByLabelText("Apply bulk weight"));
    fireEvent.change(within(bulk).getByLabelText("Bulk weight"), {
      target: { value: "0.25" },
    });
    await userEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        event.code,
        {
          participantIds: ["roster-1"],
          updates: { weight: 0.25 },
          idempotencyKey: "request-key",
        },
        "token"
      )
    );
  });

  test("uses an explicit all selector for an unfiltered bulk update", async () => {
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByText("Ada Faculty")).toBeInTheDocument();
    const bulk = screen.getByText("Bulk weight and inclusion").closest("details");
    fireEvent.click(within(bulk).getByText("Bulk weight and inclusion"));
    await userEvent.selectOptions(within(bulk).getByLabelText("Bulk update scope"), "filter");
    await userEvent.click(within(bulk).getByLabelText("Apply bulk included status"));
    await userEvent.click(within(bulk).getByLabelText("Bulk included"));
    await userEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));

    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        event.code,
        {
          filter: { all: true },
          updates: { included: false },
          idempotencyKey: "request-key",
        },
        "token"
      )
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
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByLabelText("Delivery progress")).toHaveTextContent("2 queued");
  });

  test("restores durable delivery progress after a browser refresh", async () => {
    window.sessionStorage.setItem(
      `releviz.delivery-request.${event.code}`,
      JSON.stringify({
        id: "stored-delivery",
        operation: "final_confirmation",
        delivery: { total: 5, pending: 1, sent: 4 },
      })
    );
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(await screen.findByLabelText("Delivery progress")).toHaveTextContent("1 queued");
  });

  test("individual weight updates preserve included status", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: { id: "roster-1", weight: 0.35, included: true, version: 2 },
      resultsRevision: 4,
    });
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    const weight = await screen.findByLabelText("Weight for Ada Faculty");
    fireEvent.change(weight, { target: { value: "0.35" } });
    fireEvent.blur(weight);

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        event.code,
        "roster-1",
        { weight: 0.35, expectedVersion: 1 },
        "token"
      )
    );
  });

  test("pastes, maps, previews, and merges a roster import", async () => {
    mockRosterImportPreview();
    commitRosterImport.mockResolvedValue({
      receipt: { importedCount: 1, createdCount: 1, updatedCount: 0, resultsRevision: 4 },
    });
    renderView();
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText("Ada Faculty");
    await openPastedRosterPreview();
    expect(configureRosterImport).toHaveBeenCalledWith(
      event.code,
      "import-1",
      expect.objectContaining({ columnMapping: { name: "0", email: "1" } }),
      "token"
    );
    await userEvent.click(screen.getByRole("button", { name: "Merge roster" }));

    await waitFor(() =>
      expect(commitRosterImport).toHaveBeenCalledWith(
        event.code,
        "import-1",
        { mode: "merge", idempotencyKey: "request-key" },
        "token"
      )
    );
    expect(await screen.findByRole("button", { name: "Import roster" })).toBeInTheDocument();
  });

  test("requires the exact event code before a destructive roster rebuild", async () => {
    mockRosterImportPreview();
    const rebuiltEvent = { ...event, status: "draft", version: event.version + 1 };
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
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await screen.findByText("Ada Faculty");
    await userEvent.click(screen.getByLabelText("Select Ada Faculty"));
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await userEvent.selectOptions(screen.getByLabelText("Invitation audience"), "exclude_selected");
    await userEvent.click(screen.getByRole("tab", { name: "Roster" }));
    await openPastedRosterPreview();
    await userEvent.click(screen.getByRole("radio", { name: /Rebuild the roster/ }));

    const rebuildButton = screen.getByRole("button", { name: "Rebuild roster" });
    expect(rebuildButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Rebuild confirmation code"), "BIG100");
    expect(rebuildButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Rebuild confirmation code"), "0");
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
        "token"
      )
    );
    expect(setEvent).toHaveBeenCalledWith(rebuiltEvent);
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByLabelText("Invitation audience")).toHaveValue("all");
    expect(screen.getByText("0 selected in Roster")).toBeInTheDocument();
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
    renderView(setEvent, { ...event, status: "open" });
    await userEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(await screen.findByText(/Results are current at revision 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose this time" }));
    expect(screen.getByRole("tabpanel", { name: "Finalize" })).toHaveTextContent(
      "Thursday 9:00 AM"
    );
    await userEvent.click(screen.getByRole("button", { name: "Review attendance" }));
    expect(await screen.findByText("700")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finalize meeting" }));

    await waitFor(() =>
      expect(confirmFinalMeeting).toHaveBeenCalledWith(
        event.code,
        expect.objectContaining({
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T10:00:00Z",
          expectedVersion: 2,
          idempotencyKey: "request-key",
        }),
        "token"
      )
    );
    expect(setEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "finalized" }));
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
    await userEvent.click(screen.getByRole("tab", { name: "Results" }));

    expect(await screen.findByText(/Results are updating for revision 4/)).toHaveTextContent(
      "Showing the last successful snapshot meanwhile"
    );
    expect(screen.getByText(/Previous best window/)).toBeInTheDocument();
  });
});
