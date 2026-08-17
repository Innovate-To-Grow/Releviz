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

import AppButton from "@/components/ui/AppButton";
import AppHeader from "@/components/ui/AppHeader";
import BrandLogo, { BrandHomeLink } from "@/components/ui/BrandLogo";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import EventHeader from "@/components/event/EventHeader";
import { DAY_LABELS, DAYS_PER_WEEK } from "@/lib/constants";
import { formatHour, formatMode, formatTime } from "@/lib/format";

jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), {
  virtual: true,
});
jest.mock("@material/web/select/outlined-select.js", () => ({}), {
  virtual: true,
});
jest.mock("@material/web/select/select-option.js", () => ({}), {
  virtual: true,
});
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
  default: ({ alt, priority: _priority, ...props }) => (
    <img alt={alt || ""} {...props} />
  ),
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
  requestAccountDeletionCode: jest.fn(),
}));

jest.mock("@/lib/api/feedback", () => ({
  submitFeedback: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
  safeNextPath: (value, fallback = "/dashboard") => {
    if (!value || !value.startsWith("/") || value.startsWith("//"))
      return fallback;
    const baseUrl = "https://releviz.invalid";
    const resolved = new URL(value, baseUrl);
    return resolved.origin === baseUrl
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : fallback;
  },
}));

jest.mock(
  "@/components/HomePageClient",
  () =>
    function MockHomePageClient() {
      return <div>home client</div>;
    },
);
jest.mock(
  "@/components/event/CreateEventClient",
  () =>
    function MockCreateEventClient({ operation }) {
      return (
        <div>{operation === "edit" ? "edit client" : "create client"}</div>
      );
    },
);
jest.mock(
  "@/components/dashboard/DashboardPageClient",
  () =>
    function MockDashboardPageClient() {
      return <div>dashboard client</div>;
    },
);
jest.mock(
  "@/components/event/EventPageClient",
  () =>
    function MockEventPageClient() {
      return <div>event client</div>;
    },
);

import { useAuth } from "@/components/auth/AuthContext";
import Home from "@/app/page";
import RootLayout, { metadata as rootMetadata } from "@/app/layout";
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
import SignInPage, {
  generateStaticParams as generateSignInStaticParams,
} from "@/app/sign-in/[[...sign-in]]/page";
import SignUpPage, {
  generateStaticParams as generateSignUpStaticParams,
} from "@/app/sign-up/[[...sign-up]]/page";
import {
  confirmPasswordReset,
  requestAccountDeletionCode,
  requestPasswordResetCode,
} from "@/lib/api/auth";
import { submitFeedback } from "@/lib/api/feedback";
import { navigateTo } from "@/lib/navigation";

describe("small UI modules", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    window.history.replaceState({}, "", "/");
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
        <AppButton
          icon={<span data-testid="icon" />}
          fullWidth
          className="extra"
        >
          Save
        </AppButton>
        <AppButton variant="outlined">Cancel</AppButton>
      </>,
    );
    expect(screen.getByText("Save").closest("button")).toHaveClass(
      "app-btn-full",
      "extra",
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("Cancel").closest("button")).toHaveClass(
      "app-btn-outlined",
    );
  });

  test("brand logo exposes wordmark and square assets", () => {
    const { rerender } = render(<BrandLogo />);
    expect(screen.getByRole("img", { name: "Releviz" })).toHaveAttribute(
      "src",
      "/brand/releviz-logo.png",
    );

    rerender(<BrandLogo variant="mark" />);
    expect(screen.getByRole("img", { name: "Releviz" })).toHaveAttribute(
      "src",
      "/brand/releviz-mark.png",
    );

    rerender(<BrandHomeLink logoClassName="brand-logo--footer" />);
    expect(screen.getByRole("link", { name: "Releviz home" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(rootMetadata.manifest).toBe("/manifest.json");
    expect(rootMetadata.icons.icon[1].url).toBe("/brand/releviz-mark.png");
  });

  test("ScheduleGrid paints stable pointer strokes and renders values/tooltips", () => {
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
      />,
    );
    const cell = document.querySelector("[data-cell-idx='1']");
    const otherCell = document.querySelector("[data-cell-idx='2']");
    document.elementFromPoint.mockReturnValue(cell);
    fireEvent.pointerDown(cell, {
      button: 0,
      pointerId: 7,
      pointerType: "pen",
    });
    expect(painted).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ phase: "start" }),
    );
    fireEvent.pointerMove(cell, {
      clientX: 1,
      clientY: 1,
      pointerId: 7,
      pointerType: "pen",
    });
    expect(painted).toHaveBeenCalledTimes(1);
    document.elementFromPoint.mockReturnValue(otherCell);
    fireEvent.pointerMove(cell, {
      clientX: 2,
      clientY: 2,
      pointerId: 7,
      pointerType: "pen",
    });
    expect(painted).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({ phase: "move" }),
    );
    fireEvent.pointerCancel(cell, { pointerId: 7, pointerType: "pen" });
    fireEvent.pointerMove(cell, {
      clientX: 1,
      clientY: 1,
      pointerId: 7,
      pointerType: "pen",
    });
    expect(painted).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(document.querySelector("[data-cell-idx='1']")).toHaveAttribute(
      "title",
      expect.stringContaining("Ada: 1.00"),
    );
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(painted).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ phase: "keyboard", type: "keydown" }),
    );
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
      />,
    );
    fireEvent.pointerDown(document.querySelector("[data-cell-idx='0']"), {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(painted).not.toHaveBeenCalled();
    expect(screen.getByText("2026-07-08")).toBeInTheDocument();
  });

  test("ScheduleGrid defaults to all days and handles pointer movement off cells", () => {
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
      />,
    );
    const emptyTargetCell = document.querySelector("[data-cell-idx='0']");
    fireEvent.pointerDown(emptyTargetCell, {
      button: 0,
      pointerId: 2,
      pointerType: "touch",
    });
    fireEvent.pointerMove(emptyTargetCell, {
      clientX: 1,
      clientY: 1,
      pointerId: 2,
      pointerType: "touch",
    });
    expect(painted).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Sun")).toBeInTheDocument();
  });

  test("ScheduleGrid handles empty, invalid, sparse, overnight, and offset slot groups", () => {
    const painted = jest.fn();
    const first = render(<ScheduleGrid readOnly />);
    expect(
      screen.getByText("No schedule slots are configured."),
    ).toBeInTheDocument();
    first.unmount();

    const invalid = render(
      <ScheduleGrid schedule={[]} slotGroups={{ invalid: true }} readOnly />,
    );
    expect(
      screen.getByText("No schedule slots are configured."),
    ).toBeInTheDocument();
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
      />,
    );
    const overnightCell = document.querySelector("[data-cell-idx='0']");
    expect(overnightCell).toHaveAttribute(
      "title",
      expect.stringContaining("+1d"),
    );
    fireEvent.keyDown(overnightCell, { key: " " });
    fireEvent.keyDown(overnightCell, { key: "Escape" });
    expect(painted).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ type: "keydown" }),
    );
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
          status: "active",
          responseDeadline: "2026-07-08T12:00:00.000Z",
          finalMeeting: {
            startsAt: "2026-07-20T09:00:00.000Z",
            endsAt: "2026-07-20T10:00:00.000Z",
            channel: "virtual",
            location: "Meet link",
          },
        }}
        extraCards={[{ label: "Participants", value: 3 }]}
      />,
    );
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    expect(screen.getByText("2026-07-08")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
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
      </>,
    );
    expect(screen.getAllByText("In-Person")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Not set")[0]).toBeInTheDocument();
    expect(screen.getAllByText("N/A")[0]).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue")).toBeInTheDocument();
    expect(
      screen.getByText("11:00 PM - 1:00 AM (next day)"),
    ).toBeInTheDocument();
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
      <EventHeader eventName="Team Sync" eventCode="ABC12345" isOrganizer />,
    );

    expect(screen.getByText("Team Sync")).toBeInTheDocument();
    expect(screen.getByText("#ABC12345")).toBeInTheDocument();
    expect(screen.getByText("Organizer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prachi" }));
    expect(
      screen.getByRole("menuitem", { name: "My Dashboard" }),
    ).toHaveAttribute("href", "/dashboard");

    rerender(
      <EventHeader
        eventName="Team Sync"
        eventCode="ABC12345"
        isOrganizer={false}
      />,
    );
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
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  test("account menu supports arrow navigation and restores trigger focus", () => {
    render(<AppHeader pageTitle="My Dashboard" />);

    const trigger = screen.getByRole("button", { name: "Prachi" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const dashboardItem = screen.getByRole("menuitem", {
      name: "My Dashboard",
    });
    expect(dashboardItem).toHaveFocus();

    fireEvent.keyDown(dashboardItem, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  test("AppHeader handles loading and signed-out states", () => {
    useAuth.mockReturnValue({ user: null, loading: true, logout: jest.fn() });
    const loading = render(<AppHeader pageTitle="My Dashboard" />);
    expect(
      screen.queryByRole("link", { name: "Log in" }),
    ).not.toBeInTheDocument();
    loading.unmount();

    useAuth.mockReturnValue({ user: null, loading: false, logout: jest.fn() });
    render(<AppHeader pageTitle="My Dashboard" />);
    expect(
      screen.getByRole("link", { name: "Continue with email" }),
    ).toHaveAttribute("href", "/login");
  });
});

describe("app pages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    delete process.env.AMPLIFY_STATIC_EXPORT;
  });

  test("wrapper pages render expected clients and redirects", () => {
    render(
      <RootLayout>
        <main>child</main>
      </RootLayout>,
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
    expect(
      screen.getByRole("navigation", { name: "Legal" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Support" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Report a problem" }),
    ).not.toBeInTheDocument();
    SignInPage();
    SignUpPage();
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(redirect).toHaveBeenCalledWith("/signup");
    expect(generateSignInStaticParams()).toEqual([{ "sign-in": [] }]);
    expect(generateSignUpStaticParams()).toEqual([{ "sign-up": [] }]);
  });

  test("legacy auth pages use client redirects in the Amplify static export", async () => {
    process.env.AMPLIFY_STATIC_EXPORT = "1";
    const signIn = render(<SignInPage />);
    expect(
      screen.getByRole("link", { name: "Continue to log in" }),
    ).toHaveAttribute("href", "/login");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    signIn.unmount();

    render(<SignUpPage />);
    expect(
      screen.getByRole("link", { name: "Continue to sign up" }),
    ).toHaveAttribute("href", "/signup");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/signup"));
  });

  test("privacy, terms, and support pages provide working entry points", () => {
    expect(privacyMetadata.title).toBe("Privacy | Releviz");
    expect(termsMetadata.title).toBe("Terms | Releviz");
    expect(supportMetadata.title).toBe("Support | Releviz");
    const privacy = render(<PrivacyPage />);
    expect(
      screen.getByRole("heading", { name: "Privacy notice" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support page" })).toHaveAttribute(
      "href",
      "/support",
    );
    privacy.unmount();

    const terms = render(<TermsPage />);
    expect(
      screen.getByRole("heading", { name: "Terms of service" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "privacy notice" }),
    ).toHaveAttribute("href", "/privacy");
    terms.unmount();

    render(<SupportPage />);
    expect(
      screen.getByRole("heading", { name: "How can we help?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open feedback form" }),
    ).toHaveAttribute("href", "/feedback?from=/support");
    expect(
      screen.getByRole("link", { name: "account recovery" }),
    ).toHaveAttribute("href", "/recover");
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
      }),
    );
    searchParams = new URLSearchParams("from=%2Fevent%3Fcode%3DSECRET");
    render(<FeedbackPage />);

    await userEvent.selectOptions(
      screen.getByLabelText("Feedback type"),
      "usability",
    );
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "The save state was hard to understand.",
    );
    await userEvent.click(
      screen.getByLabelText(
        /service team may follow up using my account contact information/i,
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send feedback" }),
    );
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
    expect(
      await screen.findByText("Thank you. Your feedback was received."),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("What happened, or what would you change?"),
    ).toHaveValue("");
    expect(
      screen.getByLabelText(
        /service team may follow up using my account contact information/i,
      ),
    ).not.toBeChecked();
  });

  test("feedback form exposes specific and generic retryable failures", async () => {
    submitFeedback.mockRejectedValueOnce(
      new Error("Feedback service unavailable"),
    );
    const first = render(<FeedbackPage />);
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "A useful report",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send feedback" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Feedback service unavailable",
    );
    first.unmount();

    submitFeedback.mockRejectedValueOnce(new Error());
    render(<FeedbackPage />);
    await userEvent.type(
      screen.getByLabelText("What happened, or what would you change?"),
      "Another useful report",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send feedback" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to send feedback. Please try again.",
    );
  });

  test("Login uses the unified email flow and sanitizes next", async () => {
    const requestEmailAuthCode = jest.fn().mockResolvedValue({});
    const verifyEmailAuthCode = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({ requestEmailAuthCode, verifyEmailAuthCode });
    searchParams = new URLSearchParams("next=//evil.example");
    const firstLogin = render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
    expect(verifyEmailAuthCode).toHaveBeenCalledWith({
      email: "ada@example.com",
      code: "123456",
    });

    firstLogin.unmount();
    requestEmailAuthCode.mockRejectedValueOnce(new Error("No code"));
    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(await screen.findByText("No code")).toBeInTheDocument();
  });

  test("Login and signup hide authentication forms while hydrating the session", () => {
    useAuth.mockReturnValue({
      loading: true,
      requestEmailAuthCode: jest.fn(),
      verifyEmailAuthCode: jest.fn(),
    });
    const login = render(<LoginPage />);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session…",
    );
    login.unmount();

    useAuth.mockReturnValue({
      loading: true,
      requestEmailAuthCode: jest.fn(),
      verifyEmailAuthCode: jest.fn(),
    });
    render(<SignupPage />);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session…",
    );
  });

  test("Login preserves next and sends new accounts to profile completion", async () => {
    const requestEmailAuthCode = jest.fn().mockResolvedValue({});
    const verifyEmailAuthCode = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ next_step: "complete_profile" });
    useAuth.mockReturnValue({ requestEmailAuthCode, verifyEmailAuthCode });
    searchParams = new URLSearchParams("next=/event?code=ABC123");
    const firstLogin = render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );
    expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123");
    firstLogin.unmount();

    searchParams = new URLSearchParams();
    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "654321",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/settings?complete_profile=1&next=%2Fdashboard",
      ),
    );
  });

  test("Login shows account lifecycle status messages", () => {
    useAuth.mockReturnValue({
      requestEmailAuthCode: jest.fn(),
      verifyEmailAuthCode: jest.fn(),
    });
    searchParams = new URLSearchParams("status=password-reset");
    const reset = render(<LoginPage />);
    expect(
      screen.getByText("Password reset complete. Continue with your email."),
    ).toBeInTheDocument();
    reset.unmount();

    searchParams = new URLSearchParams("status=password-changed");
    const changed = render(<LoginPage />);
    expect(
      screen.getByText(
        "Password changed. Continue with your email on this device.",
      ),
    ).toBeInTheDocument();
    changed.unmount();

    searchParams = new URLSearchParams("status=signed-out-all");
    const signedOut = render(<LoginPage />);
    expect(
      screen.getByText("All devices have been signed out."),
    ).toBeInTheDocument();
    signedOut.unmount();

    searchParams = new URLSearchParams("status=account-deleted");
    render(<LoginPage />);
    expect(
      screen.getByText("Your account has been deleted."),
    ).toBeInTheDocument();
  });

  test("Account recovery requests a code, validates passwords, and resets", async () => {
    requestPasswordResetCode.mockResolvedValue({ message: "sent" });
    confirmPasswordReset.mockResolvedValue({ message: "reset" });
    const recovery = render(<RecoverAccountPage />);

    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset code" }),
    );
    await waitFor(() =>
      expect(requestPasswordResetCode).toHaveBeenCalledWith({
        email: "ada@example.com",
      }),
    );
    expect(
      await screen.findByText(
        "If an account exists for that email, a reset code has been sent. Check your inbox.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Reset code"), "123456");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "different456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reset password" }),
    );
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(confirmPasswordReset).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "password456" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Reset password" }),
    );
    await waitFor(() =>
      expect(confirmPasswordReset).toHaveBeenCalledWith({
        email: "ada@example.com",
        code: "123456",
        password: "password456",
        passwordConfirm: "password456",
      }),
    );
    expect(navigateTo).toHaveBeenCalledWith("/login?status=password-reset");

    await userEvent.click(
      screen.getByRole("button", { name: "Use a different email" }),
    );
    expect(screen.getByLabelText("Email")).not.toBeDisabled();
    expect(screen.queryByLabelText("Reset code")).not.toBeInTheDocument();
    recovery.unmount();

    requestPasswordResetCode.mockRejectedValueOnce(new Error("No request"));
    const requestFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset code" }),
    );
    expect(await screen.findByText("No request")).toBeInTheDocument();
    requestFailure.unmount();

    requestPasswordResetCode.mockRejectedValueOnce(new Error());
    const genericRequestFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset code" }),
    );
    expect(
      await screen.findByText("Unable to request a reset code."),
    ).toBeInTheDocument();
    genericRequestFailure.unmount();

    requestPasswordResetCode.mockResolvedValueOnce({ message: "sent" });
    confirmPasswordReset.mockRejectedValueOnce(new Error("Bad reset"));
    const resetFailure = render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset code" }),
    );
    await userEvent.type(await screen.findByLabelText("Reset code"), "000000");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "password456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reset password" }),
    );
    expect(await screen.findByText("Bad reset")).toBeInTheDocument();
    resetFailure.unmount();

    requestPasswordResetCode.mockResolvedValueOnce({ message: "sent" });
    confirmPasswordReset.mockRejectedValueOnce(new Error());
    render(<RecoverAccountPage />);
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset code" }),
    );
    await userEvent.type(await screen.findByLabelText("Reset code"), "000000");
    await userEvent.type(screen.getByLabelText("New password"), "password456");
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "password456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reset password" }),
    );
    expect(
      await screen.findByText("Unable to reset your password."),
    ).toBeInTheDocument();
  });

  test("Signup route uses the same passwordless email flow", async () => {
    const requestEmailAuthCode = jest.fn().mockResolvedValue({});
    const verifyEmailAuthCode = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({
      requestEmailAuthCode,
      verifyEmailAuthCode,
      loading: false,
    });
    render(<SignupPage />);

    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(requestEmailAuthCode).toHaveBeenCalledWith({
      email: "ada@example.com",
      next: "/dashboard",
      source: "login",
    });
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
  });

  test("Signup preserves the intended destination through unified verification", async () => {
    const requestEmailAuthCode = jest.fn().mockResolvedValue({});
    const verifyEmailAuthCode = jest.fn().mockResolvedValue({});
    useAuth.mockReturnValue({
      requestEmailAuthCode,
      verifyEmailAuthCode,
      loading: false,
    });
    searchParams = new URLSearchParams("next=/event?code=ABC123");
    render(<SignupPage />);

    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123"),
    );
  });

  test("Settings redirects unauthenticated users and saves profiles", async () => {
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      updateProfile: jest.fn(),
    });
    const unauthenticated = render(<SettingsPage />);
    expect(navigateTo).toHaveBeenCalledTimes(1);
    const settingsLoginUrl = new URL(
      navigateTo.mock.calls[0][0],
      "https://releviz.test",
    );
    expect(settingsLoginUrl.pathname).toBe("/login");
    expect(settingsLoginUrl.searchParams.get("next")).toBe("/settings");
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
    const settingsNav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      within(settingsNav).getByRole("link", { name: "Profile" }),
    ).toHaveAttribute("href", "#profile");
    expect(
      within(settingsNav).getByRole("link", { name: "Active sessions" }),
    ).toHaveAttribute("href", "#sessions");
    expect(
      within(settingsNav).getByRole("link", { name: "Password" }),
    ).toHaveAttribute("href", "#password");
    expect(
      within(settingsNav).getByRole("link", { name: "Danger zone" }),
    ).toHaveAttribute("href", "#danger-zone");
    expect(screen.getByText("Loading active sessions...")).toBeInTheDocument();
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Other device")).toBeInTheDocument();
    expect(screen.getByText("Unknown browser")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Augusta" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), {
      target: { value: "King" },
    });
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    let savedTimeout;
    const timeoutSpy = jest
      .spyOn(window, "setTimeout")
      .mockImplementation((callback) => {
        savedTimeout = callback;
        return 1;
      });
    fireEvent.click(screen.getByText("Save profile"));
    await act(async () => {});
    expect(updateProfile).toHaveBeenCalledWith({
      first_name: "Augusta",
      last_name: "King",
    });
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
    expect(
      await screen.findByText("Unable to save profile."),
    ).toBeInTheDocument();

    revokeSession.mockRejectedValueOnce(new Error("No revoke"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("No revoke")).toBeInTheDocument();
    revokeSession.mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByText("Unable to revoke this session."),
    ).toBeInTheDocument();
    revokeSession.mockResolvedValueOnce({ currentRevoked: false });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(screen.queryByText("Other device")).not.toBeInTheDocument(),
    );

    revokeSession.mockResolvedValueOnce({ currentRevoked: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out this device" }),
    );
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith("/login?next=/settings"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign out all devices" }),
      ).not.toBeDisabled(),
    );

    logoutAll.mockRejectedValueOnce(new Error("No all"));
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out all devices" }),
    );
    expect(await screen.findByText("No all")).toBeInTheDocument();
    logoutAll.mockRejectedValueOnce(new Error());
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out all devices" }),
    );
    expect(
      await screen.findByText("Unable to sign out all devices."),
    ).toBeInTheDocument();
    logoutAll.mockResolvedValueOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out all devices" }),
    );
    await waitFor(() => expect(logoutAll).toHaveBeenCalledTimes(3));

    const passwordForm = screen
      .getByRole("heading", { name: "Change password" })
      .closest("form");
    const passwordDetails = passwordForm.querySelector("details");
    expect(passwordDetails).not.toHaveAttribute("open");
    fireEvent.click(passwordDetails.querySelector("summary"));
    expect(passwordDetails).toHaveAttribute("open");
    await userEvent.type(
      within(passwordForm).getByLabelText("Current password"),
      "password789",
    );
    await userEvent.type(
      within(passwordForm).getByLabelText("New password"),
      "passwordABC",
    );
    await userEvent.type(
      within(passwordForm).getByLabelText("Confirm new password"),
      "differentABC",
    );
    fireEvent.submit(passwordForm);
    expect(screen.getByText("New passwords do not match.")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();

    fireEvent.change(
      within(passwordForm).getByLabelText("Confirm new password"),
      {
        target: { value: "passwordABC" },
      },
    );
    changePassword.mockRejectedValueOnce(new Error("No password change"));
    fireEvent.submit(passwordForm);
    expect(await screen.findByText("No password change")).toBeInTheDocument();
    changePassword.mockRejectedValueOnce(new Error());
    fireEvent.submit(passwordForm);
    expect(
      await screen.findByText("Unable to change your password."),
    ).toBeInTheDocument();
    changePassword.mockResolvedValueOnce({ message: "changed" });
    fireEvent.submit(passwordForm);
    await waitFor(() =>
      expect(changePassword).toHaveBeenLastCalledWith({
        currentPassword: "password789",
        newPassword: "passwordABC",
        newPasswordConfirm: "passwordABC",
      }),
    );

    const deleteForm = screen
      .getByRole("heading", { name: "Delete account" })
      .closest("form");
    const deleteDetails = deleteForm.querySelector("details");
    expect(deleteDetails).not.toHaveAttribute("open");
    fireEvent.click(deleteDetails.querySelector("summary"));
    expect(deleteDetails).toHaveAttribute("open");
    // Deleting starts by emailing a confirmation code.
    const requestCodeButton = within(deleteForm).getByRole("button", {
      name: "Email a confirmation code",
    });
    expect(requestCodeButton).toBeDisabled();
    await userEvent.type(
      within(deleteForm).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    expect(requestCodeButton).not.toBeDisabled();

    requestAccountDeletionCode.mockRejectedValueOnce(new Error("No code"));
    fireEvent.submit(deleteForm);
    expect(await screen.findByText("No code")).toBeInTheDocument();

    requestAccountDeletionCode.mockResolvedValueOnce({ message: "sent" });
    fireEvent.submit(deleteForm);
    expect(
      await screen.findByText(
        "We emailed a confirmation code. Enter it to delete your account.",
      ),
    ).toBeInTheDocument();

    const deleteButton = within(deleteForm).getByRole("button", {
      name: "Delete account permanently",
    });
    expect(deleteButton).toBeDisabled();
    await userEvent.type(
      within(deleteForm).getByLabelText("Confirmation code"),
      "654321",
    );
    expect(deleteButton).not.toBeDisabled();

    deleteAccount.mockRejectedValueOnce(new Error("No deletion"));
    fireEvent.submit(deleteForm);
    expect(await screen.findByText("No deletion")).toBeInTheDocument();
    deleteAccount.mockRejectedValueOnce(new Error());
    fireEvent.submit(deleteForm);
    expect(
      await screen.findByText("Unable to delete your account."),
    ).toBeInTheDocument();
    deleteAccount.mockResolvedValueOnce({ message: "deleted" });
    fireEvent.submit(deleteForm);
    await waitFor(() =>
      expect(deleteAccount).toHaveBeenLastCalledWith({ code: "654321" }),
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
    expect(
      await screen.findByText("No active sessions were found."),
    ).toBeInTheDocument();
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
    expect(
      await screen.findByText("Unable to load active sessions."),
    ).toBeInTheDocument();
  });

  test("profile completion stays focused and continues directly into an event response", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
    );
    const updateProfile = jest.fn().mockResolvedValue({});
    const listSessions = jest.fn().mockResolvedValue([]);
    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions,
      revokeSession: jest.fn(),
      logoutAll: jest.fn(),
      changePassword: jest.fn(),
      deleteAccount: jest.fn(),
      user: {
        id: "new-user",
        email: "new@example.com",
        firstName: "",
        lastName: "",
      },
    });

    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: "Complete your profile" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "new@example.com",
    );
    expect(screen.getByLabelText("Email address")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("First name")).toBeRequired();
    expect(screen.getByLabelText("First name")).toHaveAttribute(
      "autocomplete",
      "given-name",
    );
    expect(screen.getByLabelText("Last name")).toBeRequired();
    expect(screen.getByLabelText("Last name")).toHaveAttribute(
      "autocomplete",
      "family-name",
    );
    expect(
      screen.queryByRole("heading", { name: "Active sessions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Change password" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Delete account" }),
    ).not.toBeInTheDocument();
    expect(listSessions).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("First name"), "New");
    await userEvent.type(screen.getByLabelText("Last name"), "Member");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to event" }),
    );

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        first_name: "New",
        last_name: "Member",
      }),
    );
    expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123&respond=1");
  });

  test("profile completion rejects an unsafe destination", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?complete_profile=1&next=%2F%2Fevil.example",
    );
    const updateProfile = jest.fn().mockResolvedValue({});
    const listSessions = jest.fn().mockResolvedValue([]);
    useAuth.mockReturnValue({
      loading: false,
      updateProfile,
      listSessions,
      revokeSession: jest.fn(),
      logoutAll: jest.fn(),
      changePassword: jest.fn(),
      deleteAccount: jest.fn(),
      user: {
        id: "new-user",
        email: "new@example.com",
        firstName: "New",
        lastName: "Member",
      },
    });

    render(<SettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith("/dashboard");
    expect(listSessions).not.toHaveBeenCalled();
  });
});
