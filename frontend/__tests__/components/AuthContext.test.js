/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import AuthContext, { AuthProvider, useAuth } from "@/components/auth/AuthContext";
import { readAuthSession, writeAuthSession } from "@/lib/api/config";
import {
  fetchProfile,
  loginWithPassword,
  logoutApi,
  startRegistration,
  updateProfileApi,
  verifyRegistration,
} from "@/lib/api/auth";

jest.mock("@/lib/api/auth", () => ({
  fetchProfile: jest.fn(),
  loginWithPassword: jest.fn(),
  logoutApi: jest.fn(),
  startRegistration: jest.fn(),
  updateProfileApi: jest.fn(),
  verifyRegistration: jest.fn(),
}));

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="user">{auth.user?.displayName || "none"}</span>
      <button onClick={() => auth.login({ email: "a", password: "p" })}>login</button>
      <button onClick={() => auth.signup({ email: "a" })}>signup</button>
      <button onClick={() => auth.verifySignup({ email: "a", code: "1" })}>verify</button>
      <button onClick={() => auth.updateProfile({ first_name: "Ada" })}>update</button>
      <button onClick={() => auth.refreshUser()}>refresh</button>
      <button onClick={() => auth.logout()}>logout</button>
      <button onClick={async () => (window.__token = await auth.getToken())}>token</button>
    </div>
  );
}

describe("AuthContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    delete window.__token;
    delete window.location;
    window.location = { assign: jest.fn() };
  });

  test("throws when useAuth is outside provider", () => {
    expect(AuthContext).toBeTruthy();
    function BadProbe() {
      useAuth();
      return null;
    }
    expect(() => render(<BadProbe />)).toThrow("useAuth must be used within AuthProvider");
  });

  test("hydrates existing sessions and clears invalid sessions", async () => {
    writeAuthSession({ access: "a", refresh: "r", user: { displayName: "Stored" } });
    fetchProfile.mockRejectedValueOnce(new Error("expired"));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(readAuthSession()).toBeNull();
  });

  test("auth actions update session state and redirect on logout", async () => {
    loginWithPassword.mockImplementation(async () => {
      writeAuthSession({ access: "login-token", user: { displayName: "Login User" } });
      return { ok: true };
    });
    startRegistration.mockResolvedValue({ message: "started" });
    verifyRegistration.mockImplementation(async () => {
      writeAuthSession({ access: "verify-token", user: { displayName: "Verified User" } });
      return { ok: true };
    });
    updateProfileApi.mockResolvedValue({ displayName: "Updated User" });
    fetchProfile.mockResolvedValue({ displayName: "Refreshed User" });
    logoutApi.mockResolvedValue();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await userEvent.click(screen.getByText("login"));
    expect(screen.getByTestId("user")).toHaveTextContent("Login User");
    await userEvent.click(screen.getByText("signup"));
    expect(startRegistration).toHaveBeenCalledWith({ email: "a" });
    await userEvent.click(screen.getByText("verify"));
    expect(screen.getByTestId("user")).toHaveTextContent("Verified User");
    await userEvent.click(screen.getByText("update"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("Updated User"));
    await userEvent.click(screen.getByText("refresh"));
    expect(fetchProfile).toHaveBeenCalled();
    await userEvent.click(screen.getByText("token"));
    expect(window.__token).toBe("verify-token");
    await userEvent.click(screen.getByText("logout"));
    expect(window.location.assign).toHaveBeenCalledWith("/");
  });

  test("responds to storage events", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    writeAuthSession({ access: "a", user: { displayName: "External" } });
    window.dispatchEvent(new Event("storage"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("External"));
  });

  test("getToken returns null without a session", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    await userEvent.click(screen.getByText("token"));
    expect(window.__token).toBeNull();
  });
});
