/**
 * @jest-environment jsdom
 */

import { createRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import MeetingCalendar from "@/components/schedule/MeetingCalendar";
import { selectionFromRecommendation } from "@/lib/meetingWindows";

// Thursday 10 September 2026: the week of Sep 6 – 12.
const NOW = Date.parse("2026-09-10T00:00:00Z");
// Before the specific-date fixture (Aug 20 – 28, 2026) so its cells are pickable.
const DATE_NOW = Date.parse("2026-08-01T00:00:00Z");

const HALF_HOURS = ["09:00", "09:30", "10:00", "10:30", "11:00"];

function weekdaySlots(firstIndex) {
  return HALF_HOURS.slice(0, 4).map((localStart, offset) => ({
    index: firstIndex + offset,
    localStart,
    localEnd: HALF_HOURS[offset + 1],
    startDayOffset: 0,
    endDayOffset: 0,
  }));
}

const weeklyEvent = {
  code: "WEEKLY1",
  mode: "inperson",
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: [
    { key: "weekday:1", slots: weekdaySlots(0) },
    { key: "weekday:3", slots: weekdaySlots(4) },
  ],
};

const recommendation = {
  rank: 1,
  channel: "inperson",
  slotIndices: [1, 2],
  groupKey: "weekday:1",
  weekday: 1,
  localStart: "09:30",
  localEnd: "10:30",
  startDayOffset: 0,
  endDayOffset: 0,
  suggestedStartsAt: "2026-09-14T09:30:00Z",
  suggestedEndsAt: "2026-09-14T10:30:00Z",
  label: "Mon 09:30–10:30",
  weightedAvailability: 0.83,
  unweightedAvailability: 0.8,
  fullyAvailableParticipantTotal: 9,
};

const results = {
  countedResponseTotal: 12,
  channels: {
    inperson: {
      weighted: [0.5, 0.83, 0.9, 0.4, 0.6, 0.7, 0.2, 0.1],
      unweighted: [0.45, 0.8, 0.85, 0.35, 0.55, 0.65, 0.15, 0.05],
    },
  },
  recommendations: [recommendation],
};

function dateGroup(date, firstIndex) {
  return {
    key: `date:${date}`,
    date,
    slots: HALF_HOURS.slice(0, 4).map((localStart, offset) => ({
      index: firstIndex + offset,
      localStart,
      localEnd: HALF_HOURS[offset + 1],
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: `${date}T${localStart}:00Z`,
      endsAt: `${date}T${HALF_HOURS[offset + 1]}:00Z`,
    })),
  };
}

const dateEvent = {
  code: "DATES9",
  mode: "inperson",
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: Array.from({ length: 9 }, (_, day) =>
    dateGroup(`2026-08-${20 + day}`, day * 4),
  ),
};

const legacyEvent = {
  code: "LEGACY1",
  mode: "inperson",
  timezone: "UTC",
  slotMinutes: 30,
  meetingDurationMinutes: 60,
  slotGroups: [
    {
      key: "2026-08-20",
      slots: [
        {
          index: 0,
          startsAt: "2026-08-20T09:00:00Z",
          endsAt: "2026-08-20T09:30:00Z",
        },
        {
          index: 1,
          startsAt: "2026-08-20T09:30:00Z",
          endsAt: "2026-08-20T10:00:00Z",
        },
        {
          index: 2,
          startsAt: "2026-08-20T10:00:00Z",
          endsAt: "2026-08-20T10:30:00Z",
        },
      ],
    },
  ],
};

const cell = (index) => document.querySelector(`[data-cell-idx="${index}"]`);

function columnHeaders() {
  return within(screen.getByRole("grid"))
    .getAllByRole("columnheader")
    .slice(1)
    .map((header) => header.getAttribute("title"));
}

function tabbableCells() {
  return [...document.querySelectorAll('[role="gridcell"][tabindex="0"]')];
}

function renderCalendar(props = {}) {
  const onSelect = jest.fn();
  const onChannelChange = jest.fn();
  const utils = render(
    <MeetingCalendar
      event={weeklyEvent}
      results={results}
      channel="inperson"
      onSelect={onSelect}
      onChannelChange={onChannelChange}
      now={NOW}
      {...props}
    />,
  );
  return { ...utils, onSelect, onChannelChange };
}

describe("MeetingCalendar", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    window.matchMedia = jest.fn().mockReturnValue({ matches: false });
    HTMLElement.prototype.scrollIntoView = jest.fn();
    HTMLElement.prototype.scrollTo = jest.fn();
    global.IntersectionObserver = class IntersectionObserver {
      constructor(callback) {
        this.callback = callback;
      }

      observe(target) {
        this.callback([{ isIntersecting: true, target }]);
      }

      unobserve() {}

      disconnect() {}
    };
  });

  test("opens on the week of the top recommendation with dated day columns", () => {
    renderCalendar();

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAccessibleName(
      "Meeting time calendar, Sep 13 – 19, 2026",
    );
    expect(grid.getAttribute("aria-label")).toMatch(/^Meeting time calendar/);
    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);
    const [monday, wednesday] = within(grid)
      .getAllByRole("columnheader")
      .slice(1);
    expect(within(monday).getByText("Mon")).toBeInTheDocument();
    expect(within(monday).getByText("Sep 14")).toBeInTheDocument();
    expect(within(wednesday).getByText("Wed")).toBeInTheDocument();
    expect(within(wednesday).getByText("Sep 16")).toBeInTheDocument();
    expect(screen.getByText("Sep 13 – 19, 2026")).toHaveTextContent(
      /Sep.*2026/,
    );
    expect(
      within(grid)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM"]);
    expect(document.querySelectorAll("[data-cell-idx]")).toHaveLength(8);
    expect(screen.queryByText("Available", { exact: true })).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Calendar legend" })).queryByText(
        "Available",
        { exact: true },
      ),
    ).toBeNull();
  });

  test("shades cells by the weighted share and toggles to unweighted", async () => {
    renderCalendar();

    expect(cell(0)).toHaveTextContent("50%");
    expect(cell(1)).toHaveTextContent("83%");
    expect(cell(6)).toHaveTextContent("20%");
    const weightedBackground = cell(1).style.backgroundColor;
    expect(weightedBackground).toMatch(/^rgb\(/);
    expect(cell(1)).toHaveAttribute("data-level", "partial");
    expect(cell(1)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Weighted 83%, unweighted 80% of 12 responses."),
    );
    expect(cell(6)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Weighted 20%, unweighted 15% of 12 responses."),
    );

    const shading = screen.getByRole("group", { name: "Shading" });
    const weighted = within(shading).getByRole("button", { name: "Weighted" });
    const unweighted = within(shading).getByRole("button", {
      name: "Unweighted",
    });
    expect(weighted).toHaveAttribute("aria-pressed", "true");
    expect(unweighted).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText("0% → 100% of responses free (weighted)"),
    ).toBeInTheDocument();

    await userEvent.click(unweighted);

    expect(unweighted).toHaveAttribute("aria-pressed", "true");
    expect(weighted).toHaveAttribute("aria-pressed", "false");
    expect(cell(0)).toHaveTextContent("45%");
    expect(cell(1)).toHaveTextContent("80%");
    expect(cell(6)).toHaveTextContent("15%");
    expect(cell(1).style.backgroundColor).not.toBe(weightedBackground);
    expect(
      screen.getByText("0% → 100% of responses free (unweighted)"),
    ).toBeInTheDocument();
    // The accessible description always carries both figures.
    expect(cell(1)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Weighted 83%, unweighted 80% of 12 responses."),
    );
  });

  test("offers the channel group only for mixed events and never uses tabs", async () => {
    const { onChannelChange, rerender } = renderCalendar({
      event: { ...weeklyEvent, mode: "mixed" },
    });

    const channelGroup = screen.getByRole("group", { name: "Meeting channel" });
    const inPerson = within(channelGroup).getByRole("button", {
      name: "In person",
    });
    const virtual = within(channelGroup).getByRole("button", {
      name: "Virtual",
    });
    expect(inPerson).toHaveAttribute("aria-pressed", "true");
    expect(virtual).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    await userEvent.click(virtual);
    expect(onChannelChange).toHaveBeenCalledTimes(1);
    expect(onChannelChange).toHaveBeenCalledWith("virtual");

    rerender(
      <MeetingCalendar
        event={weeklyEvent}
        results={results}
        channel="inperson"
        onSelect={jest.fn()}
        onChannelChange={onChannelChange}
        now={NOW}
      />,
    );
    expect(screen.queryByRole("group", { name: "Meeting channel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Virtual" })).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  test("selects a meeting window starting at the clicked cell", async () => {
    const { onSelect } = renderCalendar();

    expect(cell(0)).toHaveAttribute("data-state", "startable");
    expect(cell(0)).not.toHaveAttribute("aria-disabled");
    expect(cell(0)).toHaveAttribute(
      "aria-label",
      expect.stringContaining(
        "Mon, Sep 14, 9:00 AM – 9:30 AM. Weighted 50%, unweighted 45% of 12 responses. Starts a 60-minute window 9:00 AM – 10:00 AM.",
      ),
    );

    await userEvent.click(cell(0));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      channel: "inperson",
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T10:00:00.000Z",
      slotIndices: [0, 1],
      groupKey: "weekday:1",
      label: "Mon 09:00–10:00",
      dateLabel: expect.stringContaining("Sep 14, 2026"),
      source: "calendar",
      recommendation: null,
      rescheduled: false,
      metrics: expect.objectContaining({
        exact: false,
        weighted: 0.5,
        unweighted: 0.45,
      }),
    });

    await userEvent.click(cell(1));

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "inperson",
        startsAt: "2026-09-14T09:30:00.000Z",
        endsAt: "2026-09-14T10:30:00.000Z",
        slotIndices: [1, 2],
        groupKey: "weekday:1",
        label: "Mon 09:30–10:30",
        source: "calendar",
        recommendation,
        metrics: expect.objectContaining({
          exact: true,
          rank: 1,
          weighted: 0.83,
          unweighted: 0.8,
          fullyAvailableParticipantTotal: 9,
        }),
      }),
    );
    expect(cell(1)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Inside ranked window #1."),
    );
  });

  test("disables tail, past, and daylight-saving cells", async () => {
    const { onSelect, unmount } = renderCalendar();

    expect(cell(3)).toHaveAttribute("data-state", "tail");
    expect(cell(3)).toHaveAttribute("aria-disabled", "true");
    expect(cell(3).getAttribute("title")).toContain(
      "Not enough time remains for a 60-minute meeting.",
    );
    expect(cell(7)).toHaveAttribute("data-state", "tail");
    expect(cell(2)).toHaveAttribute("data-state", "startable");

    await userEvent.click(cell(3));
    fireEvent.keyDown(cell(3), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    unmount();

    // Now sits between the first and second Monday slots.
    const past = renderCalendar({ now: Date.parse("2026-09-14T09:15:00Z") });
    expect(cell(0)).toHaveAttribute("data-state", "past");
    expect(cell(0)).toHaveAttribute("aria-disabled", "true");
    expect(cell(0).getAttribute("title")).toContain("This time has passed.");
    expect(cell(1)).toHaveAttribute("data-state", "startable");
    await userEvent.click(cell(0));
    expect(past.onSelect).not.toHaveBeenCalled();
    past.unmount();

    // Los Angeles springs forward on Sunday 2026-03-08: 02:00–03:00 does not exist.
    const dstEvent = {
      ...weeklyEvent,
      timezone: "America/Los_Angeles",
      slotGroups: [
        {
          key: "weekday:0",
          slots: ["01:00", "01:30", "02:00", "02:30", "03:00", "03:30"].map(
            (localStart, index) => ({
              index,
              localStart,
              localEnd: ["01:30", "02:00", "02:30", "03:00", "03:30", "04:00"][
                index
              ],
              startDayOffset: 0,
              endDayOffset: 0,
            }),
          ),
        },
      ],
    };
    const dst = renderCalendar({
      event: dstEvent,
      results: null,
      now: Date.parse("2026-03-08T08:30:00Z"),
    });
    expect(columnHeaders()).toEqual(["Sun, Mar 8"]);
    [0, 1, 2, 3].forEach((index) => {
      expect(cell(index)).toHaveAttribute("data-state", "dst");
      expect(cell(index)).toHaveAttribute("aria-disabled", "true");
      expect(cell(index).getAttribute("title")).toContain(
        "That local time does not exist because of a daylight-saving change.",
      );
    });
    expect(cell(4)).toHaveAttribute("data-state", "startable");
    expect(cell(5)).toHaveAttribute("data-state", "tail");
    await userEvent.click(cell(1));
    expect(dst.onSelect).not.toHaveBeenCalled();
    await userEvent.click(cell(4));
    expect(dst.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        startsAt: "2026-03-08T10:00:00.000Z",
        endsAt: "2026-03-08T11:00:00.000Z",
        slotIndices: [4, 5],
      }),
    );
    // Next Sunday has no gap, so every window is available again.
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(columnHeaders()).toEqual(["Sun, Mar 15"]);
    expect(cell(1)).toHaveAttribute("data-state", "startable");
  });

  test("supports roving focus and keyboard selection", () => {
    const { onSelect } = renderCalendar();

    // Nothing selected: the single tab stop is the top recommendation's first cell.
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["1"]);

    act(() => cell(1).focus());
    expect(document.activeElement).toBe(cell(1));

    fireEvent.keyDown(cell(1), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(5));
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["5"]);

    fireEvent.keyDown(cell(5), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell(6));

    fireEvent.keyDown(cell(6), { key: "Home" });
    expect(document.activeElement).toBe(cell(2));

    fireEvent.keyDown(cell(2), { key: "End" });
    expect(document.activeElement).toBe(cell(6));

    fireEvent.keyDown(cell(6), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(2));

    fireEvent.keyDown(cell(2), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cell(1));

    fireEvent.keyDown(cell(1), { key: "Home", ctrlKey: true });
    expect(document.activeElement).toBe(cell(0));

    fireEvent.keyDown(cell(0), { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(cell(7));

    fireEvent.keyDown(cell(7), { key: "Home", ctrlKey: true });
    expect(document.activeElement).toBe(cell(0));
    expect(tabbableCells()).toHaveLength(1);

    fireEvent.keyDown(cell(0), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        slotIndices: [0, 1],
        startsAt: "2026-09-14T09:00:00.000Z",
      }),
    );

    fireEvent.keyDown(cell(2), { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        slotIndices: [2, 3],
        startsAt: "2026-09-14T10:00:00.000Z",
        endsAt: "2026-09-14T11:00:00.000Z",
      }),
    );

    fireEvent.keyDown(cell(0), { key: "PageDown" });
    expect(columnHeaders()).toEqual(["Mon, Sep 21", "Wed, Sep 23"]);

    fireEvent.keyDown(cell(0), { key: "PageUp" });
    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);
  });

  test("navigates between weeks and back to the current week", async () => {
    renderCalendar();

    const range = screen.getByRole("group", { name: "Calendar range" });
    await userEvent.click(
      within(range).getByRole("button", { name: "Next week" }),
    );
    expect(columnHeaders()).toEqual(["Mon, Sep 21", "Wed, Sep 23"]);
    expect(screen.getByRole("grid")).toHaveAccessibleName(
      "Meeting time calendar, Sep 20 – 26, 2026",
    );

    await userEvent.click(
      within(range).getByRole("button", { name: "Previous week" }),
    );
    await userEvent.click(
      within(range).getByRole("button", { name: "Previous week" }),
    );
    expect(columnHeaders()).toEqual(["Mon, Sep 7", "Wed, Sep 9"]);

    await userEvent.click(
      within(range).getByRole("button", { name: "Next week" }),
    );
    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);

    await userEvent.click(
      within(range).getByRole("button", { name: "This week" }),
    );
    expect(columnHeaders()).toEqual(["Mon, Sep 7", "Wed, Sep 9"]);
    expect(screen.getByRole("grid")).toHaveAccessibleName(
      "Meeting time calendar, Sep 6 – 12, 2026",
    );
    expect(
      within(range).getByRole("button", { name: "Previous week" }),
    ).toBeEnabled();
    expect(
      within(range).getByRole("button", { name: "Next week" }),
    ).toBeEnabled();
  });

  test("draws ranked windows as positioned blocks in every visible week", async () => {
    renderCalendar();

    const rankBlock = () =>
      document.querySelector(".meeting-calendar__block--rank");
    expect(
      document.querySelectorAll(".meeting-calendar__block--rank"),
    ).toHaveLength(1);
    expect(rankBlock()).toHaveClass("meeting-calendar__block--best");
    expect(rankBlock()).toHaveAttribute("data-rank", "1");
    expect(
      rankBlock().querySelector(".meeting-calendar__rank"),
    ).toHaveTextContent("#1");
    expect(rankBlock().style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(rankBlock().style.getPropertyValue("--rv-cal-row")).toBe("1");
    expect(rankBlock().style.getPropertyValue("--rv-cal-span")).toBe("2");
    expect(
      document.querySelector(".meeting-calendar__overlays"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Ranked window")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));

    expect(columnHeaders()).toEqual(["Mon, Sep 21", "Wed, Sep 23"]);
    expect(
      document.querySelectorAll(".meeting-calendar__block--rank"),
    ).toHaveLength(1);
    expect(rankBlock()).toHaveClass("meeting-calendar__block--best");
    expect(
      rankBlock().querySelector(".meeting-calendar__rank"),
    ).toHaveTextContent("#1");
    expect(rankBlock().style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(rankBlock().style.getPropertyValue("--rv-cal-row")).toBe("1");
    expect(rankBlock().style.getPropertyValue("--rv-cal-span")).toBe("2");
  });

  test("marks the selected window and moves the tab stop to it", () => {
    const selection = selectionFromRecommendation(recommendation, weeklyEvent, {
      now: NOW,
    });
    expect(selection.startsAt).toBe("2026-09-14T09:30:00Z");
    renderCalendar({ selection });

    expect(cell(1)).toHaveAttribute("aria-selected", "true");
    expect(cell(2)).toHaveAttribute("aria-selected", "true");
    expect(cell(0)).not.toHaveAttribute("aria-selected");
    expect(cell(3)).not.toHaveAttribute("aria-selected");
    const selected = document.querySelector(
      ".meeting-calendar__block--selected",
    );
    expect(selected).toHaveTextContent("Selected");
    expect(selected.style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(selected.style.getPropertyValue("--rv-cal-row")).toBe("1");
    expect(selected.style.getPropertyValue("--rv-cal-span")).toBe("2");
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["1"]);
    expect(screen.getByText("Selected window")).toBeInTheDocument();
  });

  test("pages through specific dates and sends slot instants verbatim", async () => {
    const { onSelect } = renderCalendar({
      event: dateEvent,
      results: null,
      now: DATE_NOW,
    });

    const range = screen.getByRole("group", { name: "Calendar range" });
    const previous = within(range).getByRole("button", {
      name: "Previous dates",
    });
    const next = within(range).getByRole("button", { name: "Next dates" });
    expect(screen.getByRole("grid").getAttribute("aria-label")).toMatch(
      /^Meeting time calendar, Dates 1–7 of 9/,
    );
    expect(columnHeaders()).toEqual([
      "Thu, Aug 20",
      "Fri, Aug 21",
      "Sat, Aug 22",
      "Sun, Aug 23",
      "Mon, Aug 24",
      "Tue, Aug 25",
      "Wed, Aug 26",
    ]);
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(screen.queryByRole("button", { name: "This week" })).toBeNull();

    await userEvent.click(cell(1));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "inperson",
        startsAt: "2026-08-20T09:30:00Z",
        endsAt: "2026-08-20T10:30:00Z",
        slotIndices: [1, 2],
        groupKey: "date:2026-08-20",
        label: "2026-08-20 09:30–10:30",
        source: "calendar",
      }),
    );

    await userEvent.click(next);
    expect(screen.getByRole("grid").getAttribute("aria-label")).toMatch(
      /^Meeting time calendar, Dates 8–9 of 9/,
    );
    expect(columnHeaders()).toEqual(["Thu, Aug 27", "Fri, Aug 28"]);
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();

    await userEvent.click(cell(32));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startsAt: "2026-08-28T09:00:00Z",
        endsAt: "2026-08-28T10:00:00Z",
        slotIndices: [32, 33],
        groupKey: "date:2026-08-28",
      }),
    );

    await userEvent.click(previous);
    expect(columnHeaders()[0]).toBe("Thu, Aug 20");
    expect(previous).toBeDisabled();
  });

  test("stays pickable without a results snapshot", async () => {
    const { onSelect } = renderCalendar({ results: null });

    expect(
      screen.getByText(
        /Availability shading appears once the first results snapshot is ready/,
      ),
    ).toBeInTheDocument();
    document.querySelectorAll("[data-cell-idx]").forEach((element) => {
      expect(element.style.backgroundColor).toBe("");
      expect(
        element.querySelector(".meeting-calendar__cell-value"),
      ).toHaveTextContent("");
      expect(element).toHaveClass("meeting-calendar__cell--neutral");
    });
    expect(cell(0)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("No availability snapshot yet."),
    );
    expect(document.querySelector(".meeting-calendar__block--rank")).toBeNull();
    expect(screen.queryByText("Available", { exact: true })).toBeNull();
    // Without a recommendation the calendar opens on the week of `now`.
    expect(columnHeaders()).toEqual(["Mon, Sep 7", "Wed, Sep 9"]);
    expect(cell(0)).toHaveAttribute("data-state", "past");

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));

    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);
    expect(cell(0)).toHaveAttribute("data-state", "startable");
    // The tab stop falls back to the first startable cell.
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["0"]);

    await userEvent.click(cell(4));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "inperson",
        startsAt: "2026-09-16T09:00:00.000Z",
        endsAt: "2026-09-16T10:00:00.000Z",
        slotIndices: [4, 5],
        groupKey: "weekday:3",
        label: "Wed 09:00–10:00",
        metrics: { exact: false, weighted: null, unweighted: null },
      }),
    );
  });

  test("renders legacy date groups and keeps their instants", async () => {
    const { onSelect } = renderCalendar({
      event: legacyEvent,
      results: null,
      now: DATE_NOW,
    });

    expect(columnHeaders()).toEqual(["Thu, Aug 20"]);
    expect(screen.getByRole("grid").getAttribute("aria-label")).toMatch(
      /^Meeting time calendar, Dates 1–1 of 1/,
    );
    expect(document.querySelectorAll("[data-cell-idx]")).toHaveLength(3);
    expect(cell(0)).toHaveAttribute("data-state", "startable");
    expect(cell(2)).toHaveAttribute("data-state", "tail");

    await userEvent.click(cell(0));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "inperson",
        startsAt: "2026-08-20T09:00:00Z",
        endsAt: "2026-08-20T10:00:00Z",
        slotIndices: [0, 1],
        groupKey: "2026-08-20",
        source: "calendar",
      }),
    );
  });

  test("reveals a window in another week and scrolls only the calendar to its first cell", async () => {
    const ref = createRef();
    renderCalendar({ ref });
    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);

    act(() => {
      ref.current.reveal({
        startsAt: "2026-09-23T10:00:00Z",
        slotIndices: [6, 7],
        groupKey: "weekday:3",
      });
    });

    expect(columnHeaders()).toEqual(["Mon, Sep 21", "Wed, Sep 23"]);
    const scroller = document.querySelector(".meeting-calendar__scroll");
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
        top: expect.any(Number),
        left: expect.any(Number),
        behavior: "smooth",
      }),
    );
    // Only the calendar's own scroll container moves. `scrollIntoView` would
    // also scroll the page and fight the jump to the Finalize section.
    expect(HTMLElement.prototype.scrollTo.mock.contexts).toEqual([scroller]);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["6"]);
  });

  test("reveals without animation when reduced motion is preferred", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    const ref = createRef();
    renderCalendar({ ref });

    act(() => {
      ref.current.reveal({
        startsAt: "2026-09-07T09:00:00Z",
        slotIndices: [0, 1],
        groupKey: "weekday:1",
      });
    });

    expect(columnHeaders()).toEqual(["Mon, Sep 7", "Wed, Sep 9"]);
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "auto" }),
      ),
    );
    expect(window.matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce)",
    );
    expect(HTMLElement.prototype.scrollTo.mock.contexts).toEqual([
      document.querySelector(".meeting-calendar__scroll"),
    ]);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  // jsdom lays nothing out, so the geometry the scroll math reads is stubbed.
  function stubScrollGeometry({ cellRect, scrollTop, scrollLeft }) {
    const scroller = document.querySelector(".meeting-calendar__scroll");
    scroller.getBoundingClientRect = () => ({
      top: 100,
      left: 0,
      width: 400,
      height: 300,
    });
    Object.defineProperty(scroller, "clientHeight", { value: 300 });
    Object.defineProperty(scroller, "clientWidth", { value: 400 });
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft;
    Object.defineProperty(
      scroller.querySelector(".meeting-calendar__header"),
      "offsetHeight",
      { value: 44 },
    );
    Object.defineProperty(
      scroller.querySelector(".meeting-calendar__time-header"),
      "offsetWidth",
      { value: 72 },
    );
    cell(6).getBoundingClientRect = () => cellRect;
    return scroller;
  }

  test("scrolls just far enough to uncover a revealed cell hidden under the sticky edges", async () => {
    const ref = createRef();
    renderCalendar({ ref });
    act(() => {
      ref.current.reveal({
        startsAt: "2026-09-23T10:00:00Z",
        slotIndices: [6, 7],
        groupKey: "weekday:3",
      });
    });
    // The cell sits 40px above the viewport and 30px left of it, i.e. under
    // the 44px sticky header and 72px sticky time column once scrolled to.
    const scroller = stubScrollGeometry({
      cellRect: { top: 60, left: -30, width: 80, height: 40 },
      scrollTop: 500,
      scrollLeft: 300,
    });

    await waitFor(() =>
      expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
        top: 500 - 40 - 44,
        left: 300 - 30 - 72,
        behavior: "smooth",
      }),
    );
    expect(HTMLElement.prototype.scrollTo.mock.contexts).toEqual([scroller]);
  });

  test("falls back to scrollTop/scrollLeft when the container has no scrollTo", async () => {
    delete HTMLElement.prototype.scrollTo;
    const ref = createRef();
    renderCalendar({ ref });
    act(() => {
      ref.current.reveal({
        startsAt: "2026-09-23T10:00:00Z",
        slotIndices: [6, 7],
        groupKey: "weekday:3",
      });
    });
    // The cell pokes 30px past the bottom edge and 60px past the right edge.
    const scroller = stubScrollGeometry({
      cellRect: { top: 390, left: 380, width: 80, height: 40 },
      scrollTop: 500,
      scrollLeft: 300,
    });

    await waitFor(() => expect(scroller.scrollTop).toBe(530));
    expect(scroller.scrollLeft).toBe(360);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test("draws the confirmed meeting for finalized events", () => {
    renderCalendar({
      event: {
        ...weeklyEvent,
        status: "finalized",
        finalMeeting: {
          startsAt: "2026-09-14T09:30:00Z",
          endsAt: "2026-09-14T10:30:00Z",
          channel: "inperson",
        },
      },
    });

    const confirmed = document.querySelector(
      ".meeting-calendar__block--confirmed",
    );
    expect(confirmed).toHaveTextContent("Confirmed");
    expect(confirmed.style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(confirmed.style.getPropertyValue("--rv-cal-row")).toBe("1");
    expect(confirmed.style.getPropertyValue("--rv-cal-span")).toBe("2");
    const legend = screen.getByRole("list", { name: "Calendar legend" });
    expect(within(legend).getByText("Confirmed meeting")).toBeInTheDocument();
    expect(within(legend).queryByText("Available", { exact: true })).toBeNull();
  });

  test("opens on the week of the confirmed meeting", () => {
    renderCalendar({
      event: {
        ...weeklyEvent,
        status: "finalized",
        finalMeeting: {
          startsAt: "2026-10-05T09:30:00Z",
          endsAt: "2026-10-05T10:30:00Z",
          channel: "inperson",
        },
      },
    });

    expect(
      screen.getByRole("grid", {
        name: "Meeting time calendar, Oct 4 – 10, 2026",
      }),
    ).toBeInTheDocument();
    expect(document.querySelector(".meeting-calendar")).toHaveClass(
      "meeting-calendar--finalized",
    );
    const confirmed = document.querySelector(
      ".meeting-calendar__block--confirmed",
    );
    expect(confirmed.style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(confirmed.style.getPropertyValue("--rv-cal-row")).toBe("1");
  });

  test("hides the confirmed block when it belongs to the other channel", () => {
    renderCalendar({
      event: {
        ...weeklyEvent,
        mode: "mixed",
        finalMeeting: {
          startsAt: "2026-09-14T09:30:00Z",
          endsAt: "2026-09-14T10:30:00Z",
          channel: "virtual",
        },
      },
    });

    expect(
      document.querySelector(".meeting-calendar__block--confirmed"),
    ).toBeNull();
    expect(screen.getByText("Confirmed meeting")).toBeInTheDocument();
  });

  test("exposes a valid ARIA grid with one tab stop and the overlays outside it", () => {
    const selection = selectionFromRecommendation(recommendation, weeklyEvent, {
      now: NOW,
    });
    renderCalendar({ selection });

    const grid = screen.getByRole("grid");
    const columnCount = Number(grid.getAttribute("aria-colcount"));
    const rowCount = Number(grid.getAttribute("aria-rowcount"));
    expect(columnCount).toBe(3);
    expect(rowCount).toBe(5);

    // grid → row | rowgroup → row → columnheader | rowheader | gridcell.
    [...grid.children].forEach((child) => {
      expect(["row", "rowgroup"]).toContain(child.getAttribute("role"));
    });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(rowCount);
    rows.forEach((row, rowIndex) => {
      expect(row.getAttribute("aria-rowindex")).toBe(String(rowIndex + 1));
      const cells = [...row.children];
      expect(cells).toHaveLength(columnCount);
      cells.forEach((cellElement, columnIndex) => {
        expect(cellElement.getAttribute("aria-colindex")).toBe(
          String(columnIndex + 1),
        );
        const role = cellElement.getAttribute("role");
        if (rowIndex === 0) expect(role).toBe("columnheader");
        else if (columnIndex === 0) expect(role).toBe("rowheader");
        else expect(role).toBe("gridcell");
      });
    });
    // Nothing else inside the grid carries a role (the value spans are
    // plain, aria-hidden text).
    expect(
      grid.querySelectorAll(
        '[role]:not([role="row"]):not([role="rowgroup"]):not([role="columnheader"]):not([role="rowheader"]):not([role="gridcell"])',
      ),
    ).toHaveLength(0);
    expect(within(grid).queryByRole("note")).toBeNull();
    expect(within(grid).queryByRole("alert")).toBeNull();
    expect(within(grid).queryByRole("button")).toBeNull();

    // Decorative blocks never sit inside the grid tree.
    const overlays = document.querySelector(".meeting-calendar__overlays");
    expect(overlays).toHaveAttribute("aria-hidden", "true");
    expect(grid.contains(overlays)).toBe(false);
    expect(overlays.querySelector("[tabindex], button, a")).toBeNull();

    // Roving tabindex: exactly one tab stop, on the selected window.
    const gridcells = within(grid).getAllByRole("gridcell");
    expect(gridcells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(gridcells.filter((c) => c.tabIndex === 0)[0]).toBe(cell(1));
    gridcells.forEach((c) => {
      if (c.tabIndex !== 0) expect(c.tabIndex).toBe(-1);
    });
    expect(
      gridcells.filter((c) => c.getAttribute("aria-selected") === "true"),
    ).toEqual([cell(1), cell(2)]);
    gridcells.forEach((c) => {
      expect(c.getAttribute("aria-label")).toBeTruthy();
      if (c.dataset.state === "startable") {
        expect(c).not.toHaveAttribute("aria-disabled");
      } else {
        expect(c).toHaveAttribute("aria-disabled", "true");
      }
    });
    expect(
      document
        .querySelector(".meeting-calendar")
        .style.getPropertyValue("--rv-cal-columns"),
    ).toBe("2");
  });

  test("names every toolbar control and keeps the controls full size", () => {
    renderCalendar({ event: { ...weeklyEvent, mode: "mixed" } });

    const toolbar = document.querySelector(".meeting-calendar__toolbar");
    const buttons = within(toolbar).getAllByRole("button");
    expect(
      buttons.map(
        (button) =>
          button.textContent.trim() || button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "In person",
      "Virtual",
      "Weighted",
      "Unweighted",
      "Previous week",
      "Next week",
      "This week",
    ]);
    buttons.forEach((button) => {
      expect(button).toHaveAccessibleName();
      // Default-size Bootstrap buttons are ~40px tall; btn-sm is ~31px.
      expect(button).not.toHaveClass("btn-sm");
    });
    expect(toolbar.querySelector(".btn-group-sm")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Previous week" }),
    ).toHaveAttribute("aria-label", "Previous week");
    expect(screen.getByRole("button", { name: "Next week" })).toHaveAttribute(
      "aria-label",
      "Next week",
    );
    expect(
      document.querySelector(".meeting-calendar__range-label"),
    ).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByRole("group", { name: "Meeting channel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Shading" })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Calendar range" }),
    ).toBeInTheDocument();

    // The pick buttons live in the ranked rail, never on the calendar, and
    // the calendar adds no heading of its own.
    expect(
      screen.queryByRole("button", { name: /choose this time/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /selected time/i })).toBeNull();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    const legend = screen.getByRole("list", { name: "Calendar legend" });
    within(legend)
      .getAllByRole("listitem")
      .forEach((item) => expect(item.textContent.trim()).not.toBe("Available"));
  });

  test("keeps keyboard focus inside the grid when paging through specific dates", () => {
    renderCalendar({ event: dateEvent, results: null, now: DATE_NOW });

    act(() => cell(0).focus());
    expect(document.activeElement).toBe(cell(0));

    fireEvent.keyDown(cell(0), { key: "PageDown" });

    expect(columnHeaders()).toEqual(["Thu, Aug 27", "Fri, Aug 28"]);
    // The page-1 cells unmounted; focus moved to the new page's tab stop
    // rather than falling back to the document body.
    expect(cell(0)).toBeNull();
    expect(document.activeElement).toBe(cell(28));
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["28"]);

    fireEvent.keyDown(cell(28), { key: "PageUp" });
    expect(columnHeaders()[0]).toBe("Thu, Aug 20");
    expect(document.activeElement).toBe(cell(0));
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["0"]);

    // Already on the first page: PageUp is a no-op that keeps focus put.
    fireEvent.keyDown(cell(0), { key: "PageUp" });
    expect(columnHeaders()[0]).toBe("Thu, Aug 20");
    expect(document.activeElement).toBe(cell(0));
  });

  test("arrow keys skip the empty cells of ragged date columns", () => {
    const short = {
      key: "date:2026-08-21",
      date: "2026-08-21",
      slots: HALF_HOURS.slice(0, 2).map((localStart, offset) => ({
        index: 10 + offset,
        localStart,
        localEnd: HALF_HOURS[offset + 1],
        startDayOffset: 0,
        endDayOffset: 0,
        startsAt: `2026-08-21T${localStart}:00Z`,
        endsAt: `2026-08-21T${HALF_HOURS[offset + 1]}:00Z`,
      })),
    };
    renderCalendar({
      event: {
        ...dateEvent,
        slotGroups: [
          dateGroup("2026-08-20", 0),
          short,
          dateGroup("2026-08-22", 20),
        ],
      },
      results: null,
      now: DATE_NOW,
    });

    const grid = screen.getByRole("grid");
    expect(
      grid.querySelectorAll(".meeting-calendar__cell--empty"),
    ).toHaveLength(2);
    grid.querySelectorAll(".meeting-calendar__cell--empty").forEach((empty) => {
      expect(empty).toHaveAttribute("role", "gridcell");
      expect(empty).toHaveAttribute("aria-disabled", "true");
      expect(empty).toHaveAccessibleName("Fri, no slot at this time");
      expect(empty).not.toHaveAttribute("tabindex");
    });

    act(() => cell(2).focus());
    // Row 3 has no Friday slot: ArrowRight lands on Saturday directly.
    fireEvent.keyDown(cell(2), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(22));
    fireEvent.keyDown(cell(22), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(2));
    fireEvent.keyDown(cell(2), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cell(1));
    fireEvent.keyDown(cell(1), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(11));
    // Bottom of the short column: ArrowDown has nowhere to go.
    fireEvent.keyDown(cell(11), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell(11));
    expect(tabbableCells()).toHaveLength(1);
  });

  test("previews the window on focus and hover only for startable cells", () => {
    renderCalendar();
    const preview = () =>
      document.querySelector(".meeting-calendar__block--preview");
    expect(preview()).toBeNull();

    act(() => cell(2).focus());
    expect(preview()).not.toBeNull();
    expect(preview().style.getPropertyValue("--rv-cal-col")).toBe("0");
    expect(preview().style.getPropertyValue("--rv-cal-row")).toBe("2");
    expect(preview().style.getPropertyValue("--rv-cal-span")).toBe("2");

    // A tail cell cannot start a window, so hovering it shows nothing.
    fireEvent.pointerOver(cell(3));
    expect(preview()).toBeNull();
    fireEvent.pointerOver(cell(5));
    expect(preview().style.getPropertyValue("--rv-cal-col")).toBe("1");
    fireEvent.pointerLeave(screen.getByRole("grid"));
    expect(preview()).toBeNull();
  });

  test("announces the confirmed meeting on its cells", () => {
    renderCalendar({
      event: {
        ...weeklyEvent,
        status: "finalized",
        finalMeeting: {
          startsAt: "2026-09-14T09:30:00Z",
          endsAt: "2026-09-14T10:30:00Z",
          channel: "inperson",
        },
      },
    });

    expect(cell(1).getAttribute("aria-label")).toContain(
      "Inside the confirmed meeting.",
    );
    expect(cell(2).getAttribute("aria-label")).toContain(
      "Inside the confirmed meeting.",
    );
    expect(cell(0).getAttribute("aria-label")).not.toContain("confirmed");
    expect(cell(3).getAttribute("aria-label")).not.toContain("confirmed");
    expect(cell(1).getAttribute("aria-label")).toContain(
      "Inside ranked window #1.",
    );
  });

  test("draws a ranked window only on weeks where it can be picked", async () => {
    // Los Angeles Sunday 01:00–04:00 in half-hour slots. The API only ever
    // suggests Sundays where every boundary of the window exists, so the
    // ranked 01:00–02:00 window must not carry a badge on 2026-03-08, where
    // its 02:00 boundary is the missing hour.
    const dstEvent = {
      ...weeklyEvent,
      timezone: "America/Los_Angeles",
      slotGroups: [
        {
          key: "weekday:0",
          slots: ["01:00", "01:30", "02:00", "02:30", "03:00", "03:30"].map(
            (localStart, index) => ({
              index,
              localStart,
              localEnd: ["01:30", "02:00", "02:30", "03:00", "03:30", "04:00"][
                index
              ],
              startDayOffset: 0,
              endDayOffset: 0,
            }),
          ),
        },
      ],
    };
    const dstRecommendation = {
      ...recommendation,
      slotIndices: [0, 1],
      groupKey: "weekday:0",
      weekday: 0,
      localStart: "01:00",
      localEnd: "02:00",
      suggestedStartsAt: "2026-03-15T08:00:00Z",
      suggestedEndsAt: "2026-03-15T09:00:00Z",
      label: "Sun 01:00–02:00",
    };
    // Sunday 2026-03-08 00:30 in Los Angeles: this week's window is still
    // open, so the calendar starts here rather than on the suggested week.
    renderCalendar({
      event: dstEvent,
      results: { ...results, recommendations: [dstRecommendation] },
      now: Date.parse("2026-03-08T08:30:00Z"),
    });

    expect(columnHeaders()).toEqual(["Sun, Mar 8"]);
    expect(cell(0)).toHaveAttribute("data-state", "dst");
    expect(document.querySelector(".meeting-calendar__block--rank")).toBeNull();
    expect(cell(0).getAttribute("title")).not.toContain("Inside ranked window");
    // Nothing is tabbable-by-rank on this week either: the first startable
    // cell takes the tab stop instead.
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["4"]);

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(columnHeaders()).toEqual(["Sun, Mar 15"]);
    const block = document.querySelector(".meeting-calendar__block--rank");
    expect(block).toHaveAttribute("data-rank", "1");
    expect(block.style.getPropertyValue("--rv-cal-row")).toBe("0");
    expect(cell(0)).toHaveAttribute("data-state", "startable");
    expect(cell(0).getAttribute("title")).toContain("Inside ranked window #1.");
    expect(tabbableCells().map((c) => c.dataset.cellIdx)).toEqual(["0"]);
  });

  test("keeps both fall-back fold slots pickable with verbatim instants and distinct labels", async () => {
    // API geometry for Los Angeles 2026-11-01 00:00–03:00 in half-hour
    // slots: 01:00 and 01:30 happen twice (PDT, then PST), so the date has
    // eight real slots; the day before has six.
    const utc = (hour, minute) =>
      `2026-11-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+00:00`;
    const foldSlots = [
      ["00:00", "00:30", "-07:00", utc(7, 0), utc(7, 30)],
      ["00:30", "01:00", "-07:00", utc(7, 30), utc(8, 0)],
      ["01:00", "01:30", "-07:00", utc(8, 0), utc(8, 30)],
      ["01:30", "01:00", "-07:00", utc(8, 30), utc(9, 0)],
      ["01:00", "01:30", "-08:00", utc(9, 0), utc(9, 30)],
      ["01:30", "02:00", "-08:00", utc(9, 30), utc(10, 0)],
      ["02:00", "02:30", "-08:00", utc(10, 0), utc(10, 30)],
      ["02:30", "03:00", "-08:00", utc(10, 30), utc(11, 0)],
    ].map(([localStart, localEnd, startOffset, startsAt, endsAt], offset) => ({
      index: 6 + offset,
      localStart,
      localEnd,
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt,
      endsAt,
      startOffset,
      endOffset: offset === 3 ? "-08:00" : startOffset,
      fold: startOffset === "-08:00" ? 1 : 0,
    }));
    const ordinarySlots = [
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "02:00",
      "02:30",
    ].map((localStart, offset) => ({
      index: offset,
      localStart,
      localEnd: ["00:30", "01:00", "01:30", "02:00", "02:30", "03:00"][offset],
      startDayOffset: 0,
      endDayOffset: 0,
      startsAt: `2026-10-31T${String(7 + Math.floor(offset / 2)).padStart(2, "0")}:${offset % 2 ? "30" : "00"}:00+00:00`,
      endsAt: `2026-10-31T${String(7 + Math.floor((offset + 1) / 2)).padStart(2, "0")}:${(offset + 1) % 2 ? "30" : "00"}:00+00:00`,
      startOffset: "-07:00",
      endOffset: "-07:00",
      fold: 0,
    }));
    const foldEvent = {
      ...dateEvent,
      timezone: "America/Los_Angeles",
      slotGroups: [
        { key: "date:2026-10-31", date: "2026-10-31", slots: ordinarySlots },
        { key: "date:2026-11-01", date: "2026-11-01", slots: foldSlots },
      ],
    };
    const { onSelect } = renderCalendar({
      event: foldEvent,
      results: null,
      now: Date.parse("2026-10-01T00:00:00Z"),
    });

    expect(columnHeaders()).toEqual(["Sat, Oct 31", "Sun, Nov 1"]);
    // Both 1:00 AM slots start a window; their labels carry the offset.
    expect(cell(8)).toHaveAttribute("data-state", "startable");
    expect(cell(10)).toHaveAttribute("data-state", "startable");
    expect(cell(8).getAttribute("title")).toContain(
      "1:00 AM – 1:30 AM (UTC-07:00)",
    );
    expect(cell(10).getAttribute("title")).toContain(
      "1:00 AM – 1:30 AM (UTC-08:00)",
    );
    expect(cell(2).getAttribute("title")).toContain("1:00 AM – 1:30 AM\n");
    expect(cell(2).getAttribute("title")).not.toContain("(UTC");
    // The ordinary column is shorter: its last two rows are empty cells.
    const rows = within(screen.getByRole("grid")).getAllByRole("row");
    expect(rows).toHaveLength(9);
    expect(
      document.querySelectorAll(".meeting-calendar__cell--empty"),
    ).toHaveLength(2);

    await userEvent.click(cell(10));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        startsAt: utc(9, 0),
        endsAt: utc(10, 0),
        slotIndices: [10, 11],
        groupKey: "date:2026-11-01",
        label: "2026-11-01 01:00–02:00",
      }),
    );
    await userEvent.click(cell(8));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startsAt: utc(8, 0),
        endsAt: utc(9, 0),
        slotIndices: [8, 9],
      }),
    );
  });

  test("shows an empty state when no slot groups are configured", () => {
    renderCalendar({ event: { ...weeklyEvent, slotGroups: [] } });

    expect(
      screen.getByRole("heading", {
        level: 4,
        name: "No schedule slots are configured.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next week" })).toBeNull();
    expect(document.querySelector("[data-cell-idx]")).toBeNull();
  });

  test("explains an unusable duration and an unknown time zone without offering picks", () => {
    const { rerender } = renderCalendar({
      event: { ...weeklyEvent, meetingDurationMinutes: 45 },
    });
    expect(cell(0)).toHaveAttribute("aria-disabled", "true");
    expect(cell(0)).toHaveAttribute("data-state", "invalid-duration");
    expect(cell(0)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("No meeting window can start here."),
    );
    expect(
      screen.getByText(/meeting duration .*slot length/i),
    ).toBeInTheDocument();

    // A time zone the browser cannot resolve leaves every boundary broken,
    // and "This week" still lands on the UTC week of today.
    rerender(
      <MeetingCalendar
        event={{ ...weeklyEvent, timezone: "Mars/Olympus_Mons" }}
        results={results}
        channel="inperson"
        onSelect={jest.fn()}
        now={NOW}
      />,
    );
    expect(cell(0)).toHaveAttribute("data-state", "dst");
    expect(cell(0)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Enter a valid IANA event timezone."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(columnHeaders()).toEqual(["Mon, Sep 14", "Wed, Sep 16"]);
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(columnHeaders()).toEqual(["Mon, Sep 7", "Wed, Sep 9"]);
  });

  test("moves left and to row ends across three columns and hides the preview over the selection", async () => {
    const threeDayEvent = {
      ...weeklyEvent,
      slotGroups: [
        { key: "weekday:1", slots: weekdaySlots(0) },
        { key: "weekday:2", slots: weekdaySlots(4) },
        { key: "weekday:3", slots: weekdaySlots(8) },
      ],
    };
    const threeDayResults = {
      ...results,
      channels: {
        inperson: {
          weighted: Array(12).fill(0.5),
          unweighted: Array(12).fill(0.5),
        },
      },
    };
    const selection = {
      channel: "inperson",
      startsAt: "2026-09-14T09:00:00.000Z",
      endsAt: "2026-09-14T10:00:00.000Z",
      slotIndices: [0, 1],
      groupKey: "weekday:1",
    };
    renderCalendar({
      event: threeDayEvent,
      results: threeDayResults,
      selection,
    });
    act(() => cell(9).focus());
    fireEvent.keyDown(cell(9), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(5));
    fireEvent.keyDown(cell(5), { key: "End" });
    expect(document.activeElement).toBe(cell(9));
    fireEvent.keyDown(cell(9), { key: "Home" });
    expect(document.activeElement).toBe(cell(1));
    // Unknown keys are ignored, and the row's first column has no left neighbour.
    fireEvent.keyDown(cell(1), { key: "Tab" });
    fireEvent.keyDown(cell(1), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(1));

    // Hovering a cell inside the selected window draws no extra preview.
    await userEvent.hover(cell(0));
    expect(
      document.querySelector(".meeting-calendar__block--preview"),
    ).toBeNull();
    await userEvent.hover(cell(4));
    expect(
      document.querySelector(".meeting-calendar__block--preview"),
    ).not.toBeNull();
  });

  test("labels overnight and offset slots so fall-back times stay distinct", () => {
    const overnightEvent = {
      ...weeklyEvent,
      timezone: "UTC",
      slotGroups: [
        {
          key: "weekday:6",
          slots: [
            {
              index: 0,
              localStart: "23:30",
              localEnd: "00:00",
              startDayOffset: 0,
              endDayOffset: 1,
              startOffset: "-07:00",
            },
            {
              index: 1,
              localStart: "00:00",
              localEnd: "00:30",
              startDayOffset: 1,
              endDayOffset: 1,
              startOffset: "-08:00",
            },
          ],
        },
      ],
    };
    renderCalendar({ event: overnightEvent, results: null });
    expect(cell(0)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("11:30 PM – 12:00 AM +1d (UTC-07:00)"),
    );
    expect(cell(1)).toHaveAttribute(
      "aria-label",
      expect.stringContaining("12:00 AM +1d – 12:30 AM +1d (UTC-08:00)"),
    );
    expect(screen.getByRole("rowheader", { name: /\+1d/ })).toBeInTheDocument();
    expect(
      document.querySelector(".meeting-calendar--overnight"),
    ).not.toBeNull();
  });
});
