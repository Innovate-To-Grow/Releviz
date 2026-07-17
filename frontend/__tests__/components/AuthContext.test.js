/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import AuthContext, { AuthProvider, useAuth } from "@/components/auth/AuthContext";
import { clearAuthSession, readAuthSession, writeAuthSession } from "@/lib/api/config";
import {
  changePasswordApi,
  deleteAccountApi,
  fetchAuthSessions,
  fetchProfile,
  loginWithPassword,
  logoutApi,
  requestLoginCode,
  revokeAuthSessions,
  startRegistration,
  updateProfileApi,
  verifyLoginCode,
  verifyRegistration,
} from "@/lib/api/auth";

jest.mock("@/lib/api/auth", () => ({
  changePasswordApi: jest.fn(),
  deleteAccountApi: jest.fn(),
  fetchAuthSessions: jest.fn(),
  fetchProfile: jest.fn(),
  loginWithPassword: jest.fn(),
  logoutApi: jest.fn(),
  requestLoginCode: jest.fn(),
  revokeAuthSessions: jest.fn(),
  startRegistration: jest.fn(),
  updateProfileApi: jest.fn(),
  verifyLoginCode: jest.fn(),
  verifyRegistration: jest.fn(),
}));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="user">{auth.user?.displayName || "none"}</span>
      <button onClick={() => auth.login({ email: "a", password: "p" })}>login</button>
      <button onClick={() => auth.requestEmailLoginCode({ email: "a" })}>request-code</button>
      <button onClick={() => auth.verifyEmailLoginCode({ email: "a", code: "1" })}>
        verify-login
      </button>
      <button onClick={() => auth.signup({ email: "a" })}>signup</button>
      <button onClick={() => auth.verifySignup({ email: "a", code: "1" })}>verify</button>
      <button onClick={() => auth.updateProfile({ first_name: "Ada" })}>update</button>
      <button onClick={() => auth.refreshUser()}>refresh</button>
      <button onClick={async () => (window.__sessions = await auth.listSessions())}>
        sessions
      </button>
      <button onClick={() => auth.revokeSession("other-session")}>revoke-session</button>
      <button onClick={() => auth.revokeSession("current-session")}>revoke-current</button>
      <button onClick={() => auth.logoutAll()}>logout-all</button>
      <button
        onClick={() =>
          auth.changePassword({
            currentPassword: "old",
            newPassword: "new-password",
            newPasswordConfirm: "new-password",
          })
        }
      >
        change-password
      </button>
      <button onClick={() => auth.deleteAccount({ password: "old", confirmation: "DELETE" })}>
        delete-account
      </button>
      <button onClick={() => auth.logout()}>logout</button>
      <button onClick={async () => (window.__token = await auth.getToken())}>token</button>
    </div>
  );
}

describe("AuthContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearAuthSession();
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 401));
    delete window.__token;
    delete window.__sessions;
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

  test("hydrates a session from the refresh cookie without Web Storage", async () => {
    localStorage.setItem("releviz.auth", "legacy-secret");
    global.fetch.mockResolvedValueOnce(
      jsonResponse({
        access: "cookie-access",
        user: { displayName: "Cookie User" },
      })
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("user")).toHaveTextContent("Cookie User");
    expect(readAuthSession().access).toBe("cookie-access");
    expect(localStorage.getItem("releviz.auth")).toBeNull();
  });

  test("clears in-memory auth when cookie hydration throws", async () => {
    writeAuthSession({ access: "stale", user: { displayName: "Stale User" } });
    global.fetch.mockRejectedValueOnce(new Error("network down"));
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
    requestLoginCode.mockResolvedValue({ message: "sent" });
    verifyLoginCode.mockImplementation(async () => {
      writeAuthSession({ access: "code-token", user: { displayName: "Code User" } });
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
    changePasswordApi.mockResolvedValue({ message: "changed" });
    deleteAccountApi.mockResolvedValue({ message: "deleted" });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await userEvent.click(screen.getByText("login"));
    expect(screen.getByTestId("user")).toHaveTextContent("Login User");
    await userEvent.click(screen.getByText("request-code"));
    expect(requestLoginCode).toHaveBeenCalledWith({ email: "a" });
    await userEvent.click(screen.getByText("verify-login"));
    expect(screen.getByTestId("user")).toHaveTextContent("Code User");
    await userEvent.click(screen.getByText("signup"));
    expect(startRegistration).toHaveBeenCalledWith({ email: "a" });
    await userEvent.click(screen.getByText("verify"));
    expect(screen.getByTestId("user")).toHaveTextContent("Verified User");
    await userEvent.click(screen.getByText("update"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("Updated User"));
    await userEvent.click(screen.getByText("refresh"));
    expect(fetchProfile).toHaveBeenCalled();
    await userEvent.click(screen.getByText("token"));
    await waitFor(() => expect(window.__token).toBe("verify-token"));
    await userEvent.click(screen.getByText("logout"));
    expect(window.location.assign).toHaveBeenCalledWith("/");
  });

  test("responds to in-memory auth events", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    writeAuthSession({ access: "a", user: { displayName: "External" } });
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("External"));
  });

  test("lists and revokes individual or all sessions", async () => {
    fetchAuthSessions.mockResolvedValue([{ id: "other-session" }]);
    revokeAuthSessions.mockImplementation(async ({ sessionId, all }) => ({
      currentRevoked: all || sessionId === "current-session",
    }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    writeAuthSession({ access: "a", user: { displayName: "Session User" } });

    await userEvent.click(screen.getByText("sessions"));
    await waitFor(() => expect(window.__sessions).toEqual([{ id: "other-session" }]));
    await userEvent.click(screen.getByText("revoke-session"));
    expect(revokeAuthSessions).toHaveBeenCalledWith({ sessionId: "other-session" });
    expect(screen.getByTestId("user")).toHaveTextContent("Session User");

    await userEvent.click(screen.getByText("revoke-current"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("none"));

    writeAuthSession({ access: "b", user: { displayName: "Again" } });
    await userEvent.click(screen.getByText("logout-all"));
    expect(revokeAuthSessions).toHaveBeenCalledWith({ all: true });
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("/login?status=signed-out-all")
    );
  });

  test("changes passwords and deletes accounts through security actions", async () => {
    changePasswordApi.mockResolvedValue({ message: "changed" });
    deleteAccountApi.mockResolvedValue({ message: "deleted" });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    writeAuthSession({ access: "a", user: { displayName: "Account User" } });

    await userEvent.click(screen.getByText("change-password"));
    expect(changePasswordApi).toHaveBeenCalledWith({
      currentPassword: "old",
      newPassword: "new-password",
      newPasswordConfirm: "new-password",
    });
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("/login?status=password-changed")
    );
    expect(screen.getByTestId("user")).toHaveTextContent("none");

    writeAuthSession({ access: "b", user: { displayName: "Again" } });
    await userEvent.click(screen.getByText("delete-account"));
    expect(deleteAccountApi).toHaveBeenCalledWith({
      password: "old",
      confirmation: "DELETE",
    });
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("/login?status=account-deleted")
    );
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  test("getToken returns null without a session", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    await userEvent.click(screen.getByText("token"));
    await waitFor(() => expect(window.__token).toBeNull());
  });
});
