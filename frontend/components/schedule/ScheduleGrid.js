"use client";

import { useRef } from "react";
import { lerpColor } from "@/components/ui/ColorUtils";
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
  participantDetails,
}) {
  const ignoreMouseUntilRef = useRef(0);
  const groups = Array.isArray(slotGroups) ? slotGroups : [];
  const maxRows = groups.reduce(
    (largest, group) => Math.max(largest, group?.slots?.length || 0),
    0
  );

  const handlePaint = (index, event) => {
    if (readOnly || !onCellPaint) return;
    if (
      event.type === "mousedown" ||
      event.type === "keydown" ||
      (event.type === "mousemove" && event.buttons === 1)
    ) {
      onCellPaint(index, event);
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
                          onMouseDown={(event) => {
                            if (Date.now() < ignoreMouseUntilRef.current) return;
                            handlePaint(index, event);
                          }}
                          onMouseMove={(event) => handlePaint(index, event)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handlePaint(index, { ...event, type: "keydown" });
                            }
                          }}
                          onTouchStart={(event) => {
                            event.preventDefault();
                            ignoreMouseUntilRef.current = Date.now() + 750;
                            handlePaint(index, { type: "mousedown" });
                          }}
                          onTouchMove={(event) => {
                            event.preventDefault();
                            const touch = event.touches[0];
                            const element = document.elementFromPoint(touch.clientX, touch.clientY);
                            const targetIndex = element?.dataset?.cellIdx;
                            if (targetIndex !== undefined) {
                              handlePaint(Number(targetIndex), {
                                type: "mousemove",
                                buttons: 1,
                              });
                            }
                          }}
                          style={{
                            height: "36px",
                            backgroundColor: lerpColor(value),
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
