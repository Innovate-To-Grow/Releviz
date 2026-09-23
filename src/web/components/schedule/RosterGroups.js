"use client";

import { useEffect, useId, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import FormField from "@/components/ui/FormField";
import StatusBadge from "@/components/ui/StatusBadge";
import { CheckIcon, GroupIcon } from "@/components/ui/icons";

export const UNGROUPED = "__ungrouped__";

// Roster stats list groups as [{ id, name, count, weight }]; older payloads
// send bare names or a { name: count } map. Ungrouped people carry an empty
// name and a null id and sort last. `weight` is the value everyone in the
// group shares, or null when members differ (or the group is empty).
export function summarizeGroups(rawGroups) {
  const entries = Array.isArray(rawGroups)
    ? rawGroups.map((item) =>
        typeof item === "string" ? { name: item } : item,
      )
    : Object.entries(rawGroups || {}).map(([name, value]) => ({
        name,
        count: typeof value === "number" ? value : value?.count,
      }));
  return entries
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: item.id ?? null,
      name: String(item.name ?? ""),
      count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
      weight: typeof item.weight === "number" ? item.weight : null,
    }))
    .sort(
      (a, b) =>
        Number(a.name === "") - Number(b.name === "") ||
        a.name.localeCompare(b.name),
    );
}

export function groupFilterValue(name) {
  return name === "" ? UNGROUPED : name;
}

function groupLabel(name) {
  return name === "" ? "Ungrouped" : name;
}

function peopleLabel(count) {
  if (count === null) return "";
  return `${count} ${count === 1 ? "person" : "people"}`;
}

// Weight drafts come straight from a number input, so they are always strings.
function normalizeWeight(value) {
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

// Mirrors the server's group-name rules so a bad name never leaves the page.
function groupNameError(value) {
  const name = String(value || "").trim();
  if (!name) return "Enter a group name.";
  if (name.length > 100) return "Group names must be 100 characters or fewer.";
  if (name.includes(";")) return "Group names cannot contain ;.";
  if (name.toUpperCase() === "ALL") return "ALL is reserved for every group.";
  return "";
}

/**
 * Organizer grouping controls: every group with its head count and shared
 * weight, inline weight and rename edits, group creation and deletion, and a
 * way to add the people selected in the roster table to a group (or remove
 * them from one). People can belong to several groups at once, so a person
 * counts in every group they are a member of.
 */
export default function RosterGroups({
  groups,
  selectedCount = 0,
  activeGroup = "",
  readOnly = false,
  busyGroup = "",
  onShowGroup,
  onSetWeight,
  onRename,
  onDelete,
  onAddSelected,
  onRemoveSelected,
  onMoveSelected,
  onCreate,
}) {
  const ids = useId();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [weightDrafts, setWeightDrafts] = useState({});
  // Which button's request is in flight, so only that button shows a spinner
  // while `busyGroup` (owned by the parent) disables the rest.
  const [pendingAction, setPendingAction] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const titleRef = useRef(null);
  // Each row's Delete button by filter value, and the one to focus again
  // once a failed delete leaves the roster idle.
  const deleteButtons = useRef(new Map());
  const refocusDelete = useRef("");

  const namedGroups = groups.filter((group) => group.name !== "");
  const busy = Boolean(busyGroup);
  const hasSelection = selectedCount > 0;
  const newGroupNameId = `${ids}-new-group-name`;
  // The question is about the group as it was when asked: a lock, a rename or
  // a delete elsewhere drops it rather than acting on something else later.
  const pendingDelete =
    deleteTarget && !readOnly
      ? (namedGroups.find(
          (group) =>
            group.id === deleteTarget.id && group.name === deleteTarget.name,
        ) ?? null)
      : null;
  if (deleteTarget && !pendingDelete) setDeleteTarget(null);

  useEffect(() => {
    if (busy || !refocusDelete.current) return;
    const button = deleteButtons.current.get(refocusDelete.current);
    refocusDelete.current = "";
    button?.focus();
  });

  const runAction = async (key, action) => {
    setPendingAction(key);
    try {
      return await action();
    } finally {
      setPendingAction("");
    }
  };

  const openCreate = () => {
    setCreating(true);
    setCreateError("");
    setTimeout(() => document.getElementById(newGroupNameId)?.focus(), 0);
  };

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError("");
  };

  const submitCreate = async (submitEvent) => {
    submitEvent.preventDefault();
    const nameError = groupNameError(newName);
    if (nameError) {
      setCreateError(nameError);
      return;
    }
    setCreateError("");
    const created = await runAction("create", () =>
      onCreate({ name: newName.trim() }),
    );
    if (created) closeCreate();
  };

  const commitWeight = async (group) => {
    const draft = weightDrafts[group.name];
    if (draft === undefined) return;
    setWeightDrafts((current) => {
      const next = { ...current };
      delete next[group.name];
      return next;
    });
    const weight = normalizeWeight(draft);
    if (weight === null || weight === group.weight) return;
    await onSetWeight(group.name, weight);
  };

  const startRename = (group) => {
    setRenaming(group.name);
    setRenameValue(group.name);
    setRenameError("");
  };

  const submitRename = async (group) => {
    const nameError = groupNameError(renameValue);
    if (nameError) {
      setRenameError(nameError);
      return;
    }
    const nextName = renameValue.trim();
    // Only an identical spelling is a no-op; case-only renames are real.
    if (nextName === group.name) {
      setRenaming(null);
      return;
    }
    const renamed = await runAction(
      `${groupFilterValue(group.name)}:rename`,
      () => onRename(group, nextName),
    );
    if (renamed) setRenaming(null);
  };

  const confirmDelete = async () => {
    const group = pendingDelete;
    const filterValue = groupFilterValue(group.name);
    setDeleteTarget(null);
    const deleted = await runAction(`${filterValue}:delete`, () =>
      onDelete(group),
    );
    if (deleted) {
      // The row and its Delete button are gone, so focus a stable landmark.
      titleRef.current?.focus();
      return;
    }
    // The row stays, but its button was disabled (and lost focus) while the
    // request ran: focus it now, or once the roster is idle again.
    const button = deleteButtons.current.get(filterValue);
    if (button && !button.disabled) button.focus();
    else refocusDelete.current = filterValue;
  };

  return (
    <section className="roster-groups" aria-labelledby={`${ids}-groups-title`}>
      <div className="roster-groups__header">
        <div className="roster-groups__copy">
          <h4
            ref={titleRef}
            id={`${ids}-groups-title`}
            className="roster-groups__title"
            tabIndex={-1}
          >
            Groups
          </h4>
          <p className="roster-groups__description">
            People can belong to several groups. Setting a group&apos;s weight
            applies it to everyone currently in that group, including people who
            are also in other groups.
          </p>
        </div>
        {!readOnly && (
          <AppButton
            variant={creating ? "outlined" : "filled"}
            size="sm"
            icon={<GroupIcon />}
            onClick={creating ? closeCreate : openCreate}
            disabled={busy}
            aria-expanded={creating}
            aria-controls={`${ids}-new-group`}
          >
            {creating ? "Close new group" : "New group"}
          </AppButton>
        )}
      </div>

      {creating && !readOnly && (
        <form
          id={`${ids}-new-group`}
          className="roster-groups__create"
          aria-labelledby={`${ids}-new-group-title`}
          noValidate
          onSubmit={submitCreate}
        >
          <h5 id={`${ids}-new-group-title`} className="h6 mb-3">
            Create a group
          </h5>
          <FormField id={newGroupNameId} label="Group name" required>
            <input
              id={newGroupNameId}
              type="text"
              className="form-control"
              aria-label="New group name"
              maxLength={100}
              value={newName}
              disabled={busy}
              onChange={(changeEvent) => {
                setNewName(changeEvent.target.value);
                setCreateError("");
              }}
            />
          </FormField>
          {createError && (
            <Alert variant="danger" role="alert" className="mt-3">
              {createError}
            </Alert>
          )}
          <div className="d-flex flex-wrap justify-content-end gap-2 mt-3">
            <AppButton variant="text" onClick={closeCreate} disabled={busy}>
              Cancel
            </AppButton>
            <AppButton
              type="submit"
              icon={<CheckIcon />}
              busy={pendingAction === "create"}
              disabled={busy}
            >
              Create group
            </AppButton>
          </div>
        </form>
      )}

      {groups.length > 0 ? (
        <div className="table-shell roster-groups__shell">
          <div
            className="table-responsive"
            role="region"
            aria-label="Roster groups"
            tabIndex={0}
          >
            <table className="table align-middle roster-groups__table">
              <caption className="visually-hidden">Roster groups</caption>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">People</th>
                  <th scope="col">Weight</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const named = group.name !== "";
                  const label = groupLabel(group.name);
                  const filterValue = groupFilterValue(group.name);
                  const showing = activeGroup === filterValue;
                  const draft = weightDrafts[group.name];
                  const empty = group.count === 0;
                  // A shared weight is null when members differ; an empty
                  // group has nothing to share and nothing to edit.
                  const mixed = group.weight === null && group.count > 0;
                  const weightInputId = `${ids}-weight-${filterValue}`;
                  return (
                    <tr key={filterValue} data-roster-group={filterValue}>
                      <th scope="row" className="roster-groups__name">
                        {renaming === group.name ? (
                          <div className="roster-groups__rename">
                            <input
                              type="text"
                              className="form-control form-control-sm"
                              aria-label={`New name for group ${label}`}
                              maxLength={100}
                              value={renameValue}
                              disabled={busy}
                              autoFocus
                              onChange={(changeEvent) => {
                                setRenameValue(changeEvent.target.value);
                                setRenameError("");
                              }}
                              onKeyDown={(keyEvent) => {
                                if (keyEvent.key === "Enter") {
                                  keyEvent.preventDefault();
                                  void submitRename(group);
                                } else if (keyEvent.key === "Escape") {
                                  setRenaming(null);
                                }
                              }}
                            />
                            <AppButton
                              size="sm"
                              icon={<CheckIcon />}
                              busy={pendingAction === `${filterValue}:rename`}
                              disabled={busy}
                              onClick={() => void submitRename(group)}
                            >
                              Save name
                            </AppButton>
                            <AppButton
                              size="sm"
                              variant="text"
                              disabled={busy}
                              onClick={() => setRenaming(null)}
                            >
                              Cancel
                            </AppButton>
                            {renameError && (
                              <span
                                className="roster-groups__error small text-danger w-100"
                                role="alert"
                              >
                                {renameError}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="d-inline-flex flex-wrap align-items-center gap-2">
                            <span className={named ? "" : "text-secondary"}>
                              {label}
                            </span>
                            {showing && (
                              <StatusBadge status="primary" dot={false}>
                                Showing
                              </StatusBadge>
                            )}
                          </span>
                        )}
                      </th>
                      <td className="roster-groups__count">
                        {peopleLabel(group.count)}
                      </td>
                      <td className="roster-groups__weight-cell">
                        <div className="d-flex flex-wrap align-items-center gap-2">
                          <input
                            id={weightInputId}
                            type="number"
                            className="form-control form-control-sm roster-groups__weight"
                            aria-label={
                              named
                                ? `Weight for group ${group.name}`
                                : "Weight for ungrouped people"
                            }
                            min="0"
                            max="1"
                            step="0.05"
                            placeholder={mixed ? "Mixed" : ""}
                            value={draft ?? group.weight ?? ""}
                            disabled={readOnly || busy || empty}
                            onChange={(changeEvent) =>
                              setWeightDrafts((current) => ({
                                ...current,
                                [group.name]: changeEvent.target.value,
                              }))
                            }
                            onBlur={() => void commitWeight(group)}
                            onKeyDown={(keyEvent) => {
                              if (keyEvent.key === "Enter") {
                                keyEvent.preventDefault();
                                keyEvent.currentTarget.blur();
                              }
                            }}
                          />
                          {mixed && draft === undefined && (
                            <StatusBadge status="neutral" dot={false}>
                              Mixed
                            </StatusBadge>
                          )}
                        </div>
                      </td>
                      <td className="roster-groups__actions-cell">
                        <div className="roster-groups__actions">
                          {!readOnly && !named && (
                            <AppButton
                              size="sm"
                              variant="outlined"
                              disabled={busy || !hasSelection}
                              busy={pendingAction === `${filterValue}:move`}
                              onClick={() =>
                                void runAction(`${filterValue}:move`, () =>
                                  onMoveSelected(""),
                                )
                              }
                            >
                              Ungroup selected
                            </AppButton>
                          )}
                          {!readOnly && named && (
                            <>
                              <AppButton
                                size="sm"
                                variant="outlined"
                                disabled={busy || !hasSelection}
                                busy={pendingAction === `${filterValue}:add`}
                                onClick={() =>
                                  void runAction(`${filterValue}:add`, () =>
                                    onAddSelected(group.name),
                                  )
                                }
                              >
                                Add selected
                              </AppButton>
                              <AppButton
                                size="sm"
                                variant="outlined"
                                disabled={busy || !hasSelection}
                                busy={pendingAction === `${filterValue}:remove`}
                                onClick={() =>
                                  void runAction(`${filterValue}:remove`, () =>
                                    onRemoveSelected(group.name),
                                  )
                                }
                              >
                                Remove selected
                              </AppButton>
                              {renaming !== group.name && (
                                <AppButton
                                  size="sm"
                                  variant="text"
                                  disabled={busy}
                                  onClick={() => startRename(group)}
                                >
                                  Rename
                                </AppButton>
                              )}
                              <AppButton
                                ref={(node) => {
                                  if (node)
                                    deleteButtons.current.set(
                                      filterValue,
                                      node,
                                    );
                                  else
                                    deleteButtons.current.delete(filterValue);
                                }}
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                busy={pendingAction === `${filterValue}:delete`}
                                onClick={() => setDeleteTarget(group)}
                              >
                                Delete group
                              </AppButton>
                            </>
                          )}
                          <AppButton
                            size="sm"
                            variant="text"
                            aria-pressed={showing}
                            onClick={() =>
                              onShowGroup(showing ? "" : filterValue)
                            }
                          >
                            {showing ? "Show everyone" : "Show people"}
                          </AppButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {namedGroups.length === 0 && (
        <p className="roster-groups__empty small text-secondary mb-0">
          No groups yet. Create a group, then select people in the list and add
          them to it.
        </p>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete group ${pendingDelete.name}?`}
          description="People stay on the roster."
          confirmLabel="Delete group"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
