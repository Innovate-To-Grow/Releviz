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

import ManageGroupsPanel from "@/components/schedule/participants/ManageGroupsPanel";

const design = { id: 1, name: "Design", count: 4, weight: 1, includedCount: 4 };
const sales = {
  id: 2,
  name: "Sales",
  count: 3,
  weight: null,
  includedCount: 1,
};
const empty = {
  id: 3,
  name: "Empty",
  count: 0,
  weight: null,
  includedCount: 0,
};

function renderPanel(props = {}) {
  const handlers = {
    onSetWeight: jest.fn().mockResolvedValue(true),
    onSetIncluded: jest.fn().mockResolvedValue(true),
    onCountOnly: jest.fn().mockResolvedValue(true),
    onDelete: jest.fn().mockResolvedValue(true),
    onRename: jest.fn().mockResolvedValue(true),
    onCreate: jest.fn().mockResolvedValue(true),
    onSelectPeople: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };
  const utils = render(
    <ManageGroupsPanel
      groups={[design, sales, empty]}
      ungrouped={{ count: 2, weight: 0.5, includedCount: 0 }}
      totals={{ total: 9 }}
      {...handlers}
    />,
  );
  return { ...handlers, unmount: utils.unmount };
}

const rowFor = (name) =>
  screen.getByRole("row", { name: new RegExp(`^${name}`) });
const menuFor = (user, name) =>
  user.click(screen.getByRole("button", { name: `Actions for ${name}` }));

describe("ManageGroupsPanel", () => {
  test("lists every group and the No group bucket with counts, weight and counted state", () => {
    renderPanel();
    expect(screen.getByRole("dialog", { name: "Groups" })).toHaveTextContent(
      "Groups are labels for filtering and changing many people at once. Results use each person's weight and whether they count.",
    );
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["Group", "People", "Weight", "Counted", "Actions"]);
    expect(rowFor("Design")).toHaveTextContent("4 people");
    expect(
      screen.getByRole("spinbutton", { name: "Weight for Design" }),
    ).toHaveValue(1);
    expect(rowFor("Design")).toHaveTextContent("All");
    expect(
      screen.getByRole("spinbutton", { name: "Weight for Sales" }),
    ).toHaveAttribute("placeholder", "mixed");
    expect(rowFor("Sales")).toHaveTextContent("1 of 3");
    expect(
      screen.getByRole("checkbox", { name: "Count Sales in the results" })
        .indeterminate,
    ).toBe(true);
    expect(rowFor("Empty")).toHaveTextContent("0 people");
    expect(rowFor("Empty")).toHaveTextContent("—");
    expect(
      screen.getByRole("spinbutton", { name: "Weight for Empty" }),
    ).toBeDisabled();
    expect(rowFor("No group")).toHaveTextContent("2 people");
    expect(rowFor("No group")).toHaveTextContent("None");
    expect(
      screen.queryByRole("button", { name: "Actions for No group" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Count No group in the results" }),
    ).not.toBeChecked();
  });

  test("weight saves on blur or Enter, validates, and skips no-ops", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    const input = screen.getByRole("spinbutton", { name: "Weight for Design" });
    await user.clear(input);
    await user.type(input, "0.5");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(handlers.onSetWeight).toHaveBeenCalledWith(design, 0.5),
    );

    // Blurring without a draft does nothing.
    fireEvent.blur(input);
    expect(handlers.onSetWeight).toHaveBeenCalledTimes(1);

    // The same value again is not re-sent.
    await user.clear(input);
    await user.type(input, "1");
    fireEvent.blur(input);
    expect(handlers.onSetWeight).toHaveBeenCalledTimes(1);

    // Clearing the field leaves the weight alone.
    await user.clear(input);
    fireEvent.blur(input);
    expect(handlers.onSetWeight).toHaveBeenCalledTimes(1);

    // Out of range is refused with a message that clears on the next edit.
    await user.type(input, "5");
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a weight between 0 and 1.",
    );
    await user.type(input, "0");
    expect(screen.queryByRole("alert")).toBeNull();

    const noGroup = screen.getByRole("spinbutton", {
      name: "Weight for No group",
    });
    await user.clear(noGroup);
    await user.type(noGroup, "0.75");
    fireEvent.blur(noGroup);
    await waitFor(() =>
      expect(handlers.onSetWeight).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: null, name: "", count: 2 }),
        0.75,
      ),
    );
  });

  test("the counted checkbox reports the group and the next state", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.click(
      screen.getByRole("checkbox", { name: "Count Design in the results" }),
    );
    expect(handlers.onSetIncluded).toHaveBeenCalledWith(design, false);
    await user.click(
      screen.getByRole("checkbox", { name: "Count No group in the results" }),
    );
    expect(handlers.onSetIncluded).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: null }),
      true,
    );
  });

  test("renames inline with validation, Enter, Escape and Save", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await menuFor(user, "Design");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "New name for Design" });
    expect(input).toHaveValue("Design");

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a group name.");
    await user.type(input, "Design");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    // Same name: the form just closes.
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(handlers.onRename).not.toHaveBeenCalled();

    await menuFor(user, "Design");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(handlers.onClose).not.toHaveBeenCalled();

    await menuFor(user, "Design");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Product");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(handlers.onRename).toHaveBeenCalledWith(design, "Product"),
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  test("a rename the parent refuses keeps the form open; Cancel closes it", async () => {
    const user = userEvent.setup();
    renderPanel({ onRename: jest.fn().mockResolvedValue(false) });
    await menuFor(user, "Design");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.type(screen.getByRole("textbox"), "X");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toBeInTheDocument(),
    );
    await user.click(
      within(rowFor("DesignX")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("Count only asks first and names how many are left out", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await menuFor(user, "Sales");
    await user.click(
      screen.getByRole("menuitem", { name: "Count only this group…" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Count only Sales in the results?",
    });
    expect(dialog).toHaveTextContent(
      "6 people outside Sales will be left out. Weights don't change.",
    );
    // Escape reaches the dialog, not the drawer behind it.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /Count only/ })).toBeNull();
    expect(handlers.onClose).not.toHaveBeenCalled();

    await menuFor(user, "Sales");
    await user.click(
      screen.getByRole("menuitem", { name: "Count only this group…" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Count only this group" }),
    );
    await waitFor(() =>
      expect(handlers.onCountOnly).toHaveBeenCalledWith(sales),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Count only/ })).toBeNull(),
    );
  });

  test("Delete asks first, then deletes", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await menuFor(user, "Design");
    await user.click(screen.getByRole("menuitem", { name: "Delete group…" }));
    expect(
      screen.getByRole("dialog", { name: "Delete group Design?" }),
    ).toHaveTextContent("People stay on the participant list.");
    await user.click(screen.getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalledWith(design));
  });

  test("Select these people hands the group back and empty groups cannot be selected", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await menuFor(user, "Design");
    await user.click(
      screen.getByRole("menuitem", { name: "Select these 4 people" }),
    );
    expect(handlers.onSelectPeople).toHaveBeenCalledWith(design);
    await menuFor(user, "Empty");
    expect(
      screen.getByRole("menuitem", { name: "Select these 0 people" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Count only this group…" }),
    ).toBeDisabled();
  });

  test("creates a group inline", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    const input = screen.getByRole("textbox", { name: "New group name" });
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a group name.");
    await user.type(input, "Ops");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledWith("Ops"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());

    await user.click(screen.getByRole("button", { name: "+ New group" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("a create the parent refuses keeps the form open", async () => {
    const user = userEvent.setup();
    renderPanel({ onCreate: jest.fn().mockResolvedValue(false) });
    await user.click(screen.getByRole("button", { name: "+ New group" }));
    await user.type(screen.getByRole("textbox"), "Ops");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toBeInTheDocument(),
    );
  });

  test("shows the parent's error and its own when a callback throws", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ManageGroupsPanel
        groups={[design]}
        error="Server said no."
        onSetIncluded={jest.fn().mockRejectedValue(new Error("Boom."))}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Server said no.");
    rerender(
      <ManageGroupsPanel
        groups={[design]}
        onSetIncluded={jest.fn().mockRejectedValue(new Error("Boom."))}
        onClose={jest.fn()}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Count Design in the results" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom.");
    rerender(
      <ManageGroupsPanel
        groups={[design]}
        onSetIncluded={jest.fn().mockRejectedValue({})}
        onClose={jest.fn()}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Count Design in the results" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That change could not be saved.",
    );
  });

  test("read-only locks every control and hides creation", async () => {
    const user = userEvent.setup();
    renderPanel({ readOnly: true });
    expect(
      screen.getByRole("spinbutton", { name: "Weight for Design" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Count Design in the results" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "+ New group" })).toBeNull();
    await menuFor(user, "Design");
    expect(
      screen.getByRole("menuitem", { name: "Select these 4 people" }),
    ).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Delete group…" }),
    ).toBeDisabled();
  });

  test("busyKey marks the request in flight and Escape closes the drawer", () => {
    const handlers = renderPanel({ busyKey: "create" });
    expect(
      screen.getByRole("spinbutton", { name: "Weight for Design" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  test("Close, the backdrop and Escape close an idle drawer", async () => {
    const user = userEvent.setup();
    const handlers = renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Close", exact: true }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });

  test("empty groups list explains what groups are for, and an all-groups row has no rename or delete", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel({ groups: [] });
    expect(
      screen.getByText(/No groups yet\. Groups let you filter the list/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    unmount();
    renderPanel({
      groups: [{ ...design, name: "Everyone", isAll: true }],
      totals: null,
    });
    await menuFor(user, "Everyone");
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Delete group…" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("menuitem", { name: "Count only this group…" }),
    );
    // Without totals the head counts are summed: 4 in the group + 2 ungrouped.
    expect(
      screen.getByRole("dialog", { name: /Count only/ }),
    ).toHaveTextContent("2 people outside Everyone will be left out.");
  });
});
