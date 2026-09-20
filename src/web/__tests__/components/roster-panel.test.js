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
  createRosterGroup: jest.fn(),
  deleteRosterGroup: jest.fn(),
  fetchRoster: jest.fn(),
  fetchRosterGroups: jest.fn(),
  fetchRosterSchedule: jest.fn(),
  patchRosterBulk: jest.fn(),
  patchRosterParticipant: jest.fn(),
  renameRosterGroup: jest.fn(),
}));

import RosterPanel from "@/components/schedule/RosterPanel";
import {
  createManagedParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import {
  createRosterGroup,
  deleteRosterGroup,
  fetchRoster,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
  renameRosterGroup,
} from "@/lib/api/roster";

const event = {
  code: "ROSTER1",
  name: "Roster drawer",
  status: "active",
  mode: "mixed",
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
    invitationStatus: "invited",
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
            invitationStatus: "opened",
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
            invitationStatus: "submitted",
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
    // The row edits the cell string the server formatted, and the flag shows
    // as its own checkbox.
    expect(screen.getByLabelText("Groups for Alpha")).toHaveValue(
      "ALL; Faculty",
    );
    expect(screen.getByLabelText("All groups for Alpha")).toBeChecked();
    expect(screen.getByLabelText("Groups for Beta")).toHaveValue("");
    expect(screen.getByLabelText("All groups for Beta")).not.toBeChecked();
    expect(screen.getByLabelText("Groups for Gamma")).toHaveValue("");
    expect(screen.getByLabelText("Groups for Delta")).toHaveValue(
      "Faculty; Staff",
    );
    expect(
      screen.getByLabelText("Groups for Delta"),
    ).toHaveAccessibleDescription("Separate names with ; or type ALL");
    expect(screen.getByLabelText("Roster summary")).toHaveTextContent(
      "2 groups",
    );
    const table = screen.getByRole("region", { name: "Roster participants" });
    expect(within(table).getByText("Self-managed")).toBeInTheDocument();
    expect(
      within(table).getByText("Full account", { exact: false }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Opened")).toBeInTheDocument();
    expect(within(table).getByText("Not sent")).toBeInTheDocument();
    expect(within(table).getAllByText("Submitted")).toHaveLength(2);
    expect(within(table).getByText("Invited")).toBeInTheDocument();

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
      target: { value: "opened" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({
          submitted: "false",
          invitationStatus: "opened",
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
    expect(screen.getByLabelText("Groups for Temp Person")).toBeDisabled();
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
    expect(screen.getByLabelText("Groups for Temp Person")).toBeEnabled();
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
    expect(screen.getByLabelText("Groups for Temp Person")).toBeEnabled();
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Invite person" }),
    );
    const form = screen.getByRole("form", { name: /invite/i });
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
    fireEvent.change(name, { target: { value: "Newbie" } });
    fireEvent.change(email, { target: { value: "newbie@example.com" } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(onDeliveryRequestChange).toHaveBeenCalledWith({
        id: "dr-legacy",
        operation: "invitation",
        recipientCount: 1,
        delivery: {},
      }),
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Invite person" }),
    );
    const form = screen.getByRole("form", { name: /invite/i });
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
      },
      "token",
    );
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
      participant({ id: "p-1", name: "Ada", group: "Teachers" }),
      participant({ id: "p-2", name: "Ben", group: "Teachers" }),
      participant({ id: "p-3", name: "Cara", group: "", weight: 0.5 }),
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
    // Existing names complete the per-person group inputs.
    expect(screen.getByLabelText("Groups for Ada")).toHaveAttribute("list");
    expect(
      document.querySelector(
        `#${CSS.escape(screen.getByLabelText("Groups for Ada").getAttribute("list"))} option[value="Faculty"]`,
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
    expect(await screen.findByLabelText("Groups for Ada")).toHaveValue(
      "Teachers",
    );
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

    // Declining the confirmation sends nothing.
    window.confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete group Faculty? People stay on the roster.",
    );
    expect(deleteRosterGroup).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Group not found",
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to delete Faculty.",
    );
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    // Deleting a group that is not being shown reloads the rows in place.
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
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
    expect(screen.getByLabelText("Groups for Ada")).toHaveValue("");
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

    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
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

  test("edits a person's memberships and every-group flag from the row", async () => {
    patchRosterParticipant
      .mockResolvedValueOnce({
        participant: participant({
          id: "p-1",
          name: "Ada",
          group: "Board; Faculty",
          groups: [
            { id: 12, name: "Board" },
            { id: 11, name: "Faculty" },
          ],
          version: 5,
        }),
        groups: [
          { id: 12, name: "Board", count: 1, weight: 1 },
          facultyGroup,
          { id: null, name: "", count: 1, weight: null },
        ],
      })
      .mockResolvedValueOnce({
        participant: participant({
          id: "p-1",
          name: "Ada",
          group: "ALL; Board; Faculty",
          allGroups: true,
          version: 6,
        }),
      });
    await renderPanel();
    const groupsInput = await screen.findByLabelText("Groups for Ada");
    expect(groupsInput).toHaveAccessibleDescription(
      "Separate names with ; or type ALL",
    );
    fireEvent.change(groupsInput, { target: { value: "Faculty; Board" } });
    fireEvent.blur(groupsInput);
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { group: "Faculty; Board", expectedVersion: 4 },
        "token",
      ),
    );
    // The server-normalized spelling replaces the draft and the group table
    // picks up the new group without a reload.
    await waitFor(() =>
      expect(screen.getByLabelText("Groups for Ada")).toHaveValue(
        "Board; Faculty",
      ),
    );
    expect(screen.getByLabelText("Weight for group Board")).toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    expect(screen.getByLabelText("All groups for Ada")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("All groups for Ada"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { allGroups: true, expectedVersion: 5 },
        "token",
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("All groups for Ada")).toBeChecked(),
    );
    expect(screen.getByLabelText("Groups for Ada")).toHaveValue(
      "ALL; Board; Faculty",
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Ada was updated.",
    );
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

    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete group Faculty? People stay on the roster.",
    );
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
