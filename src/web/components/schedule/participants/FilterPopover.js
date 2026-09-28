"use client";

import AppButton from "@/components/ui/AppButton";
import { FilterIcon } from "@/components/ui/icons";
import { usePopover } from "@/components/schedule/participants/MenuButton";

// Radio values are the API's query parameters as strings.
const RESPONSE_OPTIONS = [
  ["", "Any"],
  ["true", "Submitted"],
  ["false", "Not submitted"],
];
const INVITATION_OPTIONS = [
  ["", "Any"],
  ["not_sent", "Not sent"],
  ["queued", "Sending"],
  ["failed", "Failed"],
  ["sent", "Sent"],
  ["accepted", "Accepted"],
];
const RESULTS_OPTIONS = [
  ["", "Any"],
  ["true", "Counted"],
  ["false", "Left out"],
];

function RadioGroup({ legend, name, options, value, onChange }) {
  return (
    <fieldset className="participants-popover__group">
      <legend className="participants-popover__legend">{legend}</legend>
      {options.map(([optionValue, label]) => {
        const inputId = `${name}-${optionValue || "any"}`;
        return (
          <div key={inputId} className="form-check">
            <input
              className="form-check-input"
              type="radio"
              id={inputId}
              name={name}
              value={optionValue}
              checked={value === optionValue}
              onChange={() => onChange(optionValue)}
            />
            <label className="form-check-label" htmlFor={inputId}>
              {label}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * `Filter` button with a count of active filters and a popover of three
 * radio groups (Response, Invitation, Results). `value` holds the API
 * strings: submitted/included "" | "true" | "false", invitationStatus "" or
 * a delivery state.
 */
export function FilterButton({ value = {}, onChange, disabled = false }) {
  const { open, setOpen, rootRef, triggerRef, id, handleRootKeyDown } =
    usePopover();
  const current = {
    submitted: value.submitted ?? "",
    invitationStatus: value.invitationStatus ?? "",
    included: value.included ?? "",
  };
  const activeCount = Object.values(current).filter(
    (item) => item !== "",
  ).length;
  const set = (key, next) => onChange({ ...current, [key]: next });

  return (
    <div
      ref={rootRef}
      className={`dropdown participants-popover${open ? " show" : ""}`}
      onKeyDown={handleRootKeyDown}
    >
      <AppButton
        ref={triggerRef}
        variant="outlined"
        icon={<FilterIcon />}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
      >
        Filter
        {activeCount > 0 && (
          <span className="badge text-bg-primary rounded-pill ms-2 participants-popover__count">
            {activeCount}
            <span className="visually-hidden"> active</span>
          </span>
        )}
      </AppButton>
      {open && (
        <div
          id={id}
          className="dropdown-menu dropdown-menu-end show participants-popover__menu"
        >
          <RadioGroup
            legend="Response"
            name={`${id}-submitted`}
            options={RESPONSE_OPTIONS}
            value={current.submitted}
            onChange={(next) => set("submitted", next)}
          />
          <RadioGroup
            legend="Invitation"
            name={`${id}-invitation`}
            options={INVITATION_OPTIONS}
            value={current.invitationStatus}
            onChange={(next) => set("invitationStatus", next)}
          />
          <RadioGroup
            legend="Results"
            name={`${id}-included`}
            options={RESULTS_OPTIONS}
            value={current.included}
            onChange={(next) => set("included", next)}
          />
        </div>
      )}
    </div>
  );
}

/** Active filters as removable chips plus a `Clear all` link. */
export function FilterChips({ chips = [], onRemove, onClearAll }) {
  if (!chips.length) return null;
  return (
    <ul
      className="participants-chips list-unstyled"
      aria-label="Active filters"
    >
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            className="participants-chip"
            aria-label={`Remove filter ${chip.label}`}
            onClick={() => onRemove(chip.key)}
          >
            <span>{chip.label}</span>
            <span className="participants-chip__remove" aria-hidden="true">
              ×
            </span>
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          className="btn btn-link btn-sm participants-chips__clear"
          onClick={onClearAll}
        >
          Clear all
        </button>
      </li>
    </ul>
  );
}
