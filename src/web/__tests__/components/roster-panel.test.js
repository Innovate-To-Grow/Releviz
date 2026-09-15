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
import "@testing-library/jest-dom";

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

  test("reports bulk failures and reloads a row after a stale patch", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
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

    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Stale"), { status: 409 }),
    );
    const weight = screen.getByLabelText("Weight for Temp Person");
    fireEvent.change(weight, { target: { value: "0.25" } });
    fireEvent.blur(weight);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Stale"),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Weight for Temp Person")).toHaveValue(1);

    // A successful row patch forwards the results revision.
    patchRosterParticipant.mockResolvedValueOnce({
      participant: participant({ weight: 0.5, version: 5 }),
      resultsRevision: 7,
    });
    fireEvent.change(screen.getByLabelText("Weight for Temp Person"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(screen.getByLabelText("Weight for Temp Person"));
    await waitFor(() => expect(onResultsInvalidated).toHaveBeenCalledWith(7));
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
});
