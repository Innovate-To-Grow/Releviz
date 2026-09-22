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
import { createRef } from "react";

jest.mock("@/components/schedule/RosterImportWizard", () => ({
  __esModule: true,
  default: () => <div data-testid="import-wizard">Import wizard</div>,
}));

// The channel editor is exercised in its own suite; here it only needs to
// report the arrays it receives and let a test paint or copy them.
jest.mock("@/components/schedule/ScheduleChannelEditor", () => ({
  __esModule: true,
  default: ({
    inperson,
    virtual,
    readOnly,
    onInpersonPaint,
    onVirtualPaint,
    onCopy,
  }) => (
    <div data-testid="channel-editor" data-readonly={String(readOnly)}>
      <span data-testid="inperson-values">{inperson.join(",")}</span>
      <span data-testid="virtual-values">{virtual.join(",")}</span>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => onInpersonPaint(0)}
      >
        Paint in-person
      </button>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => onVirtualPaint(1)}
      >
        Paint virtual
      </button>
      <button type="button" onClick={() => onCopy("inperson", "virtual")}>
        Copy in-person to virtual
      </button>
      <button type="button" onClick={() => onCopy("virtual", "inperson")}>
        Copy virtual to in-person
      </button>
    </div>
  ),
}));

jest.mock("@/lib/api/participants", () => ({
  createManagedParticipant: jest.fn(),
  updateParticipant: jest.fn(),
}));

jest.mock("@/lib/api/roster", () => ({
  fetchRoster: jest.fn(),
  fetchRosterSchedule: jest.fn(),
  patchRosterBulk: jest.fn(),
  patchRosterParticipant: jest.fn(),
  sendRosterInvitations: jest.fn(),
}));

import RosterPanel from "@/components/schedule/RosterPanel";
import {
  createManagedParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import {
  fetchRoster,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
  sendRosterInvitations,
} from "@/lib/api/roster";

// The drawer flows below paint Available over a Busy start; the Available
// default (Busy brush) has its own test.
const event = {
  code: "ROSTER1",
  name: "Roster drawer",
  status: "active",
  mode: "mixed",
  startingAvailability: "busy",
  slotCount: 3,
  slotGroups: [
    {
      key: "weekday:1",
      label: "Mon",
      weekday: 1,
      slots: [
        { index: 0, localStart: "09:00", localEnd: "09:30" },
        { index: 1, localStart: "09:30", localEnd: "10:00" },
        { index: 2, localStart: "10:00", localEnd: "10:30" },
      ],
    },
  ],
};

function participant(overrides = {}) {
  return {
    id: "p-1",
    memberId: "m-1",
    name: "Temp Person",
    email: "temp@example.com",
    group: "Faculty",
    weight: 1,
    included: true,
    submitted: 0,
    version: 4,
    accountAccess: "temporary",
    canOrganizerEditAvailability: true,
    invitationStatus: "sent",
    ...overrides,
  };
}

function rosterResponse(participants, extra = {}) {
  return {
    participants,
    pagination: {
      page: 1,
      pageSize: 50,
      total: participants.length,
      pages: 1,
    },
    stats: {
      total: participants.length,
      submitted: participants.filter((entry) => entry.submitted).length,
      notSubmitted: participants.filter((entry) => !entry.submitted).length,
      groups: ["Faculty", "Students"],
    },
    ...extra,
  };
}

function scheduleResponse(overrides = {}) {
  return {
    participant: {
      id: "roster-row-1",
      memberId: "p-1",
      name: "Temp Person",
      version: 4,
    },
    schedule: {
      availabilityInperson: [0, 1, 0],
      availabilityVirtual: [1, 0, 0],
      submitted: 0,
      version: 4,
    },
    ...overrides,
  };
}

async function renderPanel(props = {}) {
  const getToken = jest.fn().mockResolvedValue("token");
  const utils = render(
    <RosterPanel
      event={event}
      setEvent={jest.fn()}
      getToken={getToken}
      onResultsInvalidated={jest.fn()}
      onDeliveryRequestChange={jest.fn()}
      {...props}
    />,
  );
  await waitFor(() => expect(fetchRoster).toHaveBeenCalled());
  return { ...utils, getToken };
}

async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit schedule" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Edit Temp Person's schedule",
  });
  return dialog;
}

describe("RosterPanel schedule drawer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    fetchRosterSchedule.mockResolvedValue(scheduleResponse());
    window.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    delete window.confirm;
  });

  test("pre-selects the Busy brush for an event whose participants start Available", async () => {
    const availableStart = { ...event, startingAvailability: "available" };
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        schedule: {
          availabilityInperson: [1, 1, 1],
          availabilityVirtual: [1, 1, 1],
          submitted: 0,
          version: 4,
        },
      }),
    );
    await renderPanel({ event: availableStart });
    const dialog = await openEditor();
    const choices = within(dialog).getByRole("group", {
      name: "Availability status",
    });
    expect(
      within(choices).getByRole("button", { name: "Busy" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint in-person" }),
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "0,1,1",
    );
  });

  test("loads the response, paints, copies channels, and saves a draft", async () => {
    const { getToken } = await renderPanel();
    updateParticipant.mockResolvedValue({
      participant: {
        availabilityInperson: [1, 1, 0],
        availabilityVirtual: [1, 1, 0],
        submitted: 0,
        version: 5,
        name: "Temp Person (edited)",
      },
    });
    const dialog = await openEditor();
    expect(fetchRosterSchedule).toHaveBeenCalledWith("ROSTER1", "p-1", "token");
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "0,1,0",
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,0,0",
    );
    expect(getToken).toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint in-person" }),
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "1,1,0",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint virtual" }),
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,1,0",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Busy" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint virtual" }),
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,0,0",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy in-person to virtual" }),
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,1,0",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy virtual to in-person" }),
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "1,1,0",
    );

    fireEvent.change(within(dialog).getByLabelText("Event display name"), {
      target: { value: "  Temp Person (edited) " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    expect(updateParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      "p-1",
      {
        name: "Temp Person (edited)",
        availabilityInperson: [1, 1, 0],
        availabilityVirtual: [1, 1, 0],
        submitted: 0,
        expectedVersion: 4,
      },
      "token",
    );
    expect(within(dialog).getByLabelText("Event display name")).toHaveValue(
      "Temp Person (edited)",
    );
    // The roster reloads after a save.
    expect(fetchRoster).toHaveBeenCalledTimes(2);
  });

  test("submits on behalf of the participant and falls back to local arrays", async () => {
    await renderPanel();
    updateParticipant.mockResolvedValue({
      participant: { submitted: 1, version: 6 },
    });
    const dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Schedule submitted.",
      ),
    );
    expect(updateParticipant.mock.calls[0][2]).toEqual(
      expect.objectContaining({ submitted: 1 }),
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "0,1,0",
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,0,0",
    );
  });

  test("offers the latest response after a version conflict", async () => {
    await renderPanel();
    const conflict = Object.assign(new Error("Conflict"), {
      status: 409,
      participant: {
        name: "Temp Person",
        availabilityInperson: [1, 1, 1],
        version: 9,
      },
    });
    updateParticipant.mockRejectedValueOnce(conflict);
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "This response changed after you opened it. Reload the latest response.",
      ),
    );
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeDisabled();
    expect(within(dialog).getByTestId("channel-editor")).toHaveAttribute(
      "data-readonly",
      "true",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload latest response" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Latest response loaded.",
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "1,1,1",
    );
    // The conflict carried no virtual array, so the local one is kept.
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "1,0,0",
    );
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeEnabled();
    updateParticipant.mockResolvedValueOnce({ participant: { version: 10 } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        expect.objectContaining({ expectedVersion: 9 }),
        "token",
      ),
    );
  });

  test("closes the drawer when the person upgraded to a full account, and reports other failures", async () => {
    await renderPanel();
    const upgraded = Object.assign(new Error("Forbidden"), {
      status: 403,
      errorCode: "organizer_edit_full_account",
    });
    updateParticipant.mockRejectedValueOnce(upgraded);
    let dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This person now has a full account, so organizer editing is no longer allowed.",
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    updateParticipant.mockRejectedValueOnce(
      Object.assign(new Error(""), { status: 500 }),
    );
    dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Unable to save this schedule.",
      ),
    );
  });

  test("confirms before discarding unsaved edits and restores focus on close", async () => {
    await renderPanel();
    const trigger = await screen.findByRole("button", {
      name: "Edit schedule",
    });
    trigger.focus();
    let dialog = await openEditor();
    expect(
      within(dialog).getByRole("button", { name: "Close schedule editor" }),
    ).toHaveFocus();
    // Untouched: no confirmation needed.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint in-person" }),
    );
    window.confirm.mockReturnValueOnce(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(window.confirm).toHaveBeenCalledWith(
      "Discard the unsaved changes to this participant's schedule?",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    window.confirm.mockReturnValueOnce(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Tab wraps inside the drawer.
    dialog = await openEditor();
    const buttons = within(dialog).getAllByRole("button");
    const closeButton = buttons[0];
    const lastButton = buttons[buttons.length - 1];
    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();
  });

  test("fills missing schedule arrays and surfaces load errors", async () => {
    await renderPanel();
    fetchRosterSchedule.mockResolvedValueOnce({
      participant: { id: "row", name: "", version: 2 },
      schedule: {},
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit schedule" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Participant's schedule",
    });
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "0,0,0",
    );
    expect(within(dialog).getByTestId("virtual-values")).toHaveTextContent(
      "0,0,0",
    );
    // A blank display name locks both save actions.
    fireEvent.change(within(dialog).getByLabelText("Event display name"), {
      target: { value: "   " },
    });
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    ).toBeDisabled();
    window.confirm.mockReturnValueOnce(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    fetchRosterSchedule.mockRejectedValueOnce(new Error(""));
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to load Temp Person's schedule.",
      ),
    );
  });

  test("locks editing while responses are closed", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    await renderPanel({ event: { ...event, status: "closed" } });
    expect(
      await screen.findByText(/read-only while responses are closed/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Edit schedule" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("group", { name: "Roster actions" }),
    ).not.toBeInTheDocument();
  });
});

describe("RosterPanel filters, paging, and bulk updates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
  });

  test("offers an Ungrouped filter, legacy group maps, and every delivery label", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({
            id: "a",
            name: "Alpha",
            group: undefined,
            groupName: "Legacy",
          }),
          participant({
            id: "b",
            name: "Beta",
            group: null,
            group_name: "Snake",
            invitationStatus: "accepted",
            accountAccess: "full",
            canOrganizerEditAvailability: false,
          }),
          participant({
            id: "c",
            name: "Gamma",
            group: "",
            invitationStatus: undefined,
          }),
          participant({
            id: "d",
            name: "Delta",
            invitationStatus: "accepted",
            submitted: 1,
          }),
        ],
        {
          stats: {
            total: 4,
            submitted: 1,
            notSubmitted: 3,
            groups: [{ name: "Faculty" }, { name: "" }],
          },
        },
      ),
    );
    await renderPanel();
    const groupFilter = await screen.findByLabelText("Filter by group");
    expect(
      within(groupFilter).getByRole("option", { name: "Ungrouped" }),
    ).toHaveValue("__ungrouped__");
    expect(screen.getByLabelText("Group for Alpha")).toHaveValue("Legacy");
    expect(screen.getByLabelText("Group for Beta")).toHaveValue("Snake");
    expect(screen.getByLabelText("Group for Gamma")).toHaveValue("");
    const table = screen.getByRole("region", { name: "Roster participants" });
    expect(within(table).getByText("Self-managed")).toBeInTheDocument();
    expect(
      within(table).getByText("Full account", { exact: false }),
    ).toBeInTheDocument();
    expect(within(table).getAllByText("Invitation")).toHaveLength(4);
    expect(within(table).getByText("Sent")).toBeInTheDocument();
    expect(within(table).getByText("Not sent")).toBeInTheDocument();
    expect(within(table).getAllByText("Accepted")).toHaveLength(2);
    // Only the Response badge says Submitted now.
    expect(within(table).getAllByText("Submitted")).toHaveLength(1);
    expect(within(table).queryByText("Invited")).not.toBeInTheDocument();
    expect(within(table).queryByText("Opened")).not.toBeInTheDocument();
    const invitationFilter = screen.getByLabelText("Filter by invitation");
    expect(
      within(invitationFilter)
        .getAllByRole("option")
        .map((option) => [option.textContent, option.value]),
    ).toEqual([
      ["Any invitation", ""],
      ["Not sent", "not_sent"],
      ["Sent", "sent"],
      ["Accepted", "accepted"],
    ]);

    fireEvent.change(groupFilter, { target: { value: "__ungrouped__" } });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "__ungrouped__", page: 1 }),
        "token",
      ),
    );

    // Legacy stats shaped as an object still populate the group list.
    fetchRoster.mockResolvedValue(
      rosterResponse([participant()], {
        stats: {
          total: 1,
          submitted: 0,
          notSubmitted: 1,
          groups: { Faculty: 1, Staff: 2 },
        },
      }),
    );
    fireEvent.change(screen.getByLabelText("Filter by response"), {
      target: { value: "false" },
    });
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Filter by group")).getByRole("option", {
          name: "Staff",
        }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Filter by invitation"), {
      target: { value: "sent" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({
          submitted: "false",
          invitationStatus: "sent",
        }),
        "token",
      ),
    );
  });

  test("pages through a large roster and changes the page size", async () => {
    const many = Array.from({ length: 26 }, (_, index) =>
      participant({ id: `p-${index}`, name: `Person ${index}` }),
    );
    fetchRoster.mockResolvedValue(
      rosterResponse(many, {
        pagination: { page: 1, pageSize: 25, total: 60, pages: 3 },
        stats: { total: 60, submitted: 0, notSubmitted: 60, groups: [] },
      }),
    );
    await renderPanel();
    expect(await screen.findByText("Page 1 of 3")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ page: 2 }),
        "token",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ page: 1 }),
        "token",
      ),
    );
    fireEvent.change(screen.getByLabelText("Rows per page"), {
      target: { value: "100" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ page: 1, pageSize: 100 }),
        "token",
      ),
    );
  });

  test("reports bulk failures and offers the latest row after a stale patch", async () => {
    const other = participant({
      id: "p-2",
      name: "Other Person",
      canOrganizerEditAvailability: false,
    });
    fetchRoster.mockResolvedValue(rosterResponse([participant(), other]));
    patchRosterBulk.mockRejectedValueOnce(new Error("Bulk failed"));
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    const bulk = await screen.findByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    fireEvent.click(screen.getByLabelText("Select Temp Person"));
    fireEvent.click(within(bulk).getByLabelText("Apply bulk included status"));
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Bulk failed"),
    );

    const latest = participant({ weight: 0.8, included: false, version: 9 });
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: latest,
      }),
    );
    const weight = screen.getByLabelText("Weight for Temp Person");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person was changed in another session.",
      ),
    );
    // The roster is not refreshed behind the organizer's back, and the typed
    // value stays on screen while the row waits for a reload.
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(weight).toHaveValue(0.25);
    expect(weight).toBeDisabled();
    expect(screen.getByLabelText("Group for Temp Person")).toBeDisabled();
    expect(screen.getByLabelText("Include Temp Person")).toBeDisabled();
    expect(screen.getByLabelText("Select Temp Person")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit schedule" })).toBeEnabled();
    expect(screen.getByLabelText("Weight for Other Person")).toBeEnabled();

    fetchRoster.mockResolvedValueOnce(rosterResponse([latest, other]));
    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest participant" }),
    );
    expect(
      screen.getByText("Latest values loaded for Temp Person."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload latest participant" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Weight for Temp Person")).toHaveValue(
      0.8,
    );
    expect(screen.getByLabelText("Weight for Temp Person")).toBeEnabled();
    expect(screen.getByLabelText("Group for Temp Person")).toBeEnabled();
    expect(screen.getByLabelText("Include Temp Person")).not.toBeChecked();
    expect(screen.getByLabelText("Include Temp Person")).toBeEnabled();

    // A successful row patch forwards the results revision and sends the
    // reloaded version.
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ weight: 0.5, version: 10 }),
      resultsRevision: 7,
    });
    fireEvent.change(screen.getByLabelText("Weight for Temp Person"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(screen.getByLabelText("Weight for Temp Person"));
    await waitFor(() => expect(onResultsInvalidated).toHaveBeenCalledWith(7));
    expect(patchRosterParticipant).toHaveBeenLastCalledWith(
      "ROSTER1",
      "p-1",
      { weight: 0.5, expectedVersion: 9 },
      "token",
    );
  });

  test("locks a row when toggling inclusion hits a newer version", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: participant({ included: false, version: 9 }),
      }),
    );
    await renderPanel();
    fireEvent.click(await screen.findByLabelText("Include Temp Person"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person was changed in another session. Reload the latest values before editing this row again.",
      ),
    );
    expect(patchRosterParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      "p-1",
      { included: false, expectedVersion: 4 },
      "token",
    );
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Include Temp Person")).toBeChecked();
    expect(screen.getByLabelText("Include Temp Person")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reload latest participant" }),
    ).toBeInTheDocument();
  });

  test("reloads the roster when a stale patch carries no participant", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Stale"), { status: 409 }),
    );
    await renderPanel();
    const weight = await screen.findByLabelText("Weight for Temp Person");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Stale"),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(1),
    );
    expect(screen.getByLabelText("Weight for Temp Person")).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Reload latest participant" }),
    ).not.toBeInTheDocument();

    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error(""), { status: 409 }),
    );
    fireEvent.change(screen.getByLabelText("Weight for Temp Person"), {
      target: { value: "0.3" },
    });
    fireEvent.blur(screen.getByLabelText("Weight for Temp Person"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to update Temp Person.",
      ),
    );
  });

  test("drops row conflicts once the event is no longer active", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: participant({ weight: 0.8, version: 9 }),
      }),
    );
    const props = {
      event,
      setEvent: jest.fn(),
      getToken: jest.fn().mockResolvedValue("token"),
      onResultsInvalidated: jest.fn(),
      onDeliveryRequestChange: jest.fn(),
    };
    const { rerender } = render(<RosterPanel {...props} />);
    const weight = await screen.findByLabelText("Weight for Temp Person");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person was changed in another session.",
      ),
    );

    rerender(<RosterPanel {...props} event={{ ...event, status: "closed" }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload latest participant" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/read-only while responses are closed/),
    ).toBeVisible();
  });

  // Drives a row into the locked state the way the other conflict tests do:
  // a typed weight whose patch hits a newer version on the server.
  async function lockRowThroughConflict(rows, conflictRow) {
    fetchRoster.mockResolvedValue(rosterResponse(rows));
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: conflictRow,
      }),
    );
    const panel = createRef();
    await renderPanel({ ref: panel });
    const weight = await screen.findByLabelText("Weight for Temp Person");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person was changed in another session.",
      ),
    );
    expect(weight).toHaveValue(0.25);
    expect(weight).toBeDisabled();
    return panel;
  }

  test("unlocks a conflicted row once a refresh catches up with the other session", async () => {
    const other = participant({ id: "p-2", name: "Other Person" });
    const panel = await lockRowThroughConflict(
      [participant(), other],
      participant({ weight: 0.8, version: 9 }),
    );

    // The workspace refresh re-reads the roster with the row already at the
    // version the conflict carried: the lock, the banner, and the typed draft
    // all go, and the server value shows.
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ weight: 0.8, version: 9 }), other]),
    );
    await act(async () => {
      await panel.current.refresh("token");
    });
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload latest participant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.8);
    expect(screen.getByLabelText("Weight for Temp Person")).toBeEnabled();
    expect(screen.getByLabelText("Group for Temp Person")).toBeEnabled();
    expect(screen.getByLabelText("Include Temp Person")).toBeEnabled();

    // The next patch sends the refreshed version, not the one that conflicted.
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ weight: 0.5, version: 10 }),
    });
    fireEvent.change(screen.getByLabelText("Weight for Temp Person"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(screen.getByLabelText("Weight for Temp Person"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { weight: 0.5, expectedVersion: 9 },
        "token",
      ),
    );
  });

  test("keeps a conflicted row locked until a reload carries its newer version", async () => {
    const other = participant({ id: "p-2", name: "Other Person" });
    const panel = await lockRowThroughConflict(
      [participant(), other],
      participant({ weight: 0.8, version: 9 }),
    );

    // A read that still holds an older copy of the row has not caught up:
    // the lock and the typed value stay.
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ version: 8 }), other]),
    );
    await act(async () => {
      await panel.current.refresh("token");
    });
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Temp Person was changed in another session.",
    );
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.25);
    expect(screen.getByLabelText("Weight for Temp Person")).toBeDisabled();
    expect(screen.getByLabelText("Weight for Other Person")).toBeEnabled();

    // A filtered page that does not hold the row says nothing about it
    // either.
    fetchRoster.mockResolvedValueOnce(rosterResponse([other]));
    fireEvent.change(screen.getByLabelText("Filter by group"), {
      target: { value: "Students" },
    });
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Weight for Temp Person"),
      ).not.toBeInTheDocument(),
    );
    expect(fetchRoster).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Temp Person was changed in another session.",
    );
    expect(
      screen.getByRole("button", { name: "Reload latest participant" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Weight for Other Person")).toBeEnabled();

    // Once a page holds the row at the conflict's version, the row unlocks
    // and the draft is gone.
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ weight: 0.8, version: 9 }), other]),
    );
    fireEvent.change(screen.getByLabelText("Filter by group"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(fetchRoster).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.8);
    expect(screen.getByLabelText("Weight for Temp Person")).toBeEnabled();
    expect(screen.getByLabelText("Include Temp Person")).toBeEnabled();
  });

  test("recovers a legacy delivery id and validates invitation lengths", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    const onDeliveryRequestChange = jest.fn();
    createManagedParticipant.mockResolvedValue({
      participant: { id: "new-1", name: "Newbie" },
      autoInvitedCount: 1,
      deliveryRequestId: "dr-legacy",
      recipientCount: 1,
    });
    await renderPanel({ onDeliveryRequestChange });
    fireEvent.click(await screen.findByRole("button", { name: "Add person" }));
    const form = screen.getByRole("form", { name: /add a person/i });
    const name = within(form).getByLabelText(/Full name/);
    const email = within(form).getByLabelText(/Email/);
    fireEvent.change(name, { target: { value: "x".repeat(101) } });
    fireEvent.change(email, { target: { value: `${"a".repeat(250)}@x.io` } });
    fireEvent.submit(form);
    expect(
      await within(form).findByText(
        "Full name must be 100 characters or fewer.",
      ),
    ).toBeVisible();
    expect(
      within(form).getByText("Email address must be 254 characters or fewer."),
    ).toBeVisible();
    expect(createManagedParticipant).not.toHaveBeenCalled();
    // Both actions share the same client validation.
    fireEvent.click(
      within(form).getByRole("button", { name: "Add and send invitation" }),
    );
    expect(createManagedParticipant).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Newbie" } });
    fireEvent.change(email, { target: { value: "newbie@example.com" } });
    fireEvent.click(
      within(form).getByRole("button", { name: "Add and send invitation" }),
    );
    await waitFor(() =>
      expect(onDeliveryRequestChange).toHaveBeenCalledWith({
        id: "dr-legacy",
        operation: "invitation",
        recipientCount: 1,
        delivery: {},
      }),
    );
    expect(createManagedParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      {
        name: "Newbie",
        email: "newbie@example.com",
        idempotencyKey: expect.any(String),
        sendInvitation: true,
      },
      "token",
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Newbie is ready to respond. Their invitation was queued.",
    );
  });

  test("explains why a blocked account cannot be invited", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    createManagedParticipant.mockRejectedValue(
      Object.assign(new Error("This email belongs to an inactive account."), {
        status: 409,
      }),
    );
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add person" }));
    const form = screen.getByRole("form", { name: /add a person/i });
    fireEvent.change(within(form).getByLabelText(/Full name/), {
      target: { value: "Inactive Person" },
    });
    fireEvent.change(within(form).getByLabelText(/Email/), {
      target: { value: "inactive@example.com" },
    });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "This email belongs to an inactive account.",
    );
    expect(createManagedParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      {
        name: "Inactive Person",
        email: "inactive@example.com",
        idempotencyKey: expect.any(String),
        sendInvitation: false,
      },
      "token",
    );
  });
});

describe("RosterPanel adds people and sends invitations", () => {
  const onDeliveryRequestChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("roster-key") },
    });
    fetchRoster.mockResolvedValue(
      rosterResponse([
        participant({ id: "p-1", name: "Ada", invitationStatus: "not_sent" }),
        participant({ id: "p-2", name: "Ben" }),
      ]),
    );
  });

  async function openAddPersonForm(props = {}) {
    await renderPanel({ onDeliveryRequestChange, ...props });
    const trigger = await screen.findByRole("button", { name: "Add person" });
    expect(trigger).toHaveAttribute("id", "roster-invite-trigger");
    fireEvent.click(trigger);
    const form = screen.getByRole("form", { name: "Add a person" });
    expect(
      within(form).getByRole("heading", { name: "Add a person" }),
    ).toBeInTheDocument();
    expect(form).toHaveTextContent(
      "Add one person to the roster. Enter adds them without emailing; use Add and send invitation to email their secure link now, or Send invitation later.",
    );
    expect(screen.getByRole("button", { name: "Close add person" })).toBe(
      trigger,
    );
    return {
      form,
      name: within(form).getByLabelText(/Full name/),
      email: within(form).getByLabelText(/Email/),
      addOnly: within(form).getByRole("button", { name: "Add only" }),
      addAndSend: within(form).getByRole("button", {
        name: "Add and send invitation",
      }),
    };
  }

  test("Add only adds the person without queuing an invitation", async () => {
    let resolveCreate;
    createManagedParticipant.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { form, name, email, addOnly, addAndSend } =
      await openAddPersonForm();
    expect(addOnly).toHaveAttribute("type", "submit");
    expect(addAndSend).toHaveAttribute("type", "button");
    fireEvent.change(name, { target: { value: "  Newbie " } });
    fireEvent.change(email, { target: { value: " Newbie@Example.com " } });
    fireEvent.click(addOnly);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        {
          name: "Newbie",
          email: "newbie@example.com",
          idempotencyKey: "roster-key",
          sendInvitation: false,
        },
        "token",
      ),
    );
    expect(
      within(form).getByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
    expect(addAndSend).toBeDisabled();
    expect(addAndSend).toHaveTextContent("Add and send invitation");
    expect(
      screen.getByRole("button", { name: "Close add person" }),
    ).toBeDisabled();
    // A second submit while the request is in flight is ignored.
    fireEvent.submit(form);
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    resolveCreate({
      participant: { id: "new-1", name: "Newbie" },
      created: true,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Newbie was added. No invitation was sent.",
    );
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add person" })).toHaveFocus(),
    );
  });

  test("Add only recognises a restored person and someone already on the roster", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: { id: "old-1", name: "Returning" },
      created: false,
      restored: true,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    const { form, name, email } = await openAddPersonForm();
    fireEvent.change(name, { target: { value: "Returning" } });
    fireEvent.change(email, { target: { value: "returning@example.com" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Returning was added. No invitation was sent.",
    );
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();

    createManagedParticipant.mockResolvedValueOnce({
      participant: { id: "p-2", name: "Ben" },
      created: false,
      restored: false,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const reopened = screen.getByRole("form", { name: "Add a person" });
    fireEvent.change(within(reopened).getByLabelText(/Full name/), {
      target: { value: "Ben" },
    });
    fireEvent.change(within(reopened).getByLabelText(/Email/), {
      target: { value: "ben@example.com" },
    });
    fireEvent.click(within(reopened).getByRole("button", { name: "Add only" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ben is already on this roster. No new invitation was sent.",
    );
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
  });

  test("Add and send invitation queues the email and shows its own busy label", async () => {
    let resolveCreate;
    createManagedParticipant.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { form, name, email, addOnly, addAndSend } =
      await openAddPersonForm();
    fireEvent.change(name, { target: { value: "Newbie" } });
    fireEvent.change(email, { target: { value: "newbie@example.com" } });
    fireEvent.click(addAndSend);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        {
          name: "Newbie",
          email: "newbie@example.com",
          idempotencyKey: "roster-key",
          sendInvitation: true,
        },
        "token",
      ),
    );
    expect(
      within(form).getByRole("button", { name: "Adding and sending…" }),
    ).toBeDisabled();
    expect(addOnly).toBeDisabled();
    expect(addOnly).toHaveTextContent("Add only");
    fireEvent.click(addAndSend);
    expect(createManagedParticipant).toHaveBeenCalledTimes(1);

    resolveCreate({
      participant: { id: "new-1", name: "Newbie" },
      created: true,
      autoInvitedCount: 1,
      deliveryRequest: {
        id: "dr-1",
        operation: "invitation",
        recipientCount: 1,
        delivery: {},
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Newbie is ready to respond. Their invitation was queued.",
    );
    expect(onDeliveryRequestChange).toHaveBeenCalledWith({
      id: "dr-1",
      operation: "invitation",
      recipientCount: 1,
      delivery: {},
    });

    // Sending to someone who is already on the roster queues nothing.
    createManagedParticipant.mockResolvedValueOnce({
      participant: { id: "p-2", name: "Ben" },
      created: false,
      autoInvitedCount: 0,
      deliveryRequest: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const reopened = screen.getByRole("form", { name: "Add a person" });
    fireEvent.change(within(reopened).getByLabelText(/Full name/), {
      target: { value: "Ben" },
    });
    fireEvent.change(within(reopened).getByLabelText(/Email/), {
      target: { value: "ben@example.com" },
    });
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Add and send invitation" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ben is already on this roster. No new invitation was sent.",
    );
    expect(onDeliveryRequestChange).toHaveBeenCalledTimes(1);
  });

  test("reports add failures and keeps the typed values", async () => {
    createManagedParticipant.mockRejectedValueOnce(new Error(""));
    const setEvent = jest.fn();
    const { form, name, email } = await openAddPersonForm({ setEvent });
    fireEvent.change(name, { target: { value: "Newbie" } });
    fireEvent.change(email, { target: { value: "newbie@example.com" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Unable to add this person.",
    );
    expect(name).toHaveValue("Newbie");
    expect(email).toHaveValue("newbie@example.com");
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();

    const closedEvent = { ...event, status: "closed" };
    createManagedParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Closed"), {
        errorCode: "event_not_active",
        event: closedEvent,
      }),
    );
    fireEvent.submit(form);
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent(
        "This event is closed. Reactivate it before adding participants.",
      ),
    );
    expect(setEvent).toHaveBeenCalledWith(closedEvent);

    createManagedParticipant.mockResolvedValueOnce({ participant: {} });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent(
        "The participant was added without a roster ID.",
      ),
    );
    expect(createManagedParticipant).toHaveBeenCalledTimes(3);
    // The same idempotency key is reused until the values change.
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
    fireEvent.change(name, { target: { value: "Newbie Two" } });
    createManagedParticipant.mockRejectedValueOnce(new Error("Nope"));
    fireEvent.submit(form);
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent("Nope"),
    );
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(2);
  });

  test("sends invitations to the selected people from either bar", async () => {
    let resolveSend;
    sendRosterInvitations.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    await renderPanel({ onDeliveryRequestChange });
    await screen.findByText("Ada");
    const sendButtons = screen.getAllByRole("button", {
      name: "Send invitation",
    });
    expect(sendButtons).toHaveLength(2);
    sendButtons.forEach((button) => expect(button).toBeDisabled());
    const resendBoxes = screen.getAllByLabelText(
      "Resend to people already invited",
    );
    expect(resendBoxes).toHaveLength(2);
    expect(resendBoxes[0].id).not.toBe(resendBoxes[1].id);
    resendBoxes.forEach((box) => expect(box).not.toBeChecked());
    expect(screen.getAllByText("0 selected")).toHaveLength(2);

    const list = screen.getByRole("region", { name: "Roster entries" });
    const [topBar, bottomBar] = within(list).getAllByText(/selected$/);
    const table = screen.getByRole("region", { name: "Roster participants" });
    expect(
      topBar.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      table.compareDocumentPosition(bottomBar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Select Ada"));
    expect(screen.getAllByText("1 selected")).toHaveLength(2);
    sendButtons.forEach((button) => expect(button).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Select all on page"));
    expect(screen.getAllByText("2 selected")).toHaveLength(2);

    fireEvent.click(sendButtons[1]);
    await waitFor(() =>
      expect(sendRosterInvitations).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1", "p-2"],
          resend: false,
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(screen.getAllByRole("button", { name: "Sending…" })).toHaveLength(2);
    screen
      .getAllByRole("button", { name: "Sending…" })
      .forEach((button) => expect(button).toBeDisabled());

    resolveSend({
      deliveryRequest: {
        id: "dr-roster",
        operation: "invitation",
        recipientCount: 1,
        delivery: { total: 1, pending: 1 },
      },
      requestedCount: 2,
      queuedCount: 1,
      skippedCount: 1,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Queued 1 invitation(s). 1 already invited were skipped.",
    );
    expect(onDeliveryRequestChange).toHaveBeenCalledWith({
      id: "dr-roster",
      operation: "invitation",
      recipientCount: 1,
      delivery: { total: 1, pending: 1 },
    });
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("0 selected")).toHaveLength(2);
    expect(screen.getByLabelText("Select Ada")).not.toBeChecked();
    expect(screen.getByLabelText("Select Ben")).not.toBeChecked();
    screen
      .getAllByRole("button", { name: "Send invitation" })
      .forEach((button) => expect(button).toBeDisabled());
  });

  test("resends to people already invited and skips delivery progress when nothing was queued", async () => {
    sendRosterInvitations.mockResolvedValueOnce({
      deliveryRequest: {
        id: "dr-empty",
        operation: "invitation",
        recipientCount: 0,
        delivery: {},
      },
      requestedCount: 1,
      queuedCount: 0,
      skippedCount: 1,
    });
    await renderPanel({ onDeliveryRequestChange });
    await screen.findByText("Ada");
    const [topResend, bottomResend] = screen.getAllByLabelText(
      "Resend to people already invited",
    );
    fireEvent.click(topResend);
    expect(topResend).toBeChecked();
    expect(bottomResend).toBeChecked();
    fireEvent.click(screen.getByLabelText("Select Ben"));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Send invitation" })[0],
    );
    await waitFor(() =>
      expect(sendRosterInvitations).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-2"],
          resend: true,
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Queued 0 invitation(s). 1 already invited were skipped.",
    );
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
    // The checkbox keeps its value for the next send.
    expect(topResend).toBeChecked();

    sendRosterInvitations.mockResolvedValueOnce({});
    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Send invitation" })[1],
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Queued 0 invitation(s). 0 already invited were skipped.",
      ),
    );
    expect(sendRosterInvitations).toHaveBeenLastCalledWith(
      "ROSTER1",
      { participantIds: ["p-1"], resend: true, idempotencyKey: "roster-key" },
      "token",
    );
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
  });

  test("reports send failures and keeps the selection", async () => {
    sendRosterInvitations
      .mockRejectedValueOnce(new Error("Too many invitations"))
      .mockRejectedValueOnce(new Error(""));
    await renderPanel({ onDeliveryRequestChange });
    await screen.findByText("Ada");
    fireEvent.click(screen.getByLabelText("Select Ada"));
    const [sendButton] = screen.getAllByRole("button", {
      name: "Send invitation",
    });
    fireEvent.click(sendButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many invitations",
    );
    expect(screen.getByLabelText("Select Ada")).toBeChecked();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(sendButton);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to send invitations.",
      ),
    );
    expect(sendRosterInvitations).toHaveBeenCalledTimes(2);
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
  });

  test("hides the send bars while the roster is read-only or empty", async () => {
    const { unmount } = await renderPanel({
      event: { ...event, status: "closed" },
    });
    await screen.findByText("Ada");
    expect(
      screen.queryByRole("button", { name: "Send invitation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Resend to people already invited"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    unmount();

    fetchRoster.mockResolvedValue(rosterResponse([]));
    await renderPanel();
    expect(
      await screen.findByText(
        "Add someone or import a roster to start collecting availability.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Send invitation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add person" })).toBeEnabled();
  });
});

describe("RosterPanel groups", () => {
  const stats = {
    total: 3,
    submitted: 1,
    notSubmitted: 2,
    groups: [
      { name: "Faculty", count: 2, weight: 1 },
      { name: "", count: 1, weight: null },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("group-key") },
    });
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({ id: "p-1", name: "Ada", group: "Faculty" }),
          participant({ id: "p-2", name: "Ben", group: "Faculty" }),
          participant({ id: "p-3", name: "Cara", group: "", weight: 0.5 }),
        ],
        { stats },
      ),
    );
    patchRosterBulk.mockResolvedValue({ updatedCount: 2, resultsRevision: 9 });
  });

  test("sets a group weight and renames a group through bulk patches", async () => {
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    await screen.findByText("Ada");
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "1 group",
    );
    const groupsRegion = screen.getByRole("region", { name: "Roster groups" });
    expect(groupsRegion).toHaveTextContent("Faculty");
    expect(groupsRegion).toHaveTextContent("2 people");
    // Existing names complete the per-person group inputs.
    expect(screen.getByLabelText("Group for Ada")).toHaveAttribute("list");
    expect(
      document.querySelector(
        `#${CSS.escape(screen.getByLabelText("Group for Ada").getAttribute("list"))} option[value="Faculty"]`,
      ),
    ).not.toBeNull();

    const weight = screen.getByLabelText("Weight for group Faculty");
    fireEvent.change(weight, { target: { value: "0.5" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          group: "Faculty",
          updates: { weight: 0.5 },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Weight 0.5 now applies to 2 people in Faculty.",
    );
    expect(onResultsInvalidated).toHaveBeenCalledWith(9);
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for group Faculty"), {
      target: { value: "Teachers" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          group: "Faculty",
          updates: { group: "Teachers" },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Renamed Faculty to Teachers for 2 people.",
    );
  });

  test("moves selected people, creates a group from them, and filters by group", async () => {
    await renderPanel();
    await screen.findByText("Ada");
    fireEvent.click(screen.getByLabelText("Select Cara"));
    await userEvent.click(
      screen.getByRole("button", { name: "Move selected here" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-3"],
          updates: { group: "Faculty" },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Moved 2 people to Faculty.",
    );
    // The selection is spent once the move succeeds.
    await waitFor(() =>
      expect(screen.getByLabelText("Select Cara")).not.toBeChecked(),
    );

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(screen.getByLabelText("Select Ben"));
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Board" },
    });
    fireEvent.change(screen.getByLabelText("New group weight"), {
      target: { value: "0.75" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1", "p-2"],
          updates: { group: "Board", weight: 0.75 },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created Board with 2 people at weight 0.75.",
    );

    fireEvent.click(screen.getByLabelText("Select Ada"));
    await userEvent.click(
      screen.getByRole("button", { name: "Ungroup selected" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { group: "" },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Removed 2 people from their groups.",
    );

    await userEvent.click(
      screen.getAllByRole("button", { name: "Show people" })[0],
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Faculty", page: 1 }),
        "token",
      ),
    );
    expect(screen.getByLabelText("Filter by group")).toHaveValue("Faculty");
    await userEvent.click(
      screen.getByRole("button", { name: "Show everyone" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Filter by group")).toHaveValue(""),
    );
  });

  test("applies the group stats returned by a per-person patch", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ id: "p-1", name: "Ada", weight: 0.5 }),
      groups: [
        { name: "Faculty", count: 2, weight: null },
        { name: "", count: 1, weight: null },
      ],
    });
    await renderPanel();
    const weight = await screen.findByLabelText("Weight for Ada");
    expect(screen.getByLabelText("Weight for group Faculty")).toHaveValue(1);
    fireEvent.change(weight, { target: { value: "0.5" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByLabelText("Weight for group Faculty")).toHaveValue(
        null,
      ),
    );
    expect(
      screen.getByRole("region", { name: "Roster groups" }),
    ).toHaveTextContent("Mixed");
    // No roster reload was needed for the table to update.
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });

  test("reports group update failures and keeps the roster editable", async () => {
    patchRosterBulk.mockRejectedValueOnce(new Error("Group patch failed"));
    await renderPanel();
    const weight = await screen.findByLabelText("Weight for group Faculty");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Group patch failed",
    );
    expect(screen.getByLabelText("Weight for group Faculty")).toBeEnabled();

    patchRosterBulk.mockRejectedValueOnce(new Error(""));
    fireEvent.change(weight, { target: { value: "0.3" } });
    fireEvent.blur(weight);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to update this group.",
    );
  });

  test("moves people with the bulk action and locks groups while responses are closed", async () => {
    const { unmount } = await renderPanel();
    const bulk = await screen.findByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    expect(bulk).toHaveTextContent(
      "Move to a group, change weight or inclusion",
    );
    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(within(bulk).getByLabelText("Apply bulk group"));
    fireEvent.change(within(bulk).getByLabelText("Bulk group name"), {
      target: { value: " Staff " },
    });
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { group: "Staff" },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    unmount();

    await renderPanel({ event: { ...event, status: "closed" } });
    expect(
      await screen.findByLabelText("Weight for group Faculty"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "New group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move selected here" }),
    ).not.toBeInTheDocument();
  });
});
