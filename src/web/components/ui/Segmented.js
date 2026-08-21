"use client";

import Icon from "@/components/ui/Icon";

/**
 * Mutually exclusive choice rendered as pressed buttons rather than a select.
 * Used wherever the options are few and switching should cost one click.
 * The accessible name of each option is exactly its label.
 */
export default function SegmentedControl({
  label,
  options,
  value,
  onChange,
  disabled = false,
  block = false,
  name,
  className = "",
  ...props
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`rv-segmented ${block ? "rv-segmented--block" : ""} ${className}`.trim()}
      {...props}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className="rv-segmented__option"
          aria-pressed={value === option.value}
          disabled={disabled || option.disabled}
          name={name}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <Icon name={option.icon} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A single on/off chip, for multi-select sets such as weekday pickers. */
export function ToggleChip({
  label,
  pressed,
  onClick,
  disabled = false,
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`rv-segmented__option ${className}`.trim()}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {label}
    </button>
  );
}

export function ChipGroup({ label, className = "", children, ...props }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`rv-segmented ${className}`.trim()}
      {...props}
    >
      {children}
    </div>
  );
}
