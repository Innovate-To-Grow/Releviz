/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

// Mock next/image
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, ...props }) => <img alt={alt || ""} {...props} />,
}));

// Mock AuthContext
jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

// Mock material web components
jest.mock("@material/web/textfield/outlined-text-field.js", () => ({}), { virtual: true });

import { useAuth } from "@/components/auth/AuthContext";
import HomePage from "@/components/HomePage";

describe("HomePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shows loading state when auth is loading", () => {
    useAuth.mockReturnValue({ user: null, loading: true });
    render(<HomePage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("shows Releviz branding", () => {
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    expect(screen.getByText("Releviz")).toBeInTheDocument();
    expect(screen.getByText(/Intelligent group scheduling/i)).toBeInTheDocument();
  });

  test("shows Organize and Join CTAs", () => {
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    expect(screen.getByText("Organize an Event")).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
  });

  test("shows dashboard link for an authenticated account", () => {
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
    });
    render(<HomePage />);
    expect(screen.getByText(/View my dashboard/i)).toBeInTheDocument();
  });

  test("redirects to /create when user clicks Organize", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    fireEvent.click(screen.getByText("Organize an Event"));
    expect(push).toHaveBeenCalledWith("/create");
  });

  test("redirects to /create when authenticated user clicks Organize", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
    });
    render(<HomePage />);
    fireEvent.click(screen.getByText("Organize an Event"));
    expect(push).toHaveBeenCalledWith("/create");
  });

  test("joins by trimmed event code and ignores empty codes", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    fireEvent.click(screen.getByText("Go"));
    expect(push).not.toHaveBeenCalled();
    const input = document.querySelector("md-outlined-text-field");
    input.value = " ABC123 ";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/event?code=ABC123");
  });
});
