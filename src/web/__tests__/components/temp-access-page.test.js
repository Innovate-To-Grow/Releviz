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

let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

jest.mock("@/components/ui/BrandLogo", () => ({
  __esModule: true,
  default: (props) => <div role="img" aria-label={props.alt || "Releviz"} />,
}));

jest.mock("@/components/event/EventDetailsGrid", () => ({
  __esModule: true,
  default: ({ event }) => <div data-testid="event-details">{event.name}</div>,
}));

jest.mock("@/components/schedule/ScheduleChannelEditor", () => ({
  __esModule: true,
  default: ({
    inperson,
    virtual = [],
    readOnly,
    onInpersonPaint,
    onVirtualPaint,
    onCopy,
  }) => (
    <div data-testid="schedule-editor">
      <span>{inperson.join(",")}</span>
      <span data-testid="virtual-values">{virtual.join(",")}</span>
      <button disabled={readOnly} onClick={() => onInpersonPaint(0)}>
        Paint in-person
      </button>
      <button disabled={readOnly} onClick={() => onVirtualPaint?.(1)}>
        Paint virtual
      </button>
      <button onClick={() => onCopy?.("inperson", "virtual")}>
        Copy in-person to virtual
      </button>
    </div>
  ),
}));

jest.mock("@/components/schedule/ScheduleGrid", () => ({
  __esModule: true,
  default: ({ label }) => <div data-testid="results-grid">{label}</div>,
}));

jest.mock("@/lib/api/tempAccess", () => ({
  fetchTempAccessSession: jest.fn(),
  logoutTempAccess: jest.fn(),
  requestTempAccessCode: jest.fn(),
  updateTempAccessParticipant: jest.fn(),
  verifyTempAccess: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
  replaceUrl: jest.fn((url) => window.history.replaceState({}, "", url)),
}));

import TempAccessClient from "@/app/temp-access/TempAccessClient";
import {
  fetchTempAccessSession,
  logoutTempAccess,
  requestTempAccessCode,
  updateTempAccessParticipant,
  verifyTempAccess,
} from "@/lib/api/tempAccess";
import { navigateTo } from "@/lib/navigation";

// Most of these flows exercise the legacy Busy start (paint Available over
// empty slots); the Available default has its own tests below.
const event = {
  code: "ABC123",
  name: "Design review",
  mode: "inperson",
  status: "active",
  startingAvailability: "busy",
  responseDeadline: "2099-01-01T00:00:00Z",
  slotCount: 2,
  slotGroups: [
    {
      key: "mon",
      label: "Monday",
      slots: [
        { index: 0, localStart: "09:00", localEnd: "09:30" },
        { index: 1, localStart: "09:30", localEnd: "10:00" },
      ],
    },
  ],
};

function participant(overrides = {}) {
  return {
    id: "person-1",
    name: "Temporary Taylor",
    availabilityInperson: [0, 0],
    availabilityVirtual: [0, 0],
    submitted: false,
    version: 1,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    event,
    participant: participant(),
    email: "taylor@example.com",
    ...overrides,
  };
}

describe("temporary event access page", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    fetchTempAccessSession.mockReset();
    logoutTempAccess.mockReset();
    requestTempAccessCode.mockReset();
    updateTempAccessParticipant.mockReset();
    verifyTempAccess.mockReset();
    navigateTo.mockReset();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/temp-access");
    searchParams = new URLSearchParams("code=ABC123");
    fetchTempAccessSession.mockResolvedValue(session());
    requestTempAccessCode.mockResolvedValue({ accepted: true });
    verifyTempAccess.mockResolvedValue(session());
    logoutTempAccess.mockResolvedValue({});
    updateTempAccessParticipant.mockImplementation(async (_code, payload) => ({
      participant: participant({
        availabilityInperson: payload.availabilityInperson || [0, 0],
        availabilityVirtual: payload.availabilityVirtual || [0, 0],
        submitted: Boolean(payload.submitted),
        version: 2,
      }),
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("restores a restricted session and builds an email-free server-bound upgrade link", async () => {
    render(<TempAccessClient />);

    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You are responding as Temporary Taylor"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /dashboard/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /settings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Upgrade to full access" }),
    ).toHaveAttribute(
      "href",
      "/signup?upgrade=temporary&code=ABC123&next=%2Fevent%3Fcode%3DABC123",
    );
    const upgradeHref = screen
      .getByRole("link", { name: "Upgrade to full access" })
      .getAttribute("href");
    expect(new URLSearchParams(upgradeHref.split("?")[1]).has("email")).toBe(
      false,
    );
    expect(upgradeHref).not.toContain("lockedEmail");
    expect(requestTempAccessCode).not.toHaveBeenCalled();
  });

  test("strips the invitation token, requests a code, and verifies access", async () => {
    searchParams = new URLSearchParams(
      "code=ABC123&invitation=secret-link-token",
    );
    window.history.replaceState(
      {},
      "",
      "/temp-access?code=ABC123&invitation=secret-link-token",
    );

    render(<TempAccessClient />);

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(requestTempAccessCode).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "secret-link-token",
      }),
    );
    expect(window.location.search).toBe("?code=ABC123");

    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and open schedule" }),
    );

    await waitFor(() =>
      expect(verifyTempAccess).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "secret-link-token",
        verificationCode: "123456",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("releviz.temp-access.invitation:ABC123"),
    ).toBeNull();
  });

  test("lets an explicit invitation override an existing same-event cookie session", async () => {
    searchParams = new URLSearchParams(
      "code=ABC123&invitation=invite-for-a-different-person",
    );
    window.history.replaceState(
      {},
      "",
      "/temp-access?code=ABC123&invitation=invite-for-a-different-person",
    );
    fetchTempAccessSession.mockResolvedValue(
      session({ participant: participant({ name: "Previous browser user" }) }),
    );

    render(<TempAccessClient />);

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(requestTempAccessCode).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "invite-for-a-different-person",
      }),
    );
    expect(fetchTempAccessSession).not.toHaveBeenCalled();
    expect(
      screen.queryByText("You are responding as Previous browser user"),
    ).not.toBeInTheDocument();
  });

  test("autosaves with a version and requires an explicit reload after a conflict", async () => {
    jest.useFakeTimers();
    const conflict = participant({ availabilityInperson: [1, 1], version: 9 });
    fetchTempAccessSession
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session({ participant: conflict }));
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Version conflict"), {
        status: 409,
        participant: conflict,
      }),
    );

    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenCalledWith("ABC123", {
        availabilityInperson: [1, 0],
        availabilityVirtual: [0, 0],
        submitted: 0,
        expectedVersion: 1,
      }),
    );
    expect(
      await screen.findByText(/schedule changed somewhere else/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Paint in-person" }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest response" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("schedule-editor")).toHaveTextContent("1,1"),
    );
    expect(
      screen.getByRole("button", { name: "Paint in-person" }),
    ).not.toBeDisabled();
  });

  test("reloads the latest response after a shared-response conflict", async () => {
    jest.useFakeTimers();
    const latestDraft = participant({
      availabilityInperson: [0.5, 0],
      submitted: false,
      version: 9,
    });
    fetchTempAccessSession
      .mockResolvedValueOnce(
        session({ participant: participant({ submitted: true }) }),
      )
      .mockResolvedValueOnce(session({ participant: latestDraft }));
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Version conflict"), {
        status: 409,
        participant: latestDraft,
      }),
    );

    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Your schedule" }),
    ).toBeInTheDocument();
    // A temporary participant never sees anyone else's availability.
    expect(
      screen.queryByRole("heading", { name: /group availability/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    expect(
      await screen.findByText(/schedule changed somewhere else/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload latest response" }),
    );

    await waitFor(() =>
      expect(fetchTempAccessSession).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId("schedule-editor")).toHaveTextContent("0.5,0"),
    );
    expect(
      screen.queryByRole("heading", { name: /group availability/i }),
    ).not.toBeInTheDocument();
  });

  test.each(["closed", "archived"])(
    "reloads and locks the schedule when the event is remotely %s",
    async (status) => {
      jest.useFakeTimers();
      fetchTempAccessSession
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(session({ event: { ...event, status } }));
      updateTempAccessParticipant.mockRejectedValueOnce(
        Object.assign(
          new Error(`Responses are locked while this event is ${status}.`),
          {
            status: 409,
          },
        ),
      );

      render(<TempAccessClient />);
      expect(
        await screen.findByRole("heading", { name: "Design review" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
      await act(async () => {
        jest.advanceTimersByTime(701);
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(fetchTempAccessSession).toHaveBeenCalledTimes(2),
      );
      expect(
        (
          await screen.findAllByText(
            `Responses are locked while this event is ${status}.`,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: "Paint in-person" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "Retry save" }),
      ).not.toBeInTheDocument();
    },
  );

  test("locks an excluded response instead of retrying a server-denied write", async () => {
    jest.useFakeTimers();
    fetchTempAccessSession
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session());
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(
        new Error("Excluded participants cannot change availability"),
        { status: 403 },
      ),
    );

    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(fetchTempAccessSession).toHaveBeenCalledTimes(2),
    );
    expect(
      (
        await screen.findAllByText(
          "Excluded participants cannot change availability",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Paint in-person" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Retry save" }),
    ).not.toBeInTheDocument();
  });

  test("exits temporary access when the account upgrades in another session", async () => {
    jest.useFakeTimers();
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(
        new Error("This account now has full access. Sign in to continue."),
        {
          status: 403,
          errorCode: "temp_account_upgraded",
        },
      ),
    );

    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("heading", { name: "Temporary access ended" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/account now has full access/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Design review" }),
    ).not.toBeInTheDocument();
  });

  test("submits the shared response and signs out of only the temporary session", async () => {
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Submit availability" }),
    );
    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenCalledWith("ABC123", {
        submitted: 1,
        expectedVersion: 1,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(logoutTempAccess).toHaveBeenCalledWith("ABC123"),
    );
    expect(
      await screen.findByRole("heading", { name: "You are signed out" }),
    ).toBeInTheDocument();
  });

  test("does not claim sign-out when the server cannot revoke the temporary session", async () => {
    logoutTempAccess.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText(
        /sign out could not be confirmed.*session may still be active/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "You are signed out" }),
    ).not.toBeInTheDocument();
  });

  test("flushes a pending autosave before navigating to full-account upgrade", async () => {
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    await userEvent.click(
      screen.getByRole("link", { name: "Upgrade to full access" }),
    );

    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenCalledWith("ABC123", {
        availabilityInperson: [1, 0],
        availabilityVirtual: [0, 0],
        submitted: 0,
        expectedVersion: 1,
      }),
    );
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/signup?upgrade=temporary&code=ABC123&next=%2Fevent%3Fcode%3DABC123",
      ),
    );
    expect(
      updateTempAccessParticipant.mock.invocationCallOrder[0],
    ).toBeLessThan(navigateTo.mock.invocationCallOrder[0]);
  });

  test("stays on the event when a pending draft cannot be flushed before sign out", async () => {
    updateTempAccessParticipant.mockRejectedValueOnce(
      new Error("Save unavailable"),
    );
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText(/resolve the save error before signing out/i),
    ).toBeInTheDocument();
    expect(logoutTempAccess).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Design review" }),
    ).toBeInTheDocument();
  });

  test("autosaves a draft without re-reading the session", async () => {
    jest.useFakeTimers();
    fetchTempAccessSession.mockResolvedValueOnce(
      session({ participant: participant({ submitted: true }) }),
    );

    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Your schedule" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    await waitFor(() => expect(updateTempAccessParticipant).toHaveBeenCalled());
    // The response is a draft again, and nothing else needs refreshing:
    // there is no shared view for a participant to keep current.
    expect(screen.queryByText("Submitted")).not.toBeInTheDocument();
    expect(fetchTempAccessSession).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test("rejects malformed and throttled verification codes and reports resend failures", async () => {
    searchParams = new URLSearchParams("code=ABC123&invitation=tok");
    window.history.replaceState(
      {},
      "",
      "/temp-access?code=ABC123&invitation=tok",
    );
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(requestTempAccessCode).toHaveBeenCalled());

    const verify = screen.getByRole("button", {
      name: "Verify and open schedule",
    });
    const codeInput = screen.getByLabelText("Verification code");
    await userEvent.type(codeInput, "12");
    // The browser's own pattern check would stop a click, so submit directly.
    fireEvent.submit(codeInput.closest("form"));
    expect(
      screen.getByText("Enter the six-digit code from your email."),
    ).toBeInTheDocument();
    expect(verifyTempAccess).not.toHaveBeenCalled();

    verifyTempAccess.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { status: 429 }),
    );
    await userEvent.type(screen.getByLabelText("Verification code"), "3456");
    await userEvent.click(verify);
    expect(
      await screen.findByText(
        "Too many attempts. Request a new code after waiting a moment.",
      ),
    ).toBeInTheDocument();

    verifyTempAccess.mockRejectedValueOnce(new Error("nope"));
    await userEvent.click(verify);
    expect(
      await screen.findByText(
        "That code could not be verified. Check the code or request a new one.",
      ),
    ).toBeInTheDocument();

    requestTempAccessCode.mockRejectedValueOnce(new Error("mail down"));
    await userEvent.click(
      screen.getByRole("button", { name: "Send a new code" }),
    );
    expect(
      await screen.findByText(
        "We could not send a new code. Wait a moment and try again.",
      ),
    ).toBeInTheDocument();
  });

  test("explains when the automatic code request fails and when no session exists", async () => {
    searchParams = new URLSearchParams("code=ABC123&invitation=tok");
    window.history.replaceState(
      {},
      "",
      "/temp-access?code=ABC123&invitation=tok",
    );
    requestTempAccessCode.mockRejectedValueOnce(new Error("mail down"));
    const { unmount } = render(<TempAccessClient />);
    expect(
      await screen.findByText(
        "We could not start verification. Try sending the code again.",
      ),
    ).toBeInTheDocument();
    unmount();

    window.sessionStorage.clear();
    searchParams = new URLSearchParams("code=ABC123");
    window.history.replaceState({}, "", "/temp-access?code=ABC123");
    fetchTempAccessSession.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { status: 401 }),
    );
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Access link required" }),
    ).toBeInTheDocument();
    expect(fetchTempAccessSession).toHaveBeenCalledTimes(1);
  });

  test("locks a response after the deadline and while the event is not active", async () => {
    fetchTempAccessSession.mockResolvedValue(
      session({
        event: { ...event, responseDeadline: "2000-01-01T00:00:00Z" },
      }),
    );
    const { unmount } = render(<TempAccessClient />);
    expect(
      await screen.findByText("The response deadline has passed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit availability" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Paint in-person" }),
    ).toBeDisabled();
    unmount();

    fetchTempAccessSession.mockResolvedValue(
      session({
        event: { ...event, status: "closed", responseDeadline: null },
      }),
    );
    render(<TempAccessClient />);
    expect(
      await screen.findByText(
        "Responses are locked while this event is closed.",
      ),
    ).toBeInTheDocument();
  });

  test("fills both channels of a hybrid response and copies one into the other", async () => {
    const mixedEvent = { ...event, mode: "mixed", slotCount: undefined };
    fetchTempAccessSession.mockResolvedValue(session({ event: mixedEvent }));
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Your schedule" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /group availability/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("In-Person Availability"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/submitted response/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Apply to all" }));
    expect(screen.getByTestId("schedule-editor")).toHaveTextContent("1,1");
    expect(screen.getByTestId("virtual-values")).toHaveTextContent("1,1");
    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenLastCalledWith(
        "ABC123",
        expect.objectContaining({
          availabilityInperson: [1, 1],
          availabilityVirtual: [1, 1],
        }),
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Mark all Busy" }),
    );
    expect(screen.getByTestId("virtual-values")).toHaveTextContent("0,0");
    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Paint virtual" }),
    );
    expect(screen.getByTestId("schedule-editor")).toHaveTextContent("1,0");
    expect(screen.getByTestId("virtual-values")).toHaveTextContent("0,1");
    // Painting the same value again is a no-op.
    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy in-person to virtual" }),
    );
    expect(screen.getByTestId("virtual-values")).toHaveTextContent("1,0");
    await waitFor(() =>
      expect(
        screen.getByText("Draft saved. Submit when you are ready."),
      ).toBeInTheDocument(),
    );
  });

  test("an Available start pre-selects Busy, explains the flow, and offers Mark all Available", async () => {
    const availableStart = { ...event, startingAvailability: "available" };
    fetchTempAccessSession.mockResolvedValue(
      session({
        event: availableStart,
        participant: participant({
          availabilityInperson: [1, 1],
          availabilityVirtual: [1, 1],
        }),
      }),
    );
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Your schedule" }),
    ).toBeInTheDocument();

    const choices = screen.getByRole("group", { name: "Availability status" });
    expect(
      within(choices).getByRole("button", { name: "Busy" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(choices).getByRole("button", { name: "Available" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(
        "Every time starts as Available. Paint Busy over the times that do not work for you.",
      ),
    ).toBeInTheDocument();
    // The legacy instruction would contradict the pre-selected Busy brush.
    expect(
      screen.queryByText(
        "Choose a status, then click or drag across the times that work for you.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark all Busy" }),
    ).not.toBeInTheDocument();

    // The pre-selected Busy brush paints 0 over the Available default.
    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    expect(screen.getByTestId("schedule-editor")).toHaveTextContent("0,1");
    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenLastCalledWith(
        "ABC123",
        expect.objectContaining({ availabilityInperson: [0, 1] }),
      ),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Mark all Available" }),
    );
    expect(screen.getByTestId("schedule-editor")).toHaveTextContent("1,1");
    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenLastCalledWith(
        "ABC123",
        expect.objectContaining({ availabilityInperson: [1, 1] }),
      ),
    );
  });

  test("a Busy start keeps the Available brush and hides the Available-start hint", async () => {
    render(<TempAccessClient />);
    expect(
      await screen.findByRole("heading", { name: "Your schedule" }),
    ).toBeInTheDocument();
    const choices = screen.getByRole("group", { name: "Availability status" });
    expect(
      within(choices).getByRole("button", { name: "Available" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Mark all Busy" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Every time starts as Available/),
    ).not.toBeInTheDocument();
  });

  test("reports a submit conflict and a generic submit failure", async () => {
    render(<TempAccessClient />);
    const submit = await screen.findByRole("button", {
      name: "Submit availability",
    });
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        status: 409,
        participant: participant({ version: 9, availabilityInperson: [1, 1] }),
      }),
    );
    await userEvent.click(submit);
    expect(
      await screen.findByText(
        "This schedule changed somewhere else. Reload the latest response before submitting.",
      ),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Reload latest response" }),
    );
    await waitFor(() => expect(submit).toBeEnabled());

    updateTempAccessParticipant.mockRejectedValueOnce(new Error(""));
    await userEvent.click(submit);
    expect(
      await screen.findByText("Failed to submit availability."),
    ).toBeInTheDocument();
  });

  test("warns before unloading with unsaved work", async () => {
    render(<TempAccessClient />);
    await screen.findByRole("button", { name: "Paint in-person" });
    const dispatch = () => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      return unload.defaultPrevented;
    };
    expect(dispatch()).toBe(false);
    let release;
    updateTempAccessParticipant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Paint in-person" }),
    );
    await screen.findByText("Saving draft…");
    expect(dispatch()).toBe(true);
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      release({
        participant: participant({ availabilityInperson: [1, 0], version: 2 }),
      });
    });
    await screen.findByText("Draft saved. Submit when you are ready.");
    expect(dispatch()).toBe(false);
  });
});
