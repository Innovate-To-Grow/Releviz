/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import AddPersonPanel from "@/components/schedule/participants/AddPersonPanel";

function added({ participant = {}, ...overrides } = {}) {
  return {
    participant: {
      id: "21",
      name: "Grace Hopper",
      email: "grace@example.com",
      organizerManaged: false,
      invitationStatus: "not_sent",
      ...participant,
    },
    alreadyExisted: false,
    autoInvited: false,
    ...overrides,
  };
}

function renderPanel(props = {}) {
  const handlers = {
    onAdd: jest.fn().mockResolvedValue(added()),
    onOpenPerson: jest.fn(),
    onEnterSchedule: jest.fn(),
    onAddMyself: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };
  const utils = render(
    <AddPersonPanel organizerEmail="org@example.com" {...handlers} />,
  );
  return { ...handlers, ...utils };
}

const name = () => screen.getByLabelText(/^Full name/);
const email = () => screen.getByLabelText(/^Email/);
const phone = () => screen.getByLabelText(/^Phone/);
const add = () => screen.getByRole("button", { name: "Add" });
const noEmail = () =>
  screen.getByRole("checkbox", {
    name: "They have no email. I'll enter their schedule.",
  });

let uuids;

beforeEach(() => {
  uuids = ["key-1", "key-2", "key-3"];
  if (!globalThis.crypto) globalThis.crypto = {};
  if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = () => "";
  jest
    .spyOn(globalThis.crypto, "randomUUID")
    .mockImplementation(() => uuids.shift());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AddPersonPanel", () => {
  test("adds a person, reports it, clears the form and refocuses Full name", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    expect(
      screen.getByRole("dialog", { name: "Add a person" }),
    ).toBeInTheDocument();
    expect(name()).toHaveFocus();
    expect(noEmail()).toHaveAccessibleDescription(
      "Blank = filed under org@example.com. They are never emailed.",
    );

    await user.type(name(), " Grace Hopper ");
    await user.type(email(), "Grace@Example.com");
    await user.type(phone(), "+1 555 0100");
    await user.click(add());
    await waitFor(() =>
      expect(handlers.onAdd).toHaveBeenCalledWith({
        name: "Grace Hopper",
        email: "grace@example.com",
        phone: "+1 555 0100",
        organizerManaged: false,
        sendInvitation: false,
        idempotencyKey: "key-1",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Grace Hopper was added. No invitation was sent.",
    );
    expect(name()).toHaveValue("");
    expect(email()).toHaveValue("");
    expect(phone()).toHaveValue("");
    expect(name()).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(handlers.onOpenPerson).toHaveBeenCalledWith(
      expect.objectContaining({ id: "21" }),
    );
  });

  test("Enter submits and Add and send invitation asks for an invitation", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel({
      onAdd: jest.fn().mockResolvedValue(added({ autoInvited: true })),
    });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com{Enter}");
    await waitFor(() => expect(handlers.onAdd).toHaveBeenCalledTimes(1));
    expect(handlers.onAdd.mock.calls[0][0].sendInvitation).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Grace Hopper was added and their invitation is queued.",
    );

    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(
      screen.getByRole("button", { name: "Add and send invitation" }),
    );
    await waitFor(() => expect(handlers.onAdd).toHaveBeenCalledTimes(2));
    expect(handlers.onAdd.mock.calls[1][0]).toMatchObject({
      sendInvitation: true,
      idempotencyKey: "key-2",
    });
  });

  test("validates name, email and phone, focusing the first problem", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.click(add());
    expect(
      screen.getAllByRole("alert").map((alert) => alert.textContent),
    ).toEqual(["Full name is required.", "Email address is required."]);
    expect(name()).toHaveFocus();
    expect(handlers.onAdd).not.toHaveBeenCalled();

    await user.type(name(), "Grace");
    await user.type(email(), "nope");
    await user.click(add());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid email address.",
    );
    expect(email()).toHaveFocus();

    await user.clear(email());
    await user.type(email(), "grace@example.com");
    await user.type(phone(), "12");
    await user.click(add());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a phone number with 7 to 32 digits.",
    );
    expect(phone()).toHaveFocus();
    expect(handlers.onAdd).not.toHaveBeenCalled();
  });

  test("no-email mode hides the email field and files the person under the organizer", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel({
      onAdd: jest
        .fn()
        .mockResolvedValue(added({ participant: { organizerManaged: true } })),
    });
    await user.click(noEmail());
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add and send invitation" }),
    ).toBeNull();
    await user.type(name(), "Grace");
    await user.click(add());
    await waitFor(() =>
      expect(handlers.onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "",
          organizerManaged: true,
          sendInvitation: false,
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Grace Hopper was added.",
    );
    await user.click(
      screen.getByRole("button", { name: "Enter their schedule" }),
    );
    expect(handlers.onEnterSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ organizerManaged: true }),
    );
    // Leaving no-email mode brings the email field back.
    await user.click(noEmail());
    expect(email()).toBeInTheDocument();
  });

  test("an existing person is reported with Open and, when uninvited, Send invitation", async () => {
    const user = userEvent.setup();
    const onSendInvitation = jest.fn();
    const handlers = renderPanel({
      onAdd: jest.fn().mockResolvedValue(added({ alreadyExisted: true })),
      onSendInvitation,
    });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(add());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Grace Hopper is already on the list, so nothing was added.",
    );
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(onSendInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "21" }),
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(handlers.onOpenPerson).toHaveBeenCalled();
  });

  test("an already-invited existing person only offers Open", async () => {
    const user = userEvent.setup();
    renderPanel({
      onAdd: jest.fn().mockResolvedValue(
        added({
          alreadyExisted: true,
          participant: { invitationStatus: "sent" },
        }),
      ),
      onSendInvitation: jest.fn(),
    });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(add());
    await screen.findByRole("status");
    expect(
      screen.queryByRole("button", { name: "Send invitation" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });

  test("keeps the typed values and the key on failure, and renews the key after an edit", async () => {
    const user = userEvent.setup();
    const onAdd = jest
      .fn()
      .mockRejectedValueOnce(new Error("Server busy."))
      .mockRejectedValueOnce({})
      .mockResolvedValue(added());
    renderPanel({ onAdd });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(add());
    expect(await screen.findByRole("alert")).toHaveTextContent("Server busy.");
    expect(name()).toHaveValue("Grace");
    expect(onAdd.mock.calls[0][0].idempotencyKey).toBe("key-1");

    await user.click(add());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The person could not be added.",
    );
    expect(onAdd.mock.calls[1][0].idempotencyKey).toBe("key-1");

    await user.type(phone(), "+1 555 0100");
    await user.click(add());
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(3));
    expect(onAdd.mock.calls[2][0].idempotencyKey).toBe("key-2");
  });

  test("reports a person whose result carries no participant", async () => {
    const user = userEvent.setup();
    renderPanel({
      onAdd: jest.fn().mockResolvedValue({ alreadyExisted: true }),
    });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(add());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "They is already on the list, so nothing was added.",
    );
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  test("Done closes, Add myself is offered when available, and read-only locks the form", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel({ addMyselfAvailable: true });
    await user.click(screen.getByRole("button", { name: "Add myself" }));
    expect(handlers.onAddMyself).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    const { unmount } = handlers;
    unmount();
    renderPanel({ readOnly: true, organizerEmail: "" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "This event is not taking changes right now, so nobody can be added.",
    );
    expect(name()).toBeDisabled();
    expect(add()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add myself" })).toBeNull();
    expect(noEmail()).toHaveAccessibleDescription(
      "Blank = filed under your account email. They are never emailed.",
    );
    fireEvent.submit(name().closest("form"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("leaves Escape to a dialog stacked above it", () => {
    const onClose = jest.fn();
    const { rerender } = renderPanel({ onClose, dialogOpen: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <AddPersonPanel onAdd={jest.fn()} onClose={onClose} dialogOpen={false} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("disables the buttons while an add is in flight", async () => {
    const user = userEvent.setup();
    let resolveAdd;
    renderPanel({
      onAdd: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveAdd = resolve;
          }),
      ),
    });
    await user.type(name(), "Grace");
    await user.type(email(), "grace@example.com");
    await user.click(add());
    expect(add()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add and send invitation" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    resolveAdd(added());
    await screen.findByRole("status");
    expect(add()).toBeEnabled();
  });
});
