/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import ParticipantRow from "@/components/schedule/participants/ParticipantRow";

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
    version: 1,
    ...overrides,
  };
}

function renderRow(participant = person(), props = {}) {
  const handlers = {
    onToggleSelect: jest.fn(),
    onOpen: jest.fn(),
    onEditSchedule: jest.fn(),
    onSendInvitation: jest.fn(),
    onToggleIncluded: jest.fn(),
    onRemove: jest.fn(),
    onApplyAgain: jest.fn(),
    onDismissConflict: jest.fn(),
  };
  render(
    <table>
      <tbody>
        <ParticipantRow participant={participant} {...handlers} {...props} />
      </tbody>
    </table>,
  );
  return handlers;
}

const row = () => screen.getAllByRole("row")[0];
const openMenu = (user, name = "Ada Lovelace") =>
  user.click(screen.getByRole("button", { name: `Actions for ${name}` }));

describe("ParticipantRow", () => {
  test("shows the contact line, groups, badges and every action", async () => {
    const user = userEvent.setup();
    const p = person({ phone: "+1 555 0100", submitted: true });
    const handlers = renderRow(p);

    expect(row()).toHaveAttribute("data-roster-participant-id", "11");
    await user.click(
      screen.getByRole("checkbox", { name: "Select Ada Lovelace" }),
    );
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("11", true);

    const nameButton = screen.getByRole("button", { name: /^Ada Lovelace/ });
    expect(nameButton).toHaveTextContent("ada@example.com · +1 555 0100");
    await user.click(nameButton);
    expect(handlers.onOpen).toHaveBeenCalledWith(p);

    const cells = within(row()).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("Design");
    expect(screen.getByText("Submitted")).toHaveClass("status-badge");
    expect(screen.getByText("Not sent")).toHaveClass("status-badge");

    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    expect(handlers.onEditSchedule).toHaveBeenCalledWith(p);

    await openMenu(user);
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Details",
      "Send invitation",
      "Leave out of results",
      "Remove from event…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(handlers.onOpen).toHaveBeenCalledTimes(2);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Send invitation" }));
    expect(handlers.onSendInvitation).toHaveBeenCalledWith(p);
    await openMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    );
    expect(handlers.onToggleIncluded).toHaveBeenCalledWith(p);
    await openMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from event…" }),
    );
    expect(handlers.onRemove).toHaveBeenCalledWith(p);
  });

  test("never shows the filing address of someone with no email of their own", async () => {
    const user = userEvent.setup();
    renderRow(
      person({
        organizerManaged: true,
        email: "organizer@example.com",
        groups: [],
      }),
    );
    expect(row()).not.toHaveTextContent("organizer@example.com");
    expect(
      screen.getByRole("button", { name: /^Ada Lovelace/ }),
    ).toHaveTextContent("No email · you enter their schedule");
    const badge = screen.getByText("No email", { selector: ".status-badge" });
    expect(badge.querySelector(".status-badge__dot")).toBeNull();
    expect(screen.getByText("No group")).toHaveClass("visually-hidden");
    await openMenu(user);
    expect(screen.queryByRole("menuitem", { name: /invitation/ })).toBeNull();
  });

  test("marks the organizer's own row", async () => {
    const user = userEvent.setup();
    const handlers = renderRow(
      person({ isOrganizer: true, allGroups: true, groups: [] }),
    );
    expect(
      screen.getByRole("button", { name: /^Ada Lovelace \(you\)/ }),
    ).toHaveTextContent("From your account");
    expect(within(row()).getAllByRole("cell")[1]).toHaveTextContent(
      "Every group",
    );
    expect(screen.getByText("—")).toHaveClass("status-badge");
    await user.click(screen.getByRole("button", { name: "Edit my schedule" }));
    expect(handlers.onEditSchedule).toHaveBeenCalled();
    await openMenu(user);
    expect(screen.queryByRole("menuitem", { name: /invitation/ })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Remove from event…" }),
    ).toBeEnabled();
  });

  test("a person answering with their own account has no schedule button", async () => {
    const user = userEvent.setup();
    renderRow(
      person({
        accountAccess: "full",
        canOrganizerEditAvailability: false,
        invitationStatus: "accepted",
        included: false,
        weight: 0.5,
      }),
    );
    const note = screen.getByText("Answers themselves");
    expect(note).toHaveAttribute(
      "title",
      "Ada Lovelace answered with their own account, so only they can change it.",
    );
    expect(screen.queryByRole("button", { name: /Edit schedule/ })).toBeNull();
    expect(screen.getByText("Weight 0.5")).toHaveClass("participants-tag");
    expect(screen.getByText("Left out of results")).toHaveClass(
      "participants-tag",
    );
    expect(screen.getByText("Accepted")).toHaveClass("status-badge");
    await openMenu(user);
    expect(
      screen.getByRole("menuitem", { name: "Resend invitation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Count in results" }),
    ).toBeInTheDocument();
  });

  test("shows delivery states and a queued badge", () => {
    const { unmount } = render(
      <table>
        <tbody>
          <ParticipantRow
            participant={person({ invitationDelivery: "failed" })}
          />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Failed")).toHaveClass("bg-danger-subtle");
    unmount();
    render(
      <table>
        <tbody>
          <ParticipantRow
            participant={person({
              invitationDelivery: "queued",
              invitationStatus: "sent",
            })}
          />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Sending…")).toHaveClass("bg-info-subtle");
  });

  test("read-only rows keep the details but disable every change", async () => {
    const user = userEvent.setup();
    renderRow(person(), { readOnly: true, selected: true });
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(row()).toHaveClass("participants-row--selected");
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Details" })).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Send invitation" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Leave out of results" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Remove from event…" }),
    ).toBeDisabled();
  });

  test("hides the checkbox when not selectable and spans the conflict notice", async () => {
    const user = userEvent.setup();
    const p = person();
    const handlers = renderRow(p, {
      selectable: false,
      conflict: { message: "Ada Lovelace was changed in another session." },
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveClass("participants-row__notice");
    expect(within(rows[1]).getByRole("cell")).toHaveAttribute("colspan", "5");
    expect(rows[1]).toHaveTextContent(
      "Ada Lovelace was changed in another session.",
    );
    await user.click(screen.getByRole("button", { name: "Apply again" }));
    expect(handlers.onApplyAgain).toHaveBeenCalledWith(p);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(handlers.onDismissConflict).toHaveBeenCalledWith(p);
  });

  test("a conflict row with the select column spans six cells", () => {
    renderRow(person(), { conflict: { message: "Changed elsewhere." } });
    expect(
      within(screen.getAllByRole("row")[1]).getByRole("cell"),
    ).toHaveAttribute("colspan", "6");
  });

  test.each([
    ["with the selection column", {}, 5],
    ["without the selection column", { selectable: false }, 4],
  ])("every row part has an explicit role %s", (_label, props, cellsInRow) => {
    renderRow(person(), {
      conflict: { message: "Changed elsewhere." },
      ...props,
    });
    const [personRow, noticeRow] = screen.getAllByRole("row");
    expect(personRow).toHaveAttribute("role", "row");
    expect(noticeRow).toHaveAttribute("role", "row");
    expect(personRow.querySelectorAll('td[role="cell"]')).toHaveLength(
      cellsInRow,
    );
    expect(personRow.querySelectorAll("td:not([role])")).toHaveLength(0);
    expect(within(personRow).getByRole("rowheader")).toHaveAttribute(
      "role",
      "rowheader",
    );
    expect(noticeRow.querySelector("td")).toHaveAttribute("role", "cell");
  });

  test("works without any handlers", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ParticipantRow participant={person({ groups: undefined })} />
        </tbody>
      </table>,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /^Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(screen.getByText("No group")).toBeInTheDocument();
  });
});
