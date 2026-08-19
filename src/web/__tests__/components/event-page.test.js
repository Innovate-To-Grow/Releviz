/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }) => <a href={href}>{children}</a>,
}));

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("@/components/event/EventHeader", () => ({
  __esModule: true,
  default: ({ eventName, eventCode, isOrganizer }) => (
    <div data-testid="event-header" data-organizer={String(isOrganizer)}>
      {eventName}:{eventCode}
    </div>
  ),
}));

jest.mock("@/components/schedule/ParticipantView", () => {
  const React = jest.requireActual("react");
  const EventContext = jest.requireActual(
    "@/components/event/EventContext",
  ).default;

  function MockParticipantView() {
    const { respondIntent, consumeRespondIntent } =
      React.useContext(EventContext);
    return (
      <div
        data-testid="participant-workflow"
        data-respond-intent={String(Boolean(respondIntent))}
      >
        Participant workflow
        <button type="button" onClick={consumeRespondIntent}>
          Consume response intent
        </button>
      </div>
    );
  }

  return { __esModule: true, default: MockParticipantView };
});

jest.mock("@/components/schedule/OrganizerView", () => ({
  __esModule: true,
  default: () => <div>Organizer workflow</div>,
}));

jest.mock("@/lib/api/events", () => ({
  fetchEvent: jest.fn(),
  markInvitationOpened: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
  replaceUrl: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import EventPage, { isDemoEventPreview } from "@/components/event/EventPage";
import { fetchEvent, markInvitationOpened } from "@/lib/api/events";
import { navigateTo, replaceUrl } from "@/lib/navigation";

const user = { id: "member-1", displayName: "Member" };
const event = {
  code: "EVENT123",
  name: "Planning session",
  organizerUserId: "organizer-1",
  slotCount: 2,
};

function auth(overrides = {}) {
  useAuth.mockReturnValue({
    user,
    loading: false,
    getToken: jest.fn().mockResolvedValue("token"),
    ...overrides,
  });
}

describe("event page routing", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    searchParams = new URLSearchParams("code=EVENT123");
    auth();
    window.history.replaceState({}, "", "/event?code=EVENT123");
  });

  test("loads a participant event with the authenticated API", async () => {
    fetchEvent.mockResolvedValue({ event });

    render(<EventPage />);

    expect(await screen.findByText("Participant workflow")).toBeInTheDocument();
    expect(screen.getByTestId("event-header")).toHaveTextContent(
      "Planning session:EVENT123",
    );
    expect(screen.getByTestId("event-header")).toHaveAttribute(
      "data-organizer",
      "false",
    );
    expect(fetchEvent).toHaveBeenCalledWith("EVENT123", "token");
  });

  test("enables the exact design-preview URL only in development", () => {
    const demoParams = new URLSearchParams("code=DEMO2026&demo=1");

    expect(isDemoEventPreview(demoParams, "development")).toBe(true);
    expect(isDemoEventPreview(demoParams, "production")).toBe(false);
    expect(isDemoEventPreview(demoParams, "test")).toBe(false);
    expect(
      isDemoEventPreview(
        new URLSearchParams("code=DEMO2026&demo=0"),
        "development",
      ),
    ).toBe(false);
    expect(
      isDemoEventPreview(
        new URLSearchParams("code=OTHER&demo=1"),
        "development",
      ),
    ).toBe(false);
  });

  test("keeps a demo-shaped URL on the authenticated live path in tests", async () => {
    searchParams = new URLSearchParams("code=DEMO2026&demo=1");
    fetchEvent.mockResolvedValue({ event: { ...event, code: "DEMO2026" } });

    render(<EventPage />);

    expect(await screen.findByText("Participant workflow")).toBeInTheDocument();
    expect(fetchEvent).toHaveBeenCalledWith("DEMO2026", "token");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test("passes and consumes a one-time response intent", async () => {
    searchParams = new URLSearchParams("code=EVENT123&respond=1");
    window.history.replaceState(
      {},
      "",
      "/event?code=EVENT123&respond=1#availability",
    );
    fetchEvent.mockResolvedValue({ event });

    render(<EventPage />);

    expect(await screen.findByTestId("participant-workflow")).toHaveAttribute(
      "data-respond-intent",
      "true",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Consume response intent" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("participant-workflow")).toHaveAttribute(
        "data-respond-intent",
        "false",
      ),
    );
    expect(replaceUrl).toHaveBeenCalledWith(
      "/event?code=EVENT123#availability",
    );
  });

  test("clears a response intent when the current user is the organizer", async () => {
    searchParams = new URLSearchParams("code=EVENT123&respond=1");
    window.history.replaceState({}, "", "/event?code=EVENT123&respond=1");
    fetchEvent.mockResolvedValue({
      event: { ...event, organizerUserId: user.id },
    });

    render(<EventPage />);

    expect(await screen.findByText("Organizer workflow")).toBeInTheDocument();
    await waitFor(() =>
      expect(replaceUrl).toHaveBeenCalledWith("/event?code=EVENT123"),
    );
  });

  test("marks an invitation opened, removes the capability token, and loads organizer tools", async () => {
    searchParams = new URLSearchParams(
      "code=EVENT123&invitation=private-token",
    );
    window.history.replaceState(
      {},
      "",
      "/event?code=EVENT123&invitation=private-token#availability",
    );
    markInvitationOpened.mockRejectedValue(new Error("tracking unavailable"));
    fetchEvent.mockResolvedValue({
      event: { ...event, organizerUserId: user.id },
    });

    render(<EventPage />);

    expect(await screen.findByText("Organizer workflow")).toBeInTheDocument();
    expect(screen.getByTestId("event-header")).toHaveAttribute(
      "data-organizer",
      "true",
    );
    expect(markInvitationOpened).toHaveBeenCalledWith(
      "EVENT123",
      "private-token",
    );
    expect(replaceUrl).toHaveBeenCalledWith(
      "/event?code=EVENT123#availability",
    );
  });

  test("redirects unauthenticated users without retaining invitation credentials", async () => {
    auth({ user: null });

    render(<EventPage />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/login?next=%2Fevent%3Fcode%3DEVENT123",
      ),
    );
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  test("requires profile completion before loading a direct event link", async () => {
    auth({ requiresProfileCompletion: true });

    render(<EventPage />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DEVENT123",
      ),
    );
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  test("shows missing-code and API error states", async () => {
    searchParams = new URLSearchParams();
    const missing = render(<EventPage />);
    expect(
      await screen.findByRole("heading", { name: "Event Not Found" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No event code in URL")).toBeInTheDocument();
    missing.unmount();

    searchParams = new URLSearchParams("code=UNKNOWN");
    fetchEvent.mockRejectedValue(new Error("Access denied"));
    render(<EventPage />);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Create New Event" }),
    ).toHaveAttribute("href", "/create");
  });

  test("keeps loading while authentication is pending", () => {
    auth({ loading: true });
    render(<EventPage />);
    expect(screen.getByText("Loading event...")).toBeInTheDocument();
  });

  test("does not block event loading on pending invitation telemetry", async () => {
    auth();
    searchParams = new URLSearchParams("code=EVENT123&invitation=token");
    window.history.replaceState(
      {},
      "",
      "/event?code=EVENT123&invitation=token",
    );
    markInvitationOpened.mockReturnValue(new Promise(() => {}));
    fetchEvent.mockResolvedValue({ event });

    render(<EventPage />);

    expect(await screen.findByText("Participant workflow")).toBeInTheDocument();
    expect(replaceUrl).toHaveBeenCalledWith("/event?code=EVENT123");
  });

  test("ignores an older event request that settles after a route change", async () => {
    let resolveFirst;
    const firstRequest = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    fetchEvent.mockImplementation((code) =>
      code === "EVENT123"
        ? firstRequest
        : Promise.resolve({
            event: {
              ...event,
              code: "SECOND",
              name: "Second event",
            },
          }),
    );

    const view = render(<EventPage />);
    await waitFor(() =>
      expect(fetchEvent).toHaveBeenCalledWith("EVENT123", "token"),
    );

    searchParams = new URLSearchParams("code=SECOND");
    window.history.replaceState({}, "", "/event?code=SECOND");
    view.rerender(<EventPage />);

    expect(await screen.findByText("Second event:SECOND")).toBeInTheDocument();
    resolveFirst({ event });
    await waitFor(() =>
      expect(screen.getByTestId("event-header")).toHaveTextContent(
        "Second event:SECOND",
      ),
    );
  });

  test("cancels a queued event load when the route unmounts immediately", async () => {
    fetchEvent.mockResolvedValue({ event });
    const view = render(<EventPage />);
    view.unmount();
    await Promise.resolve();
    expect(fetchEvent).not.toHaveBeenCalled();
  });
});
