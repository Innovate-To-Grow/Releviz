"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";

const VALUE_MARKS = { 0: "", 0.5: "~", 1: "✓" };

// Availability is announced in words, and drawn with a glyph plus a fill
// pattern, so the value never depends on colour alone.
function describeValue(value) {
  if (value === 0) return "Busy";
  if (value === 0.5) return "If needed";
  if (value === 1) return "Available";
  return `${Math.round(value * 100)}% available`;
}

function slotLabel(slot) {
  const startDay = slot.startDayOffset ? ` +${slot.startDayOffset}d` : "";
  const endDay = slot.endDayOffset ? ` +${slot.endDayOffset}d` : "";
  const startOffset = slot.startOffset ? ` ${slot.startOffset}` : "";
  const endOffset = slot.endOffset ? ` ${slot.endOffset}` : "";
  return `${formatTime(slot.localStart)}${startDay}${startOffset} – ${formatTime(
    slot.localEnd,
  )}${endDay}${endOffset}`;
}

function ScheduleGrid({
  schedule = [],
  slotGroups = [],
  readOnly,
  showValues,
  onCellPaint,
  label,
  participantDetails,
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
  const cellPositions = groups.flatMap((group, column) =>
    (group?.slots || []).flatMap((slot, row) =>
      slot ? [{ index: slot.index, row, column }] : [],
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
    if (readOnly || !onCellPaint) return;
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

  return (
    <div className="rv-schedule">
      {label && <h4 className="rv-field__label">{label}</h4>}
      <div className="rv-schedule__body">
        {groups.length === 0 ? (
          <p className="rv-field__hint">No schedule slots are configured.</p>
        ) : (
          <div className="rv-grid-scroll">
            <div
              role="grid"
              className="rv-grid"
              style={{ "--rv-grid-columns": groups.length }}
              aria-label={label || "Availability"}
              aria-colcount={groups.length + 1}
              aria-rowcount={maxRows + 1}
            >
              <div
                role="row"
                aria-rowindex={1}
                className="rv-grid__row rv-grid__head"
              >
                <div
                  role="columnheader"
                  aria-colindex={1}
                  className="rv-grid__colhead rv-grid__colhead--time"
                >
                  Time
                </div>
                {groups.map((group, column) => (
                  <div
                    role="columnheader"
                    aria-colindex={column + 2}
                    className="rv-grid__colhead"
                    key={group.key}
                  >
                    {group.label}
                  </div>
                ))}
              </div>

              <div role="rowgroup">
                {Array.from({ length: maxRows }, (_, row) => {
                  const firstSlot = groups.find((group) => group.slots?.[row])
                    ?.slots?.[row];
                  return (
                    <div
                      key={row}
                      role="row"
                      aria-rowindex={row + 2}
                      className="rv-grid__row"
                    >
                      <div
                        role="rowheader"
                        aria-colindex={1}
                        className="rv-grid__rowhead"
                        data-first-row={row === 0 ? "true" : undefined}
                      >
                        {firstSlot ? formatTime(firstSlot.localStart) : ""}
                      </div>
                      {groups.map((group, column) => {
                        const slot = group.slots?.[row];
                        if (!slot) {
                          return (
                            <div
                              key={`${group.key}:empty:${row}`}
                              role="gridcell"
                              className="rv-grid__cell"
                              data-empty="true"
                              aria-colindex={column + 2}
                              aria-label={`${group.label}, no slot at this time`}
                              aria-disabled="true"
                            />
                          );
                        }

                        const index = slot.index;
                        const value = Number(schedule[index] || 0);
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
                            key={index}
                            role="gridcell"
                            className={`rv-grid__cell${showValues ? " rv-grid__cell--heat" : ""}`}
                            style={
                              showValues
                                ? { "--rv-cell-value": value }
                                : undefined
                            }
                            data-value={showValues ? undefined : value}
                            ref={(node) => {
                              if (node) cellRefs.current.set(index, node);
                              else cellRefs.current.delete(index);
                            }}
                            tabIndex={
                              readOnly
                                ? undefined
                                : index === rovingCellIndex
                                  ? 0
                                  : -1
                            }
                            aria-colindex={column + 2}
                            aria-label={`${group.label}, ${slotLabel(slot)}, ${describeValue(value)}`}
                            aria-readonly={readOnly ? "true" : undefined}
                            aria-selected={readOnly ? undefined : value > 0}
                            data-cell-idx={index}
                            title={title}
                            onPointerDown={(event) => startStroke(index, event)}
                            onPointerMove={continueStroke}
                            onPointerUp={finishStroke}
                            onPointerCancel={finishStroke}
                            onLostPointerCapture={finishStroke}
                            onFocus={() => setActiveCellIndex(index)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                paintCell(index, event, "keyboard");
                                return;
                              }
                              moveKeyboardFocus(index, event);
                            }}
                          >
                            {showValues ? (
                              value.toFixed(2).replace(/\.00$/, "")
                            ) : (
                              <span
                                className="rv-grid__mark"
                                aria-hidden="true"
                              >
                                {VALUE_MARKS[value] || ""}
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
          </div>
        )}
      </div>
      {!readOnly && groups.length > 0 && (
        <p className="rv-schedule__legend">
          <span className="rv-schedule__legend-item">
            <span
              className="rv-schedule__swatch"
              data-value="0"
              aria-hidden="true"
            />
            Busy
          </span>
          <span className="rv-schedule__legend-item">
            <span
              className="rv-schedule__swatch"
              data-value="0.5"
              aria-hidden="true"
            >
              ~
            </span>
            If needed
          </span>
          <span className="rv-schedule__legend-item">
            <span
              className="rv-schedule__swatch"
              data-value="1"
              aria-hidden="true"
            >
              ✓
            </span>
            Available
          </span>
        </p>
      )}
    </div>
  );
}

export default ScheduleGrid;
