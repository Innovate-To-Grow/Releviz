"use client";

import { useId, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import Modal from "@/components/ui/Modal";
import { CheckIcon } from "@/components/ui/icons";
import MixedCheckbox from "@/components/schedule/participants/MixedCheckbox";
import { groupNameError } from "@/lib/participants";

// A mixed box goes to all, then none, then back to mixed; a box that started
// out uniform just toggles.
function cycle(current, original) {
  if (current === "mixed") return "all";
  if (current === "all") return "none";
  return original === "mixed" ? "mixed" : "all";
}

/**
 * Tick the groups for one person or for everyone selected. Each group shows
 * its state (all, none or mixed), `Every group, including groups added
 * later` is a separate box that disables the rest while on, and a group can
 * be created from inside the picker. Apply sends only what changed.
 */
export default function GroupPicker({
  title,
  groups = [],
  state,
  counts = null,
  busy = false,
  onApply,
  onClose,
  onCreateGroup,
}) {
  const id = useId();
  const original = {
    allGroups: state?.allGroups ?? "none",
    byGroup: state?.byGroup ?? {},
  };
  const [draft, setDraft] = useState(() => ({
    allGroups: original.allGroups,
    byGroup: { ...original.byGroup },
  }));
  const [created, setCreated] = useState([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const allGroups = [...groups, ...created];
  const total = counts?.total ?? 1;
  const everyOn = draft.allGroups === "all";

  const stateOf = (groupId) => draft.byGroup[groupId] ?? "none";
  const originalOf = (groupId) => original.byGroup[groupId] ?? "none";
  const countOf = (value, mixedCount) =>
    value === "all" ? total : value === "none" ? 0 : (mixedCount ?? 0);

  const addGroupIds = [];
  const removeGroupIds = [];
  allGroups.forEach((group) => {
    const next = stateOf(group.id);
    if (next === originalOf(group.id) || next === "mixed") return;
    (next === "all" ? addGroupIds : removeGroupIds).push(group.id);
  });
  const updates = {};
  if (addGroupIds.length) updates.addGroupIds = addGroupIds;
  if (removeGroupIds.length) updates.removeGroupIds = removeGroupIds;
  if (draft.allGroups !== original.allGroups && draft.allGroups !== "mixed")
    updates.allGroups = draft.allGroups === "all";
  const hasChanges = Object.keys(updates).length > 0;

  const toggleGroup = (groupId) =>
    setDraft((current) => ({
      ...current,
      byGroup: {
        ...current.byGroup,
        [groupId]: cycle(
          current.byGroup[groupId] ?? "none",
          originalOf(groupId),
        ),
      },
    }));

  const submitCreate = async (submitEvent) => {
    submitEvent.preventDefault();
    const message = groupNameError(newName);
    if (message) {
      setCreateError(message);
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const group = await onCreateGroup(newName.trim());
      setCreated((current) => [...current, group]);
      setDraft((current) => ({
        ...current,
        byGroup: { ...current.byGroup, [group.id]: "all" },
      }));
      setCreating(false);
      setNewName("");
    } catch (error) {
      setCreateError(error?.message || "The group could not be created.");
    } finally {
      setCreateBusy(false);
    }
  };

  const locked = busy || createBusy;

  return (
    <Modal
      size="md"
      title={title}
      busy={busy}
      onClose={onClose}
      className="participants-picker"
      footer={
        <>
          <AppButton variant="text" onClick={onClose} disabled={locked}>
            Cancel
          </AppButton>
          <AppButton
            icon={<CheckIcon />}
            busy={busy}
            disabled={locked || !hasChanges}
            onClick={() => onApply?.(updates)}
          >
            Apply
          </AppButton>
        </>
      }
    >
      <div className="form-check participants-picker__row participants-picker__all">
        <MixedCheckbox
          className="form-check-input"
          id={`${id}-all`}
          checked={everyOn}
          mixed={draft.allGroups === "mixed"}
          disabled={locked}
          aria-describedby={counts ? `${id}-all-count` : undefined}
          onChange={() =>
            setDraft((current) => ({
              ...current,
              allGroups: cycle(current.allGroups, original.allGroups),
            }))
          }
        />
        <label className="form-check-label" htmlFor={`${id}-all`}>
          Every group, including groups added later
        </label>
        {counts && (
          <span
            id={`${id}-all-count`}
            className="participants-picker__count text-secondary small"
          >
            {countOf(draft.allGroups, counts.allGroups)} of {total}
          </span>
        )}
      </div>
      <hr className="my-3" />
      {allGroups.length === 0 ? (
        <p className="small text-secondary mb-3">No groups yet.</p>
      ) : (
        <ul className="list-unstyled participants-picker__list mb-3">
          {allGroups.map((group) => {
            const value = stateOf(group.id);
            const inputId = `${id}-group-${group.id}`;
            return (
              <li
                key={group.id}
                className="form-check participants-picker__row"
              >
                <MixedCheckbox
                  className="form-check-input"
                  id={inputId}
                  checked={value === "all"}
                  mixed={value === "mixed"}
                  disabled={locked || everyOn}
                  aria-describedby={counts ? `${inputId}-count` : undefined}
                  onChange={() => toggleGroup(group.id)}
                />
                <label className="form-check-label" htmlFor={inputId}>
                  {group.name}
                </label>
                {counts && (
                  <span
                    id={`${inputId}-count`}
                    className="participants-picker__count text-secondary small"
                  >
                    {countOf(value, counts.byGroup?.[group.id])} of {total}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating ? (
        <form
          className="participants-inline-form"
          noValidate
          onSubmit={submitCreate}
        >
          <input
            type="text"
            className={`form-control form-control-sm${createError ? " is-invalid" : ""}`}
            aria-label="New group name"
            maxLength={100}
            value={newName}
            disabled={locked}
            autoFocus
            onChange={(event) => {
              setNewName(event.target.value);
              setCreateError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setCreating(false);
                setNewName("");
                setCreateError("");
              }
            }}
          />
          <AppButton
            type="submit"
            size="sm"
            busy={createBusy}
            disabled={locked}
          >
            Create
          </AppButton>
          <AppButton
            size="sm"
            variant="text"
            disabled={locked}
            onClick={() => {
              setCreating(false);
              setNewName("");
              setCreateError("");
            }}
          >
            Cancel
          </AppButton>
          {createError && (
            <Alert variant="danger" role="alert" className="w-100 mt-2">
              {createError}
            </Alert>
          )}
        </form>
      ) : (
        <AppButton
          variant="text"
          size="sm"
          className="p-0"
          disabled={locked}
          onClick={() => setCreating(true)}
        >
          + New group
        </AppButton>
      )}
    </Modal>
  );
}
