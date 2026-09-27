/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import EmailMenu from "@/components/schedule/participants/EmailMenu";

const openMenu = async (user) =>
  user.click(screen.getByRole("button", { name: "Email" }));

describe("EmailMenu", () => {
  test("lists both actions with their counts and the next reminder time", async () => {
    const user = userEvent.setup();
    const onInviteAll = jest.fn();
    const onSendReminders = jest.fn();
    const nextAt = "2026-10-01T09:00:00Z";
    render(
      <EmailMenu
        notInvitedCount={7}
        remindCount={3}
        reminders={{ enabled: true, nextAt }}
        onInviteAll={onInviteAll}
        onSendReminders={onSendReminders}
      />,
    );
    await openMenu(user);
    expect(screen.getByRole("menu")).toHaveTextContent(
      `Next automatic reminder: ${new Date(nextAt).toLocaleString([], {})}`,
    );
    await user.click(
      screen.getByRole("menuitem", {
        name: "Invite everyone not invited yet (7)…",
      }),
    );
    expect(onInviteAll).toHaveBeenCalledTimes(1);
    await openMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Send reminders (3)…" }),
    );
    expect(onSendReminders).toHaveBeenCalledTimes(1);
  });

  test("says reminders are off and disables reminders at zero", async () => {
    const user = userEvent.setup();
    render(
      <EmailMenu
        notInvitedCount={0}
        remindCount={0}
        reminders={{ enabled: false, nextAt: "2026-10-01T09:00:00Z" }}
        onInviteAll={jest.fn()}
        onSendReminders={jest.fn()}
      />,
    );
    await openMenu(user);
    expect(screen.getByRole("menu")).toHaveTextContent("Reminders are off");
    expect(
      screen.getByRole("menuitem", { name: "Send reminders (0)…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Invite everyone not invited yet (0)…",
      }),
    ).toBeEnabled();
  });

  test("does not offer reminders while they are off, even with people to remind", async () => {
    const user = userEvent.setup();
    const onSendReminders = jest.fn();
    render(
      <EmailMenu
        notInvitedCount={2}
        remindCount={3}
        reminders={{ enabled: false, nextAt: null }}
        onInviteAll={jest.fn()}
        onSendReminders={onSendReminders}
      />,
    );
    await openMenu(user);
    expect(screen.getByRole("menu")).toHaveTextContent("Reminders are off");
    const remind = screen.getByRole("menuitem", {
      name: "Send reminders (3)…",
    });
    expect(remind).toBeDisabled();
    await user.click(remind);
    expect(onSendReminders).not.toHaveBeenCalled();
    expect(
      screen.getByRole("menuitem", {
        name: "Invite everyone not invited yet (2)…",
      }),
    ).toBeEnabled();
  });

  test("treats missing reminder settings as off and honours disabled", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EmailMenu />);
    await openMenu(user);
    expect(screen.getByRole("menu")).toHaveTextContent("Reminders are off");
    rerender(
      <EmailMenu reminders={{ enabled: true, nextAt: null }} disabled />,
    );
    expect(screen.getByRole("button", { name: "Email" })).toBeDisabled();
  });
});
