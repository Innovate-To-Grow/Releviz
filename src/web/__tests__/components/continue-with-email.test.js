/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, priority: _priority, ...props }) => (
    <img alt={alt || ""} {...props} />
  ),
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

jest.mock("@/lib/navigation", () => {
  const actual = jest.requireActual("@/lib/navigation");
  return { ...actual, navigateTo: jest.fn() };
});

import { useAuth } from "@/components/auth/AuthContext";
import ContinueWithEmailPage, {
  destinationAfterAuthentication,
} from "@/components/auth/ContinueWithEmailPage";
import { navigateTo } from "@/lib/navigation";

const login = jest.fn();
const requestEmailAuthCode = jest.fn();
const verifyEmailAuthCode = jest.fn();
const CODE_SENT_MESSAGE = "Check your email for a verification code.";
const EVENT_NEXT = "/event?code=ABC123";

const submitForm = (control) => fireEvent.submit(control.closest("form"));

async function sendCode(email = "ada@example.com") {
  await userEvent.type(screen.getByLabelText("Email"), email);
  userEvent.click(screen.getByRole("button", { name: "Continue" }));
  return screen.findByLabelText("Verification Code");
}

function switchToPassword() {
  userEvent.click(
    screen.getByRole("button", { name: "Sign in with password instead" }),
  );
  return screen.getByLabelText("Password");
}

describe("ContinueWithEmailPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    login.mockResolvedValue({});
    requestEmailAuthCode.mockResolvedValue({ message: CODE_SENT_MESSAGE });
    verifyEmailAuthCode.mockResolvedValue({});
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      login,
      requestEmailAuthCode,
      verifyEmailAuthCode,
    });
  });

  describe("code mode", () => {
    test("renders the branded email step with the site header", () => {
      render(<ContinueWithEmailPage />);

      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        "/login",
      );
      expect(screen.getByRole("img", { name: "Releviz" })).toHaveClass(
        "brand-logo--auth",
      );
      expect(
        screen.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Enter your email to sign in or create your account"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "We'll email you a 6-digit sign-in code. New here? This creates your account.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "By continuing, you agree to receive a one-time verification email.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toHaveAttribute(
        "placeholder",
        "you@email.com",
      );
      expect(screen.getByLabelText("Email").closest("form")).toHaveAttribute(
        "novalidate",
      );
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    });

    test("keeps the submit disabled until the email is valid and rejects invalid submits", async () => {
      render(<ContinueWithEmailPage />);
      const email = screen.getByLabelText("Email");
      const submit = screen.getByRole("button", { name: "Continue" });

      expect(submit).toBeDisabled();
      await userEvent.type(email, "ada@example");
      expect(submit).toBeDisabled();

      submitForm(email);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Please enter a valid email address.",
      );
      expect(email).toHaveAttribute("aria-invalid", "true");
      expect(requestEmailAuthCode).not.toHaveBeenCalled();

      await userEvent.type(email, ".com");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(submit).toBeEnabled();
    });

    test("requests a code for an event destination and verifies it", async () => {
      render(<ContinueWithEmailPage next={EVENT_NEXT} />);

      const codeInput = await sendCode();
      expect(requestEmailAuthCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        next: EVENT_NEXT,
        source: "event_registration",
        event: "ABC123",
      });
      expect(screen.getByRole("status")).toHaveTextContent(CODE_SENT_MESSAGE);
      expect(
        screen.getByRole("heading", { name: "Verify Your Identity" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Enter the 6-digit code we sent to continue signing in or setting up your account.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Sending to")).toBeInTheDocument();
      expect(screen.getByText("ada@example.com").tagName).toBe("STRONG");
      expect(
        screen.queryByText(
          "By continuing, you agree to receive a one-time verification email.",
        ),
      ).not.toBeInTheDocument();
      expect(codeInput).toHaveAttribute("inputmode", "numeric");
      expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
      expect(codeInput).toHaveAttribute("placeholder", "000000");
      expect(codeInput).toHaveAttribute("maxlength", "6");

      const submit = screen.getByRole("button", { name: "Continue" });
      await userEvent.type(codeInput, "12ab34");
      expect(codeInput).toHaveValue("1234");
      expect(submit).toBeDisabled();
      await userEvent.type(codeInput, "56");
      expect(submit).toBeEnabled();

      userEvent.click(submit);
      await waitFor(() =>
        expect(verifyEmailAuthCode).toHaveBeenCalledWith({
          email: "ada@example.com",
          code: "123456",
        }),
      );
      expect(navigateTo).toHaveBeenCalledWith(EVENT_NEXT);

      submitForm(codeInput);
      expect(verifyEmailAuthCode).toHaveBeenCalledTimes(1);
    });

    test("uses the login source for non-event destinations and skips the info alert without a message", async () => {
      requestEmailAuthCode.mockResolvedValue({});
      render(<ContinueWithEmailPage />);

      await sendCode();
      expect(requestEmailAuthCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        next: "/dashboard",
        source: "login",
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    test("tolerates an empty response body when requesting a code", async () => {
      requestEmailAuthCode.mockResolvedValue(undefined);
      render(<ContinueWithEmailPage />);

      await sendCode();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    test("preserves an event destination while a new account completes its profile", async () => {
      verifyEmailAuthCode.mockResolvedValue({
        requires_profile_completion: true,
      });
      render(<ContinueWithEmailPage next={EVENT_NEXT} />);

      await userEvent.type(await sendCode("new@example.com"), "654321");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() =>
        expect(navigateTo).toHaveBeenCalledWith(
          "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
        ),
      );
    });

    test("reports verification failures with a fallback message", async () => {
      verifyEmailAuthCode
        .mockRejectedValueOnce(new Error("Code expired"))
        .mockRejectedValueOnce(new Error(""));
      render(<ContinueWithEmailPage />);

      await userEvent.type(await sendCode(), "123456");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Code expired",
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Unable to verify the code.",
        ),
      );
      expect(navigateTo).not.toHaveBeenCalled();
    });

    test("resends the code and replaces the info message", async () => {
      requestEmailAuthCode
        .mockResolvedValueOnce({ message: CODE_SENT_MESSAGE })
        .mockResolvedValueOnce({ message: "A new code is on its way." });
      render(<ContinueWithEmailPage next={EVENT_NEXT} />);

      await sendCode();
      userEvent.click(screen.getByRole("button", { name: "Resend code" }));

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "A new code is on its way.",
        ),
      );
      expect(screen.queryByText(CODE_SENT_MESSAGE)).not.toBeInTheDocument();
      expect(requestEmailAuthCode).toHaveBeenCalledTimes(2);
      expect(requestEmailAuthCode).toHaveBeenLastCalledWith({
        email: "ada@example.com",
        next: EVENT_NEXT,
        source: "event_registration",
        event: "ABC123",
      });
      expect(screen.getByLabelText("Verification Code")).toBeInTheDocument();
    });

    test("surfaces a throttled resend and stays on the code step", async () => {
      requestEmailAuthCode
        .mockResolvedValueOnce({ message: CODE_SENT_MESSAGE })
        .mockRejectedValueOnce(
          new Error("Too many verification attempts. Please try again later."),
        );
      render(<ContinueWithEmailPage />);

      await sendCode();
      userEvent.click(screen.getByRole("button", { name: "Resend code" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Too many verification attempts. Please try again later.",
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Verification Code")).toBeInTheDocument();
      expect(screen.getByText("ada@example.com").tagName).toBe("STRONG");
    });

    test("returns to the email step with the address preserved", async () => {
      render(<ContinueWithEmailPage />);

      await userEvent.type(await sendCode(), "123");
      userEvent.click(screen.getByRole("button", { name: "Back" }));

      expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
      expect(
        screen.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Verification Code"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByLabelText("Verification Code")).toHaveValue("");
    });

    test("reports delivery failures with a fallback message", async () => {
      requestEmailAuthCode
        .mockRejectedValueOnce(new Error("Email unavailable"))
        .mockRejectedValueOnce(new Error(""));
      render(<ContinueWithEmailPage />);

      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Email unavailable",
      );
      expect(screen.getByLabelText("Email")).toBeInTheDocument();

      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Unable to send a verification code.",
        ),
      );
      expect(
        screen.queryByLabelText("Verification Code"),
      ).not.toBeInTheDocument();
    });
  });

  describe("mode switching", () => {
    test("carries the email across both modes and clears feedback", async () => {
      requestEmailAuthCode.mockRejectedValueOnce(
        new Error("Email unavailable"),
      );
      render(<ContinueWithEmailPage />);

      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("alert");

      switchToPassword();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Welcome to Releviz" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Releviz" })).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
      expect(screen.getByLabelText("Email")).toHaveAttribute(
        "autocomplete",
        "username",
      );
      expect(screen.getByLabelText("Password")).toHaveAttribute(
        "placeholder",
        "Enter your password",
      );
      expect(
        screen.getByText(
          "By continuing, you agree to receive a one-time verification email.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          "We'll email you a 6-digit sign-in code. New here? This creates your account.",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Sign in with password instead" }),
      ).not.toBeInTheDocument();

      await userEvent.type(screen.getByLabelText("Password"), "secret");
      userEvent.click(
        screen.getByRole("button", {
          name: "Sign in with a verification code",
        }),
      );
      expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
      expect(
        screen.getByText(
          "We'll email you a 6-digit sign-in code. New here? This creates your account.",
        ),
      ).toBeInTheDocument();

      switchToPassword();
      expect(screen.getByLabelText("Password")).toHaveValue("");
    });

    test("keeps the account status banner across a mode switch and focuses the new step", () => {
      render(<ContinueWithEmailPage initialStatus="All devices signed out." />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "All devices signed out.",
      );
      expect(screen.getByLabelText("Email")).toHaveFocus();

      switchToPassword();
      expect(screen.getByRole("status")).toHaveTextContent(
        "All devices signed out.",
      );
      expect(screen.getByLabelText("Email")).toHaveFocus();

      userEvent.click(
        screen.getByRole("button", {
          name: "Sign in with a verification code",
        }),
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "All devices signed out.",
      );
      expect(screen.getByLabelText("Email")).toHaveFocus();
    });

    test("focuses the password field when the email is already known", async () => {
      render(<ContinueWithEmailPage />);
      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");

      switchToPassword();
      expect(screen.getByLabelText("Password")).toHaveFocus();
    });

    test("locks navigation while a code request is in flight", async () => {
      let finishRequest;
      requestEmailAuthCode.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRequest = resolve;
          }),
      );
      render(<ContinueWithEmailPage />);

      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(
        await screen.findByRole("button", { name: "Sending code..." }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Sign in with password instead" }),
      ).toBeDisabled();

      finishRequest({ message: CODE_SENT_MESSAGE });
      expect(await screen.findByLabelText("Verification Code")).toHaveFocus();
      expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    });

    test("locks the code step while a resend is in flight and keeps the sent address", async () => {
      let finishResend;
      requestEmailAuthCode
        .mockResolvedValueOnce({ message: CODE_SENT_MESSAGE })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishResend = resolve;
            }),
        );
      render(<ContinueWithEmailPage />);

      await sendCode();
      userEvent.click(screen.getByRole("button", { name: "Resend code" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Back" })).toBeDisabled(),
      );
      expect(
        screen.getByRole("button", { name: "Resend code" }),
      ).toBeDisabled();

      finishResend({ message: "A new code is on its way." });
      await screen.findByText("A new code is on its way.");
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

      userEvent.click(screen.getByRole("button", { name: "Back" }));
      const emailField = screen.getByLabelText("Email");
      expect(emailField).toHaveFocus();
      await userEvent.clear(emailField);
      await userEvent.type(emailField, "bob@example.com");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.type(
        await screen.findByLabelText("Verification Code"),
        "654321",
      );
      expect(screen.getByText("bob@example.com").tagName).toBe("STRONG");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(verifyEmailAuthCode).toHaveBeenCalledWith({
          email: "bob@example.com",
          code: "654321",
        }),
      );
    });

    test("clears a stale verification error while the code is retyped", async () => {
      verifyEmailAuthCode.mockRejectedValueOnce(new Error("Code expired"));
      render(<ContinueWithEmailPage />);

      const codeField = await sendCode();
      await userEvent.type(codeField, "123456");
      userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Code expired",
      );

      await userEvent.clear(codeField);
      await userEvent.type(codeField, "7");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(codeField).toHaveValue("7");
    });
  });

  describe("password mode", () => {
    test("validates both fields before signing in", async () => {
      render(<ContinueWithEmailPage />);
      const password = switchToPassword();
      const submit = screen.getByRole("button", { name: "Sign In" });

      expect(submit).toBeDisabled();
      expect(password.closest("form")).toHaveAttribute("novalidate");
      submitForm(password);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Please enter your email.",
      );
      expect(screen.getByLabelText("Email")).toHaveAttribute(
        "aria-invalid",
        "true",
      );

      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      submitForm(password);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Please enter your password.",
      );
      expect(password).toHaveAttribute("aria-invalid", "true");
      expect(login).not.toHaveBeenCalled();

      await userEvent.type(password, "hunter22");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(submit).toBeEnabled();
      userEvent.click(submit);

      await waitFor(() =>
        expect(login).toHaveBeenCalledWith({
          email: "ada@example.com",
          password: "hunter22",
        }),
      );
      expect(navigateTo).toHaveBeenCalledWith("/dashboard");

      submitForm(password);
      expect(login).toHaveBeenCalledTimes(1);
    });

    test("sends a new account to profile completion after a password sign-in", async () => {
      login.mockResolvedValue({ next_step: "complete_profile" });
      render(<ContinueWithEmailPage next={EVENT_NEXT} />);

      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      await userEvent.type(switchToPassword(), "hunter22");
      userEvent.click(screen.getByRole("button", { name: "Sign In" }));

      await waitFor(() =>
        expect(navigateTo).toHaveBeenCalledWith(
          "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DABC123",
        ),
      );
    });

    test("reports sign-in failures with a fallback message", async () => {
      login
        .mockRejectedValueOnce(new Error("Invalid credentials."))
        .mockRejectedValueOnce(new Error(""));
      render(<ContinueWithEmailPage />);

      const password = switchToPassword();
      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
      await userEvent.type(password, "wrong");
      userEvent.click(screen.getByRole("button", { name: "Sign In" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Invalid credentials.",
      );

      await userEvent.type(password, "!");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      userEvent.click(screen.getByRole("button", { name: "Sign In" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unable to sign in.",
      );
      expect(navigateTo).not.toHaveBeenCalled();
    });

    test("links to account recovery, carrying a non-default destination", () => {
      const plain = render(<ContinueWithEmailPage />);
      switchToPassword();
      expect(
        screen.getByRole("link", { name: "Forgot password?" }),
      ).toHaveAttribute("href", "/recover");
      plain.unmount();

      render(<ContinueWithEmailPage next={EVENT_NEXT} />);
      switchToPassword();
      expect(
        screen.getByRole("link", { name: "Forgot password?" }),
      ).toHaveAttribute("href", "/recover?next=%2Fevent%3Fcode%3DABC123");
    });
  });

  describe("session state", () => {
    test("shows the account status banner until a code is requested", async () => {
      render(
        <ContinueWithEmailPage initialStatus="Your account has been deleted." />,
      );
      const banner = screen.getByRole("status");
      expect(banner).toHaveTextContent("Your account has been deleted.");
      expect(banner).toHaveClass("alert-success");

      await sendCode();
      expect(
        screen.queryByText("Your account has been deleted."),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(CODE_SENT_MESSAGE);
    });

    test("redirects an authenticated account instead of rendering the login form", async () => {
      useAuth.mockReturnValue({
        user: { id: "member-1" },
        loading: false,
        nextStep: null,
        requiresProfileCompletion: false,
        login,
        requestEmailAuthCode,
        verifyEmailAuthCode,
      });

      render(<ContinueWithEmailPage next={EVENT_NEXT} />);

      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Opening your account…",
      );
      await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(EVENT_NEXT));
    });

    test("sends an authenticated incomplete profile to setup and avoids auth-entry loops", async () => {
      useAuth.mockReturnValue({
        user: { id: "member-1" },
        loading: false,
        nextStep: "complete_profile",
        requiresProfileCompletion: true,
        login,
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
      expect(
        destinationAfterAuthentication(
          "/settings?complete_profile=1&next=%2Flogin",
          {},
        ),
      ).toBe("/dashboard");
    });

    test("hides the form while the session is loading and keeps the typed email", async () => {
      useAuth.mockReturnValue({
        user: null,
        loading: true,
        login,
        requestEmailAuthCode,
        verifyEmailAuthCode,
      });
      const { rerender } = render(<ContinueWithEmailPage />);

      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Checking your session…",
      );
      expect(navigateTo).not.toHaveBeenCalled();

      useAuth.mockReturnValue({
        user: null,
        loading: false,
        login,
        requestEmailAuthCode,
        verifyEmailAuthCode,
      });
      rerender(<ContinueWithEmailPage />);
      await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");

      useAuth.mockReturnValue({
        user: null,
        loading: true,
        login,
        requestEmailAuthCode,
        verifyEmailAuthCode,
      });
      rerender(<ContinueWithEmailPage />);
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Continue" }),
      ).not.toBeInTheDocument();
      expect(requestEmailAuthCode).not.toHaveBeenCalled();

      useAuth.mockReturnValue({
        user: null,
        loading: false,
        login,
        requestEmailAuthCode,
        verifyEmailAuthCode,
      });
      rerender(<ContinueWithEmailPage />);
      expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    });
  });
});
