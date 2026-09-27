"use client";

import AppButton from "@/components/ui/AppButton";
import { ChevronDownIcon, GroupIcon } from "@/components/ui/icons";
import { usePopover } from "@/components/schedule/participants/MenuButton";
import { UNGROUPED } from "@/lib/participants";

/**
 * `Group: …` filter: a popover titled Show with Everyone, each group and (when
 * anyone is ungrouped) No group, each with its head count, plus links to
 * create a group or open the groups panel. `value` is "" for everyone, a
 * group name, or the ungrouped marker.
 */
export default function GroupFilterButton({
  value = "",
  groups = [],
  everyoneCount = 0,
  noGroupCount = 0,
  onChange,
  onNewGroup,
  onManageGroups,
  disabled = false,
}) {
  const { open, setOpen, close, rootRef, triggerRef, id, handleRootKeyDown } =
    usePopover();
  const label =
    value === "" ? "Everyone" : value === UNGROUPED ? "No group" : value;
  const options = [
    { value: "", label: "Everyone", count: everyoneCount },
    ...groups.map((group) => ({
      value: group.name,
      label: group.name,
      count: group.count,
    })),
  ];
  if (noGroupCount > 0 || value === UNGROUPED)
    options.push({ value: UNGROUPED, label: "No group", count: noGroupCount });

  const choose = (next) => {
    close();
    if (next !== value) onChange(next);
  };

  return (
    <div
      ref={rootRef}
      className={`dropdown participants-popover${open ? " show" : ""}`}
      onKeyDown={handleRootKeyDown}
    >
      <AppButton
        ref={triggerRef}
        variant="outlined"
        icon={<GroupIcon />}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
      >
        Group: {label}
        <span className="app-btn-icon ms-1" aria-hidden="true">
          <ChevronDownIcon size="0.75em" />
        </span>
      </AppButton>
      {open && (
        <div id={id} className="dropdown-menu show participants-popover__menu">
          <fieldset className="participants-popover__group">
            <legend className="participants-popover__legend">Show</legend>
            {options.map((option) => {
              const inputId = `${id}-${option.value || "everyone"}`;
              return (
                <div
                  key={option.value}
                  className="form-check participants-popover__option"
                >
                  <input
                    className="form-check-input"
                    type="radio"
                    id={inputId}
                    name={`${id}-group`}
                    checked={value === option.value}
                    aria-describedby={`${inputId}-count`}
                    onChange={() => choose(option.value)}
                    onClick={() => {
                      // Re-choosing the current option fires no change event;
                      // it still means "done".
                      if (option.value === value) close();
                    }}
                  />
                  <label className="form-check-label" htmlFor={inputId}>
                    {option.label}
                  </label>
                  <span
                    id={`${inputId}-count`}
                    className="participants-popover__option-count text-secondary small"
                  >
                    {option.count}
                  </span>
                </div>
              );
            })}
          </fieldset>
          <div className="dropdown-divider" />
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              close();
              onNewGroup?.();
            }}
          >
            + New group
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              close();
              onManageGroups?.();
            }}
          >
            Manage groups…
          </button>
        </div>
      )}
    </div>
  );
}
