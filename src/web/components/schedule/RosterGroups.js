"use client";

import { useId, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import StatusBadge from "@/components/ui/StatusBadge";
import { CheckIcon, GroupIcon } from "@/components/ui/icons";

export const UNGROUPED = "__ungrouped__";

// Roster stats list groups as [{ name, count, weight }]; older payloads send
// bare names or a { name: count } map. Ungrouped people carry an empty name
// and sort last. `weight` is the value everyone in the group shares, or null
// when members differ.
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

function normalizeWeight(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return number;
}

function groupNameError(value) {
  const name = String(value || "").trim();
  if (!name) return "Enter a group name.";
  if (name.length > 100) return "Group names must be 100 characters or fewer.";
  return "";
}

/**
 * Organizer grouping controls: every group with its head count and shared
 * weight, inline weight and rename edits, and a way to move the people
 * selected in the roster table into a group (or a brand-new one).
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
  onMoveSelected,
  onCreate,
}) {
  const ids = useId();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWeight, setNewWeight] = useState("1");
  const [createError, setCreateError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [weightDrafts, setWeightDrafts] = useState({});

  const namedGroups = groups.filter((group) => group.name !== "");
  const busy = Boolean(busyGroup);
  const hasSelection = selectedCount > 0;
  const selectionHint = hasSelection
    ? `${selectedCount} selected in the list`
    : "Select people in the list first";
  const newGroupNameId = `${ids}-new-group-name`;
  const newGroupWeightId = `${ids}-new-group-weight`;

  const openCreate = () => {
    setCreating(true);
    setCreateError("");
    setTimeout(() => document.getElementById(newGroupNameId)?.focus(), 0);
  };

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewWeight("1");
    setCreateError("");
  };

  const submitCreate = async (submitEvent) => {
    submitEvent.preventDefault();
    const nameError = groupNameError(newName);
    if (nameError) {
      setCreateError(nameError);
      return;
    }
    if (!hasSelection) {
      setCreateError("Select the people to put in this group first.");
      return;
    }
    const weight = normalizeWeight(newWeight);
    if (weight === null) {
      setCreateError("Weight must be between 0 and 1.");
      return;
    }
    setCreateError("");
    const created = await onCreate({ name: newName.trim(), weight });
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
    if (nextName === group.name) {
      setRenaming(null);
      return;
    }
    const renamed = await onRename(group.name, nextName);
    if (renamed) setRenaming(null);
  };

  return (
    <section className="roster-groups" aria-labelledby={`${ids}-groups-title`}>
      <div className="roster-groups__header">
        <div className="roster-groups__copy">
          <h4 id={`${ids}-groups-title`} className="roster-groups__title">
            Groups
          </h4>
          <p className="roster-groups__description">
            A group&apos;s weight applies to everyone in it: 1 counts a person
            in full, 0.5 as half a vote, 0 as an observer.
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
          <h5 id={`${ids}-new-group-title`} className="h6 mb-1">
            New group from the selected people
          </h5>
          <p className="small text-secondary mb-3">{selectionHint}.</p>
          <div className="form-row-2">
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
            <FormField id={newGroupWeightId} label="Weight">
              <input
                id={newGroupWeightId}
                type="number"
                className="form-control"
                aria-label="New group weight"
                min="0"
                max="1"
                step="0.05"
                value={newWeight}
                disabled={busy}
                onChange={(changeEvent) => {
                  setNewWeight(changeEvent.target.value);
                  setCreateError("");
                }}
              />
            </FormField>
          </div>
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
              busy={busyGroup === "create"}
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
                  const label = groupLabel(group.name);
                  const filterValue = groupFilterValue(group.name);
                  const showing = activeGroup === filterValue;
                  const rowBusy = busyGroup === filterValue;
                  const draft = weightDrafts[group.name];
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
                              busy={rowBusy}
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
                            <span
                              className={
                                group.name === "" ? "text-secondary" : ""
                              }
                            >
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
                              group.name === ""
                                ? "Weight for ungrouped people"
                                : `Weight for group ${group.name}`
                            }
                            min="0"
                            max="1"
                            step="0.05"
                            placeholder={group.weight === null ? "Mixed" : ""}
                            value={draft ?? group.weight ?? ""}
                            disabled={readOnly || busy}
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
                          {group.weight === null && draft === undefined && (
                            <StatusBadge status="neutral" dot={false}>
                              Mixed
                            </StatusBadge>
                          )}
                        </div>
                      </td>
                      <td className="roster-groups__actions-cell">
                        <div className="roster-groups__actions">
                          {!readOnly && (
                            <AppButton
                              size="sm"
                              variant="outlined"
                              disabled={busy || !hasSelection}
                              title={hasSelection ? undefined : selectionHint}
                              busy={rowBusy && hasSelection}
                              onClick={() => void onMoveSelected(group.name)}
                            >
                              {group.name === ""
                                ? "Ungroup selected"
                                : "Move selected here"}
                            </AppButton>
                          )}
                          {!readOnly &&
                            group.name !== "" &&
                            renaming !== group.name && (
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
          No groups yet. Select people in the list and create a group, or type a
          group name on a person&apos;s row.
        </p>
      )}
    </section>
  );
}
