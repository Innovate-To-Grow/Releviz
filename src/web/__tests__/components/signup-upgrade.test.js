/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const signup = jest.fn();
const verifySignup = jest.fn();
const fetchTempAccessSession = jest.fn();
const startTemporaryUpgradeRegistration = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: () => ({ signup, verifySignup, loading: false }),
}));

jest.mock("@/components/ui/BrandLogo", () => ({
  BrandHomeLink: () => <div>Releviz</div>,
}));

jest.mock("@/lib/api/auth", () => ({
  startTemporaryUpgradeRegistration: (...args) =>
    startTemporaryUpgradeRegistration(...args),
}));

jest.mock("@/lib/api/tempAccess", () => ({
  fetchTempAccessSession: (...args) => fetchTempAccessSession(...args),
}));

jest.mock("@/lib/navigation", () => {
  const actual = jest.requireActual("@/lib/navigation");
  return { ...actual, navigateTo: jest.fn() };
});

import SignupPage from "@/app/signup/page";

describe("temporary-account upgrade registration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams(
      "upgrade=temporary&code=ABC123&next=%2Fevent%3Fcode%3DABC123",
    );
    fetchTempAccessSession.mockResolvedValue({ email: "temp@example.com" });
    startTemporaryUpgradeRegistration.mockResolvedValue({});
    verifySignup.mockResolvedValue({});
  });

  test("loads and locks the server-bound temporary identity without putting email in the URL", async () => {
    render(<SignupPage />);

    expect(searchParams.has("email")).toBe(false);
    expect(searchParams.has("lockedEmail")).toBe(false);
    expect(fetchTempAccessSession).toHaveBeenCalledWith("ABC123");
    const email = await screen.findByDisplayValue("temp@example.com");
    expect(email).toHaveValue("temp@example.com");
    expect(email).toHaveAttribute("readonly");
    expect(email).toHaveAccessibleName("Email");
    expect(email).toHaveAccessibleDescription(
      "This email is fixed so your existing event responses stay connected.",
    );
    expect(
      screen.getByText(
        "This email is fixed so your existing event responses stay connected.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("First name"), "Taylor");
    await userEvent.type(screen.getByLabelText("Last name"), "Temp");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.type(
      screen.getByLabelText("Confirm password"),
      "password123",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() =>
      expect(startTemporaryUpgradeRegistration).toHaveBeenCalledWith(
        "ABC123",
        expect.objectContaining({
          first_name: "Taylor",
          last_name: "Temp",
        }),
      ),
    );
    expect(
      startTemporaryUpgradeRegistration.mock.calls[0][1],
    ).not.toHaveProperty("email");
    expect(
      startTemporaryUpgradeRegistration.mock.calls[0][1],
    ).not.toHaveProperty("organization");
    expect(
      startTemporaryUpgradeRegistration.mock.calls[0][1],
    ).not.toHaveProperty("title");
    expect(signup).not.toHaveBeenCalled();

    await userEvent.type(
      await screen.findByLabelText("Verification code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and continue" }),
    );
    await waitFor(() =>
      expect(verifySignup).toHaveBeenCalledWith({
        email: "temp@example.com",
        code: "123456",
        temporaryUpgrade: true,
      }),
    );
  });

  test("blocks registration when the restricted temporary session cannot be loaded", async () => {
    fetchTempAccessSession.mockRejectedValueOnce(
      new Error("No temporary session"),
    );

    render(<SignupPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not verify this temporary session",
    );
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Send verification code" }),
    ).toBeDisabled();
    expect(startTemporaryUpgradeRegistration).not.toHaveBeenCalled();
    expect(signup).not.toHaveBeenCalled();
  });

  test("blocks an incomplete upgrade URL before making a session request", async () => {
    searchParams = new URLSearchParams(
      "upgrade=temporary&next=%2Fevent%3Fcode%3DABC123",
    );

    render(<SignupPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "upgrade link is incomplete",
    );
    expect(fetchTempAccessSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Send verification code" }),
    ).toBeDisabled();
  });
});
