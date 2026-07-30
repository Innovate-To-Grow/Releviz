"use client";

import { useCallback, useEffect, useRef } from "react";
import { lerpColor, lerpVirtualColor } from "@/components/ui/ColorUtils";
import { formatTime } from "@/lib/format";

function slotLabel(slot) {
  const startDay = slot.startDayOffset ? ` +${slot.startDayOffset}d` : "";
  const endDay = slot.endDayOffset ? ` +${slot.endDayOffset}d` : "";
  const startOffset = slot.startOffset ? ` ${slot.startOffset}` : "";
  const endOffset = slot.endOffset ? ` ${slot.endOffset}` : "";
  return `${formatTime(slot.localStart)}${startDay}${startOffset} – ${formatTime(
    slot.localEnd
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
  const groups = Array.isArray(slotGroups) ? slotGroups : [];
  const maxRows = groups.reduce(
    (largest, group) => Math.max(largest, group?.slots?.length || 0),
    0
  );

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
      pointerType: event.pointerType || (phase === "keyboard" ? "keyboard" : "mouse"),
      type: phase === "keyboard" ? "keydown" : phase === "start" ? "pointerdown" : "pointermove",
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

  return (
    <div>
      {label && (
        <h4
          style={{
            margin: "0 0 12px 0",
            color: "var(--md-sys-color-on-surface)",
            fontWeight: "500",
          }}
        >
          {label}
        </h4>
      )}
      <div
        style={{
          overflowX: "auto",
          backgroundColor: "#fff",
          borderRadius: "8px",
          padding: "16px",
          border: "1px solid var(--md-sys-color-outline)",
        }}
      >
        {groups.length === 0 ? (
          <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
            No schedule slots are configured.
          </p>
        ) : (
          <div
            role="grid"
            aria-label={label || "Availability"}
            style={{ minWidth: `${80 + groups.length * 96}px` }}
          >
            <div
              role="row"
              style={{
                display: "grid",
                gridTemplateColumns: `80px repeat(${groups.length}, minmax(96px, 1fr))`,
                marginBottom: "8px",
              }}
            >
              <div
                role="columnheader"
                style={{
                  paddingRight: "8px",
                  textAlign: "right",
                  fontSize: "0.8rem",
                  color: "var(--md-sys-color-on-surface-variant)",
                }}
              >
                Time
              </div>
              {groups.map((group) => (
                <div
                  role="columnheader"
                  key={group.key}
                  style={{
                    flex: 1,
                    minWidth: "96px",
                    textAlign: "center",
                    fontWeight: "bold",
                    fontSize: "0.9rem",
                    color: "var(--md-sys-color-secondary)",
                  }}
                >
                  {group.label}
                </div>
              ))}
            </div>

            <div
              role="rowgroup"
              style={{
                border: "1px solid var(--md-sys-color-surface-variant)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              {Array.from({ length: maxRows }, (_, row) => {
                const firstSlot = groups.find((group) => group.slots?.[row])?.slots?.[row];
                return (
                  <div
                    key={row}
                    role="row"
                    style={{
                      display: "grid",
                      gridTemplateColumns: `80px repeat(${groups.length}, minmax(96px, 1fr))`,
                    }}
                  >
                    <div
                      role="rowheader"
                      style={{
                        alignItems: "center",
                        background: "#fff",
                        borderTop:
                          row === 0 ? "none" : "1px solid var(--md-sys-color-surface-variant)",
                        color: "var(--md-sys-color-on-surface-variant)",
                        display: "flex",
                        fontSize: "0.72rem",
                        height: "36px",
                        justifyContent: "flex-end",
                        paddingRight: "8px",
                      }}
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
                            aria-label={`${group.label}, no slot at this time`}
                            aria-disabled="true"
                            style={{
                              height: "36px",
                              background:
                                "repeating-linear-gradient(135deg, transparent, transparent 5px, rgba(0,0,0,0.04) 5px, rgba(0,0,0,0.04) 10px)",
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
                            .filter((participant) => Number(participant.schedule[index] || 0) > 0)
                            .map(
                              (participant) =>
                                `${participant.name}: ${Number(participant.schedule[index]).toFixed(
                                  2
                                )}`
                            )
                            .join("\n")
                        : "";
                      const title = details ? `${slotLabel(slot)}\n${details}` : slotLabel(slot);

                      return (
                        <div
                          key={index}
                          role="gridcell"
                          tabIndex={readOnly ? undefined : 0}
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
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              paintCell(index, event, "keyboard");
                            }
                          }}
                          style={{
                            height: "36px",
                            backgroundColor: virtual ? lerpVirtualColor(value) : lerpColor(value),
                            borderTop:
                              row === 0 ? "none" : "1px solid var(--md-sys-color-surface-variant)",
                            borderLeft:
                              column === 0
                                ? "none"
                                : "1px solid var(--md-sys-color-surface-variant)",
                            cursor: readOnly ? "default" : "pointer",
                            touchAction: "none",
                            userSelect: "none",
                            WebkitUserSelect: "none",
                            transition: "background-color 0.1s ease",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.7rem",
                            color: "var(--md-sys-color-on-surface)",
                            fontWeight: "500",
                            boxSizing: "border-box",
                          }}
                        >
                          {showValues ? value.toFixed(2).replace(/\.00$/, "") : ""}
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
