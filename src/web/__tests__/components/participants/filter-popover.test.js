/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import {
  FilterButton,
  FilterChips,
} from "@/components/schedule/participants/FilterPopover";

const filterButton = () => screen.getByRole("button", { name: /^Filter/ });

describe("FilterButton", () => {
  test("opens three radio groups wired to the API values", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<FilterButton value={{}} onChange={onChange} />);
    expect(filterButton()).toHaveAttribute("aria-expanded", "false");
    expect(filterButton()).toHaveTextContent(/^Filter$/);

    await user.click(filterButton());
    expect(filterButton()).toHaveAttribute("aria-expanded", "true");
    const groups = screen.getAllByRole("group");
    expect(
      groups.map((group) => group.querySelector("legend").textContent),
    ).toEqual(["Response", "Invitation", "Results"]);
    expect(
      within(groups[1])
        .getAllByRole("radio")
        .map((radio) => radio.value),
    ).toEqual(["", "not_sent", "queued", "failed", "sent", "accepted"]);
    expect(within(groups[0]).getByRole("radio", { name: "Any" })).toBeChecked();

    await user.click(
      within(groups[0]).getByRole("radio", { name: "Not submitted" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      submitted: "false",
      invitationStatus: "",
      included: "",
    });
    await user.click(within(groups[1]).getByRole("radio", { name: "Failed" }));
    expect(onChange).toHaveBeenLastCalledWith({
      submitted: "",
      invitationStatus: "failed",
      included: "",
    });
    await user.click(
      within(groups[2]).getByRole("radio", { name: "Left out" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      submitted: "",
      invitationStatus: "",
      included: "false",
    });
    // The popover stays open for more choices.
    expect(screen.getAllByRole("group")).toHaveLength(3);
  });

  test("counts active filters and reflects the current value", async () => {
    const user = userEvent.setup();
    render(
      <FilterButton
        value={{ submitted: "true", invitationStatus: "", included: "true" }}
        onChange={jest.fn()}
      />,
    );
    expect(filterButton()).toHaveTextContent("Filter2 active");
    await user.click(filterButton());
    expect(screen.getByRole("radio", { name: "Submitted" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Counted" })).toBeChecked();
  });

  test("closes on Escape (refocusing the button) and on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <FilterButton value={{}} onChange={jest.fn()} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    await user.click(filterButton());
    fireEvent.keyDown(screen.getByRole("radio", { name: "Failed" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("group")).toBeNull();
    expect(filterButton()).toHaveFocus();

    await user.click(filterButton());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("group")).toBeNull();
  });

  test("can be disabled", () => {
    render(<FilterButton value={{}} onChange={jest.fn()} disabled />);
    expect(filterButton()).toBeDisabled();
  });
});

describe("FilterChips", () => {
  test("renders nothing without chips", () => {
    const { container } = render(
      <FilterChips chips={[]} onRemove={jest.fn()} onClearAll={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("each chip removes its filter and Clear all clears them", async () => {
    const user = userEvent.setup();
    const onRemove = jest.fn();
    const onClearAll = jest.fn();
    render(
      <FilterChips
        chips={[
          { key: "submitted", label: "Response: Not submitted" },
          { key: "group", label: "Group: Design" },
        ]}
        onRemove={onRemove}
        onClearAll={onClearAll}
      />,
    );
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(list).toHaveClass("participants-chips");
    await user.click(
      screen.getByRole("button", { name: "Remove filter Group: Design" }),
    );
    expect(onRemove).toHaveBeenCalledWith("group");
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
