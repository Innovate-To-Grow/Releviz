/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

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

jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  downloadFinalCalendar: jest.fn(),
  fetchDeliveryRequest: jest.fn(),
  fetchEventResults: jest.fn(),
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));

import {
  DeliveryRequestProgress,
  EventControls,
  FinalizeScalePanel,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import {
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
  updateEventLifecycle,
} from "@/lib/api/events";
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
  render(
    <DeliveryRequestProgress
      initialRequest={{
        id: "delivery-1",
        summary: { recipientTotal: 5, permanentFailure: 2, canceled: 1 },
      }}
      getToken={getToken}
      onChange={onChange}
    />,
  );

  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
    "Needs attention",
  );
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
    "1 canceled",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh progress" }),
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
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent(
    "2 queued",
  );
});

test("delivery progress exposes refresh and retry errors", async () => {
  fetchDeliveryRequest.mockRejectedValueOnce(new Error("progress unavailable"));
  retryDeliveryRequest.mockRejectedValueOnce(new Error("retry unavailable"));
  render(
    <DeliveryRequestProgress
      initialRequest={{ id: "delivery-2", delivery: { permanentFailure: 1 } }}
      getToken={getToken}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh progress" }),
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
  expect(within(controls).getByRole("status")).toHaveTextContent(
    "12 reminder emails were queued",
  );
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
  render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      selection={recommendation}
      onBrowseResults={jest.fn()}
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
  expect(
    screen.getByLabelText("Finalization delivery progress"),
  ).toHaveTextContent("4 queued");

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
      onBrowseResults={jest.fn()}
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
      onBrowseResults={jest.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Download calendar (.ics)" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("download failed");
  click.mockRestore();
});

test("finalize empty and inactive states return to results and block review", async () => {
  const onBrowseResults = jest.fn();
  const { rerender } = render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={null}
      onBrowseResults={onBrowseResults}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Browse results" }));
  expect(onBrowseResults).toHaveBeenCalled();

  rerender(
    <FinalizeScalePanel
      event={{ ...baseEvent, status: "archived" }}
      setEvent={jest.fn()}
      getToken={getToken}
      selection={recommendation}
      onBrowseResults={onBrowseResults}
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
      onBrowseResults={jest.fn()}
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
    expect(within(controls).getByRole("status")).toHaveTextContent(
      "3 reminder emails were queued",
    ),
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

test("results refresh on demand and show a finalized event's time zone fallback", async () => {
  fetchEventResults.mockResolvedValue({
    results: {
      status: "ready",
      recommendations: [recommendation],
      revision: 2,
      generatedAt: "2026-08-19T12:00:00Z",
    },
    revision: 2,
  });
  render(
    <ResultsSnapshotPanel
      event={{ ...baseEvent, timezone: "Not/AZone" }}
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
  await userEvent.click(
    await screen.findByRole("button", { name: "Refresh results" }),
  );
  await waitFor(() => expect(fetchEventResults).toHaveBeenCalledTimes(2));
});
