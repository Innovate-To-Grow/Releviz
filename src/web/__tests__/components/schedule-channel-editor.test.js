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

  test("treats a target that still matches an Available start as empty", async () => {
    const onCopy = jest.fn();
    const { rerender } = render(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[0, 1]}
        virtual={[1, 1]}
        readOnly={false}
        startingValue={1}
        onCopy={onCopy}
      />,
    );

    // Every slot began Available, so an all-Available Virtual channel is
    // untouched and gets replaced without a prompt.
    await userEvent.click(
      screen.getByRole("button", { name: "Copy In-Person to Virtual" }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onCopy).toHaveBeenCalledWith("inperson", "virtual");

    // A Virtual channel painted entirely Busy is a real answer and is
    // protected by the confirmation.
    onCopy.mockClear();
    rerender(
      <ScheduleChannelEditor
        mode="mixed"
        slotGroups={[]}
        inperson={[0, 1]}
        virtual={[0, 0]}
        readOnly={false}
        startingValue={1}
        onCopy={onCopy}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "In person" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy In-Person to Virtual" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onCopy).not.toHaveBeenCalled();
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
});
