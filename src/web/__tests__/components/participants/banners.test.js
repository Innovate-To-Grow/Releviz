/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  DeadlineBanner,
  LeftOutBanner,
  NotInvitedBanner,
  ReadOnlyBanner,
} from "@/components/schedule/participants/Banners";

describe("NotInvitedBanner", () => {
  test("renders nothing when everyone has been invited", () => {
    const { container } = render(
      <NotInvitedBanner count={0} onSend={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("says nothing is sent yet and offers to send the invitations", () => {
    const onSend = jest.fn();
    render(<NotInvitedBanner count={3} onSend={onSend} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "3 people haven't been invited yet. Nobody is emailed until you send invitations.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send invitations…" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("uses the singular for one person", () => {
    render(<NotInvitedBanner count={1} onSend={jest.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 person hasn't been invited yet. Nobody is emailed until you send invitations.",
    );
  });
});

describe("LeftOutBanner", () => {
  test("renders nothing when nobody is left out", () => {
    const { container } = render(
      <LeftOutBanner
        count={0}
        onShow={jest.fn()}
        onCountEveryone={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("uses the singular for one person and wires both links", () => {
    const onShow = jest.fn();
    const onCountEveryone = jest.fn();
    render(
      <LeftOutBanner
        count={1}
        onShow={onShow}
        onCountEveryone={onCountEveryone}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 person is left out of the results.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Count everyone again" }),
    );
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onCountEveryone).toHaveBeenCalledTimes(1);
  });

  test("uses the plural and disables the count link while busy", () => {
    render(
      <LeftOutBanner
        count={4}
        busy
        onShow={jest.fn()}
        onCountEveryone={jest.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 people are left out of the results.",
    );
    expect(
      screen.getByRole("button", { name: "Count everyone again" }),
    ).toBeDisabled();
  });

  test("keeps the count link off while the list is read-only, with Show them still available", () => {
    const onShow = jest.fn();
    const onCountEveryone = jest.fn();
    render(
      <LeftOutBanner
        count={2}
        readOnly
        onShow={onShow}
        onCountEveryone={onCountEveryone}
      />,
    );
    const countEveryone = screen.getByRole("button", {
      name: "Count everyone again",
    });
    expect(countEveryone).toBeDisabled();
    fireEvent.click(countEveryone);
    expect(onCountEveryone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});

describe("DeadlineBanner", () => {
  test("names the deadline in the event timezone and offers to change it", () => {
    const onEdit = jest.fn();
    render(
      <DeadlineBanner
        deadline="2026-09-01T12:00:00Z"
        timezone="America/New_York"
        onEdit={onEdit}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("alert-warning");
    expect(banner).toHaveTextContent(
      /The response deadline \(.*8:00:00\sAM EDT\) has passed, so people can't be added, invited or changed\. You can still enter schedules for people you answer for\./,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change deadline" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("omits the action without a handler", () => {
    render(<DeadlineBanner deadline="2026-09-01T12:00:00Z" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("ReadOnlyBanner", () => {
  test("explains that the list cannot change", () => {
    render(<ReadOnlyBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Responses are closed, so this list is read-only. Reactivate the event to make changes.",
    );
  });
});
