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
  default: ({ alt, priority: _priority, ...props }) => <img alt={alt || ""} {...props} />,
}));

// Mock AuthContext
jest.mock("@/components/auth/AuthContext", () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from "@/components/auth/AuthContext";
import HomePage from "@/components/HomePage";

describe("HomePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("keeps the public explanation visible while auth is loading", () => {
    useAuth.mockReturnValue({ user: null, loading: true });
    render(<HomePage />);
    expect(
      screen.getByRole("heading", { name: "Find a time that works for everyone." })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a scheduling poll" })).toBeDisabled();
  });

  test("explains the product and shows signed-out account actions", () => {
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    expect(screen.getByRole("link", { name: "Releviz home" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/Create a scheduling poll, share one link/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("heading", { name: "Open an existing poll" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How Releviz works" })).toBeInTheDocument();
  });

  test("shows a prominent dashboard continuation for an authenticated account", () => {
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
    });
    render(<HomePage />);
    expect(screen.getByRole("link", { name: /Go to my dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard"
    );
  });

  test("starts account creation before an anonymous organizer creates a poll", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create a scheduling poll" }));
    expect(push).toHaveBeenCalledWith("/signup?next=%2Fcreate");
  });

  test("opens the create form directly for an authenticated organizer", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
    });
    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Create a scheduling poll" }));
    expect(push).toHaveBeenCalledWith("/create");
  });

  test("sends an anonymous participant through login without losing the event code", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({ user: null, loading: false });
    render(<HomePage />);
    const openButton = screen.getByRole("button", { name: "Open event" });
    expect(openButton).toBeDisabled();
    fireEvent.click(openButton);
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Event code"), { target: { value: " ABC123 " } });
    fireEvent.submit(screen.getByLabelText("Event code").closest("form"));
    expect(push).toHaveBeenCalledWith("/login?next=%2Fevent%3Fcode%3DABC123");
  });

  test("opens an event directly for an authenticated participant", () => {
    const push = jest.fn();
    jest.spyOn(require("next/navigation"), "useRouter").mockReturnValue({ push });
    useAuth.mockReturnValue({
      user: { id: "user-1", displayName: "Prachi", email: "prachi@test.com" },
      loading: false,
    });
    render(<HomePage />);
    fireEvent.change(screen.getByLabelText("Event code"), { target: { value: " EVENT9 " } });
    fireEvent.click(screen.getByRole("button", { name: "Open event" }));
    expect(push).toHaveBeenCalledWith("/event?code=EVENT9");
  });
});
