/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  ToastRegion,
  useToasts,
} from "@/components/schedule/participants/Toasts";

function Harness({ onReady }) {
  const api = useToasts();
  onReady(api);
  return <ToastRegion toasts={api.toasts} onDismiss={api.dismiss} />;
}

function renderToasts() {
  let api = null;
  const utils = render(
    <Harness
      onReady={(value) => {
        api = value;
      }}
    />,
  );
  return { ...utils, api: () => api };
}

describe("toasts", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("success toasts are polite and fade after six seconds", () => {
    const { api } = renderToasts();
    act(() => {
      api().push({ tone: "success", message: "Saved." });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    act(() => {
      jest.advanceTimersByTime(5999);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("danger toasts stay until dismissed", () => {
    const { api } = renderToasts();
    act(() => {
      api().push({ tone: "danger", message: "It failed." });
    });
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("It failed.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("sticky overrides the tone default in both directions", () => {
    const { api } = renderToasts();
    act(() => {
      api().push({ tone: "info", message: "Pinned.", sticky: true });
      api().push({ tone: "danger", message: "Fleeting.", sticky: false });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Pinned.");
    expect(screen.getByRole("alert")).toHaveTextContent("Fleeting.");
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Pinned.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("an action link calls its handler and dismissing early clears the timer", () => {
    const { api } = renderToasts();
    const onClick = jest.fn();
    let id;
    act(() => {
      id = api().push({
        message: "Queued 3 invitations.",
        action: { label: "View progress", onClick },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => {
      api().dismiss(id);
      api().dismiss("missing");
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("unmounting clears pending timers", () => {
    const { api, unmount } = renderToasts();
    act(() => {
      api().push({ message: "Bye." });
    });
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("push without arguments still makes an info toast", () => {
    const { api } = renderToasts();
    act(() => {
      api().push();
    });
    expect(screen.getByRole("status")).toHaveClass("alert-info");
  });
});
