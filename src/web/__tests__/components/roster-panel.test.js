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

// The import sheet has its own suite; here it only reports what it commits
// and asks to be closed.
jest.mock("@/components/schedule/RosterImportWizard", () => ({
  __esModule: true,
  default: ({ onCommitted, onClose }) => (
    <div data-testid="import-wizard">
      <button
        type="button"
        onClick={() =>
          onCommitted({
            receipt: { importedCount: 2, createdCount: 2, updatedCount: 0 },
            autoInvitedCount: 1,
            sendInvitations: true,
            deliveryRequest: { id: "import-delivery", recipientCount: 1 },
            event: { code: "ROSTER1", status: "active", version: 9 },
          })
        }
      >
        Commit import
      </button>
      <button
        type="button"
        onClick={() =>
          onCommitted({
            receipt: { mode: "rebuild", importedCount: 1, createdCount: 1 },
            sendInvitations: false,
          })
        }
      >
        Commit rebuild
      </button>
      <button type="button" onClick={onClose}>
        Close import
      </button>
    </div>
  ),
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

jest.mock("@/lib/api/events", () => ({
  sendReminders: jest.fn(),
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
import { sendReminders } from "@/lib/api/events";
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
  responseDeadline: null,
  remindersEnabled: false,
  reminderHoursBefore: 24,
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

const groupStats = [
  { id: 11, name: "Faculty", count: 1, weight: 1, included: true },
  { id: 12, name: "Students", count: 0, weight: null, included: null },
];

function participant(overrides = {}) {
  return {
    id: "p-1",
    memberId: "m-1",
    name: "Temp Person",
    email: "temp@example.com",
    phone: "",
    group: "Faculty",
    groups: [{ id: 11, name: "Faculty" }],
    allGroups: false,
    weight: 1,
    included: true,
    submitted: false,
    version: 4,
    accountAccess: "temporary",
    organizerManaged: false,
    canOrganizerEditAvailability: true,
    canOrganizerEditEmail: true,
    isOrganizer: false,
    invitationStatus: "sent",
    invitationDelivery: null,
    ...overrides,
  };
}

const second = participant({
  id: "p-2",
  memberId: "m-2",
  name: "Second Person",
  email: "second@example.com",
  group: "",
  groups: [],
  submitted: true,
  invitationStatus: "not_sent",
});

function rosterResponse(participants, extra = {}) {
  const submitted = participants.filter((entry) => entry.submitted).length;
  const excluded = participants.filter(
    (entry) => entry.included === false,
  ).length;
  const counts = {
    total: participants.length,
    submitted,
    notSubmitted: participants.length - submitted,
    included: participants.length - excluded,
    excluded,
  };
  return {
    participants,
    pagination: {
      page: 1,
      pageSize: 50,
      total: participants.length,
      pages: 1,
    },
    stats: { ...counts, groups: groupStats },
    overall: {
      ...counts,
      notInvited: participants.filter(
        (entry) => entry.invitationStatus === "not_sent",
      ).length,
      sending: 0,
      failed: 0,
      noEmail: 0,
      remindable: 3,
    },
    organizerOnRoster: true,
    ...extra,
  };
}

function scheduleResponse(overrides = {}) {
  return {
    participant: {
      id: "p-1",
      memberId: "m-1",
      name: "Temp Person",
      included: true,
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
  await waitFor(() =>
    expect(screen.queryByText("Loading participants…")).not.toBeInTheDocument(),
  );
  return { ...utils, getToken };
}

async function openEditor(name = "Edit schedule") {
  fireEvent.click((await screen.findAllByRole("button", { name }))[0]);
  return screen.findByRole("dialog", {
    name: /schedule$/,
  });
}

async function openRowMenu(name) {
  fireEvent.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  return screen.getByRole("menu", { name: `Actions for ${name}` });
}

const menuItem = (label) => screen.getByRole("menuitem", { name: label });

// The drawers' backdrop and header button share one label; the header
// button is the one inside the dialog.
const closeButton = (dialogName, label) =>
  within(screen.getByRole("dialog", { name: dialogName })).getByRole("button", {
    name: label,
  });

// Popovers close on a pointer press outside them.
const closePopover = () => fireEvent.pointerDown(document.body);

// Matches text that begins with `prefix` (a function matcher, so no pattern
// is built from a variable).
const startsWith = (prefix) => (text) => text.startsWith(prefix);

// The row's title span comes before any panel or notice that repeats the
// name.
const rowFor = (name) => screen.getAllByText(startsWith(name))[0].closest("tr");

async function openPerson(name = "Temp Person") {
  fireEvent.click(
    await screen.findByRole("button", { name: startsWith(name) }),
  );
  return screen.findByRole("dialog", { name });
}

function toast(text) {
  return within(
    screen.getByRole("region", { name: "Notifications" }),
  ).getByText(text);
}

async function findToast(text) {
  return within(
    screen.getByRole("region", { name: "Notifications" }),
  ).findByText(text);
}

beforeEach(() => {
  jest.resetAllMocks();
  document.body.style.overflow = "";
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: jest.fn().mockReturnValue("roster-key") },
  });
  HTMLElement.prototype.scrollIntoView = jest.fn();
  fetchRoster.mockResolvedValue(rosterResponse([participant(), second]));
  fetchRosterSchedule.mockResolvedValue(scheduleResponse());
  patchRosterBulk.mockResolvedValue({ updatedCount: 2, resultsRevision: 8 });
});

describe("RosterPanel states", () => {
  test("shows the loading state, then the empty state with its actions", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([], { organizerOnRoster: false }),
    );
    render(
      <RosterPanel
        event={event}
        setEvent={jest.fn()}
        getToken={jest.fn().mockResolvedValue("token")}
      />,
    );
    expect(screen.getByText("Loading participants…")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "No participants yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add people one at a time or import a list. Nobody is emailed until you invite them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Search participants"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("0 people · 0 submitted · 0 not submitted · 2 groups"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add myself" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Create a group" }));
    expect(
      await screen.findByRole("dialog", { name: "Groups" }),
    ).toBeInTheDocument();
    fireEvent.click(closeButton("Groups", "Close groups"));

    fireEvent.click(
      screen.getByRole("button", { name: "Import a spreadsheet" }),
    );
    expect(await screen.findByTestId("import-wizard")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    expect(screen.queryByTestId("import-wizard")).not.toBeInTheDocument();

    const empty = screen.getByRole("heading", {
      name: "No participants yet",
    }).parentElement;
    fireEvent.click(
      within(empty).getByRole("button", { name: "+ Add person" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add a person" }),
    ).toBeInTheDocument();
  });

  test("keeps a closed event read-only, with the reason on the disabled actions", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([]));
    await renderPanel({ event: { ...event, status: "closed" } });
    expect(
      await screen.findByText("This event does not have any participants."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ Add person" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import" })).toHaveAttribute(
      "title",
      "Responses are closed, so this list is read-only.",
    );
    expect(
      screen.queryByRole("button", { name: "Email" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import a spreadsheet" }),
    ).not.toBeInTheDocument();
  });

  test("locks the list once the response deadline has passed, noticed on its own", async () => {
    jest.useFakeTimers();
    try {
      const deadline = new Date(Date.now() + 30000).toISOString();
      render(
        <RosterPanel
          event={{ ...event, responseDeadline: deadline }}
          setEvent={jest.fn()}
          getToken={jest.fn().mockResolvedValue("token")}
        />,
      );
      await act(async () => {
        jest.advanceTimersByTime(0);
      });
      expect(await screen.findByText(/^Temp Person/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Email" })).toBeEnabled();
      expect(screen.queryByText(/has passed/)).not.toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(61000);
      });
      expect(screen.getByRole("status", { name: "" })).toBeInTheDocument();
      expect(
        screen.getByText(/The response deadline .* has passed/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Change deadline" }),
      ).toHaveAttribute("href", "/edit?code=ROSTER1");
      expect(
        screen.queryByRole("button", { name: "Email" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "+ Add person" }),
      ).toHaveAttribute(
        "title",
        "The response deadline has passed, so people can't be added, invited or changed.",
      );
      // Schedules can still be entered for people the organizer answers for.
      expect(
        screen.getAllByRole("button", { name: "Edit schedule" })[0],
      ).toBeEnabled();
      expect(screen.getByLabelText("Select Temp Person")).toBeDisabled();
    } finally {
      jest.useRealTimers();
    }
  });

  test("reads the organizer's own schedule as read-only after the deadline, others still editable", async () => {
    const me = participant({
      id: "p-me",
      memberId: "m-me",
      name: "Olive Organizer",
      isOrganizer: true,
      canOrganizerEditAvailability: false,
    });
    const leftOut = participant({
      id: "p-out",
      memberId: "m-out",
      name: "Left Out",
      included: false,
    });
    fetchRoster.mockResolvedValue(rosterResponse([participant(), leftOut, me]));
    const summaries = {
      "p-me": {
        id: "p-me",
        memberId: "m-me",
        name: "Olive Organizer",
        isOrganizer: true,
        version: 1,
      },
      "p-out": {
        id: "p-out",
        memberId: "m-out",
        name: "Left Out",
        included: false,
        version: 1,
      },
    };
    fetchRosterSchedule.mockImplementation((_code, id) =>
      Promise.resolve(
        scheduleResponse(summaries[id] ? { participant: summaries[id] } : {}),
      ),
    );
    await renderPanel({
      event: { ...event, responseDeadline: "2020-01-01T00:00:00Z" },
    });
    // The roster cannot change, so the left-out banner only offers to show
    // who is left out.
    expect(
      screen.getByRole("button", { name: "Count everyone again" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show them" })).toBeEnabled();

    let dialog = await openEditor("Edit my schedule");
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "The response deadline has passed, so your own answers can't change.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Submit" }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    dialog = await openEditor("Edit schedule");
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    ).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    // Counting a left-out person in again is a roster change, so it waits
    // for the deadline to move.
    fireEvent.click(
      within(rowFor("Left Out")).getByRole("button", { name: "Edit schedule" }),
    );
    dialog = await screen.findByRole("dialog", {
      name: "Edit Left Out's schedule",
    });
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Left Out is left out of the results, so their schedule can't change.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Count them again" }),
    ).toBeDisabled();
  });

  test("reports a failed load with a retry and clears it after a silent reload", async () => {
    fetchRoster
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValue(rosterResponse([participant()]));
    const panel = createRef();
    await renderPanel({ ref: panel });
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to load the participant list.",
      ),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/^Temp Person/)).toBeInTheDocument();
  });

  test("summarises the whole list and offers the left-out banner", async () => {
    const onResultsInvalidated = jest.fn();
    fetchRoster.mockResolvedValue(
      rosterResponse([participant({ included: false }), second]),
    );
    await renderPanel({ onResultsInvalidated });
    expect(
      await screen.findByText(
        "2 people · 1 submitted · 1 not submitted · 2 groups",
      ),
    ).toBeInTheDocument();
    const banner = screen.getByText("1 person is left out of the results.");
    expect(banner).toBeInTheDocument();
    const row = rowFor("Temp Person");
    expect(within(row).getByText("Left out of results")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ included: "false", page: 1 }),
        "token",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove filter Results: Left out" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Showing 2 of 2 people/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Count everyone again" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          filter: { all: true },
          updates: { included: true },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(
      await findToast("Everyone counts in the results again."),
    ).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalledWith(8);

    patchRosterBulk.mockRejectedValueOnce(new Error(""));
    fireEvent.click(
      screen.getByRole("button", { name: "Count everyone again" }),
    );
    expect(
      await findToast("Unable to change the results."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(
        screen.getByRole("region", { name: "Notifications" }),
      ).getAllByRole("button", { name: "Dismiss" })[0],
    );
  });

  test("closes everything that could change the list once the event is no longer active", async () => {
    const { rerender } = await renderPanel();
    await openPerson();
    fireEvent.click(screen.getByLabelText("Select Second Person"));
    rerender(
      <RosterPanel
        event={{ ...event, status: "closed" }}
        setEvent={jest.fn()}
        getToken={jest.fn().mockResolvedValue("token")}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Selected people" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select Second Person")).toBeDisabled();
  });
});

describe("RosterPanel search, filters and paging", () => {
  test("searches with a debounce, shows chips, and clears them together", async () => {
    await renderPanel();
    const search = await screen.findByLabelText("Search participants");
    expect(search).toHaveAttribute(
      "placeholder",
      "Search name, email, phone or group",
    );
    fireEvent.change(search, { target: { value: " zed " } });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ search: "zed", page: 1 }),
        "token",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove filter Search: zed" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Response" })).getByLabelText(
        "Not submitted",
      ),
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ search: "zed", submitted: "false" }),
        "token",
      ),
    );
    closePopover();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter Search: zed" }),
    );
    expect(search).toHaveValue("");
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ search: "", submitted: "false" }),
        "token",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove filter Response: Not submitted",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull(),
    );

    closePopover();
    // No match: the empty state offers to clear everything.
    fetchRoster.mockResolvedValueOnce({
      ...rosterResponse([]),
      overall: rosterResponse([participant()]).overall,
    });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Invitation" })).getByLabelText(
        "Failed",
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "No matching participants." }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(
        screen
          .getByRole("heading", { name: "No matching participants." })
          .closest(".empty-state"),
      ).getByRole("button", { name: "Clear all" }),
    );
    expect(await screen.findByText(/^Temp Person/)).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Active filters" }),
    ).not.toBeInTheDocument();
  });

  test("filters by group from the popover and manages groups from its footer", async () => {
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Group: Everyone/ }),
    );
    fireEvent.click(screen.getByLabelText("Faculty"));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Faculty" }),
        "token",
      ),
    );
    expect(
      screen.getByRole("button", { name: /^Group: Faculty/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Group: Faculty/ }));
    fireEvent.click(screen.getByRole("button", { name: "Manage groups…" }));
    expect(
      await screen.findByRole("dialog", { name: "Groups" }),
    ).toBeInTheDocument();
    fireEvent.click(closeButton("Groups", "Close groups"));
  });

  test("creates a group from the popover with validation and error reporting", async () => {
    createRosterGroup
      .mockRejectedValueOnce(new Error("Taken"))
      .mockResolvedValueOnce({
        group: { id: 13, name: "Staff" },
        groups: [...groupStats, { id: 13, name: "Staff", count: 0 }],
      });
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Group: Everyone/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ New group" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    fireEvent.submit(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Enter a group name.",
    );
    fireEvent.change(within(dialog).getByLabelText("Group name"), {
      target: { value: "Staff" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Taken");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await findToast("Created group Staff.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
    expect(
      screen.getByText("2 people · 1 submitted · 1 not submitted · 3 groups"),
    ).toBeInTheDocument();
    expect(createRosterGroup).toHaveBeenCalledWith(
      "ROSTER1",
      { name: "Staff" },
      "token",
    );

    // Cancelling the dialog leaves nothing behind.
    fireEvent.click(screen.getByRole("button", { name: /^Group: Everyone/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ New group" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "New group" }),
      ).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
  });

  test("keeps the new-group dialog closed while the list is read-only", async () => {
    await renderPanel({
      event: { ...event, responseDeadline: "2020-01-01T00:00:00Z" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /^Group: Everyone/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ New group" }));
    expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
  });

  test("pages through a large roster, changes the page size, and clamps a page past the end", async () => {
    const many = Array.from({ length: 26 }, (_entry, index) =>
      participant({ id: `p-${index}`, name: `Person ${index}` }),
    );
    fetchRoster.mockImplementation((_code, { page }) =>
      Promise.resolve({
        ...rosterResponse(many),
        pagination: { page, pageSize: 25, total: 60, pages: 3 },
      }),
    );
    const panel = createRef();
    await renderPanel({ ref: panel });
    await screen.findByText("Page 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ page: 2 }),
        "token",
      ),
    );
    await screen.findByText("Page 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Page 1 of 3");
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

    // People removed elsewhere: page 3 no longer exists, so the last page
    // is shown instead.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("Page 3 of 3");
    fetchRoster.mockImplementation((_code, { page }) =>
      Promise.resolve({
        ...rosterResponse(many),
        pagination: { page, pageSize: 100, total: 40, pages: 1 },
      }),
    );
    // A silent refresh through the ref, as the live sync does, notices it
    // and lands on the last page on its own.
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ page: 1, pageSize: 100 }),
        "token",
      ),
    );
    await screen.findByText("Page 1 of 1");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("RosterPanel selection and bulk changes", () => {
  test("selects a page, everyone matching, and applies weight and counting in bulk", async () => {
    const onResultsInvalidated = jest.fn();
    fetchRoster.mockResolvedValue({
      ...rosterResponse([participant(), second]),
      pagination: { page: 1, pageSize: 2, total: 60, pages: 30 },
    });
    await renderPanel({ onResultsInvalidated });
    fireEvent.click(await screen.findByLabelText("Select Temp Person"));
    const bar = screen.getByRole("region", { name: "Selected people" });
    expect(bar).toHaveTextContent("1 selected");

    fireEvent.click(screen.getByLabelText("Select everyone on this page"));
    expect(bar).toHaveTextContent("2 selected");
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 60 matching" }),
    );
    expect(bar).toHaveTextContent("60 selected · everyone matching the filter");
    expect(
      screen.getByText("Everyone matching the filter is selected (60)."),
    ).toBeInTheDocument();

    // A change to everyone matching is confirmed first.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(menuItem("Set weight…"));
    const weightDialog = await screen.findByRole("dialog", {
      name: "Set weight",
    });
    fireEvent.change(within(weightDialog).getByLabelText("Weight"), {
      target: { value: "0.5" },
    });
    fireEvent.click(
      within(weightDialog).getByRole("button", { name: "Apply" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Apply to 60 people?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(patchRosterBulk).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(menuItem("Count in results"));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Apply to 60 people?" }),
      ).getByRole("button", { name: "Apply" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          filter: { all: true },
          updates: { included: true },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(
      await findToast("2 people now count in the results."),
    ).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalledWith(8);
    // The selection survives the reload.
    expect(bar).toHaveTextContent("60 selected");

    // Unticking a row leaves select-all mode; the explicit ids stay.
    fireEvent.click(screen.getByLabelText("Select Second Person"));
    expect(bar).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(menuItem("Leave out of results"));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1"],
          updates: { included: false },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(
      await findToast("Left 2 people out of the results."),
    ).toBeInTheDocument();

    patchRosterBulk.mockRejectedValueOnce(new Error("Nope"));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(menuItem("Set weight…"));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Set weight" }),
      ).getByRole("button", { name: "Apply" }),
    );
    expect(await findToast("Nope")).toBeInTheDocument();

    // Select all again, then a filter change drops the everyone-matching
    // mode, and Clear drops the rest.
    fireEvent.click(screen.getByLabelText("Select everyone on this page"));
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 60 matching" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Results" })).getByLabelText(
        "Counted",
      ),
    );
    expect(bar).toHaveTextContent("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.queryByRole("region", { name: "Selected people" }),
    ).not.toBeInTheDocument();
  });

  test("sends the active filter as the selector for everyone matching", async () => {
    fetchRoster.mockResolvedValue({
      ...rosterResponse([participant()]),
      pagination: { page: 1, pageSize: 1, total: 3, pages: 3 },
    });
    await renderPanel();
    fireEvent.change(await screen.findByLabelText("Search participants"), {
      target: { value: "temp" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ search: "temp" }),
        "token",
      ),
    );
    fireEvent.click(screen.getByLabelText("Select everyone on this page"));
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 3 matching" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(menuItem("Count in results"));
    fireEvent.submit(
      await screen.findByRole("dialog", { name: "Apply to 3 people?" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        expect.objectContaining({ filter: { search: "temp" } }),
        "token",
      ),
    );
  });

  test("changes groups for the selected people through the picker", async () => {
    await renderPanel();
    fireEvent.click(await screen.findByLabelText("Select Temp Person"));
    fireEvent.click(screen.getByLabelText("Select Second Person"));
    fireEvent.click(screen.getByRole("button", { name: "Groups…" }));
    const picker = await screen.findByRole("dialog", {
      name: "Groups for 2 selected people",
    });
    expect(within(picker).getByLabelText("Faculty").indeterminate).toBe(true);
    expect(picker).toHaveTextContent("1 of 2");
    fireEvent.click(within(picker).getByLabelText("Students"));
    fireEvent.click(within(picker).getByLabelText("Faculty"));
    fireEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1", "p-2"],
          updates: { addGroups: ["Faculty", "Students"] },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(await findToast("Updated groups for 2 people.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("starts the picker mixed for everyone matching and creates a group inside it", async () => {
    createRosterGroup.mockResolvedValue({
      group: { id: 13, name: "Staff" },
      groups: [...groupStats, { id: 13, name: "Staff", count: 0 }],
    });
    fetchRoster.mockResolvedValue({
      ...rosterResponse([participant()]),
      pagination: { page: 1, pageSize: 1, total: 30, pages: 30 },
    });
    await renderPanel();
    fireEvent.click(
      await screen.findByLabelText("Select everyone on this page"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 30 matching" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Groups…" }));
    const picker = await screen.findByRole("dialog", {
      name: "Groups for 30 selected people",
    });
    expect(within(picker).getByLabelText("Faculty").indeterminate).toBe(true);
    expect(picker).not.toHaveTextContent("of 30");
    fireEvent.click(
      within(picker).getByRole("button", { name: "+ New group" }),
    );
    fireEvent.change(within(picker).getByLabelText("New group name"), {
      target: { value: "Staff" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Create" }));
    expect(await within(picker).findByLabelText("Staff")).toBeChecked();
    expect(toast("Created group Staff.")).toBeInTheDocument();
    fireEvent.click(
      within(picker).getByLabelText(
        "Every group, including groups added later",
      ),
    );
    fireEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    fireEvent.submit(
      await screen.findByRole("dialog", { name: "Apply to 30 people?" }),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          filter: { all: true },
          updates: { addGroups: ["Staff"], allGroups: true },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );

    // Closing the picker without applying changes nothing.
    fireEvent.click(screen.getByRole("button", { name: "Groups…" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: "Groups for 30 selected people",
        }),
      ).getByRole("button", { name: "Cancel" }),
    );
    expect(patchRosterBulk).toHaveBeenCalledTimes(1);
  });
});

describe("RosterPanel invitations", () => {
  test("previews and sends invitations to the selected people", async () => {
    const onDeliveryRequestChange = jest.fn();
    sendRosterInvitations
      .mockResolvedValueOnce({
        preview: true,
        requestedCount: 2,
        willSend: 1,
        skipped: { alreadyInvited: 1, noEmail: 0, organizer: 0, inFlight: 0 },
      })
      .mockResolvedValueOnce({
        queuedCount: 2,
        skipped: { alreadyInvited: 0, noEmail: 0 },
        deliveryRequest: { id: "delivery-1", recipientCount: 2 },
      });
    const card = document.createElement("div");
    card.className = "organizer-workspace__delivery";
    document.body.appendChild(card);
    await renderPanel({ onDeliveryRequestChange });
    fireEvent.click(
      await screen.findByLabelText("Select everyone on this page"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send invitation…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    expect(dialog).toHaveTextContent("Checking who can be invited…");
    expect(
      await within(dialog).findByText("1 will get an invitation now"),
    ).toBeInTheDocument();
    expect(sendRosterInvitations).toHaveBeenCalledWith(
      "ROSTER1",
      { participantIds: ["p-1", "p-2"], preview: true, resend: false },
      "token",
    );
    fireEvent.click(within(dialog).getByLabelText("Email them again too"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send 2 invitations" }),
    );
    await waitFor(() =>
      expect(sendRosterInvitations).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          participantIds: ["p-1", "p-2"],
          resend: true,
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(await findToast("Queued 2 invitations.")).toBeInTheDocument();
    expect(onDeliveryRequestChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "delivery-1" }),
    );
    expect(
      screen.queryByRole("region", { name: "Selected people" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    card.remove();
  });

  test("invites one person from the row menu and reports preview, throttle and send errors", async () => {
    sendRosterInvitations
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce({
        requestedCount: 1,
        willSend: 1,
        skipped: {},
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("Slow down"), { status: 429 }),
      )
      .mockResolvedValueOnce({ requestedCount: 1, willSend: 1, skipped: {} })
      .mockRejectedValueOnce(new Error("Mail is down"))
      .mockResolvedValueOnce({
        queuedCount: 0,
        skipped: { alreadyInvited: 0, noEmail: 1 },
        deliveryRequest: { id: "delivery-0", recipientCount: 0 },
      });
    const onDeliveryRequestChange = jest.fn();
    await renderPanel({ onDeliveryRequestChange });
    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Resend invitation"));
    let dialog = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Unable to check who can be invited.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await openRowMenu("Second Person");
    fireEvent.click(menuItem("Send invitation"));
    dialog = await screen.findByRole("dialog", { name: "Send invitations" });
    const send = await within(dialog).findByRole("button", {
      name: "Send 1 invitation",
    });
    fireEvent.click(send);
    expect(
      await findToast(
        "Too many invitation requests. Try again in a few minutes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await openRowMenu("Second Person");
    fireEvent.click(menuItem("Send invitation"));
    dialog = await screen.findByRole("dialog", { name: "Send invitations" });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Send 1 invitation" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Mail is down",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send 1 invitation" }),
    );
    expect(
      await findToast("Queued 0 invitations. Skipped 1 without an email."),
    ).toBeInTheDocument();
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
  });

  test("invites everyone not invited yet and sends reminders after a preview", async () => {
    const onDeliveryRequestChange = jest.fn();
    sendRosterInvitations.mockResolvedValue({
      requestedCount: 1,
      willSend: 1,
      skipped: {},
    });
    sendReminders
      .mockResolvedValueOnce({ preview: true, wouldEnqueue: 3 })
      .mockResolvedValueOnce({
        deliveryRequestId: "reminder-1",
        recipientCount: 3,
        delivery: { total: 3, pending: 3 },
      })
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce({ preview: true, wouldEnqueue: 2 })
      .mockRejectedValueOnce(new Error("Reminders failed"));
    await renderPanel({
      onDeliveryRequestChange,
      event: {
        ...event,
        remindersEnabled: true,
        responseDeadline: "2999-01-02T00:00:00Z",
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Email" }));
    const menu = screen.getByRole("menu", { name: "Email" });
    expect(menu).toHaveTextContent("Next automatic reminder:");
    fireEvent.click(menuItem("Invite everyone not invited yet (1)…"));
    const dialog = await screen.findByRole("dialog", {
      name: "Send invitations",
    });
    await within(dialog).findByText("1 will get an invitation now");
    expect(sendRosterInvitations).toHaveBeenCalledWith(
      "ROSTER1",
      {
        filter: { invitationStatus: "not_sent" },
        preview: true,
        resend: false,
      },
      "token",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(menuItem("Send reminders (3)…"));
    const confirm = await screen.findByRole("dialog", {
      name: "Remind 3 invited people who haven't submitted?",
    });
    expect(sendReminders).toHaveBeenCalledWith(
      "ROSTER1",
      { preview: true },
      "token",
    );
    expect(confirm).toHaveTextContent(
      "People never invited, people without an email, and you are skipped.",
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Send reminders" }),
    );
    await waitFor(() =>
      expect(sendReminders).toHaveBeenLastCalledWith(
        "ROSTER1",
        { idempotencyKey: "roster-key" },
        "token",
      ),
    );
    expect(await findToast("Queued 3 reminders.")).toBeInTheDocument();
    expect(onDeliveryRequestChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reminder-1", operation: "reminder" }),
    );

    // A failed preview is a toast; a failed send too.
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(menuItem("Send reminders (3)…"));
    expect(
      await findToast("Unable to check who can be reminded."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(menuItem("Send reminders (3)…"));
    fireEvent.submit(
      await screen.findByRole("dialog", {
        name: "Remind 2 invited people who haven't submitted?",
      }),
    );
    expect(await findToast("Reminders failed")).toBeInTheDocument();
  });

  test("keeps reminders off the menu while they are off, and refuses a run the server says is off", async () => {
    sendReminders.mockResolvedValue({
      preview: true,
      wouldEnqueue: 2,
      remindersEnabled: false,
    });
    const { rerender, getToken } = await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Email" }));
    expect(screen.getByRole("menu", { name: "Email" })).toHaveTextContent(
      "Reminders are off",
    );
    expect(menuItem("Send reminders (3)…")).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Email" }), {
      key: "Escape",
    });

    // The event on screen says reminders are on, but the preview (the
    // server's word) says they were turned off since.
    rerender(
      <RosterPanel
        event={{ ...event, remindersEnabled: true }}
        setEvent={jest.fn()}
        getToken={getToken}
        onResultsInvalidated={jest.fn()}
        onDeliveryRequestChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(menuItem("Send reminders (3)…"));
    expect(
      await findToast(
        "Reminders are off for this event, so nobody would be emailed. Turn them on in the event settings first.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sendReminders).toHaveBeenCalledTimes(1);
    expect(sendReminders).toHaveBeenCalledWith(
      "ROSTER1",
      { preview: true },
      "token",
    );
  });

  test("says reminders are off and lets the reminder confirmation be cancelled", async () => {
    sendReminders.mockResolvedValue({ preview: true, wouldEnqueue: 1 });
    fetchRoster.mockResolvedValue({
      ...rosterResponse([participant()]),
      overall: undefined,
    });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Email" }));
    expect(screen.getByRole("menu", { name: "Email" })).toHaveTextContent(
      "Reminders are off",
    );
    expect(menuItem("Send reminders (0)…")).toBeDisabled();
    expect(
      menuItem("Invite everyone not invited yet (0)…"),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Email" }), {
      key: "Escape",
    });
  });
});

describe("RosterPanel person panel", () => {
  test("opens a person, moves between people, and saves changed fields", async () => {
    patchRosterParticipant.mockResolvedValue({
      participant: participant({ phone: "+1 555 0100", version: 5 }),
      groups: [
        { id: 11, name: "Faculty", count: 1, weight: 1, included: true },
      ],
    });
    await renderPanel();
    let dialog = await openPerson();
    expect(dialog).toHaveTextContent("1 of 2");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next person" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Second Person" });
    expect(dialog).toHaveTextContent("2 of 2");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Previous person" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Temp Person" });

    fireEvent.change(within(dialog).getByLabelText(/^Phone/), {
      target: { value: "+1 555 0100" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { phone: "+1 555 0100", expectedVersion: 4 },
        "token",
      ),
    );
    expect(await findToast("Saved.")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Temp Person" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 people · 1 submitted · 1 not submitted · 1 group"),
    ).toBeInTheDocument();
    expect(
      within(rowFor("Temp Person")).getByText("temp@example.com · +1 555 0100"),
    ).toBeInTheDocument();

    // A new address has not been invited yet: the toast offers to send.
    sendRosterInvitations.mockResolvedValue({ willSend: 1, skipped: {} });
    patchRosterParticipant.mockResolvedValue({
      participant: participant({
        email: "new@example.com",
        invitationStatus: "not_sent",
        version: 6,
      }),
    });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await findToast("Saved. The new address hasn't been invited yet."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Notifications" })).getByRole(
        "button",
        { name: "Send invitation" },
      ),
    );
    expect(
      await screen.findByRole("dialog", { name: "Send invitations" }),
    ).toBeInTheDocument();
    expect(sendRosterInvitations).toHaveBeenCalledWith(
      "ROSTER1",
      { participantIds: ["p-1"], preview: true, resend: false },
      "token",
    );
    // Escape reaches the dialog above the panel only.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Send invitations" }),
    ).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Temp Person" }),
    ).toBeInTheDocument();
  });

  test("keeps a conflicted draft in the panel and saves it again on the newer version", async () => {
    patchRosterParticipant
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), {
          status: 409,
          participant: participant({ phone: "+1 555 0999", version: 9 }),
        }),
      )
      .mockResolvedValueOnce({
        participant: participant({
          phone: "+1 555 0100",
          weight: 0.5,
          version: 10,
        }),
      });
    await renderPanel();
    const dialog = await openPerson();
    fireEvent.change(within(dialog).getByLabelText(/^Phone/), {
      target: { value: "+1 555 0100" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Temp Person was changed in another session, so your change wasn't saved. Save again to apply it on top of the latest values.",
    );
    // The row holds what the server has; the panel keeps the typed values,
    // still unsaved.
    const row = rowFor("Temp Person");
    expect(
      within(row).getByText("temp@example.com · +1 555 0999"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply again" })).toBeNull();
    expect(within(dialog).getByLabelText(/^Phone/)).toHaveValue("+1 555 0100");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByRole("dialog", {
      name: "Discard your changes?",
    });
    fireEvent.click(
      within(discard).getByRole("button", { name: "Keep editing" }),
    );

    // A further edit does not lose the conflicted field.
    fireEvent.change(within(dialog).getByLabelText(/^Weight/), {
      target: { value: "0.5" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { phone: "+1 555 0100", weight: 0.5, expectedVersion: 9 },
        "token",
      ),
    );
    expect(await findToast("Saved.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      within(rowFor("Temp Person")).getByText("temp@example.com · +1 555 0100"),
    ).toBeInTheDocument();
  });

  test("keeps other failures inside the panel and lets a conflicted draft be discarded", async () => {
    patchRosterParticipant
      .mockRejectedValueOnce(
        Object.assign(new Error("Bad phone"), { status: 400 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), {
          status: 409,
          participant: participant({ phone: "+1 555 0999", version: 9 }),
        }),
      );
    await renderPanel();
    const dialog = await openPerson();
    fireEvent.change(within(dialog).getByLabelText(/^Phone/), {
      target: { value: "+1 555 0100" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Bad phone",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText(/changed in another session/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByRole("dialog", {
      name: "Discard your changes?",
    });
    fireEvent.click(within(discard).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Temp Person" }),
      ).not.toBeInTheDocument(),
    );
    // The row shows what the server holds, with nothing left to apply.
    expect(
      within(rowFor("Temp Person")).getByText("temp@example.com · +1 555 0999"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/changed in another session/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply again" })).toBeNull();
  });

  test("picks groups for the person, removes them, and opens their schedule", async () => {
    patchRosterParticipant.mockResolvedValue({
      participant: participant({ groups: [{ id: 12, name: "Students" }] }),
    });
    deleteRosterParticipant.mockResolvedValue({ groups: groupStats });
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    let dialog = await openPerson();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "+ Add to group" }),
    );
    let picker = await screen.findByRole("dialog", {
      name: "Groups for Temp Person",
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Groups for Temp Person" }),
      ).toBeNull(),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "+ Add to group" }),
    );
    picker = await screen.findByRole("dialog", {
      name: "Groups for Temp Person",
    });
    fireEvent.click(within(picker).getByLabelText("Students"));
    fireEvent.click(within(picker).getByLabelText("Faculty"));
    fireEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    const chips = within(dialog).getByRole("list", { name: "Groups" });
    expect(await within(chips).findByText("Students")).toBeInTheDocument();
    expect(within(chips).queryByText("Faculty")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { addGroupIds: [12], removeGroupIds: [11], expectedVersion: 4 },
        "token",
      ),
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit schedule" }),
    );
    await screen.findByRole("dialog", { name: "Edit Temp Person's schedule" });
    expect(screen.queryByRole("dialog", { name: "Temp Person" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    dialog = await openPerson();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from event…" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Remove Temp Person from the event?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Remove person" }),
    );
    await waitFor(() =>
      expect(deleteRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        "token",
      ),
    );
    expect(
      await findToast("Temp Person was removed from the event."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalled();
  });
});

describe("RosterPanel rows", () => {
  test("toggles counting from the row menu and reports conflicts and failures", async () => {
    patchRosterParticipant
      .mockResolvedValueOnce({
        participant: participant({ included: false, version: 5 }),
        resultsRevision: 9,
      })
      .mockResolvedValueOnce({
        participant: participant({ included: true, version: 6 }),
      })
      .mockRejectedValueOnce(new Error(""))
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), {
          status: 409,
          participant: participant({ included: false, version: 8 }),
        }),
      )
      .mockResolvedValueOnce({
        participant: participant({ included: false, version: 9 }),
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), {
          status: 409,
          participant: participant({ included: false, version: 11 }),
        }),
      );
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { included: false, expectedVersion: 4 },
        "token",
      ),
    );
    expect(
      await findToast("Temp Person is left out of the results."),
    ).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalledWith(9);

    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Count in results"));
    expect(
      await findToast("Temp Person now counts in the results."),
    ).toBeInTheDocument();
    expect(patchRosterParticipant).toHaveBeenLastCalledWith(
      "ROSTER1",
      "p-1",
      { included: true, expectedVersion: 5 },
      "token",
    );

    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    expect(
      await findToast("Unable to update Temp Person."),
    ).toBeInTheDocument();

    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    const message =
      "Temp Person was changed in another session, so your change wasn't saved. The latest values are shown.";
    expect(await screen.findByText(message)).toBeInTheDocument();
    const row = rowFor("Temp Person");
    expect(within(row).getByText("Left out of results")).toBeInTheDocument();

    // Apply again re-runs the same change on the version now shown.
    fireEvent.click(
      within(row.nextElementSibling).getByRole("button", {
        name: "Apply again",
      }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "p-1",
        { included: false, expectedVersion: 8 },
        "token",
      ),
    );
    expect(await findToast("Temp Person was updated.")).toBeInTheDocument();
    expect(screen.queryByText(message)).toBeNull();

    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Count in results"));
    expect(await screen.findByText(message)).toBeInTheDocument();
    fireEvent.click(
      within(rowFor("Temp Person").nextElementSibling).getByRole("button", {
        name: "Dismiss",
      }),
    );
    expect(screen.queryByText(message)).toBeNull();
  });

  test("reloads when a stale change carries no row, and opens details from the menu", async () => {
    patchRosterParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Stale"), { status: 409 }),
    );
    await renderPanel();
    await openRowMenu("Second Person");
    fireEvent.click(menuItem("Leave out of results"));
    expect(await findToast("Stale")).toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(2);

    await openRowMenu("Second Person");
    fireEvent.click(menuItem("Details"));
    expect(
      await screen.findByRole("dialog", { name: "Second Person" }),
    ).toBeInTheDocument();
    fireEvent.click(closeButton("Second Person", "Close details"));

    await openRowMenu("Second Person");
    fireEvent.click(menuItem("Remove from event…"));
    const confirm = await screen.findByRole("dialog", {
      name: "Remove Second Person from the event?",
    });
    deleteRosterParticipant.mockRejectedValueOnce(new Error(""));
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Remove person" }),
    );
    expect(
      await findToast("Unable to remove Second Person."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("RosterPanel manage groups", () => {
  async function openGroups() {
    fireEvent.click(await screen.findByRole("button", { name: /^Group: / }));
    fireEvent.click(screen.getByRole("button", { name: "Manage groups…" }));
    return screen.findByRole("dialog", { name: "Groups" });
  }

  test("renames, deletes, weights, counts and creates groups from the panel", async () => {
    renameRosterGroup.mockResolvedValue({
      groups: [{ id: 11, name: "Staff", count: 1, weight: 1, included: true }],
    });
    deleteRosterGroup.mockResolvedValue({ groups: [] });
    createRosterGroup.mockResolvedValue({
      group: { id: 14, name: "Guests" },
      groups: [...groupStats, { id: 14, name: "Guests", count: 0 }],
    });
    includeOnlyRosterGroup.mockResolvedValue({
      groups: groupStats,
      resultsRevision: 12,
    });
    const onResultsInvalidated = jest.fn();
    fetchRoster.mockResolvedValue(
      rosterResponse([participant(), second], {
        stats: {
          total: 2,
          submitted: 1,
          notSubmitted: 1,
          groups: [
            { ...groupStats[0], included: false },
            groupStats[1],
            { id: null, name: "", count: 1, weight: 1, included: true },
          ],
        },
      }),
    );
    await renderPanel({ onResultsInvalidated });
    const dialog = await openGroups();

    // Weight and counting for a group, and for the people in no group.
    fireEvent.change(within(dialog).getByLabelText("Weight for Faculty"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(within(dialog).getByLabelText("Weight for Faculty"));
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenCalledWith(
        "ROSTER1",
        {
          group: "Faculty",
          updates: { weight: 0.5 },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(await findToast("Set weight 0.5 for 2 people.")).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalledWith(8);
    fireEvent.click(
      within(dialog).getByLabelText("Count No group in the results"),
    );
    await waitFor(() =>
      expect(patchRosterBulk).toHaveBeenLastCalledWith(
        "ROSTER1",
        {
          group: "",
          updates: { included: false },
          idempotencyKey: "roster-key",
        },
        "token",
      ),
    );
    expect(
      await findToast("Left 2 people out of the results."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByLabelText("Count Faculty in the results"),
    );
    expect(
      await findToast("2 people now count in the results."),
    ).toBeInTheDocument();

    // Count only this group.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Count only this group…"));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: "Count only Faculty in the results?",
        }),
      ).getByRole("button", { name: "Count only this group" }),
    );
    await waitFor(() =>
      expect(includeOnlyRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        11,
        "token",
      ),
    );
    expect(
      await findToast("Only Faculty counts in the results now."),
    ).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalledWith(12);

    // Create, rename and delete.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "+ New group" }),
    );
    fireEvent.change(within(dialog).getByLabelText("New group name"), {
      target: { value: "Guests" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await findToast("Created group Guests.")).toBeInTheDocument();
    expect(await within(dialog).findByText("Guests")).toBeInTheDocument();

    fetchRoster.mockResolvedValue(
      rosterResponse([participant(), second], {
        stats: {
          total: 2,
          submitted: 1,
          notSubmitted: 1,
          groups: [
            { id: 11, name: "Staff", count: 1, weight: 1, included: true },
            groupStats[1],
          ],
        },
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Rename"));
    fireEvent.change(within(dialog).getByLabelText("New name for Faculty"), {
      target: { value: "Staff" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(renameRosterGroup).toHaveBeenCalledWith(
        "ROSTER1",
        11,
        { name: "Staff" },
        "token",
      ),
    );
    expect(await findToast("Renamed Faculty to Staff.")).toBeInTheDocument();
    expect(await within(dialog).findByText("Staff")).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Staff" }),
    );
    fireEvent.click(menuItem("Delete group…"));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Delete group Staff?" }),
      ).getByRole("button", { name: "Delete group" }),
    );
    await waitFor(() =>
      expect(deleteRosterGroup).toHaveBeenCalledWith("ROSTER1", 11, "token"),
    );
    expect(await findToast("Deleted Staff.")).toBeInTheDocument();
  });

  test("follows a renamed or deleted group in the filter and selects a group's people", async () => {
    renameRosterGroup.mockResolvedValue({});
    deleteRosterGroup.mockResolvedValue({});
    await renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Group: Everyone/ }),
    );
    fireEvent.click(screen.getByLabelText("Faculty"));
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Faculty" }),
        "token",
      ),
    );
    let dialog = await openGroups();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Rename"));
    fireEvent.change(within(dialog).getByLabelText("New name for Faculty"), {
      target: { value: "Staff" },
    });
    fireEvent.keyDown(within(dialog).getByLabelText("New name for Faculty"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Staff" }),
        "token",
      ),
    );
    // The reloaded stats still call it Faculty (the mocks do not follow the
    // rename), so the row keeps its name for the delete below.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Delete group…"));
    fireEvent.submit(
      await screen.findByRole("dialog", { name: "Delete group Faculty?" }),
    );
    await waitFor(() => expect(deleteRosterGroup).toHaveBeenCalled());
    // The filter pointed at another name, so the roster simply reloads.
    expect(
      screen.getByRole("button", { name: /^Group: Staff/ }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Select these 1 people"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Groups" })).toBeNull(),
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "Faculty", page: 1 }),
        "token",
      ),
    );
    expect(
      screen.getByRole("region", { name: "Selected people" }),
    ).toHaveTextContent("everyone matching the filter");

    // Deleting the group the list is filtered by clears the filter.
    dialog = await openGroups();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Delete group…"));
    fireEvent.submit(
      await screen.findByRole("dialog", { name: "Delete group Faculty?" }),
    );
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ group: "" }),
        "token",
      ),
    );
  });

  test("shows group action failures inside the panel", async () => {
    renameRosterGroup.mockRejectedValue(new Error("Rename failed"));
    await renderPanel();
    const dialog = await openGroups();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actions for Faculty" }),
    );
    fireEvent.click(menuItem("Rename"));
    fireEvent.change(within(dialog).getByLabelText("New name for Faculty"), {
      target: { value: "Staff" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Rename failed",
    );
    expect(within(dialog).getByLabelText("New name for Faculty")).toHaveValue(
      "Staff",
    );
  });
});

describe("RosterPanel adds people", () => {
  // The create reply describes the member: its id is the member's, and it
  // carries none of the roster-only fields the row and the panel read.
  const added = {
    id: "m-3",
    name: "Manual Person",
    email: "manual@example.com",
    accountAccess: "temporary",
    canOrganizerEditAvailability: true,
    invitationStatus: "not_sent",
    version: 1,
  };
  const addedRow = participant({
    id: "p-3",
    memberId: "m-3",
    name: "Manual Person",
    email: "manual@example.com",
    group: "",
    groups: [],
    invitationStatus: "not_sent",
    version: 1,
  });

  async function openAdd() {
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "+ Add person" }))[0],
    );
    return screen.findByRole("dialog", { name: "Add a person" });
  }

  function fillAdd(dialog) {
    fireEvent.change(within(dialog).getByLabelText(/^Full name/), {
      target: { value: "Manual Person" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), {
      target: { value: "manual@example.com" },
    });
  }

  test("adds a person, opens them, and queues an invitation when asked", async () => {
    const onDeliveryRequestChange = jest.fn();
    const onResultsInvalidated = jest.fn();
    createManagedParticipant
      .mockResolvedValueOnce({
        participant: added,
        created: true,
        autoInvitedCount: 0,
        deliveryRequest: null,
      })
      .mockResolvedValueOnce({
        participant: added,
        created: true,
        autoInvitedCount: 1,
        deliveryRequestId: "manual-delivery",
        recipientCount: 1,
      })
      .mockResolvedValueOnce({
        participant: added,
        created: false,
        autoInvitedCount: 0,
      });
    await renderPanel({ onDeliveryRequestChange, onResultsInvalidated });
    // Once added, the person is on the reloaded page.
    fetchRoster.mockResolvedValue(
      rosterResponse([participant(), second, addedRow]),
    );
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(/^Full name/), {
      target: { value: "Manual Person" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), {
      target: { value: "Manual@Example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createManagedParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        {
          name: "Manual Person",
          email: "manual@example.com",
          phone: "",
          organizerManaged: false,
          idempotencyKey: "roster-key",
          sendInvitation: false,
        },
        "token",
      ),
    );
    expect(
      await within(dialog).findByText(
        "Manual Person was added. No invitation was sent.",
      ),
    ).toBeInTheDocument();
    expect(onResultsInvalidated).toHaveBeenCalled();
    expect(onDeliveryRequestChange).not.toHaveBeenCalled();
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(fetchRosterSchedule).not.toHaveBeenCalled();

    fillAdd(dialog);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add and send invitation" }),
    );
    expect(
      await within(dialog).findByText(
        "Manual Person was added and their invitation is queued.",
      ),
    ).toBeInTheDocument();
    expect(onDeliveryRequestChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "manual-delivery",
        operation: "invitation",
      }),
    );

    fillAdd(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText(
        "Manual Person is already on the list, so nothing was added.",
      ),
    ).toBeInTheDocument();
    sendRosterInvitations.mockResolvedValue({ willSend: 1, skipped: {} });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send invitation" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Send invitations" }),
    ).toBeInTheDocument();
    expect(sendRosterInvitations).toHaveBeenCalledWith(
      "ROSTER1",
      { participantIds: ["p-3"], preview: true, resend: false },
      "token",
    );
    // Escape closes the send dialog only; the add panel stays.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Send invitations" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "Add a person" }),
    ).toBeInTheDocument();

    // Open shows the roster row, not the create reply: the address can
    // still change and the person sits among their neighbours.
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    const panel = await screen.findByRole("dialog", { name: "Manual Person" });
    expect(screen.queryByRole("dialog", { name: "Add a person" })).toBeNull();
    expect(within(panel).getByLabelText(/^Email/)).toBeEnabled();
    expect(within(panel).getByText("3 of 3")).toBeInTheDocument();
  });

  test("fetches the new person's row when the page does not list them, and falls back to the reply", async () => {
    createManagedParticipant.mockResolvedValue({
      participant: added,
      created: true,
      autoInvitedCount: 0,
    });
    fetchRosterSchedule.mockResolvedValueOnce({
      participant: addedRow,
      schedule: {},
    });
    await renderPanel();
    let dialog = await openAdd();
    fillAdd(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await within(dialog).findByText(
      "Manual Person was added. No invitation was sent.",
    );
    expect(fetchRosterSchedule).toHaveBeenCalledWith("ROSTER1", "m-3", "token");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    let panel = await screen.findByRole("dialog", { name: "Manual Person" });
    expect(within(panel).getByLabelText(/^Email/)).toBeEnabled();
    fireEvent.click(closeButton("Manual Person", "Close details"));

    // When the row cannot be read either, the reply stands in, and the
    // panel follows each save so its version stays current.
    fetchRosterSchedule
      .mockRejectedValueOnce(new Error("Not found"))
      .mockResolvedValueOnce({});
    patchRosterParticipant
      .mockResolvedValueOnce({
        participant: { ...addedRow, phone: "+1 555 0100", version: 2 },
      })
      .mockResolvedValueOnce({
        participant: {
          ...addedRow,
          phone: "+1 555 0100",
          weight: 0.5,
          version: 3,
        },
      });
    dialog = await openAdd();
    fillAdd(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await within(dialog).findByText(
      "Manual Person was added. No invitation was sent.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    panel = await screen.findByRole("dialog", { name: "Manual Person" });
    fireEvent.change(within(panel).getByLabelText(/^Phone/), {
      target: { value: "+1 555 0100" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "m-3",
        { phone: "+1 555 0100", expectedVersion: 1 },
        "token",
      ),
    );
    expect(await findToast("Saved.")).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText(/^Weight/), {
      target: { value: "0.5" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "m-3",
        { weight: 0.5, expectedVersion: 2 },
        "token",
      ),
    );
    fireEvent.click(closeButton("Manual Person", "Close details"));

    // A reply without a participant stands in the same way.
    dialog = await openAdd();
    fillAdd(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await within(dialog).findByText(
      "Manual Person was added. No invitation was sent.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(
      await screen.findByRole("dialog", { name: "Manual Person" }),
    ).toBeInTheDocument();
  });

  test("adds a person without email and opens their schedule", async () => {
    createManagedParticipant.mockResolvedValue({
      participant: { ...added, organizerManaged: true },
      created: true,
      autoInvitedCount: 0,
    });
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "p-3",
          memberId: "m-3",
          name: "Manual Person",
          version: 1,
        },
      }),
    );
    await renderPanel();
    fetchRoster.mockResolvedValue(
      rosterResponse([
        participant(),
        second,
        { ...addedRow, email: "", organizerManaged: true },
      ]),
    );
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(/^Full name/), {
      target: { value: "Manual Person" },
    });
    fireEvent.click(
      within(dialog).getByLabelText(
        "They have no email. I'll enter their schedule.",
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("Manual Person was added."),
    ).toBeInTheDocument();
    expect(createManagedParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      expect.objectContaining({ email: "", organizerManaged: true }),
      "token",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Enter their schedule" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Edit Manual Person's schedule",
      }),
    ).toBeInTheDocument();
    expect(fetchRosterSchedule).toHaveBeenCalledWith("ROSTER1", "p-3", "token");
  });

  test("reports add failures with the server's wording and closed events", async () => {
    const setEvent = jest.fn();
    createManagedParticipant
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'That is one of your own addresses. Check "No email of their own".',
          ),
          { status: 409, errorCode: "organizer_own_email" },
        ),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("Closed"), {
          status: 409,
          errorCode: "event_not_active",
          event: { ...event, status: "closed" },
        }),
      )
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce({ participant: {} });
    await renderPanel({ setEvent });
    const dialog = await openAdd();
    const fill = () => {
      fireEvent.change(within(dialog).getByLabelText(/^Full name/), {
        target: { value: "Manual Person" },
      });
      fireEvent.change(within(dialog).getByLabelText(/^Email/), {
        target: { value: "manual@example.com" },
      });
    };
    fill();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That is one of your own addresses.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "This event is closed. Reactivate it before adding participants.",
      ),
    );
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Unable to add this person.",
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "The participant was added without an ID.",
      ),
    );
  });

  test("adds the organizer from the panel and opens their schedule", async () => {
    joinEvent
      .mockResolvedValueOnce({ participant: { id: "m-org", name: "Olive" } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error(""));
    fetchRoster.mockResolvedValue(
      rosterResponse([participant()], { organizerOnRoster: false }),
    );
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "p-org",
          memberId: "m-org",
          name: "Olive",
          isOrganizer: true,
          version: 1,
        },
      }),
    );
    const onResultsInvalidated = jest.fn();
    await renderPanel({ onResultsInvalidated });
    const dialog = await openAdd();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add myself" }));
    expect(
      await screen.findByRole("dialog", { name: "Edit my schedule" }),
    ).toBeInTheDocument();
    expect(joinEvent).toHaveBeenCalledWith("ROSTER1", "token");
    expect(fetchRosterSchedule).toHaveBeenCalledWith(
      "ROSTER1",
      "m-org",
      "token",
    );
    expect(onResultsInvalidated).toHaveBeenCalled();
    expect(
      toast("You're on the list. Your schedule is open."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Without a row id there is nothing to open; a failure is a toast.
    const reopened = await openAdd();
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Add myself" }),
    );
    expect(await findToast("You're on the list.")).toBeInTheDocument();
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Add myself" }),
    );
    expect(
      await findToast("Unable to add you as a participant."),
    ).toBeInTheDocument();
  });
});

describe("RosterPanel import", () => {
  test("keeps the sheet open after a commit and toasts its outcome once closed", async () => {
    const onDeliveryRequestChange = jest.fn();
    const onResultsInvalidated = jest.fn();
    const setEvent = jest.fn();
    await renderPanel({
      onDeliveryRequestChange,
      onResultsInvalidated,
      setEvent,
    });
    fireEvent.click(await screen.findByLabelText("Select Temp Person"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Commit import" }),
    );
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("import-wizard")).toBeInTheDocument();
    expect(onDeliveryRequestChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "import-delivery" }),
    );
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({ version: 9 }),
    );
    expect(onResultsInvalidated).toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Selected people" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    expect(
      await findToast(
        "Imported 2 people: 2 added, 0 updated. 1 invitation queued.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Commit rebuild" }),
    );
    expect(
      screen.queryByRole("region", { name: "Selected people" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    expect(
      await findToast(
        "Imported 1 people: 1 added, 0 updated. No invitations were sent.",
      ),
    ).toBeInTheDocument();
  });
});

describe("RosterPanel schedule drawer", () => {
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

  test("loads the response, paints, copies channels, saves a draft and reads Close", async () => {
    const { getToken } = await renderPanel();
    updateParticipant.mockResolvedValue({
      participant: {
        availabilityInperson: [1, 1, 0],
        availabilityVirtual: [1, 1, 0],
        submitted: 0,
        version: 5,
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
    expect(within(dialog).queryByLabelText("Event display name")).toBeNull();
    expect(dialog).not.toHaveTextContent("never be silently overwritten");

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

    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    expect(updateParticipant).toHaveBeenCalledWith(
      "ROSTER1",
      "m-1",
      {
        name: "Temp Person",
        availabilityInperson: [1, 1, 0],
        availabilityVirtual: [1, 1, 0],
        submitted: 0,
        expectedVersion: 4,
      },
      "token",
    );
    // The roster reloads after a save, and Cancel becomes Close.
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("asks before saving a submitted response as a draft, and submits on behalf", async () => {
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        schedule: {
          availabilityInperson: [0, 1, 0],
          availabilityVirtual: [1, 0, 0],
          submitted: 1,
          version: 4,
        },
      }),
    );
    updateParticipant.mockResolvedValue({
      participant: { submitted: 0, version: 6 },
    });
    await renderPanel();
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Save as a draft?",
    });
    expect(confirm).toHaveTextContent(
      "This takes Temp Person's answers out of the results until you submit again.",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(updateParticipant).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Save as a draft?" }),
      ).getByRole("button", { name: "Save as draft" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    expect(updateParticipant.mock.calls[0][2]).toEqual(
      expect.objectContaining({ submitted: 0 }),
    );

    // Now a draft: no confirmation on the next save; submitting works too.
    updateParticipant.mockResolvedValue({
      participant: { submitted: 1, version: 7 },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Submit on behalf" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Schedule submitted.",
      ),
    );
    expect(updateParticipant.mock.calls[1][2]).toEqual(
      expect.objectContaining({ submitted: 1, expectedVersion: 6 }),
    );
    expect(within(dialog).getByTestId("inperson-values")).toHaveTextContent(
      "0,1,0",
    );
  });

  test("locks a left-out person's schedule until they count again", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([participant({ included: false })]),
    );
    patchRosterParticipant.mockResolvedValue({
      participant: participant({ included: true, version: 5 }),
    });
    await renderPanel();
    const dialog = await openEditor();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Temp Person is left out of the results, so their schedule can't change.",
    );
    expect(within(dialog).getByTestId("channel-editor")).toHaveAttribute(
      "data-readonly",
      "true",
    );
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Count them again" }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-1",
        { included: true, expectedVersion: 4 },
        "token",
      ),
    );
    expect(
      await findToast("Temp Person now counts in the results."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/left out of the results/)).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeEnabled();
  });

  test("falls back to the schedule's own row when it is off the page", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    // The new person is not on the page, so their row is read by member id.
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "p-9",
          memberId: "m-9",
          name: "Off Page",
          organizerManaged: true,
          included: false,
          version: 2,
        },
      }),
    );
    createManagedParticipant.mockResolvedValue({
      participant: { id: "m-9", name: "Off Page", organizerManaged: true },
      created: true,
    });
    patchRosterParticipant.mockRejectedValueOnce(new Error("Nope"));
    await renderPanel();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "+ Add person" }))[0],
    );
    const add = await screen.findByRole("dialog", { name: "Add a person" });
    fireEvent.change(within(add).getByLabelText(/^Full name/), {
      target: { value: "Off Page" },
    });
    fireEvent.click(
      within(add).getByLabelText(
        "They have no email. I'll enter their schedule.",
      ),
    );
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    fireEvent.click(
      await within(add).findByRole("button", { name: "Enter their schedule" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Off Page's schedule",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Count them again" }),
    );
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledWith(
        "ROSTER1",
        "p-9",
        { included: true, expectedVersion: 2 },
        "token",
      ),
    );
    expect(await findToast("Nope")).toBeInTheDocument();
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
    updateParticipant.mockResolvedValueOnce({ participant: { version: 10 } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenLastCalledWith(
        "ROSTER1",
        "m-1",
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
    expect(
      await findToast(
        "Temp Person now manages their own response, so you can no longer edit their schedule.",
      ),
    ).toBeInTheDocument();
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
    const trigger = (
      await screen.findAllByRole("button", { name: "Edit schedule" })
    )[0];
    trigger.focus();
    let dialog = await openEditor();
    expect(
      within(dialog).getByRole("button", { name: "Close schedule editor" }),
    ).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    dialog = await openEditor();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Paint in-person" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    let discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    expect(
      screen.getByRole("dialog", { name: "Edit Temp Person's schedule" }),
    ).toBeInTheDocument();

    // Escape while the dialog is open closes only the dialog.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Temp Person's schedule" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    discardDialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    fireEvent.click(
      within(discardDialog).getByRole("button", { name: "Cancel" }),
    );
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
  });

  test("fills missing schedule arrays and surfaces load errors", async () => {
    await renderPanel();
    fetchRosterSchedule.mockResolvedValueOnce({
      participant: { id: "row", name: "", version: 2 },
      schedule: {},
    });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Edit schedule" }))[0],
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    fetchRosterSchedule.mockRejectedValueOnce(new Error(""));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit schedule" })[0],
    );
    expect(
      await findToast("Unable to load Temp Person's schedule."),
    ).toBeInTheDocument();
  });

  test("reloads instead of opening a response the person has claimed since the roster loaded", async () => {
    fetchRosterSchedule.mockResolvedValue(
      scheduleResponse({
        participant: {
          id: "p-1",
          memberId: "m-1",
          name: "Temp Person",
          version: 4,
          accountAccess: "full",
          canOrganizerEditAvailability: false,
        },
      }),
    );
    await renderPanel();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Edit schedule" }))[0],
    );
    expect(
      await findToast(
        "Temp Person now manages their own response, so you can no longer edit their schedule.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchRoster).toHaveBeenCalledTimes(2);
  });

  test("locks editing while responses are closed and labels people who answer themselves", async () => {
    fetchRoster.mockResolvedValue(
      rosterResponse([
        participant(),
        participant({
          id: "p-2",
          name: "Self Managed",
          accountAccess: "full",
          canOrganizerEditAvailability: false,
        }),
      ]),
    );
    await renderPanel({ event: { ...event, status: "closed" } });
    expect(await screen.findByText("Answers themselves")).toBeInTheDocument();
    const dialog = await openEditor();
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "Availability can only be edited while this event is active.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Save draft" }),
    ).toBeDisabled();
  });
});

describe("RosterPanel live sync and ref", () => {
  test("a silent reload keeps the open panel, the selection and hands back its digest", async () => {
    const activity = {
      total: 2,
      submitted: 1,
      changedAt: "2026-08-20T08:00:00Z",
    };
    fetchRoster.mockResolvedValue(
      rosterResponse([participant(), second], { activity }),
    );
    const panel = createRef();
    await renderPanel({ ref: panel });
    await screen.findByText(/^Temp Person/);
    expect(panel.current.activity()).toEqual(activity);
    fireEvent.click(screen.getByLabelText("Select Second Person"));
    const dialog = await openPerson();
    fireEvent.change(within(dialog).getByLabelText(/^Phone/), {
      target: { value: "+1 555 0100" },
    });

    const moved = { total: 2, submitted: 2, changedAt: "2026-08-20T09:00:00Z" };
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
    expect(screen.queryByText("Loading participants…")).not.toBeInTheDocument();
    await act(async () => {
      releaseRoster(
        rosterResponse([participant({ submitted: true, version: 5 }), second], {
          activity: moved,
        }),
      );
      await silent;
    });
    expect(panel.current.activity()).toEqual(moved);
    expect(
      screen.getByText("2 people · 2 submitted · 0 not submitted · 2 groups"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Temp Person" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Phone/)).toHaveValue("+1 555 0100");
    expect(
      screen.getByRole("region", { name: "Selected people" }),
    ).toHaveTextContent("1 selected");

    // A silent failure is the caller's to report; the panel keeps what it
    // has. A listing without a digest clears the digest.
    fetchRoster.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(
        panel.current.refresh("token", { silent: true }),
      ).rejects.toThrow("offline");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fetchRoster.mockResolvedValueOnce(rosterResponse([participant()]));
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(panel.current.activity()).toBeNull();
  });

  test("a reload never moves a row behind a change that landed while it was in flight", async () => {
    fetchRoster.mockResolvedValue(rosterResponse([participant()]));
    const panel = createRef();
    await renderPanel({ ref: panel });
    await screen.findByText(/^Temp Person/);

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
      participant: participant({ included: false, version: 5 }),
    });
    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    await findToast("Temp Person is left out of the results.");
    await act(async () => {
      releaseRoster(
        rosterResponse([participant({ included: true, version: 4 })]),
      );
      await silent;
    });
    const row = rowFor("Temp Person");
    expect(within(row).getByText("Left out of results")).toBeInTheDocument();

    fetchRoster.mockResolvedValueOnce(
      rosterResponse([participant({ included: true, version: 6 })]),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(within(row).queryByText("Left out of results")).toBeNull();
  });

  test("serializes rapid changes to one row with the latest version", async () => {
    let resolveFirst;
    patchRosterParticipant
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        participant: participant({ included: true, version: 3 }),
      });
    await renderPanel();
    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    await waitFor(() =>
      expect(patchRosterParticipant).toHaveBeenCalledTimes(1),
    );
    await openRowMenu("Temp Person");
    fireEvent.click(menuItem("Leave out of results"));
    expect(patchRosterParticipant).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst({
        participant: participant({ included: false, version: 2 }),
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

  test("recovers a delivery run from the listing and jumps to failed invitations", async () => {
    const onDeliveryRequestChange = jest.fn();
    fetchRoster.mockResolvedValue(
      rosterResponse([participant({ invitationDelivery: "failed" })], {
        latestDeliveryRequest: { id: "recovered", operation: "invitation" },
      }),
    );
    const panel = createRef();
    await renderPanel({ ref: panel, onDeliveryRequestChange });
    await screen.findByText(/^Temp Person/);
    expect(onDeliveryRequestChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "recovered" }),
    );
    const row = rowFor("Temp Person");
    expect(within(row).getByText("Failed")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search participants"), {
      target: { value: "zed" },
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({ search: "zed" }),
        "token",
      ),
    );
    act(() => {
      panel.current.showFailedInvitations();
    });
    await waitFor(() =>
      expect(fetchRoster).toHaveBeenLastCalledWith(
        "ROSTER1",
        expect.objectContaining({
          search: "",
          invitationStatus: "failed",
          page: 1,
        }),
        "token",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove filter Invitation: Failed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Participants" })).toHaveFocus();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
