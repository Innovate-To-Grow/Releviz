"use client";

import AppButton from "@/components/ui/AppButton";
import { FilterIcon } from "@/components/ui/icons";
import { usePopover } from "@/components/schedule/participants/MenuButton";
import {
  RESPONSE_FILTER_OPTIONS,
  responseFilterKey,
  responseFilterParams,
} from "@/lib/participants";

const RESPONSE_OPTIONS = RESPONSE_FILTER_OPTIONS.map(({ key, label }) => [
  key,
  label,
]);
// Radio values are the API's `included` parameter as strings.
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
 * `Filter` button with a count of active filters and a popover of two radio
 * groups (Response, Results). `value` holds the API strings: submitted and
 * included "" | "true" | "false", invitationStatus "" or a delivery state.
 * The Response group is one choice that sets submitted and invitationStatus
 * together.
 */
export function FilterButton({ value = {}, onChange, disabled = false }) {
  const { open, setOpen, rootRef, triggerRef, id, handleRootKeyDown } =
    usePopover();
  const current = {
    submitted: value.submitted ?? "",
    invitationStatus: value.invitationStatus ?? "",
    included: value.included ?? "",
  };
  const responseKey = responseFilterKey(current);
  const activeCount =
    (responseKey !== "" ? 1 : 0) + (current.included !== "" ? 1 : 0);

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
            name={`${id}-response`}
            options={RESPONSE_OPTIONS}
            value={responseKey}
            onChange={(next) =>
              onChange({ ...current, ...responseFilterParams(next) })
            }
          />
          <RadioGroup
            legend="Results"
            name={`${id}-included`}
            options={RESULTS_OPTIONS}
            value={current.included}
            onChange={(next) => onChange({ ...current, included: next })}
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
