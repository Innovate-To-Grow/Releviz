"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { lerpColor, lerpVirtualColor } from "@/components/ui/ColorUtils";
import { formatTime } from "@/lib/format";

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
  virtual = false,
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
    <div className="schedule-grid-shell">
      {label && <h4 className="schedule-grid-title">{label}</h4>}
      <div className="schedule-grid-scroll">
        {groups.length === 0 ? (
          <p className="schedule-grid-empty">
            No schedule slots are configured.
          </p>
        ) : (
          <div
            className="schedule-grid"
            role="grid"
            aria-label={label || "Availability"}
            aria-colcount={groups.length + 1}
            aria-rowcount={maxRows + 1}
            style={{ minWidth: `${80 + groups.length * 96}px` }}
          >
            <div
              className="schedule-grid-header"
              role="row"
              aria-rowindex={1}
              style={{
                gridTemplateColumns: `80px repeat(${groups.length}, minmax(96px, 1fr))`,
              }}
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
                    style={{
                      gridTemplateColumns: `80px repeat(${groups.length}, minmax(96px, 1fr))`,
                    }}
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
                            style={{
                              borderTop:
                                row === 0
                                  ? "none"
                                  : "1px solid var(--md-sys-color-surface-variant)",
                              borderLeft:
                                column === 0
                                  ? "none"
                                  : "1px solid var(--md-sys-color-surface-variant)",
                            }}
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
                          className="schedule-grid-cell"
                          key={index}
                          role="gridcell"
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
                          aria-label={`${group.label}, ${slotLabel(slot)}, availability ${value}`}
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
                          style={{
                            backgroundColor: virtual
                              ? lerpVirtualColor(value)
                              : lerpColor(value),
                            borderTop:
                              row === 0
                                ? "none"
                                : "1px solid var(--md-sys-color-surface-variant)",
                            borderLeft:
                              column === 0
                                ? "none"
                                : "1px solid var(--md-sys-color-surface-variant)",
                            cursor: readOnly ? "default" : "pointer",
                          }}
                        >
                          {showValues
                            ? value.toFixed(2).replace(/\.00$/, "")
                            : ""}
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
