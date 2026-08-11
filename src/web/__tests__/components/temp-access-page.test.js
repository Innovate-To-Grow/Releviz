/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  default: ({ inperson, readOnly, onInpersonPaint }) => (
    <div data-testid="schedule-editor">
      <span>{inperson.join(",")}</span>
      <button disabled={readOnly} onClick={() => onInpersonPaint(0)}>
        Paint in-person
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

const event = {
  code: "ABC123",
  name: "Design review",
  mode: "inperson",
  status: "open",
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
    results: null,
    canViewResults: false,
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

    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(screen.getByText("You are responding as Temporary Taylor")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /dashboard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upgrade to full access" })).toHaveAttribute(
      "href",
      "/signup?upgrade=temporary&code=ABC123&next=%2Fevent%3Fcode%3DABC123"
    );
    const upgradeHref = screen
      .getByRole("link", { name: "Upgrade to full access" })
      .getAttribute("href");
    expect(new URLSearchParams(upgradeHref.split("?")[1]).has("email")).toBe(false);
    expect(upgradeHref).not.toContain("lockedEmail");
    expect(requestTempAccessCode).not.toHaveBeenCalled();
  });

  test("strips the invitation token, requests a code, and verifies access", async () => {
    searchParams = new URLSearchParams("code=ABC123&invitation=secret-link-token");
    window.history.replaceState({}, "", "/temp-access?code=ABC123&invitation=secret-link-token");

    render(<TempAccessClient />);

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    await waitFor(() =>
      expect(requestTempAccessCode).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "secret-link-token",
      })
    );
    expect(window.location.search).toBe("?code=ABC123");

    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify and open schedule" }));

    await waitFor(() =>
      expect(verifyTempAccess).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "secret-link-token",
        verificationCode: "123456",
      })
    );
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("releviz.temp-access.invitation:ABC123")).toBeNull();
  });

  test("lets an explicit invitation override an existing same-event cookie session", async () => {
    searchParams = new URLSearchParams("code=ABC123&invitation=invite-for-a-different-person");
    window.history.replaceState(
      {},
      "",
      "/temp-access?code=ABC123&invitation=invite-for-a-different-person"
    );
    fetchTempAccessSession.mockResolvedValue(
      session({ participant: participant({ name: "Previous browser user" }) })
    );

    render(<TempAccessClient />);

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    await waitFor(() =>
      expect(requestTempAccessCode).toHaveBeenCalledWith({
        code: "ABC123",
        invitationToken: "invite-for-a-different-person",
      })
    );
    expect(fetchTempAccessSession).not.toHaveBeenCalled();
    expect(
      screen.queryByText("You are responding as Previous browser user")
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
      })
    );

    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
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
      })
    );
    expect(await screen.findByText(/schedule changed somewhere else/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paint in-person" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reload latest response" }));
    await waitFor(() => expect(screen.getByTestId("schedule-editor")).toHaveTextContent("1,1"));
    expect(screen.getByRole("button", { name: "Paint in-person" })).not.toBeDisabled();
  });

  test("refreshes permission-derived results when reloading a shared-response conflict", async () => {
    jest.useFakeTimers();
    const visibleResults = {
      countedResponseTotal: 1,
      unansweredParticipantTotal: 0,
      channels: { inperson: { unweighted: [1, 1] } },
    };
    const latestDraft = participant({
      availabilityInperson: [0.5, 0],
      submitted: false,
      version: 9,
    });
    fetchTempAccessSession
      .mockResolvedValueOnce(
        session({
          participant: participant({ submitted: true }),
          canViewResults: true,
          results: visibleResults,
        })
      )
      .mockResolvedValueOnce(
        session({ participant: latestDraft, canViewResults: false, results: null })
      );
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Version conflict"), {
        status: 409,
        participant: latestDraft,
      })
    );

    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Group availability" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    expect(await screen.findByText(/schedule changed somewhere else/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Group availability" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest response" }));

    await waitFor(() => expect(fetchTempAccessSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("schedule-editor")).toHaveTextContent("0.5,0"));
    expect(screen.queryByRole("heading", { name: "Group availability" })).not.toBeInTheDocument();
  });

  test.each(["closed", "archived"])(
    "reloads and locks the schedule when the event is remotely %s",
    async (status) => {
      jest.useFakeTimers();
      fetchTempAccessSession
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(session({ event: { ...event, status } }));
      updateTempAccessParticipant.mockRejectedValueOnce(
        Object.assign(new Error(`Responses are locked while this event is ${status}.`), {
          status: 409,
        })
      );

      render(<TempAccessClient />);
      expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
      await act(async () => {
        jest.advanceTimersByTime(701);
        await Promise.resolve();
      });

      await waitFor(() => expect(fetchTempAccessSession).toHaveBeenCalledTimes(2));
      expect(
        (await screen.findAllByText(`Responses are locked while this event is ${status}.`)).length
      ).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Paint in-person" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();
    }
  );

  test("locks an excluded response instead of retrying a server-denied write", async () => {
    jest.useFakeTimers();
    fetchTempAccessSession.mockResolvedValueOnce(session()).mockResolvedValueOnce(session());
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("Excluded participants cannot change availability"), { status: 403 })
    );

    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchTempAccessSession).toHaveBeenCalledTimes(2));
    expect(
      (await screen.findAllByText("Excluded participants cannot change availability")).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Paint in-person" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();
  });

  test("exits temporary access when the account upgrades in another session", async () => {
    jest.useFakeTimers();
    updateTempAccessParticipant.mockRejectedValueOnce(
      Object.assign(new Error("This account now has full access. Sign in to continue."), {
        status: 403,
        errorCode: "temp_account_upgraded",
      })
    );

    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("heading", { name: "Temporary access ended" })
    ).toBeInTheDocument();
    expect(screen.getByText(/account now has full access/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Design review" })).not.toBeInTheDocument();
  });

  test("submits the shared response and signs out of only the temporary session", async () => {
    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Submit availability" }));
    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenCalledWith("ABC123", {
        submitted: 1,
        expectedVersion: 1,
      })
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(logoutTempAccess).toHaveBeenCalledWith("ABC123"));
    expect(await screen.findByRole("heading", { name: "You are signed out" })).toBeInTheDocument();
  });

  test("does not claim sign-out when the server cannot revoke the temporary session", async () => {
    logoutTempAccess.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText(/sign out could not be confirmed.*session may still be active/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "You are signed out" })).not.toBeInTheDocument();
  });

  test("flushes a pending autosave before navigating to full-account upgrade", async () => {
    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await userEvent.click(screen.getByRole("link", { name: "Upgrade to full access" }));

    await waitFor(() =>
      expect(updateTempAccessParticipant).toHaveBeenCalledWith("ABC123", {
        availabilityInperson: [1, 0],
        availabilityVirtual: [0, 0],
        submitted: 0,
        expectedVersion: 1,
      })
    );
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/signup?upgrade=temporary&code=ABC123&next=%2Fevent%3Fcode%3DABC123"
      )
    );
    expect(updateTempAccessParticipant.mock.invocationCallOrder[0]).toBeLessThan(
      navigateTo.mock.invocationCallOrder[0]
    );
  });

  test("stays on the event when a pending draft cannot be flushed before sign out", async () => {
    updateTempAccessParticipant.mockRejectedValueOnce(new Error("Save unavailable"));
    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Design review" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText(/resolve the save error before signing out/i)
    ).toBeInTheDocument();
    expect(logoutTempAccess).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Design review" })).toBeInTheDocument();
  });

  test("conservatively hides stale results after a submitted response becomes a draft", async () => {
    jest.useFakeTimers();
    const visibleResults = {
      countedResponseTotal: 1,
      unansweredParticipantTotal: 0,
      channels: { inperson: { unweighted: [1, 1] } },
    };
    fetchTempAccessSession
      .mockResolvedValueOnce(
        session({
          participant: participant({ submitted: true }),
          canViewResults: true,
          results: visibleResults,
        })
      )
      .mockRejectedValueOnce(new Error("Results refresh unavailable"));

    render(<TempAccessClient />);
    expect(await screen.findByRole("heading", { name: "Group availability" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paint in-person" }));
    await act(async () => {
      jest.advanceTimersByTime(701);
      await Promise.resolve();
    });

    await waitFor(() => expect(updateTempAccessParticipant).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Group availability" })).not.toBeInTheDocument()
    );
    jest.useRealTimers();
  });
});
