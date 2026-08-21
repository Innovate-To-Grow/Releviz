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
import { OrganizerHeader } from "@/components/schedule/OrganizerPanels";
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
  expect(within(controls).getByText("Active")).toBeInTheDocument();
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
      recommendation={recommendation}
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
      recommendation={null}
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
      recommendation={null}
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
      recommendation={null}
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
      recommendation={recommendation}
      onBrowseResults={onBrowseResults}
    />,
  );
  expect(screen.getByRole("note")).toHaveTextContent("Reactivate this event");
  expect(
    screen.getByRole("button", { name: "Review attendance" }),
  ).toBeDisabled();
});
