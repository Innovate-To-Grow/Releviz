/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";

jest.mock("@/components/schedule/ScheduleGrid", () => ({
  __esModule: true,
  default: ({ label = "Availability", schedule = [] }) => (
    <div data-testid={`channel-grid-${label}`}>{schedule.join(",")}</div>
  ),
}));

describe("ScheduleChannelEditor", () => {
  test("uses roving tabs and arrow keys to switch schedule channels", async () => {
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[1]}
        virtual={[0.5]}
        readOnly={false}
      />,
    );

    const inpersonTab = screen.getByRole("tab", { name: "In person" });
    const virtualTab = screen.getByRole("tab", { name: "Virtual" });
    expect(inpersonTab).toHaveAttribute("tabindex", "0");
    expect(virtualTab).toHaveAttribute("tabindex", "-1");
    inpersonTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(virtualTab).toHaveFocus();
    expect(virtualTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tabpanel", { name: "Virtual" }),
    ).toBeInTheDocument();
  });

  test("switches channels and copies into an empty target immediately", async () => {
    const onCopy = jest.fn();
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[1, 0.5]}
        virtual={[0, 0]}
        readOnly={false}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByTestId("channel-grid-In-Person")).toHaveTextContent(
      "1,0.5",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy In-Person to Virtual" }),
    );
    expect(onCopy).toHaveBeenCalledWith("inperson", "virtual");
  });

  test("confirms before replacing a non-empty target", async () => {
    const onCopy = jest.fn();
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[1, 1]}
        virtual={[0.5, 0]}
        readOnly={false}
        onCopy={onCopy}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Virtual" }));
    expect(screen.getByTestId("channel-grid-Virtual")).toHaveTextContent(
      "0.5,0",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy Virtual to In-Person" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCopy).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy Virtual to In-Person" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Replace schedule" }),
    );
    expect(onCopy).toHaveBeenCalledWith("virtual", "inperson");
  });

  test("wraps keyboard tab navigation in both directions and ignores other keys", async () => {
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[1]}
        virtual={[0.5]}
        readOnly={false}
      />,
    );
    const inpersonTab = screen.getByRole("tab", { name: "In person" });
    const virtualTab = screen.getByRole("tab", { name: "Virtual" });
    inpersonTab.focus();
    fireEvent.keyDown(inpersonTab, { key: "ArrowLeft" });
    expect(virtualTab).toHaveFocus();
    fireEvent.keyDown(virtualTab, { key: "ArrowDown" });
    expect(inpersonTab).toHaveFocus();
    fireEvent.keyDown(inpersonTab, { key: "End" });
    expect(virtualTab).toHaveFocus();
    fireEvent.keyDown(virtualTab, { key: "Home" });
    expect(inpersonTab).toHaveFocus();
    fireEvent.keyDown(inpersonTab, { key: "Tab" });
    expect(inpersonTab).toHaveFocus();
    expect(inpersonTab).toHaveAttribute("aria-selected", "true");
  });

  test("renders a single channel without tabs and disables copying identical schedules", () => {
    const { unmount } = render(
      <ScheduleChannelEditor
        mode="virtual"
        slotGroups={[]}
        inperson={[0]}
        virtual={[1]}
        readOnly={false}
        legend={false}
      />,
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("channel-grid-Availability")).toHaveTextContent(
      "1",
    );
    expect(
      screen.queryByRole("list", { name: "Availability legend" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Copy/ }),
    ).not.toBeInTheDocument();

    unmount();
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[1, 0]}
        virtual={["1", 0]}
        readOnly={false}
        onCopy={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copy In-Person to Virtual" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("list", { name: "Availability legend" }),
    ).toBeInTheDocument();
  });

  // Deliberately ragged: a null group, a group without slots and a null slot
  // must not break the blocked-slot scan.
  const blockedSlotGroups = [
    null,
    { key: "weekday:0", label: "Sun" },
    {
      key: "weekday:1",
      label: "Mon",
      slots: [
        null,
        { index: 0, localStart: "09:00", localEnd: "09:30", blocked: false },
        { index: 1, localStart: "09:30", localEnd: "10:00", blocked: true },
      ],
    },
  ];

  test("adds the Blocked legend item when any slot is blocked", () => {
    const { unmount } = render(
      <ScheduleChannelEditor
        mode="inperson"
        slotGroups={blockedSlotGroups}
        inperson={[1, 1]}
        virtual={[0, 0]}
        readOnly={false}
      />,
    );
    let legend = screen.getByRole("list", { name: "Availability legend" });
    let items = legend.querySelectorAll(".availability-legend__item");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Busy");
    expect(items[3]).toHaveTextContent("Blocked");
    expect(
      items[3].querySelector(".availability-swatch--blocked"),
    ).toBeInTheDocument();
    unmount();

    // Hiding the availability legend still surfaces the blocked-only legend.
    render(
      <ScheduleChannelEditor
        mode="virtual"
        slotGroups={blockedSlotGroups}
        inperson={[0, 0]}
        virtual={[1, 1]}
        readOnly={false}
        legend={false}
      />,
    );
    legend = screen.getByRole("list", { name: "Availability legend" });
    items = legend.querySelectorAll(".availability-legend__item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Blocked");
    expect(screen.queryByText("Busy")).not.toBeInTheDocument();
  });

  test("ignores stale marks under blocked slots when copying channels", async () => {
    // Slot 1 is blocked: the only difference between the channels is hidden,
    // so the schedules are effectively identical and the copy is disabled.
    const { unmount } = render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={blockedSlotGroups}
        inperson={[0, 1]}
        virtual={[0, 0]}
        readOnly={false}
        onCopy={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copy In-Person to Virtual" }),
    ).toBeDisabled();
    unmount();

    // The target's only availability is a stale mark under the blocked slot,
    // so the copy proceeds without asking to replace anything.
    const onCopy = jest.fn();
    render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={blockedSlotGroups}
        inperson={[1, 0]}
        virtual={[0, 1]}
        readOnly={false}
        onCopy={onCopy}
      />,
    );
    const copyButton = screen.getByRole("button", {
      name: "Copy In-Person to Virtual",
    });
    expect(copyButton).toBeEnabled();
    await userEvent.click(copyButton);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onCopy).toHaveBeenCalledWith("inperson", "virtual");
  });

  test("omits every legend for aggregate values and for unblocked grids", () => {
    const { unmount } = render(
      <ScheduleChannelEditor
        mode="inperson"
        slotGroups={blockedSlotGroups}
        inperson={[1, 1]}
        virtual={[0, 0]}
        readOnly
        showValues
      />,
    );
    expect(
      screen.queryByRole("list", { name: "Availability legend" }),
    ).not.toBeInTheDocument();
    unmount();

    render(
      <ScheduleChannelEditor
        mode="inperson"
        slotGroups={{ invalid: true }}
        inperson={[1, 1]}
        virtual={[0, 0]}
        readOnly={false}
        legend={false}
      />,
    );
    expect(
      screen.queryByRole("list", { name: "Availability legend" }),
    ).not.toBeInTheDocument();
  });
});
