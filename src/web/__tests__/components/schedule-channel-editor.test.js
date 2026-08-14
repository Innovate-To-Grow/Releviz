/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
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
});
