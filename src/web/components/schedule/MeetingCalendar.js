"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import EmptyState from "@/components/ui/EmptyState";
import {
  AvailabilitySwatch,
  availabilityKey,
} from "@/components/ui/Availability";
import { lerpColor, lerpVirtualColor } from "@/components/ui/ColorUtils";
import {
  CalendarCheckIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GroupIcon,
  VirtualIcon,
} from "@/components/ui/icons";
import { formatTime } from "@/lib/format";
import { createLocalDateTimeResolver } from "@/lib/time";
import {
  addDays,
  buildColumns,
  cellMetrics,
  cellState,
  confirmedBlock,
  defaultView,
  formatRangeLabel,
  groupKind,
  localDateOf,
  normalizeSlotGroups,
  pageCount,
  rankedRecommendations,
  recommendationBlocks,
  selectionBlock,
  selectionFromWindow,
  weekStartOf,
  windowAt,
  windowSlotCount,
} from "@/lib/meetingWindows";

const CHANNELS = [
  { key: "inperson", label: "In person", Icon: GroupIcon },
  { key: "virtual", label: "Virtual", Icon: VirtualIcon },
];

const METRICS = [
  { key: "weighted", label: "Weighted" },
  { key: "unweighted", label: "Unweighted" },
];

// What the calendar draws while the recommended times are collapsed: nothing.
const NO_RECOMMENDATIONS = [];

function percent(value) {
  return value === null || value === undefined
    ? null
    : Math.max(0, Math.min(100, Math.round(value * 100)));
}

function reducedMotion() {
  return Boolean(
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
  );
}

// Scrolls the calendar's own container (never the page) just enough to show
// `cell` past the sticky header row and time column. `scrollIntoView` would
// also move every ancestor scroller, fighting the jump to the Finalize
// section that follows a pick.
function scrollContainerToCell(container, cell) {
  const containerRect = container.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const headerHeight =
    container.querySelector(".meeting-calendar__header")?.offsetHeight || 0;
  const timeWidth =
    container.querySelector(".meeting-calendar__time-header")?.offsetWidth || 0;
  const cellTop =
    cellRect.top -
    containerRect.top -
    container.clientTop +
    container.scrollTop;
  const cellLeft =
    cellRect.left -
    containerRect.left -
    container.clientLeft +
    container.scrollLeft;
  let top = container.scrollTop;
  let left = container.scrollLeft;
  if (cellTop - headerHeight < top) top = cellTop - headerHeight;
  else if (cellTop + cellRect.height > top + container.clientHeight)
    top = cellTop + cellRect.height - container.clientHeight;
  if (cellLeft - timeWidth < left) left = cellLeft - timeWidth;
  else if (cellLeft + cellRect.width > left + container.clientWidth)
    left = cellLeft + cellRect.width - container.clientWidth;
  top = Math.max(0, Math.round(top));
  left = Math.max(0, Math.round(left));
  const behavior = reducedMotion() ? "auto" : "smooth";
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top, left, behavior });
  } else {
    container.scrollTop = top;
    container.scrollLeft = left;
  }
}

// "1:00 AM – 1:30 AM"; with `withOffset`, "1:00 AM – 1:30 AM (UTC-07:00)" so
// the two 1:00 AM slots of a fall-back date can be told apart.
function slotTimeLabel(slot, withOffset = false) {
  const start = `${formatTime(slot.localStart)}${slot.startDayOffset ? ` +${slot.startDayOffset}d` : ""}`;
  const end = `${formatTime(slot.localEnd)}${slot.endDayOffset ? ` +${slot.endDayOffset}d` : ""}`;
  const offset =
    withOffset && slot.startOffset ? ` (UTC${slot.startOffset})` : "";
  return `${start} – ${end}${offset}`;
}

// A specific date whose slots do not all share one UTC offset crosses a
// daylight-saving change; its wall-clock times alone no longer identify a slot.
function hasMixedOffsets(column) {
  const offsets = new Set();
  column.slots.forEach((slot) => {
    if (slot.startOffset) offsets.add(slot.startOffset);
  });
  return offsets.size > 1;
}

// One sentence per `cellState`: startable, blocked, tail, past, dst; the
// default covers `invalid-duration`. `reason` overrides the generic sentence
// for `dst` (the boundary that failed) and for a `blocked` window whose own
// slot is open (it would merely run into a block).
function stateSentence({ state, reason, durationMinutes, windowLabel }) {
  switch (state) {
    case "startable":
      return `Starts a ${durationMinutes}-minute window ${windowLabel}.`;
    case "blocked":
      return reason || "This time is blocked for the event.";
    case "tail":
      return `Not enough time remains for a ${durationMinutes}-minute meeting.`;
    case "past":
      return "This time has passed.";
    case "dst":
      return reason || "This time cannot be scheduled.";
    default:
      return "No meeting window can start here.";
  }
}

const CalendarCell = memo(function CalendarCell({
  model,
  tabIndex,
  selected,
  columnIndex,
  mark,
  readOnly,
}) {
  if (!model) return null;
  // Blocked-times painting: the cell is a paint target on a neutral surface,
  // a red ✕ when marked; no availability tone, figure or pick state.
  if (mark !== undefined) {
    const label = `${model.editLabel}, ${mark ? "blocked" : "open"}`;
    return (
      <div
        role="gridcell"
        className="meeting-calendar__cell meeting-calendar__cell--paint"
        data-cell-idx={model.index}
        data-row={model.row}
        data-blocked-paint={mark ? "true" : "false"}
        aria-colindex={columnIndex + 2}
        aria-selected={mark ? "true" : "false"}
        aria-readonly={readOnly ? "true" : undefined}
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
      >
        <span className="meeting-calendar__cell-value" aria-hidden="true">
          {mark ? "✕" : ""}
        </span>
      </div>
    );
  }
  return (
    <div
      role="gridcell"
      className={`meeting-calendar__cell${model.neutral ? " meeting-calendar__cell--neutral" : ""}`}
      data-cell-idx={model.index}
      data-row={model.row}
      data-state={model.state}
      data-blocked-slot={model.blockedSlot ? "true" : undefined}
      data-level={model.level}
      aria-colindex={columnIndex + 2}
      aria-disabled={model.pickable ? undefined : "true"}
      aria-selected={selected ? "true" : undefined}
      aria-label={model.ariaLabel}
      title={model.title}
      tabIndex={tabIndex}
      style={
        model.background ? { backgroundColor: model.background } : undefined
      }
    >
      <span className="meeting-calendar__cell-value" aria-hidden="true">
        {model.percentText}
      </span>
    </div>
  );
});

function EmptyCell({ columnIndex, headerLabel }) {
  return (
    <div
      role="gridcell"
      className="meeting-calendar__cell meeting-calendar__cell--empty"
      aria-colindex={columnIndex + 2}
      aria-disabled="true"
      aria-label={`${headerLabel}, no slot at this time`}
    />
  );
}

/**
 * Calendar for reviewing group availability and picking the meeting window.
 *
 * Columns are real dates (the enabled weekdays of one week for weekly events,
 * or up to seven configured dates). Cells are shaded by weighted or
 * unweighted availability; ranked recommendations are drawn as outlined
 * blocks while `showRankedWindows` is true (the recommended times in the
 * Time Table's Finalize step are open), and picking a cell inside one still
 * yields that recommended time either way. Clicking (or pressing Enter/Space on) any startable cell selects a
 * window of the event's meeting duration beginning there. Only a slot the
 * organizer blocked (`data-blocked-slot`) is neutral: no share, no tone. An
 * open slot whose window would run into a block is unpickable too
 * (`data-state="blocked"`) but keeps its share, like a tail cell.
 *
 * `highlightRank` emphasizes one recommended time's outline (the chip the
 * organizer points at). The Finalize step's Other times picker shows what
 * it is choosing here too: `focusColumn` (a column key) highlights the day
 * it lists, and `previewWindow` (`{ startsAt, slotIndices, groupKey, label }`)
 * draws the time under the pointer or focus, when it is on screen.
 *
 * `pickLock` (a sentence saying why, e.g. the meeting is finalized) turns
 * picking off: no cell selects a window, nothing previews one, and the pick
 * itself is not drawn, so the confirmed meeting stands alone. The grid is
 * read-only and described by that sentence.
 *
 * With `blockedEditing` set (the Time Table's Blocked times step is open) the
 * calendar is the block editor: every slot cell paints the draft with the
 * step's brush (a stroke by pointer, Enter/Space by keyboard), and picking,
 * the overlays, the shading and the percentages are off until the step
 * closes. `blockedEditing` is `{ marks, onPaint(index), readOnly }`.
 */
const MeetingCalendar = forwardRef(function MeetingCalendar(
  {
    event,
    results = null,
    channel,
    onChannelChange,
    selection = null,
    onSelect,
    now = null,
    defaultMetric = "weighted",
    showRankedWindows = true,
    highlightRank = null,
    previewWindow = null,
    focusColumn = null,
    blockedEditing = null,
    pickLock = null,
  },
  ref,
) {
  const timeZone = event?.timezone || "UTC";
  const mixed = event?.mode === "mixed";
  const durationMinutes = Number(event?.meetingDurationMinutes) || 0;
  const [metric, setMetric] = useState(defaultMetric);
  const [view, setView] = useState(null);
  const [activeCellIndex, setActiveCellIndex] = useState(null);
  const [hoverIndex, setHoverIndex] = useState(null);
  const scrollRef = useRef(null);
  // Set by keyboard paging so focus follows the grid into the new range
  // instead of dropping to the document when the old cells unmount.
  const refocusAfterViewChange = useRef(false);
  // The blocked-times stroke in progress (see the paint handlers below).
  const strokeRef = useRef({
    active: false,
    pointerId: null,
    visited: new Set(),
  });
  const finishStroke = useCallback(() => {
    strokeRef.current = { active: false, pointerId: null, visited: new Set() };
  }, []);

  const resolver = useMemo(() => {
    try {
      return createLocalDateTimeResolver(timeZone);
    } catch (error) {
      return () => {
        throw error;
      };
    }
  }, [timeZone]);

  const groups = useMemo(() => normalizeSlotGroups(event), [event]);
  const kind = groupKind(groups);
  const k = windowSlotCount(event);
  // The same list the Time Table's ranked chips show.
  const recommendations = useMemo(
    () => rankedRecommendations(results),
    [results],
  );
  const painting = Boolean(blockedEditing);
  const paintReadOnly = painting && Boolean(blockedEditing.readOnly);
  const paintHelpId = useId();
  // Picking is off (see `pickLock`); the paint surface has its own lock.
  const pickLocked = Boolean(pickLock) && !painting;
  const pickLockHelpId = useId();
  // Locking (a meeting finalized, here or elsewhere) brings the calendar to
  // the confirmed meeting, from wherever a pick or browsing had taken it.
  const [seenLock, setSeenLock] = useState(Boolean(pickLock));
  if (Boolean(pickLock) !== seenLock) {
    setSeenLock(Boolean(pickLock));
    if (pickLock) {
      setView(null);
      setActiveCellIndex(null);
    }
  }

  const finalMeeting = event?.finalMeeting || null;
  // A locked calendar (painting or not) opens on the confirmed meeting, not
  // on a pick it no longer draws.
  const anchorSelection = pickLock ? null : selection;
  const autoView = useMemo(
    () =>
      defaultView({
        groups,
        selection: anchorSelection,
        finalMeeting,
        recommendations,
        channel,
        now,
        timeZone,
      }),
    [
      groups,
      anchorSelection,
      finalMeeting,
      recommendations,
      channel,
      now,
      timeZone,
    ],
  );
  const effectiveView = view || autoView;

  const columns = useMemo(
    () => buildColumns({ groups, view: effectiveView, resolver }),
    [groups, effectiveView, resolver],
  );
  const totalPages = pageCount(groups);
  const rangeLabel = formatRangeLabel({
    kind,
    view: effectiveView,
    groups,
    columns,
  });

  // Ranked windows are drawn only while the recommended list is open, and only
  // where they can still be picked: an occurrence that has passed, or one a
  // daylight-saving change breaks (the API never suggests those), would put
  // a badge on a hatched block.
  const drawnRecommendations =
    showRankedWindows && !painting ? recommendations : NO_RECOMMENDATIONS;
  const blocks = useMemo(
    () =>
      recommendationBlocks(drawnRecommendations, columns, channel).filter(
        (block) =>
          cellState({
            column: columns[block.columnIndex],
            row: block.row,
            k,
            now,
          }) === "startable",
      ),
    [drawnRecommendations, columns, channel, k, now],
  );
  // The pick, the confirmed meeting and the hover preview are picker chrome:
  // none of them shows on the paint surface. With picking locked the pick
  // is not drawn either: it would sit on (and label over) the confirmed
  // meeting it became.
  const selected = useMemo(
    () =>
      !painting && !pickLocked && selection?.channel === channel
        ? selectionBlock(selection, columns)
        : null,
    [painting, pickLocked, selection, columns, channel],
  );
  const confirmed = useMemo(() => {
    // A read-only paint surface (finalized event) keeps the confirmed
    // meeting in view; an editable one clears the surface for painting.
    if (painting && !paintReadOnly) return null;
    const block = confirmedBlock(finalMeeting, columns);
    if (!block) return null;
    if (block.channel && block.channel !== channel) return null;
    return block;
  }, [painting, paintReadOnly, finalMeeting, columns, channel]);

  const maxRows = columns.reduce(
    (largest, column) => Math.max(largest, column.slots.length),
    0,
  );
  const counted = results?.countedResponseTotal;
  const neutral = !results?.channels?.[channel];

  // Per-cell view models, keyed by slot index. Recomputed only when the data
  // behind them changes; hover/focus never touch this map.
  const cellModels = useMemo(() => {
    const models = new Map();
    const blockRankByIndex = new Map();
    blocks.forEach((block) => {
      const column = columns[block.columnIndex];
      column.slots.slice(block.row, block.row + block.span).forEach((slot) => {
        if (!blockRankByIndex.has(slot.index) && block.rank != null)
          blockRankByIndex.set(slot.index, block.rank);
      });
    });
    // The confirmed overlay is aria-hidden, so its cells say so themselves.
    const confirmedIndices = new Set(
      confirmed
        ? columns[confirmed.columnIndex].slots
            .slice(confirmed.row, confirmed.row + confirmed.span)
            .map((slot) => slot.index)
        : [],
    );
    columns.forEach((column, columnIndex) => {
      const mixedOffsets = hasMixedOffsets(column);
      column.slots.forEach((slot, row) => {
        const metrics = cellMetrics(results, channel, slot.index);
        const value = metrics[metric];
        const shown = value === null ? 0 : value;
        const state = cellState({ column, row, k, now });
        // "blocked" is a window state: it also covers the k-1 open slots
        // before a block. Only a slot the organizer actually blocked hides
        // its share (stored as 0.0); an open slot whose window merely runs
        // into a block keeps its real share, like tail/past/dst cells do.
        const blockedSlot = Boolean(slot.blocked);
        // A window fails on whichever of its k boundaries cannot be resolved,
        // which is not necessarily the clicked cell's own boundary.
        const reason =
          state === "dst"
            ? windowAt(column, row, k).error
            : state === "blocked" && !blockedSlot
              ? `A ${durationMinutes}-minute meeting starting here would overlap a blocked time.`
              : undefined;
        const endSlot =
          column.slots[Math.min(column.slots.length - 1, row + k - 1)];
        const windowLabel =
          state === "startable"
            ? `${formatTime(slot.localStart)} – ${formatTime(endSlot.localEnd)}`
            : "";
        const weightedPercent = percent(metrics.weighted);
        const unweightedPercent = percent(metrics.unweighted);
        // A blocked slot is excluded from results (its share is stored as 0),
        // so it is described only by its state, never by a percentage.
        const cellNeutral = neutral || blockedSlot;
        const availabilityText = blockedSlot
          ? null
          : neutral
            ? "No availability snapshot yet."
            : `Weighted ${weightedPercent ?? 0}%, unweighted ${unweightedPercent ?? 0}%${
                Number.isFinite(counted) ? ` of ${counted} responses` : ""
              }.`;
        const rank = blockRankByIndex.get(slot.index);
        const rankText = `${rank != null ? ` Inside recommended time #${rank}.` : ""}${
          confirmedIndices.has(slot.index)
            ? " Inside the confirmed meeting."
            : ""
        }`;
        // Locked, a time that could start a window says why it cannot.
        const pickable = state === "startable" && !pickLocked;
        const sentence =
          state === "startable" && pickLocked
            ? pickLock
            : stateSentence({
                state,
                reason,
                durationMinutes,
                windowLabel,
              });
        const when = `${column.headerLabel}, ${column.subLabel}, ${slotTimeLabel(slot, mixedOffsets)}`;
        const description = [availabilityText, sentence].filter(Boolean);
        models.set(slot.index, {
          index: slot.index,
          row,
          columnIndex,
          state,
          pickable,
          blockedSlot,
          level: availabilityKey(shown),
          neutral: cellNeutral,
          percentText:
            cellNeutral || value === null ? "" : `${percent(value)}%`,
          background: cellNeutral
            ? null
            : channel === "virtual"
              ? lerpVirtualColor(shown)
              : lerpColor(shown),
          ariaLabel: `${when}. ${description.join(" ")}${rankText}`,
          title: `${when}\n${description.join("\n")}${rankText ? `\n${rankText.trim()}` : ""}`,
          // While painting blocked times: a weekday mark applies to every
          // week, so the label names the weekday, not this week's date.
          editLabel:
            kind === "weekday"
              ? `${column.headerLabel} (every week), ${slotTimeLabel(slot, mixedOffsets)}`
              : `${when}`,
        });
      });
    });
    return models;
  }, [
    blocks,
    confirmed,
    columns,
    results,
    channel,
    metric,
    k,
    kind,
    now,
    neutral,
    counted,
    durationMinutes,
    pickLocked,
    pickLock,
  ]);

  const selectedIndices = useMemo(() => {
    if (!selected) return new Set();
    const column = columns[selected.columnIndex];
    return new Set(
      column.slots
        .slice(selected.row, selected.row + selected.span)
        .map((slot) => slot.index),
    );
  }, [selected, columns]);

  const positions = useMemo(
    () =>
      columns.flatMap((column, columnIndex) =>
        column.slots.map((slot, row) => ({
          index: slot.index,
          row,
          columnIndex,
        })),
      ),
    [columns],
  );
  const positionByIndex = useMemo(
    () => new Map(positions.map((position) => [position.index, position])),
    [positions],
  );

  const firstStartable = positions.find(
    (position) => cellModels.get(position.index)?.state === "startable",
  );
  const bestBlock = blocks.find((block) => block.best) || null;
  // One tab stop: the focused cell, else the selected window, else the
  // confirmed meeting, else the best ranked window, else the first startable
  // cell. While painting every cell is a target, so the focused cell or the
  // first one.
  let rovingIndex = positions[0]?.index;
  if (positionByIndex.has(activeCellIndex)) rovingIndex = activeCellIndex;
  else if (painting) rovingIndex = positions[0]?.index;
  else if (selected)
    rovingIndex = columns[selected.columnIndex].slots[selected.row]?.index;
  else if (confirmed)
    rovingIndex = columns[confirmed.columnIndex].slots[confirmed.row]?.index;
  else if (bestBlock)
    rovingIndex = columns[bestBlock.columnIndex].slots[bestBlock.row]?.index;
  else if (firstStartable) rovingIndex = firstStartable.index;

  // What the Other times picker is pointing at, and the day it lists.
  const candidateBlock = useMemo(() => {
    if (painting || pickLocked || !previewWindow) return null;
    const block = selectionBlock(previewWindow, columns);
    if (!block) return null;
    // Only a time that can still be picked, and not the pick itself (its
    // own block and label already show it).
    const index = columns[block.columnIndex].slots[block.row]?.index;
    if (cellModels.get(index)?.state !== "startable") return null;
    if (
      selected &&
      selected.columnIndex === block.columnIndex &&
      selected.row === block.row &&
      selected.span === block.span
    )
      return null;
    return block;
  }, [painting, pickLocked, previewWindow, columns, cellModels, selected]);
  const focusColumnIndex =
    painting || !focusColumn
      ? -1
      : columns.findIndex((column) => column.key === focusColumn);

  const previewBlock = useMemo(() => {
    if (painting || pickLocked) return null;
    const index = hoverIndex ?? null;
    if (index === null) return null;
    const model = cellModels.get(index);
    if (!model || model.state !== "startable") return null;
    if (selectedIndices.has(index) && selected && selected.row === model.row)
      return null;
    return { columnIndex: model.columnIndex, row: model.row, span: k };
  }, [
    painting,
    pickLocked,
    hoverIndex,
    cellModels,
    selectedIndices,
    selected,
    k,
  ]);

  const navigate = useCallback(
    (direction) => {
      if (kind === "weekday") {
        setView({ weekStart: addDays(effectiveView.weekStart, 7 * direction) });
        return;
      }
      const page = Math.max(
        0,
        Math.min(totalPages - 1, (effectiveView.page || 0) + direction),
      );
      setView({ page });
    },
    [kind, effectiveView, totalPages],
  );

  const goToThisWeek = useCallback(() => {
    let today;
    try {
      today = localDateOf(new Date(now ?? Date.now()).toISOString(), timeZone);
    } catch {
      today = new Date(now ?? Date.now()).toISOString().slice(0, 10);
    }
    setView({ weekStart: weekStartOf(today) });
  }, [now, timeZone]);

  const scrollCellIntoView = useCallback((index) => {
    if (typeof window === "undefined") return;
    window.setTimeout(() => {
      const container = scrollRef.current;
      const cell = container?.querySelector(`[data-cell-idx="${index}"]`);
      if (container && cell) scrollContainerToCell(container, cell);
    }, 0);
  }, []);

  // What a picker points at (an Other time, or a recommended chip's
  // outline): the grid scrolls, inside itself, to show it.
  const highlightedBlock =
    highlightRank == null
      ? null
      : blocks.find((block) => block.rank === highlightRank) || null;
  const emphasis = candidateBlock || highlightedBlock;
  const emphasisIndex = emphasis
    ? (columns[emphasis.columnIndex].slots[emphasis.row]?.index ?? null)
    : null;
  useEffect(() => {
    if (emphasisIndex != null) scrollCellIntoView(emphasisIndex);
  }, [emphasisIndex, scrollCellIntoView]);

  // After PageUp/PageDown the focused cell may have unmounted (specific-date
  // pages render different slots); put focus back on the grid's tab stop.
  useEffect(() => {
    if (!refocusAfterViewChange.current) return;
    refocusAfterViewChange.current = false;
    const active = scrollRef.current?.querySelector(
      '[role="gridcell"][tabindex="0"]',
    );
    if (active && active !== document.activeElement) active.focus();
  }, [effectiveView]);

  // A stroke that leaves the grid still ends when the pointer is released
  // anywhere, or when the window loses focus mid-stroke. Keyed on the mode,
  // not on `blockedEditing` itself: every paint hands the calendar a new
  // marks array, and re-running this effect then would cut the stroke short
  // after its first cell.
  useEffect(() => {
    if (!painting) return undefined;
    window.addEventListener("pointerup", finishStroke);
    window.addEventListener("pointercancel", finishStroke);
    window.addEventListener("blur", finishStroke);
    return () => {
      finishStroke();
      window.removeEventListener("pointerup", finishStroke);
      window.removeEventListener("pointercancel", finishStroke);
      window.removeEventListener("blur", finishStroke);
    };
  }, [painting, finishStroke]);

  useImperativeHandle(
    ref,
    () => ({
      reveal(target) {
        if (!target) return;
        const next = defaultView({
          groups,
          selection: target,
          recommendations: [],
          now,
          timeZone,
        });
        setView(next);
        const first = Array.isArray(target.slotIndices)
          ? target.slotIndices[0]
          : null;
        if (first != null) {
          setActiveCellIndex(first);
          scrollCellIntoView(first);
        }
      },
      // Moves the calendar to show `target` (its week or page, and the grid
      // scrolled to it) without moving the grid's tab stop: for a picker
      // browsing days, not for a pick. Returns whether the week or page
      // changed (its range label then announces the move).
      showWindow(target) {
        if (!target) return false;
        const next = defaultView({
          groups,
          selection: target,
          recommendations: [],
          now,
          timeZone,
        });
        setView(next);
        const first = Array.isArray(target.slotIndices)
          ? target.slotIndices[0]
          : null;
        if (first != null) scrollCellIntoView(first);
        return (
          next.weekStart !== effectiveView.weekStart ||
          (next.page ?? 0) !== (effectiveView.page ?? 0)
        );
      },
    }),
    [groups, now, timeZone, scrollCellIntoView, effectiveView],
  );

  const selectCell = useCallback(
    (index) => {
      if (pickLocked) return;
      const position = positionByIndex.get(index);
      if (!position) return;
      const model = cellModels.get(index);
      if (!model || model.state !== "startable") return;
      const nextSelection = selectionFromWindow({
        column: columns[position.columnIndex],
        row: position.row,
        k,
        channel,
        results,
        event,
        recommendations,
      });
      if (nextSelection) onSelect?.(nextSelection);
    },
    [
      pickLocked,
      positionByIndex,
      cellModels,
      columns,
      k,
      channel,
      results,
      event,
      recommendations,
      onSelect,
    ],
  );

  const cellIndexFromEvent = (domEvent) => {
    const cell = domEvent.target?.closest?.("[data-cell-idx]");
    if (!cell) return null;
    const index = Number(cell.dataset.cellIdx);
    return Number.isInteger(index) ? index : null;
  };

  const focusCell = (index) => {
    setActiveCellIndex(index);
    setHoverIndex(index);
    scrollRef.current?.querySelector(`[data-cell-idx="${index}"]`)?.focus();
  };

  const moveFocus = (index, key, ctrl) => {
    const current = positionByIndex.get(index);
    if (!current) return false;
    let candidates = [];
    if (key === "ArrowRight") {
      candidates = positions
        .filter(
          (p) => p.row === current.row && p.columnIndex > current.columnIndex,
        )
        .sort((a, b) => a.columnIndex - b.columnIndex);
    } else if (key === "ArrowLeft") {
      candidates = positions
        .filter(
          (p) => p.row === current.row && p.columnIndex < current.columnIndex,
        )
        .sort((a, b) => b.columnIndex - a.columnIndex);
    } else if (key === "ArrowDown") {
      candidates = positions
        .filter(
          (p) => p.columnIndex === current.columnIndex && p.row > current.row,
        )
        .sort((a, b) => a.row - b.row);
    } else if (key === "ArrowUp") {
      candidates = positions
        .filter(
          (p) => p.columnIndex === current.columnIndex && p.row < current.row,
        )
        .sort((a, b) => b.row - a.row);
    } else if (key === "Home" && ctrl) {
      candidates = positions;
    } else if (key === "End" && ctrl) {
      candidates = [...positions].reverse();
    } else if (key === "Home") {
      candidates = positions
        .filter((p) => p.row === current.row)
        .sort((a, b) => a.columnIndex - b.columnIndex);
    } else if (key === "End") {
      candidates = positions
        .filter((p) => p.row === current.row)
        .sort((a, b) => b.columnIndex - a.columnIndex);
    } else {
      return false;
    }
    const target = candidates[0];
    if (target && target.index !== index) focusCell(target.index);
    return true;
  };

  // Blocked-times painting. A stroke starts on pointerdown, paints each cell
  // it crosses once (pointer capture keeps the events coming while the
  // pointer leaves the grid, so the cell under it is hit-tested), and ends
  // on pointerup, cancel, lost capture, or the window losing focus. Enter
  // and Space paint the focused cell. Painting never picks a window.
  const paintIndex = (index) => {
    if (!painting || paintReadOnly || !positionByIndex.has(index)) return;
    blockedEditing.onPaint(index);
  };

  const handlePointerDown = (domEvent) => {
    if (paintReadOnly || domEvent.button > 0) return;
    const index = cellIndexFromEvent(domEvent);
    if (index === null) return;
    domEvent.preventDefault();
    strokeRef.current = {
      active: true,
      pointerId: domEvent.pointerId,
      visited: new Set([index]),
    };
    domEvent.currentTarget.setPointerCapture?.(domEvent.pointerId);
    // Tab returns to the last painted cell.
    setActiveCellIndex(index);
    paintIndex(index);
  };

  const handlePointerMove = (domEvent) => {
    const stroke = strokeRef.current;
    if (!stroke.active || stroke.pointerId !== domEvent.pointerId) return;
    domEvent.preventDefault();
    const hit = document
      .elementFromPoint?.(domEvent.clientX, domEvent.clientY)
      ?.closest?.("[data-cell-idx]");
    if (!hit || !scrollRef.current?.contains(hit)) return;
    const index = Number(hit.dataset.cellIdx);
    if (stroke.visited.has(index)) return;
    stroke.visited.add(index);
    paintIndex(index);
  };

  const handleKeyDown = (domEvent) => {
    const index = cellIndexFromEvent(domEvent);
    if (index === null) return;
    if (domEvent.key === "Enter" || domEvent.key === " ") {
      domEvent.preventDefault();
      if (painting) paintIndex(index);
      else selectCell(index);
      return;
    }
    if (domEvent.key === "PageDown" || domEvent.key === "PageUp") {
      domEvent.preventDefault();
      refocusAfterViewChange.current = true;
      navigate(domEvent.key === "PageDown" ? 1 : -1);
      return;
    }
    if (moveFocus(index, domEvent.key, domEvent.ctrlKey || domEvent.metaKey))
      domEvent.preventDefault();
  };

  const handleClick = (domEvent) => {
    // The stroke already painted on pointerdown; a click must never pick.
    if (painting) return;
    const index = cellIndexFromEvent(domEvent);
    if (index !== null) selectCell(index);
  };

  const handleFocus = (domEvent) => {
    const index = cellIndexFromEvent(domEvent);
    if (index === null) return;
    setActiveCellIndex(index);
    setHoverIndex(index);
  };

  const handlePointerOver = (domEvent) => {
    const index = cellIndexFromEvent(domEvent);
    if (index !== null) setHoverIndex(index);
  };

  const handlePointerLeave = () => setHoverIndex(null);

  if (!groups.length) {
    return (
      <EmptyState
        headingLevel={4}
        icon={<CalendarIcon />}
        title="No schedule slots are configured."
      >
        <p className="mb-0">
          Edit the event schedule to add days and a time range first.
        </p>
      </EmptyState>
    );
  }

  const rowTemplate = `var(--rv-cal-time-w) repeat(${columns.length}, minmax(0, 1fr))`;
  const overnight = groups.some((group) =>
    group.slots.some((slot) => slot.startDayOffset || slot.endDayOffset),
  );
  // Once a meeting is confirmed the ranked outlines recede so it stands out.
  const finalized = Boolean(finalMeeting) && finalMeeting.active !== false;
  const previousLabel = kind === "weekday" ? "Previous week" : "Previous dates";
  const nextLabel = kind === "weekday" ? "Next week" : "Next dates";
  const gridLabel = `Meeting time calendar, ${rangeLabel}`;

  return (
    <div
      className={`meeting-calendar${overnight ? " meeting-calendar--overnight" : ""}${finalized ? " meeting-calendar--finalized" : ""}${painting ? " meeting-calendar--painting" : ""}${pickLocked ? " meeting-calendar--pick-locked" : ""}`}
      data-channel={channel}
      data-metric={metric}
      data-mode={painting ? "blocked-editing" : undefined}
      style={{ "--rv-cal-columns": columns.length }}
    >
      <div className="meeting-calendar__toolbar">
        {mixed && (
          <div role="group" aria-label="Meeting channel" className="btn-group">
            {CHANNELS.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={`btn app-btn ${channel === key ? "btn-primary" : "btn-outline-secondary"}`}
                aria-pressed={channel === key}
                onClick={() => onChannelChange?.(key)}
              >
                <span className="app-btn-icon" aria-hidden="true">
                  <Icon />
                </span>
                {label}
              </button>
            ))}
          </div>
        )}
        {painting ? (
          <span className="meeting-calendar__mode">
            {paintReadOnly
              ? "Blocked times (read-only)"
              : "Marking blocked times"}
          </span>
        ) : (
          <div role="group" aria-label="Shading" className="btn-group">
            {METRICS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`btn ${metric === key ? "btn-primary" : "btn-outline-secondary"}`}
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div
          role="group"
          aria-label="Calendar range"
          className="meeting-calendar__range"
        >
          {/* One boxed control: previous, the range shown, next. */}
          <div className="meeting-calendar__stepper">
            <button
              type="button"
              className="btn btn-outline-secondary app-btn"
              aria-label={previousLabel}
              onClick={() => navigate(-1)}
              disabled={kind === "date" && (effectiveView.page || 0) <= 0}
            >
              <span className="app-btn-icon" aria-hidden="true">
                <ChevronLeftIcon />
              </span>
            </button>
            <span className="meeting-calendar__range-label" aria-live="polite">
              {rangeLabel}
            </span>
            <button
              type="button"
              className="btn btn-outline-secondary app-btn"
              aria-label={nextLabel}
              onClick={() => navigate(1)}
              disabled={
                kind === "date" && (effectiveView.page || 0) >= totalPages - 1
              }
            >
              <span className="app-btn-icon" aria-hidden="true">
                <ChevronRightIcon />
              </span>
            </button>
          </div>
          {kind === "weekday" && (
            <button
              type="button"
              className="btn btn-outline-secondary app-btn meeting-calendar__today"
              onClick={goToThisWeek}
            >
              <span className="app-btn-icon" aria-hidden="true">
                <CalendarIcon />
              </span>
              This week
            </button>
          )}
        </div>
      </div>

      {painting && (
        <p id={paintHelpId} className="visually-hidden">
          {paintReadOnly
            ? "Blocked times are read-only for this event: the marks show what is blocked, and painting is off until the event is reactivated."
            : "Press Enter or Space to mark the focused time with the selected brush. Drag with a pointer to paint several times."}
          {kind === "weekday"
            ? " A mark applies to that weekday every week."
            : ""}
        </p>
      )}
      {pickLocked && (
        <p id={pickLockHelpId} className="visually-hidden">
          {pickLock}
        </p>
      )}

      <div className="meeting-calendar__scroll" ref={scrollRef}>
        <div className="meeting-calendar__canvas">
          <div
            className="meeting-calendar__grid"
            role="grid"
            aria-label={
              painting ? `${gridLabel}, marking blocked times` : gridLabel
            }
            aria-multiselectable={painting ? "true" : undefined}
            aria-readonly={paintReadOnly || pickLocked ? "true" : undefined}
            aria-describedby={
              painting ? paintHelpId : pickLocked ? pickLockHelpId : undefined
            }
            aria-colcount={columns.length + 1}
            aria-rowcount={maxRows + 1}
            onKeyDown={handleKeyDown}
            onClick={handleClick}
            onFocus={handleFocus}
            onPointerOver={handlePointerOver}
            onPointerLeave={handlePointerLeave}
            onPointerDown={painting ? handlePointerDown : undefined}
            onPointerMove={painting ? handlePointerMove : undefined}
            onPointerUp={painting ? finishStroke : undefined}
            onPointerCancel={painting ? finishStroke : undefined}
            onLostPointerCapture={painting ? finishStroke : undefined}
          >
            <div
              className="meeting-calendar__header"
              role="row"
              aria-rowindex={1}
              style={{ gridTemplateColumns: rowTemplate }}
            >
              <div
                className="meeting-calendar__time-header"
                role="columnheader"
                aria-colindex={1}
              >
                Time
              </div>
              {columns.map((column, columnIndex) => (
                <div
                  key={column.key}
                  className={`meeting-calendar__column-header${columnIndex === focusColumnIndex ? " meeting-calendar__column-header--focus" : ""}`}
                  role="columnheader"
                  aria-colindex={columnIndex + 2}
                  title={`${column.headerLabel}, ${column.subLabel}`}
                >
                  <span className="meeting-calendar__column-day">
                    {column.headerLabel}
                  </span>
                  <span className="meeting-calendar__column-date">
                    {column.subLabel}
                  </span>
                </div>
              ))}
            </div>
            <div role="rowgroup">
              {Array.from({ length: maxRows }, (_, row) => {
                const firstSlot = columns.find((column) => column.slots[row])
                  ?.slots[row];
                return (
                  <div
                    key={row}
                    className="meeting-calendar__row"
                    role="row"
                    aria-rowindex={row + 2}
                    style={{ gridTemplateColumns: rowTemplate }}
                  >
                    <div
                      className="meeting-calendar__row-header"
                      role="rowheader"
                      aria-colindex={1}
                    >
                      {firstSlot ? formatTime(firstSlot.localStart) : ""}
                      {firstSlot?.startDayOffset ? (
                        <small> +{firstSlot.startDayOffset}d</small>
                      ) : null}
                    </div>
                    {columns.map((column, columnIndex) => {
                      const slot = column.slots[row];
                      if (!slot) {
                        return (
                          <EmptyCell
                            key={`${column.key}:empty:${row}`}
                            columnIndex={columnIndex}
                            headerLabel={column.headerLabel}
                          />
                        );
                      }
                      return (
                        <CalendarCell
                          key={slot.index}
                          model={cellModels.get(slot.index)}
                          columnIndex={columnIndex}
                          tabIndex={slot.index === rovingIndex ? 0 : -1}
                          selected={selectedIndices.has(slot.index)}
                          mark={
                            painting
                              ? Number(blockedEditing.marks[slot.index]) > 0
                              : undefined
                          }
                          readOnly={paintReadOnly}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="meeting-calendar__overlays" aria-hidden="true">
            {focusColumnIndex >= 0 && (
              <div
                className="meeting-calendar__column-focus"
                style={{
                  "--rv-cal-col": focusColumnIndex,
                  "--rv-cal-span": maxRows,
                }}
              />
            )}
            {blocks.map((block) => (
              <div
                key={block.key}
                className={`meeting-calendar__block meeting-calendar__block--rank${block.best ? " meeting-calendar__block--best" : ""}${block.rank != null && block.rank === highlightRank ? " meeting-calendar__block--highlight" : ""}`}
                data-rank={block.rank ?? undefined}
                style={{
                  "--rv-cal-col": block.columnIndex,
                  "--rv-cal-row": block.row,
                  "--rv-cal-span": block.span,
                }}
              >
                {block.rank != null && (
                  <span className="meeting-calendar__rank">#{block.rank}</span>
                )}
              </div>
            ))}
            {confirmed && (
              <div
                className="meeting-calendar__block meeting-calendar__block--confirmed"
                style={{
                  "--rv-cal-col": confirmed.columnIndex,
                  "--rv-cal-row": confirmed.row,
                  "--rv-cal-span": confirmed.span,
                }}
              >
                <span className="meeting-calendar__block-label">
                  <CalendarCheckIcon />
                  <span className="meeting-calendar__block-label-text">
                    Confirmed
                  </span>
                </span>
              </div>
            )}
            {previewBlock && (
              <div
                className="meeting-calendar__block meeting-calendar__block--preview"
                style={{
                  "--rv-cal-col": previewBlock.columnIndex,
                  "--rv-cal-row": previewBlock.row,
                  "--rv-cal-span": previewBlock.span,
                }}
              />
            )}
            {candidateBlock && (
              <div
                className="meeting-calendar__block meeting-calendar__block--preview meeting-calendar__block--candidate"
                style={{
                  "--rv-cal-col": candidateBlock.columnIndex,
                  "--rv-cal-row": candidateBlock.row,
                  "--rv-cal-span": candidateBlock.span,
                }}
              >
                {previewWindow.label && (
                  <span className="meeting-calendar__block-label meeting-calendar__block-label--candidate">
                    {previewWindow.label}
                  </span>
                )}
              </div>
            )}
            {selected && (
              <div
                className="meeting-calendar__block meeting-calendar__block--selected"
                style={{
                  "--rv-cal-col": selected.columnIndex,
                  "--rv-cal-row": selected.row,
                  "--rv-cal-span": selected.span,
                }}
              >
                <span className="meeting-calendar__block-label">Selected</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <ul className="meeting-calendar__legend" aria-label="Calendar legend">
        {painting ? (
          <>
            <li className="meeting-calendar__legend-item">
              <AvailabilitySwatch level="blocked-paint" />
              <span>Blocked</span>
            </li>
            <li className="meeting-calendar__legend-item">
              <AvailabilitySwatch level="open" />
              <span>Open</span>
            </li>
          </>
        ) : (
          <>
            <li className="meeting-calendar__legend-item">
              <span
                className="meeting-calendar__legend-gradient"
                aria-hidden="true"
              />
              <span>0% → 100% of responses free ({metric})</span>
            </li>
            {showRankedWindows && (
              <li className="meeting-calendar__legend-item">
                <span
                  className="meeting-calendar__legend-swatch meeting-calendar__legend-swatch--rank"
                  aria-hidden="true"
                />
                <span>Recommended time</span>
              </li>
            )}
            {!pickLocked && (
              <li className="meeting-calendar__legend-item">
                <span
                  className="meeting-calendar__legend-swatch meeting-calendar__legend-swatch--selected"
                  aria-hidden="true"
                />
                <span>Selected window</span>
              </li>
            )}
            {event?.finalMeeting && (
              <li className="meeting-calendar__legend-item">
                <span
                  className="meeting-calendar__legend-swatch meeting-calendar__legend-swatch--confirmed"
                  aria-hidden="true"
                />
                <span>Confirmed meeting</span>
              </li>
            )}
          </>
        )}
      </ul>

      {painting && kind === "weekday" && (
        <p className="meeting-calendar__note">
          Blocked times repeat every week.
        </p>
      )}
      {!painting && !pickLocked && k < 1 && (
        <p className="meeting-calendar__note">
          The meeting duration does not divide into the slot length, so no
          window can be picked. Edit the event to fix the duration.
        </p>
      )}
      {!painting && k >= 1 && neutral && (
        <p className="meeting-calendar__note">
          Availability shading appears once the first results snapshot is ready.
          {pickLocked ? "" : " You can already pick any window."}
        </p>
      )}
      {!painting &&
        !pickLocked &&
        k >= 1 &&
        !neutral &&
        !firstStartable &&
        columns.length > 0 && (
          <p className="meeting-calendar__note">
            No window can start in this range. Move to another{" "}
            {kind === "weekday" ? "week" : "page"} or edit the event schedule.
          </p>
        )}
    </div>
  );
});

export default MeetingCalendar;
