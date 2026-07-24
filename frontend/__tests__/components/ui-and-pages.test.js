/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import EventHeader from "@/components/event/EventHeader";
import { DAY_LABELS, DAYS_PER_WEEK } from "@/lib/constants";
import { formatHour, formatMode, formatTime } from "@/lib/format";

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

jest.mock("@/lib/api/auth", () => ({
  confirmPasswordReset: jest.fn(),
  requestPasswordResetCode: jest.fn(),
}));

jest.mock("@/lib/api/feedback", () => ({
  submitFeedback: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
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
    function MockCreateEventClient({ operation }) {
      return <div>{operation === "edit" ? "edit client" : "create client"}</div>;
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
import EditEventPage from "@/app/edit/page";
import EventPageRoute from "@/app/event/page";
import LoginPage from "@/app/login/page";
import RecoverAccountPage from "@/app/recover/page";
import SignupPage from "@/app/signup/page";
import SettingsPage from "@/app/settings/page";
import FeedbackPage, { safeFeedbackPath } from "@/app/feedback/page";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import SupportPage, { metadata as supportMetadata } from "@/app/support/page";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import SignInPage from "@/app/sign-in/[[...sign-in]]/page";
import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";
import { confirmPasswordReset, requestPasswordResetCode } from "@/lib/api/auth";
import { submitFeedback } from "@/lib/api/feedback";
import { navigateTo } from "@/lib/navigation";

describe("small UI modules", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
  });

  test("format and constants helpers", () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(DAY_LABELS).toContain("Mon");
    expect(formatHour(0)).toBe("12:00 AM");
    expect(formatHour(12)).toBe("12:00 PM");
    expect(formatHour(23)).toBe("11:00 PM");
    expect(formatTime("09:15")).toBe("9:15 AM");
    expect(formatTime("23:30")).toBe("11:30 PM");
    expect(formatTime("00:00")).toBe("12:00 AM");
    expect(formatTime("24:00")).toBe("Not set");
    expect(formatTime("23:60")).toBe("Not set");
    expect(formatTime("bad")).toBe("Not set");
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
    const schedule = Array(4).fill(0);
    schedule[1] = 1;
    const slotGroups = [
      {
        key: "weekday:1",
        label: "Mon",
        weekday: 1,
        slots: [
          {
            index: 0,
            localStart: "09:00",
            localEnd: "09:30",
            startDayOffset: 0,
            endDayOffset: 0,
          },
          {
            index: 1,
            localStart: "09:30",
            localEnd: "10:00",
            startDayOffset: 0,
            endDayOffset: 0,
          },
        ],
      },
      {
        key: "weekday:2",
        label: "Tue",
        weekday: 2,
        slots: [
          {
            index: 2,
            localStart: "09:00",
            localEnd: "09:30",
            startDayOffset: 0,
            endDayOffset: 0,
          },
          {
            index: 3,
            localStart: "09:30",
            localEnd: "10:00",
            startDayOffset: 0,
            endDayOffset: 0,
          },
        ],
      },
    ];
    document.elementFromPoint = jest.fn();
    render(
      <ScheduleGrid
        schedule={schedule}
        slotGroups={slotGroups}
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
    const callsAfterTouch = painted.mock.calls.length;
    fireEvent.mouseDown(cell);
    expect(painted).toHaveBeenCalledTimes(callsAfterTouch);
    expect(painted).toHaveBeenCalled();
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(document.querySelector("[data-cell-idx='1']")).toHaveAttribute(
      "title",
      expect.stringContaining("Ada: 1.00")
    );
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(painted).toHaveBeenCalledWith(1, expect.objectContaining({ type: "keydown" }));
  });

  test("ScheduleGrid supports read-only specific dates", () => {
    const painted = jest.fn();
    render(
      <ScheduleGrid
        schedule={[0.5, 1]}
        slotGroups={[
          {
            key: "date:2026-07-08",
            label: "2026-07-08",
            slots: [
              {
                index: 0,
                localStart: "09:00",
                localEnd: "09:30",
                startDayOffset: 0,
                endDayOffset: 0,
                startOffset: "-07:00",
                endOffset: "-07:00",
              },
            ],
          },
          {
            key: "date:2026-07-09",
            label: "2026-07-09",
            slots: [
              {
                index: 1,
                localStart: "09:00",
                localEnd: "09:30",
                startDayOffset: 0,
                endDayOffset: 0,
                startOffset: "-07:00",
                endOffset: "-07:00",
              },
            ],
          },
        ]}
        readOnly
        showValues
        onCellPaint={painted}
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
        schedule={[0]}
        slotGroups={[
          {
            key: "weekday:0",
            label: "Sun",
            slots: [
              {
                index: 0,
                localStart: "09:00",
                localEnd: "09:30",
                startDayOffset: 0,
                endDayOffset: 0,
              },
            ],
          },
        ]}
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

  test("ScheduleGrid handles empty, invalid, sparse, overnight, and offset slot groups", () => {
    const painted = jest.fn();
    const first = render(<ScheduleGrid readOnly />);
    expect(screen.getByText("No schedule slots are configured.")).toBeInTheDocument();
    first.unmount();

    const invalid = render(<ScheduleGrid schedule={[]} slotGroups={{ invalid: true }} readOnly />);
    expect(screen.getByText("No schedule slots are configured.")).toBeInTheDocument();
    invalid.unmount();

    render(
      <ScheduleGrid
        schedule={[0.25, 0, 1]}
        slotGroups={[
          {
            key: "sparse",
            label: "Sparse",
            slots: [
              null,
              {
                index: 0,
                localStart: "23:30",
                localEnd: "00:00",
                startDayOffset: 0,
                endDayOffset: 1,
                startOffset: "+00:00",
                endOffset: "+00:00",
              },
              null,
            ],
          },
          {
            key: "short",
            label: "Short",
            slots: [
              {
                index: 1,
                localStart: "23:00",
                localEnd: "23:30",
                startDayOffset: 0,
                endDayOffset: 0,
              },
              {
                index: 2,
                localStart: "23:30",
                localEnd: "00:00",
                startDayOffset: 1,
                endDayOffset: 1,
              },
            ],
          },
          { key: "none", label: "None" },
        ]}
        readOnly={false}
        showValues={false}
        onCellPaint={painted}
      />
    );
    const overnightCell = document.querySelector("[data-cell-idx='0']");
    expect(overnightCell).toHaveAttribute("title", expect.stringContaining("+1d"));
    fireEvent.keyDown(overnightCell, { key: " " });
    fireEvent.keyDown(overnightCell, { key: "Escape" });
    expect(painted).toHaveBeenCalledWith(0, expect.objectContaining({ type: "keydown" }));
  });

  test("EventDetailsGrid renders defaults, dates, and extra cards", () => {
    render(
      <EventDetailsGrid
        event={{
          name: "Planning",
          mode: "mixed",
          startTime: "09:15",
          endTime: "11:15",
          slotMinutes: 15,
          crossesMidnight: false,
          days: [1, 2],
          location: "Room",
          daySelectionType: "specific_dates",
          specificDates: ["2026-07-08"],
          timezone: "UTC",
          status: "open",
          responseDeadline: "2026-07-08T12:00:00.000Z",
          finalMeeting: {
            startsAt: "2026-07-20T09:00:00.000Z",
            endsAt: "2026-07-20T10:00:00.000Z",
            channel: "virtual",
            location: "Meet link",
          },
        }}
        extraCards={[{ label: "Participants", value: 3 }]}
      />
    );
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    expect(screen.getByText("2026-07-08")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Virtual · Meet link")).toBeInTheDocument();
    expect(screen.queryByText("No deadline")).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  test("EventDetailsGrid renders fallback values", () => {
    render(
      <>
        <EventDetailsGrid event={{}} />
        <EventDetailsGrid event={{ days: [1, 2], timezone: "UTC" }} />
        <EventDetailsGrid
          event={{
            startTime: "23:00",
            endTime: "01:00",
            crossesMidnight: true,
            slotMinutes: 15,
          }}
        />
      </>
    );
    expect(screen.getAllByText("In-Person")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Not set")[0]).toBeInTheDocument();
    expect(screen.getAllByText("N/A")[0]).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue")).toBeInTheDocument();
    expect(screen.getByText("11:00 PM - 1:00 AM (next day)")).toBeInTheDocument();
  });
});

describe("role-aware headers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@example.com" },
      loading: false,
      logout: jest.fn(),
    });
  });

  test("EventHeader shows event identity, role, and dashboard navigation", () => {
    const { rerender } = render(
      <EventHeader eventName="Team Sync" eventCode="ABC12345" isOrganizer />
    );

    expect(screen.getByText("Team Sync")).toBeInTheDocument();
    expect(screen.getByText("#ABC12345")).toBeInTheDocument();
    expect(screen.getByText("Organizer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prachi" }));
    expect(screen.getByRole("link", { name: "My Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard"
    );

    rerender(<EventHeader eventName="Team Sync" eventCode="ABC12345" isOrganizer={false} />);
    expect(screen.getByText("Participant")).toBeInTheDocument();
  });

  test("AppHeader shows page context and handles authenticated navigation", async () => {
    const logout = jest.fn().mockResolvedValue();
    useAuth.mockReturnValue({
      user: { displayName: "Prachi", email: "prachi@example.com" },
      loading: false,
      logout,
    });

    render(<AppHeader pageTitle="Create event" contextLabel="Organizer" />);

    expect(screen.getByText("/ Create event")).toBeInTheDocument();
    expect(screen.getByText("Organizer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prachi" }));
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/settings");
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  test("AppHeader handles loading and signed-out states", () => {
    useAuth.mockReturnValue({ user: null, loading: true, logout: jest.fn() });
    const loading = render(<AppHeader pageTitle="My Dashboard" />);
    expect(screen.queryByRole("link", { name: "Login" })).not.toBeInTheDocument();
    loading.unmount();

    useAuth.mockReturnValue({ user: null, loading: false, logout: jest.fn() });
    render(<AppHeader pageTitle="My Dashboard" />);
    expect(screen.getByRole("link", { name: "Login" })).toHaveAttribute("href", "/login");
  });
});

describe("app pages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
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
    render(<EditEventPage />);
    render(<EventPageRoute />);
    render(<NotFound />);
    expect(screen.getByText("home client")).toBeInTheDocument();
    expect(screen.getByText("create client")).toBeInTheDocument();
    expect(screen.getByText("dashboard client")).toBeInTheDocument();
    expect(screen.getByText("edit client")).toBeInTheDocument();
    expect(screen.getByText("event client")).toBeInTheDocument();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Product and support" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report a problem" })).toHaveAttribute(
      "href",
      "/feedback"
    );
    SignInPage();
    SignUpPage();
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(redirect).toHaveBeenCalledWith("/signup");
  });

  test("privacy, terms, and support pages provide working entry points", () => {
    expect(privacyMetadata.title).toBe("Privacy | Releviz");
    expect(termsMetadata.title).toBe("Terms | Releviz");
    expect(supportMetadata.title).toBe("Support | Releviz");
    const privacy = render(<PrivacyPage />);
    expect(screen.getByRole("heading", { name: "Privacy notice" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support page" })).toHaveAttribute("href", "/support");
    privacy.unmount();

    const terms = render(<TermsPage />);
    expect(screen.getByRole("heading", { name: "Terms of service" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute(
      "href",
      "/privacy"
    );
    terms.unmount();

    render(<SupportPage />);
    expect(screen.getByRole("heading", { name: "How can we help?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open feedback form" })).toHaveAttribute(
      "href",
      "/feedback?from=/support"
    );
    expect(screen.getByRole("link", { name: "account recovery" })).toHaveAttribute(
      "href",
      "/recover"
    );
  });

  test("feedback path sanitization excludes origins and URL secrets", () => {
    expect(safeFeedbackPath("")).toBe("");
    expect(safeFeedbackPath("event")).toBe("");
    expect(safeFeedbackPath("//evil.example/path")).toBe("");
    expect(safeFeedbackPath("/event?code=SECRET#availability")).toBe("/event");
    expect(safeFeedbackPath(`/${"a".repeat(600)}`)).toHaveLength(500);
  });

  test("feedback form submits bounded context and exposes progress and success", async () => {
    let resolveFeedback;
    submitFeedback.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFeedback = resolve;
      })
    );
    searchParams = new URLSearchParams("from=%2Fevent%3Fcode%3DSECRET");
    render(<FeedbackPage />);

    await userEvent.selectOptions(screen.getByLabelText("Feedback type"), "usability");
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "The save state was hard to understand."
    );
    await userEvent.click(
      screen.getByLabelText(/service team may follow up using my account contact information/i)
    );
    await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(submitFeedback).toHaveBeenCalledWith({
      category: "usability",
      message: "The save state was hard to understand.",
      pagePath: "/event",
      consentToFollowUp: true,
    });

    await act(async () => {
      resolveFeedback({ status: "received" });
    });
    expect(await screen.findByText("Thank you. Your feedback was received.")).toBeInTheDocument();
    expect(screen.getByLabelText("What happened, or what would you change?")).toHaveValue("");
    expect(
      screen.getByLabelText(/service team may follow up using my account contact information/i)
    ).not.toBeChecked();
  });

  test("feedback form exposes specific and generic retryable failures", async () => {
    submitFeedback.mockRejectedValueOnce(new Error("Feedback service unavailable"));
    const first = render(<FeedbackPage />);
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "A useful report"
    );
    await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Feedback service unavailable");
    first.unmount();

    submitFeedback.mockRejectedValueOnce(new Error());
    render(<FeedbackPage />);
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "Another useful report"
    );
    await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to send feedback. Please try again."
    );
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
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/recover"
    );

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
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
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
    expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123");

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

  test("Login shows account lifecycle status messages", () => {
    useAuth.mockReturnValue({
      login: jest.fn(),
      requestEmailLoginCode: jest.fn(),
      verifyEmailLoginCode: jest.fn(),
    });
    searchParams = new URLSearchParams("status=password-reset");
    const reset = render(<LoginPage />);
    expect(
      screen.getByText("Password reset complete. Log in with your new password.")
    ).toBeInTheDocument();
    reset.unmount();

    searchParams = new URLSearchParams("status=password-changed");
    const changed = render(<LoginPage />);
    expect(screen.getByText("Password changed. Log in again on this device.")).toBeInTheDocument();
    changed.unmount();

    searchParams = new URLSearchParams("status=signed-out-all");
    const signedOut = render(<LoginPage />);
    expect(screen.getByText("All devices have been signed out.")).toBeInTheDocument();
    signedOut.unmount();

    searchParams = new URLSearchParams("status=account-deleted");
    render(<LoginPage />);
    expect(screen.getByText("Your account has been deleted.")).toBeInTheDocument();
  });

  test("Account recovery requests a code, validates passwords, and resets", async () => {
    requestPasswordResetCode.mockResolvedValue({ message: "sent" });
    confirmPasswordReset.mockResolvedValue({ message: "reset" });
    const recovery = render(<RecoverAccountPage />);

    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    await waitFor(() =>
      expect(requestPasswordResetCode).toHaveBeenCalledWith({ email: "ada@example.com" })
    );
    expect(
      await screen.findByText(
        "If an account exists for that email, a reset code has been sent. Check your inbox."
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Reset code"), "123456");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "different456");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(confirmPasswordReset).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "password456" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() =>
      expect(confirmPasswordReset).toHaveBeenCalledWith({
        email: "ada@example.com",
        code: "123456",
        password: "password456",
        passwordConfirm: "password456",
      })
    );
    expect(navigateTo).toHaveBeenCalledWith("/login?status=password-reset");

    await userEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email")).not.toBeDisabled();
    expect(screen.queryByLabelText("Reset code")).not.toBeInTheDocument();
    recovery.unmount();

    requestPasswordResetCode.mockRejectedValueOnce(new Error("No request"));
    const requestFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByText("No request")).toBeInTheDocument();
    requestFailure.unmount();

    requestPasswordResetCode.mockRejectedValueOnce(new Error());
    const genericRequestFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByText("Unable to request a reset code.")).toBeInTheDocument();
    genericRequestFailure.unmount();

    requestPasswordResetCode.mockResolvedValueOnce({ message: "sent" });
    confirmPasswordReset.mockRejectedValueOnce(new Error("Bad reset"));
    const resetFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    await userEvent.type(await screen.findByLabelText("Reset code"), "000000");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "password456");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("Bad reset")).toBeInTheDocument();
    resetFailure.unmount();

    requestPasswordResetCode.mockResolvedValueOnce({ message: "sent" });
    confirmPasswordReset.mockRejectedValueOnce(new Error());
    render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    await userEvent.type(await screen.findByLabelText("Reset code"), "000000");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "password456");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("Unable to reset your password.")).toBeInTheDocument();
  });

  test("Signup validates passwords, starts registration, verifies, and shows errors", async () => {
    const signup = jest.fn().mockResolvedValue({});
    const verifySignup = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({ signup, verifySignup });
    const firstSignup = render(<SignupPage />);
    await userEvent.type(screen.getByLabelText("First name"), "Ada");
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace");
    await userEvent.type(screen.getByLabelText("Organization"), "Releviz");
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
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
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
    await userEvent.type(screen.getByLabelText("Organization"), "Releviz");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.type(screen.getByLabelText("Confirm password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    expect(await screen.findByText("No signup")).toBeInTheDocument();

    signup.mockRejectedValueOnce(new Error());
    render(<SignupPage />);
    await userEvent.type(screen.getAllByLabelText("First name").at(-1), "Ada");
    await userEvent.type(screen.getAllByLabelText("Last name").at(-1), "Lovelace");
    await userEvent.type(screen.getAllByLabelText("Organization").at(-1), "Releviz");
    await userEvent.type(screen.getAllByLabelText("Email").at(-1), "ada@example.com");
    await userEvent.type(screen.getAllByLabelText("Password").at(-1), "password123");
    await userEvent.type(screen.getAllByLabelText("Confirm password").at(-1), "password123");
    await userEvent.click(screen.getAllByRole("button", { name: "Send verification code" }).at(-1));
    expect(await screen.findByText("Unable to start registration.")).toBeInTheDocument();
  });

  test("Settings redirects unauthenticated users and saves profiles", async () => {
    useAuth.mockReturnValue({ user: null, loading: false, updateProfile: jest.fn() });
    const unauthenticated = render(<SettingsPage />);
    expect(navigateTo).toHaveBeenCalledWith("/login?next=/settings");
    unauthenticated.unmount();

    const updateProfile = jest.fn().mockResolvedValue({});
    const listSessions = jest.fn().mockResolvedValue([
      {
        id: "current",
        current: true,
        userAgent: "Browser A",
        lastSeenAt: "2026-07-16T12:00:00.000Z",
        ipAddress: "203.0.113.1",
      },
      {
        id: "other",
        current: false,
        userAgent: "",
        lastSeenAt: "2026-07-15T12:00:00.000Z",
        ipAddress: null,
      },
    ]);
    const revokeSession = jest.fn();
    const logoutAll = jest.fn();
    const changePassword = jest.fn();
    const deleteAccount = jest.fn();
    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions,
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      user: {
        id: "u1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        organization: "Releviz",
        title: "Engineer",
      },
    });
    const authenticated = render(<SettingsPage />);
    expect(screen.getByText("Loading active sessions...")).toBeInTheDocument();
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Other device")).toBeInTheDocument();
    expect(screen.getByText("Unknown browser")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "King" } });
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "Math" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Countess" } });
    let savedTimeout;
    const timeoutSpy = jest.spyOn(window, "setTimeout").mockImplementation((callback) => {
      savedTimeout = callback;
      return 1;
    });
    fireEvent.click(screen.getByText("Save profile"));
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
    fireEvent.click(screen.getByText("Save profile"));
    expect(await screen.findByText("No save")).toBeInTheDocument();

    updateProfile.mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByText("Save profile"));
    expect(await screen.findByText("Unable to save profile.")).toBeInTheDocument();

    revokeSession.mockRejectedValueOnce(new Error("No revoke"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("No revoke")).toBeInTheDocument();
    revokeSession.mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Unable to revoke this session.")).toBeInTheDocument();
    revokeSession.mockResolvedValueOnce({ currentRevoked: false });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByText("Other device")).not.toBeInTheDocument());

    revokeSession.mockResolvedValueOnce({ currentRevoked: true });
    fireEvent.click(screen.getByRole("button", { name: "Sign out this device" }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/login?next=/settings"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign out all devices" })).not.toBeDisabled()
    );

    logoutAll.mockRejectedValueOnce(new Error("No all"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    expect(await screen.findByText("No all")).toBeInTheDocument();
    logoutAll.mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    expect(await screen.findByText("Unable to sign out all devices.")).toBeInTheDocument();
    logoutAll.mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    await waitFor(() => expect(logoutAll).toHaveBeenCalledTimes(3));

    const passwordForm = screen.getByRole("heading", { name: "Change password" }).closest("form");
    await userEvent.type(within(passwordForm).getByLabelText("Current password"), "password789");
    await userEvent.type(within(passwordForm).getByLabelText("New password"), "passwordABC");
    await userEvent.type(
      within(passwordForm).getByLabelText("Confirm new password"),
      "differentABC"
    );
    fireEvent.submit(passwordForm);
    expect(screen.getByText("New passwords do not match.")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();

    fireEvent.change(within(passwordForm).getByLabelText("Confirm new password"), {
      target: { value: "passwordABC" },
    });
    changePassword.mockRejectedValueOnce(new Error("No password change"));
    fireEvent.submit(passwordForm);
    expect(await screen.findByText("No password change")).toBeInTheDocument();
    changePassword.mockRejectedValueOnce(new Error());
    fireEvent.submit(passwordForm);
    expect(await screen.findByText("Unable to change your password.")).toBeInTheDocument();
    changePassword.mockResolvedValueOnce({ message: "changed" });
    fireEvent.submit(passwordForm);
    await waitFor(() =>
      expect(changePassword).toHaveBeenLastCalledWith({
        currentPassword: "password789",
        newPassword: "passwordABC",
        newPasswordConfirm: "passwordABC",
      })
    );

    const deleteForm = screen.getByRole("heading", { name: "Delete account" }).closest("form");
    const deleteButton = within(deleteForm).getByRole("button", {
      name: "Delete account permanently",
    });
    expect(deleteButton).toBeDisabled();
    await userEvent.type(within(deleteForm).getByLabelText("Current password"), "passwordABC");
    await userEvent.type(within(deleteForm).getByLabelText("Type DELETE to confirm"), "DELETE");
    expect(deleteButton).not.toBeDisabled();
    deleteAccount.mockRejectedValueOnce(new Error("No deletion"));
    fireEvent.submit(deleteForm);
    expect(await screen.findByText("No deletion")).toBeInTheDocument();
    deleteAccount.mockRejectedValueOnce(new Error());
    fireEvent.submit(deleteForm);
    expect(await screen.findByText("Unable to delete your account.")).toBeInTheDocument();
    deleteAccount.mockResolvedValueOnce({ message: "deleted" });
    fireEvent.submit(deleteForm);
    await waitFor(() =>
      expect(deleteAccount).toHaveBeenLastCalledWith({
        password: "passwordABC",
        confirmation: "DELETE",
      })
    );
    authenticated.unmount();

    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions: jest.fn().mockResolvedValue([]),
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      user: { id: "u2", email: "empty@example.com" },
    });
    const empty = render(<SettingsPage />);
    expect(await screen.findByText("No active sessions were found.")).toBeInTheDocument();
    empty.unmount();

    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions: jest.fn().mockRejectedValue(new Error("No sessions")),
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      user: { id: "u3", email: "error@example.com" },
    });
    const failedSessions = render(<SettingsPage />);
    expect(await screen.findByText("No sessions")).toBeInTheDocument();
    failedSessions.unmount();

    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions: jest.fn().mockRejectedValue(new Error()),
      revokeSession,
      logoutAll,
      changePassword,
      deleteAccount,
      user: { id: "u4", email: "error2@example.com" },
    });
    render(<SettingsPage />);
    expect(await screen.findByText("Unable to load active sessions.")).toBeInTheDocument();
  });
});
