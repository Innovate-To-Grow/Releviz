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
            invitationStatus: "submitted",
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
        phone: "",
        organizerManaged: false,
        idempotencyKey: expect.any(String),
      },
      "token",
    );
  });
});

describe("RosterPanel organizer-managed people", () => {
  const managedHelp =
    "Enter one of your own verified email addresses. No invitation is sent.";
  const managedLabel =
    "No email of their own — use one of mine and I'll enter their schedule";

  beforeEach(() => {
    jest.clearAllMocks();
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
  });

  async function openInviteForm() {
    fireEvent.click(
      await screen.findByRole("button", { name: "Invite person" }),
    );
    const form = screen.getByRole("form", { name: /invite/i });
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
    let submit = within(invite.form).getByRole("button", {
      name: "Add and send invitation",
    });
    expect(submit.querySelector(".app-btn-icon")).not.toBeNull();

    fireEvent.click(invite.managed);
    expect(invite.managed).toBeChecked();
    expect(invite.email).toHaveAccessibleDescription(managedHelp);
    submit = within(invite.form).getByRole("button", { name: "Add person" });
    expect(submit.querySelector(".app-btn-icon")).toBeNull();
    expect(
      within(invite.form).queryByRole("button", {
        name: "Add and send invitation",
      }),
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
      },
      "token",
    );
    // No invitation was queued, so there is no delivery progress to show.
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: /invite/i })).toBeNull();

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
      expect.objectContaining({ phone: "", organizerManaged: true }),
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
    fireEvent.submit(invite.form);
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        expect.objectContaining({
          phone: "+1 (555) 010-0199",
          organizerManaged: false,
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
    expect(screen.queryByRole("form", { name: /invite/i })).toBeNull();

    invite = await openInviteForm();
    expect(invite.phone).toHaveValue("");
    expect(invite.managed).not.toBeChecked();
    expect(
      within(invite.form).getByRole("button", {
        name: "Add and send invitation",
      }),
    ).toBeInTheDocument();
  });

  test("labels organizer-managed rows and shows the phone between email and account", async () => {
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
    expect(
      within(table).getByText(
        "organizer@example.com · +1 555 010 0199 · Organizer-managed",
      ),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("temp@example.com · Temporary"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("No email · Full account"),
    ).toBeInTheDocument();
    // The organizer enters a managed person's schedule.
    const managedRow = within(table)
      .getByRole("rowheader", { name: /Managed Person/ })
      .closest("tr");
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
      screen.getByText("temp@example.com · +1 555 010 0199 · Temporary"),
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
