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

jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("@/lib/navigation", () => ({
  navigateTo: jest.fn(),
  safeNextPath: (value, fallback = "/dashboard") => {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
      return fallback;
    }
    const baseUrl = "https://releviz.invalid";
    const resolved = new URL(value, baseUrl);
    return resolved.origin === baseUrl
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : fallback;
  },
}));

import { useAuth } from "@/components/auth/AuthContext";
import EmailAuthLinkPage, {
  destinationForLink,
  parseEmailAuthHash,
} from "@/app/email-auth-link/page";
import { navigateTo } from "@/lib/navigation";

const verifyEmailAuthCode = jest.fn();
const verifyEmailLoginCode = jest.fn();
const verifySignup = jest.fn();

describe("EmailAuthLinkPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/email-auth-link");
    verifyEmailAuthCode.mockResolvedValue({});
    verifyEmailLoginCode.mockResolvedValue({});
    verifySignup.mockResolvedValue({});
    useAuth.mockReturnValue({
      user: null,
      loading: false,
      logout: jest.fn(),
      verifyEmailAuthCode,
      verifyEmailLoginCode,
      verifySignup,
    });
  });

  test("verifies a unified link, clears the secret fragment, and restores next", async () => {
    window.location.hash =
      "flow=auth&source=event_registration&email=Ada%40Example.com&code=123456&event=ABC123&next=%2Fevent%3Fcode%3DABC123";

    render(<EmailAuthLinkPage />);

    expect(
      screen.getByRole("heading", { name: "Signing you in" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(verifyEmailAuthCode).toHaveBeenCalledWith({
        email: "ada@example.com",
        code: "123456",
      }),
    );
    expect(window.location.hash).toBe("");
    expect(navigateTo).toHaveBeenCalledWith("/event?code=ABC123");
  });

  test.each([
    ["login", verifyEmailLoginCode],
    ["register", verifySignup],
  ])("dispatches the %s legacy verification flow", async (flow, expected) => {
    window.location.hash = `flow=${flow}&source=${flow}&email=a%40b.com&code=654321`;
    render(<EmailAuthLinkPage />);
    await waitFor(() => expect(expected).toHaveBeenCalled());
  });

  test("preserves the destination through required profile completion", async () => {
    verifyEmailAuthCode.mockResolvedValue({
      requires_profile_completion: true,
    });
    window.location.hash =
      "flow=auth&source=event_registration&email=a%40b.com&code=123456&event=SPRING_1";

    render(<EmailAuthLinkPage />);

    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith(
        "/settings?complete_profile=1&next=%2Fevent%3Fcode%3DSPRING_1",
      ),
    );
  });

  test("rejects malformed or externally redirecting link data", async () => {
    window.location.hash =
      "flow=auth&source=login&email=a%40b.com&code=not-a-code&next=%2F%2Fevil.example";
    render(<EmailAuthLinkPage />);

    expect(
      await screen.findByRole("heading", { name: "Link verification failed" }),
    ).toBeInTheDocument();
    expect(verifyEmailAuthCode).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(
      screen.getByRole("link", { name: "Request a new code" }),
    ).toHaveAttribute("href", "/login");
  });

  test("parsers constrain destinations to local paths", () => {
    expect(
      parseEmailAuthHash(
        "#flow=auth&source=login&email=a%40b.com&code=123456&next=%2Fsettings",
      ),
    ).toEqual(expect.objectContaining({ email: "a@b.com", next: "/settings" }));
    expect(
      destinationForLink({
        source: "login",
        event: "",
        next: "//evil.example",
      }),
    ).toBe("/dashboard");
  });
});
