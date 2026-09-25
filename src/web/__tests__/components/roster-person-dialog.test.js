/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import RosterPersonDialog, {
  detailsEditable,
  nameEditable,
} from "@/components/schedule/RosterPersonDialog";

function person(overrides = {}) {
  return {
    id: "p-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organizerManaged: false,
    isOrganizer: false,
    canOrganizerEditAvailability: true,
    canOrganizerEditEmail: true,
    ...overrides,
  };
}

function renderDialog(participant = person(), props = {}) {
  const onSave = jest.fn();
  const onClose = jest.fn();
  render(
    <RosterPersonDialog
      participant={participant}
      onSave={onSave}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSave, onClose };
}

const nameInput = () => screen.getByLabelText(/Full name/);
const emailInput = () => screen.getByLabelText(/Email address/);
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));

describe("roster person editing rules", () => {
  test("renames everyone the organizer still answers for", () => {
    expect(nameEditable(person())).toBe(true);
    expect(
      nameEditable(
        person({ organizerManaged: true, canOrganizerEditAvailability: false }),
      ),
    ).toBe(true);
    expect(nameEditable(person({ canOrganizerEditAvailability: false }))).toBe(
      false,
    );
    expect(nameEditable(person({ isOrganizer: true }))).toBe(false);
  });

  test("offers the dialog while a name or the email can still change", () => {
    expect(detailsEditable(person())).toBe(true);
    expect(
      detailsEditable(
        person({
          canOrganizerEditAvailability: false,
          canOrganizerEditEmail: true,
        }),
      ),
    ).toBe(true);
    expect(
      detailsEditable(
        person({
          canOrganizerEditAvailability: false,
          canOrganizerEditEmail: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("RosterPersonDialog", () => {
  test("sends only the fields that changed", () => {
    const { onSave } = renderDialog();
    expect(
      screen.getByRole("dialog", { name: "Edit Ada Lovelace" }),
    ).toBeInTheDocument();
    expect(nameInput()).toHaveValue("Ada Lovelace");
    expect(emailInput()).toHaveValue("ada@example.com");
    expect(
      screen.getByText(
        "A new address gets a fresh invitation that is not sent until you send it.",
      ),
    ).toBeInTheDocument();

    save();
    expect(onSave).toHaveBeenLastCalledWith({});

    fireEvent.change(nameInput(), { target: { value: "  Ada King " } });
    save();
    expect(onSave).toHaveBeenLastCalledWith({ name: "Ada King" });

    fireEvent.change(emailInput(), { target: { value: " ADA@Work.example " } });
    save();
    expect(onSave).toHaveBeenLastCalledWith({
      name: "Ada King",
      email: "ada@work.example",
    });
  });

  test("validates the name and the email before saving", () => {
    const { onSave } = renderDialog();
    fireEvent.change(nameInput(), { target: { value: "  " } });
    fireEvent.change(emailInput(), { target: { value: "" } });
    save();
    expect(screen.getByText("Full name is required.")).toBeInTheDocument();
    expect(screen.getByText("Email address is required.")).toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(nameInput(), { target: { value: "x".repeat(101) } });
    expect(
      screen.queryByText("Full name is required."),
    ).not.toBeInTheDocument();
    fireEvent.change(emailInput(), { target: { value: "not-an-address" } });
    expect(
      screen.queryByText("Email address is required."),
    ).not.toBeInTheDocument();
    save();
    expect(
      screen.getByText("Full name must be 100 characters or fewer."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter a valid email address."),
    ).toBeInTheDocument();

    fireEvent.change(nameInput(), { target: { value: "Ada" } });
    fireEvent.change(emailInput(), {
      target: { value: `${"a".repeat(250)}@example.com` },
    });
    save();
    expect(
      screen.getByText("Email address must be 254 characters or fewer."),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  test("gives a person with no email of their own an address, or leaves it blank", () => {
    const { onSave } = renderDialog(
      person({
        name: "Grandma",
        email: "organizer@example.com",
        organizerManaged: true,
      }),
    );
    // The organizer's filing address is not theirs to show.
    expect(emailInput()).toHaveValue("");
    expect(emailInput()).toHaveAttribute("placeholder", "No email");
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "They have no email of their own yet. Add one to invite them later; their schedule stays as you entered it.",
      ),
    ).toBeInTheDocument();

    save();
    expect(onSave).toHaveBeenLastCalledWith({});

    fireEvent.change(emailInput(), {
      target: { value: "grandma@example.com" },
    });
    save();
    expect(onSave).toHaveBeenLastCalledWith({ email: "grandma@example.com" });
  });

  test("explains why a field cannot change", () => {
    const { onSave } = renderDialog(
      person({
        canOrganizerEditAvailability: false,
        canOrganizerEditEmail: false,
      }),
    );
    expect(nameInput()).toBeDisabled();
    expect(emailInput()).toBeDisabled();
    expect(
      screen.getByText("They set their own name in their Releviz account."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "They have already signed in or answered, so their address can no longer be changed. Remove them and add them again if it is wrong.",
      ),
    ).toBeInTheDocument();
    save();
    expect(onSave).toHaveBeenLastCalledWith({});
  });

  test("keeps the organizer's own name and address with their account", () => {
    renderDialog(
      person({
        name: "Olive Organizer",
        isOrganizer: true,
        canOrganizerEditAvailability: false,
        canOrganizerEditEmail: false,
      }),
    );
    expect(
      screen.getByText("Your name comes from your account settings."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your own address comes from your account settings."),
    ).toBeInTheDocument();
  });

  test("renames someone whose address is locked", () => {
    const { onSave } = renderDialog(person({ canOrganizerEditEmail: false }));
    expect(nameInput()).toBeEnabled();
    expect(emailInput()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: "Ada B." } });
    save();
    expect(onSave).toHaveBeenLastCalledWith({ name: "Ada B." });
  });

  test("shows the save error and locks the form while saving", () => {
    const { onClose } = renderDialog(person(), {
      busy: true,
      error: "ada@example.com is already on this roster.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "ada@example.com is already on this roster.",
    );
    expect(nameInput()).toBeDisabled();
    expect(emailInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("closes from Cancel", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
