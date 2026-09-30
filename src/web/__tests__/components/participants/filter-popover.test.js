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
  test("opens two radio groups wired to the API values", async () => {
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
    ).toEqual(["Response", "Results"]);
    expect(screen.queryByRole("group", { name: "Invitation" })).toBeNull();
    expect(
      within(groups[0])
        .getAllByRole("radio")
        .map((radio) => [radio.value, radio.labels[0].textContent]),
    ).toEqual([
      ["", "Any"],
      ["submitted", "Submitted"],
      ["not_submitted", "Not submitted"],
      ["not_invited", "Not invited yet"],
      ["sending", "Sending invite"],
      ["failed", "Invite failed"],
      ["invited", "Invited"],
      ["started", "Started"],
    ]);
    expect(within(groups[0]).getByRole("radio", { name: "Any" })).toBeChecked();
    expect(within(groups[1]).getByRole("radio", { name: "Any" })).toBeChecked();

    await user.click(
      within(groups[0]).getByRole("radio", { name: "Not submitted" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      submitted: "false",
      invitationStatus: "",
      included: "",
    });
    await user.click(
      within(groups[0]).getByRole("radio", { name: "Invite failed" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      submitted: "",
      invitationStatus: "failed",
      included: "",
    });
    await user.click(
      within(groups[1]).getByRole("radio", { name: "Left out" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      submitted: "",
      invitationStatus: "",
      included: "false",
    });
    // The popover stays open for more choices.
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  test.each([
    ["Any", { submitted: "", invitationStatus: "" }],
    ["Submitted", { submitted: "true", invitationStatus: "" }],
    ["Not submitted", { submitted: "false", invitationStatus: "" }],
    ["Not invited yet", { submitted: "false", invitationStatus: "not_sent" }],
    ["Sending invite", { submitted: "", invitationStatus: "queued" }],
    ["Invite failed", { submitted: "", invitationStatus: "failed" }],
    ["Invited", { submitted: "false", invitationStatus: "sent" }],
    ["Started", { submitted: "false", invitationStatus: "accepted" }],
  ])(
    "choosing Response %s sets both parameters and keeps Results",
    async (label, params) => {
      const user = userEvent.setup();
      const onChange = jest.fn();
      // Re-clicking the checked radio is no change, so start from another.
      const start =
        label === "Any"
          ? { submitted: "true", invitationStatus: "" }
          : { submitted: "", invitationStatus: "" };
      render(
        <FilterButton
          value={{ ...start, included: "false" }}
          onChange={onChange}
        />,
      );
      await user.click(filterButton());
      const response = screen.getByRole("group", { name: "Response" });
      await user.click(within(response).getByRole("radio", { name: label }));
      expect(onChange).toHaveBeenLastCalledWith({
        ...params,
        included: "false",
      });
    },
  );

  test("the Response group is single choice and reflects the parameters", async () => {
    const user = userEvent.setup();
    const checkedResponse = () =>
      within(screen.getByRole("group", { name: "Response" }))
        .getAllByRole("radio")
        .filter((radio) => radio.checked)
        .map((radio) => radio.labels[0].textContent);
    const { rerender } = render(
      <FilterButton
        value={{ submitted: "false", invitationStatus: "sent", included: "" }}
        onChange={jest.fn()}
      />,
    );
    await user.click(filterButton());
    expect(checkedResponse()).toEqual(["Invited"]);
    rerender(
      <FilterButton
        value={{ submitted: "true", invitationStatus: "failed", included: "" }}
        onChange={jest.fn()}
      />,
    );
    expect(checkedResponse()).toEqual(["Invite failed"]);
    rerender(
      <FilterButton
        value={{ submitted: "", invitationStatus: "queued", included: "" }}
        onChange={jest.fn()}
      />,
    );
    expect(checkedResponse()).toEqual(["Sending invite"]);
    rerender(
      <FilterButton
        value={{ submitted: "false", invitationStatus: "", included: "" }}
        onChange={jest.fn()}
      />,
    );
    expect(checkedResponse()).toEqual(["Not submitted"]);
  });

  test("every radio has a unique id and a label, and each group shares one name", async () => {
    const user = userEvent.setup();
    render(<FilterButton value={{}} onChange={jest.fn()} />);
    await user.click(filterButton());
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(11);
    expect(new Set(radios.map((radio) => radio.id)).size).toBe(11);
    radios.forEach((radio) => expect(radio.labels).toHaveLength(1));
    ["Response", "Results"].forEach((legend) => {
      const inGroup = within(
        screen.getByRole("group", { name: legend }),
      ).getAllByRole("radio");
      expect(new Set(inGroup.map((radio) => radio.name)).size).toBe(1);
    });
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(2);
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

  test.each([
    [{}, /^Filter$/],
    [{ submitted: "false", invitationStatus: "not_sent" }, "Filter1 active"],
    [{ submitted: "false", invitationStatus: "accepted" }, "Filter1 active"],
    [{ submitted: "", invitationStatus: "failed" }, "Filter1 active"],
    [{ invitationStatus: "queued", included: "false" }, "Filter2 active"],
    [{ included: "true" }, "Filter1 active"],
  ])(
    "the Response group counts as one active filter for %j",
    (value, expected) => {
      render(<FilterButton value={value} onChange={jest.fn()} />);
      expect(filterButton()).toHaveTextContent(expected);
    },
  );

  test("closes on Escape (refocusing the button) and on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <FilterButton value={{}} onChange={jest.fn()} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    await user.click(filterButton());
    fireEvent.keyDown(screen.getByRole("radio", { name: "Invite failed" }), {
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
          { key: "response", label: "Response: Not submitted" },
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
    await user.click(
      screen.getByRole("button", {
        name: "Remove filter Response: Not submitted",
      }),
    );
    expect(onRemove).toHaveBeenLastCalledWith("response");
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
