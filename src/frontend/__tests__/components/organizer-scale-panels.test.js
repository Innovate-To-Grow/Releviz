/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("@/components/event/EventDetailsGrid", () => ({
  __esModule: true,
  default: ({ extraCards = [] }) => (
    <div>
      {extraCards.map((card) => (
        <span key={card.label}>{`${card.label}: ${card.value}`}</span>
      ))}
    </div>
  ),
}));
jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  downloadFinalCalendar: jest.fn(),
  fetchDeliveryRequest: jest.fn(),
  fetchEventResults: jest.fn(),
  launchEvent: jest.fn(),
  previewFinalMeeting: jest.fn(),
  retryDeliveryRequest: jest.fn(),
  sendReminders: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));

import {
  DeliveryRequestProgress,
  FinalizeScalePanel,
  OverviewPanel,
  ResultsSnapshotPanel,
} from "@/components/schedule/OrganizerScalePanels";
import {
  confirmFinalMeeting,
  downloadFinalCalendar,
  fetchDeliveryRequest,
  fetchEventResults,
  launchEvent,
  previewFinalMeeting,
  retryDeliveryRequest,
  sendReminders,
  updateEventLifecycle,
} from "@/lib/api/events";

const getToken = jest.fn().mockResolvedValue("token");
const baseEvent = {
  code: "SCALE1",
  name: "Scale event",
  status: "open",
  version: 4,
  accessMode: "invite_only",
  meetingDurationMinutes: 60,
  slotMinutes: 30,
  resultsRevision: 7,
  timezone: "UTC",
  location: "Room 4",
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
    />
  );

  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent("Needs attention");
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent("1 canceled");
  await userEvent.click(screen.getByRole("button", { name: "Refresh progress" }));
  await waitFor(() => expect(fetchDeliveryRequest).toHaveBeenCalledWith("delivery-1", "token"));
  await userEvent.click(screen.getByRole("button", { name: "Retry failed recipients" }));
  await waitFor(() => expect(retryDeliveryRequest).toHaveBeenCalledWith("delivery-1", "token"));
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent("2 queued");
});

test("delivery progress exposes refresh and retry errors", async () => {
  fetchDeliveryRequest.mockRejectedValueOnce(new Error("progress unavailable"));
  retryDeliveryRequest.mockRejectedValueOnce(new Error("retry unavailable"));
  render(
    <DeliveryRequestProgress
      initialRequest={{ id: "delivery-2", delivery: { permanentFailure: 1 } }}
      getToken={getToken}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh progress" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("progress unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Retry failed recipients" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("retry unavailable");
});

test("overview queues reminders and closes an open event", async () => {
  const setEvent = jest.fn();
  const setDeliveryRequest = jest.fn();
  sendReminders.mockResolvedValue({
    deliveryRequestId: "reminder-1",
    recipientCount: 12,
    delivery: { total: 12, pending: 12 },
  });
  updateEventLifecycle.mockResolvedValue({ event: { ...baseEvent, status: "closed", version: 5 } });
  render(
    <OverviewPanel
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      deliveryRequest={null}
      setDeliveryRequest={setDeliveryRequest}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "Queue reminders" }));
  await waitFor(() =>
    expect(setDeliveryRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reminder-1", operation: "reminder" })
    )
  );
  expect(screen.getByRole("status")).toHaveTextContent("12 reminder emails were queued");
  await userEvent.click(screen.getByRole("button", { name: "Close responses" }));
  await waitFor(() =>
    expect(updateEventLifecycle).toHaveBeenCalledWith(
      baseEvent.code,
      expect.objectContaining({ status: "closed", expectedVersion: 4 }),
      "token"
    )
  );
  expect(setEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
});

test("overview reopens a finalized event, clears an expired deadline, and tracks cancellation", async () => {
  const setEvent = jest.fn();
  const setDeliveryRequest = jest.fn();
  updateEventLifecycle.mockResolvedValue({
    event: { ...baseEvent, status: "open", version: 5 },
    cancellationDeliveryRequestId: "cancel-1",
    cancellationEnqueued: 9,
  });
  render(
    <OverviewPanel
      event={{
        ...baseEvent,
        status: "finalized",
        responseDeadline: "2020-01-01T00:00:00Z",
      }}
      setEvent={setEvent}
      getToken={getToken}
      deliveryRequest={null}
      setDeliveryRequest={setDeliveryRequest}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "Reopen event" }));
  await waitFor(() =>
    expect(updateEventLifecycle).toHaveBeenCalledWith(
      baseEvent.code,
      expect.objectContaining({ status: "open", responseDeadline: null }),
      "token"
    )
  );
  expect(setDeliveryRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "cancel-1",
      operation: "final_cancellation",
      delivery: { total: 9, pending: 9 },
    })
  );
});

test("overview surfaces launch and lifecycle errors with the latest event", async () => {
  const latest = { ...baseEvent, status: "draft", version: 6 };
  const conflict = new Error("launch conflict");
  conflict.event = latest;
  launchEvent.mockRejectedValueOnce(conflict);
  const setEvent = jest.fn();
  const { rerender } = render(
    <OverviewPanel
      event={{ ...baseEvent, status: "draft" }}
      setEvent={setEvent}
      getToken={getToken}
      deliveryRequest={null}
      setDeliveryRequest={jest.fn()}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Launch and send invitations" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("launch conflict");
  expect(setEvent).toHaveBeenCalledWith(latest);

  updateEventLifecycle.mockRejectedValueOnce(new Error("cannot archive"));
  rerender(
    <OverviewPanel
      event={baseEvent}
      setEvent={setEvent}
      getToken={getToken}
      deliveryRequest={null}
      setDeliveryRequest={jest.fn()}
    />
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
    />
  );
  expect(await screen.findByText(/Results are current at revision 5/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Choose this time" }));
  expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: "legacy-1" }));

  rerender(
    <ResultsSnapshotPanel
      event={baseEvent}
      getToken={getToken}
      invalidationKey={1}
      onChoose={onChoose}
    />
  );
  expect(await screen.findByText(/Result calculation failed/)).toBeInTheDocument();
  expect(screen.getByText("No valid meeting window is available yet.")).toBeInTheDocument();
});

test("results expose request failures", async () => {
  fetchEventResults.mockRejectedValueOnce(new Error("snapshot unavailable"));
  render(
    <ResultsSnapshotPanel
      event={baseEvent}
      getToken={getToken}
      invalidationKey={0}
      onChoose={jest.fn()}
    />
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("snapshot unavailable");
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
    />
  );
  fireEvent.change(screen.getByLabelText("Location or meeting link"), {
    target: { value: "https://meet.example/scale" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Review attendance" }));
  expect(await screen.findByText("4")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Finalize meeting" }));
  await waitFor(() => expect(setEvent).toHaveBeenCalled());
  expect(screen.getByLabelText("Delivery progress")).toHaveTextContent("4 queued");

  confirmFinalMeeting.mockRejectedValueOnce(new Error("confirmation failed"));
  await userEvent.click(screen.getByRole("button", { name: "Finalize meeting" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("confirmation failed");
});

test("finalized organizers can download ICS and see download errors", async () => {
  const createObjectURL = jest.fn().mockReturnValue("blob:calendar");
  const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
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
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Download calendar (.ics)" }));
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
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Download calendar (.ics)" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("download failed");
  click.mockRestore();
});

test("finalize empty and draft states return to results and block review", async () => {
  const onBrowseResults = jest.fn();
  const { rerender } = render(
    <FinalizeScalePanel
      event={baseEvent}
      setEvent={jest.fn()}
      getToken={getToken}
      recommendation={null}
      onBrowseResults={onBrowseResults}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Browse results" }));
  expect(onBrowseResults).toHaveBeenCalled();

  rerender(
    <FinalizeScalePanel
      event={{ ...baseEvent, status: "draft" }}
      setEvent={jest.fn()}
      getToken={getToken}
      recommendation={recommendation}
      onBrowseResults={onBrowseResults}
    />
  );
  expect(screen.getByRole("note")).toHaveTextContent("Launch this event");
  expect(screen.getByRole("button", { name: "Review attendance" })).toBeDisabled();
});
