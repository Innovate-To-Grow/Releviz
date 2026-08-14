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

jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), {
  virtual: true,
});
jest.mock("@material/web/select/outlined-select.js", () => ({}), {
  virtual: true,
});
jest.mock("@material/web/select/select-option.js", () => ({}), {
  virtual: true,
});

const replace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("@/lib/api/dashboard", () => ({
  fetchDashboardEvents: jest.fn(),
}));

jest.mock("@/lib/api/events", () => ({
  createEvent: jest.fn(),
  deleteEvent: jest.fn(),
  duplicateEvent: jest.fn(),
  fetchEvent: jest.fn(),
  updateEvent: jest.fn(),
  updateEventLifecycle: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
  reloadPage: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import DashboardPage from "@/components/dashboard/DashboardPage";
import CreateEvent from "@/components/event/CreateEvent";
import { fetchDashboardEvents } from "@/lib/api/dashboard";
import {
  createEvent,
  deleteEvent,
  duplicateEvent,
  fetchEvent,
  updateEvent,
  updateEventLifecycle,
} from "@/lib/api/events";
import { navigateTo, reloadPage } from "@/lib/navigation";

const organizer = {
  id: "organizer-1",
  displayName: "Event Manager",
};

const baseEvent = {
  code: "EVENT123",
  name: "Planning session",
  organizerUserId: organizer.id,
  startTime: "09:00",
  endTime: "10:00",
  slotMinutes: 30,
  days: [1, 2],
  mode: "inperson",
  location: "Room 4",
  participantViewPermission: "own_only",
  daySelectionType: "days_of_week",
  responseDeadline: "2026-08-20T17:00:00Z",
  timezone: "UTC",
  remindersEnabled: true,
  reminderHoursBefore: 24,
  status: "active",
  version: 3,
};

function authenticated() {
  useAuth.mockReturnValue({
    user: organizer,
    loading: false,
    getToken: jest.fn().mockResolvedValue("token"),
  });
}

function setCustomElementValue(element, value) {
  element.value = value;
  fireEvent(element, new Event("input", { bubbles: true }));
}

describe("organizer event management UI", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    searchParams = new URLSearchParams();
    authenticated();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue("request-key") },
    });
  });

  test("dashboard duplicates, archives, and confirms deletion", async () => {
    const participantEvent = {
      ...baseEvent,
      code: "JOINED01",
      name: "Joined event",
      organizerUserId: "someone-else",
    };
    const duplicate = {
      ...baseEvent,
      code: "COPY0001",
      name: "Planning session (copy)",
      status: "active",
      version: 1,
      responseDeadline: null,
    };
    fetchDashboardEvents.mockResolvedValue({
      organized: [baseEvent],
      participating: [participantEvent],
    });
    duplicateEvent.mockResolvedValue({ event: duplicate, idempotent: false });
    updateEventLifecycle.mockResolvedValue({
      event: { ...baseEvent, status: "archived", version: 4 },
    });
    deleteEvent.mockResolvedValue({
      deletedCode: duplicate.code,
      idempotent: false,
    });

    render(<DashboardPage />);
    expect(
      await screen.findByRole("heading", { name: "My Dashboard" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Events I Participate In (1)")).toBeInTheDocument();

    const sourceCard = screen
      .getByRole("link", { name: baseEvent.name })
      .closest("article");
    await userEvent.click(
      within(sourceCard).getByRole("button", { name: "Duplicate" }),
    );
    await waitFor(() =>
      expect(duplicateEvent).toHaveBeenCalledWith(
        baseEvent.code,
        {
          expectedVersion: baseEvent.version,
          idempotencyKey: "request-key",
        },
        "token",
      ),
    );
    expect(
      await screen.findByRole("link", { name: duplicate.name }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Planning session was duplicated as a new active event.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(
      within(sourceCard).getByRole("button", { name: "Archive" }),
    );
    await waitFor(() =>
      expect(updateEventLifecycle).toHaveBeenCalledWith(
        baseEvent.code,
        {
          status: "archived",
          expectedVersion: baseEvent.version,
          responseDeadline: baseEvent.responseDeadline,
        },
        "token",
      ),
    );
    expect(
      await screen.findByText("Planning session was archived."),
    ).toBeInTheDocument();
    const archivedCard = screen
      .getByRole("link", { name: baseEvent.name })
      .closest("article");
    expect(
      within(archivedCard).queryByRole("button", { name: "Archive" }),
    ).not.toBeInTheDocument();
    expect(
      within(archivedCard).getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("aria-disabled", "true");

    const duplicateCard = screen
      .getByRole("link", { name: duplicate.name })
      .closest("article");
    await userEvent.click(
      within(duplicateCard).getByRole("button", { name: "Delete" }),
    );
    const confirmation = screen.getByLabelText("Event code confirmation");
    const deleteButton = screen.getByRole("button", {
      name: "Delete event permanently",
    });
    expect(deleteButton).toBeDisabled();
    await userEvent.type(confirmation, duplicate.code);
    expect(deleteButton).not.toBeDisabled();
    await userEvent.click(deleteButton);
    await waitFor(() =>
      expect(deleteEvent).toHaveBeenCalledWith(
        duplicate.code,
        {
          expectedVersion: duplicate.version,
          idempotencyKey: "request-key",
          confirmation: duplicate.code,
        },
        "token",
      ),
    );
    expect(
      await screen.findByText(
        "Planning session (copy) was permanently deleted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: duplicate.name }),
    ).not.toBeInTheDocument();
  });

  test("dashboard retries duplicate requests with the same key and handles navigation", async () => {
    globalThis.crypto.randomUUID
      .mockReturnValueOnce("stable-duplicate-key")
      .mockReturnValueOnce("unused-key");
    fetchDashboardEvents.mockResolvedValue({
      organized: [baseEvent],
      participating: [],
    });
    duplicateEvent
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        event: {
          ...baseEvent,
          code: "RETRYCPY",
          name: "Retry copy",
          status: "active",
        },
      });

    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "My Dashboard" });
    const card = screen
      .getByRole("link", { name: baseEvent.name })
      .closest("article");
    await userEvent.click(
      within(card).getByRole("button", { name: "Duplicate" }),
    );
    expect(await screen.findByText("Network unavailable")).toBeInTheDocument();
    await userEvent.click(
      within(card).getByRole("button", { name: "Duplicate" }),
    );
    await waitFor(() => expect(duplicateEvent).toHaveBeenCalledTimes(2));
    expect(duplicateEvent.mock.calls[0][1].idempotencyKey).toBe(
      "stable-duplicate-key",
    );
    expect(duplicateEvent.mock.calls[1][1].idempotencyKey).toBe(
      "stable-duplicate-key",
    );

    const codeField = document.querySelector(
      'md-outlined-text-field[label="Enter Event Code"]',
    );
    setCustomElementValue(codeField, " A B C ");
    fireEvent.keyDown(codeField, { key: "Enter" });
    expect(navigateTo).toHaveBeenCalledWith("/event?code=A%20B%20C");
  });

  test("dashboard reports load failures and redirects unauthenticated users", async () => {
    fetchDashboardEvents.mockRejectedValueOnce(new Error("offline"));
    const first = render(<DashboardPage />);
    expect(
      await screen.findByText(
        "Failed to load your events. Please refresh and try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No events organized yet.")).toBeInTheDocument();
    first.unmount();

    useAuth.mockReturnValue({
      user: null,
      loading: false,
      getToken: jest.fn(),
    });
    render(<DashboardPage />);
    expect(navigateTo).toHaveBeenCalledWith("/login?next=/dashboard");
  });

  test("edit form loads values and requires explicit response-reset confirmation", async () => {
    searchParams = new URLSearchParams("code=EVENT123");
    fetchEvent.mockResolvedValue({ event: baseEvent });
    const resetError = Object.assign(
      new Error("Saved availability would be reset."),
      {
        requiresResponseReset: true,
        participantCount: 2,
      },
    );
    updateEvent.mockRejectedValueOnce(resetError).mockResolvedValueOnce({
      event: { ...baseEvent, name: "Updated planning", version: 4 },
      responsesReset: 2,
    });

    render(<CreateEvent operation="edit" />);
    expect(
      await screen.findByRole("heading", { name: "Edit event" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Advanced options").closest("details"),
    ).toHaveAttribute("open");
    const nameField = document.querySelector(
      'md-outlined-text-field[label="Event Name"]',
    );
    expect(nameField).toHaveAttribute("value", baseEvent.name);
    setCustomElementValue(nameField, "Updated planning");
    fireEvent.change(screen.getByLabelText("End Time"), {
      target: { value: "10:30" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Schedule changes require a response reset"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /clear draft and submitted availability for 2 participants/,
      ),
    ).toBeInTheDocument();
    const confirmation = screen.getByLabelText(
      "I understand that participant availability will be reset.",
    );
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
    await userEvent.click(confirmation);
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(2));
    expect(updateEvent.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        name: "Updated planning",
        endTime: "10:30",
        expectedVersion: baseEvent.version,
        resetResponses: false,
      }),
    );
    expect(updateEvent.mock.calls[1][1].resetResponses).toBe(true);
    expect(replace).toHaveBeenCalledWith("/event?code=EVENT123");
  });

  test("inline edit reuses initial values and reports saves without navigation", async () => {
    const onCancel = jest.fn();
    const onSaved = jest.fn();
    const result = {
      event: { ...baseEvent, name: "Inline update", version: 4 },
      responsesReset: 0,
    };
    updateEvent.mockResolvedValue(result);

    const first = render(
      <CreateEvent
        operation="edit"
        presentation="inline"
        initialEvent={baseEvent}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );

    const inlineForm = screen
      .getByRole("button", { name: "Save changes" })
      .closest("form");
    expect(inlineForm).toHaveClass("create-event-form--inline");
    expect(fetchEvent).not.toHaveBeenCalled();
    expect(
      document.querySelector('md-outlined-text-field[label="Event Name"]'),
    ).toHaveAttribute("value", baseEvent.name);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    first.unmount();

    render(
      <CreateEvent
        operation="edit"
        presentation="inline"
        initialEvent={baseEvent}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateEvent).toHaveBeenCalledWith(
        baseEvent.code,
        expect.objectContaining({ expectedVersion: baseEvent.version }),
        "token",
      ),
    );
    expect(onSaved).toHaveBeenCalledWith(result);
    expect(replace).not.toHaveBeenCalled();
  });

  test("edit form exposes conflicts, load errors, and authentication recovery", async () => {
    searchParams = new URLSearchParams("code=EVENT123");
    fetchEvent.mockResolvedValueOnce({ event: baseEvent });
    const conflict = Object.assign(new Error("Reload your edits."), {
      event: { ...baseEvent, version: 5 },
    });
    updateEvent.mockRejectedValueOnce(conflict);
    const first = render(<CreateEvent operation="edit" />);
    await screen.findByRole("heading", { name: "Edit event" });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const reloadButton = await screen.findByRole("button", {
      name: "Reload latest event",
    });
    expect(reloadButton.closest(".event-form-warning")).toHaveTextContent(
      "The latest saved version is 5.",
    );
    await userEvent.click(reloadButton);
    expect(reloadPage).toHaveBeenCalled();
    first.unmount();

    searchParams = new URLSearchParams();
    render(<CreateEvent operation="edit" />);
    expect(
      await screen.findByText("No event code was provided for editing."),
    ).toBeInTheDocument();

    useAuth.mockReturnValue({
      user: null,
      loading: false,
      getToken: jest.fn(),
    });
    render(<CreateEvent operation="edit" />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?next=%2Fedit%3Fcode%3D"),
    );
  });

  test("edit form rejects non-organizers", async () => {
    searchParams = new URLSearchParams("code=EVENT123");
    fetchEvent.mockResolvedValue({
      event: { ...baseEvent, organizerUserId: "another-organizer" },
    });

    render(<CreateEvent operation="edit" />);

    expect(
      await screen.findByText("Only the organizer can edit this event."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Unable to edit event" }),
    ).toBeInTheDocument();
  });

  test("create form validates and submits a keyboard-friendly form", async () => {
    createEvent.mockResolvedValue({
      event: { ...baseEvent, code: "CREATED1" },
    });
    render(<CreateEvent />);
    expect(
      screen.getByRole("heading", { name: "Schedule" }),
    ).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "Create Event" });
    const createForm = createButton.closest("form");
    expect(createForm).toHaveClass("create-event-form");
    expect(createForm).not.toHaveClass("md-card");
    expect(createForm.closest("main")).toHaveClass("create-event-shell");
    expect(
      screen.getByRole("heading", { name: "Meeting & access" }),
    ).toBeInTheDocument();
    const advancedOptions = screen
      .getByText("Advanced options")
      .closest("details");
    expect(advancedOptions).not.toHaveAttribute("open");

    const locationField = document.querySelector(
      'md-outlined-text-field[label="Location / Address"]',
    );
    const timezoneField = screen.getByLabelText("Event timezone");
    const meetingDurationField = screen.getByLabelText("Meeting Duration");
    const accessField = screen.getByLabelText("Event Access");
    expect(screen.getByRole("button", { name: "In-Person" })).toBeVisible();
    expect(locationField).toBeVisible();
    expect(timezoneField).toBeVisible();
    expect(meetingDurationField).toBeVisible();
    expect(accessField).toBeVisible();
    expect(advancedOptions).not.toContainElement(locationField);
    expect(advancedOptions).not.toContainElement(timezoneField);
    expect(advancedOptions).not.toContainElement(meetingDurationField);
    expect(advancedOptions).not.toContainElement(accessField);

    expect(advancedOptions).toContainElement(
      screen.getByLabelText("Slot Duration"),
    );
    expect(advancedOptions).toContainElement(
      screen.getByLabelText("Participant View"),
    );
    expect(advancedOptions).toContainElement(
      screen.getByLabelText("Response Deadline"),
    );
    expect(advancedOptions).toContainElement(
      screen.getByLabelText("Reminder Hours Before Deadline"),
    );
    await userEvent.click(screen.getByText("Advanced options"));
    expect(advancedOptions).toHaveAttribute("open");
    expect(
      screen.getByRole("heading", { name: "Fine tuning" }),
    ).toBeInTheDocument();
    await userEvent.click(createButton);
    const nameError = await screen.findByText("Event name is required");
    expect(nameError).toHaveClass("create-event-field-error");
    expect(nameError.closest('[data-error-field="eventName"]')).not.toBeNull();

    const nameField = document.querySelector(
      'md-outlined-text-field[label="Event Name"]',
    );
    expect(nameField).toHaveAttribute("aria-invalid", "true");
    expect(nameField.parentElement).toContainElement(nameError);
    setCustomElementValue(nameField, "Created event");
    expect(
      screen.queryByText("Event name is required"),
    ).not.toBeInTheDocument();
    setCustomElementValue(screen.getByLabelText("Event Access"), "open_link");
    const timezoneSelect = screen.getByLabelText("Event timezone");
    expect(timezoneSelect.tagName).toBe("MD-OUTLINED-SELECT");
    expect(
      within(timezoneSelect).getByText("America/Los_Angeles"),
    ).toBeInTheDocument();
    setCustomElementValue(timezoneSelect, "America/Los_Angeles");
    fireEvent.change(screen.getByLabelText("Meeting Duration"), {
      target: { value: "60" },
    });
    fireEvent.submit(createForm);
    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: "Created event",
        startTime: "09:00",
        endTime: "17:00",
        slotMinutes: 30,
        accessMode: "open_link",
        timezone: "America/Los_Angeles",
        meetingDurationMinutes: 60,
        status: "active",
      }),
    );
    expect(replace).toHaveBeenCalledWith("/event?code=CREATED1");
  });

  test("keeps common validation visible without opening advanced options", async () => {
    render(<CreateEvent />);
    const advancedOptions = screen
      .getByText("Advanced options")
      .closest("details");
    const nameField = document.querySelector(
      'md-outlined-text-field[label="Event Name"]',
    );
    const meetingDuration = screen.getByLabelText("Meeting Duration");

    expect(advancedOptions).not.toHaveAttribute("open");
    setCustomElementValue(nameField, "Duration validation");
    fireEvent.change(meetingDuration, { target: { value: "20" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create Event" }).closest("form"),
    );

    expect(advancedOptions).not.toHaveAttribute("open");
    const durationError = await screen.findByText(
      "Meeting duration must be 15–480 minutes and align to 30-minute slots",
    );
    expect(
      durationError.closest('[data-error-field="meetingDuration"]'),
    ).toContainElement(meetingDuration);
    expect(meetingDuration).toHaveAttribute("aria-invalid", "true");
    expect(
      document.querySelector(".create-event-feedback .create-event-error"),
    ).not.toBeInTheDocument();
  });

  test("opens advanced options and places advanced validation beside its field", async () => {
    render(<CreateEvent />);
    const advancedOptions = screen
      .getByText("Advanced options")
      .closest("details");
    const nameField = document.querySelector(
      'md-outlined-text-field[label="Event Name"]',
    );
    const reminderHours = screen.getByLabelText(
      "Reminder Hours Before Deadline",
    );

    expect(advancedOptions).not.toHaveAttribute("open");
    setCustomElementValue(nameField, "Reminder validation");
    fireEvent.change(reminderHours, { target: { value: "721" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create Event" }).closest("form"),
    );

    expect(advancedOptions).toHaveAttribute("open");
    const reminderError = await screen.findByText(
      "Reminder timing must be between 0 and 720 hours",
    );
    expect(
      reminderError.closest('[data-error-field="reminderHours"]'),
    ).toContainElement(reminderHours);
    expect(reminderHours).toHaveAttribute("aria-invalid", "true");
    expect(
      document.querySelector(".create-event-feedback .create-event-error"),
    ).not.toBeInTheDocument();
  });
});
