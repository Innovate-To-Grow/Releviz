/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("@material/web/checkbox/checkbox.js", () => ({}), { virtual: true });
jest.mock("@material/web/dialog/dialog.js", () => ({}), { virtual: true });
jest.mock("@material/web/slider/slider.js", () => ({}), { virtual: true });
jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), { virtual: true });

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("@/components/event/EventDetailsGrid", () => ({
  __esModule: true,
  default: ({ event, extraCards = [] }) => (
    <div data-testid="event-details">
      {event.name}
      {extraCards.map((card) => (
        <span key={card.label}>
          {card.label}:{card.value}
        </span>
      ))}
    </div>
  ),
}));

jest.mock("@/components/schedule/ScheduleGrid", () => ({
  __esModule: true,
  default: ({ label = "Schedule", schedule = [], readOnly, onCellPaint }) => (
    <div data-testid={`grid-${label}`}>
      <span>{schedule.join(",")}</span>
      {onCellPaint && (
        <button type="button" disabled={readOnly} onMouseDown={(event) => onCellPaint(0, event)}>
          Paint {label}
        </button>
      )}
    </div>
  ),
}));

jest.mock("@/lib/api/participants", () => ({
  createManagedParticipant: jest.fn(),
  deleteParticipant: jest.fn(),
  fetchCurrentParticipant: jest.fn(),
  fetchParticipants: jest.fn(),
  fetchParticipantsIncludeHidden: jest.fn(),
  joinEvent: jest.fn(),
  unhideParticipant: jest.fn(),
  updateParticipant: jest.fn(),
}));

jest.mock("@/lib/api/events", () => ({
  confirmFinalMeeting: jest.fn(),
  fetchEventResults: jest.fn(),
  fetchFinalization: jest.fn(),
  fetchInvitations: jest.fn(),
  previewFinalMeeting: jest.fn(),
  sendInvitations: jest.fn(),
  sendReminders: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import EventContext from "@/components/event/EventContext";
import ParticipantView from "@/components/schedule/ParticipantView";
import { fetchCurrentParticipant, joinEvent, updateParticipant } from "@/lib/api/participants";
import { fetchEventResults } from "@/lib/api/events";

const member = { id: "member-1", displayName: "Morgan Member" };
const slots = [
  {
    key: "2026-08-18",
    label: "Tuesday",
    slots: [
      { index: 0, startsAt: "2026-08-18T09:00:00Z", endsAt: "2026-08-18T09:30:00Z" },
      { index: 1, startsAt: "2026-08-18T09:30:00Z", endsAt: "2026-08-18T10:00:00Z" },
    ],
  },
];
const baseEvent = {
  code: "EVENT123",
  name: "Planning session",
  mode: "mixed",
  location: "Room 4",
  status: "open",
  version: 3,
  timezone: "UTC",
  slotMinutes: 30,
  slotGroups: slots,
  responseDeadline: "2099-08-20T17:00:00Z",
  participantViewPermission: "realtime",
  daySelectionType: "specific_dates",
  finalMeeting: null,
};

function auth(user = member, loading = false) {
  useAuth.mockReturnValue({
    user,
    loading,
    getToken: jest.fn().mockResolvedValue("token"),
  });
}

function setCustomElementValue(element, value) {
  element.value = value;
  fireEvent(element, new Event("input", { bubbles: true }));
}

function participant(id, userId, name, overrides = {}) {
  return {
    id,
    user_id: userId,
    name,
    availabilityInperson: [0, 0],
    availabilityVirtual: [0, 0],
    submitted: false,
    hidden: 0,
    sort_order: 0,
    group_name: "",
    version: 1,
    ...overrides,
  };
}

function renderParticipant(event = baseEvent, context = {}) {
  return render(
    <EventContext.Provider value={{ event, numSlots: 2, ...context }}>
      <ParticipantView />
    </EventContext.Provider>,
  );
}

const sharedResults = {
  countedResponseTotal: 2,
  unansweredParticipantTotal: 1,
  excludedParticipantTotal: 1,
  calculationBasis: { weighted: { totalWeight: 1.5 } },
  channels: {
    inperson: { weighted: [1, 0.5], unweighted: [1, 0.5] },
    virtual: { weighted: [0.5, 1], unweighted: [0.5, 1] },
  },
  recommendations: [
    {
      rank: 1,
      label: "Tue, Aug 18, 9:00 AM",
      channel: "inperson",
      slotIndex: 0,
      suggestedStartsAt: "2026-08-18T09:00:00Z",
      suggestedEndsAt: "2026-08-18T09:30:00Z",
      weightedAvailability: 1,
      fullyAvailableParticipantTotal: 2,
    },
  ],
  recommendationBasis: { status: "ranked" },
};

describe("participant workflow", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    auth();
    fetchEventResults.mockRejectedValue(new Error("Not available yet"));
    fetchCurrentParticipant.mockResolvedValue({ participant: null, scheduleDataIncluded: false });
    joinEvent.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName),
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("request-key") },
    });
  });

  test("a response intent joins a new participant exactly once", async () => {
    const consumeRespondIntent = jest.fn();

    renderParticipant(baseEvent, {
      respondIntent: true,
      consumeRespondIntent,
    });

    expect(
      await screen.findByText(`Welcome, ${member.displayName}`),
    ).toBeInTheDocument();
    expect(fetchCurrentParticipant).toHaveBeenCalledTimes(1);
    expect(joinEvent).toHaveBeenCalledTimes(1);
    expect(joinEvent).toHaveBeenCalledWith(baseEvent.code, "token");
    expect(consumeRespondIntent).toHaveBeenCalledTimes(1);

    await act(async () => {});
    expect(joinEvent).toHaveBeenCalledTimes(1);
  });

  test("a response intent resumes an existing participant without joining again", async () => {
    const consumeRespondIntent = jest.fn();
    fetchCurrentParticipant.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName),
      scheduleDataIncluded: true,
    });

    renderParticipant(baseEvent, {
      respondIntent: true,
      consumeRespondIntent,
    });

    expect(
      await screen.findByText(`Welcome, ${member.displayName}`),
    ).toBeInTheDocument();
    expect(joinEvent).not.toHaveBeenCalled();
    expect(consumeRespondIntent).toHaveBeenCalledTimes(1);
  });

  test("a failed automatic join is not retried and leaves the manual action available", async () => {
    const consumeRespondIntent = jest.fn();
    joinEvent.mockRejectedValue(new Error("Invitation required"));

    renderParticipant(baseEvent, {
      respondIntent: true,
      consumeRespondIntent,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't start your response: Invitation required",
    );
    expect(
      screen.getByRole("button", { name: `Join as ${member.displayName}` }),
    ).toBeInTheDocument();
    expect(joinEvent).toHaveBeenCalledTimes(1);
    expect(consumeRespondIntent).toHaveBeenCalledTimes(1);

    await act(async () => {});
    expect(joinEvent).toHaveBeenCalledTimes(1);
  });

  test("does not auto-join when an event is no longer accepting responses", async () => {
    const consumeRespondIntent = jest.fn();

    renderParticipant(
      { ...baseEvent, status: "closed" },
      { respondIntent: true, consumeRespondIntent },
    );

    expect(
      await screen.findByText("This event is no longer accepting responses."),
    ).toBeInTheDocument();
    expect(joinEvent).not.toHaveBeenCalled();
    expect(consumeRespondIntent).toHaveBeenCalledTimes(1);
  });

  test("joins, autosaves changed availability, and submits a valid response", async () => {
    updateParticipant
      .mockResolvedValueOnce({
        participant: participant("mine", member.id, member.displayName, {
          availabilityInperson: [1, 1],
          availabilityVirtual: [1, 1],
          version: 2,
        }),
      })
      .mockResolvedValueOnce({
        participant: participant("mine", member.id, member.displayName, {
          availabilityInperson: [1, 1],
          availabilityVirtual: [1, 1],
          submitted: true,
          version: 3,
        }),
      });

    renderParticipant();
    expect(await screen.findByRole("heading", { name: "Join Event" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: `Join as ${member.displayName}` }));
    expect(await screen.findByText(`Welcome, ${member.displayName}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply Available to all" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Availability" }));

    await waitFor(() => expect(updateParticipant).toHaveBeenCalledTimes(2));
    expect(updateParticipant.mock.calls[0][2]).toEqual({
      availabilityInperson: [1, 1],
      availabilityVirtual: [1, 1],
      submitted: 0,
      expectedVersion: 1,
    });
    expect(updateParticipant.mock.calls[1][2]).toEqual({
      submitted: 1,
      expectedVersion: 2,
    });
    expect(await screen.findByText("Schedule submitted.")).toBeInTheDocument();
  });

  test("surfaces autosave conflicts and reloads the authoritative response", async () => {
    const latest = participant("mine", member.id, member.displayName, {
      availabilityInperson: [0.5, 0],
      availabilityVirtual: [0, 0.5],
      version: 7,
    });
    const conflict = Object.assign(new Error("A newer response exists."), {
      participant: latest,
    });
    updateParticipant.mockRejectedValueOnce(conflict);

    renderParticipant();
    await screen.findByRole("heading", { name: "Join Event" });
    await userEvent.click(screen.getByRole("button", { name: `Join as ${member.displayName}` }));
    await screen.findByText(`Welcome, ${member.displayName}`);
    await userEvent.click(screen.getByRole("button", { name: "Mark all Busy" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Availability" }));

    expect(await screen.findByText("A newer response exists.")).toBeInTheDocument();
    expect(screen.getByText("Save the draft successfully before submitting.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload latest response" }));
    expect(screen.getByTestId("grid-In-Person")).toHaveTextContent("0.5,0");
    expect(screen.getByText("Draft saved. Submit when you are ready.")).toBeInTheDocument();
  });

  test("copies mixed-mode availability and autosaves the target channel", async () => {
    joinEvent.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName, {
        availabilityInperson: [1, 0.5],
        availabilityVirtual: [0, 0],
      }),
    });
    updateParticipant.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName, {
        availabilityInperson: [1, 0.5],
        availabilityVirtual: [1, 0.5],
        version: 2,
      }),
    });

    renderParticipant();
    await screen.findByRole("heading", { name: "Join Event" });
    await userEvent.click(screen.getByRole("button", { name: `Join as ${member.displayName}` }));
    await screen.findByText(`Welcome, ${member.displayName}`);
    await userEvent.click(screen.getByRole("button", { name: "Copy In-Person to Virtual" }));
    expect(screen.getByTestId("grid-Virtual")).toHaveTextContent("1,0.5");

    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        baseEvent.code,
        "mine",
        expect.objectContaining({
          availabilityInperson: [1, 0.5],
          availabilityVirtual: [1, 0.5],
          submitted: 0,
        }),
        "token"
      )
    );
  });

  test("shows authorized shared results and locks changes after finalization", async () => {
    fetchCurrentParticipant.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName, {
        submitted: true,
        availabilityInperson: [1, 0],
        availabilityVirtual: [0, 1],
      }),
      scheduleDataIncluded: true,
    });
    fetchEventResults.mockResolvedValue({
      status: "fresh",
      requestedRevision: 4,
      computedRevision: 4,
      generatedAt: "2026-08-18T08:00:00Z",
      results: sharedResults,
    });

    const view = renderParticipant();
    expect(await screen.findByText(/Based on 2 submitted response/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Individual Schedules" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchCurrentParticipant).toHaveBeenCalledTimes(2));
    view.unmount();

    renderParticipant({ ...baseEvent, status: "finalized" });
    expect(
      await screen.findByText("Responses are locked while this event is finalized.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Availability" })).toBeDisabled();
  });

  test("polls versioned group results until the requested revision is fresh", async () => {
    jest.useFakeTimers();
    fetchCurrentParticipant.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName, { submitted: true }),
      scheduleDataIncluded: true,
    });
    fetchEventResults
      .mockResolvedValueOnce({
        status: "refreshing",
        requestedRevision: 5,
        computedRevision: 4,
        results: sharedResults,
      })
      .mockResolvedValueOnce({
        status: "fresh",
        requestedRevision: 5,
        computedRevision: 5,
        results: sharedResults,
      });

    const view = renderParticipant({ ...baseEvent, resultsRevision: 5 });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(screen.getByText(/Group availability is updating for revision 5/)).toBeInTheDocument();
    expect(screen.getByText(/Based on 2 submitted response/)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(fetchEventResults).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Group availability is updating/)).not.toBeInTheDocument();
    view.unmount();
    jest.useRealTimers();
  });

  test("renders loading and own-only empty-result semantics", async () => {
    auth(null, true);
    const loading = renderParticipant();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    loading.unmount();

    auth();
    fetchCurrentParticipant.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName, {
        submitted: true,
      }),
      scheduleDataIncluded: true,
    });
    fetchEventResults.mockRejectedValue(new Error("Not authorized"));
    renderParticipant({ ...baseEvent, participantViewPermission: "own_only" });
    await waitFor(() => expect(fetchCurrentParticipant).toHaveBeenCalled());
    expect(fetchEventResults).not.toHaveBeenCalled();
    expect(
      screen.getByText("Choose a status, then click or drag across the times below.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Group Availability")).not.toBeInTheDocument();
  });
});
