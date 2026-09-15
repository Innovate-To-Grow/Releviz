"use client";

import { AvailableIcon, BusyIcon, PartialIcon } from "./icons";

/** The three availability levels used across every schedule editor. */
export const AVAILABILITY_CHOICES = [
  { label: "Busy", value: 0, key: "busy", Icon: BusyIcon },
  { label: "If needed", value: 0.5, key: "partial", Icon: PartialIcon },
  { label: "Available", value: 1, key: "free", Icon: AvailableIcon },
];

export function availabilityKey(value) {
  const numeric = Number(value) || 0;
  if (numeric <= 0) return "busy";
  if (numeric >= 1) return "free";
  return "partial";
}

export function availabilityLabel(value) {
  const key = availabilityKey(value);
  return AVAILABILITY_CHOICES.find((choice) => choice.key === key)?.label;
}

/** Colored swatch with the same non-color cue used inside grid cells. */
export function AvailabilitySwatch({ level = "busy", virtual = false }) {
  const glyph = level === "free" ? "✓" : level === "partial" ? "◐" : "";
  return (
    <span
      className={`availability-swatch availability-swatch--${level}${virtual ? " availability-swatch--virtual" : ""}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

/**
 * Legend explaining the grid colors and glyphs. Pass `virtual` to show the
 * virtual-channel palette, or `channels="both"` to show both.
 */
export function AvailabilityLegend({
  virtual = false,
  channels = "single",
  className = "",
  showValues = false,
}) {
  const items = AVAILABILITY_CHOICES.map((choice) => ({
    ...choice,
    detail: showValues ? `${choice.value}` : null,
  }));
  return (
    <ul
      className={`availability-legend ${className}`.trim()}
      aria-label="Availability legend"
    >
      {items.map((item) => (
        <li key={item.key} className="availability-legend__item">
          {channels === "both" ? (
            <>
              <AvailabilitySwatch level={item.key} />
              <AvailabilitySwatch level={item.key} virtual />
            </>
          ) : (
            <AvailabilitySwatch level={item.key} virtual={virtual} />
          )}
          <span>{item.label}</span>
          {item.detail && (
            <span className="text-secondary">({item.detail})</span>
          )}
        </li>
      ))}
      {channels === "both" && (
        <li className="availability-legend__item text-secondary">
          Left swatch: in person · right swatch: virtual
        </li>
      )}
    </ul>
  );
}

/**
 * Segmented "Mark times as" control. Buttons expose `aria-pressed` so the
 * current level is announced, and each label carries its color swatch.
 */
export function AvailabilityChoice({
  value,
  onChange,
  disabled = false,
  virtual = false,
  label = "Availability status",
  size = "md",
  className = "",
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`btn-group availability-choice-group ${size === "sm" ? "btn-group-sm" : ""} ${className}`.trim()}
    >
      {AVAILABILITY_CHOICES.map((choice) => {
        const active = value === choice.value;
        return (
          <button
            key={choice.key}
            type="button"
            className={`btn ${active ? "btn-primary" : "btn-outline-secondary"}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
          >
            <AvailabilitySwatch level={choice.key} virtual={virtual} />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}
