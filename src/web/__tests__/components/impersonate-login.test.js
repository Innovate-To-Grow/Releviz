/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
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

jest.mock("@/lib/api/auth", () => ({
  impersonateLogin: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import ImpersonateLoginPage, { metadata } from "@/app/impersonate-login/page";
import ImpersonateLoginClient from "@/app/impersonate-login/ImpersonateLoginClient";
import { impersonateLogin } from "@/lib/api/auth";
import { navigateTo } from "@/lib/navigation";

function mockAuth(loading) {
  useAuth.mockReturnValue({ user: null, loading, logout: jest.fn() });
}

describe("ImpersonateLoginPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/impersonate-login");
    impersonateLogin.mockResolvedValue({});
    mockAuth(false);
  });

  test("the route wrapper is unindexed and renders the client flow", async () => {
    expect(metadata).toEqual({
      title: "Signing you in · Releviz",
      robots: { index: false, follow: false },
    });
    window.location.hash = "#token=wrapped";

    render(<ImpersonateLoginPage />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Signing you in...");
    await waitFor(() =>
      expect(impersonateLogin).toHaveBeenCalledWith({ token: "wrapped" }),
    );
  });

  test("exchanges the token, clears the fragment, and lands on the dashboard", async () => {
    window.location.hash = "#token=abc123";

    render(<ImpersonateLoginClient />);

    expect(impersonateLogin).toHaveBeenCalledTimes(1);
    expect(impersonateLogin).toHaveBeenCalledWith({ token: "abc123" });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/impersonate-login");
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));
  });

  test("routes an incomplete profile through settings first", async () => {
    impersonateLogin.mockResolvedValue({ requires_profile_completion: true });
    window.location.hash = "#token=abc123";

    render(<ImpersonateLoginClient />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/settings?complete_profile=1&next=%2Fdashboard",
      ),
    );
  });

  test("explains a missing token without calling the API", () => {
    render(<ImpersonateLoginClient />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "No impersonation token provided.",
    );
    expect(screen.getByRole("link", { name: "Go to Login" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(impersonateLogin).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test("hides the backend detail when the token is rejected", async () => {
    impersonateLogin.mockRejectedValue(
      new Error("Invalid impersonation link."),
    );
    window.location.hash = "#token=stale";

    render(<ImpersonateLoginClient />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This impersonation link is invalid or has expired.",
    );
    expect(
      screen.queryByText("Invalid impersonation link."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Login" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(impersonateLogin).toHaveBeenCalledTimes(1);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test("waits for the auth provider and exchanges the token only once", async () => {
    mockAuth(true);
    window.location.hash = "#token=abc123";

    const { rerender } = render(<ImpersonateLoginClient />);

    expect(screen.getByRole("status")).toHaveTextContent("Signing you in...");
    expect(impersonateLogin).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#token=abc123");

    mockAuth(false);
    rerender(<ImpersonateLoginClient />);
    expect(impersonateLogin).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/dashboard"));

    mockAuth(true);
    rerender(<ImpersonateLoginClient />);
    mockAuth(false);
    rerender(<ImpersonateLoginClient />);
    expect(impersonateLogin).toHaveBeenCalledTimes(1);
  });
});
