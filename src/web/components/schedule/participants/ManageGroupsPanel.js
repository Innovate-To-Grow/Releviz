"use client";

import { useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { CheckIcon } from "@/components/ui/icons";
import Drawer from "@/components/schedule/participants/Drawer";
import { IconMenuButton } from "@/components/schedule/participants/MenuButton";
import MixedCheckbox from "@/components/schedule/participants/MixedCheckbox";
import { groupNameError, peopleCount, weightError } from "@/lib/participants";

const NO_GROUP = "No group";

function keyOf(group) {
  return group.id ?? "ungrouped";
}

// `includedCount: null` means some but not all members count, without the
// listing saying how many.
function countedText(group) {
  if (!group.count) return "—";
  if (group.includedCount === null) return "Some";
  if (group.includedCount === group.count) return "All";
  if (!group.includedCount) return "None";
  return `${group.includedCount} of ${group.count}`;
}

/**
 * Side drawer listing every group with its head count, shared weight and
 * how many of its people count in the results, plus rename, count-only,
 * delete and create. The `No group` bucket has the same controls but no
 * menu. `busyKey` names the request in flight (`create`, `rename:{id}`,
 * `weight:{id}`, `included:{id}`, `countOnly:{id}`, `delete:{id}`, with
 * `ungrouped` standing in for the bucket's id).
 */
export default function ManageGroupsPanel({
  groups = [],
  ungrouped = { count: 0, weight: null, includedCount: 0 },
  totals = null,
  busyKey = "",
  error = "",
  readOnly = false,
  onSetWeight,
  onSetIncluded,
  onCountOnly,
  onDelete,
  onRename,
  onCreate,
  onSelectPeople,
  onClose,
}) {
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [weightDrafts, setWeightDrafts] = useState({});
  const [weightErrors, setWeightErrors] = useState({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [localError, setLocalError] = useState("");

  const busy = Boolean(busyKey);
  const locked = readOnly || busy;
  const noGroupRow = { id: null, name: "", ...ungrouped };
  const rows = [...groups, noGroupRow];
  const totalPeople =
    totals?.total ??
    groups.reduce((sum, group) => sum + (group.count || 0), 0) +
      (ungrouped.count || 0);

  const run = async (action) => {
    setLocalError("");
    try {
      return await action();
    } catch (caught) {
      setLocalError(caught?.message || "That change could not be saved.");
      return false;
    }
  };

  const commitWeight = async (group) => {
    const key = keyOf(group);
    const draft = weightDrafts[key];
    if (draft === undefined) return;
    setWeightDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (draft === "") return;
    const message = weightError(draft);
    if (message) {
      setWeightErrors((current) => ({ ...current, [key]: message }));
      return;
    }
    setWeightErrors((current) => ({ ...current, [key]: "" }));
    const weight = Number(draft);
    if (weight === group.weight) return;
    await run(() => onSetWeight(group, weight));
  };

  const startRename = (group) => {
    setRenaming(group.id);
    setRenameValue(group.name);
    setRenameError("");
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameError("");
  };

  const submitRename = async (group) => {
    const message = groupNameError(renameValue);
    if (message) {
      setRenameError(message);
      return;
    }
    const nextName = renameValue.trim();
    if (nextName === group.name) {
      cancelRename();
      return;
    }
    const renamed = await run(() => onRename(group, nextName));
    if (renamed !== false) cancelRename();
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError("");
  };

  const submitCreate = async (submitEvent) => {
    submitEvent.preventDefault();
    const message = groupNameError(newName);
    if (message) {
      setCreateError(message);
      return;
    }
    const created = await run(() => onCreate(newName.trim()));
    if (created !== false) cancelCreate();
  };

  const confirmAction = async () => {
    const { type, group } = confirm;
    await run(() => (type === "delete" ? onDelete(group) : onCountOnly(group)));
    setConfirm(null);
  };

  const stopEscape = (event, cancel) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    }
  };

  const createForm = creating ? (
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
        onKeyDown={(event) => stopEscape(event, cancelCreate)}
      />
      <AppButton
        type="submit"
        size="sm"
        icon={<CheckIcon />}
        busy={busyKey === "create"}
        disabled={locked}
      >
        Create
      </AppButton>
      <AppButton
        size="sm"
        variant="text"
        disabled={busy}
        onClick={cancelCreate}
      >
        Cancel
      </AppButton>
      {createError && (
        <span className="small text-danger w-100" role="alert">
          {createError}
        </span>
      )}
    </form>
  ) : (
    !readOnly && (
      <AppButton
        variant="text"
        size="sm"
        className="p-0"
        disabled={busy}
        onClick={() => setCreating(true)}
      >
        + New group
      </AppButton>
    )
  );

  return (
    <>
      <Drawer
        title="Groups"
        subtitle="Groups are labels for filtering and changing many people at once. Results use each person's weight and whether they count."
        onClose={onClose}
        busy={busy}
        dialogOpen={Boolean(confirm)}
        closeLabel="Close groups"
        className="participants-groups-panel"
        footer={
          <AppButton variant="outlined" onClick={onClose} disabled={busy}>
            Close
          </AppButton>
        }
      >
        {(error || localError) && (
          <Alert variant="danger" role="alert">
            {error || localError}
          </Alert>
        )}
        {groups.length === 0 ? (
          <p className="text-secondary mb-0">
            No groups yet. Groups let you filter the list and set weight or
            counting for several people at once.
          </p>
        ) : (
          <div className="table-shell">
            <div
              className="table-responsive"
              role="region"
              aria-label="Groups table"
              tabIndex={0}
            >
              <table className="table align-middle participants-groups-table">
                <caption className="visually-hidden">Groups</caption>
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col">People</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Counted</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((group) => {
                    const named = group.id !== null;
                    const label = named ? group.name : NO_GROUP;
                    const key = keyOf(group);
                    const empty = !group.count;
                    const mixedWeight = group.weight === null && !empty;
                    const draft = weightDrafts[key];
                    const allCounted =
                      !empty && group.includedCount === group.count;
                    const mixedCounted =
                      (!empty && group.includedCount === null) ||
                      (group.includedCount > 0 &&
                        group.includedCount < group.count);
                    return (
                      <tr key={key} data-participants-group={key}>
                        <th
                          scope="row"
                          className="participants-groups-table__name"
                        >
                          {renaming === group.id && named ? (
                            <div className="participants-inline-form">
                              <input
                                type="text"
                                className={`form-control form-control-sm${renameError ? " is-invalid" : ""}`}
                                aria-label={`New name for ${group.name}`}
                                maxLength={100}
                                value={renameValue}
                                disabled={busy}
                                autoFocus
                                onChange={(event) => {
                                  setRenameValue(event.target.value);
                                  setRenameError("");
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void submitRename(group);
                                  } else stopEscape(event, cancelRename);
                                }}
                              />
                              <AppButton
                                size="sm"
                                icon={<CheckIcon />}
                                busy={busyKey === `rename:${group.id}`}
                                disabled={busy}
                                onClick={() => void submitRename(group)}
                              >
                                Save
                              </AppButton>
                              <AppButton
                                size="sm"
                                variant="text"
                                disabled={busy}
                                onClick={cancelRename}
                              >
                                Cancel
                              </AppButton>
                              {renameError && (
                                <span
                                  className="small text-danger w-100"
                                  role="alert"
                                >
                                  {renameError}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className={named ? "" : "text-secondary"}>
                              {label}
                            </span>
                          )}
                        </th>
                        <td className="text-nowrap">
                          {peopleCount(group.count || 0)}
                        </td>
                        <td className="participants-groups-table__weight">
                          <input
                            type="number"
                            className={`form-control form-control-sm${weightErrors[key] ? " is-invalid" : ""}`}
                            aria-label={`Weight for ${label}`}
                            aria-describedby={
                              weightErrors[key]
                                ? `${key}-weight-error`
                                : undefined
                            }
                            min="0"
                            max="1"
                            step="0.05"
                            placeholder={mixedWeight ? "mixed" : ""}
                            value={draft ?? group.weight ?? ""}
                            disabled={locked || empty}
                            onChange={(event) => {
                              const next = event.target.value;
                              setWeightDrafts((current) => ({
                                ...current,
                                [key]: next,
                              }));
                              setWeightErrors((current) => ({
                                ...current,
                                [key]: "",
                              }));
                            }}
                            onBlur={() => void commitWeight(group)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          {weightErrors[key] && (
                            <span
                              id={`${key}-weight-error`}
                              className="small text-danger d-block"
                              role="alert"
                            >
                              {weightErrors[key]}
                            </span>
                          )}
                        </td>
                        <td className="participants-groups-table__counted">
                          <div className="d-flex align-items-center gap-2">
                            <MixedCheckbox
                              className="form-check-input mt-0"
                              aria-label={`Count ${label} in the results`}
                              checked={allCounted}
                              mixed={mixedCounted}
                              disabled={locked || empty}
                              onChange={(event) => {
                                const next = event.target.checked;
                                void run(() => onSetIncluded(group, next));
                              }}
                            />
                            <span className="small text-secondary text-nowrap">
                              {countedText(group)}
                            </span>
                          </div>
                        </td>
                        <td className="participants-groups-table__actions">
                          {named && (
                            <IconMenuButton
                              ariaLabel={`Actions for ${group.name}`}
                              items={[
                                {
                                  key: "select",
                                  label: `Select these ${group.count || 0} people`,
                                  disabled: empty,
                                  onSelect: () => onSelectPeople?.(group),
                                },
                                {
                                  key: "rename",
                                  label: "Rename",
                                  hidden: Boolean(group.isAll),
                                  disabled: locked,
                                  onSelect: () => startRename(group),
                                },
                                {
                                  key: "count-only",
                                  label: "Count only this group…",
                                  disabled: locked || empty,
                                  onSelect: () =>
                                    setConfirm({ type: "countOnly", group }),
                                },
                                {
                                  key: "delete",
                                  label: "Delete group…",
                                  danger: true,
                                  hidden: Boolean(group.isAll),
                                  disabled: locked,
                                  onSelect: () =>
                                    setConfirm({ type: "delete", group }),
                                },
                              ]}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {createForm}
      </Drawer>
      {confirm?.type === "countOnly" && (
        <ConfirmDialog
          title={`Count only ${confirm.group.name} in the results?`}
          confirmLabel="Count only this group"
          busy={busyKey === `countOnly:${confirm.group.id}`}
          onConfirm={() => void confirmAction()}
          onClose={() => setConfirm(null)}
        >
          <p className="mb-0">
            {Math.max(totalPeople - (confirm.group.count || 0), 0)} people
            outside {confirm.group.name} will be left out. Weights don&apos;t
            change.
          </p>
        </ConfirmDialog>
      )}
      {confirm?.type === "delete" && (
        <ConfirmDialog
          title={`Delete group ${confirm.group.name}?`}
          confirmLabel="Delete group"
          busy={busyKey === `delete:${confirm.group.id}`}
          onConfirm={() => void confirmAction()}
          onClose={() => setConfirm(null)}
        >
          <p className="mb-0">People stay on the participant list.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
