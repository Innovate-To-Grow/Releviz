"use client";

import { lerpColor } from "@/components/ui/ColorUtils";
import { DAY_LABELS, DAYS_PER_WEEK } from "@/lib/constants";
import { formatHour } from "@/lib/format";

/**
 * Reusable schedule grid component.
 *
 * Props:
 *   schedule    - Array of numeric values (0-1), length = (endHour - startHour) * 7
 *   startHour   - Start hour (e.g. 9)
 *   endHour     - End hour (e.g. 17)
 *   readOnly    - If true, disables mouse painting
 *   showValues  - If true, shows numeric values in cells
 *   onCellPaint - Callback (index, e) for mouse events (only used when !readOnly)
 *   label       - Optional label above the grid
 */
function ScheduleGrid({
  schedule,
  startHour,
  endHour,
  selectedDays,
  readOnly,
  showValues,
  onCellPaint,
  label,
  participantDetails,
  daySelectionType,
  specificDates,
}) {
  const numHours = endHour - startHour;
  const isSpecificDates = daySelectionType === "specific_dates" && Array.isArray(specificDates);
  const days = isSpecificDates
    ? specificDates
    : selectedDays
      ? DAY_LABELS.filter((_, i) => selectedDays.includes(i))
      : DAY_LABELS;
  const numColumns = days.length;
  const dayIndices = isSpecificDates
    ? specificDates.map((_, i) => i)
    : (selectedDays ?? [0, 1, 2, 3, 4, 5, 6]);

  const times = [];
  for (let i = 0; i < numHours; i++) {
    times.push(formatHour(startHour + i));
  }

  const handleMouse = (idx, e) => {
    if (readOnly || !onCellPaint) return;
    if (e.type === "mousedown" || (e.type === "mousemove" && e.buttons === 1)) {
      onCellPaint(idx, e);
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
        <div className="schedule-inner">
          <div style={{ display: "flex", marginLeft: "80px", marginBottom: "8px" }}>
            {days.map((d) => (
              <div
                key={d}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontWeight: "bold",
                  fontSize: "0.9rem",
                  color: "var(--md-sys-color-secondary)",
                }}
              >
                {d}
              </div>
            ))}
          </div>

          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: "80px",
                paddingRight: "8px",
              }}
            >
              {times.map((t) => (
                <div
                  key={t}
                  style={{
                    height: "32px",
                    display: "flex",
                    alignItems: "center",
                    fontSize: "0.75rem",
                    justifyContent: "flex-end",
                    color: "var(--md-sys-color-on-surface-variant)",
                  }}
                >
                  {t}
                </div>
              ))}
            </div>

            <div
              style={{
                display: "flex",
                flex: 1,
                border: "1px solid var(--md-sys-color-surface-variant)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              {dayIndices.map((dayIndex, colPos) => (
                <div key={dayIndex} style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                  {times.map((t, hourIndex) => {
                    const idx = isSpecificDates
                      ? hourIndex * numColumns + colPos
                      : hourIndex * DAYS_PER_WEEK + dayIndex;
                    const val = parseFloat(schedule[idx] || 0);
                    const tooltip = participantDetails
                      ? participantDetails
                          .filter((pd) => pd.schedule[idx] > 0)
                          .map((pd) => `${pd.name}: ${pd.schedule[idx].toFixed(2)}`)
                          .join("\n")
                      : undefined;
                    return (
                      <div
                        key={idx}
                        data-cell-idx={idx}
                        title={tooltip}
                        onMouseDown={(e) => handleMouse(idx, e)}
                        onMouseMove={(e) => handleMouse(idx, e)}
                        onTouchStart={(e) => {
                          e.preventDefault();
                          handleMouse(idx, { type: "mousedown" });
                        }}
                        onTouchMove={(e) => {
                          e.preventDefault();
                          const t = e.touches[0];
                          const el = document.elementFromPoint(t.clientX, t.clientY);
                          const ci = el?.dataset?.cellIdx;
                          if (ci !== undefined)
                            handleMouse(parseInt(ci), { type: "mousemove", buttons: 1 });
                        }}
                        style={{
                          height: "32px",
                          backgroundColor: lerpColor(val),
                          borderTop:
                            hourIndex !== 0
                              ? "1px solid var(--md-sys-color-surface-variant)"
                              : "none",
                          borderLeft:
                            colPos !== 0 ? "1px solid var(--md-sys-color-surface-variant)" : "none",
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
                        }}
                      >
                        {showValues ? val.toFixed(2).replace(/\.00$/, "") : ""}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ScheduleGrid;
