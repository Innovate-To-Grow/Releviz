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
import { createRef, useState } from "react";

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
              name: "Updated scale event",
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

jest.mock("@/components/auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  downloadFinalCalendar: jest.fn(),
  fetchDeliveryRequest: jest.fn(),
  fetchEventResults: jest.fn(),
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
  updateEvent: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));
jest.mock("@/lib/navigation", () => ({ reloadPage: jest.fn() }));

import { useAuth } from "@/components/auth/AuthContext";
import { useBlockedSlotsDraft } from "@/components/schedule/BlockedSlotsEditor";
import {
  DeliveryRequestProgress,
  EventControls,
  FinalizeScalePanel,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import {
  LiveSyncStatus,
  ManagedScheduleDrawer,
  OrganizerHeader,
} from "@/components/schedule/OrganizerPanels";
import {
  confirmFinalMeeting,
  downloadFinalCalendar,
  fetchDeliveryRequest,
  fetchEventResults,
  previewFinalMeeting,
  retryDeliveryRequest,
  sendReminders,
  updateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { reloadPage } from "@/lib/navigation";
import {
  formatWeekLabel,
  localDateOf,
  selectionFromRecommendation,
  weekStartOf,
} from "@/lib/meetingWindows";

const getToken = jest.fn().mockResolvedValue("token");
const baseEvent = {
  code: "SCALE1",
  name: "Scale event",
  status: "active",
  version: 4,
  accessMode: "invite_only",
  meetingDurationMinutes: 60,
  slotMinutes: 30,
  resultsRevision: 7,
  mode: "mixed",
  days: [1, 3],
  startTime: "09:00",
  endTime: "17:00",
  timezone: "UTC",
  location: "Room 4",
  responseDeadline: null,
};
const recommendation = {
  channel: "virtual",
  startsAt: "2026-09-01T09:00:00Z",
  endsAt: "2026-09-01T10:00:00Z",
};
const drawerEvent = {
  ...baseEvent,
  slotGroups: [
    {
      key: "2026-09-01",
      slots: [
        {
          index: 0,
          startsAt: "2026-09-01T09:00:00Z",
          endsAt: "2026-09-01T09:30:00Z",
        },
        {
          index: 1,
          startsAt: "2026-09-01T09:30:00Z",
          endsAt: "2026-09-01T10:00:00Z",
        },
      ],
    },
  ],
};

function renderDrawerProps(overrides = {}) {
  return {
    event: drawerEvent,
    mode: "inperson",
    participant: { id: "roster-1", name: "Temporary Taylor" },
    participantName: "Temporary Taylor",
    setParticipantName: jest.fn(),
    inperson: [0, 1],
    virtual: [0, 0],
    availabilityValue: 1,
    onAvailabilityValueChange: jest.fn(),
    responsesOpen: true,
    saving: false,
    error: "",
    status: "",
    conflictParticipant: null,
    onInpersonPaint: jest.fn(),
    onVirtualPaint: jest.fn(),
    onCopy: jest.fn(),
    onSaveDraft: jest.fn(),
    onSubmit: jest.fn(),
    onReloadLatest: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
}

function renderDrawer(overrides = {}) {
  const props = renderDrawerProps(overrides);
  return { props, ...render(<ManagedScheduleDrawer {...props} />) };
}

beforeEach(() => {
  jest.resetAllMocks();
  getToken.mockResolvedValue("token");
  useAuth.mockReturnValue({ getToken });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: jest.fn().mockReturnValue("request-key") },
  });
});

test("delivery progress refreshes, retries permanent failures, and reports canceled jobs", async () => {
  const onChange = jest.fn();
  fetchDeliveryRequest.mockResolvedValue({
    request: {
      id: "delivery-1",
      operation: "reminder",
      delivery: { total: 5, sent: 3, permanentFailure: 2, canceled: 1 },
    },
  });
  retryDeliveryRequest.mockResolvedValue({
    id: "delivery-1",
    operation: "reminder",
    summary: { recipientTotal: 5, pending: 2, sent: 3 },
  });
  const { rerender } = render(
    <DeliveryRequestProgress
      initialRequest={{
        id: "delivery-1",
        summary: { recipientTotal: 5, permanentFailure: 2, canceled: 1 },
      }}
      getToken={getToken}
      onChange={onChange}
      refreshKey={0}
    />,
  );

  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
    "Needs attention",
  );
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
    "1 canceled",
  );
  // The card has no refresh button of its own: the workspace's single
  // Refresh bumps `refreshKey`, and mounting with 0 does not fetch.
  expect(
    screen.queryByRole("button", { name: /refresh/i }),
  ).not.toBeInTheDocument();
  expect(fetchDeliveryRequest).not.toHaveBeenCalled();
  rerender(
    <DeliveryRequestProgress
      initialRequest={{
        id: "delivery-1",
        summary: { recipientTotal: 5, permanentFailure: 2, canceled: 1 },
      }}
      getToken={getToken}
      onChange={onChange}
      refreshKey={1}
    />,
  );
  await waitFor(() =>
    expect(fetchDeliveryRequest).toHaveBeenCalledWith("delivery-1", "token"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry failed recipients" }),
  );
  await waitFor(() =>
    expect(retryDeliveryRequest).toHaveBeenCalledWith("delivery-1", "token"),
  );
  expect(onChange).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
      "2 queued",
    ),
  );
});

test("delivery progress exposes refresh and retry errors", async () => {
  fetchDeliveryRequest.mockRejectedValueOnce(new Error("progress unavailable"));
  retryDeliveryRequest.mockRejectedValueOnce(new Error("retry unavailable"));
  render(
    <DeliveryRequestProgress
      initialRequest={{ id: "delivery-2", delivery: { permanentFailure: 1 } }}
      getToken={getToken}
      refreshKey={3}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "progress unavailable",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry failed recipients" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "retry unavailable",
  );
});

test("organizer header keeps lifecycle controls beside the workspace refresh action", async () => {
  const onRefresh = jest.fn();
  const { rerender } = render(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={onRefresh}
      controls={<button type="button">Lifecycle action</button>}
    />,
  );

  expect(
    screen.getByRole("heading", {
      level: 2,
      name: "Scale event",
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Manage participants and find the best meeting time."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Event status: Active"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("UTC timezone")).not.toBeInTheDocument();
  expect(screen.queryByText("60-minute meeting")).not.toBeInTheDocument();

  const actions = screen.getByRole("group", { name: "Workspace actions" });
  expect(
    within(actions).getByRole("button", { name: "Lifecycle action" }),
  ).toBeInTheDocument();
  await userEvent.click(
    within(actions).getByRole("button", { name: "Refresh" }),
  );
  expect(onRefresh).toHaveBeenCalledTimes(1);

  rerender(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={onRefresh}
      refreshing
      controls={<button type="button">Lifecycle action</button>}
    />,
  );
  expect(
    within(actions).getByRole("button", { name: "Refreshing…" }),
  ).toBeDisabled();
  expect(
    within(actions).getByRole("button", { name: "Refreshing…" }),
  ).toHaveAttribute("aria-busy", "true");
});

test("organizer header states whether new responses are loading on their own", () => {
  const { rerender } = render(
    <OrganizerHeader event={baseEvent} onRefresh={jest.fn()} />,
  );
  // Not syncing (the event is not active): no live line at all.
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("Live")).not.toBeInTheDocument();

  rerender(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={jest.fn()}
      live={{ error: "", updatedAt: null }}
    />,
  );
  expect(screen.getByText("Live")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "New responses load automatically.",
  );
  expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();

  // The last time the workspace changed because of a sync sits outside the
  // announced status text, as a machine-readable time.
  const updatedAt = Date.parse("2026-08-20T08:05:00Z");
  rerender(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={jest.fn()}
      live={{ error: "", updatedAt }}
    />,
  );
  const stamp = screen.getByText(/^Updated /);
  expect(stamp.tagName).toBe("TIME");
  expect(stamp).toHaveAttribute("dateTime", "2026-08-20T08:05:00.000Z");
  expect(stamp).toHaveTextContent(
    `Updated ${new Date(updatedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`,
  );
  expect(screen.getByRole("status")).not.toHaveTextContent("Updated");

  rerender(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={jest.fn()}
      live={{
        error: "New responses could not be loaded automatically (offline).",
        updatedAt,
      }}
    />,
  );
  expect(screen.getByText("Live updates paused")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "New responses could not be loaded automatically (offline). Use Refresh to load new responses.",
  );
  expect(screen.getByText(/^Updated /)).toBeInTheDocument();

  expect(
    render(<LiveSyncStatus live={null} />).container,
  ).toBeEmptyDOMElement();
});

test("organizer header keeps live sync on with nothing to switch it off", () => {
  render(
    <OrganizerHeader
      event={baseEvent}
      onRefresh={jest.fn()}
      live={{ error: "", updatedAt: null }}
    />,
  );
  expect(screen.getByText("Live")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "New responses load automatically.",
  );
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByText("Auto-refresh off")).not.toBeInTheDocument();
});

test("managed schedule drawer is a labelled modal dialog that traps focus and closes on Escape", async () => {
  const { props } = renderDrawer();

  const dialog = screen.getByRole("dialog", {
    name: "Edit Temporary Taylor's schedule",
  });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByText("Temporary participant")).toBeInTheDocument();
  expect(document.body.style.overflow).toBe("hidden");

  const closeButton = within(dialog).getByRole("button", {
    name: "Close schedule editor",
  });
  expect(closeButton).toHaveFocus();

  expect(
    screen.getByRole("textbox", { name: "Event display name" }),
  ).toHaveAccessibleDescription(
    "You and this participant edit the same response. A version conflict will never be silently overwritten.",
  );
  expect(screen.getByText("Mark times as")).toBeInTheDocument();
  const choices = screen.getByRole("group", { name: "Availability status" });
  expect(
    within(choices).getByRole("button", { name: "Available" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(within(choices).getByRole("button", { name: "Busy" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await userEvent.click(within(choices).getByRole("button", { name: "Busy" }));
  expect(props.onAvailabilityValueChange).toHaveBeenCalledWith(0);

  await userEvent.click(
    within(dialog).getByRole("button", { name: "Submit on behalf" }),
  );
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Save draft" }),
  );
  expect(props.onSaveDraft).toHaveBeenCalledTimes(1);

  // Shift+Tab from the first focusable control wraps to the last one.
  closeButton.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(
    within(dialog).getByRole("button", { name: "Submit on behalf" }),
  ).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test("managed schedule drawer explains who can edit each kind of participant", () => {
  const { rerender } = renderDrawer({
    participant: {
      id: "roster-2",
      name: "Full Fiona",
      accountAccess: "full",
      canOrganizerEditAvailability: true,
    },
  });
  expect(
    screen.getByText("Full account · not responded yet"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Event display name" }),
  ).toHaveAccessibleDescription(
    "You can enter this schedule until they join, save, or submit it themselves; after that only they can change it. A version conflict will never be silently overwritten.",
  );

  // Organizer-managed people are always shared, whatever their account.
  rerender(
    <ManagedScheduleDrawer
      {...renderDrawerProps({
        participant: {
          id: "roster-3",
          name: "Managed Morgan",
          accountAccess: "full",
          organizerManaged: true,
        },
      })}
    />,
  );
  expect(screen.getByText("Organizer-managed participant")).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Event display name" }),
  ).toHaveAccessibleDescription(
    "You and this participant edit the same response. A version conflict will never be silently overwritten.",
  );
});

test("managed schedule drawer locks editing while saving, closed, or conflicted", () => {
  const { rerender } = renderDrawer({ participantName: "   " });
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Submit on behalf" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

  rerender(
    <ManagedScheduleDrawer {...renderDrawerProps({ responsesOpen: false })} />,
  );
  expect(screen.getByRole("note")).toHaveTextContent(
    "Availability can only be edited while this event is active.",
  );
  expect(
    screen.getByRole("textbox", { name: "Event display name" }),
  ).toBeDisabled();
  expect(
    within(
      screen.getByRole("group", { name: "Availability status" }),
    ).getByRole("button", { name: "Busy" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

  rerender(
    <ManagedScheduleDrawer
      {...renderDrawerProps({
        saving: true,
        status: "Draft saved.",
      })}
    />,
  );
  const savingButtons = screen.getAllByRole("button", { name: "Saving..." });
  expect(savingButtons).toHaveLength(2);
  savingButtons.forEach((button) => expect(button).toBeDisabled());
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Close schedule editor",
    }),
  ).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Draft saved.");

  const onReloadLatest = jest.fn();
  rerender(
    <ManagedScheduleDrawer
      {...renderDrawerProps({
        error: "This response changed after you opened it.",
        conflictParticipant: { id: "roster-1", version: 2 },
        onReloadLatest,
      })}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This response changed after you opened it.",
  );
  expect(
    screen.getByRole("button", { name: "Submit on behalf" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload latest response" }),
  );
  expect(onReloadLatest).toHaveBeenCalledTimes(1);
});

test("overview keeps key summaries and its edit button visible while details are collapsed", () => {
  render(<OverviewPanel event={baseEvent} onEventSaved={jest.fn()} />);

  const heading = screen.getByRole("heading", {
    level: 3,
    name: "Overview",
  });
  expect(heading).toHaveAttribute("id", "organizer-overview-heading");
  expect(
    screen.getByText("Review the event schedule and response settings."),
  ).toBeInTheDocument();
  expect(screen.getByText("Schedule")).toBeInTheDocument();
  expect(screen.getByText("Meeting")).toBeInTheDocument();
  expect(screen.getByText("Responses")).toBeInTheDocument();
  expect(screen.getByText(/Mon, Wed/)).toBeInTheDocument();
  expect(screen.getByText(/Mixed/)).toBeInTheDocument();
  expect(screen.getByText(/Invite only/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit event" })).toBeEnabled();
  expect(
    screen.queryByRole("link", { name: "Edit event" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Show all details" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Availability interval")).not.toBeInTheDocument();
  expect(screen.queryByText("Event code")).not.toBeInTheDocument();
  expect(screen.queryByText("Result revision")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Event controls" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Queue reminders" }),
  ).not.toBeInTheDocument();
  // Blocked times moved to the Time Table.
  expect(
    screen.queryByRole("heading", { name: "Blocked times" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("grid", { name: "Blocked times" }),
  ).not.toBeInTheDocument();
});

test("overview reveals and hides the complete detail group without moving its edit action", async () => {
  render(<OverviewPanel event={baseEvent} onEventSaved={jest.fn()} />);

  await userEvent.click(
    screen.getByRole("button", { name: "Show all details" }),
  );

  expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByText("Availability interval")).toBeInTheDocument();
  expect(screen.getByText("Event code")).toBeInTheDocument();
  expect(screen.getByText("Status")).toBeInTheDocument();
  expect(screen.getByText("Result revision")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit event" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expect(
    screen.getByRole("button", { name: "Show all details" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Availability interval")).not.toBeInTheDocument();
});

test("overview opens and cancels inline editing without hiding its summary", async () => {
  const onEventSaved = jest.fn();
  render(<OverviewPanel event={baseEvent} onEventSaved={onEventSaved} />);

  await userEvent.click(screen.getByRole("button", { name: "Edit event" }));

  expect(
    screen.getByRole("heading", { name: "Edit event" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.getByText("Schedule")).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Edit event" }),
  ).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(
    screen.queryByRole("heading", { name: "Edit event" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit event" })).toBeEnabled();
  expect(screen.getByText("Schedule")).toBeInTheDocument();
  expect(onEventSaved).not.toHaveBeenCalled();
});

test("overview reports the complete inline save result and closes the form", async () => {
  const onEventSaved = jest.fn();
  const updatedEvent = {
    ...baseEvent,
    name: "Updated scale event",
    version: 5,
  };
  const result = { event: updatedEvent, responsesReset: 0 };
  render(<OverviewPanel event={baseEvent} onEventSaved={onEventSaved} />);

  await userEvent.click(screen.getByRole("button", { name: "Edit event" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(onEventSaved).toHaveBeenCalledWith(result);
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Edit event" }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Event changes saved.",
  );
  expect(screen.getByRole("button", { name: "Edit event" })).toBeEnabled();
});

test("overview keeps a confirmed meeting summary visible while details are collapsed", () => {
  render(
    <OverviewPanel
      event={{
        ...baseEvent,
        status: "closed",
        finalMeeting: {
          id: "final-1",
          startsAt: "2026-09-01T09:00:00Z",
          endsAt: "2026-09-01T10:00:00Z",
          channel: "mixed",
          location: "Room 4",
        },
      }}
    />,
  );

  expect(screen.getByText("Confirmed meeting")).toBeInTheDocument();
  expect(screen.queryByText("Availability interval")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit event" })).toBeDisabled();
});

test.each([
  ["a finalized event", { status: "finalized" }],
  ["an archived event", { status: "archived" }],
  ["an event with a confirmed meeting", { finalMeeting: { id: "final-1" } }],
])("overview disables editing for %s", (_label, eventOverrides) => {
  render(<OverviewPanel event={{ ...baseEvent, ...eventOverrides }} />);

  expect(screen.getByRole("button", { name: "Edit event" })).toBeDisabled();
});

test("event controls queue reminders and close an active event", async () => {
  const setEvent = jest.fn();
  const setDeliveryRequest = jest.fn();
  sendReminders.mockResolvedValue({
    deliveryRequestId: "reminder-1",
    recipientCount: 12,
    delivery: { total: 12, pending: 12 },
  });
  updateEventLifecycle.mockResolvedValue({
    event: { ...baseEvent, status: "closed", version: 5 },
  });
  render(
    <EventControls
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={setDeliveryRequest}
    />,
  );

  const controls = screen.getByRole("region", { name: "Event controls" });
  expect(
    within(controls).getByRole("heading", {
      level: 3,
      name: "Event controls",
    }),
  ).toHaveAttribute("id", "organizer-lifecycle-title");
  expect(within(controls).getByText("active")).toBeInTheDocument();
  expect(
    within(controls).getByRole("button", { name: "Archive event" }),
  ).toBeInTheDocument();

  await userEvent.click(
    within(controls).getByRole("button", { name: "Queue reminders" }),
  );
  await waitFor(() =>
    expect(setDeliveryRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reminder-1", operation: "reminder" }),
    ),
  );
  expect(
    within(controls).getByText("12 reminder emails were queued."),
  ).toBeInTheDocument();
  await userEvent.click(
    within(controls).getByRole("button", { name: "Close responses" }),
  );
  await waitFor(() =>
    expect(updateEventLifecycle).toHaveBeenCalledWith(
      baseEvent.code,
      expect.objectContaining({ status: "closed", expectedVersion: 4 }),
      "token",
    ),
  );
  expect(setEvent).toHaveBeenCalledWith(
    expect.objectContaining({ status: "closed" }),
  );
});

test("event controls reopen a finalized event, clear an expired deadline, and track cancellation", async () => {
  const setEvent = jest.fn();
  const setDeliveryRequest = jest.fn();
  updateEventLifecycle.mockResolvedValue({
    event: { ...baseEvent, status: "active", version: 5 },
    cancellationDeliveryRequestId: "cancel-1",
    cancellationEnqueued: 9,
  });
  // Rendered without onReactivated: reopening must not require the callback.
  render(
    <EventControls
      event={{
        ...baseEvent,
        status: "finalized",
        responseDeadline: "2020-01-01T00:00:00Z",
      }}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={setDeliveryRequest}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Reactivate event" }),
  );
  await waitFor(() =>
    expect(updateEventLifecycle).toHaveBeenCalledWith(
      baseEvent.code,
      expect.objectContaining({ status: "active", responseDeadline: null }),
      "token",
    ),
  );
  expect(setDeliveryRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "cancel-1",
      operation: "final_cancellation",
      delivery: { total: 9, pending: 9 },
    }),
  );
});

test("event controls surface lifecycle errors", async () => {
  const setEvent = jest.fn();
  updateEventLifecycle.mockRejectedValueOnce(new Error("cannot archive"));
  render(
    <EventControls
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={jest.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Archive event" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot archive");
});

const LIFECYCLE_SUMMARIES = {
  active: "This event is active and accepting responses.",
  closed: "Responses are now closed.",
  finalized:
    "The meeting is finalized. Reactivate the event to collect new responses.",
  archived: "This event is archived.",
};

// Holds the event like the workspace does so lifecycle changes re-render.
function StatefulEventControls({ initialEvent, ...props }) {
  const [event, setEvent] = useState(initialEvent);
  return <EventControls event={event} setEvent={setEvent} {...props} />;
}

test.each(Object.entries(LIFECYCLE_SUMMARIES))(
  "event controls summarize a %s event from first paint",
  (status, summary) => {
    render(
      <EventControls
        event={{ ...baseEvent, status }}
        setEvent={jest.fn()}
        getToken={getToken}
        setDeliveryRequest={jest.fn()}
      />,
    );

    const controls = screen.getByRole("region", { name: "Event controls" });
    const lifecycle = within(controls).getByText(summary);
    expect(lifecycle).toHaveAttribute("role", "status");
    expect(lifecycle).toHaveClass("organizer-event-controls__lifecycle");
    expect(within(controls).getAllByRole("status")).toEqual([lifecycle]);
  },
);

test.each([
  ["an unknown", "draft"],
  ["a missing", undefined],
])(
  "event controls show no lifecycle summary for %s status",
  (_label, status) => {
    render(
      <EventControls
        event={{ ...baseEvent, status }}
        setEvent={jest.fn()}
        getToken={getToken}
        setDeliveryRequest={jest.fn()}
      />,
    );

    const controls = screen.getByRole("region", { name: "Event controls" });
    expect(
      controls.querySelector(".organizer-event-controls__lifecycle"),
    ).toBeNull();
    expect(within(controls).queryByRole("status")).not.toBeInTheDocument();
  },
);

test("reactivating swaps the lifecycle summary and states the active sentence once", async () => {
  const onReactivated = jest.fn();
  updateEventLifecycle.mockResolvedValueOnce({
    event: { ...baseEvent, status: "active", version: 6 },
  });
  render(
    <StatefulEventControls
      initialEvent={{ ...baseEvent, status: "closed", version: 5 }}
      getToken={getToken}
      setDeliveryRequest={jest.fn()}
      onReactivated={onReactivated}
    />,
  );

  const controls = screen.getByRole("region", { name: "Event controls" });
  expect(
    within(controls).getByText("Responses are now closed."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("This event is active and accepting responses."),
  ).not.toBeInTheDocument();

  await userEvent.click(
    within(controls).getByRole("button", { name: "Reactivate event" }),
  );

  expect(
    await within(controls).findByText(
      "This event is active and accepting responses.",
    ),
  ).toBeInTheDocument();
  // The summary is the only place the sentence appears: no toast repeats it.
  expect(
    screen.getAllByText("This event is active and accepting responses."),
  ).toHaveLength(1);
  expect(within(controls).getAllByRole("status")).toHaveLength(1);
  expect(
    screen.queryByText("Responses are now closed."),
  ).not.toBeInTheDocument();
  expect(
    within(controls).getByRole("button", { name: "Close responses" }),
  ).toBeInTheDocument();
  expect(onReactivated).toHaveBeenCalledTimes(1);
});

test("event controls report a reactivation once the reopened event is stored", async () => {
  const setEvent = jest.fn();
  const onReactivated = jest.fn();
  updateEventLifecycle.mockResolvedValueOnce({
    event: { ...baseEvent, status: "active", version: 5 },
  });
  render(
    <EventControls
      event={{ ...baseEvent, status: "finalized" }}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={jest.fn()}
      onReactivated={onReactivated}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Reactivate event" }),
  );

  await waitFor(() => expect(onReactivated).toHaveBeenCalledTimes(1));
  expect(setEvent).toHaveBeenCalledTimes(1);
  expect(setEvent.mock.invocationCallOrder[0]).toBeLessThan(
    onReactivated.mock.invocationCallOrder[0],
  );
});

test("closing responses does not report a reactivation", async () => {
  const setEvent = jest.fn();
  const onReactivated = jest.fn();
  updateEventLifecycle.mockResolvedValueOnce({
    event: { ...baseEvent, status: "closed", version: 5 },
  });
  render(
    <EventControls
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={jest.fn()}
      onReactivated={onReactivated}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Close responses" }),
  );

  await waitFor(() =>
    expect(setEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed" }),
    ),
  );
  expect(onReactivated).not.toHaveBeenCalled();
});

test("a rejected reactivation shows the error and reports nothing", async () => {
  const setEvent = jest.fn();
  const onReactivated = jest.fn();
  updateEventLifecycle.mockRejectedValueOnce(new Error("cannot reactivate"));
  render(
    <EventControls
      event={{ ...baseEvent, status: "closed" }}
      setEvent={setEvent}
      getToken={getToken}
      setDeliveryRequest={jest.fn()}
      onReactivated={onReactivated}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Reactivate event" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "cannot reactivate",
  );
  expect(setEvent).not.toHaveBeenCalled();
  expect(onReactivated).not.toHaveBeenCalled();
  // The summary still describes the unchanged event.
  expect(screen.getByText("Responses are now closed.")).toBeInTheDocument();
});

test("results support the legacy envelope and failed or empty snapshots", async () => {
  fetchEventResults
    .mockResolvedValueOnce({
      results: {
        revision: 5,
        generatedAt: "2026-09-01T08:00:00Z",
        recommendations: [
          {
            id: "legacy-1",
            channel: "virtual",
            startsAt: "2026-09-01T09:00:00Z",
            endsAt: "2026-09-01T10:00:00Z",
            weightedScore: 0.8,
            unweightedScore: 0.7,
          },
        ],
      },
    })
    .mockResolvedValueOnce({
      status: "failed",
      requestedRevision: 6,
      computedRevision: 5,
      results: { recommendations: [] },
    });
  const onChoose = jest.fn();
  const { rerender } = render(
    <ResultsSnapshotPanel
      event={baseEvent}
      getToken={getToken}
      invalidationKey={0}
      onChoose={onChoose}
    />,
  );
  expect(
    await screen.findByText(/Results are current at revision 5/),
  ).toBeInTheDocument();
  // baseEvent has no slotGroups: the calendar falls back to its empty state
  // while the ranked list still lists the legacy recommendation.
  expect(
    screen.getByText("No schedule slots are configured."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("grid", { name: /Meeting time calendar/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 5, name: "Recommended times" }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: /choose this time/i }),
  );
  expect(onChoose).toHaveBeenCalledWith(
    expect.objectContaining({ id: "legacy-1" }),
  );

  rerender(
    <ResultsSnapshotPanel
      event={baseEvent}
      getToken={getToken}
      invalidationKey={1}
      onChoose={onChoose}
    />,
  );
  expect(
    await screen.findByText(/Result calculation failed/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("No valid meeting window is available yet."),
  ).toBeInTheDocument();
});

test("results expose request failures", async () => {
  fetchEventResults.mockRejectedValueOnce(new Error("snapshot unavailable"));
  render(
    <ResultsSnapshotPanel
      event={baseEvent}
      getToken={getToken}
      invalidationKey={0}
      onChoose={jest.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "snapshot unavailable",
  );
});

test("finalize handles nested attendance, delivery progress, and confirmation errors", async () => {
  previewFinalMeeting.mockResolvedValueOnce({
    finalMeeting: { attendance: { availableParticipantTotal: 4 } },
  });
  confirmFinalMeeting.mockResolvedValueOnce({
    event: { ...baseEvent, status: "finalized" },
    deliveryRequestId: "final-1",
    delivery: { recipientTotal: 4, pending: 4 },
  });
  const setEvent = jest.fn();
  const onDeliveryRequest = jest.fn();
  render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      selection={recommendation}
      onDeliveryRequest={onDeliveryRequest}
    />,
  );
  fireEvent.change(screen.getByLabelText("Location or meeting link"), {
    target: { value: "https://meet.example/scale" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Review attendance" }),
  );
  expect(await screen.findByText("4")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Finalize meeting" }),
  );
  await waitFor(() => expect(setEvent).toHaveBeenCalled());
  // Delivery progress is handed to the workspace banner, not drawn here.
  expect(onDeliveryRequest).toHaveBeenCalledWith({
    id: "final-1",
    operation: "final_confirmation",
    delivery: { recipientTotal: 4, pending: 4 },
  });
  expect(
    screen.queryByLabelText("Finalization delivery progress"),
  ).not.toBeInTheDocument();

  confirmFinalMeeting.mockRejectedValueOnce(new Error("confirmation failed"));
  await userEvent.click(
    screen.getByRole("button", { name: "Finalize meeting" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "confirmation failed",
  );
});

test("finalized organizers can download ICS and see download errors", async () => {
  const createObjectURL = jest.fn().mockReturnValue("blob:calendar");
  const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  downloadFinalCalendar.mockResolvedValueOnce({
    blob: new Blob(["BEGIN:VCALENDAR"]),
    filename: "scale.ics",
  });
  const finalized = {
    ...baseEvent,
    status: "finalized",
    finalMeeting: {
      ...recommendation,
      channel: "virtual",
      location: "",
      active: true,
    },
  };
  const { rerender } = render(
    <FinalizeScalePanel
      event={finalized}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Download calendar (.ics)" }),
  );
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  expect(click).toHaveBeenCalled();

  downloadFinalCalendar.mockRejectedValueOnce(new Error("download failed"));
  rerender(
    <FinalizeScalePanel
      event={{ ...finalized, status: "archived" }}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Download calendar (.ics)" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("download failed");
  click.mockRestore();
});

test("finalize empty and inactive states point at the calendar and block review", async () => {
  const headingRef = createRef();
  const { rerender } = render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
      headingRef={headingRef}
    />,
  );
  const block = document.getElementById("organizer-finalize");
  expect(block).toHaveAccessibleName("Finalize");
  expect(headingRef.current).toBe(
    screen.getByRole("heading", { level: 4, name: "Finalize" }),
  );
  expect(block).toHaveTextContent("No time selected yet");
  // Nothing is recommended here, so the empty state points at the calendar
  // only.
  expect(block).toHaveTextContent("Pick a time on the calendar.");
  expect(block).not.toHaveTextContent("recommended times above");
  expect(within(block).queryAllByRole("button")).toHaveLength(0);

  rerender(
    <FinalizeScalePanel
      event={{ ...baseEvent, status: "archived" }}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={recommendation}
      headingRef={headingRef}
    />,
  );
  expect(screen.getByRole("note")).toHaveTextContent("Reactivate this event");
  expect(
    screen.getByRole("button", { name: "Review attendance" }),
  ).toBeDisabled();
});

const calendarSelection = {
  channel: "inperson",
  startsAt: "2026-09-01T09:00:00Z",
  endsAt: "2026-09-01T10:00:00Z",
  slotIndices: [0, 1],
  groupKey: "date:2026-09-01",
  label: "2026-09-01 09:00–10:00",
  dateLabel: "",
  source: "calendar",
  recommendation: null,
  rescheduled: false,
  metrics: { exact: false, weighted: 0.75, unweighted: 0.7 },
};

function renderFinalize(selection) {
  return render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={selection}
    />,
  );
}

test("finalize describes a custom calendar window with its estimated availability", async () => {
  previewFinalMeeting.mockResolvedValueOnce({
    attendance: { availableParticipantTotal: 3 },
  });
  renderFinalize(calendarSelection);

  expect(screen.getByText("2026-09-01 09:00–10:00")).toBeInTheDocument();
  expect(screen.getByText("Custom window")).toBeInTheDocument();
  expect(screen.queryByText(/Recommended #/)).not.toBeInTheDocument();
  expect(screen.getByText("In person")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Up to 75% weighted · 70% unweighted across this window (its lowest slot; people must be free for all of it). Exact attendance counts appear after Review attendance.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      "The suggested date has passed; this uses the next occurrence.",
    ),
  ).not.toBeInTheDocument();
  // The step's summary names the time too; the candidate spells it out.
  const candidate = within(document.querySelector(".final-candidate"));
  expect(candidate.getByText(/9:00 AM/)).toBeInTheDocument();
  expect(candidate.getByText(/\(UTC\)/)).toBeInTheDocument();
  expect(
    document.querySelector("#organizer-finalize > summary"),
  ).toHaveTextContent(/Selected · .*9:00 AM/);

  // The calendar window's instants are sent verbatim.
  await userEvent.click(
    screen.getByRole("button", { name: "Review attendance" }),
  );
  await waitFor(() =>
    expect(previewFinalMeeting).toHaveBeenCalledWith(
      baseEvent.code,
      {
        startsAt: "2026-09-01T09:00:00Z",
        endsAt: "2026-09-01T10:00:00Z",
        channel: "inperson",
        location: "Room 4",
      },
      "token",
    ),
  );
  expect(await screen.findByText("3")).toBeInTheDocument();
  // A count-only payload draws the tiles without a per-person table.
  expect(screen.queryByRole("table")).toBeNull();
});

test("finalize lists attendance by person behind the count tiles", async () => {
  previewFinalMeeting.mockResolvedValueOnce({
    attendance: {
      availableParticipantTotal: 1,
      partialParticipantTotal: 1,
      unavailableParticipantTotal: 1,
      unansweredParticipantTotal: 1,
      excludedParticipantTotal: 4,
      participants: [
        {
          participantId: "p-1",
          name: "Ada Always",
          status: "available",
          minimumAvailability: 1,
        },
        {
          participantId: "p-2",
          name: "Pat Partly",
          status: "partial",
          minimumAvailability: 0.5,
        },
        {
          participantId: "p-3",
          name: "Uma Unable",
          status: "unavailable",
          minimumAvailability: 0,
        },
      ],
      unansweredParticipants: [{ participantId: "p-4", name: "Nina Noreply" }],
      excludedParticipants: [
        { participantId: "p-5", name: "Hank Hidden", reason: "hidden" },
        {
          participantId: "p-6",
          name: "Olive Omitted",
          reason: "organizerExcluded",
        },
        {
          participantId: "p-7",
          name: "Ivan Invalid",
          reason: "invalidResponse",
        },
        { participantId: "p-8", name: "Rex Reasonless", reason: "mystery" },
      ],
    },
  });
  renderFinalize(calendarSelection);

  await userEvent.click(
    screen.getByRole("button", { name: "Review attendance" }),
  );

  const region = await screen.findByRole("region", {
    name: "Attendance by person",
  });
  expect(region).toHaveAttribute("tabindex", "0");
  const table = within(region).getByRole("table", {
    name: "Attendance by person",
  });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Person", "Response", "Availability"]);
  expect(
    within(table)
      .getAllByRole("rowheader")
      .map((header) => [
        header.textContent,
        ...within(header.closest("tr"))
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ]),
  ).toEqual([
    ["Ada Always", "Submitted", "Fully available · 100%"],
    ["Pat Partly", "Submitted", "Partly available · 50%"],
    ["Uma Unable", "Submitted", "Not available · 0%"],
    ["Nina Noreply", "Not submitted", "—"],
    ["Hank Hidden", "Not included", "Hidden from results"],
    ["Olive Omitted", "Not included", "Excluded by organizer"],
    ["Ivan Invalid", "Not included", "Invalid response"],
    ["Rex Reasonless", "Not included", "mystery"],
  ]);
  // The count tile stays the only element whose whole text is "Available".
  expect(screen.getAllByText("Available", { exact: true })).toHaveLength(1);
  expect(
    within(screen.getByRole("group", { name: "Attendance review" })).getByText(
      "4",
    ),
  ).toBeInTheDocument();
});

test("finalize shows exact ranked metrics and the rescheduled note", () => {
  renderFinalize({
    ...calendarSelection,
    rescheduled: true,
    metrics: {
      exact: true,
      weighted: 0.75,
      unweighted: 0.7,
      rank: 2,
      fullyAvailableParticipantTotal: 5,
    },
  });

  expect(screen.getByText("Recommended #2")).toBeInTheDocument();
  expect(screen.queryByText("Custom window")).not.toBeInTheDocument();
  expect(
    screen.getByText("75% weighted · 70% unweighted · 5 fully available"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "The suggested date has passed; this uses the next occurrence.",
    ),
  ).toBeInTheDocument();
});

test("finalize explains when a window has no counted responses", () => {
  renderFinalize({
    ...calendarSelection,
    metrics: { exact: false, weighted: null, unweighted: null },
  });

  expect(
    screen.getByText("No responses have been counted yet."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
  expect(screen.queryByText(/weighted/)).not.toBeInTheDocument();
  expect(screen.getByText("Custom window")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Review attendance" }),
  ).toBeEnabled();
});

// Weekly Mon/Wed 09:00–11:00 in half-hour slots (the API shape).
const weeklyEvent = {
  ...baseEvent,
  mode: "inperson",
  slotGroups: [1, 3].map((weekday, groupIndex) => ({
    key: `weekday:${weekday}`,
    label: weekday === 1 ? "Mon" : "Wed",
    weekday,
    slots: ["09:00", "09:30", "10:00", "10:30"].map((localStart, offset) => ({
      index: groupIndex * 4 + offset,
      localStart,
      localEnd: ["09:30", "10:00", "10:30", "11:00"][offset],
      startDayOffset: 0,
      endDayOffset: 0,
    })),
  })),
};

test("choosing a stale ranked window reveals its next occurrence and keeps it marked as selected", async () => {
  // Suggested long ago: the snapshot outlived its suggested Monday.
  const stale = {
    rank: 1,
    channel: "inperson",
    slotIndices: [0, 1],
    groupKey: "weekday:1",
    weekday: 1,
    localStart: "09:00",
    localEnd: "10:00",
    startDayOffset: 0,
    endDayOffset: 0,
    suggestedStartsAt: "2020-01-06T09:00:00Z",
    suggestedEndsAt: "2020-01-06T10:00:00Z",
    label: "Mon 09:00–10:00",
    weightedAvailability: 0.8,
    unweightedAvailability: 0.7,
    fullyAvailableParticipantTotal: 5,
  };
  fetchEventResults.mockResolvedValue({
    results: {
      revision: 7,
      generatedAt: "2020-01-05T00:00:00Z",
      countedResponseTotal: 5,
      channels: {
        inperson: {
          weighted: [0.8, 0.8, 0.5, 0.4, 0.3, 0.2, 0.1, 0.1],
          unweighted: [0.7, 0.7, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1],
        },
      },
      recommendations: [stale],
    },
  });
  const onChoose = jest.fn();
  const panelProps = {
    event: weeklyEvent,
    getToken,
    invalidationKey: 0,
    onChoose,
    onSelect: jest.fn(),
  };
  const { rerender } = render(
    <ResultsSnapshotPanel {...panelProps} selection={null} />,
  );
  const choose = await screen.findByRole("button", {
    name: /choose this time/i,
  });
  expect(choose).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(choose);
  expect(onChoose).toHaveBeenCalledWith(stale);

  // The workspace turns the raw recommendation into a selection; the same
  // call here yields the next Monday 09:00, never the 2020 instant.
  const selection = selectionFromRecommendation(stale, weeklyEvent, {
    now: Date.now(),
  });
  expect(selection.rescheduled).toBe(true);
  expect(Date.parse(selection.startsAt)).toBeGreaterThanOrEqual(
    Date.now() - 60_000,
  );
  expect(Date.parse(selection.startsAt) - Date.now()).toBeLessThanOrEqual(
    8 * 24 * 60 * 60 * 1000,
  );
  // The calendar moved to that occurrence's week, not to January 2020.
  const week = weekStartOf(localDateOf(selection.startsAt, "UTC"));
  expect(
    screen.getByRole("grid", { name: /^Meeting time calendar/ }),
  ).toHaveAccessibleName(`Meeting time calendar, ${formatWeekLabel(week)}`);

  rerender(<ResultsSnapshotPanel {...panelProps} selection={selection} />);
  expect(
    screen.getByRole("button", { name: /selected time/i }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    document.querySelector(".meeting-calendar__block--selected"),
  ).not.toBeNull();
  expect(document.querySelector('[data-cell-idx="0"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("event controls report reminder failures and legacy delivery summaries", async () => {
  sendReminders
    .mockRejectedValueOnce(new Error("Reminder service unavailable"))
    .mockResolvedValueOnce({
      deliveryRequest: {
        id: "reminder-2",
        recipientCount: 3,
        summary: { total: 3, pending: 3 },
      },
    });
  const setDeliveryRequest = jest.fn();
  render(
    <EventControls
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      setDeliveryRequest={setDeliveryRequest}
    />,
  );
  const controls = screen.getByRole("region", { name: "Event controls" });
  await userEvent.click(
    within(controls).getByRole("button", { name: "Queue reminders" }),
  );
  expect(await within(controls).findByRole("alert")).toHaveTextContent(
    "Reminder service unavailable",
  );
  await userEvent.click(
    within(controls).getByRole("button", { name: "Queue reminders" }),
  );
  await waitFor(() =>
    expect(
      within(controls).getByText("3 reminder emails were queued."),
    ).toBeInTheDocument(),
  );
  expect(setDeliveryRequest).toHaveBeenCalledWith(
    expect.objectContaining({ id: "reminder-2" }),
  );
});

test("finalize lists partial and unavailable counts and reports review failures", async () => {
  previewFinalMeeting.mockRejectedValueOnce(new Error(""));
  renderFinalize({
    ...calendarSelection,
    metrics: {
      exact: true,
      weighted: 0.6,
      unweighted: 0.5,
      rank: 3,
      fullyAvailableParticipantTotal: 4,
      partiallyAvailableParticipantTotal: 2,
      unavailableParticipantTotal: 1,
    },
  });
  expect(
    screen.getByText(
      "60% weighted · 50% unweighted · 4 fully available · 2 partially available · 1 unavailable",
    ),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Review attendance" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to review this meeting time.",
  );
});

test("results refresh through the workspace handle and show a finalized event's time zone fallback", async () => {
  fetchEventResults.mockResolvedValue({
    results: {
      status: "ready",
      recommendations: [recommendation],
      revision: 2,
      generatedAt: "2026-08-19T12:00:00Z",
    },
    revision: 2,
  });
  const panel = createRef();
  render(
    <ResultsSnapshotPanel
      ref={panel}
      event={{ ...baseEvent, timezone: "Not/AZone" }}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  await waitFor(() => expect(fetchEventResults).toHaveBeenCalledTimes(1));
  // The ranked window still renders its times through the browser zone.
  expect(
    await screen.findByRole("button", { name: /choose this time/i }),
  ).toBeInTheDocument();
  expect(document.querySelector(".ranked-chips__detail")).toHaveTextContent(
    /\d{1,2}\/\d{1,2}\/2026.* – .*2026/,
  );
  // No refresh button of its own: the workspace header drives refreshes.
  expect(
    screen.queryByRole("button", { name: /refresh/i }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await panel.current.refresh("token");
  });
  expect(fetchEventResults).toHaveBeenCalledTimes(2);
});

test("results hand the workspace their freshness and reload silently for it", async () => {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 7,
    computedRevision: 7,
    generatedAt: "2026-08-19T12:00:00Z",
    results: { recommendations: [] },
  });
  const panel = createRef();
  render(
    <ResultsSnapshotPanel
      ref={panel}
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  // Nothing to compare against before the first load lands.
  expect(panel.current.activity()).toBeNull();
  await screen.findByText(/Results are current at revision 7/);
  expect(panel.current.activity()).toEqual({
    status: "fresh",
    requestedRevision: 7,
    computedRevision: 7,
    generatedAt: "2026-08-19T12:00:00Z",
  });
  // Named once in the collapsed summary and once in the empty state.
  expect(screen.getAllByText("No recommendation yet")).toHaveLength(2);

  // A silent reload never flips the empty state into "calculating" while it
  // is in flight; it just swaps the snapshot in when it lands.
  let release;
  fetchEventResults.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let silent;
  act(() => {
    silent = panel.current.refresh("token", { silent: true });
  });
  expect(screen.getAllByText("No recommendation yet")).toHaveLength(2);
  expect(
    screen.queryByText("Calculating recommendations"),
  ).not.toBeInTheDocument();
  await act(async () => {
    release({
      status: "refreshing",
      requestedRevision: 8,
      computedRevision: 7,
      generatedAt: "2026-08-19T12:00:00Z",
      results: { recommendations: [] },
    });
    await silent;
  });
  expect(
    screen.getByText(/Results are updating for revision 8/),
  ).toBeInTheDocument();
  expect(panel.current.activity()).toEqual({
    status: "refreshing",
    requestedRevision: 8,
    computedRevision: 7,
    generatedAt: "2026-08-19T12:00:00Z",
  });

  // A silent failure is reported to the caller, not shown in the panel, and
  // the snapshot on screen is kept.
  fetchEventResults.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await expect(
      panel.current.refresh("token", { silent: true }),
    ).rejects.toThrow("offline");
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Results are updating for revision 8/),
  ).toBeInTheDocument();

  // A legacy envelope without freshness fields reports nulls for them.
  fetchEventResults.mockResolvedValueOnce({ results: { recommendations: [] } });
  await act(async () => {
    await panel.current.refresh("token", { silent: true });
  });
  expect(panel.current.activity()).toEqual({
    status: "fresh",
    requestedRevision: null,
    computedRevision: null,
    generatedAt: null,
  });
});

test("the ranked list is collapsed by default and summarizes the best window", async () => {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 2,
    computedRevision: 2,
    results: {
      recommendations: [
        { ...recommendation, rank: 1, label: "Tue 09:00–10:00" },
        {
          ...recommendation,
          rank: 2,
          label: "Wed 09:00–10:00",
          startsAt: "2026-09-02T09:00:00Z",
          endsAt: "2026-09-02T10:00:00Z",
        },
      ],
    },
  });
  render(
    <ResultsSnapshotPanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  // The list is a named, collapsed disclosure inside the (collapsed)
  // Finalize step, not a landmark and not a step of its own.
  const rail = document.querySelector("details.organizer-recommended-times");
  const finalize = document.getElementById("organizer-finalize");
  expect(finalize).toContainElement(rail);
  expect(rail).toHaveAttribute("id", "organizer-recommended-times");
  expect(rail).toHaveAttribute(
    "aria-labelledby",
    "organizer-recommended-times-heading",
  );
  expect(
    within(rail.querySelector("summary")).getByRole("heading", {
      level: 5,
      name: "Recommended times",
    }),
  ).toHaveAttribute("id", "organizer-recommended-times-heading");
  expect(
    screen.queryByRole("complementary", { name: "Recommended times" }),
  ).not.toBeInTheDocument();
  expect(rail).not.toHaveAttribute("open");
  expect(finalize).not.toHaveAttribute("open");
  await waitFor(() =>
    expect(rail).toHaveTextContent("2 recommended · best Tue 09:00–10:00"),
  );
  // Finalize's own summary says there is something to choose from.
  expect(finalize.querySelector(":scope > summary")).toHaveTextContent(
    "No time selected yet · 2 recommended",
  );
  // Buttons exist for tests and assistive tech, but are hidden until opened.
  expect(
    within(rail).getAllByRole("button", { name: /choose this time/i }),
  ).toHaveLength(2);
  expect(
    within(rail).getAllByRole("button", { name: /choose this time/i })[0],
  ).not.toBeVisible();
  await toggleRecommendedTimes();
  expect(finalize).toHaveAttribute("open");
  expect(rail).toHaveAttribute("open");
  expect(
    within(rail).getAllByRole("button", { name: /choose this time/i })[0],
  ).toBeVisible();
  // The list comes right after the step's description, then Other times,
  // then the step's content.
  expect(rail.previousElementSibling).toHaveClass(
    "finalize-block__description",
  );
  expect(rail.nextElementSibling).toHaveAttribute(
    "id",
    "organizer-other-times",
  );
  expect(rail.nextElementSibling.nextElementSibling).toHaveClass(
    "finalize-block__body",
  );
  expect(finalize).toHaveTextContent("No time selected yet");
  // This event has no slots at all, so the prompt says why nothing can be
  // picked rather than pointing at the pickers.
  expect(finalize).toHaveTextContent(
    "No upcoming time can start. Edit the event's schedule or unblock times to add one.",
  );

  // Closing Finalize closes the list with it, so reopening Finalize shows
  // the list collapsed again.
  await userEvent.click(finalize.querySelector(":scope > summary"));
  expect(finalize).not.toHaveAttribute("open");
  await waitFor(() => expect(rail).not.toHaveAttribute("open"));
  await userEvent.click(finalize.querySelector(":scope > summary"));
  expect(finalize).toHaveAttribute("open");
  expect(rail).not.toHaveAttribute("open");
});

test("the ranked list explains an empty or still-computing snapshot", async () => {
  fetchEventResults.mockResolvedValueOnce({
    status: "refreshing",
    requestedRevision: 3,
    computedRevision: 2,
    results: null,
  });
  const { unmount } = render(
    <ResultsSnapshotPanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  const rail = document.querySelector("details.organizer-recommended-times");
  await waitFor(() =>
    expect(rail).toHaveTextContent("Calculating recommendations"),
  );
  unmount();

  fetchEventResults.mockResolvedValueOnce({
    status: "fresh",
    requestedRevision: 3,
    computedRevision: 3,
    results: { recommendations: [] },
  });
  render(
    <ResultsSnapshotPanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(
      document.querySelector("details.organizer-recommended-times"),
    ).toHaveTextContent("No recommendation yet"),
  );
});

// A ranked window as the current API lists it, `rank` hours after 09:00 on
// 1 September 2026 (virtual, like `recommendation`).
function rankedAt(rank, weightedAvailability = 0.8) {
  const hour = String(8 + rank).padStart(2, "0");
  const next = String(9 + rank).padStart(2, "0");
  return {
    ...recommendation,
    rank,
    label: `Tue ${hour}:00–${next}:00`,
    startsAt: `2026-09-01T${hour}:00:00Z`,
    endsAt: `2026-09-01T${next}:00:00Z`,
    weightedAvailability,
    unweightedAvailability: weightedAvailability,
    fullyAvailableParticipantTotal: 2,
  };
}

function mockRanking(recommendations, basis) {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 2,
    computedRevision: 2,
    results: {
      recommendations,
      recommendationBasis: { ruleVersion: 2, status: "ready", ...basis },
    },
  });
}

async function renderRanking(recommendations, basis) {
  mockRanking(recommendations, basis);
  const view = render(
    <ResultsSnapshotPanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      onChoose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );
  await screen.findByText(/Results are current at revision 2/);
  const rail = document.querySelector("details.organizer-recommended-times");
  return { ...view, rail, intro: rail.querySelector(".ranked-chips__intro") };
}

const RANKING_RULE =
  "We recommend times someone can attend for the whole 60 minutes, at least half as available as the best, never overlapping in the same format.";
const RANKING_POINTER =
  "Point at one to find it on the calendar; click one to select it.";

test.each([
  [
    "every other time overlaps or suits nobody",
    [rankedAt(1, 1), rankedAt(2, 0.75)],
    { listEnd: "noMoreWindows", bestWeightedAvailability: 1 },
    "Every other upcoming time overlaps one of these or scores 0% weighted.",
  ],
  [
    "a single window",
    [rankedAt(1, 1)],
    { listEnd: "noMoreWindows", bestWeightedAvailability: 1 },
    "Every other upcoming time overlaps this one or scores 0% weighted.",
  ],
  [
    "the next option falls under half of the best",
    [rankedAt(1, 1), rankedAt(2, 0.8571)],
    {
      listEnd: "belowFloor",
      bestWeightedAvailability: 1,
      weightedAvailabilityFloor: 0.5,
      nextWeightedAvailability: 0.4286,
    },
    "The next option drops to 43% weighted, under half of the best.",
  ],
  [
    "the next option rounds to the floor",
    [rankedAt(1, 1), rankedAt(2, 0.5025)],
    {
      listEnd: "belowFloor",
      bestWeightedAvailability: 1,
      weightedAvailabilityFloor: 0.5,
      nextWeightedAvailability: 0.4975,
    },
    "The next option drops to 49.7% weighted, under half of the best.",
  ],
  [
    "a best window under half of the group",
    [rankedAt(1, 0.4), rankedAt(2, 0.2)],
    {
      listEnd: "belowFloor",
      bestWeightedAvailability: 0.4,
      weightedAvailabilityFloor: 0.2,
      nextWeightedAvailability: 0.1,
    },
    "The next option drops to 10% weighted, under half of the best. No time suits even half of the weighted group; these are the closest.",
  ],
  [
    "a lone window under half of the group",
    [rankedAt(1, 0.4)],
    { listEnd: "noMoreWindows", bestWeightedAvailability: 0.4 },
    "Every other upcoming time overlaps this one or scores 0% weighted. No time suits even half of the weighted group; this is the closest.",
  ],
])(
  "the ranked list says why it ends where it does: %s",
  async (_case, recommendations, basis, reason) => {
    const { rail, intro } = await renderRanking(recommendations, basis);
    expect(intro).toHaveTextContent(
      `${RANKING_RULE} ${reason} ${RANKING_POINTER}`,
      { normalizeWhitespace: true },
    );
    expect(
      within(rail).getAllByRole("button", { name: /choose this time/i }),
    ).toHaveLength(recommendations.length);
    expect(rail.querySelector("summary")).toHaveTextContent(
      `${recommendations.length} recommended · best Tue 09:00–10:00`,
    );
  },
);

test("a full ranked list reports how many more windows qualified", async () => {
  const recommendations = Array.from({ length: 10 }, (_, index) =>
    rankedAt(index + 1, 1),
  );
  const { rail, intro } = await renderRanking(recommendations, {
    listEnd: "limit",
    qualifyingWindowTotal: 12,
    bestWeightedAvailability: 1,
  });
  expect(rail.querySelector("summary")).toHaveTextContent(
    "10 of 12 recommended · best Tue 09:00–10:00",
  );
  expect(intro).toHaveTextContent("Showing the top 10 of 12.");
  expect(rail.querySelectorAll(".ranked-chip")).toHaveLength(10);
});

test("the ranked list never slices what the API listed", async () => {
  // Older clients cut at ten; the API now decides the length.
  const recommendations = Array.from({ length: 12 }, (_, index) =>
    rankedAt(index + 1, 1),
  );
  const { rail } = await renderRanking(recommendations, {
    listEnd: "noMoreWindows",
    qualifyingWindowTotal: 12,
    bestWeightedAvailability: 1,
  });
  expect(rail.querySelectorAll(".ranked-chip")).toHaveLength(12);
  expect(rail.querySelector("summary")).toHaveTextContent(
    "12 recommended · best Tue 09:00–10:00",
  );
});

test("a listed window never reads 0%", async () => {
  const { rail } = await renderRanking([rankedAt(1, 0.004)], {
    listEnd: "noMoreWindows",
    bestWeightedAvailability: 0.004,
  });
  const chip = rail.querySelector(".ranked-chip");
  expect(chip.querySelector(".ranked-chip__share")).toHaveTextContent(
    "<1% weighted",
  );
  expect(chip).toHaveAccessibleName(/<1% weighted ?, <1% unweighted/);
  expect(rail.querySelector(".ranked-chips__detail")).toHaveTextContent(
    "<1% weighted · <1% unweighted",
  );
});

test.each([
  [
    "no_viable_windows",
    { zeroWeightOnlyAvailability: false },
    "No time works yet",
    "No time works yet",
    "No upcoming 60-minute window has anyone free for all of it. Ask for more availability, unblock times, or shorten the meeting.",
  ],
  [
    "no_viable_windows",
    { zeroWeightOnlyAvailability: true },
    "No time works yet",
    "No time works yet",
    "No upcoming 60-minute window has anyone with a weight above 0 free for all of it. Some times suit only people weighted 0, who don't count toward the recommendations. Ask for more availability, unblock times, or shorten the meeting.",
  ],
  [
    "no_weighted_responses",
    {},
    "No weighted responses yet",
    "No one who counts has responded",
    "Everyone counted in the results so far has weight 0, so no time is recommended. Recommendations appear once someone with a weight above 0 is counted.",
  ],
  [
    "no_future_slots",
    {},
    "No upcoming times",
    "No upcoming times",
    "No upcoming open stretch fits a 60-minute meeting: the configured times have passed, are blocked, or leave gaps that are too short.",
  ],
  [
    "invalid_duration",
    {},
    "Meeting length doesn't fit",
    "Meeting length doesn't fit",
    "The meeting length must be a whole number of 30-minute slots.",
  ],
  [
    "waiting_for_submissions",
    {},
    "Waiting for responses",
    "Waiting for responses",
    "Recommendations appear once someone included in the results submits availability.",
  ],
])(
  "an empty ranked list names its reason: %s",
  async (status, extra, hint, title, body) => {
    const { rail } = await renderRanking([], { status, ...extra });
    expect(rail.querySelector(".time-table__section-hint")).toHaveTextContent(
      hint,
    );
    expect(
      within(rail).getByRole("heading", { level: 6, name: title }),
    ).toBeInTheDocument();
    expect(within(rail).getByText(body)).toBeInTheDocument();
  },
);

test("an older snapshot's 0% padding is neither listed nor outlined", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    fetchEventResults.mockResolvedValue({
      status: "refreshing",
      requestedRevision: 7,
      computedRevision: 7,
      results: {
        countedResponseTotal: 3,
        channels: {
          inperson: {
            weighted: [0, 0.9, 0.9, 0],
            unweighted: [0, 0.8, 0.8, 0],
          },
        },
        // Ranked before rule version 2: the list was padded to its
        // length with windows nobody can attend.
        recommendations: [
          datedRanked,
          { ...datedRunnerUp, weightedAvailability: 0 },
        ],
        recommendationBasis: { status: "ready", maximumRecommendations: 10 },
      },
    });
    render(<ResultsSnapshotPanel {...timeTableProps(datedEvent)} />);
    await screen.findByText(/Results are updating for revision 7/);
    const rail = document.querySelector("details.organizer-recommended-times");
    await toggleRecommendedTimes();
    expect(rail.querySelectorAll(".ranked-chip")).toHaveLength(1);
    expect(rail.querySelector("summary")).toHaveTextContent(
      "1 recommended · best Thu 09:30–10:30",
    );
    expect(rail.querySelector(".ranked-chips__intro")).toHaveTextContent(
      "The calendar outlines every recommended time. Point at one to find it on the calendar; click one to select it.",
    );
    const outlines = document.querySelectorAll(
      ".meeting-calendar__block--rank",
    );
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveAttribute("data-rank", "1");
  } finally {
    nowSpy.mockRestore();
  }
});

// Two disjoint hour-long recommended times on `datedEvent`, ranked by the
// current rule; `order` lists them best first.
function reRankedSnapshot(order) {
  const byStart = {
    "09:00": {
      channel: "inperson",
      groupKey: "date:2026-08-20",
      slotIndices: [0, 1],
      suggestedStartsAt: "2026-08-20T09:00:00Z",
      suggestedEndsAt: "2026-08-20T10:00:00Z",
      label: "Thu 09:00–10:00",
      fullyAvailableParticipantTotal: 2,
    },
    "10:00": {
      channel: "inperson",
      groupKey: "date:2026-08-20",
      slotIndices: [2, 3],
      suggestedStartsAt: "2026-08-20T10:00:00Z",
      suggestedEndsAt: "2026-08-20T11:00:00Z",
      label: "Thu 10:00–11:00",
      fullyAvailableParticipantTotal: 2,
    },
  };
  return {
    status: "fresh",
    requestedRevision: 7,
    computedRevision: 7,
    results: {
      countedResponseTotal: 3,
      channels: {
        inperson: {
          weighted: [0.9, 0.9, 0.8, 0.8],
          unweighted: [0.9, 0.9, 0.8, 0.8],
        },
      },
      recommendations: order.map((start, index) => ({
        ...byStart[start],
        rank: index + 1,
        weightedAvailability: index === 0 ? 0.9 : 0.8,
        unweightedAvailability: index === 0 ? 0.9 : 0.8,
      })),
      recommendationBasis: {
        ruleVersion: 2,
        status: "ready",
        listEnd: "noMoreWindows",
        bestWeightedAvailability: 0.9,
      },
    },
  };
}

test("a focused recommended time keeps its highlight and focus when a live update re-ranks it", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    fetchEventResults.mockResolvedValueOnce(
      reRankedSnapshot(["09:00", "10:00"]),
    );
    const panel = createRef();
    render(
      <ResultsSnapshotPanel ref={panel} {...timeTableProps(datedEvent)} />,
    );
    await screen.findByText(/Results are current at revision 7/);
    await toggleRecommendedTimes();
    const rail = document.querySelector("details.organizer-recommended-times");
    const chipFor = (label) =>
      within(rail).getByRole("button", { name: new RegExp(label) });
    const highlighted = () =>
      document.querySelector(".meeting-calendar__block--highlight");

    act(() => chipFor("Thu 10:00–11:00").focus());
    expect(highlighted()).toHaveAttribute("data-rank", "2");
    expect(rail.querySelector(".ranked-chips__detail")).toHaveTextContent(
      "#2 Thu 10:00–11:00",
    );

    // The same time becomes #1: the highlight and the detail line follow
    // it, and focus stays on its chip.
    fetchEventResults.mockResolvedValueOnce(
      reRankedSnapshot(["10:00", "09:00"]),
    );
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(chipFor("Thu 10:00–11:00")).toHaveFocus();
    expect(highlighted()).toHaveAttribute("data-rank", "1");
    expect(rail.querySelector(".ranked-chips__detail")).toHaveTextContent(
      "#1 Thu 10:00–11:00",
    );

    // Dropped from the list: focus moves to the list's summary and the
    // calendar emphasizes nothing.
    fetchEventResults.mockResolvedValueOnce(reRankedSnapshot(["09:00"]));
    await act(async () => {
      await panel.current.refresh("token", { silent: true });
    });
    expect(rail.querySelector(":scope > summary")).toHaveFocus();
    expect(highlighted()).toBeNull();
    expect(rail.querySelector(".ranked-chips__detail")).toHaveTextContent(
      "#1 Thu 09:00–10:00",
    );
  } finally {
    nowSpy.mockRestore();
  }
});

// The API shape of `weeklyEvent` with `slotCount` and per-slot `blocked`
// flags derived from a `blockedSlots` map ({ groupKey: [rows] }).
function blockedWeeklyEvent(blockedSlots = {}, overrides = {}) {
  return {
    ...weeklyEvent,
    slotCount: 8,
    blockedSlots,
    slotGroups: weeklyEvent.slotGroups.map((group) => ({
      ...group,
      slots: group.slots.map((slot, row) => ({
        ...slot,
        blocked: (blockedSlots[group.key] || []).includes(row),
      })),
    })),
    ...overrides,
  };
}

// Renders the Time Table around `event` with a current, empty snapshot: the
// calendar (the paint surface once the Blocked times step is open) and the
// three steps under it.
function timeTableProps(event, overrides = {}) {
  return {
    event,
    setEvent: jest.fn(),
    getToken,
    invalidationKey: 0,
    onChoose: jest.fn(),
    onSelect: jest.fn(),
    ...overrides,
  };
}

function mockEmptySnapshot() {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 1,
    computedRevision: 1,
    results: { channels: {}, recommendations: [] },
  });
}

function renderTimeTable(event, overrides = {}) {
  mockEmptySnapshot();
  const props = timeTableProps(event, overrides);
  return { props, ...render(<ResultsSnapshotPanel {...props} />) };
}

// Stores saved events like the workspace does, so a save, a conflict reload
// or an inline event edit re-renders the Overview and the Time Table with
// the newer event.
function StatefulTimeTable({ initialEvent, onEventSaved }) {
  const [event, setEvent] = useState(initialEvent);
  const handleSaved = async (result) => {
    onEventSaved?.(result);
    if (result?.event) setEvent(result.event);
  };
  return (
    <>
      <OverviewPanel event={event} onEventSaved={handleSaved} />
      <ResultsSnapshotPanel
        {...timeTableProps(event, { setEvent, onEventSaved: handleSaved })}
      />
    </>
  );
}

function renderStatefulTimeTable(initialEvent, onEventSaved) {
  mockEmptySnapshot();
  return render(
    <StatefulTimeTable
      initialEvent={initialEvent}
      onEventSaved={onEventSaved}
    />,
  );
}

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

// The step is found by its class (not its heading text) and toggled through
// its summary; while it is open the meeting calendar is the paint surface,
// so cells are looked up in that one grid.
const blockedTimesDetails = () =>
  document.querySelector("details.organizer-blocked-times");
const blockedTimesSummary = () =>
  blockedTimesDetails().querySelector("summary");
const calendarGrid = () =>
  screen.getByRole("grid", { name: /^Meeting time calendar/ });
const editorCell = (index) =>
  calendarGrid().querySelector(`[data-cell-idx="${index}"]`);
const paintCell = (index) =>
  fireEvent.pointerDown(editorCell(index), {
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
const saveButton = () =>
  screen.getByRole("button", { name: "Save blocked times" });
const openBlockedTimes = async () => {
  if (!blockedTimesDetails().open) await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).toHaveAttribute("open");
};
// While the step is open its tools (brush, Save, feedback) live in a bar
// under the calendar; the panel renders its own snapshot status, so the
// draft's feedback is looked up inside that bar.
const paintBar = () =>
  screen.getByRole("region", { name: "Blocked times tools" });
const blockedStatus = () => within(paintBar()).queryByRole("status");
const blockedAlert = () => within(paintBar()).queryByRole("alert");
const DISCARDED_MESSAGE =
  "Unsaved blocked-time marks were discarded because the event changed.";
const STEP_DESCRIPTION =
  "While this step is open, paint on the calendar above to mark the parts of each day that are not available for this event. Participants see these times greyed out. The brush and Save stay in the bar under the calendar.";

test("the blocked-times step starts closed and turns the calendar into the paint surface while open", async () => {
  const { unmount } = renderTimeTable(weeklyEvent);
  await screen.findByText(/Results are current/);

  const details = blockedTimesDetails();
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveAttribute(
    "aria-labelledby",
    "organizer-blocked-times-heading",
  );
  expect(
    within(details.querySelector("summary")).getByRole("heading", {
      level: 4,
      name: "Blocked times",
    }),
  ).toHaveAttribute("id", "organizer-blocked-times-heading");
  expect(details).toHaveTextContent("0 slots blocked");
  // One grid, the calendar: no second "Blocked times" grid, and no paint
  // attributes while the step is closed.
  expect(screen.getAllByRole("grid")).toHaveLength(1);
  expect(
    screen.queryByRole("grid", { name: "Blocked times" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-blocked-paint]")).toBeNull();
  expect(calendarGrid().getAttribute("aria-label")).not.toMatch(
    /marking blocked times/,
  );

  await openBlockedTimes();
  expect(calendarGrid()).toHaveAccessibleName(/, marking blocked times$/);
  expect(calendarGrid()).toHaveAttribute("aria-multiselectable", "true");
  expect(calendarGrid()).not.toHaveAttribute("aria-readonly");
  const calendar = document.querySelector(".meeting-calendar");
  expect(calendar).toHaveClass("meeting-calendar--painting");
  expect(calendar).toHaveAttribute("data-mode", "blocked-editing");
  expect(calendarGrid().querySelectorAll("[data-blocked-paint]")).toHaveLength(
    8,
  );
  expect(screen.getByText(STEP_DESCRIPTION)).toBeInTheDocument();
  // The grid is named without a second visible "Blocked times" heading.
  expect(
    screen.getAllByRole("heading", { level: 4, name: "Blocked times" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("group", { name: "Mark times as" }),
  ).toBeInTheDocument();
  // The brushes carry a visible label and a swatch each, like every other
  // "Mark times as" toolbar.
  expect(screen.getByText("Mark times as")).toHaveClass(
    "schedule-toolbar__label",
  );
  expect(
    screen
      .getByRole("button", { name: "Blocked" })
      .querySelector(".availability-swatch--blocked-paint"),
  ).toHaveTextContent("✕");
  expect(
    screen
      .getByRole("button", { name: "Open" })
      .querySelector(".availability-swatch--open"),
  ).toBeEmptyDOMElement();
  expect(screen.getByRole("button", { name: "Blocked" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Nothing to save yet: the marks match the stored (empty) blocks.
  expect(saveButton()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
  expect(screen.getByText("0 slots marked")).not.toHaveAttribute("role");
  // The toolbar and the legend speak the painting vocabulary meanwhile.
  expect(screen.getByText("Marking blocked times")).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Shading" }),
  ).not.toBeInTheDocument();
  const legend = screen.getByRole("list", { name: "Calendar legend" });
  expect(legend).toHaveTextContent("Blocked");
  expect(legend).toHaveTextContent("Open");
  expect(legend).not.toHaveTextContent("Selected window");
  expect(
    screen.getByText("Blocked times repeat every week."),
  ).toBeInTheDocument();
  unmount();

  // The API always emits `blockedSlots: {}` for a fresh event (truthy, but
  // empty): still closed, still nothing to save.
  const { unmount: unmountEmpty } = renderTimeTable(blockedWeeklyEvent({}));
  await screen.findByText(/Results are current/);
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(blockedTimesDetails()).toHaveTextContent("0 slots blocked");
  await openBlockedTimes();
  expect(saveButton()).toBeDisabled();
  unmountEmpty();

  renderTimeTable(blockedWeeklyEvent({ "weekday:1": [1], "weekday:3": [2] }));
  await screen.findByText(/Results are current/);
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
  // Closed: the calendar shows the stored blocks as blocked slots.
  expect(editorCell(1)).toHaveAttribute("data-blocked-slot", "true");
  expect(editorCell(1)).not.toHaveAttribute("data-blocked-paint");

  await openBlockedTimes();
  // Open: the stored blocks hydrate the marks (slot 1 on Mon, slot 6 on Wed),
  // drawn as paint on a neutral surface with no pick state left on the cell.
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(1)).toHaveAttribute("aria-selected", "true");
  expect(editorCell(1)).toHaveAttribute(
    "aria-label",
    "Mon (every week), 9:30 AM – 10:00 AM, blocked",
  );
  expect(editorCell(1)).not.toHaveAttribute("data-state");
  expect(editorCell(1)).not.toHaveAttribute("data-level");
  expect(editorCell(1)).not.toHaveAttribute("data-blocked-slot");
  expect(editorCell(1)).not.toHaveAttribute("aria-disabled");
  expect(editorCell(1).style.backgroundColor).toBe("");
  expect(
    editorCell(1).querySelector(".meeting-calendar__cell-value"),
  ).toHaveTextContent("✕");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(0)).toHaveAttribute("aria-selected", "false");
  expect(editorCell(0)).toHaveAttribute(
    "aria-label",
    "Mon (every week), 9:00 AM – 9:30 AM, open",
  );
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

  // Closing the step hands the calendar back to the picker.
  await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(calendarGrid().getAttribute("aria-label")).not.toMatch(
    /marking blocked times/,
  );
  expect(editorCell(1)).toHaveAttribute("data-blocked-slot", "true");
  expect(calendarGrid().querySelector("[data-blocked-paint]")).toBeNull();
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
});

test("the blocked-times step counts blocked rows defensively and keeps the disclosure controlled", async () => {
  const { unmount } = renderTimeTable({
    ...weeklyEvent,
    blockedSlots: "not-a-map",
  });
  await screen.findByText(/Results are current/);
  expect(blockedTimesDetails()).toHaveTextContent("0 slots blocked");
  expect(blockedTimesDetails()).not.toHaveAttribute("open");

  // Toggling the summary updates the controlled state.
  await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).toHaveAttribute("open");
  await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  unmount();

  renderTimeTable({
    ...weeklyEvent,
    blockedSlots: { "weekday:1": "rows?", "weekday:3": [0, 3] },
  });
  await screen.findByText(/Results are current/);
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
});

test("painting on the calendar saves the marked rows and re-hydrates from the saved event", async () => {
  const onEventSaved = jest.fn();
  const savedEvent = blockedWeeklyEvent(
    { "weekday:1": [0] },
    { version: weeklyEvent.version + 1 },
  );
  let resolveSave;
  updateEvent.mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve;
    }),
  );
  // `weeklyEvent` omits `slotCount`: the marks fall back to the highest
  // slot index.
  renderStatefulTimeTable(weeklyEvent, onEventSaved);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(0);
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(0)).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
  expect(blockedTimesSummary()).toHaveTextContent("unsaved changes");

  await userEvent.click(saveButton());

  const savingButton = await screen.findByRole("button", { name: "Saving…" });
  expect(savingButton).toBeDisabled();
  expect(savingButton).toHaveAttribute("aria-busy", "true");
  // Saving freezes the paint surface without dropping its tab stop.
  expect(calendarGrid()).toHaveAttribute("aria-readonly", "true");
  expect(editorCell(0)).toHaveAttribute("aria-readonly", "true");
  expect(editorCell(0)).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
  expect(updateEvent).toHaveBeenCalledWith(
    "SCALE1",
    { blockedSlots: { "weekday:1": [0] }, expectedVersion: 4 },
    "token",
  );

  await act(async () => {
    resolveSave({ event: savedEvent, responsesReset: 0 });
  });

  expect(onEventSaved).toHaveBeenCalledWith({
    event: savedEvent,
    responsesReset: 0,
  });
  expect(await within(paintBar()).findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
  // The stored event now carries the block, so there is nothing to save,
  // and the step stays open with the calendar still painting.
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(saveButton()).toBeDisabled();
  expect(calendarGrid()).not.toHaveAttribute("aria-readonly");
  expect(blockedTimesDetails()).toHaveTextContent("1 slots blocked");
  expect(blockedTimesSummary()).not.toHaveTextContent("unsaved changes");
  expect(blockedTimesDetails()).toHaveAttribute("open");
  // Painting never picked a window.
  expect(document.getElementById("organizer-finalize")).not.toHaveAttribute(
    "open",
  );

  // Painting again clears the status.
  paintCell(3);
  expect(blockedStatus()).toBeNull();
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
});

test("the Open brush unmarks on the calendar and Clear all clears every mark", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  renderTimeTable(blockedWeeklyEvent({ "weekday:1": [1], "weekday:3": [2] }));
  await screen.findByText(/Results are current/);
  await openBlockedTimes();
  expect(saveButton()).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Blocked" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  paintCell(1);
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "false");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
  // Painting an already open slot with the Open brush changes nothing.
  paintCell(1);
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();

  // Restoring the stored block leaves nothing to save again.
  await userEvent.click(screen.getByRole("button", { name: "Blocked" }));
  paintCell(1);
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "true");
  expect(saveButton()).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();
  expect(
    calendarGrid().querySelectorAll('[data-blocked-paint="true"]'),
  ).toHaveLength(0);
  expect(saveButton()).toBeEnabled();

  await userEvent.click(saveButton());
  await waitFor(() =>
    expect(updateEvent).toHaveBeenCalledWith(
      "SCALE1",
      { blockedSlots: {}, expectedVersion: 4 },
      "token",
    ),
  );
  expect(await within(paintBar()).findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
});

test("the blocked-times draft recovers from a conflict by loading the newer event", async () => {
  const onEventSaved = jest.fn();
  const newerEvent = blockedWeeklyEvent(
    { "weekday:3": [3] },
    { version: weeklyEvent.version + 5 },
  );
  updateEvent.mockRejectedValueOnce(
    Object.assign(new Error("Version mismatch"), {
      status: 409,
      event: newerEvent,
    }),
  );
  renderStatefulTimeTable(weeklyEvent, onEventSaved);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(0);
  await userEvent.click(saveButton());

  const alert = await within(paintBar()).findByRole("alert");
  expect(alert).toHaveTextContent(
    "The event changed in another session. Reload and try again.",
  );
  expect(onEventSaved).not.toHaveBeenCalled();
  await userEvent.click(
    within(alert).getByRole("button", { name: "Reload latest event" }),
  );

  expect(onEventSaved).toHaveBeenCalledWith({ event: newerEvent });
  expect(reloadPage).not.toHaveBeenCalled();
  await waitFor(() => expect(blockedAlert()).toBeNull());
  // The unsaved mark gave way to the newer event's blocks.
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(7)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(blockedTimesDetails()).toHaveTextContent("1 slots blocked");
  expect(saveButton()).toBeDisabled();
});

test("the blocked-times draft keeps unsaved marks across an inline event edit", async () => {
  const onEventSaved = jest.fn();
  updateEvent.mockImplementation(async (_code, payload) => ({
    event: blockedWeeklyEvent(payload.blockedSlots, {
      name: "Updated scale event",
      version: payload.expectedVersion + 1,
    }),
    responsesReset: 0,
  }));
  renderStatefulTimeTable(blockedWeeklyEvent(), onEventSaved);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(0);
  paintCell(5);
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(blockedTimesSummary()).toHaveTextContent(
    "0 slots blocked · unsaved changes",
  );

  // Renaming through the inline editor bumps `version` but leaves the index
  // space and the stored blocks alone, so the paint survives.
  await userEvent.click(screen.getByRole("button", { name: "Edit event" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Event changes saved.")).toBeInTheDocument();
  expect(onEventSaved).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({ version: 5 }),
    }),
  );
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(5)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
  expect(screen.queryByText(DISCARDED_MESSAGE)).not.toBeInTheDocument();

  // ...and the fresh version flows into the save, which then stores exactly
  // what was painted: nothing is discarded.
  await userEvent.click(saveButton());
  await waitFor(() =>
    expect(updateEvent).toHaveBeenCalledWith(
      "SCALE1",
      {
        blockedSlots: { "weekday:1": [0], "weekday:3": [1] },
        expectedVersion: 5,
      },
      "token",
    ),
  );
  expect(await screen.findByText("Blocked times saved.")).toBeInTheDocument();
  expect(screen.queryByText(DISCARDED_MESSAGE)).not.toBeInTheDocument();
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(5)).toHaveAttribute("data-blocked-paint", "true");
  expect(saveButton()).toBeDisabled();
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
  expect(blockedTimesSummary()).not.toHaveTextContent("unsaved changes");
});

test("the blocked-times draft announces unsaved marks it discards for a changed event", async () => {
  const stored = blockedWeeklyEvent({ "weekday:1": [1] });
  // The same days renamed Tue/Thu: the slot count is unchanged, so rows
  // would silently move onto other days.
  const renamedDays = {
    ...blockedWeeklyEvent({}, { version: 10 }),
    slotGroups: weeklyEvent.slotGroups.map((group, groupIndex) => ({
      ...group,
      key: `weekday:${[2, 4][groupIndex]}`,
      label: ["Tue", "Thu"][groupIndex],
      weekday: [2, 4][groupIndex],
    })),
  };
  const { rerender } = renderTimeTable(stored);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();
  const show = (event) =>
    rerender(<ResultsSnapshotPanel {...timeTableProps(event)} />);

  paintCell(0);
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

  // A workspace refresh that returns the same schedule and blocks (a fresh
  // object with a newer version) leaves the paint alone.
  show({
    ...stored,
    version: stored.version + 1,
    slotGroups: stored.slotGroups.map((group) => ({ ...group })),
  });
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(blockedStatus()).toBeNull();

  // Another session changed the blocks: they replace the paint, with a note.
  show(blockedWeeklyEvent({ "weekday:3": [2] }, { version: 9 }));
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "true");
  expect(blockedStatus()).toHaveTextContent(DISCARDED_MESSAGE);
  expect(blockedStatus()).toHaveClass("blocked-slots-controls__note--warning");
  expect(blockedAlert()).toBeNull();
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();

  // Painting again clears the note.
  paintCell(3);
  expect(blockedStatus()).toBeNull();
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

  // A schedule edit that changes the index space resets the marks too.
  show(renamedDays);
  expect(editorCell(3)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "false");
  expect(blockedStatus()).toHaveTextContent(DISCARDED_MESSAGE);
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();

  // With nothing unsaved, a change of blocks re-hydrates quietly.
  show({
    ...renamedDays,
    version: 11,
    blockedSlots: { "weekday:2": [0] },
    slotGroups: renamedDays.slotGroups.map((group) => ({
      ...group,
      slots: group.slots.map((slot) => ({
        ...slot,
        blocked: group.key === "weekday:2" && slot.index === 0,
      })),
    })),
  });
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(blockedStatus()).toBeNull();
  expect(saveButton()).toBeDisabled();
});

test("the blocked-times draft reloads the page for a conflict without the newer event", async () => {
  const onEventSaved = jest.fn();
  updateEvent.mockRejectedValueOnce(
    Object.assign(new Error("Version mismatch"), { status: 409 }),
  );
  renderTimeTable(weeklyEvent, { onEventSaved });
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(2);
  await userEvent.click(saveButton());

  const alert = await within(paintBar()).findByRole("alert");
  await userEvent.click(
    within(alert).getByRole("button", { name: "Reload latest event" }),
  );
  expect(reloadPage).toHaveBeenCalledTimes(1);
  expect(onEventSaved).not.toHaveBeenCalled();
  // Whatever was painted stays until the page reloads.
  expect(editorCell(2)).toHaveAttribute("data-blocked-paint", "true");
});

test("the blocked-times draft surfaces other failures without a reload action", async () => {
  updateEvent
    .mockRejectedValueOnce(
      Object.assign(new Error("Blocked slots leave no open window."), {
        status: 400,
      }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error("Responses would be reset."), {
        status: 409,
        requiresResponseReset: true,
        event: weeklyEvent,
      }),
    )
    .mockRejectedValueOnce(Object.assign(new Error(""), { status: 500 }));
  renderTimeTable(weeklyEvent);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(4);
  await userEvent.click(saveButton());
  let alert = await within(paintBar()).findByRole("alert");
  expect(alert).toHaveTextContent("Blocked slots leave no open window.");
  expect(
    within(alert).queryByRole("button", { name: "Reload latest event" }),
  ).not.toBeInTheDocument();
  // Painting again clears the failure.
  paintCell(5);
  expect(blockedAlert()).toBeNull();

  // A 409 demanding a reset cannot come from blocks; it is shown as is.
  await userEvent.click(saveButton());
  alert = await within(paintBar()).findByRole("alert");
  expect(alert).toHaveTextContent("Responses would be reset.");
  expect(
    within(alert).queryByRole("button", { name: "Reload latest event" }),
  ).not.toBeInTheDocument();

  // Clearing every mark also clears the failure; with no stored blocks there
  // is nothing to save until a mark returns.
  await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(blockedAlert()).toBeNull();
  expect(saveButton()).toBeDisabled();
  paintCell(6);
  await userEvent.click(saveButton());
  expect(await within(paintBar()).findByRole("alert")).toHaveTextContent(
    "Failed to save blocked times.",
  );
});

test.each([
  [
    "a finalized event",
    { status: "finalized" },
    "Reactivate this finalized event before editing it.",
  ],
  [
    "an event with a confirmed meeting",
    { finalMeeting: { id: "final-1" } },
    "Reactivate the event before editing a confirmed meeting.",
  ],
])(
  "the blocked-times paint surface is read-only for %s",
  async (_label, overrides, reason) => {
    renderTimeTable(blockedWeeklyEvent({ "weekday:1": [1] }, overrides));
    await screen.findByText(/Results are current/);
    await openBlockedTimes();

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute("title", reason);
    const clearAll = screen.getByRole("button", { name: "Clear all" });
    expect(clearAll).toBeDisabled();
    expect(clearAll).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: "Blocked" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    // The reason is visible, not just a tooltip, and the calendar says so.
    expect(within(paintBar()).getByText(reason)).toBeInTheDocument();
    expect(screen.getByText("Blocked times (read-only)")).toBeInTheDocument();
    expect(screen.queryByText("Marking blocked times")).not.toBeInTheDocument();
    // Read-only, yet still reachable: the grid keeps its tab stop.
    expect(calendarGrid()).toHaveAttribute("aria-readonly", "true");
    expect(editorCell(0)).toHaveAttribute("aria-readonly", "true");
    expect(editorCell(0)).toHaveAttribute("tabindex", "0");
    paintCell(0);
    fireEvent.keyDown(editorCell(0), { key: "Enter" });
    expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
    expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  },
);

test("the blocked-times draft handles events without slot groups or slots", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  const { unmount } = renderTimeTable(baseEvent);
  await screen.findByText(/Results are current/);
  // No slots: the calendar shows its empty state (the only one on screen)
  // and the step has nothing to paint on.
  expect(
    screen.getByRole("heading", { name: "No schedule slots are configured." }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  await openBlockedTimes();
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
  unmount();

  // A group without slots contributes nothing to the marks or the calendar.
  renderTimeTable({
    ...weeklyEvent,
    slotGroups: [
      { key: "weekday:1", label: "Mon" },
      ...weeklyEvent.slotGroups.slice(1),
    ],
  });
  await screen.findByText(/Results are current/);
  await openBlockedTimes();
  expect(calendarGrid().querySelectorAll("[data-cell-idx]")).toHaveLength(4);
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();

  // ...and is skipped when serializing the marked rows.
  paintCell(4);
  await userEvent.click(saveButton());
  await waitFor(() =>
    expect(updateEvent).toHaveBeenCalledWith(
      "SCALE1",
      { blockedSlots: { "weekday:3": [0] }, expectedVersion: 4 },
      "token",
    ),
  );
});

test("the blocked-times draft stands alone without a lock or a save listener", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  renderTimeTable(weeklyEvent);
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  // Unlocked by default: no lock title, and the grid takes paint.
  expect(saveButton()).not.toHaveAttribute("title");
  expect(screen.getByRole("button", { name: "Clear all" })).not.toHaveAttribute(
    "title",
  );
  expect(calendarGrid()).not.toHaveAttribute("aria-readonly");
  paintCell(0);
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");

  await userEvent.click(saveButton());
  await waitFor(() =>
    expect(updateEvent).toHaveBeenCalledWith(
      "SCALE1",
      { blockedSlots: { "weekday:1": [0] }, expectedVersion: 4 },
      "token",
    ),
  );
  expect(await within(paintBar()).findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
});

test("the blocked-times draft hook defaults to an unlocked, saveable draft", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  const seen = {};
  function Probe() {
    const draft = useBlockedSlotsDraft(weeklyEvent, { getToken });
    Object.assign(seen, draft);
    return (
      <button type="button" onClick={() => draft.paint(2)}>
        paint
      </button>
    );
  }
  render(<Probe />);
  expect(seen.locked).toBe(false);
  expect(seen.lockTitle).toBeUndefined();
  expect(seen.lockReason).toBe("");
  expect(seen.surface).toEqual({
    marks: [0, 0, 0, 0, 0, 0, 0, 0],
    onPaint: seen.paint,
    readOnly: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "paint" }));
  expect(seen.marks[2]).toBe(1);
  expect(seen.dirty).toBe(true);
  // Saving without a listener still stores the marks.
  await act(async () => {
    await seen.save();
  });
  expect(updateEvent).toHaveBeenCalledWith(
    "SCALE1",
    { blockedSlots: { "weekday:1": [2] }, expectedVersion: 4 },
    "token",
  );
  expect(seen.status).toBe("Blocked times saved.");
});

test("the blocked-times tools sit in a bar under the calendar only while the step is open", async () => {
  renderTimeTable(weeklyEvent);
  await screen.findByText(/Results are current/);
  expect(
    screen.queryByRole("region", { name: "Blocked times tools" }),
  ).not.toBeInTheDocument();

  await openBlockedTimes();
  const bar = paintBar();
  // Right under the calendar, before the steps, so it stays with the surface.
  expect(bar.previousElementSibling).toHaveClass("meeting-calendar");
  expect(bar.nextElementSibling).toHaveClass("time-table__sections");
  expect(
    within(bar).getByRole("group", { name: "Mark times as" }),
  ).toBeInTheDocument();
  expect(
    within(bar).getByRole("button", { name: "Save blocked times" }),
  ).toBeInTheDocument();
  expect(within(bar).getByText("0 slots marked")).toBeInTheDocument();
  // The step itself only explains the mode.
  expect(
    within(blockedTimesDetails()).queryByRole("button", {
      name: "Save blocked times",
    }),
  ).not.toBeInTheDocument();
  expect(
    within(blockedTimesDetails()).getByText(STEP_DESCRIPTION),
  ).toBeInTheDocument();

  // Close closes the step: the bar goes, the draft stays, and focus lands on
  // the step's summary instead of falling off the unmounted button.
  paintCell(2);
  await userEvent.click(within(bar).getByRole("button", { name: "Close" }));
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(
    screen.queryByRole("region", { name: "Blocked times tools" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(blockedTimesSummary()).toHaveFocus());
  expect(blockedTimesSummary()).toHaveTextContent("unsaved changes");
  await openBlockedTimes();
  expect(editorCell(2)).toHaveAttribute("data-blocked-paint", "true");
  expect(within(paintBar()).getByText("1 slots marked")).toBeInTheDocument();
});

test("painting on the calendar never picks a window", async () => {
  const onSelect = jest.fn();
  renderTimeTable(weeklyEvent, { onSelect });
  await screen.findByText(/Results are current/);
  await openBlockedTimes();

  paintCell(1);
  await userEvent.click(editorCell(1));
  fireEvent.keyDown(editorCell(1), { key: "Enter" });
  fireEvent.keyDown(editorCell(1), { key: " " });
  expect(onSelect).not.toHaveBeenCalled();
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "true");
  const finalize = document.getElementById("organizer-finalize");
  expect(finalize).not.toHaveAttribute("open");
  expect(finalize).toHaveTextContent("No time selected yet");
});

// Four 30-minute slots on one date, with a ranked 09:30 window: a calendar
// whose overlays can be checked against the painting mode.
const datedEvent = {
  ...baseEvent,
  mode: "inperson",
  slotCount: 4,
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
const datedRanked = {
  rank: 1,
  channel: "inperson",
  groupKey: "date:2026-08-20",
  slotIndices: [1, 2],
  suggestedStartsAt: "2026-08-20T09:30:00Z",
  suggestedEndsAt: "2026-08-20T10:30:00Z",
  label: "Thu 09:30–10:30",
  weightedAvailability: 0.9,
  unweightedAvailability: 0.8,
  fullyAvailableParticipantTotal: 3,
};
const datedRunnerUp = {
  rank: 2,
  channel: "inperson",
  groupKey: "date:2026-08-20",
  slotIndices: [0, 1],
  suggestedStartsAt: "2026-08-20T09:00:00Z",
  suggestedEndsAt: "2026-08-20T10:00:00Z",
  label: "Thu 09:00–10:00",
  weightedAvailability: 0.5,
  unweightedAvailability: 0.4,
  fullyAvailableParticipantTotal: 1,
};
const DATED_NOW = Date.parse("2026-08-01T00:00:00Z");

function mockDatedSnapshot() {
  fetchEventResults.mockResolvedValue({
    status: "fresh",
    requestedRevision: 7,
    computedRevision: 7,
    results: {
      countedResponseTotal: 3,
      channels: {
        inperson: {
          weighted: [0.5, 0.9, 0.9, 0.4],
          unweighted: [0.4, 0.8, 0.8, 0.3],
        },
      },
      recommendations: [datedRanked, datedRunnerUp],
    },
  });
}

// Opens Finalize (if needed) and then its Other times list.
async function openOtherTimes() {
  const finalize = document.getElementById("organizer-finalize");
  if (!finalize.open)
    await userEvent.click(finalize.querySelector(":scope > summary"));
  const other = document.getElementById("organizer-other-times");
  if (!other.open)
    await userEvent.click(other.querySelector(":scope > summary"));
  return other;
}

test("Other times picks any open time inside Finalize, recommended or not", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    mockDatedSnapshot();
    const onSelect = jest.fn();
    render(
      <ResultsSnapshotPanel {...timeTableProps(datedEvent, { onSelect })} />,
    );
    await screen.findByText(/Results are current at revision 7/);
    const finalize = document.getElementById("organizer-finalize");
    const other = document.getElementById("organizer-other-times");
    expect(finalize).toContainElement(other);
    expect(other).not.toHaveAttribute("open");
    expect(
      within(other.querySelector("summary")).getByRole("heading", {
        level: 5,
        name: "Other times",
      }),
    ).toBeInTheDocument();
    expect(other.querySelector("summary")).toHaveTextContent(
      "Any open 60-minute time, recommended or not",
    );

    await openOtherTimes();
    const day = within(other).getByLabelText("Day");
    const start = within(other).getByLabelText("Start");
    expect(Array.from(day.options).map((option) => option.value)).toEqual([
      "date:2026-08-20",
    ]);
    // Every start the calendar would accept, with its lowest slot's share
    // and, when it is also recommended, its rank.
    expect(
      Array.from(start.options).map((option) => option.textContent),
    ).toEqual([
      "09:00–10:00 · up to 50% weighted · Recommended #2",
      "09:30–10:30 · up to 90% weighted · Recommended #1",
      "10:00–11:00 · up to 40% weighted",
    ]);
    // The time zone and what the share means are the Start field's help.
    expect(within(other).getByLabelText("Start")).toHaveAccessibleDescription(
      "Times are in UTC. Shares are weighted, from each time's lowest slot; Review attendance gives exact counts.",
    );
    // With recommendations and open times, Finalize points at both.
    expect(finalize).toHaveTextContent(
      "Pick a time on the calendar, or choose a recommended or other time above.",
    );

    // A time nobody recommended: selected like a calendar pick, and focus
    // stays on the button.
    await userEvent.selectOptions(start, "2");
    const select = within(other).getByRole("button", {
      name: "Select this time",
    });
    await userEvent.click(select);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "picker",
        channel: "inperson",
        slotIndices: [2, 3],
        startsAt: "2026-08-20T10:00:00Z",
        metrics: expect.objectContaining({ exact: false, weighted: 0.4 }),
      }),
    );
    expect(select).toHaveFocus();
    expect(within(other).getByRole("status")).toHaveTextContent(
      /^Selected .*, 10:00–11:00\.$/,
    );

    // A recommended time picked here is still that recommendation.
    await userEvent.selectOptions(start, "0");
    await userEvent.click(select);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "picker",
        slotIndices: [0, 1],
        metrics: expect.objectContaining({ exact: true, rank: 2 }),
      }),
    );
  } finally {
    nowSpy.mockRestore();
  }
});

test("Other times lists a weekly event's days in its own time zone and resets the start per day", async () => {
  // Wednesday 23:30 in Los Angeles is already Thursday in UTC. Four weeks
  // from the event-local Wednesday end on Monday 19 October; counted from
  // the UTC Thursday they would reach Wednesday 21 October.
  const nowSpy = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-09-24T06:30:00Z"));
  try {
    fetchEventResults.mockResolvedValue({
      status: "fresh",
      requestedRevision: 1,
      computedRevision: 1,
      results: {
        countedResponseTotal: 2,
        channels: {
          inperson: {
            weighted: [0.5, 0.5, 0, 1, 1, 1, 1, 1],
            unweighted: [0.5, 0.5, 0, 1, 1, 1, 1, 1],
          },
        },
        recommendations: [],
        recommendationBasis: { ruleVersion: 2, status: "no_viable_windows" },
      },
    });
    const onSelect = jest.fn();
    render(
      <ResultsSnapshotPanel
        {...timeTableProps(
          { ...weeklyEvent, timezone: "America/Los_Angeles" },
          { onSelect },
        )}
      />,
    );
    await screen.findByText(/Results are current at revision 1/);
    const other = await openOtherTimes();
    const day = () => within(other).getByLabelText("Day");
    const start = () => within(other).getByLabelText("Start");
    const values = Array.from(day().options).map((option) => option.value);
    expect(values[0]).toBe("weekday:1:2026-09-28");
    expect(values[values.length - 1]).toBe("weekday:1:2026-10-19");
    expect(values).toHaveLength(7);
    // Monday's later windows run into a 0% slot.
    expect(
      Array.from(start().options).map((option) => option.textContent),
    ).toEqual([
      "09:00–10:00 · up to 50% weighted",
      "09:30–10:30 · 0% weighted",
      "10:00–11:00 · 0% weighted",
    ]);
    await userEvent.selectOptions(start(), "2");
    expect(start()).toHaveValue("2");
    // A new day starts over at its first start.
    await userEvent.selectOptions(day(), "weekday:3:2026-09-30");
    expect(start()).toHaveValue("0");
    expect(start().options[0]).toHaveTextContent(
      "09:00–10:00 · up to 100% weighted",
    );
    // Nothing recommended, so Finalize points at Other times only.
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "Pick a time on the calendar, or choose one under Other times above.",
    );

    // A start that passed since the list was built is refused, and the list
    // catches up with the clock.
    await userEvent.selectOptions(day(), "weekday:1:2026-09-28");
    // Monday 09:15 in Los Angeles.
    nowSpy.mockReturnValue(Date.parse("2026-09-28T16:15:00Z"));
    await userEvent.click(
      within(other).getByRole("button", { name: "Select this time" }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(within(other).getByRole("status")).toHaveTextContent(
      "That time has just started. Pick another one.",
    );
    await waitFor(() =>
      expect(Array.from(start().options).map((option) => option.value)).toEqual(
        ["1", "2"],
      ),
    );
    expect(day().options[0]).toHaveValue("weekday:1:2026-09-28");
  } finally {
    nowSpy.mockRestore();
  }
});

test("Other times follows the calendar's format and explains when nothing can start", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    mockDatedSnapshot();
    const { unmount } = render(
      <ResultsSnapshotPanel
        {...timeTableProps({ ...datedEvent, mode: "mixed" })}
      />,
    );
    await screen.findByText(/Results are current at revision 7/);
    let other = await openOtherTimes();
    const format = within(other).getByLabelText("Format");
    expect(format).toHaveValue("inperson");
    await userEvent.selectOptions(format, "virtual");
    const channels = screen.getByRole("group", { name: "Meeting channel" });
    expect(
      within(channels).getByRole("button", { name: "Virtual" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(other).getByLabelText("Format")).toHaveValue("virtual");
    // No virtual results: the starts carry no share.
    expect(within(other).getByLabelText("Start").options[2]).toHaveTextContent(
      /^10:00–11:00$/,
    );
    unmount();

    // The dates have passed.
    nowSpy.mockReturnValue(Date.parse("2026-09-01T00:00:00Z"));
    mockDatedSnapshot();
    const passed = render(
      <ResultsSnapshotPanel {...timeTableProps(datedEvent)} />,
    );
    await screen.findByText(/Results are current at revision 7/);
    other = await openOtherTimes();
    expect(other).toHaveTextContent("No upcoming 60-minute time can start.");
    expect(within(other).queryByRole("button")).toBeNull();
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "No upcoming time can start. Edit the event's schedule or unblock times to add one.",
    );
    passed.unmount();

    // A weekly event with every slot blocked.
    mockEmptySnapshot();
    const weekly = render(
      <ResultsSnapshotPanel
        {...timeTableProps(
          blockedWeeklyEvent({
            "weekday:1": [0, 1, 2, 3],
            "weekday:3": [0, 1, 2, 3],
          }),
        )}
      />,
    );
    await screen.findByText(/Results are current/);
    // Closed, the list renders nothing but its (empty) status line: no
    // controls and no stale "nothing can start" note.
    other = document.getElementById("organizer-other-times");
    const closedContent = other.querySelector(".time-table__section-content");
    expect(closedContent.textContent).toBe("");
    expect(closedContent.querySelectorAll("select, button")).toHaveLength(0);
    expect(other.querySelector("summary")).toHaveTextContent(
      "Any open 60-minute time in the next 4 weeks, recommended or not",
    );
    other = await openOtherTimes();
    expect(other).toHaveTextContent(
      "No 60-minute time can start in the next 4 weeks.",
    );
    weekly.unmount();

    // A duration that does not fit the slots.
    mockEmptySnapshot();
    render(
      <ResultsSnapshotPanel
        {...timeTableProps({ ...datedEvent, meetingDurationMinutes: 45 })}
      />,
    );
    await screen.findByText(/Results are current/);
    other = await openOtherTimes();
    expect(other).toHaveTextContent(
      "The meeting length does not divide into the slot length",
    );
    expect(document.getElementById("organizer-finalize")).toHaveTextContent(
      "No time can be picked until the meeting length divides into the slot length. Edit the event to fix it.",
    );
  } finally {
    nowSpy.mockRestore();
  }
});

test("opening Blocked times hides the ranked outlines and the pick until it closes", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    mockDatedSnapshot();
    const selection = selectionFromRecommendation(datedRanked, datedEvent, {
      now: DATED_NOW,
    });
    render(
      <ResultsSnapshotPanel {...timeTableProps(datedEvent, { selection })} />,
    );
    await screen.findByText(/Results are current at revision 7/);
    const rankBlock = () =>
      document.querySelector(".meeting-calendar__block--rank");
    const selectedBlock = () =>
      document.querySelector(".meeting-calendar__block--selected");
    const rail = document.querySelector("details.organizer-recommended-times");

    expect(selectedBlock()).not.toBeNull();
    await toggleRecommendedTimes();
    expect(rankBlock()).not.toBeNull();

    await openBlockedTimes();
    expect(rankBlock()).toBeNull();
    expect(selectedBlock()).toBeNull();
    expect(screen.queryByText("Recommended time")).not.toBeInTheDocument();
    expect(rail).toHaveAttribute("open");

    await userEvent.click(blockedTimesSummary());
    expect(blockedTimesDetails()).not.toHaveAttribute("open");
    expect(rankBlock()).not.toBeNull();
    expect(selectedBlock()).not.toBeNull();
    expect(screen.getByText("Recommended time")).toBeInTheDocument();
  } finally {
    nowSpy.mockRestore();
  }
});

test("ranked windows are compact chips that highlight their window on the calendar", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    mockDatedSnapshot();
    render(<ResultsSnapshotPanel {...timeTableProps(datedEvent)} />);
    await screen.findByText(/Results are current at revision 7/);
    const rail = document.querySelector("details.organizer-recommended-times");
    await toggleRecommendedTimes();

    // One chip per candidate: rank, window, weighted share; the rest of the
    // figures are in the accessible name and in the detail line below.
    const chips = within(rail).getAllByRole("button", {
      name: /choose this time/i,
    });
    expect(chips).toHaveLength(2);
    const [best, runnerUp] = chips;
    expect(best).toHaveClass("ranked-chip", "ranked-chip--best");
    expect(runnerUp).not.toHaveClass("ranked-chip--best");
    expect(best.querySelector(".ranked-chip__rank")).toHaveTextContent("#1");
    expect(best.querySelector(".ranked-chip__title")).toHaveTextContent(
      "Thu 09:30–10:30",
    );
    expect(best.querySelector(".ranked-chip__share")).toHaveTextContent("90%");
    // The name is built from the inline text as a browser reads it: spaces
    // between the parts, no tooltip repeating it.
    expect(best).toHaveAccessibleName(
      /^#1 Thu 09:30–10:30 90% weighted\s*, 80% unweighted, 3 fully available, best match, choose this time$/,
    );
    expect(best).not.toHaveAttribute("title");
    expect(best).toHaveAttribute("aria-pressed", "false");
    expect(within(rail).queryByText("Weighted")).not.toBeInTheDocument();

    // The detail line spells out the best candidate until a chip is pointed
    // at or focused, then follows it; the calendar emphasizes that window.
    const detail = () => rail.querySelector(".ranked-chips__detail");
    const block = (rank) =>
      document.querySelector(
        `.meeting-calendar__block--rank[data-rank="${rank}"]`,
      );
    expect(detail()).toHaveAttribute("data-rank", "1");
    expect(detail()).toHaveTextContent(
      "#1 Thu 09:30–10:30 · Thu, Aug 20, 2026, 9:30 AM – Thu, Aug 20, 2026, 10:30 AM · 90% weighted · 80% unweighted · 3 fully available",
    );
    expect(block(1)).not.toHaveClass("meeting-calendar__block--highlight");
    fireEvent.pointerEnter(runnerUp);
    expect(detail()).toHaveAttribute("data-rank", "2");
    expect(detail()).toHaveTextContent(
      "#2 Thu 09:00–10:00 · Thu, Aug 20, 2026, 9:00 AM – Thu, Aug 20, 2026, 10:00 AM · 50% weighted · 40% unweighted · 1 fully available",
    );
    expect(block(2)).toHaveClass("meeting-calendar__block--highlight");
    expect(block(1)).not.toHaveClass("meeting-calendar__block--highlight");
    fireEvent.pointerLeave(runnerUp);
    expect(detail()).toHaveAttribute("data-rank", "1");
    expect(block(2)).not.toHaveClass("meeting-calendar__block--highlight");
    fireEvent.focus(runnerUp);
    expect(block(2)).toHaveClass("meeting-calendar__block--highlight");
    fireEvent.blur(runnerUp);
    expect(block(2)).not.toHaveClass("meeting-calendar__block--highlight");
  } finally {
    nowSpy.mockRestore();
  }
});

test("choosing a ranked window leaves painting mode and keeps the draft", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  try {
    mockDatedSnapshot();
    const onChoose = jest.fn();
    render(
      <ResultsSnapshotPanel {...timeTableProps(datedEvent, { onChoose })} />,
    );
    await screen.findByText(/Results are current at revision 7/);

    await openBlockedTimes();
    paintCell(0);
    expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
    const rail = document.querySelector("details.organizer-recommended-times");
    await toggleRecommendedTimes();
    await userEvent.click(
      screen.getAllByRole("button", { name: /choose this time/i })[0],
    );

    expect(onChoose).toHaveBeenCalledWith(datedRanked);
    // The pick needs the picker: the step closes, the draft stays.
    expect(blockedTimesDetails()).not.toHaveAttribute("open");
    expect(calendarGrid().getAttribute("aria-label")).not.toMatch(
      /marking blocked times/,
    );
    expect(blockedTimesSummary()).toHaveTextContent("unsaved changes");
    await openBlockedTimes();
    expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
    expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  } finally {
    nowSpy.mockRestore();
  }
});

test("the calendar draws the ranked windows only while the ranked list is open", async () => {
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(DATED_NOW);
  const onSelect = jest.fn();

  try {
    mockDatedSnapshot();
    render(
      <ResultsSnapshotPanel {...timeTableProps(datedEvent, { onSelect })} />,
    );
    await screen.findByText(/Results are current at revision 7/);
    const grid = screen.getByRole("grid", { name: /^Meeting time calendar/ });
    const cell = (index) => grid.querySelector(`[data-cell-idx="${index}"]`);
    const rankBlock = () =>
      document.querySelector(".meeting-calendar__block--rank");

    // Closed list: no outline, no badge, no legend entry, no rank in the
    // cell's description...
    const rail = document.querySelector("details.organizer-recommended-times");
    expect(rail).not.toHaveAttribute("open");
    expect(rankBlock()).toBeNull();
    expect(screen.queryByText("Recommended time")).not.toBeInTheDocument();
    expect(cell(1).getAttribute("aria-label")).not.toContain(
      "Inside recommended time",
    );
    // ...but a pick inside the window is still the ranked window.
    await userEvent.click(cell(1));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        slotIndices: [1, 2],
        metrics: expect.objectContaining({ exact: true, rank: 1 }),
      }),
    );

    await toggleRecommendedTimes();
    expect(rail).toHaveAttribute("open");
    expect(rankBlock()).toHaveAttribute("data-rank", "1");
    expect(
      rankBlock().querySelector(".meeting-calendar__rank"),
    ).toHaveTextContent("#1");
    expect(screen.getByText("Recommended time")).toBeInTheDocument();
    expect(cell(1).getAttribute("aria-label")).toContain(
      "Inside recommended time #1.",
    );

    await toggleRecommendedTimes();
    expect(rail).not.toHaveAttribute("open");
    expect(rankBlock()).toBeNull();
    expect(screen.queryByText("Recommended time")).not.toBeInTheDocument();

    // Closing Finalize with the list open takes the outlines away too.
    await toggleRecommendedTimes();
    expect(rankBlock()).not.toBeNull();
    const finalize = document.getElementById("organizer-finalize");
    await userEvent.click(finalize.querySelector(":scope > summary"));
    expect(finalize).not.toHaveAttribute("open");
    await waitFor(() => expect(rankBlock()).toBeNull());
    expect(rail).not.toHaveAttribute("open");
  } finally {
    nowSpy.mockRestore();
  }
});

test("finalize stays collapsed until a pick opens it and sums up its state", async () => {
  const step = () => document.getElementById("organizer-finalize");
  const summary = () => step().querySelector("summary");
  const { rerender } = renderFinalize(null);
  expect(step()).not.toHaveAttribute("open");
  expect(summary()).toHaveTextContent("No time selected yet");
  expect(summary()).toContainElement(
    screen.getByRole("heading", { level: 4, name: "Finalize" }),
  );

  // A pick opens the step and names the time in the summary.
  rerender(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={calendarSelection}
    />,
  );
  expect(step()).toHaveAttribute("open");
  expect(summary()).toHaveTextContent(/Selected · .*9:00/);
  expect(screen.getByText("Custom window")).toBeInTheDocument();

  // The organizer can close it; the next pick opens it again.
  await userEvent.click(summary());
  expect(step()).not.toHaveAttribute("open");
  rerender(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={{ ...calendarSelection }}
    />,
  );
  expect(step()).toHaveAttribute("open");

  // Clearing the pick leaves the step as it is.
  rerender(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
    />,
  );
  expect(step()).toHaveAttribute("open");
  expect(summary()).toHaveTextContent("No time selected yet");
  expect(step()).toHaveTextContent("Pick a time on the calendar.");

  // The summary counts the recommendations, and the empty state says what
  // the Time Table hands it to say.
  rerender(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
      recommendedCount={3}
      emptyPrompt="Pick one of three."
      picker={<p>Pickers</p>}
    />,
  );
  expect(summary()).toHaveTextContent("No time selected yet · 3 recommended");
  expect(step()).toHaveTextContent("Pickers");
  expect(step()).toHaveTextContent("Pick one of three.");

  // A confirmed meeting is summed up too, collapsed on a fresh mount.
  const finalized = {
    ...baseEvent,
    status: "finalized",
    finalMeeting: { ...recommendation, location: "", active: true },
  };
  rerender(
    <FinalizeScalePanel
      event={finalized}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
    />,
  );
  expect(summary()).toHaveTextContent(/Finalized · .*9:00/);
  expect(
    screen.getByRole("button", { name: "Download calendar (.ics)" }),
  ).toBeInTheDocument();
});

test("the blocked-times step sits first under the calendar and saves through the workspace", async () => {
  const onEventSaved = jest.fn();
  updateEvent.mockResolvedValue({
    event: blockedWeeklyEvent({ "weekday:1": [0] }, { version: 5 }),
    responsesReset: 0,
  });
  renderTimeTable(weeklyEvent, { onEventSaved });
  await screen.findByText(/Results are current/);

  const stack = document.querySelector(".time-table__sections");
  expect(Array.from(stack.children).map((step) => step.id)).toEqual([
    "organizer-blocked-times",
    "organizer-finalize",
  ]);
  // The recommended times are inside Finalize, not a step of their own.
  expect(document.getElementById("organizer-finalize")).toContainElement(
    document.getElementById("organizer-recommended-times"),
  );
  expect(stack.previousElementSibling).toHaveClass("meeting-calendar");
  // One time table: the calendar is the only grid, before and after opening.
  expect(screen.getAllByRole("grid")).toHaveLength(1);
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(blockedTimesDetails()).toHaveTextContent("0 slots blocked");
  await openBlockedTimes();
  expect(screen.getAllByRole("grid")).toHaveLength(1);

  paintCell(0);
  await userEvent.click(saveButton());
  await waitFor(() =>
    expect(updateEvent).toHaveBeenCalledWith(
      "SCALE1",
      { blockedSlots: { "weekday:1": [0] }, expectedVersion: 4 },
      "token",
    ),
  );
  await waitFor(() =>
    expect(onEventSaved).toHaveBeenCalledWith({
      event: expect.objectContaining({ version: 5 }),
      responsesReset: 0,
    }),
  );
  expect(
    within(paintBar()).getByText("Blocked times saved."),
  ).toBeInTheDocument();
});

test("results note blocked slots only when the snapshot lists them", async () => {
  fetchEventResults
    .mockResolvedValueOnce({
      status: "fresh",
      requestedRevision: 7,
      computedRevision: 7,
      results: { recommendations: [], blockedSlotIndices: [3, 4] },
    })
    .mockResolvedValueOnce({
      status: "fresh",
      requestedRevision: 8,
      computedRevision: 8,
      results: { recommendations: [] },
    })
    .mockResolvedValueOnce({
      status: "fresh",
      requestedRevision: 9,
      computedRevision: 9,
      results: { recommendations: [], blockedSlotIndices: "3,4" },
    });
  const panelProps = {
    event: weeklyEvent,
    getToken,
    onChoose: jest.fn(),
    onSelect: jest.fn(),
  };
  const { rerender } = render(
    <ResultsSnapshotPanel {...panelProps} invalidationKey={0} />,
  );
  expect(
    await screen.findByText("2 blocked slots are excluded from these results."),
  ).toBeInTheDocument();

  // A snapshot computed before blocking shipped simply has no note.
  rerender(<ResultsSnapshotPanel {...panelProps} invalidationKey={1} />);
  await screen.findByText(/Results are current at revision 8/);
  expect(
    screen.queryByText(/blocked slots are excluded/),
  ).not.toBeInTheDocument();

  rerender(<ResultsSnapshotPanel {...panelProps} invalidationKey={2} />);
  await screen.findByText(/Results are current at revision 9/);
  expect(
    screen.queryByText(/blocked slots are excluded/),
  ).not.toBeInTheDocument();
});
