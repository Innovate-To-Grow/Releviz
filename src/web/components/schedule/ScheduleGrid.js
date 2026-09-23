"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { lerpColor, lerpVirtualColor } from "@/components/ui/ColorUtils";
import { availabilityKey } from "@/components/ui/Availability";
import { formatTime } from "@/lib/format";

const TIME_COLUMN_WIDTH = 72;
const MIN_COLUMN_WIDTH = 88;

function slotLabel(slot) {
  const startDay = slot.startDayOffset ? ` +${slot.startDayOffset}d` : "";
  const endDay = slot.endDayOffset ? ` +${slot.endDayOffset}d` : "";
  const startOffset = slot.startOffset ? ` ${slot.startOffset}` : "";
  const endOffset = slot.endOffset ? ` ${slot.endOffset}` : "";
  return `${formatTime(slot.localStart)}${startDay}${startOffset} – ${formatTime(
    slot.localEnd,
  )}${endDay}${endOffset}`;
}

// Non-color cue rendered inside editable cells. Read-only aggregate grids show
// the numeric value instead (see `showValues`).
function cellGlyph(level) {
  if (level === "free") return "✓";
  if (level === "partial") return "◐";
  return "";
}

/**
 * Availability grid: columns are days (or dates), rows are time slots.
 *
 * Interaction model (unchanged from the previous design):
 * - pointer down starts a stroke and paints the cell; moving over other cells
 *   while the pointer is held paints them once each (mouse, pen, touch);
 * - Enter/Space paints the focused cell; arrow keys, Home/End and Ctrl+Home/End
 *   move a roving tab stop between cells;
 * - `readOnly` grids expose values without tab stops.
 *
 * `label` renders a visible title and names the grid; `ariaLabel` names it
 * without a title, for hosts that already show a heading.
 *
 * Organizer-blocked slots (`slot.blocked`) keep their grid position and index
 * but render as inert grey-striped cells: no availability colour or glyph
 * (whatever value is stored at that index), no tab stop, no pointer or
 * keyboard handlers, and strokes and arrow keys pass over them.
 *
 * `blockedEditing` turns the grid into the organizer's blocked-times editor:
 * `slot.blocked` is ignored because `schedule` IS the block map being edited
 * (any value > 0 marks the slot blocked), every slot is paintable exactly like
 * availability mode, and cells expose `data-blocked-paint` plus a ✕ glyph
 * instead of `data-availability` and an inline colour.
 */
function ScheduleGrid({
  schedule = [],
  slotGroups = [],
  readOnly,
  showValues,
  onCellPaint,
  label,
  ariaLabel,
  virtual = false,
  participantDetails,
  compact = false,
  blockedEditing = false,
}) {
  const strokeRef = useRef({
    active: false,
    pointerId: null,
    pointerType: "",
    visited: new Set(),
  });
  const cellRefs = useRef(new Map());
  const [activeCellIndex, setActiveCellIndex] = useState(null);
  const groups = Array.isArray(slotGroups) ? slotGroups : [];
  const maxRows = groups.reduce(
    (largest, group) => Math.max(largest, group?.slots?.length || 0),
    0,
  );
  const isBlocked = (slot) => !blockedEditing && slot?.blocked === true;
  // Blocked cells are inert, so they take no part in the roving tab stop or
  // arrow-key movement and strokes never paint them.
  const cellPositions = groups.flatMap((group, column) =>
    (group?.slots || []).flatMap((slot, row) =>
      slot && !isBlocked(slot) ? [{ index: slot.index, row, column }] : [],
    ),
  );
  const blockedIndices = new Set(
    groups.flatMap((group) =>
      (group?.slots || []).flatMap((slot) =>
        isBlocked(slot) ? [slot.index] : [],
      ),
    ),
  );
  const positionByIndex = new Map(
    cellPositions.map((position) => [position.index, position]),
  );
  const rovingCellIndex = positionByIndex.has(activeCellIndex)
    ? activeCellIndex
    : cellPositions[0]?.index;

  const finishStroke = useCallback(() => {
    strokeRef.current = {
      active: false,
      pointerId: null,
      pointerType: "",
      visited: new Set(),
    };
  }, []);

  useEffect(() => {
    const finish = () => finishStroke();
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [finishStroke]);

  const paintCell = (index, event, phase) => {
    if (readOnly || !onCellPaint || blockedIndices.has(index)) return;
    if (strokeRef.current.visited.has(index) && phase !== "keyboard") return;
    if (phase !== "keyboard") strokeRef.current.visited.add(index);
    onCellPaint(index, {
      phase,
      pointerType:
        event.pointerType || (phase === "keyboard" ? "keyboard" : "mouse"),
      type:
        phase === "keyboard"
          ? "keydown"
          : phase === "start"
            ? "pointerdown"
            : "pointermove",
    });
  };

  const startStroke = (index, event) => {
    if (readOnly || !onCellPaint || event.button > 0) return;
    event.preventDefault();
    strokeRef.current = {
      active: true,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      visited: new Set(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    paintCell(index, event, "start");
  };

  const continueStroke = (event) => {
    const stroke = strokeRef.current;
    if (!stroke.active || stroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    const element = document.elementFromPoint?.(event.clientX, event.clientY);
    const cell = element?.closest?.("[data-cell-idx]");
    if (cell?.dataset?.blocked === "true") return;
    const targetIndex = cell?.dataset?.cellIdx;
    if (targetIndex !== undefined) {
      paintCell(Number(targetIndex), event, "move");
    }
  };

  const moveKeyboardFocus = (index, event) => {
    const current = positionByIndex.get(index);
    if (!current) return;

    let candidates = [];
    if (event.key === "ArrowRight") {
      candidates = cellPositions
        .filter(
          (cell) => cell.row === current.row && cell.column > current.column,
        )
        .sort((a, b) => a.column - b.column);
    } else if (event.key === "ArrowLeft") {
      candidates = cellPositions
        .filter(
          (cell) => cell.row === current.row && cell.column < current.column,
        )
        .sort((a, b) => b.column - a.column);
    } else if (event.key === "ArrowDown") {
      candidates = cellPositions
        .filter(
          (cell) => cell.column === current.column && cell.row > current.row,
        )
        .sort((a, b) => a.row - b.row);
    } else if (event.key === "ArrowUp") {
      candidates = cellPositions
        .filter(
          (cell) => cell.column === current.column && cell.row < current.row,
        )
        .sort((a, b) => b.row - a.row);
    } else if (event.key === "Home" && event.ctrlKey) {
      candidates = cellPositions;
    } else if (event.key === "End" && event.ctrlKey) {
      candidates = [...cellPositions].reverse();
    } else if (event.key === "Home") {
      candidates = cellPositions
        .filter((cell) => cell.row === current.row)
        .sort((a, b) => a.column - b.column);
    } else if (event.key === "End") {
      candidates = cellPositions
        .filter((cell) => cell.row === current.row)
        .sort((a, b) => b.column - a.column);
    } else {
      return;
    }

    const target = candidates[0];
    if (!target || target.index === index) return;
    event.preventDefault();
    setActiveCellIndex(target.index);
    cellRefs.current.get(target.index)?.focus();
  };

  const columnWidth = compact ? 72 : MIN_COLUMN_WIDTH;
  const rowTemplate = `${TIME_COLUMN_WIDTH}px repeat(${groups.length}, minmax(${columnWidth}px, 1fr))`;

  return (
    <div
      className={`schedule-grid-shell${compact ? " schedule-grid-shell--compact" : ""}`}
    >
      {label && <h4 className="schedule-grid-title">{label}</h4>}
      <div
        className="schedule-grid-scroll"
        // Read-only grids have no focusable cells, so the scroll region itself
        // must be reachable from the keyboard.
        tabIndex={readOnly && groups.length > 0 ? 0 : undefined}
      >
        {groups.length === 0 ? (
          <p className="schedule-grid-empty">
            No schedule slots are configured.
          </p>
        ) : (
          <div
            className="schedule-grid"
            role="grid"
            aria-label={ariaLabel || label || "Availability"}
            aria-colcount={groups.length + 1}
            aria-rowcount={maxRows + 1}
            aria-readonly={readOnly ? "true" : undefined}
            style={{
              minWidth: `max(100%, ${TIME_COLUMN_WIDTH + groups.length * columnWidth}px)`,
            }}
          >
            <div
              className="schedule-grid-header"
              role="row"
              aria-rowindex={1}
              style={{ gridTemplateColumns: rowTemplate }}
            >
              <div
                className="schedule-grid-time-header"
                role="columnheader"
                aria-colindex={1}
              >
                Time
              </div>
              {groups.map((group, column) => (
                <div
                  className="schedule-grid-column-header"
                  role="columnheader"
                  aria-colindex={column + 2}
                  key={group.key}
                  title={group.label}
                >
                  {group.label}
                </div>
              ))}
            </div>

            <div className="schedule-grid-body" role="rowgroup">
              {Array.from({ length: maxRows }, (_, row) => {
                const firstSlot = groups.find((group) => group.slots?.[row])
                  ?.slots?.[row];
                return (
                  <div
                    className="schedule-grid-row"
                    key={row}
                    role="row"
                    aria-rowindex={row + 2}
                    style={{ gridTemplateColumns: rowTemplate }}
                  >
                    <div
                      className="schedule-grid-row-header"
                      role="rowheader"
                      aria-colindex={1}
                      data-first-row={row === 0 ? "true" : undefined}
                    >
                      {firstSlot ? formatTime(firstSlot.localStart) : ""}
                    </div>
                    {groups.map((group, column) => {
                      const slot = group.slots?.[row];
                      if (!slot) {
                        return (
                          <div
                            className="schedule-grid-cell schedule-grid-cell-empty"
                            key={`${group.key}:empty:${row}`}
                            role="gridcell"
                            aria-colindex={column + 2}
                            aria-label={`${group.label}, no slot at this time`}
                            aria-disabled="true"
                            data-first-row={row === 0 ? "true" : undefined}
                            data-first-column={
                              column === 0 ? "true" : undefined
                            }
                          />
                        );
                      }

                      const index = slot.index;
                      if (isBlocked(slot)) {
                        const blockedLabel = `${group.label}, ${slotLabel(slot)}, blocked for this event`;
                        return (
                          <div
                            className="schedule-grid-cell schedule-grid-cell-blocked"
                            key={index}
                            role="gridcell"
                            aria-colindex={column + 2}
                            aria-label={blockedLabel}
                            aria-disabled="true"
                            data-cell-idx={index}
                            data-blocked="true"
                            data-first-row={row === 0 ? "true" : undefined}
                            data-first-column={
                              column === 0 ? "true" : undefined
                            }
                            title={blockedLabel}
                          />
                        );
                      }

                      // Shared by availability and blocked-times cells: the
                      // roving tab stop, pointer strokes and keyboard painting.
                      const interaction = {
                        ref: (node) => {
                          if (node) cellRefs.current.set(index, node);
                          else cellRefs.current.delete(index);
                        },
                        tabIndex: readOnly
                          ? undefined
                          : index === rovingCellIndex
                            ? 0
                            : -1,
                        onPointerDown: (event) => startStroke(index, event),
                        onPointerMove: continueStroke,
                        onPointerUp: finishStroke,
                        onPointerCancel: finishStroke,
                        onLostPointerCapture: finishStroke,
                        onFocus: () => setActiveCellIndex(index),
                        onKeyDown: (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            paintCell(index, event, "keyboard");
                            return;
                          }
                          moveKeyboardFocus(index, event);
                        },
                      };

                      if (blockedEditing) {
                        const marked = Number(schedule[index]) > 0;
                        const markLabel = `${group.label}, ${slotLabel(slot)}, ${marked ? "blocked" : "open"}`;
                        return (
                          <div
                            className="schedule-grid-cell"
                            key={index}
                            role="gridcell"
                            {...interaction}
                            aria-colindex={column + 2}
                            aria-label={markLabel}
                            aria-readonly={readOnly ? "true" : undefined}
                            aria-selected={marked}
                            data-cell-idx={index}
                            data-blocked-paint={marked ? "true" : "false"}
                            data-first-row={row === 0 ? "true" : undefined}
                            data-first-column={
                              column === 0 ? "true" : undefined
                            }
                            title={markLabel}
                          >
                            <span
                              className="schedule-grid-cell__glyph"
                              aria-hidden="true"
                            >
                              {marked ? "✕" : ""}
                            </span>
                          </div>
                        );
                      }

                      const value = Number(schedule[index] || 0);
                      const level = availabilityKey(value);
                      const details = participantDetails
                        ? participantDetails
                            .filter(
                              (participant) =>
                                Number(participant.schedule[index] || 0) > 0,
                            )
                            .map(
                              (participant) =>
                                `${participant.name}: ${Number(
                                  participant.schedule[index],
                                ).toFixed(2)}`,
                            )
                            .join("\n")
                        : "";
                      const title = details
                        ? `${slotLabel(slot)}\n${details}`
                        : slotLabel(slot);

                      return (
                        <div
                          className="schedule-grid-cell"
                          key={index}
                          role="gridcell"
                          {...interaction}
                          aria-colindex={column + 2}
                          aria-label={`${group.label}, ${slotLabel(slot)}, availability ${value}`}
                          aria-readonly={readOnly ? "true" : undefined}
                          aria-selected={readOnly ? undefined : value > 0}
                          data-cell-idx={index}
                          data-availability={level}
                          data-first-row={row === 0 ? "true" : undefined}
                          data-first-column={column === 0 ? "true" : undefined}
                          title={title}
                          style={{
                            backgroundColor: virtual
                              ? lerpVirtualColor(value)
                              : lerpColor(value),
                          }}
                        >
                          {showValues ? (
                            value.toFixed(2).replace(/\.00$/, "")
                          ) : (
                            <span
                              className="schedule-grid-cell__glyph"
                              aria-hidden="true"
                            >
                              {cellGlyph(level)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScheduleGrid;
