/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, priority: _priority, ...props }) => (
    <img alt={alt || ""} {...props} />
  ),
}));

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("@/lib/navigation", () => {
  const actual = jest.requireActual("@/lib/navigation");
  return { ...actual, navigateTo: jest.fn() };
});

import { useAuth } from "@/components/auth/AuthContext";
import ContinueWithEmailPage, {
  destinationAfterAuthentication,
} from "@/components/auth/ContinueWithEmailPage";
import { navigateTo } from "@/lib/navigation";

const requestEmailAuthCode = jest.fn();
const verifyEmailAuthCode = jest.fn();

describe("ContinueWithEmailPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestEmailAuthCode.mockResolvedValue({});
    verifyEmailAuthCode.mockResolvedValue({});
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      requestEmailAuthCode,
      verifyEmailAuthCode,
    });
  });

  test("keeps the site header visible and uses one email-code flow", async () => {
    render(<ContinueWithEmailPage next="/event?code=ABC123" />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Continue with email" }),
    ).toHaveAttribute("href", "/login");

    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );

    await waitFor(() =>
      expect(requestEmailAuthCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        next: "/event?code=ABC123",
        source: "event_registration",
        event: "ABC123",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );

    await waitFor(() =>
      expect(verifyEmailAuthCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        code: "123456",
      }),
    );
    expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123");
  });

  test("preserves an event destination while a new account completes its profile", async () => {
    verifyEmailAuthCode.mockResolvedValue({
      requires_profile_completion: true,
    });
    render(<ContinueWithEmailPage next="/event?code=ABC123" />);

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
        "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
      ),
    );
  });

  test("can return to the email step and reports delivery errors", async () => {
    requestEmailAuthCode.mockRejectedValueOnce(new Error("Email unavailable"));
    render(<ContinueWithEmailPage />);

    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email unavailable",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Use a different email" }),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
  });

  test("redirects an authenticated account instead of rendering the login form", async () => {
    useAuth.mockReturnValue({
      user: { id: "member-1" },
      loading: false,
      nextStep: null,
      requiresProfileCompletion: false,
      requestEmailAuthCode,
      verifyEmailAuthCode,
    });

    render(<ContinueWithEmailPage next="/event?code=ABC123" />);

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening your account…",
    );
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123"),
    );
  });

  test("sends an authenticated incomplete profile to setup and avoids auth-entry loops", async () => {
    useAuth.mockReturnValue({
      user: { id: "member-1" },
      loading: false,
      nextStep: "complete_profile",
      requiresProfileCompletion: true,
      requestEmailAuthCode,
      verifyEmailAuthCode,
    });

    render(<ContinueWithEmailPage next="/login" />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/settings?complete_profile=1&next=%2Fdashboard",
      ),
    );
    expect(destinationAfterAuthentication("//evil.example", {})).toBe(
      "/dashboard",
    );
    expect(
      destinationAfterAuthentication(
        "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
        {},
      ),
    ).toBe("/event?code=ABC123");
    expect(
      destinationAfterAuthentication(
        "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
        { requires_profile_completion: true },
      ),
    ).toBe("/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123");
  });

  test("does not flash the email form while the session is loading", () => {
    useAuth.mockReturnValue({
      user: null,
      loading: true,
      requestEmailAuthCode,
      verifyEmailAuthCode,
    });

    render(<ContinueWithEmailPage />);

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session…",
    );
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
