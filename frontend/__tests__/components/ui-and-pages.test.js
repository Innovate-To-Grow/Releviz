/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import AppButton from "@/components/ui/AppButton";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import { DAY_LABELS, DAYS_PER_WEEK } from "@/lib/constants";
import { formatHour, formatMode } from "@/lib/format";

jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), { virtual: true });
jest.mock("@material/web/select/outlined-select.js", () => ({}), { virtual: true });
jest.mock("@material/web/select/select-option.js", () => ({}), { virtual: true });
jest.mock("@material/web/slider/slider.js", () => ({}), { virtual: true });
jest.mock("@material/web/checkbox/checkbox.js", () => ({}), { virtual: true });

const push = jest.fn();
const replace = jest.fn();
const redirect = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  redirect: (...args) => redirect(...args),
  useRouter: () => ({ push, replace }),
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

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, ...props }) => <img alt={alt || ""} {...props} />,
}));

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
  AuthProvider: function MockAuthProvider({ children }) {
    return <div data-testid="provider">{children}</div>;
  },
}));

jest.mock(
  "@/components/HomePageClient",
  () =>
    function MockHomePageClient() {
      return <div>home client</div>;
    }
);
jest.mock(
  "@/components/event/CreateEventClient",
  () =>
    function MockCreateEventClient() {
      return <div>create client</div>;
    }
);
jest.mock(
  "@/components/dashboard/DashboardPageClient",
  () =>
    function MockDashboardPageClient() {
      return <div>dashboard client</div>;
    }
);
jest.mock(
  "@/components/event/EventPageClient",
  () =>
    function MockEventPageClient() {
      return <div>event client</div>;
    }
);

import { useAuth } from "@/components/auth/AuthContext";
import Home from "@/app/page";
import RootLayout from "@/app/layout";
import NotFound from "@/app/not-found";
import CreatePage from "@/app/create/page";
import DashboardPage from "@/app/dashboard/page";
import EventPageRoute from "@/app/event/page";
import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import SettingsPage from "@/app/settings/page";
import SignInPage from "@/app/sign-in/[[...sign-in]]/page";
import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";

describe("small UI modules", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    delete window.location;
    window.location = { assign: jest.fn() };
  });

  test("format and constants helpers", () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(DAY_LABELS).toContain("Mon");
    expect(formatHour(0)).toBe("12:00 AM");
    expect(formatHour(12)).toBe("12:00 PM");
    expect(formatHour(23)).toBe("11:00 PM");
    expect(formatMode("virtual")).toBe("Virtual");
    expect(formatMode("mixed")).toBe("Mixed");
    expect(formatMode("inperson")).toBe("In-Person");
  });

  test("AppButton renders variants and optional icon", () => {
    render(
      <>
        <AppButton icon={<span data-testid="icon" />} fullWidth className="extra">
          Save
        </AppButton>
        <AppButton variant="outlined">Cancel</AppButton>
      </>
    );
    expect(screen.getByText("Save").closest("button")).toHaveClass("app-btn-full", "extra");
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("Cancel").closest("button")).toHaveClass("app-btn-outlined");
  });

  test("ScheduleGrid paints mouse and touch cells and renders values/tooltips", () => {
    const painted = jest.fn();
    const schedule = Array(14).fill(0);
    schedule[1] = 1;
    document.elementFromPoint = jest.fn();
    render(
      <ScheduleGrid
        schedule={schedule}
        startHour={9}
        endHour={11}
        selectedDays={[1, 2]}
        readOnly={false}
        showValues
        onCellPaint={painted}
        label="Availability"
        participantDetails={[{ name: "Ada", schedule }]}
      />
    );
    const cell = document.querySelector("[data-cell-idx='1']");
    fireEvent.mouseDown(cell);
    fireEvent.mouseMove(cell, { buttons: 1 });
    document.elementFromPoint.mockReturnValue(cell);
    fireEvent.touchStart(cell);
    fireEvent.touchMove(cell, { touches: [{ clientX: 1, clientY: 1 }] });
    expect(painted).toHaveBeenCalled();
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(document.querySelector("[data-cell-idx='1']")).toHaveAttribute("title", "Ada: 1.00");
  });

  test("ScheduleGrid supports read-only specific dates", () => {
    const painted = jest.fn();
    render(
      <ScheduleGrid
        schedule={[0.5, 1]}
        startHour={9}
        endHour={10}
        readOnly
        showValues
        onCellPaint={painted}
        daySelectionType="specific_dates"
        specificDates={["2026-07-08", "2026-07-09"]}
      />
    );
    fireEvent.mouseDown(document.querySelector("[data-cell-idx='0']"));
    expect(painted).not.toHaveBeenCalled();
    expect(screen.getByText("2026-07-08")).toBeInTheDocument();
  });

  test("ScheduleGrid defaults to all days and handles empty touch targets", () => {
    const painted = jest.fn();
    document.elementFromPoint = jest.fn().mockReturnValue(null);
    render(
      <ScheduleGrid
        schedule={Array(7).fill(0)}
        startHour={9}
        endHour={10}
        readOnly={false}
        showValues={false}
        onCellPaint={painted}
      />
    );
    fireEvent.touchMove(document.querySelector("[data-cell-idx='0']"), {
      touches: [{ clientX: 1, clientY: 1 }],
    });
    expect(screen.getByText("Sun")).toBeInTheDocument();
  });

  test("ScheduleGrid uses virtual color scheme when virtual prop is true", () => {
    const schedule = Array(56).fill(1);
    render(
      <ScheduleGrid
        schedule={schedule}
        startHour={9}
        endHour={17}
        selectedDays={[0, 1, 2, 3, 4, 5, 6]}
        readOnly={true}
        showValues={true}
        virtual={true}
      />
    );
    const cells = document.querySelectorAll("[data-cell-idx]");
    expect(cells.length).toBeGreaterThan(0);
  });

  test("EventDetailsGrid renders defaults, dates, and extra cards", () => {
    render(
      <EventDetailsGrid
        event={{
          name: "Planning",
          mode: "mixed",
          startHour: 9,
          endHour: 11,
          days: [1, 2],
          location: "Room",
          daySelectionType: "specific_dates",
          specificDates: ["2026-07-08"],
        }}
        extraCards={[{ label: "Participants", value: 3 }]}
      />
    );
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  test("EventDetailsGrid renders fallback values", () => {
    render(<EventDetailsGrid event={{}} />);
    expect(screen.getByText("In-Person")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
  });
});

describe("app pages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    delete window.location;
    window.location = { assign: jest.fn() };
  });

  test("wrapper pages render expected clients and redirects", () => {
    render(
      <RootLayout>
        <main>child</main>
      </RootLayout>
    );
    expect(screen.getByTestId("provider")).toBeInTheDocument();
    render(<Home />);
    render(<CreatePage />);
    render(<DashboardPage />);
    render(<EventPageRoute />);
    render(<NotFound />);
    expect(screen.getByText("home client")).toBeInTheDocument();
    expect(screen.getByText("create client")).toBeInTheDocument();
    expect(screen.getByText("dashboard client")).toBeInTheDocument();
    expect(screen.getByText("event client")).toBeInTheDocument();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    SignInPage();
    SignUpPage();
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(redirect).toHaveBeenCalledWith("/signup");
  });

  test("Login submits, sanitizes next, and shows errors", async () => {
    const login = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({
      login,
      requestEmailLoginCode: jest.fn(),
      verifyEmailLoginCode: jest.fn(),
    });
    searchParams = new URLSearchParams("next=//evil.example");
    const firstLogin = render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/dashboard"));

    firstLogin.unmount();
    login.mockRejectedValueOnce(new Error("Bad login"));
    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Bad login")).toBeInTheDocument();

    login.mockRejectedValueOnce(new Error());
    searchParams = new URLSearchParams("next=/create");
    render(<LoginPage />);
    await userEvent.type(screen.getAllByLabelText("Email").at(-1), "ada@example.com");
    await userEvent.type(screen.getAllByLabelText("Password").at(-1), "bad");
    await userEvent.click(screen.getAllByRole("button", { name: "Log in" }).at(-1));
    expect(await screen.findByText("Unable to log in.")).toBeInTheDocument();

    login.mockResolvedValueOnce({});
    searchParams = new URLSearchParams();
    render(<LoginPage />);
    await userEvent.type(screen.getAllByLabelText("Email").at(-1), "ada@example.com");
    await userEvent.type(screen.getAllByLabelText("Password").at(-1), "password123");
    await userEvent.click(screen.getAllByRole("button", { name: "Log in" }).at(-1));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/dashboard"));
  });

  test("Login supports email code flow and mode switching", async () => {
    const login = jest.fn();
    const requestEmailLoginCode = jest.fn().mockResolvedValue({});
    const verifyEmailLoginCode = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({ login, requestEmailLoginCode, verifyEmailLoginCode });
    searchParams = new URLSearchParams("next=/event?code=ABC123");
    const firstLogin = render(<LoginPage />);

    await userEvent.click(screen.getByRole("button", { name: "Email code" }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send login code" }));
    await waitFor(() =>
      expect(requestEmailLoginCode).toHaveBeenCalledWith({ email: "ada@example.com" })
    );
    expect(
      await screen.findByText("Verification code sent. Check your email.")
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() =>
      expect(verifyEmailLoginCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        code: "123456",
      })
    );
    expect(window.location.assign).toHaveBeenCalledWith("/event?code=ABC123");

    await userEvent.click(screen.getByRole("button", { name: "Password" }));
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    firstLogin.unmount();

    requestEmailLoginCode.mockRejectedValueOnce(new Error("No code"));
    const secondLogin = render(<LoginPage />);
    await userEvent.click(screen.getByRole("button", { name: "Email code" }));
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send login code" }));
    expect(await screen.findByText("No code")).toBeInTheDocument();
    secondLogin.unmount();

    requestEmailLoginCode.mockResolvedValueOnce({});
    verifyEmailLoginCode.mockRejectedValueOnce(new Error());
    render(<LoginPage />);
    await userEvent.click(screen.getAllByRole("button", { name: "Email code" }).at(-1));
    await userEvent.type(screen.getAllByLabelText("Email").at(-1), "ada@example.com");
    await userEvent.click(screen.getAllByRole("button", { name: "Send login code" }).at(-1));
    await screen.findByText("Verification code sent. Check your email.");
    await userEvent.type(screen.getAllByLabelText("Verification code").at(-1), "000000");
    await userEvent.click(screen.getAllByRole("button", { name: "Log in" }).at(-1));
    expect(await screen.findByText("Unable to verify code.")).toBeInTheDocument();
  });

  test("Signup validates passwords, starts registration, verifies, and shows errors", async () => {
    const signup = jest.fn().mockResolvedValue({});
    const verifySignup = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({ signup, verifySignup });
    const firstSignup = render(<SignupPage />);
    await userEvent.type(screen.getByLabelText("First name"), "Ada");
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace");
    await userEvent.type(screen.getByLabelText("Organization"), "Scheduler");
    await userEvent.type(screen.getByLabelText("Title"), "Engineer");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.type(screen.getByLabelText("Confirm password"), "different123");
    await userEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password123" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    await waitFor(() => expect(signup).toHaveBeenCalled());
    await userEvent.type(await screen.findByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("/dashboard"));
    await screen.findByRole("button", { name: "Verify and continue" });

    verifySignup.mockRejectedValueOnce(new Error("Bad code"));
    await userEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(await screen.findByText("Bad code")).toBeInTheDocument();

    verifySignup.mockRejectedValueOnce(new Error());
    await userEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(await screen.findByText("Unable to verify code.")).toBeInTheDocument();

    firstSignup.unmount();
    signup.mockRejectedValueOnce(new Error("No signup"));
    render(<SignupPage />);
    await userEvent.type(screen.getByLabelText("First name"), "Ada");
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace");
    await userEvent.type(screen.getByLabelText("Organization"), "Scheduler");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.type(screen.getByLabelText("Confirm password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    expect(await screen.findByText("No signup")).toBeInTheDocument();

    signup.mockRejectedValueOnce(new Error());
    render(<SignupPage />);
    await userEvent.type(screen.getAllByLabelText("First name").at(-1), "Ada");
    await userEvent.type(screen.getAllByLabelText("Last name").at(-1), "Lovelace");
    await userEvent.type(screen.getAllByLabelText("Organization").at(-1), "Scheduler");
    await userEvent.type(screen.getAllByLabelText("Email").at(-1), "ada@example.com");
    await userEvent.type(screen.getAllByLabelText("Password").at(-1), "password123");
    await userEvent.type(screen.getAllByLabelText("Confirm password").at(-1), "password123");
    await userEvent.click(screen.getAllByRole("button", { name: "Send verification code" }).at(-1));
    expect(await screen.findByText("Unable to start registration.")).toBeInTheDocument();
  });

  test("Settings redirects unauthenticated users and saves profiles", async () => {
    useAuth.mockReturnValue({ user: null, loading: false, updateProfile: jest.fn() });
    render(<SettingsPage />);
    expect(window.location.assign).toHaveBeenCalledWith("/login?next=/settings");

    const updateProfile = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      user: {
        id: "u1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        organization: "Scheduler",
        title: "Engineer",
      },
    });
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "King" } });
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "Math" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Countess" } });
    let savedTimeout;
    const timeoutSpy = jest.spyOn(window, "setTimeout").mockImplementation((callback) => {
      savedTimeout = callback;
      return 1;
    });
    fireEvent.click(screen.getByText("Save"));
    await act(async () => {});
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Augusta",
        last_name: "King",
        organization: "Math",
        title: "Countess",
      })
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    act(() => savedTimeout());
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    timeoutSpy.mockRestore();

    updateProfile.mockRejectedValueOnce(new Error("No save"));
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("No save")).toBeInTheDocument();

    updateProfile.mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("Unable to save profile.")).toBeInTheDocument();
  });
});

describe("EventHeader", () => {
  beforeEach(() => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
  });

  test("displays event code next to event name", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="ABC12345" />);
    expect(screen.getByText("Team Sync")).toBeInTheDocument();
    expect(screen.getByText("#ABC12345")).toBeInTheDocument();
  });

  test("does not show event code when not provided", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="" />);
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  test("shows My Dashboard link in user menu when logged in", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="ABC12345" />);
    fireEvent.click(screen.getByText("Prachi"));
    expect(screen.getByText("My Dashboard")).toBeInTheDocument();
  });

  test("shows Organizer badge when isOrganizer is true", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="ABC12345" isOrganizer={true} />);
    expect(screen.getByText("Organizer")).toBeInTheDocument();
  });

  test("shows Participant badge when isOrganizer is false", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="ABC12345" isOrganizer={false} />);
    expect(screen.getByText("Participant")).toBeInTheDocument();
  });

  test("shows no role badge when isOrganizer is undefined", async () => {
    const { default: EventHeader } = await import("@/components/event/EventHeader");
    render(<EventHeader eventName="Team Sync" eventCode="ABC12345" />);
    expect(screen.queryByText("Organizer")).not.toBeInTheDocument();
    expect(screen.queryByText("Participant")).not.toBeInTheDocument();
  });
});

describe("CreateEvent", () => {
  beforeEach(() => {
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      getToken: jest.fn().mockResolvedValue("mock-token"),
    });
  });

  test("allows submitting without an event name", async () => {
    const { default: CreateEvent } = await import("@/components/event/CreateEvent");
    render(<CreateEvent />);
    // Should NOT show "Event name is required" error when name is empty
    const button = screen.getByText("Create Event");
    fireEvent.click(button);
    expect(screen.queryByText(/event name is required/i)).not.toBeInTheDocument();
  });
});

describe("AppHeader", () => {
  test("shows page title and user name", async () => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    expect(screen.getByText("Releviz")).toBeInTheDocument();
    expect(screen.getByText("/ My Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Prachi")).toBeInTheDocument();
  });

  test("shows login button when not logged in", async () => {
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    expect(screen.getByText("Login")).toBeInTheDocument();
  });

  test("shows context label when provided", async () => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" contextLabel="Organizer" />);
    expect(screen.getByText("Organizer")).toBeInTheDocument();
  });

  test("shows dropdown menu when user clicks their name", async () => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    fireEvent.click(screen.getByText("Prachi"));
    expect(screen.getByText("My Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });

  test("calls logout when Log out is clicked", async () => {
    const mockLogout = jest.fn().mockResolvedValue(undefined);
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: mockLogout,
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    fireEvent.click(screen.getByText("Prachi"));
    fireEvent.click(screen.getByText("Log out"));
    expect(mockLogout).toHaveBeenCalled();
  });

  test("closes dropdown when Settings link is clicked", async () => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    fireEvent.click(screen.getByText("Prachi"));
    expect(screen.getByText("Settings")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Settings"));
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
  });
  test("closes dropdown when My Dashboard link is clicked", async () => {
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    fireEvent.click(screen.getByText("Prachi"));
    // getAllByText because "My Dashboard" appears in both page title and dropdown
    const dashboardLinks = screen.getAllByText(/My Dashboard/);
    fireEvent.click(dashboardLinks[dashboardLinks.length - 1]);
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
  });
  test("shows nothing when auth is loading", async () => {
    useAuth.mockReturnValue({
      user: null,
      loading: true,
      logout: jest.fn(),
    });
    const { AppHeader } = await import("@/components/ui/AppHeader");
    render(<AppHeader pageTitle="My Dashboard" />);
    expect(screen.queryByText("Login")).not.toBeInTheDocument();
    expect(screen.queryByText("Prachi")).not.toBeInTheDocument();
  });
});
