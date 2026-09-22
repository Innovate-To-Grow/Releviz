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
import BlockedSlotsEditor from "@/components/schedule/BlockedSlotsEditor";
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
  // while the ranked rail still lists the legacy recommendation.
  expect(
    screen.getByText("No schedule slots are configured."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("grid", { name: /Meeting time calendar/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Ranked windows" }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Choose this time" }),
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
  expect(block).toHaveTextContent(
    "Pick a window on the calendar or choose a ranked one.",
  );
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
  expect(screen.queryByText(/Ranked #/)).not.toBeInTheDocument();
  expect(screen.getByText("In person")).toBeInTheDocument();
  expect(
    screen.getByText(
      "At least 75% weighted · 70% unweighted across this window (lowest slot). Exact attendance counts appear after Review attendance.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      "The suggested date has passed; this uses the next occurrence.",
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/9:00 AM/)).toBeInTheDocument();
  expect(screen.getByText(/\(UTC\)/)).toBeInTheDocument();

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

  expect(screen.getByText("Ranked #2")).toBeInTheDocument();
  expect(screen.queryByText("Custom window")).not.toBeInTheDocument();
  expect(
    screen.getByText("75% weighted · 70% unweighted · 5 fully available"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/At least/)).not.toBeInTheDocument();
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
  expect(screen.queryByText(/At least/)).not.toBeInTheDocument();
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
    name: "Choose this time",
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
  expect(screen.getByRole("grid")).toHaveAccessibleName(
    `Meeting time calendar, ${formatWeekLabel(week)}`,
  );

  rerender(<ResultsSnapshotPanel {...panelProps} selection={selection} />);
  expect(screen.getByRole("button", { name: "Selected time" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
    await screen.findByRole("button", { name: "Choose this time" }),
  ).toBeInTheDocument();
  expect(document.querySelector(".result-option__time")).toHaveTextContent(
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
    screen.queryByText("Calculating the best options"),
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
  const rail = await screen.findByRole("complementary", {
    name: "Ranked windows",
  });
  const disclosure = rail.querySelector("details");
  expect(disclosure).not.toHaveAttribute("open");
  await waitFor(() =>
    expect(rail).toHaveTextContent("2 candidates · best Tue 09:00–10:00"),
  );
  // Buttons exist for tests and assistive tech, but are hidden until opened.
  expect(
    within(rail).getAllByRole("button", { name: "Choose this time" }),
  ).toHaveLength(2);
  expect(
    within(rail).getAllByRole("button", { name: "Choose this time" })[0],
  ).not.toBeVisible();
  await userEvent.click(within(rail).getByText("Ranked windows"));
  expect(disclosure).toHaveAttribute("open");
  expect(
    within(rail).getAllByRole("button", { name: "Choose this time" })[0],
  ).toBeVisible();
  // The Finalize step renders inside the same results panel.
  expect(
    screen.getByRole("heading", { level: 4, name: "Finalize" }),
  ).toBeInTheDocument();
  expect(document.getElementById("organizer-finalize")).toHaveTextContent(
    "No time selected yet",
  );
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
  const rail = await screen.findByRole("complementary", {
    name: "Ranked windows",
  });
  await waitFor(() =>
    expect(rail).toHaveTextContent("Calculating the best options"),
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
      screen.getByRole("complementary", { name: "Ranked windows" }),
    ).toHaveTextContent("No recommendation yet"),
  );
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

// Stores saved events like the workspace does, so a save or a conflict
// reload re-renders the overview with the newer event.
function StatefulOverview({ initialEvent, onEventSaved }) {
  const [event, setEvent] = useState(initialEvent);
  const handleSaved = async (result) => {
    onEventSaved?.(result);
    if (result?.event) setEvent(result.event);
  };
  return <OverviewPanel event={event} onEventSaved={handleSaved} />;
}

// The disclosure is found by its class (not its heading text) and toggled
// through its summary; the editor grid carries the same accessible name
// without rendering a second heading.
const blockedTimesDetails = () =>
  document.querySelector("details.organizer-blocked-times");
const blockedTimesSummary = () =>
  blockedTimesDetails().querySelector("summary");
const editorGrid = () => screen.getByRole("grid", { name: "Blocked times" });
const editorCell = (index) =>
  editorGrid().querySelector(`[data-cell-idx="${index}"]`);
const paintCell = (index) =>
  fireEvent.pointerDown(editorCell(index), {
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
const saveButton = () =>
  screen.getByRole("button", { name: "Save blocked times" });
const DISCARDED_MESSAGE =
  "Unsaved blocked-time marks were discarded because the event changed.";

test("overview opens the blocked-times editor by default until the event has blocks", () => {
  const { unmount } = render(
    <OverviewPanel event={weeklyEvent} onEventSaved={jest.fn()} />,
  );

  const details = blockedTimesDetails();
  expect(details).toHaveAttribute("open");
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
  expect(
    screen.getByText(
      "Mark the parts of each day that are not available for this event. Participants see these times greyed out.",
    ),
  ).toBeInTheDocument();
  expect(editorGrid()).toBeInTheDocument();
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
  unmount();

  // The API always emits `blockedSlots: {}` for a fresh event (truthy, but
  // empty), which must also open the disclosure.
  const { unmount: unmountEmpty } = render(
    <OverviewPanel event={blockedWeeklyEvent({})} onEventSaved={jest.fn()} />,
  );
  expect(blockedTimesDetails()).toHaveAttribute("open");
  expect(blockedTimesDetails()).toHaveTextContent("0 slots blocked");
  expect(saveButton()).toBeDisabled();
  unmountEmpty();

  render(
    <OverviewPanel
      event={blockedWeeklyEvent({ "weekday:1": [1], "weekday:3": [2] })}
      onEventSaved={jest.fn()}
    />,
  );
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
  // The stored blocks hydrate the marks (slot 1 on Mon, slot 6 on Wed).
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
});

test("overview counts blocked rows defensively and keeps the disclosure controlled", async () => {
  const { unmount } = render(
    <OverviewPanel
      event={{ ...weeklyEvent, blockedSlots: "not-a-map" }}
      onEventSaved={jest.fn()}
    />,
  );
  expect(blockedTimesDetails()).toHaveTextContent("0 slots blocked");
  expect(blockedTimesDetails()).toHaveAttribute("open");

  // Toggling the summary updates the controlled state.
  await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
  await userEvent.click(blockedTimesSummary());
  expect(blockedTimesDetails()).toHaveAttribute("open");
  unmount();

  render(
    <OverviewPanel
      event={{
        ...weeklyEvent,
        blockedSlots: { "weekday:1": "rows?", "weekday:3": [0, 3] },
      }}
      onEventSaved={jest.fn()}
    />,
  );
  expect(blockedTimesDetails()).toHaveTextContent("2 slots blocked");
  expect(blockedTimesDetails()).not.toHaveAttribute("open");
});

test("blocked times editor paints, saves the marked rows, and re-hydrates from the saved event", async () => {
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
  render(
    <StatefulOverview initialEvent={weeklyEvent} onEventSaved={onEventSaved} />,
  );

  paintCell(0);
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(editorCell(0)).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();

  await userEvent.click(saveButton());

  const savingButton = await screen.findByRole("button", { name: "Saving…" });
  expect(savingButton).toBeDisabled();
  expect(savingButton).toHaveAttribute("aria-busy", "true");
  expect(editorGrid()).toHaveAttribute("aria-readonly", "true");
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
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
  // The stored event now carries the block, so there is nothing to save,
  // and the disclosure stays open because it was decided once on mount.
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(saveButton()).toBeDisabled();
  expect(editorGrid()).not.toHaveAttribute("aria-readonly");
  expect(blockedTimesDetails()).toHaveTextContent("1 slots blocked");
  expect(blockedTimesDetails()).toHaveAttribute("open");

  // Painting again clears the status.
  paintCell(3);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
});

test("blocked times editor unmarks with the Open brush and clears every mark", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  render(
    <OverviewPanel
      event={blockedWeeklyEvent({ "weekday:1": [1], "weekday:3": [2] })}
      onEventSaved={jest.fn()}
    />,
  );
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
    editorGrid().querySelectorAll('[data-blocked-paint="true"]'),
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
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
});

test("blocked times editor recovers from a conflict by loading the newer event", async () => {
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
  render(
    <StatefulOverview initialEvent={weeklyEvent} onEventSaved={onEventSaved} />,
  );

  paintCell(0);
  await userEvent.click(saveButton());

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "The event changed in another session. Reload and try again.",
  );
  expect(onEventSaved).not.toHaveBeenCalled();
  await userEvent.click(
    within(alert).getByRole("button", { name: "Reload latest event" }),
  );

  expect(onEventSaved).toHaveBeenCalledWith({ event: newerEvent });
  expect(reloadPage).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  // The unsaved mark gave way to the newer event's blocks.
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(7)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(blockedTimesDetails()).toHaveTextContent("1 slots blocked");
  expect(saveButton()).toBeDisabled();
});

test("blocked times editor keeps unsaved marks across an inline event edit", async () => {
  const onEventSaved = jest.fn();
  updateEvent.mockImplementation(async (_code, payload) => ({
    event: blockedWeeklyEvent(payload.blockedSlots, {
      name: "Updated scale event",
      version: payload.expectedVersion + 1,
    }),
    responsesReset: 0,
  }));
  render(
    <StatefulOverview
      initialEvent={blockedWeeklyEvent()}
      onEventSaved={onEventSaved}
    />,
  );

  paintCell(0);
  paintCell(5);
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

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
});

test("blocked times editor announces unsaved marks it discards for a changed event", () => {
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
  const { rerender } = render(
    <OverviewPanel event={stored} onEventSaved={jest.fn()} />,
  );
  paintCell(0);
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

  // A workspace refresh that returns the same schedule and blocks (a fresh
  // object with a newer version) leaves the paint alone.
  rerender(
    <OverviewPanel
      event={{
        ...stored,
        version: stored.version + 1,
        slotGroups: stored.slotGroups.map((group) => ({ ...group })),
      }}
      onEventSaved={jest.fn()}
    />,
  );
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  // Another session changed the blocks: they replace the paint, with a note.
  rerender(
    <OverviewPanel
      event={blockedWeeklyEvent({ "weekday:3": [2] }, { version: 9 })}
      onEventSaved={jest.fn()}
    />,
  );
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(1)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByRole("status")).toHaveTextContent(DISCARDED_MESSAGE);
  expect(screen.getByRole("status")).toHaveClass("alert-warning");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();

  // Painting again clears the note.
  paintCell(3);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("2 slots marked")).toBeInTheDocument();

  // A schedule edit that changes the index space resets the marks too.
  rerender(<OverviewPanel event={renamedDays} onEventSaved={jest.fn()} />);
  expect(editorCell(3)).toHaveAttribute("data-blocked-paint", "false");
  expect(editorCell(6)).toHaveAttribute("data-blocked-paint", "false");
  expect(screen.getByRole("status")).toHaveTextContent(DISCARDED_MESSAGE);
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();

  // With nothing unsaved, a change of blocks re-hydrates quietly.
  rerender(
    <OverviewPanel
      event={{
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
      }}
      onEventSaved={jest.fn()}
    />,
  );
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "true");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

test("blocked times editor reloads the page for a conflict without the newer event", async () => {
  const onEventSaved = jest.fn();
  updateEvent.mockRejectedValueOnce(
    Object.assign(new Error("Version mismatch"), { status: 409 }),
  );
  render(<OverviewPanel event={weeklyEvent} onEventSaved={onEventSaved} />);

  paintCell(2);
  await userEvent.click(saveButton());

  const alert = await screen.findByRole("alert");
  await userEvent.click(
    within(alert).getByRole("button", { name: "Reload latest event" }),
  );
  expect(reloadPage).toHaveBeenCalledTimes(1);
  expect(onEventSaved).not.toHaveBeenCalled();
  // Whatever was painted stays until the page reloads.
  expect(editorCell(2)).toHaveAttribute("data-blocked-paint", "true");
});

test("blocked times editor surfaces other failures without a reload action", async () => {
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
  render(<OverviewPanel event={weeklyEvent} onEventSaved={jest.fn()} />);

  paintCell(4);
  await userEvent.click(saveButton());
  let alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Blocked slots leave no open window.");
  expect(
    within(alert).queryByRole("button", { name: "Reload latest event" }),
  ).not.toBeInTheDocument();
  // Painting again clears the failure.
  paintCell(5);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  // A 409 demanding a reset cannot come from blocks; it is shown as is.
  await userEvent.click(saveButton());
  alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Responses would be reset.");
  expect(
    within(alert).queryByRole("button", { name: "Reload latest event" }),
  ).not.toBeInTheDocument();

  // Clearing every mark also clears the failure; with no stored blocks there
  // is nothing to save until a mark returns.
  await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
  paintCell(6);
  await userEvent.click(saveButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
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
])("blocked times editor is read-only for %s", (_label, overrides, reason) => {
  render(
    <OverviewPanel
      event={blockedWeeklyEvent({ "weekday:1": [1] }, overrides)}
      onEventSaved={jest.fn()}
    />,
  );

  expect(saveButton()).toBeDisabled();
  expect(saveButton()).toHaveAttribute("title", reason);
  const clearAll = screen.getByRole("button", { name: "Clear all" });
  expect(clearAll).toBeDisabled();
  expect(clearAll).toHaveAttribute("title", reason);
  expect(screen.getByRole("button", { name: "Blocked" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  expect(editorGrid()).toHaveAttribute("aria-readonly", "true");
  expect(editorCell(0)).not.toHaveAttribute("tabindex");
  paintCell(0);
  expect(editorCell(0)).toHaveAttribute("data-blocked-paint", "false");
  expect(screen.getByText("1 slots marked")).toBeInTheDocument();
});

test("blocked times editor handles events without slot groups or slots", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  const { unmount } = render(
    <OverviewPanel event={baseEvent} onEventSaved={jest.fn()} />,
  );
  const details = blockedTimesDetails();
  expect(details).toHaveAttribute("open");
  expect(
    within(details).getByText("No schedule slots are configured."),
  ).toBeInTheDocument();
  expect(screen.getByText("0 slots marked")).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
  unmount();

  // A group without slots contributes nothing to the marks.
  render(
    <OverviewPanel
      event={{
        ...weeklyEvent,
        slotGroups: [
          { key: "weekday:1", label: "Mon" },
          ...weeklyEvent.slotGroups.slice(1),
        ],
      }}
      onEventSaved={jest.fn()}
    />,
  );
  expect(editorGrid().querySelectorAll("[data-cell-idx]")).toHaveLength(4);
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

test("blocked times editor stands alone without a lock or a save listener", async () => {
  updateEvent.mockResolvedValue({ event: weeklyEvent });
  render(<BlockedSlotsEditor event={weeklyEvent} />);

  // Unlocked by default: no lock title, and the grid takes paint.
  expect(saveButton()).not.toHaveAttribute("title");
  expect(screen.getByRole("button", { name: "Clear all" })).not.toHaveAttribute(
    "title",
  );
  expect(editorGrid()).not.toHaveAttribute("aria-readonly");
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
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Blocked times saved.",
  );
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
