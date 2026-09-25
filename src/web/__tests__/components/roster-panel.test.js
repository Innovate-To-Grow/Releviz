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
  joinEvent: jest.fn(),
  updateParticipant: jest.fn(),
}));

jest.mock("@/lib/api/roster", () => ({
  createRosterGroup: jest.fn(),
  deleteRosterGroup: jest.fn(),
  deleteRosterParticipant: jest.fn(),
  fetchRoster: jest.fn(),
  fetchRosterGroups: jest.fn(),
  fetchRosterSchedule: jest.fn(),
  includeOnlyRosterGroup: jest.fn(),
  patchRosterBulk: jest.fn(),
  patchRosterParticipant: jest.fn(),
  renameRosterGroup: jest.fn(),
  sendRosterInvitations: jest.fn(),
}));

import RosterPanel from "@/components/schedule/RosterPanel";
import {
  createManagedParticipant,
  joinEvent,
  updateParticipant,
} from "@/lib/api/participants";
import {
  createRosterGroup,
  deleteRosterGroup,
  deleteRosterParticipant,
  fetchRoster,
  fetchRosterSchedule,
  includeOnlyRosterGroup,
  patchRosterBulk,
  patchRosterParticipant,
  renameRosterGroup,
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

  test("closes the drawer when the person took over their response", async () => {
    await renderPanel();
    const owned = Object.assign(new Error("Forbidden"), {
      status: 403,
      errorCode: "organizer_edit_participant_owned",
    });
    updateParticipant.mockRejectedValueOnce(owned);
    let dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person now manages their own response, so you can no longer edit their schedule.",
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(2);

    // A backend from before the rename still sends the legacy code.
    updateParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), {
        status: 403,
        code: "organizer_edit_full_account",
      }),
    );
    dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Temp Person now manages their own response, so you can no longer edit their schedule.",
    );

    // Any other 403 stays inside the drawer.
    updateParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Not allowed."), {
        status: 403,
        errorCode: "event_not_active",
      }),
    );
    dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Not allowed.",
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
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
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint in-person" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    // Dirty: an in-page dialog asks first; the drawer stays open behind it.
    let discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    expect(
      screen.getByRole("dialog", { name: "Edit Temp Person's schedule" }),
    ).toBeInTheDocument();

    // Escape while the dialog is open closes only the dialog, not the drawer.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Temp Person's schedule" }),
    ).toBeInTheDocument();

    // Cancelling the dialog keeps editing.
    fireEvent.keyDown(document, { key: "Escape" });
    discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    fireEvent.click(
      within(discardDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Temp Person's schedule" }),
    ).toBeInTheDocument();

    // Confirming discards the edits and closes the drawer.
    fireEvent.keyDown(document, { key: "Escape" });
    discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    fireEvent.click(
      within(discardDialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");

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
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    fireEvent.click(
      within(discardDialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    fetchRosterSchedule.mockRejectedValueOnce(new Error(""));
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to load Temp Person's schedule.",
      ),
    );
  });

  test("edits a full account's schedule until they respond themselves", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([participant({ accountAccess: "full" })]),
    );
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "roster-row-1",
          memberId: "p-1",
          name: "Temp Person",
          version: 4,
          accountAccess: "full",
          canOrganizerEditAvailability: true,
        },
      }),
    );
    updateParticipant.mockResolvedValue({ participant: { version: 5 } });
    await renderPanel();
    const row = (await screen.findByText("Temp Person")).closest("tr");
    expect(row).toHaveTextContent("Full account");
    const dialog = await openEditor();
    expect(
      within(dialog).getByText("Full account · not responded yet"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        expect.objectContaining({ name: "Temp Person", submitted: 0 }),
        "token",
      ),
    );
  });

  test("reloads instead of opening a response the person has claimed since the roster loaded", async () => {
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "roster-row-1",
          memberId: "p-1",
          name: "Temp Person",
          version: 4,
          accountAccess: "full",
          canOrganizerEditAvailability: false,
        },
      }),
    );
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit schedule" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Temp Person now manages their own response, so you can no longer edit their schedule.",
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(2);
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
  });

  test("offers an Ungrouped filter, multi-group cells, and every delivery label", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({
            id: "a",
            name: "Alpha",
            group: "ALL; Faculty",
            groups: [{ id: 1, name: "Faculty" }],
            allGroups: true,
          }),
          participant({
            id: "b",
            name: "Beta",
            group: null,
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
            group: "Faculty; Staff",
            groups: [
              { id: 1, name: "Faculty" },
              { id: 2, name: "Staff" },
            ],
            invitationStatus: "accepted",
            submitted: 1,
          }),
        ],
        {
          stats: {
            total: 4,
            submitted: 1,
            notSubmitted: 3,
            groups: [
              { id: 1, name: "Faculty" },
              { id: 2, name: "Staff" },
              { id: null, name: "" },
            ],
          },
        },
      ),
    );
    await renderPanel();
    const groupFilter = await screen.findByLabelText("Filter by group");
    expect(
      within(groupFilter).getByRole("option", { name: "Ungrouped" }),
    ).toHaveValue("__ungrouped__");
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "2 groups",
    );
    const table = screen.getByRole("region", { name: "Roster participants" });
    // Name, email, then All and one checkbox column per group, headed by the
    // group's name as typed.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "",
      "Name",
      "Email",
      "All",
      "Faculty",
      "Staff",
      "Settings",
      "Status",
    ]);
    expect(
      within(table).getByRole("columnheader", { name: "All" }),
    ).toHaveAttribute("title", "Every group, including groups created later");
    // The All flag ticks (and locks) every column; explicit memberships tick
    // their own columns.
    expect(screen.getByLabelText("All groups for Alpha")).toBeChecked();
    expect(screen.getByLabelText("All groups for Beta")).not.toBeChecked();
    for (const name of ["Faculty", "Staff"]) {
      const alpha = screen.getByLabelText(`Alpha in ${name}`);
      expect(alpha).toBeChecked();
      expect(alpha).toBeDisabled();
      expect(alpha).toHaveAttribute(
        "title",
        `${name}: included through All groups`,
      );
      expect(screen.getByLabelText(`Beta in ${name}`)).not.toBeChecked();
      expect(screen.getByLabelText(`Gamma in ${name}`)).not.toBeChecked();
      expect(screen.getByLabelText(`Delta in ${name}`)).toBeChecked();
      expect(screen.getByLabelText(`Delta in ${name}`)).toBeEnabled();
      expect(screen.getByLabelText(`Delta in ${name}`)).toHaveAttribute(
        "title",
        name,
      );
    }
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
    expect(screen.getByLabelText("All groups for Temp Person")).toBeDisabled();
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
    expect(screen.getByLabelText("All groups for Temp Person")).toBeEnabled();
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
    expect(screen.getByLabelText("All groups for Temp Person")).toBeEnabled();
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

  test("a silent reload swaps the page in place and hands back its digest", async () => {
    const activity = {
      total: 1,
      submitted: 0,
      changedAt: "2026-08-20T08:00:00Z",
    };
    fetchRoster.mockResolvedValue(
      rosterResponse([participant()], { activity }),
    );
    const panel = createRef();
    await renderPanel({ ref: panel });
    await screen.findByLabelText("Weight for Temp Person");
    expect(panel.current.activity()).toEqual(activity);

    // The organizer is typing in a row while the live sync re-reads the page:
    // the table never unmounts, so the field keeps focus and its draft.
    const weight = screen.getByLabelText("Weight for Temp Person");
    weight.focus();
    fireEvent.change(weight, { target: { value: "0.7" } });
    const moved = { total: 1, submitted: 1, changedAt: "2026-08-20T09:00:00Z" };
    let releaseRoster;
    fetchRoster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRoster = resolve;
        }),
    );
    let silent;
    act(() => {
      silent = panel.current.refresh("token", { silent: true });
    });
    expect(screen.queryByText("Loading roster…")).not.toBeInTheDocument();
    await act(async () => {
      releaseRoster(
        rosterResponse(
          [participant({ submitted: 1, invitationStatus: "submitted" })],
          {
            activity: moved,
          },
        ),
      );
      await silent;
    });
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(panel.current.activity()).toEqual(moved);
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "1 submitted",
    );
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveFocus();
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.7);

    // A silent failure is the caller's to report; the panel shows nothing
    // and keeps what it has. A listing without a digest clears the digest.
    fetchRoster.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(
        panel.current.refresh("token", { silent: true }),
      ).rejects.toThrow("offline");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "1 submitted",
    );
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ submitted: 1 })]),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(panel.current.activity()).toBeNull();
  });

  test("a reload never moves a row behind a patch that landed while it was in flight", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    const panel = createRef();
    await renderPanel({ ref: panel });
    const weight = await screen.findByLabelText("Weight for Temp Person");

    // The listing was read before the patch and still carries version 4.
    let releaseRoster;
    fetchRoster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRoster = resolve;
        }),
    );
    let silent;
    act(() => {
      silent = panel.current.refresh("token", { silent: true });
    });
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ weight: 0.5, version: 5 }),
    });
    fireEvent.change(weight, { target: { value: "0.5" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Temp Person was updated.",
      ),
    );
    await act(async () => {
      releaseRoster(rosterResponse([participant({ weight: 1, version: 4 })]));
      await silent;
    });
    // The stale listing did not undo the saved weight.
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.5);

    // A newer listing still wins.
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ weight: 0.9, version: 6 })]),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(0.9);
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
        phone: "",
        organizerManaged: false,
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
        phone: "",
        organizerManaged: false,
        idempotencyKey: expect.any(String),
        sendInvitation: false,
      },
      "token",
    );
  });
});

describe("RosterPanel organizer-managed people", () => {
  const managedHelp =
    "Leave blank to use your account email, or enter another of your verified addresses. No invitation is sent.";
  const managedLabel =
    "No email of their own — use one of mine and I'll enter their schedule";

  beforeEach(() => {
    jest.clearAllMocks();
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
  });

  async function openInviteForm() {
    fireEvent.click(await screen.findByRole("button", { name: "Add person" }));
    const form = screen.getByRole("form", { name: /add a person/i });
    const name = within(form).getByLabelText(/Full name/);
    // Opening moves focus to the name on a timer; wait for it so later focus
    // assertions are not overtaken.
    await waitFor(() => expect(name).toHaveFocus());
    return {
      form,
      name,
      email: within(form).getByLabelText(/Email address/),
      phone: within(form).getByLabelText("Phone (optional)"),
      managed: within(form).getByLabelText(managedLabel),
    };
  }

  test("adds a person the organizer manages without sending an invitation", async () => {
    const onDeliveryRequestChange = jest.fn();
    createManagedParticipant.mockResolvedValue({
      participant: { id: "managed-1", name: "Managed Person" },
      created: true,
      restored: false,
      memberCreated: true,
      autoInvitedCount: 0,
      deliveryRequest: {
        id: "managed-delivery",
        operation: "invitation",
        recipientCount: 0,
        delivery: {},
      },
    });
    await renderPanel({ onDeliveryRequestChange });
    const invite = await openInviteForm();
    expect(invite.phone).toHaveAttribute("type", "tel");
    expect(invite.phone).toHaveAttribute("maxlength", "32");
    expect(invite.managed).not.toBeChecked();
    expect(within(invite.form).queryByText(managedHelp)).toBeNull();
    expect(
      within(invite.form).getByRole("button", { name: "Add only" }),
    ).toHaveAttribute("type", "submit");
    expect(
      within(invite.form)
        .getByRole("button", { name: "Add and send invitation" })
        .querySelector(".app-btn-icon"),
    ).not.toBeNull();

    // Sending is meaningless for a person without their own email, so the
    // form collapses to a single add action.
    fireEvent.click(invite.managed);
    expect(invite.managed).toBeChecked();
    expect(invite.email).toHaveAccessibleDescription(managedHelp);
    const submit = within(invite.form).getByRole("button", {
      name: "Add person",
    });
    expect(submit).toHaveAttribute("type", "submit");
    expect(submit.querySelector(".app-btn-icon")).toBeNull();
    expect(
      within(invite.form).queryByRole("button", {
        name: "Add and send invitation",
      }),
    ).toBeNull();
    expect(
      within(invite.form).queryByRole("button", { name: "Add only" }),
    ).toBeNull();

    fireEvent.change(invite.name, { target: { value: " Managed Person " } });
    fireEvent.change(invite.email, {
      target: { value: "Organizer@Example.com" },
    });
    fireEvent.change(invite.phone, { target: { value: " +1 555 010 0199 " } });
    fireEvent.submit(invite.form);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Managed Person was added. Use Edit schedule to enter their availability.",
    );
    expect(createManagedParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      {
        name: "Managed Person",
        email: "organizer@example.com",
        phone: "+1 555 010 0199",
        organizerManaged: true,
        idempotencyKey: expect.any(String),
        sendInvitation: false,
      },
      "token",
    );
    // No invitation was queued, so there is no delivery progress to show.
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: /add a person/i })).toBeNull();

    // The form comes back clean for the next person.
    const reopened = await openInviteForm();
    expect(reopened.phone).toHaveValue("");
    expect(reopened.managed).not.toBeChecked();
    expect(
      within(reopened.form).getByRole("button", {
        name: "Add and send invitation",
      }),
    ).toBeInTheDocument();
  });

  test("keeps the existing notice when a managed person is already on the roster", async () => {
    createManagedParticipant
      .mockResolvedValueOnce({
        participant: { id: "managed-1", name: "Managed Person" },
        created: false,
        restored: false,
        autoInvitedCount: 0,
        deliveryRequest: null,
      })
      .mockResolvedValueOnce({
        participant: { id: "managed-1", name: "Managed Person" },
        created: false,
        restored: true,
        autoInvitedCount: 0,
        deliveryRequest: null,
      });
    await renderPanel();
    let invite = await openInviteForm();
    fireEvent.click(invite.managed);
    fireEvent.change(invite.name, { target: { value: "Managed Person" } });
    fireEvent.change(invite.email, {
      target: { value: "organizer@example.com" },
    });
    fireEvent.submit(invite.form);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /^Managed Person is already on this roster\. No new invitation was sent\.$/,
    );

    // A hidden row that comes back counts as added again.
    invite = await openInviteForm();
    fireEvent.click(invite.managed);
    fireEvent.change(invite.name, { target: { value: "Managed Person" } });
    fireEvent.change(invite.email, {
      target: { value: "organizer@example.com" },
    });
    fireEvent.submit(invite.form);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Managed Person was added. Use Edit schedule to enter their availability.",
    );
    expect(createManagedParticipant).toHaveBeenCalledTimes(2);
    expect(createManagedParticipant.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        phone: "",
        organizerManaged: true,
        sendInvitation: false,
      }),
    );
  });

  test("shows the server's own-address hint and clears it when the checkbox changes", async () => {
    createManagedParticipant.mockRejectedValue(
      Object.assign(
        new Error(
          'That is one of your own addresses. Check "No email of their own" to add a person you manage.',
        ),
        { status: 409, errorCode: "organizer_own_email" },
      ),
    );
    await renderPanel();
    const invite = await openInviteForm();
    fireEvent.change(invite.name, { target: { value: "Managed Person" } });
    fireEvent.change(invite.email, {
      target: { value: "organizer@example.com" },
    });
    fireEvent.submit(invite.form);
    const error = await within(invite.form).findByRole("alert");
    expect(error).toHaveClass("roster-invite-form__error");
    expect(error).toHaveTextContent(
      'That is one of your own addresses. Check "No email of their own" to add a person you manage.',
    );
    expect(createManagedParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      expect.objectContaining({ organizerManaged: false }),
      "token",
    );
    // The typed values survive the failure.
    expect(invite.name).toHaveValue("Managed Person");
    expect(invite.email).toHaveValue("organizer@example.com");

    fireEvent.click(invite.managed);
    expect(within(invite.form).queryByRole("alert")).toBeNull();
    expect(invite.managed).toBeChecked();
  });

  test("validates the phone before sending and clears the error once it is fixed", async () => {
    await renderPanel();
    const invite = await openInviteForm();
    fireEvent.change(invite.name, { target: { value: "Managed Person" } });
    fireEvent.change(invite.email, {
      target: { value: "person@example.com" },
    });

    fireEvent.change(invite.phone, { target: { value: "call me" } });
    fireEvent.blur(invite.phone);
    expect(
      within(invite.form).getByText("Enter a valid phone number."),
    ).toBeVisible();
    fireEvent.change(invite.phone, { target: { value: "12345" } });
    expect(
      within(invite.form).queryByText("Enter a valid phone number."),
    ).toBeNull();
    fireEvent.submit(invite.form);
    expect(
      await within(invite.form).findByText("Enter a valid phone number."),
    ).toBeVisible();
    expect(invite.phone).toHaveFocus();
    expect(invite.phone).toHaveAttribute("aria-invalid", "true");
    expect(createManagedParticipant).not.toHaveBeenCalled();

    fireEvent.change(invite.phone, { target: { value: "1".repeat(33) } });
    fireEvent.blur(invite.phone);
    expect(
      within(invite.form).getByText("Phone must be 32 characters or fewer."),
    ).toBeVisible();
    fireEvent.submit(invite.form);
    expect(createManagedParticipant).not.toHaveBeenCalled();

    // Name errors still take focus first.
    fireEvent.change(invite.name, { target: { value: " " } });
    fireEvent.submit(invite.form);
    expect(
      await within(invite.form).findByText("Full name is required."),
    ).toBeVisible();
    expect(invite.name).toHaveFocus();

    createManagedParticipant.mockResolvedValue({
      participant: { id: "new-1", name: "Managed Person" },
      created: true,
      autoInvitedCount: 1,
      deliveryRequest: null,
    });
    fireEvent.change(invite.name, { target: { value: "Managed Person" } });
    fireEvent.change(invite.phone, { target: { value: "+1 (555) 010-0199" } });
    expect(
      within(invite.form).queryByText("Phone must be 32 characters or fewer."),
    ).toBeNull();
    fireEvent.blur(invite.phone);
    expect(within(invite.form).queryByRole("alert")).toBeNull();
    fireEvent.click(
      within(invite.form).getByRole("button", {
        name: "Add and send invitation",
      }),
    );
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        expect.objectContaining({
          phone: "+1 (555) 010-0199",
          organizerManaged: false,
          sendInvitation: true,
        }),
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Managed Person is ready to respond. Their invitation was queued.",
    );
  });

  test("resets the phone and checkbox when the form closes", async () => {
    await renderPanel();
    let invite = await openInviteForm();
    fireEvent.change(invite.phone, { target: { value: "+1 555 010 0199" } });
    fireEvent.click(invite.managed);
    expect(invite.managed).toBeChecked();
    fireEvent.click(
      within(invite.form).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("form", { name: /add a person/i })).toBeNull();

    invite = await openInviteForm();
    expect(invite.phone).toHaveValue("");
    expect(invite.managed).not.toBeChecked();
    expect(
      within(invite.form).getByRole("button", {
        name: "Add and send invitation",
      }),
    ).toBeInTheDocument();
  });

  test("labels organizer-managed rows and never shows the organizer's address as theirs", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([
        participant({
          id: "managed-1",
          name: "Managed Person",
          email: "organizer@example.com",
          phone: "+1 555 010 0199",
          organizerManaged: true,
          invitationStatus: "not_sent",
        }),
        participant({
          id: "p-2",
          name: "Plain Person",
          organizerManaged: false,
        }),
        participant({
          id: "p-3",
          name: "Full Person",
          email: "",
          phone: "",
          accountAccess: "full",
          canOrganizerEditAvailability: false,
        }),
      ]),
    );
    await renderPanel();
    const table = await screen.findByRole("region", {
      name: "Roster participants",
    });
    const rowFor = (name) =>
      within(table).getByRole("rowheader", { name }).closest("tr");
    const managedRow = rowFor(/Managed Person/);
    expect(managedRow).not.toHaveTextContent("organizer@example.com");
    expect(within(managedRow).getByText("No email")).toBeInTheDocument();
    expect(within(managedRow).getByText("+1 555 010 0199")).toBeInTheDocument();
    expect(
      within(managedRow).getByText("Organizer-managed"),
    ).toBeInTheDocument();
    const plainRow = rowFor(/Plain Person/);
    expect(within(plainRow).getByText("temp@example.com")).toBeInTheDocument();
    expect(within(plainRow).getByText("Temporary")).toBeInTheDocument();
    const fullRow = rowFor(/Full Person/);
    expect(within(fullRow).getByText("No email")).toBeInTheDocument();
    expect(within(fullRow).getByText("Full account")).toBeInTheDocument();
    // The organizer enters a managed person's schedule.
    expect(
      within(managedRow).getByRole("button", { name: "Edit schedule" }),
    ).toBeEnabled();
    expect(within(managedRow).getByText("Not sent")).toBeInTheDocument();
    expect(screen.getByLabelText("Search roster")).toHaveAttribute(
      "placeholder",
      "Search name, email or phone",
    );
  });

  test("patches a row's phone on blur and skips unchanged values", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ phone: "+1 555 010 0199", version: 5 }),
    });
    await renderPanel();
    const phone = await screen.findByLabelText("Phone for Temp Person");
    expect(phone).toHaveAttribute("type", "tel");
    expect(phone).toHaveAttribute("maxlength", "32");
    expect(phone).toHaveValue("");

    // Blurring without a change sends nothing.
    fireEvent.blur(phone);
    expect(patchRosterParticipant).not.toHaveBeenCalled();

    fireEvent.change(phone, { target: { value: "+1 555 010 0199" } });
    expect(phone).toHaveValue("+1 555 010 0199");
    fireEvent.blur(phone);
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { phone: "+1 555 010 0199", expectedVersion: 4 },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Temp Person was updated.",
    );
    expect(phone).toHaveValue("+1 555 010 0199");
    expect(
      within(phone.closest("tr")).getByText("+1 555 010 0199", {
        selector: "small",
      }),
    ).toBeInTheDocument();

    // The next patch carries the version the server returned; an identical
    // value is not re-sent.
    fireEvent.change(phone, { target: { value: "+1 555 010 0199" } });
    fireEvent.blur(phone);
    expect(patchRosterParticipant).toHaveBeenCalledTimes(1);

    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Enter a valid phone number."), { status: 400 }),
    );
    fireEvent.change(phone, { target: { value: "nope" } });
    fireEvent.blur(phone);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid phone number.",
    );
    expect(patchRosterParticipant).toHaveBeenLastCalledWith(
      "ROSTER1",
      "p-1",
      { phone: "nope", expectedVersion: 5 },
      "token",
    );
    // The rejected draft rolls back to the saved phone.
    await waitFor(() => expect(phone).toHaveValue("+1 555 010 0199"));
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
          phone: "",
          organizerManaged: false,
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

  test("Add only for an existing full account explains Edit schedule and selects nobody", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "m-9",
        name: "Avery",
        accountAccess: "full",
        canOrganizerEditAvailability: true,
      },
      created: true,
      memberCreated: false,
      autoInvitedCount: 0,
    });
    sendRosterInvitations.mockResolvedValueOnce({
      deliveryRequest: null,
      requestedCount: 1,
      queuedCount: 1,
      skippedCount: 0,
    });
    const { form, name, email } = await openAddPersonForm();
    fireEvent.change(name, { target: { value: "Avery" } });
    fireEvent.change(email, { target: { value: "avery@example.com" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Avery was added. No invitation was sent. They already have a Releviz account, so you can use Edit schedule until they respond themselves.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));

    // Adding someone never selects them, so the next send reaches only the
    // people the organizer checks.
    expect(screen.getAllByText("0 selected")).toHaveLength(2);
    screen
      .getAllByRole("button", { name: "Send invitation" })
      .forEach((button) => expect(button).toBeDisabled());
    fireEvent.click(screen.getByLabelText("Select Ben"));
    expect(screen.getAllByText("1 selected")).toHaveLength(2);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Send invitation" })[0],
    );
    await waitFor(() =>
      expect(sendRosterInvitations).toHaveBeenCalledWith(
        "ROSTER1",
        expect.objectContaining({ participantIds: ["p-2"] }),
        "token",
      ),
    );
  });

  test("Add only skips the Edit schedule hint for an account the organizer cannot edit", async () => {
    createManagedParticipant.mockResolvedValueOnce({
      participant: {
        id: "m-9",
        name: "Avery",
        accountAccess: "full",
        canOrganizerEditAvailability: false,
      },
      created: false,
      restored: true,
      autoInvitedCount: 0,
    });
    const { form, name, email } = await openAddPersonForm();
    fireEvent.change(name, { target: { value: "Avery" } });
    fireEvent.change(email, { target: { value: "avery@example.com" } });
    fireEvent.submit(form);
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      "Avery was added. No invitation was sent.",
    );
    expect(notice).not.toHaveTextContent("Edit schedule");
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
          phone: "",
          organizerManaged: false,
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
  const facultyGroup = { id: 11, name: "Faculty", count: 2, weight: 1 };
  const ungrouped = { id: null, name: "", count: 1, weight: null };
  const stats = {
    total: 3,
    submitted: 1,
    notSubmitted: 2,
    groups: [facultyGroup, ungrouped],
  };
  // What the roster and the group endpoints return once Faculty has been
  // renamed to Teachers.
  const teachersGroup = { ...facultyGroup, name: "Teachers" };
  const renamedRoster = rosterResponse(
    [
      participant({
        id: "p-1",
        name: "Ada",
        group: "Teachers",
        groups: [{ id: 11, name: "Teachers" }],
      }),
      participant({
        id: "p-2",
        name: "Ben",
        group: "Teachers",
        groups: [{ id: 11, name: "Teachers" }],
      }),
      participant({
        id: "p-3",
        name: "Cara",
        group: "",
        groups: [],
        weight: 0.5,
      }),
    ],
    { stats: { ...stats, groups: [teachersGroup, ungrouped] } },
  );
  const renamedResponse = {
    group: teachersGroup,
    groups: [teachersGroup, ungrouped],
  };

  async function openBulk() {
    const bulk = await screen.findByLabelText("Bulk roster actions");
    fireEvent.click(within(bulk).getByText("Bulk actions"));
    return bulk;
  }

  // Clicks the row's "Delete group" and confirms in the in-page dialog.
  async function confirmGroupDelete(name) {
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    const confirmDialog = await screen.findByRole("dialog", {
      name: `Delete group ${name}?`,
    });
    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete group" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: `Delete group ${name}?` }),
      ).not.toBeInTheDocument(),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("group-key") },
    });
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({
            id: "p-1",
            name: "Ada",
            group: "Faculty",
            groups: [{ id: 11, name: "Faculty" }],
          }),
          participant({
            id: "p-2",
            name: "Ben",
            group: "Faculty",
            groups: [{ id: 11, name: "Faculty" }],
          }),
          participant({
            id: "p-3",
            name: "Cara",
            group: "",
            groups: [],
            weight: 0.5,
          }),
        ],
        { stats },
      ),
    );
    patchRosterBulk.mockResolvedValue({ updatedCount: 2, resultsRevision: 9 });
  });

  test("sets a group weight through a bulk patch and renames a group through its endpoint", async () => {
    renameRosterGroup.mockResolvedValue(renamedResponse);
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    await screen.findByText("Ada");
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "1 group",
    );
    const groupsRegion = screen.getByRole("region", { name: "Roster groups" });
    expect(groupsRegion).toHaveTextContent("Faculty");
    expect(groupsRegion).toHaveTextContent("2 people");
    // Each group heads a checkbox column in the roster.
    expect(screen.getByLabelText("Ada in Faculty")).toBeChecked();
    expect(screen.getByLabelText("Cara in Faculty")).not.toBeChecked();

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
    fetchRoster.mockResolvedValue(renamedRoster);
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(renameRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        11,
        { name: "Teachers" },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Renamed Faculty to Teachers.",
    );
    // The recounted groups arrive with the response, and the rows reload so
    // their cell strings pick up the new spelling.
    expect(
      await screen.findByLabelText("Weight for group Teachers"),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(3));
    expect(fetchRoster).toHaveBeenLastCalledWith(
      "ROSTER1",
      expect.objectContaining({ group: "" }),
      "token",
    );
    expect(await screen.findByLabelText("Ada in Teachers")).toBeChecked();
    expect(screen.queryByLabelText("Ada in Faculty")).not.toBeInTheDocument();
  });

  test("keeps the group filter on a renamed group and reports rename failures", async () => {
    renameRosterGroup
      .mockRejectedValueOnce(
        Object.assign(new Error("A group named Teachers already exists."), {
          status: 409,
        }),
      )
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce(renamedResponse);
    await renderPanel();
    await screen.findByText("Ada");
    await userEvent.click(
      screen.getAllByRole("button", { name: "Show people" })[0],
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Filter by group")).toHaveValue("Faculty"),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for group Faculty"), {
      target: { value: "Teachers" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A group named Teachers already exists.",
    );
    expect(screen.getByLabelText("Filter by group")).toHaveValue("Faculty");

    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to rename Faculty.",
    );

    fetchRoster.mockResolvedValue(renamedRoster);
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Renamed Faculty to Teachers.",
    );
    // The filter follows the rename, which reloads the roster on its own.
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Teachers", page: 1 }),
        "token",
      ),
    );
    expect(fetchRoster).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Filter by group")).toHaveValue("Teachers");
  });

  test("adds and removes the selected people, creates a group, and ungroups", async () => {
    createRosterGroup.mockResolvedValue({
      group: { id: 12, name: "Board", count: 0, weight: null },
      groups: [
        { id: 12, name: "Board", count: 0, weight: null },
        facultyGroup,
        { id: null, name: "", count: 1, weight: null },
      ],
    });
    await renderPanel();
    await screen.findByText("Ada");
    expect(screen.getByRole("button", { name: "Add selected" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Select Cara"));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-3"],
          updates: { addGroups: ["Faculty"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added 2 people to Faculty.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    // Adding keeps the selection so the same people can go into another
    // group next.
    expect(screen.getByLabelText("Select Cara")).toBeChecked();

    patchRosterBulk.mockResolvedValueOnce({ updatedCount: 1 });
    await userEvent.click(
      screen.getByRole("button", { name: "Remove selected" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-3"],
          updates: { removeGroups: ["Faculty"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Removed 1 person from Faculty.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(3));

    // A group starts empty: no selection or weight is needed.
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: " Board " },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() =>
      expect(createRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        { name: "Board" },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created Board.",
    );
    // The response carried the recounted groups, so no reload was needed.
    expect(
      await screen.findByLabelText("Weight for group Board"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "2 groups",
    );
    expect(fetchRoster).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Select Cara")).toBeChecked();

    await userEvent.click(
      screen.getByRole("button", { name: "Ungroup selected" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-3"],
          updates: { group: "" },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Removed 2 people from their groups.",
    );
    // Ungrouping spends the selection.
    await waitFor(() =>
      expect(screen.getByLabelText("Select Cara")).not.toBeChecked(),
    );
  });

  test("keeps a group created while a quiet reload was in flight", async () => {
    const panel = createRef();
    createRosterGroup.mockResolvedValue({
      group: { id: 12, name: "Board", count: 0, weight: null },
      groups: [
        { id: 12, name: "Board", count: 0, weight: null },
        facultyGroup,
        ungrouped,
      ],
    });
    await renderPanel({ ref: panel });
    await screen.findByText("Ada");
    const staleListing = fetchRoster.mock.results[0].value;
    let finishStaleReload;
    fetchRoster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStaleReload = () => staleListing.then(resolve);
        }),
    );
    // The live sync starts a quiet reload; its listing predates the group.
    let staleReload;
    act(() => {
      staleReload = panel.current.refresh("token", { silent: true });
    });

    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Board" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created Board.",
    );
    expect(screen.getByLabelText("Weight for group Board")).toBeInTheDocument();

    await act(async () => {
      finishStaleReload();
      await staleReload;
    });
    // The older listing does not take the new group away again.
    expect(screen.getByLabelText("Weight for group Board")).toBeInTheDocument();
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "2 groups",
    );

    // A listing that starts after the change is taken as it is.
    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ id: "p-1", name: "Ada" })], {
        stats: {
          ...stats,
          groups: [
            { id: 12, name: "Board", count: 1, weight: 1 },
            facultyGroup,
          ],
        },
      }),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(
      within(screen.getByRole("region", { name: "Roster groups" })).getByText(
        "1 person",
      ),
    ).toBeInTheDocument();
  });

  test("reloads the roster when a created group carries no stats and reports failures", async () => {
    createRosterGroup
      .mockRejectedValueOnce(
        Object.assign(new Error("A group named Faculty already exists."), {
          status: 409,
        }),
      )
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce({ group: { id: 13, name: "Staff" } });
    await renderPanel();
    await screen.findByText("Ada");
    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Staff" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A group named Faculty already exists.",
    );
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to create Staff.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created Staff.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
  });

  test("deletes a group and reports delete failures", async () => {
    deleteRosterGroup
      .mockRejectedValueOnce(
        Object.assign(new Error("Group not found"), { status: 404 }),
      )
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValue({
        groups: [{ id: null, name: "", count: 3, weight: null }],
      });
    await renderPanel();
    await screen.findByText("Ada");
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({ id: "p-1", name: "Ada", group: "" }),
          participant({ id: "p-2", name: "Ben", group: "" }),
          participant({ id: "p-3", name: "Cara", group: "", weight: 0.5 }),
        ],
        {
          stats: {
            ...stats,
            groups: [{ id: null, name: "", count: 3, weight: null }],
          },
        },
      ),
    );

    // Declining the in-page confirmation sends nothing.
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    const declineDialog = await screen.findByRole("dialog", {
      name: "Delete group Faculty?",
    });
    await userEvent.click(
      within(declineDialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete group Faculty?" }),
      ).not.toBeInTheDocument(),
    );
    expect(deleteRosterGroup).not.toHaveBeenCalled();

    await confirmGroupDelete("Faculty");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Group not found",
    );
    await confirmGroupDelete("Faculty");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to delete Faculty.",
    );
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    // Deleting a group that is not being shown reloads the rows in place.
    await confirmGroupDelete("Faculty");
    await waitFor(() =>
      expect(deleteRosterGroup).toHaveBeenCalledWith("ROSTER1", 11, "token"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Deleted Faculty.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(fetchRoster).toHaveBeenLastCalledWith(
      "ROSTER1",
      expect.objectContaining({ group: "" }),
      "token",
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Weight for group Faculty"),
      ).not.toBeInTheDocument(),
    );
    // The deleted group's column goes with it; All stays.
    expect(screen.queryByLabelText("Ada in Faculty")).not.toBeInTheDocument();
    expect(screen.getByLabelText("All groups for Ada")).toBeInTheDocument();
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });

  test("clears the group filter when the shown group is deleted", async () => {
    deleteRosterGroup.mockResolvedValue({});
    await renderPanel();
    await screen.findByText("Ada");
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

    await confirmGroupDelete("Faculty");
    await waitFor(() =>
      expect(deleteRosterGroup).toHaveBeenCalledWith("ROSTER1", 11, "token"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Deleted Faculty.",
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "", page: 1 }),
        "token",
      ),
    );
    expect(fetchRoster).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Filter by group")).toHaveValue("");
  });

  test("filters by group from the group table", async () => {
    await renderPanel();
    await screen.findByText("Ada");
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

  test("ticks a person's group columns and the All flag, then saves them together", async () => {
    const boardGroup = { id: 12, name: "Board", count: 0, weight: null };
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({
            id: "p-1",
            name: "Ada",
            group: "Faculty",
            groups: [{ id: 11, name: "Faculty" }],
          }),
        ],
        { stats: { ...stats, groups: [boardGroup, facultyGroup] } },
      ),
    );
    const ada = (overrides) =>
      participant({ id: "p-1", name: "Ada", ...overrides });
    patchRosterParticipant
      .mockResolvedValueOnce({
        participant: ada({
          group: "Board",
          groups: [{ id: 12, name: "Board" }],
          version: 5,
        }),
        groups: [
          { ...boardGroup, count: 1, weight: 1 },
          { ...facultyGroup, count: 0, weight: null },
        ],
      })
      .mockResolvedValueOnce({
        participant: ada({
          group: "ALL; Board",
          groups: [{ id: 12, name: "Board" }],
          allGroups: true,
          version: 6,
        }),
      });
    await renderPanel();
    const board = await screen.findByLabelText("Ada in Board");
    const faculty = screen.getByLabelText("Ada in Faculty");
    const all = screen.getByLabelText("All groups for Ada");
    expect(board).not.toBeChecked();
    expect(faculty).toBeChecked();
    expect(all).not.toBeChecked();
    // Each box names its group, since the header row scrolls away.
    expect(board).toHaveAttribute("title", "Board");
    expect(
      screen.queryByRole("region", { name: "Unsaved group changes" }),
    ).not.toBeInTheDocument();

    // A tick is only a draft: it shows at once, is marked, and waits.
    fireEvent.click(board);
    expect(board).toBeChecked();
    expect(board.closest("td")).toHaveClass(
      "roster-table__group-cell--pending",
    );
    const bar = screen.getByRole("region", { name: "Unsaved group changes" });
    expect(bar).toHaveTextContent("1 unsaved group change for 1 person.");
    expect(patchRosterParticipant).not.toHaveBeenCalled();

    // Ticking it back is no change at all.
    fireEvent.click(board);
    expect(board).not.toBeChecked();
    expect(board.closest("td")).not.toHaveClass(
      "roster-table__group-cell--pending",
    );
    expect(
      screen.queryByRole("region", { name: "Unsaved group changes" }),
    ).not.toBeInTheDocument();

    // All covers every group, so each column shows ticked and locked.
    fireEvent.click(board);
    fireEvent.click(all);
    expect(all).toBeChecked();
    for (const box of [board, faculty]) {
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
    }
    expect(faculty).toHaveAttribute(
      "title",
      "Faculty: included through All groups",
    );
    expect(
      screen.getByRole("region", { name: "Unsaved group changes" }),
    ).toHaveTextContent("2 unsaved group changes for 1 person.");
    // Leaving the page now asks first.
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    // Discard puts every box back as saved.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(board).not.toBeChecked();
    expect(all).not.toBeChecked();
    expect(faculty).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unsaved group changes were discarded.",
    );
    const stay = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(stay);
    expect(stay.defaultPrevented).toBe(false);

    // Adding one group and dropping another is one request for the row.
    fireEvent.click(board);
    fireEvent.click(faculty);
    fireEvent.click(screen.getByRole("button", { name: "Save group changes" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { addGroupIds: [12], removeGroupIds: [11], expectedVersion: 4 },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved group changes for 1 person.",
    );
    expect(board).toBeChecked();
    expect(faculty).not.toBeChecked();
    expect(
      screen.queryByRole("region", { name: "Unsaved group changes" }),
    ).not.toBeInTheDocument();
    // The recounted groups arrive with the patch; no reload is needed.
    expect(
      within(screen.getByRole("region", { name: "Roster groups" })).getByText(
        "1 person",
      ),
    ).toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    fireEvent.click(all);
    fireEvent.click(screen.getByRole("button", { name: "Save group changes" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { allGroups: true, expectedVersion: 5 },
        "token",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Unsaved group changes" }),
      ).not.toBeInTheDocument(),
    );
    expect(all).toBeChecked();
    expect(patchRosterParticipant).toHaveBeenCalledTimes(2);
  });

  test("saves ticks for several people and keeps the ones that failed", async () => {
    patchRosterParticipant
      .mockResolvedValueOnce({
        participant: participant({
          id: "p-2",
          name: "Ben",
          group: "",
          groups: [],
          version: 5,
        }),
      })
      .mockRejectedValueOnce(new Error("Cara could not be saved"));
    await renderPanel();
    fireEvent.click(await screen.findByLabelText("Ben in Faculty"));
    fireEvent.click(screen.getByLabelText("Cara in Faculty"));
    expect(
      screen.getByRole("region", { name: "Unsaved group changes" }),
    ).toHaveTextContent("2 unsaved group changes for 2 people.");

    fireEvent.click(screen.getByRole("button", { name: "Save group changes" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(2),
    );
    expect(patchRosterParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      "p-2",
      { removeGroupIds: [11], expectedVersion: 4 },
      "token",
    );
    expect(patchRosterParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      "p-3",
      { addGroupIds: [11], expectedVersion: 4 },
      "token",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cara could not be saved",
    );
    // Ben's change is saved; Cara's tick stays a draft to retry.
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Unsaved group changes" }),
      ).toHaveTextContent("1 unsaved group change for 1 person."),
    );
    expect(screen.getByLabelText("Ben in Faculty")).not.toBeChecked();
    expect(screen.getByLabelText("Cara in Faculty")).toBeChecked();
  });

  test("drops a tick for a group deleted in another session", async () => {
    const panel = createRef();
    await renderPanel({ ref: panel });
    fireEvent.click(await screen.findByLabelText("Cara in Faculty"));
    expect(
      screen.getByRole("region", { name: "Unsaved group changes" }),
    ).toBeInTheDocument();
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [participant({ id: "p-3", name: "Cara", group: "", groups: [] })],
        { stats: { ...stats, groups: [ungrouped] } },
      ),
    );
    // The workspace's live sync reloads the page quietly.
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cara in Faculty"),
      ).not.toBeInTheDocument(),
    );
    // The column is gone, and so is the change that nothing could save.
    expect(
      screen.queryByRole("region", { name: "Unsaved group changes" }),
    ).not.toBeInTheDocument();
    expect(patchRosterParticipant).not.toHaveBeenCalled();
  });

  test("reloads the roster when a saved tick names a group deleted in another session", async () => {
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("This group was deleted in another session."), {
        status: 409,
      }),
    );
    await renderPanel();
    const cara = await screen.findByLabelText("Cara in Faculty");
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [participant({ id: "p-3", name: "Cara", group: "", groups: [] })],
        { stats: { ...stats, groups: [ungrouped] } },
      ),
    );

    fireEvent.click(cara);
    fireEvent.click(screen.getByRole("button", { name: "Save group changes" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-3",
        { addGroupIds: [11], expectedVersion: 4 },
        "token",
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This group was deleted in another session.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cara in Faculty"),
      ).not.toBeInTheDocument(),
    );
    // A refused save is not a conflict: the row stays editable.
    expect(screen.getByLabelText("All groups for Cara")).toBeEnabled();
  });

  test("keeps a conflicting membership save on screen until the row is reloaded", async () => {
    const latest = participant({
      id: "p-3",
      name: "Cara",
      group: "",
      groups: [],
      version: 9,
    });
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: latest,
      }),
    );
    await renderPanel();
    const cara = await screen.findByLabelText("Cara in Faculty");
    fireEvent.click(cara);
    fireEvent.click(screen.getByRole("button", { name: "Save group changes" }));
    expect(
      await screen.findByRole("button", { name: "Reload latest participant" }),
    ).toBeInTheDocument();
    expect(cara).toBeChecked();
    expect(cara).toBeDisabled();

    fetchRoster.mockResolvedValueOnce(
      rosterResponse([latest], { stats: { ...stats } }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest participant" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Cara in Faculty")).not.toBeChecked(),
    );
    expect(screen.getByLabelText("Cara in Faculty")).toBeEnabled();
    expect(
      screen.queryByRole("region", { name: "Unsaved group changes" }),
    ).not.toBeInTheDocument();
  });

  test("applies the group stats returned by a per-person patch", async () => {
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ id: "p-1", name: "Ada", weight: 0.5 }),
      groups: [
        { id: 11, name: "Faculty", count: 2, weight: null },
        { id: null, name: "", count: 1, weight: null },
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

  test("adds, removes, replaces and clears groups with the bulk action", async () => {
    await renderPanel();
    const bulk = await openBulk();
    expect(bulk).toHaveTextContent("Change groups, weight or inclusion");
    const action = within(bulk).getByLabelText("Bulk group action");
    const target = within(bulk).getByLabelText("Bulk target group");
    const everyGroup = within(bulk).getByLabelText("Bulk every group");
    expect(action).toBeDisabled();
    expect(target).toBeDisabled();
    expect(everyGroup).toBeDisabled();
    fireEvent.click(within(bulk).getByLabelText("Apply bulk groups"));
    expect(action).toBeEnabled();
    expect(target).toBeEnabled();
    expect(everyGroup).toBeEnabled();
    // Only named groups are offered as targets.
    expect(
      within(target)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Choose group", "Faculty"]);

    // A target is required for everything but "clear".
    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a group for this bulk update.",
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();

    fireEvent.change(target, { target: { value: "Faculty" } });
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { addGroups: ["Faculty"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Updated 2 roster entries.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.change(action, { target: { value: "remove" } });
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { removeGroups: ["Faculty"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.change(action, { target: { value: "replace" } });
    fireEvent.click(everyGroup);
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { group: "Faculty", allGroups: true },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(4));

    // "Clear" needs no target and disables the picker; with "Every group"
    // it drops the memberships and then sets the flag.
    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.change(action, { target: { value: "clear" } });
    expect(target).toBeDisabled();
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { group: "", allGroups: true },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(5));

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(everyGroup);
    fireEvent.click(within(bulk).getByLabelText("Apply bulk weight"));
    fireEvent.change(within(bulk).getByLabelText("Bulk weight"), {
      target: { value: "0.5" },
    });
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { group: "", weight: 0.5 },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
  });

  // Points the bulk "Change groups" action (add) at a named group, the way
  // an organizer would before touching the Groups table.
  async function chooseBulkTarget(name) {
    const bulk = await openBulk();
    fireEvent.click(within(bulk).getByLabelText("Apply bulk groups"));
    const target = within(bulk).getByLabelText("Bulk target group");
    fireEvent.change(target, { target: { value: name } });
    expect(target).toHaveValue(name);
    return { bulk, target };
  }

  const bulkTargetOptions = (target) =>
    within(target)
      .getAllByRole("option")
      .map((option) => option.textContent);

  test("moves the bulk target group along with a rename", async () => {
    renameRosterGroup.mockResolvedValue(renamedResponse);
    await renderPanel();
    await screen.findByText("Ada");
    const { bulk, target } = await chooseBulkTarget("Faculty");

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for group Faculty"), {
      target: { value: "Teachers" },
    });
    fetchRoster.mockResolvedValue(renamedRoster);
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(renameRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        11,
        { name: "Teachers" },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Renamed Faculty to Teachers.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    // The picker followed the group rather than keeping a name the server
    // no longer knows.
    expect(target).toHaveValue("Teachers");
    expect(bulkTargetOptions(target)).toEqual(["Choose group", "Teachers"]);

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { addGroups: ["Teachers"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(patchRosterBulk).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Updated 2 roster entries.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(3));
  });

  test("drops the bulk target group when that group is deleted", async () => {
    deleteRosterGroup.mockResolvedValue({ groups: [] });
    await renderPanel();
    await screen.findByText("Ada");
    const { bulk, target } = await chooseBulkTarget("Faculty");
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({ id: "p-1", name: "Ada", group: "" }),
          participant({ id: "p-2", name: "Ben", group: "" }),
          participant({ id: "p-3", name: "Cara", group: "", weight: 0.5 }),
        ],
        { stats: { ...stats, groups: [{ ...ungrouped, count: 3 }] } },
      ),
    );

    await confirmGroupDelete("Faculty");
    await waitFor(() =>
      expect(deleteRosterGroup).toHaveBeenCalledWith("ROSTER1", 11, "token"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Deleted Faculty.",
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    // The picker is back at "Choose group": nothing is left to point at.
    expect(target).toHaveValue("");
    expect(bulkTargetOptions(target)).toEqual(["Choose group"]);
    expect(within(bulk).getByLabelText("Apply bulk groups")).toBeChecked();
    expect(within(bulk).getByLabelText("Bulk group action")).toHaveValue("add");

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a group for this bulk update.",
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("refuses a bulk target group the reloaded roster no longer lists", async () => {
    await renderPanel();
    await screen.findByText("Ada");
    const { bulk, target } = await chooseBulkTarget("Faculty");

    // Another session replaced Faculty with Board: the next read brings the
    // new group list while the picker's state still says Faculty.
    const boardGroup = { id: 12, name: "Board", count: 3, weight: 1 };
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({ id: "p-1", name: "Ada", group: "Board" }),
          participant({ id: "p-2", name: "Ben", group: "Board" }),
          participant({ id: "p-3", name: "Cara", group: "Board", weight: 0.5 }),
        ],
        { stats: { ...stats, groups: [boardGroup] } },
      ),
    );
    fireEvent.change(screen.getByLabelText("Filter by response"), {
      target: { value: "false" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ submitted: "false", page: 1 }),
        "token",
      ),
    );
    expect(
      await screen.findByLabelText("Weight for group Board"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Weight for group Faculty"),
    ).not.toBeInTheDocument();
    expect(bulkTargetOptions(target)).toEqual(["Choose group", "Board"]);
    // With Faculty gone from the options the picker reads as "Choose group",
    // so the stale name must not be what the request carries.
    expect(target).toHaveValue("");

    fireEvent.click(screen.getByLabelText("Select Ada"));
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a group for this bulk update.",
    );
    expect(patchRosterBulk).not.toHaveBeenCalled();
    expect(fetchRoster).toHaveBeenCalledTimes(2);

    // Picking a group that is on screen sends the request as usual.
    fireEvent.change(target, { target: { value: "Board" } });
    fireEvent.click(within(bulk).getByRole("button", { name: "Apply update" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { addGroups: ["Board"] },
          idempotencyKey: "group-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Updated 2 roster entries.",
    );
  });

  test("resets the bulk group controls and locks groups while responses are closed", async () => {
    const props = {
      event,
      setEvent: jest.fn(),
      getToken: jest.fn().mockResolvedValue("token"),
      onResultsInvalidated: jest.fn(),
      onDeliveryRequestChange: jest.fn(),
    };
    const { rerender } = render(<RosterPanel {...props} />);
    const bulk = await openBulk();
    fireEvent.click(within(bulk).getByLabelText("Apply bulk groups"));
    fireEvent.change(within(bulk).getByLabelText("Bulk group action"), {
      target: { value: "replace" },
    });
    fireEvent.change(within(bulk).getByLabelText("Bulk target group"), {
      target: { value: "Faculty" },
    });
    fireEvent.click(within(bulk).getByLabelText("Bulk every group"));

    rerender(<RosterPanel {...props} event={{ ...event, status: "closed" }} />);
    expect(
      await screen.findByLabelText("Weight for group Faculty"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "New group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add selected" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete group" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("All groups for Ada")).toBeDisabled();
    expect(
      screen.queryByLabelText("Bulk roster actions"),
    ).not.toBeInTheDocument();

    // Reactivating brings the bulk form back at its defaults.
    rerender(<RosterPanel {...props} event={{ ...event, status: "active" }} />);
    const reopened = await openBulk();
    expect(
      within(reopened).getByLabelText("Apply bulk groups"),
    ).not.toBeChecked();
    expect(within(reopened).getByLabelText("Bulk group action")).toHaveValue(
      "add",
    );
    expect(within(reopened).getByLabelText("Bulk target group")).toHaveValue(
      "",
    );
    expect(
      within(reopened).getByLabelText("Bulk every group"),
    ).not.toBeChecked();
  });

  test("creates groups on an empty roster before anyone is added", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([], {
        stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
      }),
    );
    createRosterGroup.mockResolvedValue({
      groups: [{ id: 21, name: "Faculty", count: 0, weight: null }],
    });
    await renderPanel();
    expect(
      await screen.findByText(
        "Add someone or import a roster to start collecting availability.",
      ),
    ).toBeVisible();
    // Nothing to filter or bulk-edit yet, but groups can be set up ahead of
    // the import.
    expect(
      screen.queryByRole("search", { name: "Roster filters" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Bulk actions")).not.toBeInTheDocument();
    expect(screen.getByText(/No groups yet/)).toHaveTextContent(
      "once they are on the roster",
    );

    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Faculty" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() =>
      expect(createRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        { name: "Faculty" },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created Faculty.",
    );
    const groupsRegion = await screen.findByRole("region", {
      name: "Roster groups",
    });
    expect(
      within(groupsRegion).getByLabelText("Weight for group Faculty"),
    ).toBeDisabled();
    expect(groupsRegion).toHaveTextContent("0 people");
    expect(screen.queryByText(/No groups yet/)).not.toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });

  test("keeps the group section read-only on a closed empty roster", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([], {
        stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
      }),
    );
    await renderPanel({ event: { ...event, status: "closed" } });
    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New group" }),
    ).not.toBeInTheDocument();
  });

  test("hides the group section until the roster loads and while it fails", async () => {
    fetchRoster.mockRejectedValueOnce(new Error("Roster unavailable"));
    await renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    expect(
      screen.queryByRole("heading", { name: "Groups" }),
    ).not.toBeInTheDocument();
  });

  test("keeps the group section and its form when creating a group fails", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([], {
        stats: { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
      }),
    );
    createRosterGroup.mockRejectedValueOnce(
      new Error("A group named Faculty already exists."),
    );
    await renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "New group" }),
    );
    fireEvent.change(screen.getByLabelText("New group name"), {
      target: { value: "Faculty" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A group named Faculty already exists.",
    );
    // The failure is reported next to a form the organizer can correct.
    expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument();
    expect(screen.getByLabelText("New group name")).toHaveValue("Faculty");
  });

  test("offers the group section on a roster without groups", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [participant({ id: "p-1", name: "Ada", group: "", allGroups: true })],
        {
          stats: { total: 1, submitted: 0, notSubmitted: 1, groups: [] },
        },
      ),
    );
    await renderPanel();
    await screen.findByText("Ada");
    expect(screen.getByRole("button", { name: "New group" })).toBeEnabled();
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Roster groups" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("All groups for Ada")).toBeChecked();
  });
});

describe("RosterPanel people corrections", () => {
  const ada = participant({
    id: "p-1",
    memberId: "m-1",
    name: "Ada",
    email: "ada@exmaple.com",
    canOrganizerEditEmail: true,
  });
  const ben = participant({
    id: "p-2",
    memberId: "m-2",
    name: "Ben",
    email: "ben@example.com",
    accountAccess: "full",
    canOrganizerEditAvailability: false,
    canOrganizerEditEmail: false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fetchRoster.mockResolvedValue(
      rosterResponse([ada, ben], { organizerOnRoster: false }),
    );
  });

  test("adds the organizer to their own roster and opens their schedule", async () => {
    const onResultsInvalidated = jest.fn();
    joinEvent.mockResolvedValue({
      participant: { id: "m-org", name: "Olive Organizer" },
    });
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "p-org",
          memberId: "m-org",
          name: "Olive Organizer",
          isOrganizer: true,
          canOrganizerEditAvailability: false,
          version: 1,
        },
      }),
    );
    await renderPanel({ onResultsInvalidated });
    const addMyself = await screen.findByRole("button", { name: "Add myself" });
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          ada,
          ben,
          participant({
            id: "p-org",
            memberId: "m-org",
            name: "Olive Organizer",
            email: "olive@example.com",
            accountAccess: "full",
            isOrganizer: true,
            canOrganizerEditAvailability: false,
            canOrganizerEditEmail: false,
            invitationStatus: "not_sent",
          }),
        ],
        { organizerOnRoster: true },
      ),
    );

    fireEvent.click(addMyself);

    await waitFor(() =>
      expect(joinEvent).toHaveBeenCalledWith("ROSTER1", "token"),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Edit my schedule",
    });
    expect(fetchRosterSchedule).toHaveBeenCalledWith(
      "ROSTER1",
      "m-org",
      "token",
    );
    expect(onResultsInvalidated).toHaveBeenCalled();
    expect(within(drawer).getByText("Your own response")).toBeInTheDocument();
    // Their name comes from their account, so there is none to edit.
    expect(
      within(drawer).queryByLabelText("Event display name"),
    ).not.toBeInTheDocument();
    expect(
      within(drawer).getByText(/You answer as Olive Organizer/),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Submit" }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "You are on the roster now. Enter your availability with Edit my schedule on your row.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add myself" }),
    ).not.toBeInTheDocument();

    // Saving their own answers never sends a name.
    updateParticipant.mockResolvedValue({
      participant: {
        name: "Olive Organizer",
        availabilityInperson: [0, 1, 0],
        availabilityVirtual: [1, 0, 0],
        submitted: 1,
        version: 2,
      },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "m-org",
        {
          availabilityInperson: [0, 1, 0],
          availabilityVirtual: [1, 0, 0],
          submitted: 1,
          expectedVersion: 4,
        },
        "token",
      ),
    );
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Close schedule editor" }),
    );

    // Their row is labelled as theirs and edits their own schedule.
    const row = screen
      .getByText("Olive Organizer")
      .closest("[data-roster-participant-id]");
    expect(row).toHaveTextContent("You (organizer)");
    expect(
      within(row).getByRole("button", { name: "Edit my schedule" }),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", {
        name: "Edit name and email for Olive Organizer",
      }),
    ).not.toBeInTheDocument();
  });

  test("hides Add myself until the roster says the organizer is missing", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([ada]));
    await renderPanel();
    await screen.findByText("Ada");
    expect(
      screen.queryByRole("button", { name: "Add myself" }),
    ).not.toBeInTheDocument();
  });

  test("reports a failed Add myself", async () => {
    joinEvent
      .mockRejectedValueOnce(new Error("Name is required"))
      .mockRejectedValueOnce(new Error(""));
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add myself" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name is required",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add myself" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to add you to the roster.",
      ),
    );
    expect(fetchRosterSchedule).not.toHaveBeenCalled();
  });

  test("adds the organizer without opening an editor when no row id comes back", async () => {
    joinEvent.mockResolvedValue({});
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add myself" }));
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(fetchRosterSchedule).not.toHaveBeenCalled();
  });

  test("corrects a mistyped email and name from Edit details", async () => {
    const onResultsInvalidated = jest.fn();
    patchRosterParticipant.mockResolvedValue({
      participant: { ...ada, name: "Ada L.", email: "ada@example.com" },
      resultsRevision: 7,
    });
    await renderPanel({ onResultsInvalidated });
    // Ben answered himself: nothing about him can change here.
    expect(
      screen.queryByRole("button", { name: "Edit name and email for Ben" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit name and email for Ada",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit Ada" });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), {
      target: { value: "Ada L." },
    });
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );

    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { name: "Ada L.", email: "ada@example.com", expectedVersion: 4 },
        "token",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit Ada" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ada L. now uses ada@example.com. Their invitation has not been sent to this address yet.",
    );
    expect(onResultsInvalidated).toHaveBeenCalledWith(7);
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  test("renames without a request when nothing changed, and keeps the dialog on errors", async () => {
    patchRosterParticipant
      .mockRejectedValueOnce(
        Object.assign(new Error("ada@example.com is already on this roster."), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce({ participant: { ...ada, name: "Ada K." } });
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit name and email for Ada",
      }),
    );
    let dialog = screen.getByRole("dialog", { name: "Edit Ada" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit Ada" }),
      ).not.toBeInTheDocument(),
    );
    expect(patchRosterParticipant).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit name and email for Ada" }),
    );
    dialog = screen.getByRole("dialog", { name: "Edit Ada" });
    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    // The reason shows in the dialog, not under the table.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "ada@example.com is already on this roster.",
    );
    expect(
      screen.queryByText("ada@example.com is already on this roster.", {
        selector: ".roster-panel__message *, .roster-panel__message",
      }),
    ).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/Email address/), {
      target: { value: "ada@exmaple.com" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), {
      target: { value: "Ada K." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { name: "Ada K.", expectedVersion: 4 },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ada was updated.",
    );
  });

  test("closes the dialog on a version conflict and offers the reload", async () => {
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("The participant changed in another session."), {
        status: 409,
        participant: { ...ada, version: 9 },
      }),
    );
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit name and email for Ada",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit Ada" });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), {
      target: { value: "Ada B." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    expect(
      await screen.findByRole("button", { name: "Reload latest participant" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Edit Ada" }),
    ).not.toBeInTheDocument();
    // The row stays locked until reloaded.
    expect(
      screen.getByRole("button", { name: "Edit name and email for Ada" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
  });

  test("removes a person after confirming, and reports failures", async () => {
    const onResultsInvalidated = jest.fn();
    deleteRosterParticipant
      .mockResolvedValueOnce({
        deleted: true,
        resultsRevision: 12,
        groups: [{ id: null, name: "", count: 1, weight: 1, included: true }],
      })
      .mockRejectedValueOnce(
        new Error("An email to this person is being sent right now."),
      )
      .mockRejectedValueOnce(new Error(""));
    await renderPanel({ onResultsInvalidated });
    fireEvent.click(await screen.findByLabelText("Select Ada"));
    expect(screen.getAllByText("1 selected")[0]).toBeInTheDocument();

    // Cancel leaves everything as it was.
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    let dialog = screen.getByRole("dialog", {
      name: "Remove Ada from the roster?",
    });
    expect(dialog).toHaveTextContent(
      "To keep their answers but leave them out of the results, untick Included instead.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteRosterParticipant).not.toHaveBeenCalled();

    fetchRoster.mockResolvedValue(rosterResponse([ben]));
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    dialog = screen.getByRole("dialog", {
      name: "Remove Ada from the roster?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove person" }),
    );
    await waitFor(() =>
      expect(deleteRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ada was removed from the roster.",
    );
    expect(onResultsInvalidated).toHaveBeenCalledWith(12);
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    expect(screen.getAllByText("0 selected")[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ben" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Remove Ben from the roster?" }),
      ).getByRole("button", { name: "Remove person" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An email to this person is being sent right now.",
    );
    expect(
      screen.queryByRole("dialog", { name: "Remove Ben from the roster?" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ben" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Remove Ben from the roster?" }),
      ).getByRole("button", { name: "Remove person" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to remove Ben.",
      ),
    );
  });

  test("keeps the other stats when a removal returns no groups", async () => {
    deleteRosterParticipant.mockResolvedValueOnce({ deleted: true });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Ada" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Remove Ada from the roster?" }),
      ).getByRole("button", { name: "Remove person" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ada was removed from the roster.",
    );
  });

  test("hides row corrections while the roster is read-only", async () => {
    await renderPanel({ event: { ...event, status: "closed" } });
    await screen.findByText("Ada");
    expect(
      screen.queryByRole("button", { name: "Remove Ada" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit name and email for Ada" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add myself" }),
    ).not.toBeInTheDocument();
  });
});

describe("RosterPanel group inclusion", () => {
  const faculty = {
    id: 11,
    name: "Faculty",
    count: 2,
    weight: 1,
    included: true,
  };
  const students = {
    id: 12,
    name: "Students",
    count: 1,
    weight: 1,
    included: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("include-key") },
    });
    fetchRoster.mockResolvedValue(
      rosterResponse(
        [
          participant({
            id: "p-1",
            name: "Ada",
            groups: [{ id: 11, name: "Faculty" }],
          }),
        ],
        {
          stats: {
            total: 3,
            submitted: 0,
            notSubmitted: 3,
            included: 2,
            excluded: 1,
            groups: [faculty, students],
          },
        },
      ),
    );
    patchRosterBulk.mockResolvedValue({ updatedCount: 2, resultsRevision: 5 });
  });

  test("includes or leaves out a whole group", async () => {
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    fireEvent.click(await screen.findByLabelText("Include group Faculty"));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          group: "Faculty",
          updates: { included: false },
          idempotencyKey: "include-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Left 2 people in Faculty out of the results.",
    );
    expect(onResultsInvalidated).toHaveBeenCalledWith(5);

    fireEvent.click(screen.getByLabelText("Include group Students"));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({
          group: "Students",
          updates: { included: true },
        }),
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Included 2 people in Students.",
    );
  });

  test("counts one group alone and brings everyone back", async () => {
    const onResultsInvalidated = jest.fn();
    includeOnlyRosterGroup
      .mockResolvedValueOnce({
        includedCount: 2,
        updatedCount: 1,
        resultsRevision: 6,
        groups: [faculty, { ...students, included: false }],
      })
      .mockRejectedValueOnce(new Error(""));
    await renderPanel({ onResultsInvalidated });
    const facultyRow = (
      await screen.findByRole("region", {
        name: "Roster groups",
      })
    ).querySelector('[data-roster-group="Faculty"]');
    fireEvent.click(
      within(facultyRow).getByRole("button", { name: "Only this group" }),
    );
    await waitFor(() =>
      expect(includeOnlyRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        11,
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Only Faculty counts in the results now. Use Include everyone to bring the others back.",
    );
    expect(onResultsInvalidated).toHaveBeenCalledWith(6);
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));

    fireEvent.click(
      within(facultyRow).getByRole("button", { name: "Only this group" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to include only Faculty.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Include everyone" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          filter: { all: true },
          updates: { included: true },
          idempotencyKey: "include-key",
        },
        "token",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Everyone is included in the results again (2 people changed).",
    );
  });

  test("leaves the results alone when including only a group changes nothing", async () => {
    const onResultsInvalidated = jest.fn();
    includeOnlyRosterGroup.mockResolvedValueOnce({ updatedCount: 0 });
    await renderPanel({ onResultsInvalidated });
    const facultyRow = (
      await screen.findByRole("region", {
        name: "Roster groups",
      })
    ).querySelector('[data-roster-group="Faculty"]');
    fireEvent.click(
      within(facultyRow).getByRole("button", { name: "Only this group" }),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(onResultsInvalidated).not.toHaveBeenCalled();
  });
});
