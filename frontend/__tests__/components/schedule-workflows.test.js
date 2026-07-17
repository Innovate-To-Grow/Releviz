/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  deleteParticipant: jest.fn(),
  fetchParticipants: jest.fn(),
  fetchParticipantsIncludeHidden: jest.fn(),
  joinEvent: jest.fn(),
  unhideParticipant: jest.fn(),
  updateParticipant: jest.fn(),
}));

jest.mock("@/lib/api/weights", () => ({
  fetchWeights: jest.fn(),
  updateWeights: jest.fn(),
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
import OrganizerView from "@/components/schedule/OrganizerView";
import ParticipantView from "@/components/schedule/ParticipantView";
import {
  deleteParticipant,
  fetchParticipants,
  fetchParticipantsIncludeHidden,
  joinEvent,
  unhideParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import { fetchWeights, updateWeights } from "@/lib/api/weights";
import {
  confirmFinalMeeting,
  fetchEventResults,
  fetchInvitations,
  previewFinalMeeting,
  sendInvitations,
  sendReminders,
  updateEventLifecycle,
} from "@/lib/api/events";

const member = { id: "member-1", displayName: "Morgan Member" };
const organizer = { id: "organizer-1", displayName: "Olivia Organizer" };
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

function renderParticipant(event = baseEvent) {
  return render(
    <EventContext.Provider value={{ event, numSlots: 2 }}>
      <ParticipantView />
    </EventContext.Provider>
  );
}

function renderOrganizer(event = baseEvent, setEvent = jest.fn()) {
  return {
    setEvent,
    ...render(
      <EventContext.Provider value={{ event, setEvent, numSlots: 2 }}>
        <OrganizerView />
      </EventContext.Provider>
    ),
  };
}

const sharedResults = {
  countedResponseTotal: 2,
  unansweredParticipantTotal: 1,
  excludedParticipantTotal: 1,
  calculationBasis: { weighted: { totalWeight: 1.5 } },
  requiredParticipantConflicts: { channels: { inperson: [0], virtual: [] } },
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
      requiredParticipantConflictTotal: 0,
    },
  ],
  recommendationBasis: { status: "ranked" },
};

describe("participant workflow", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    auth();
    fetchEventResults.mockRejectedValue(new Error("Not available yet"));
    fetchParticipants.mockResolvedValue({
      participants: [participant("other", "other-user", "Alex", { submitted: true })],
    });
    joinEvent.mockResolvedValue({
      participant: participant("mine", member.id, member.displayName),
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("request-key") },
    });
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
    expect(await screen.findByText("Alex")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: `Join as ${member.displayName}` }));
    expect(await screen.findByText(`Welcome, ${member.displayName}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply level to all" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Schedule" }));

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
    await screen.findByText("Alex");
    await userEvent.click(screen.getByRole("button", { name: `Join as ${member.displayName}` }));
    await screen.findByText(`Welcome, ${member.displayName}`);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Schedule" }));

    expect(await screen.findByText("A newer response exists.")).toBeInTheDocument();
    expect(screen.getByText("Save the draft successfully before submitting.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload latest response" }));
    expect(screen.getByTestId("grid-In-Person")).toHaveTextContent("0.5,0");
    expect(screen.getByText("Draft saved. Submit when you are ready.")).toBeInTheDocument();
  });

  test("shows authorized shared results and locks changes after finalization", async () => {
    fetchParticipants.mockResolvedValue({
      participants: [
        participant("mine", member.id, member.displayName, {
          submitted: true,
          availabilityInperson: [1, 0],
          availabilityVirtual: [0, 1],
        }),
        participant("other", "other-user", "Alex", {
          submitted: true,
          availabilityInperson: [0.5, 0],
          availabilityVirtual: [1, 1],
        }),
      ],
    });
    fetchEventResults.mockResolvedValue({ results: sharedResults });

    const view = renderParticipant();
    expect(await screen.findByText(/Based on 2 submitted response/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Individual Schedules" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchParticipants).toHaveBeenCalledTimes(2));
    view.unmount();

    renderParticipant({ ...baseEvent, status: "finalized" });
    expect(
      await screen.findByText("Responses are locked while this event is finalized.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Schedule" })).toBeDisabled();
  });

  test("renders loading and own-only empty-result semantics", async () => {
    auth(null, true);
    const loading = renderParticipant();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    loading.unmount();

    auth();
    fetchParticipants.mockResolvedValue({
      participants: [
        participant("mine", member.id, member.displayName, {
          submitted: true,
        }),
      ],
    });
    fetchEventResults.mockRejectedValue(new Error("Not authorized"));
    renderParticipant({ ...baseEvent, participantViewPermission: "own_only" });
    expect(
      await screen.findByText("The organizer has limited participants to their own schedules.")
    ).toBeInTheDocument();
  });
});

describe("organizer workflow", () => {
  const mine = participant("mine", organizer.id, organizer.displayName, {
    submitted: true,
    availabilityInperson: [1, 1],
    availabilityVirtual: [1, 0],
    version: 4,
  });
  const alex = participant("alex", "alex-user", "Alex", {
    submitted: true,
    availabilityInperson: [1, 0.5],
    availabilityVirtual: [0.5, 1],
    sort_order: 1,
    group_name: "Design",
  });
  const blair = participant("blair", "blair-user", "Blair", {
    sort_order: 2,
  });
  const hidden = participant("hidden", "hidden-user", "Hidden Person", {
    hidden: 1,
    sort_order: 3,
  });
  const attendance = {
    availableParticipantTotal: 2,
    partialParticipantTotal: 0,
    unavailableParticipantTotal: 0,
    unansweredParticipantTotal: 1,
    excludedParticipantTotal: 1,
    requiredConflictTotal: 0,
    participants: [{ participantId: "alex", name: "Alex", status: "available", required: true }],
  };

  beforeEach(() => {
    jest.resetAllMocks();
    auth(organizer);
    fetchParticipantsIncludeHidden.mockResolvedValue({
      participants: [mine, alex, blair, hidden],
    });
    fetchWeights.mockResolvedValue({
      weights: [
        { participant_id: "mine", weight: 1, included: 1, required: 0 },
        { participant_id: "alex", weight: 0.5, included: 1, required: 1 },
        { participant_id: "blair", weight: 1, included: 1, required: 0 },
      ],
    });
    fetchInvitations.mockResolvedValue({
      invitations: [
        {
          id: "invite-1",
          email: "alex@example.com",
          status: "opened",
          statusLabel: "Opened",
          awaitingReminder: true,
        },
      ],
    });
    fetchEventResults.mockResolvedValue({ results: sharedResults });
    updateWeights.mockResolvedValue({});
    updateParticipant.mockImplementation((code, id, payload) =>
      Promise.resolve({
        participant: {
          ...(id === "alex" ? alex : id === "blair" ? blair : mine),
          ...payload,
          version: 8,
          group_name: payload.groupName,
        },
      })
    );
    deleteParticipant.mockResolvedValue({});
    unhideParticipant.mockResolvedValue({});
    updateEventLifecycle.mockImplementation((code, payload) =>
      Promise.resolve({ event: { ...baseEvent, status: payload.status, version: 4 } })
    );
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("request-key") },
    });
  });

  test("sends invitations/reminders and confirms a ranked final time", async () => {
    sendInvitations.mockResolvedValue({
      invitations: [
        {
          id: "invite-2",
          email: "new@example.com",
          statusLabel: "Invited",
          awaitingReminder: false,
        },
      ],
      recipientCount: 1,
      delivery: { sent: 0, pending: 1, processing: 0, retry: 0, permanentFailure: 0 },
    });
    sendReminders.mockResolvedValue({
      recipientCount: 1,
      delivery: { sent: 1, pending: 0, processing: 0, retry: 0, permanentFailure: 0 },
    });
    previewFinalMeeting.mockResolvedValue({ attendance });
    confirmFinalMeeting.mockResolvedValue({
      event: {
        ...baseEvent,
        status: "finalized",
        version: 4,
        finalMeeting: {
          startsAt: "2026-08-18T09:00:00Z",
          endsAt: "2026-08-18T09:30:00Z",
          channel: "inperson",
          location: "Room 4",
        },
      },
      finalMeeting: { attendance },
      delivery: { sent: 1, pending: 0, retry: 1, permanentFailure: 0 },
    });

    const { setEvent } = renderOrganizer();
    expect(await screen.findByRole("heading", { name: "Organizer Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText("Awaiting reminder")).toBeInTheDocument();

    const emailField = document.querySelector('md-outlined-text-field[label="Invite emails"]');
    setCustomElementValue(emailField, "new@example.com");
    fireEvent.change(screen.getByPlaceholderText("Optional message"), {
      target: { value: "Please respond" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send Invitations" }));
    expect(
      await screen.findByText(
        "Accepted 1 invitation(s): 0 sent, 1 awaiting delivery, 0 failed permanently."
      )
    ).toBeInTheDocument();
    expect(sendInvitations).toHaveBeenCalledWith(
      baseEvent.code,
      {
        emails: ["new@example.com"],
        message: "Please respond",
        idempotencyKey: "request-key",
      },
      "token"
    );

    await userEvent.click(screen.getByRole("button", { name: "Send Reminders" }));
    expect(await screen.findByText("Sent 1 reminder(s).")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use recommendation 1" }));
    expect(screen.getByText(/Recommendation #1 loaded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review Attendance" }));
    expect(await screen.findByText(/Attendance review is current/)).toBeInTheDocument();
    expect(screen.getByText("Alex: available (required)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm Final Time" }));
    expect(
      await screen.findByText(
        "Final time is locked. Some confirmation emails are queued for retry."
      )
    ).toBeInTheDocument();
    expect(confirmFinalMeeting).toHaveBeenCalledWith(
      baseEvent.code,
      expect.objectContaining({
        startsAt: "2026-08-18T09:00:00.000Z",
        endsAt: "2026-08-18T09:30:00.000Z",
        expectedVersion: 3,
        idempotencyKey: "request-key",
      }),
      "token"
    );
    expect(setEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "finalized" }));
  });

  test("manages lifecycle, weights, ordering, visibility, groups, and organizer availability", async () => {
    const { setEvent } = renderOrganizer();
    await screen.findAllByText("Alex");

    await userEvent.click(screen.getByRole("button", { name: "Close Event" }));
    await waitFor(() =>
      expect(updateEventLifecycle).toHaveBeenCalledWith(
        baseEvent.code,
        { status: "closed", expectedVersion: 3, responseDeadline: undefined },
        "token"
      )
    );
    expect(setEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));

    const archiveButton = screen.getByRole("button", { name: "Archive Event" });
    await waitFor(() => expect(archiveButton).not.toBeDisabled());
    await userEvent.click(archiveButton);
    await waitFor(() =>
      expect(updateEventLifecycle).toHaveBeenCalledWith(
        baseEvent.code,
        { status: "archived", expectedVersion: 3, responseDeadline: undefined },
        "token"
      )
    );

    await userEvent.click(screen.getByRole("button", { name: "Uncheck All" }));
    await userEvent.click(screen.getByRole("button", { name: "Check All" }));
    expect(updateWeights).toHaveBeenCalled();

    const alexManagementName = screen
      .getAllByText("Alex")
      .find((element) => element.tagName === "SPAN");
    let alexCard = alexManagementName.parentElement.parentElement.parentElement;
    await userEvent.click(within(alexCard).getByLabelText("Required participant"));
    await waitFor(() =>
      expect(updateWeights).toHaveBeenCalledWith(
        baseEvent.code,
        expect.arrayContaining([expect.objectContaining({ participantId: "alex", required: 0 })]),
        "token"
      )
    );

    const groupInput = screen.getByDisplayValue("Design");
    fireEvent.change(groupInput, { target: { value: "Research" } });
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        baseEvent.code,
        "alex",
        { groupName: "Research" },
        "token"
      )
    );

    const updatedAlexManagementName = screen
      .getAllByText("Alex")
      .find((element) => element.tagName === "SPAN");
    alexCard = updatedAlexManagementName.parentElement.parentElement.parentElement;
    await userEvent.click(within(alexCard).getByTitle("Move down"));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        baseEvent.code,
        "alex",
        { sortOrder: 2 },
        "token"
      )
    );

    const reorderedAlexManagementName = screen
      .getAllByText("Alex")
      .find((element) => element.tagName === "SPAN");
    alexCard = reorderedAlexManagementName.parentElement.parentElement.parentElement;
    await userEvent.click(within(alexCard).getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(deleteParticipant).toHaveBeenCalledWith(baseEvent.code, "alex", "token")
    );

    await userEvent.click(screen.getByRole("button", { name: /Hidden Participants/ }));
    await userEvent.click(screen.getByRole("button", { name: "Unhide" }));
    await waitFor(() =>
      expect(unhideParticipant).toHaveBeenCalledWith(baseEvent.code, "hidden", "token")
    );

    await userEvent.click(screen.getByRole("button", { name: "Paint In-Person" }));
    await userEvent.click(screen.getByRole("button", { name: "Save My Schedule" }));
    await waitFor(() =>
      expect(updateParticipant).toHaveBeenCalledWith(
        baseEvent.code,
        "mine",
        expect.objectContaining({
          availabilityInperson: [0, 1],
          submitted: 1,
          expectedVersion: 4,
        }),
        "token"
      )
    );
  });

  test("renders loading and empty recommendation states", async () => {
    auth(null, true);
    const loading = renderOrganizer();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    loading.unmount();

    auth(organizer);
    fetchParticipantsIncludeHidden.mockResolvedValue({ participants: [] });
    fetchWeights.mockResolvedValue({ weights: [] });
    fetchInvitations.mockResolvedValue({ invitations: [] });
    fetchEventResults.mockResolvedValue({
      results: {
        ...sharedResults,
        recommendations: [],
        recommendationBasis: { status: "no_future_slots" },
      },
    });
    renderOrganizer({ ...baseEvent, mode: "inperson", status: "draft" });
    expect(
      await screen.findByText("No future configured slots are available to recommend.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Open or close this event before confirming a final meeting time.")
    ).toBeInTheDocument();
    expect(screen.getByText("No participants yet. Share the event link!")).toBeInTheDocument();
  });
});
