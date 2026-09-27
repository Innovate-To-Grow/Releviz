/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import PersonPanel from "@/components/schedule/participants/PersonPanel";

const groups = [
  { id: 1, name: "Design" },
  { id: 2, name: "Engineering" },
];

function person(overrides = {}) {
  return {
    id: "11",
    participantId: "11",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "",
    groups: [{ id: 1, name: "Design" }],
    allGroups: false,
    weight: 1,
    included: true,
    submitted: false,
    accountAccess: "temporary",
    organizerManaged: false,
    canOrganizerEditAvailability: true,
    isOrganizer: false,
    canOrganizerEditEmail: true,
    invitationStatus: "not_sent",
    invitationDelivery: null,
    version: 3,
    ...overrides,
  };
}

function renderPanel(participant = person(), props = {}) {
  const handlers = {
    onPrev: jest.fn(),
    onNext: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
    onClose: jest.fn(),
    onEditSchedule: jest.fn(),
    onSendInvitation: jest.fn(),
    onRemove: jest.fn(),
    onOpenGroupPicker: jest.fn().mockResolvedValue(null),
    ...props,
  };
  const utils = render(
    <PersonPanel participant={participant} groups={groups} {...handlers} />,
  );
  return { ...handlers, ...utils };
}

// Labels can carry more text (a required marker) after the name.
const field = (name) =>
  screen.getByLabelText((label) => label.startsWith(name));
const save = () => screen.getByRole("button", { name: "Save" });

describe("PersonPanel", () => {
  test("shows the person's details and sections, with Save disabled until dirty", () => {
    renderPanel(person(), {
      position: { index: 1, total: 4 },
      organizerEmail: "org@example.com",
    });
    const dialog = screen.getByRole("dialog", { name: "Ada Lovelace" });
    expect(dialog).toHaveTextContent(
      "Invited by email. Signs in with their link, no account.",
    );
    expect(screen.getByText("2 of 4")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous person" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next person" })).toBeEnabled();
    expect(field("Full name")).toHaveValue("Ada Lovelace");
    expect(field("Email")).toHaveValue("ada@example.com");
    expect(field("Phone")).toHaveValue("");
    expect(field("Phone")).toHaveAccessibleDescription(
      "Never used to contact them",
    );
    expect(
      within(screen.getByRole("list", { name: "Groups" })).getByText("Design"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Count Ada Lovelace's answers" }),
    ).toBeChecked();
    expect(field("Weight")).toHaveValue(1);
    expect(field("Weight")).toHaveAccessibleDescription(
      "At 0, Ada Lovelace counts only in the unweighted score.",
    );
    expect(screen.getByText("Not sent")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send invitation" }),
    ).toBeEnabled();
    expect(save()).toBeDisabled();
    // The backdrop and the header's x share a label; the x gets initial focus.
    expect(
      screen.getAllByRole("button", { name: "Close details" }).at(-1),
    ).toHaveFocus();
  });

  test("saves only the changed fields, then is clean again", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.clear(field("Full name"));
    await user.type(field("Full name"), " Ada L. ");
    await user.type(field("Phone"), "+1 555 0100");
    await user.click(screen.getByRole("checkbox", { name: /Count/ }));
    await user.clear(field("Weight"));
    await user.type(field("Weight"), "0.5");
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() =>
      expect(handlers.onSave).toHaveBeenCalledWith({
        name: "Ada L.",
        phone: "+1 555 0100",
        included: false,
        weight: 0.5,
      }),
    );
    await waitFor(() => expect(save()).toBeDisabled());
    expect(field("Full name")).toHaveValue("Ada L.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Discard your changes?" }),
    ).toBeNull();
  });

  test("validates every field before saving", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.clear(field("Full name"));
    await user.clear(field("Email"));
    await user.type(field("Email"), "nope");
    await user.type(field("Phone"), "12");
    await user.clear(field("Weight"));
    await user.type(field("Weight"), "3");
    fireEvent.submit(field("Full name").closest("form"));
    const alerts = screen
      .getAllByRole("alert")
      .map((alert) => alert.textContent);
    expect(alerts).toEqual([
      "Full name is required.",
      "Enter a valid email address.",
      "Enter a phone number with 7 to 32 digits.",
      "Enter a weight between 0 and 1.",
    ]);
    expect(handlers.onSave).not.toHaveBeenCalled();
    await user.type(field("Full name"), "A");
    expect(screen.queryByText("Full name is required.")).toBeNull();
  });

  test("a locked email explains why and the organizer's own row is read-only", () => {
    const { unmount } = renderPanel(
      person({ canOrganizerEditEmail: false, invitationStatus: "accepted" }),
    );
    expect(field("Email")).toBeDisabled();
    expect(field("Email")).toHaveAccessibleDescription(
      "Ada Lovelace already signed in, so this address can't change. Remove Ada Lovelace and add them again if it is wrong.",
    );
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled();
    unmount();

    renderPanel(person({ isOrganizer: true, canOrganizerEditEmail: false }));
    expect(
      screen.getByRole("dialog", { name: "Ada Lovelace (you)" }),
    ).toHaveTextContent("Your own row.");
    expect(field("Full name")).toBeDisabled();
    expect(field("Full name")).toHaveAccessibleDescription(
      "From your account settings",
    );
    expect(field("Email")).toHaveAccessibleDescription(
      "From your account settings",
    );
    expect(
      screen.getByRole("button", { name: "Edit my schedule" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invitation" })).toBeNull();
  });

  test("a person with no email of their own can be given one", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel(
      person({
        organizerManaged: true,
        email: "org@example.com",
        accountAccess: "full",
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No email of their own. You enter their schedule.",
    );
    expect(field("Email")).toHaveValue("");
    expect(field("Email")).toHaveAttribute(
      "placeholder",
      "Add their email to invite them",
    );
    expect(screen.queryByRole("heading", { name: "Invitation" })).toBeNull();
    await user.type(field("Email"), "Ada@Example.com");
    await user.click(save());
    await waitFor(() =>
      expect(handlers.onSave).toHaveBeenCalledWith({
        email: "ada@example.com",
      }),
    );
  });

  test("a person who answers themselves keeps their name and has no schedule button", () => {
    renderPanel(
      person({
        accountAccess: "full",
        canOrganizerEditAvailability: false,
        canOrganizerEditEmail: false,
        invitationStatus: "sent",
        invitationSentAt: "2026-09-10T10:00:00Z",
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Answers with their own account.",
    );
    expect(screen.getByText("Answers themselves")).toHaveAttribute(
      "title",
      "Ada Lovelace answered with their own account, so only they can change it.",
    );
    expect(field("Full name")).toBeDisabled();
    expect(field("Full name")).toHaveAccessibleDescription(
      "They set their own name in their Releviz account.",
    );
    expect(
      screen.getByText(
        `Sent on ${new Date("2026-09-10T10:00:00Z").toLocaleString([], {})}`,
      ),
    ).toBeInTheDocument();
  });

  test("shows a full account that can still be entered for, plus delivery states", () => {
    const { unmount } = renderPanel(
      person({ accountAccess: "full", invitationStatus: "sent" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Has a Releviz account. You can enter their schedule until they answer themselves.",
    );
    expect(screen.getByText("Sent")).toBeInTheDocument();
    unmount();
    renderPanel(
      person({ invitationStatus: "sent", invitationDelivery: "queued" }),
    );
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend" })).toBeDisabled();
  });

  test("the group picker updates the draft and Save sends the membership diff", async () => {
    const user = userEvent.setup();
    const onOpenGroupPicker = jest
      .fn()
      .mockResolvedValueOnce({ addGroupIds: [2, 2], removeGroupIds: [1] })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ allGroups: true });
    const handlers = renderPanel(person(), { onOpenGroupPicker });
    await user.click(screen.getByRole("button", { name: "+ Add to group" }));
    expect(onOpenGroupPicker).toHaveBeenCalledWith({
      allGroups: "none",
      byGroup: { 1: "all" },
    });
    const list = () => screen.getByRole("list", { name: "Groups" });
    await waitFor(() => expect(list()).toHaveTextContent("Engineering"));
    expect(list()).not.toHaveTextContent("Design");

    await user.click(screen.getByRole("button", { name: "+ Add to group" }));
    await waitFor(() => expect(onOpenGroupPicker).toHaveBeenCalledTimes(2));
    expect(list()).toHaveTextContent("Engineering");

    await user.click(screen.getByRole("button", { name: "+ Add to group" }));
    await waitFor(() =>
      expect(list()).toHaveTextContent(
        "Every group, including groups added later",
      ),
    );
    await user.click(save());
    await waitFor(() =>
      expect(handlers.onSave).toHaveBeenCalledWith({
        addGroupIds: [2],
        removeGroupIds: [1],
        allGroups: true,
      }),
    );
  });

  test("shows No group and unknown group ids gracefully", () => {
    renderPanel(person({ groups: [{ id: 7, name: "Ops" }] }), { groups: [] });
    expect(screen.getByRole("list", { name: "Groups" })).toHaveTextContent(
      "Ops",
    );
    const { unmount } = renderPanel(person({ groups: [] }));
    expect(
      screen.getAllByRole("list", { name: "Groups" })[1],
    ).toHaveTextContent("No group");
    unmount();
  });

  test("closing with unsaved changes asks first", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.type(field("Phone"), "+1 555 0100");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const confirm = screen.getByRole("dialog", {
      name: "Discard your changes?",
    });
    expect(confirm).toHaveTextContent(
      "Your changes to Ada Lovelace haven't been saved.",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(field("Phone")).toHaveValue("+1 555 0100");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Discard your changes?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("opening the schedule with unsaved changes asks first", async () => {
    const user = userEvent.setup();
    const p = person();
    const handlers = renderPanel(p);
    await user.type(field("Phone"), "+1 555 0100");
    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    expect(
      screen.getByRole("dialog", { name: "Discard your changes?" }),
    ).toBeInTheDocument();
    expect(handlers.onEditSchedule).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(handlers.onEditSchedule).not.toHaveBeenCalled();
    expect(field("Phone")).toHaveValue("+1 555 0100");

    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onEditSchedule).toHaveBeenCalledWith(p);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(field("Phone")).toHaveValue("");
  });

  test("moving to another person asks when dirty and goes straight there when clean", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel(person(), {
      position: { index: 1, total: 3 },
    });
    await user.click(screen.getByRole("button", { name: "Next person" }));
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Previous person" }));
    expect(handlers.onPrev).toHaveBeenCalledTimes(1);

    await user.type(field("Phone"), "+1 555 0100");
    await user.click(screen.getByRole("button", { name: "Next person" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onNext).toHaveBeenCalledTimes(2);
    expect(field("Phone")).toHaveValue("");

    await user.type(field("Phone"), "+1 555 0100");
    await user.click(screen.getByRole("button", { name: "Previous person" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onPrev).toHaveBeenCalledTimes(2);
  });

  test("disables prev/next at the ends and hides them without a position", () => {
    const { unmount } = renderPanel(person(), {
      position: { index: 0, total: 1 },
    });
    expect(
      screen.getByRole("button", { name: "Previous person" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next person" })).toBeDisabled();
    unmount();
    renderPanel();
    expect(
      screen.queryByRole("button", { name: "Previous person" }),
    ).toBeNull();
  });

  test("surfaces conflicts, parent errors and a rejected save", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel(person(), {
      conflict: { message: "Ada Lovelace was changed in another session." },
      error: "Could not save.",
      onSave: jest.fn().mockRejectedValue(new Error("Network down.")),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ada Lovelace was changed in another session.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save.");

    rerender(
      <PersonPanel
        participant={person()}
        groups={groups}
        onSave={jest.fn().mockRejectedValue(new Error("Network down."))}
        onClose={jest.fn()}
      />,
    );
    await user.type(field("Phone"), "+1 555 0100");
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down.");

    rerender(
      <PersonPanel
        participant={person()}
        groups={groups}
        onSave={jest.fn().mockRejectedValue({})}
        onClose={jest.fn()}
      />,
    );
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The changes could not be saved.",
    );
  });

  test("read-only, a passed deadline and busy lock the form", async () => {
    const user = userEvent.setup();
    const { rerender, ...handlers } = renderPanel(person(), { readOnly: true });
    expect(field("Full name")).toBeDisabled();
    expect(field("Phone")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove from event…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Send invitation" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit schedule" })).toBeEnabled();
    fireEvent.submit(field("Full name").closest("form"));
    expect(handlers.onSave).not.toHaveBeenCalled();

    rerender(
      <PersonPanel
        participant={person()}
        groups={groups}
        deadlinePassed
        onClose={jest.fn()}
      />,
    );
    expect(field("Weight")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "+ Add to group" }),
    ).toBeDisabled();

    rerender(
      <PersonPanel
        participant={person()}
        groups={groups}
        busy
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit schedule" }),
    ).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: "Close details" }).at(-1),
    ).toBeDisabled();
  });

  test("the schedule, invitation and remove actions hand back the participant", async () => {
    const user = userEvent.setup();
    const p = person();
    const handlers = renderPanel(p);
    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    await user.click(
      screen.getByRole("button", { name: "Remove from event…" }),
    );
    expect(handlers.onEditSchedule).toHaveBeenCalledWith(p);
    expect(handlers.onSendInvitation).toHaveBeenCalledWith(p);
    expect(handlers.onRemove).toHaveBeenCalledWith(p);
  });

  test("renders nothing without a participant and resets when the person changes", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <PersonPanel participant={null} onClose={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <PersonPanel
        participant={person()}
        groups={groups}
        onClose={jest.fn()}
      />,
    );
    await user.type(field("Phone"), "+1 555 0100");
    rerender(
      <PersonPanel
        participant={person({ id: "12", name: "Grace Hopper" })}
        groups={groups}
        onClose={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "Grace Hopper" }),
    ).toBeInTheDocument();
    expect(field("Phone")).toHaveValue("");
  });

  test("leaves Escape to a dialog the parent has open above the panel", async () => {
    const handlers = renderPanel(person(), { dialogOpen: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Ada Lovelace" }),
    ).toBeInTheDocument();
  });
});
