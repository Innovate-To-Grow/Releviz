/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
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

jest.mock("@/components/schedule/ParticipantView", () => ({
  __esModule: true,
  default: () => <div>Participant workflow</div>,
}));

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
import EventPage from "@/components/event/EventPage";
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
    expect(screen.getByTestId("event-header")).toHaveTextContent("Planning session:EVENT123");
    expect(screen.getByTestId("event-header")).toHaveAttribute("data-organizer", "false");
    expect(fetchEvent).toHaveBeenCalledWith("EVENT123", "token");
  });

  test("marks an invitation opened, removes the capability token, and loads organizer tools", async () => {
    searchParams = new URLSearchParams("code=EVENT123&invitation=private-token");
    window.history.replaceState(
      {},
      "",
      "/event?code=EVENT123&invitation=private-token#availability"
    );
    markInvitationOpened.mockRejectedValue(new Error("tracking unavailable"));
    fetchEvent.mockResolvedValue({
      event: { ...event, organizerUserId: user.id },
    });

    render(<EventPage />);

    expect(await screen.findByText("Organizer workflow")).toBeInTheDocument();
    expect(screen.getByTestId("event-header")).toHaveAttribute("data-organizer", "true");
    expect(markInvitationOpened).toHaveBeenCalledWith("EVENT123", "private-token");
    expect(replaceUrl).toHaveBeenCalledWith("/event?code=EVENT123#availability");
  });

  test("redirects unauthenticated users without retaining invitation credentials", async () => {
    auth({ user: null });

    render(<EventPage />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith("/login?next=%2Fevent%3Fcode%3DEVENT123")
    );
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  test("shows missing-code and API error states", async () => {
    searchParams = new URLSearchParams();
    const missing = render(<EventPage />);
    expect(await screen.findByRole("heading", { name: "Event Not Found" })).toBeInTheDocument();
    expect(screen.getByText("No event code in URL")).toBeInTheDocument();
    missing.unmount();

    searchParams = new URLSearchParams("code=UNKNOWN");
    fetchEvent.mockRejectedValue(new Error("Access denied"));
    render(<EventPage />);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create New Event" })).toHaveAttribute("href", "/");
  });

  test("keeps the loading state while authentication or invitation tracking is pending", () => {
    auth({ loading: true });
    const authPending = render(<EventPage />);
    expect(screen.getByText("Loading event...")).toBeInTheDocument();
    authPending.unmount();

    auth();
    searchParams = new URLSearchParams("code=EVENT123&invitation=token");
    markInvitationOpened.mockReturnValue(new Promise(() => {}));
    render(<EventPage />);
    expect(screen.getByText("Loading event...")).toBeInTheDocument();
  });
});
