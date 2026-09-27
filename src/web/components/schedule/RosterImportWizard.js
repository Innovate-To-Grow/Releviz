"use client";

import { useId, useMemo, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  ImportIcon,
  SpreadsheetIcon,
  WarningIcon,
} from "@/components/ui/icons";
import {
  cancelRosterImport,
  commitRosterImport,
  configureRosterImport,
  createRosterImport,
  fetchRosterImportRows,
} from "@/lib/api/roster";
import { rosterImportStatusMessage } from "@/lib/roster-import-status";

const FIELD_OPTIONS = [
  ["name", "Name", true],
  ["email", "Email", true],
  ["group", "Group", false],
  ["phone", "Phone", false],
  ["weight", "Weight", false],
  ["included", "Included", false],
];

const STEPS = ["Upload or paste", "Map columns", "Review and commit", "Done"];

const SOURCE_TABS = [
  { key: "file", label: "File upload", Icon: SpreadsheetIcon },
  { key: "paste", label: "Paste spreadsheet", Icon: CopyIcon },
];

const PHASE_STEP = { source: 1, mapping: 2, preview: 3, complete: 4 };

const PHASE_DESCRIPTION = {
  source: "Upload a CSV/XLSX file or paste cells from a spreadsheet.",
  mapping: "Choose a worksheet and map its columns.",
  preview: "Review validation issues before changing the event's participants.",
  complete: "The participant import was committed successfully.",
};

function normalizedHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const HEADER_ALIASES = {
  name: ["name", "fullname", "participant", "participantname"],
  email: ["email", "emailaddress", "mail"],
  group: [
    "group",
    "groupname",
    "team",
    "teamname",
    "department",
    "organization",
  ],
  phone: ["phone", "phonenumber", "mobile", "cell", "tel", "telephone"],
  weight: ["weight", "priority"],
  included: ["included", "include", "counted"],
};

// "Groups", "Teams" or "Emails" name the same column as the singular alias.
function headerMatches(header, aliases) {
  const normalized = normalizedHeader(header);
  return (
    aliases.includes(normalized) ||
    (normalized.endsWith("s") && aliases.includes(normalized.slice(0, -1)))
  );
}

function suggestedMapping(headers = [], current = {}) {
  const result = Object.fromEntries(
    Object.entries(current).map(([field, value]) => [
      field,
      Number.isInteger(value) || /^\d+$/.test(String(value))
        ? String(value)
        : "",
    ]),
  );
  // A column already mapped to one field is not offered to another.
  const used = new Set(Object.values(result).filter(Boolean));
  FIELD_OPTIONS.forEach(([field]) => {
    if (result[field] !== undefined && result[field] !== "") return;
    const match = headers.findIndex(
      (header, index) =>
        !used.has(String(index)) &&
        headerMatches(header, HEADER_ALIASES[field]),
    );
    if (match >= 0) {
      result[field] = String(match);
      used.add(String(match));
    }
  });
  return result;
}

// What an optional field gets when no column is mapped to it, spelled out so
// the choice never reads as an opaque "Use default".
function unmappedLabel(field, defaults) {
  if (field === "group") {
    const group = String(defaults.group || "").trim();
    return group ? `No column (everyone in ${group})` : "No column (no group)";
  }
  if (field === "weight") return `No column (weight ${defaults.weight})`;
  if (field === "included")
    return defaults.included
      ? "No column (everyone included)"
      : "No column (everyone left out)";
  return "No column (left blank)";
}

function importFrom(data) {
  return data?.import || data?.rosterImport || data || null;
}

// Invalid rows keep their server-provided error sentences as wrapping text
// (they can run to several sentences), with a short badge for the colour cue.
function validationStatus(row) {
  if (!row.valid) {
    return {
      status: "danger",
      text: "Invalid",
      detail: (row.errors || []).join(" · ") || "",
    };
  }
  if (row.duplicate === "identical") {
    return { status: "info", text: "Identical duplicate merged", detail: "" };
  }
  if (row.duplicate === "conflict") {
    return { status: "warning", text: "Conflicting duplicate", detail: "" };
  }
  return { status: "success", text: "Ready", detail: "" };
}

function StepIndicator({ phase }) {
  const current = PHASE_STEP[phase] || 1;
  return (
    <ol className="step-indicator" aria-label="Import steps">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const modifier =
          step < current
            ? " step-indicator__item--done"
            : step === current
              ? " step-indicator__item--active"
              : "";
        return (
          <li
            key={label}
            className={`step-indicator__item${modifier}`}
            aria-current={step === current ? "step" : undefined}
          >
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <div className="pagination-row roster-import__pagination">
      <div className="d-flex flex-wrap align-items-center gap-2 ms-auto">
        <AppButton
          variant="outlined"
          size="sm"
          icon={<ChevronLeftIcon />}
          disabled={pagination.page <= 1}
          onClick={() => onPage(pagination.page - 1)}
        >
          Previous
        </AppButton>
        <span className="pagination-row__count">
          Page {pagination.page} of {pagination.pages}
        </span>
        <AppButton
          variant="outlined"
          size="sm"
          icon={<ChevronRightIcon />}
          disabled={pagination.page >= pagination.pages}
          onClick={() => onPage(pagination.page + 1)}
        >
          Next
        </AppButton>
      </div>
    </div>
  );
}

export default function RosterImportWizard({
  event,
  getToken,
  onEventChange,
  onCommitted,
  onClose,
}) {
  const [sourceType, setSourceType] = useState("file");
  const [file, setFile] = useState(null);
  const [pastedText, setPastedText] = useState("");
  const [record, setRecord] = useState(null);
  const [worksheet, setWorksheet] = useState("");
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState({});
  const [defaults, setDefaults] = useState({
    group: "",
    weight: 1,
    included: true,
  });
  const [rows, setRows] = useState([]);
  const [rowDrafts, setRowDrafts] = useState({});
  const [pagination, setPagination] = useState(null);
  const [phase, setPhase] = useState("source");
  const [mode, setMode] = useState("merge");
  const [sendInvitations, setSendInvitations] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const idempotencyKey = useRef("");
  const sourceTabsId = useId();
  const fieldIds = useId();
  const sourceTabRefs = useRef({});

  const selectedSheet = useMemo(
    () =>
      record?.worksheets?.find((candidate) => candidate.name === worksheet) ||
      null,
    [record, worksheet],
  );
  const headers =
    record?.selectedWorksheet === worksheet &&
    Number(record?.headerRow) === Number(headerRow) &&
    record?.headers?.length
      ? record.headers
      : selectedSheet?.headers || [];

  const loadRows = async (
    importRecord = record,
    page = 1,
    tokenOverride = null,
  ) => {
    if (!importRecord?.id) return;
    const token = tokenOverride || (await getToken());
    const data = await fetchRosterImportRows(
      event.code,
      importRecord.id,
      { page, pageSize: 50 },
      token,
    );
    setRecord(importFrom(data) || importRecord);
    setRows(data.rows || []);
    setRowDrafts({});
    setPagination(
      data.pagination || {
        page,
        pageSize: 50,
        total: data.rows?.length || 0,
        pages: 1,
      },
    );
  };

  const handleSource = async () => {
    setError("");
    setStatus("");
    if (sourceType === "file") {
      if (!file) return setError("Choose a .csv or .xlsx file first.");
      if (!/\.(csv|xlsx)$/i.test(file.name))
        return setError("Only .csv and .xlsx files are supported.");
      if (file.size > 5 * 1024 * 1024)
        return setError("The compressed file must be 5 MiB or smaller.");
    } else if (!pastedText.trim()) {
      return setError("Paste rows copied from Google Sheets or Excel first.");
    }
    setBusy(true);
    try {
      const token = await getToken();
      const data = await createRosterImport(
        event.code,
        sourceType === "file" ? { file } : { pastedText },
        token,
      );
      const nextRecord = importFrom(data);
      setRecord(nextRecord);
      const nextWorksheet =
        nextRecord?.selectedWorksheet ||
        (nextRecord?.worksheets?.length === 1
          ? nextRecord.worksheets[0].name
          : "");
      const nextHeaders =
        nextRecord?.worksheets?.find(
          (candidate) => candidate.name === nextWorksheet,
        )?.headers || [];
      setWorksheet(nextWorksheet);
      setHeaderRow(nextRecord?.headerRow || 1);
      setMapping(
        suggestedMapping(nextHeaders, nextRecord?.columnMapping || {}),
      );
      setDefaults({
        group: nextRecord?.defaults?.group || "",
        weight: nextRecord?.defaults?.weight ?? 1,
        included: nextRecord?.defaults?.included ?? true,
      });
      setPhase("mapping");
    } catch (requestError) {
      setError(requestError.message || "Unable to read this import source.");
    } finally {
      setBusy(false);
    }
  };

  const handleConfigure = async () => {
    setError("");
    setStatus("");
    if (!worksheet) {
      setError("Choose a worksheet before mapping columns.");
      return;
    }
    const defaultHeaderRow = Number(selectedSheet?.defaultHeaderRow || 1);
    const needsHeaderRefresh =
      Number(headerRow) !== defaultHeaderRow &&
      (record?.selectedWorksheet !== worksheet ||
        Number(record?.headerRow) !== Number(headerRow));
    if (needsHeaderRefresh) {
      setBusy(true);
      try {
        const token = await getToken();
        const data = await configureRosterImport(
          event.code,
          record.id,
          { worksheet, headerRow },
          token,
        );
        const nextRecord = importFrom(data);
        const nextHeaders = nextRecord?.headers || [];
        setRecord(nextRecord);
        setMapping(suggestedMapping(nextHeaders));
        setStatus(
          "Columns loaded from the selected header row. Check the mapping, then preview.",
        );
      } catch (requestError) {
        setError(
          requestError.message ||
            "Unable to load columns from this header row.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!mapping.name || !mapping.email) {
      setError("Map both the name and email columns.");
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      const data = await configureRosterImport(
        event.code,
        record.id,
        { worksheet, headerRow, columnMapping: mapping, defaults },
        token,
      );
      const nextRecord = importFrom(data);
      setRecord(nextRecord);
      await loadRows(nextRecord, 1, token);
      setPhase("preview");
    } catch (requestError) {
      setError(
        requestError.message || "Unable to validate the column mapping.",
      );
    } finally {
      setBusy(false);
    }
  };

  const updateRow = async (row, updates) => {
    setError("");
    setBusy(true);
    try {
      const token = await getToken();
      const data = await configureRosterImport(
        event.code,
        record.id,
        { rowUpdates: [{ id: row.id, ...updates }] },
        token,
      );
      setRecord(importFrom(data));
      await loadRows(importFrom(data), pagination?.page || 1, token);
      return true;
    } catch (requestError) {
      setError(requestError.message || "Unable to update this row.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rowDraftValue = (row, field, serverValue) =>
    Object.hasOwn(rowDrafts[row.id] || {}, field)
      ? rowDrafts[row.id][field]
      : serverValue;

  const updateRowDraft = (rowId, field, value) => {
    setRowDrafts((current) => ({
      ...current,
      [rowId]: { ...current[rowId], [field]: value },
    }));
  };

  const clearRowDraft = (rowId, field, expectedValue) => {
    setRowDrafts((current) => {
      const currentRow = current[rowId];
      if (!currentRow || String(currentRow[field]) !== String(expectedValue))
        return current;
      const nextRow = { ...currentRow };
      delete nextRow[field];
      const next = { ...current };
      if (Object.keys(nextRow).length) next[rowId] = nextRow;
      else delete next[rowId];
      return next;
    });
  };

  const saveRowDraft = async (row, field, value, serverValue) => {
    if (String(value) !== String(serverValue)) {
      await updateRow(row, { [field]: value });
    }
    clearRowDraft(row.id, field, value);
  };

  const selectSourceType = (nextSource, { focus = false } = {}) => {
    setSourceType(nextSource);
    if (focus) sourceTabRefs.current[nextSource]?.focus();
  };

  const handleSourceTabKeyDown = (event) => {
    const sources = ["file", "paste"];
    const currentIndex = sources.indexOf(sourceType);
    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % sources.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + sources.length) % sources.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = sources.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectSourceType(sources[nextIndex], { focus: true });
  };

  const handleCommit = async () => {
    setError("");
    setStatus("");
    if (mode === "rebuild" && confirmationCode !== event.code) {
      setError("Enter the event code exactly to confirm a rebuild.");
      return;
    }
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    setBusy(true);
    try {
      const token = await getToken();
      const data = await commitRosterImport(
        event.code,
        record.id,
        {
          mode,
          idempotencyKey: idempotencyKey.current,
          sendInvitations,
          ...(mode === "rebuild" ? { confirmationCode } : {}),
        },
        token,
      );
      setStatus(
        rosterImportStatusMessage({
          receipt: data.receipt,
          autoInvitedCount: data.autoInvitedCount,
          sendInvitations,
        }),
      );
      setPhase("complete");
      onCommitted?.({ ...data, sendInvitations });
    } catch (requestError) {
      if (requestError.event) onEventChange?.(requestError.event);
      setError(
        requestError.code === "event_not_active" ||
          requestError.event?.status === "closed"
          ? "This event is closed. Reactivate it before committing this import."
          : requestError.message || "Unable to commit this import.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!record?.id) return onClose?.();
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      await cancelRosterImport(event.code, record.id, token);
      onClose?.();
    } catch (requestError) {
      setError(requestError.message || "Unable to cancel this import.");
    } finally {
      setBusy(false);
    }
  };

  const includeByDefaultId = `${fieldIds}-include-by-default`;
  const mergeModeId = `${fieldIds}-mode-merge`;
  const rebuildModeId = `${fieldIds}-mode-rebuild`;
  const sendInvitationsId = `${fieldIds}-send-invitations`;
  const commitDisabled =
    busy ||
    !record?.summary?.valid ||
    (mode === "rebuild" && confirmationCode !== event.code);

  return (
    <Panel
      className="roster-import"
      headingLevel={3}
      titleId="roster-import-heading"
      title="Import participants"
      description={PHASE_DESCRIPTION[phase]}
      actions={
        onClose ? (
          <AppButton
            variant="text"
            icon={<CloseIcon />}
            onClick={handleCancel}
            disabled={busy}
          >
            Close
          </AppButton>
        ) : null
      }
      aria-labelledby="roster-import-heading"
    >
      <StepIndicator phase={phase} />

      {phase === "source" && (
        <div className="d-flex flex-column gap-3">
          <ul
            className="nav nav-pills roster-import__source-switcher"
            role="tablist"
            aria-label="Import source"
          >
            {SOURCE_TABS.map(({ key, label, Icon }) => (
              <li className="nav-item" role="presentation" key={key}>
                <button
                  type="button"
                  role="tab"
                  className={`nav-link d-inline-flex align-items-center gap-2${
                    sourceType === key ? " active" : ""
                  }`}
                  id={`${sourceTabsId}-${key}-tab`}
                  aria-controls={`${sourceTabsId}-${key}-panel`}
                  aria-selected={sourceType === key}
                  tabIndex={sourceType === key ? 0 : -1}
                  ref={(node) => {
                    sourceTabRefs.current[key] = node;
                  }}
                  onClick={() => selectSourceType(key)}
                  onKeyDown={handleSourceTabKeyDown}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
          <div
            role="tabpanel"
            id={`${sourceTabsId}-${sourceType}-panel`}
            aria-labelledby={`${sourceTabsId}-${sourceType}-tab`}
            className="d-flex flex-column gap-3"
          >
            {sourceType === "file" ? (
              <FormField
                label="CSV or XLSX file"
                help="Maximum compressed size: 5 MiB. Legacy .xls files and formulas are not supported."
              >
                <input
                  type="file"
                  className="form-control"
                  aria-label="CSV or XLSX file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </FormField>
            ) : (
              <FormField label="Rows copied from Google Sheets or Excel">
                <textarea
                  className="form-control font-monospace"
                  aria-label="Pasted participant rows"
                  rows={9}
                  value={pastedText}
                  onChange={(event) => setPastedText(event.target.value)}
                  placeholder={
                    "name\temail\tgroup\nAda\tada@example.com\tFaculty; Team 3"
                  }
                />
              </FormField>
            )}
            <div className="d-flex flex-wrap gap-2">
              <AppButton
                icon={<ArrowRightIcon />}
                busy={busy}
                onClick={handleSource}
                disabled={busy}
              >
                {busy ? "Reading…" : "Continue to mapping"}
              </AppButton>
            </div>
          </div>
        </div>
      )}

      {phase === "mapping" && (
        <div className="d-flex flex-column gap-3">
          <div className="row g-3">
            {record?.worksheets?.length > 1 && (
              <div className="col-12 col-md-6">
                <FormField label="Worksheet">
                  <select
                    className="form-select"
                    value={worksheet}
                    onChange={(event) => {
                      const name = event.target.value;
                      const selected = record.worksheets.find(
                        (item) => item.name === name,
                      );
                      const sheetHeaders = selected?.headers || [];
                      setWorksheet(name);
                      setHeaderRow(selected?.defaultHeaderRow || 1);
                      setMapping(suggestedMapping(sheetHeaders));
                    }}
                  >
                    <option value="">Choose a worksheet</option>
                    {record.worksheets.map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} ({sheet.rowCount} rows)
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            )}
            <div className="col-12 col-sm-6 col-md-3">
              <FormField label="Header row">
                <input
                  type="number"
                  className="form-control"
                  min="1"
                  value={headerRow}
                  onChange={(event) => {
                    const nextHeaderRow = Number(event.target.value);
                    setHeaderRow(nextHeaderRow);
                    setMapping(
                      nextHeaderRow ===
                        Number(selectedSheet?.defaultHeaderRow || 1)
                        ? suggestedMapping(selectedSheet?.headers || [])
                        : {},
                    );
                  }}
                />
              </FormField>
            </div>
          </div>

          <fieldset className="roster-import__mapping-grid">
            <legend className="fs-6 fw-semibold mb-2">Column mapping</legend>
            <p className="small text-secondary mb-3">
              Columns are matched by their header (for example Group, Groups or
              Team). Check each field: one without a column uses the default
              shown, which you can change under Defaults.
            </p>
            <div className="row g-3">
              {FIELD_OPTIONS.map(([field, label, mandatory]) => (
                <div className="col-12 col-md-4" key={field}>
                  <FormField label={`${label}${mandatory ? " *" : ""}`}>
                    <select
                      className="form-select"
                      value={mapping[field] || ""}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [field]: event.target.value || undefined,
                        }))
                      }
                    >
                      <option value="">
                        {mandatory
                          ? "Select a column"
                          : unmappedLabel(field, defaults)}
                      </option>
                      {headers.map((header, index) => (
                        <option
                          key={`${index}:${header}`}
                          value={String(index)}
                        >
                          {header || `Column ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </FormField>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="roster-import__defaults-grid">
            <legend className="fs-6 fw-semibold mb-2">Defaults</legend>
            <div className="row g-3 align-items-end">
              <div className="col-12 col-md-4">
                <FormField
                  label="Default group"
                  help="Blank = unassigned, ALL = every group, separate several names with ; or ,"
                >
                  <input
                    className="form-control"
                    value={defaults.group}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        group: event.target.value,
                      }))
                    }
                  />
                </FormField>
              </div>
              <div className="col-12 col-md-4">
                <FormField label="Default weight">
                  <input
                    type="number"
                    className="form-control"
                    min="0"
                    max="1"
                    step="0.05"
                    value={defaults.weight}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        weight: Number(event.target.value),
                      }))
                    }
                  />
                </FormField>
              </div>
              <div className="col-12 col-md-4">
                <div className="form-check mb-2">
                  <input
                    id={includeByDefaultId}
                    className="form-check-input"
                    type="checkbox"
                    checked={Boolean(defaults.included)}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        included: event.target.checked,
                      }))
                    }
                  />
                  <label
                    className="form-check-label"
                    htmlFor={includeByDefaultId}
                  >
                    Include by default
                  </label>
                </div>
              </div>
            </div>
          </fieldset>

          <div className="d-flex flex-wrap gap-2">
            <AppButton
              variant="outlined"
              icon={<ChevronLeftIcon />}
              onClick={() => setPhase("source")}
              disabled={busy}
            >
              Back
            </AppButton>
            <AppButton
              icon={<ArrowRightIcon />}
              busy={busy}
              onClick={handleConfigure}
              disabled={busy}
            >
              {busy ? "Validating…" : "Preview rows"}
            </AppButton>
          </div>
        </div>
      )}

      {phase === "preview" && (
        <div className="d-flex flex-column gap-3">
          <div className="metric-tiles roster-import__summary">
            {[
              ["Selected", record?.summary?.selected],
              ["Valid", record?.summary?.valid],
              ["Invalid", record?.summary?.invalid],
              ["Conflicts", record?.summary?.conflicts],
            ].map(([label, value]) => (
              <div className="metric-tile" key={label}>
                <span className="metric-tile__label">{label}</span>
                <strong className="metric-tile__value">{value || 0}</strong>
              </div>
            ))}
          </div>

          <div className="table-shell">
            <div
              className="table-responsive"
              role="region"
              aria-label="Imported rows awaiting review"
              tabIndex={0}
            >
              <table className="table table-sm align-middle roster-import__table">
                <caption className="visually-hidden">
                  Imported rows awaiting review
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Use</th>
                    <th scope="col">Row</th>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Group</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Included</th>
                    <th scope="col">Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const validation = validationStatus(row);
                    return (
                      <tr
                        key={row.id}
                        className={row.selected ? undefined : "opacity-50"}
                      >
                        <td>
                          <input
                            className="form-check-input"
                            aria-label={`Select row ${row.rowNumber}`}
                            type="checkbox"
                            checked={Boolean(row.selected)}
                            disabled={busy}
                            onChange={(event) =>
                              updateRow(row, { selected: event.target.checked })
                            }
                          />
                        </td>
                        <td className="tabular-nums">{row.rowNumber}</td>
                        <td>
                          <input
                            className="form-control form-control-sm"
                            aria-label={`Name for row ${row.rowNumber}`}
                            value={rowDraftValue(row, "name", row.name || "")}
                            disabled={busy}
                            onChange={(event) =>
                              updateRowDraft(row.id, "name", event.target.value)
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                row,
                                "name",
                                event.target.value,
                                row.name || "",
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="form-control form-control-sm"
                            aria-label={`Email for row ${row.rowNumber}`}
                            value={rowDraftValue(row, "email", row.email || "")}
                            disabled={busy}
                            onChange={(event) =>
                              updateRowDraft(
                                row.id,
                                "email",
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                row,
                                "email",
                                event.target.value,
                                row.email || "",
                              )
                            }
                          />
                          {row.organizerManaged && (
                            <small className="d-block text-secondary mt-1">
                              No email of their own: you&apos;ll enter their
                              schedule
                            </small>
                          )}
                        </td>
                        <td>
                          <input
                            className="form-control form-control-sm"
                            aria-label={`Group for row ${row.rowNumber}`}
                            value={rowDraftValue(row, "group", row.group || "")}
                            disabled={busy}
                            onChange={(event) =>
                              updateRowDraft(
                                row.id,
                                "group",
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                row,
                                "group",
                                event.target.value,
                                row.group || "",
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="form-control form-control-sm"
                            aria-label={`Phone for row ${row.rowNumber}`}
                            type="tel"
                            maxLength={32}
                            value={rowDraftValue(row, "phone", row.phone || "")}
                            disabled={busy}
                            onChange={(event) =>
                              updateRowDraft(
                                row.id,
                                "phone",
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                row,
                                "phone",
                                event.target.value,
                                row.phone || "",
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="form-control form-control-sm"
                            style={{ width: "6rem" }}
                            aria-label={`Weight for row ${row.rowNumber}`}
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={rowDraftValue(
                              row,
                              "weight",
                              row.weight ?? 1,
                            )}
                            disabled={busy}
                            onChange={(event) =>
                              updateRowDraft(
                                row.id,
                                "weight",
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                row,
                                "weight",
                                Number(event.target.value),
                                Number(row.weight ?? 1),
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="form-check-input"
                            aria-label={`Included for row ${row.rowNumber}`}
                            type="checkbox"
                            checked={Boolean(row.included)}
                            disabled={busy}
                            onChange={(event) =>
                              updateRow(row, { included: event.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <div className="d-flex flex-column align-items-start gap-1">
                            <StatusBadge status={validation.status}>
                              {validation.text}
                            </StatusBadge>
                            {validation.detail && (
                              <small
                                className="text-danger-emphasis text-wrap"
                                style={{ maxWidth: "18rem" }}
                              >
                                {validation.detail}
                              </small>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <Pagination
            pagination={pagination}
            onPage={(page) =>
              loadRows(record, page).catch((requestError) =>
                setError(requestError.message),
              )
            }
          />

          <fieldset className="roster-import__mode-options border rounded p-3">
            <legend className="fs-6 fw-semibold float-none w-auto px-2 mb-2">
              Import behavior
            </legend>
            <p className="roster-import__hint form-text mt-0 mb-3">
              Existing participants are updated without another email. New
              people are emailed only if you tick the box; you can also send
              invitations later from the participant list. A blank email, or one
              of your own addresses, adds someone with no email of their own:
              they are never emailed, and you enter their schedule.
            </p>
            <div className="form-check">
              <input
                id={mergeModeId}
                className="form-check-input"
                type="radio"
                name="import-mode"
                value="merge"
                checked={mode === "merge"}
                onChange={() => setMode("merge")}
              />
              <label className="form-check-label" htmlFor={mergeModeId}>
                Merge with the current participants and preserve schedules
              </label>
            </div>
            <div className="form-check">
              <input
                id={rebuildModeId}
                className="form-check-input"
                type="radio"
                name="import-mode"
                value="rebuild"
                checked={mode === "rebuild"}
                onChange={() => setMode("rebuild")}
              />
              <label className="form-check-label" htmlFor={rebuildModeId}>
                Rebuild the participant list and clear schedules, invitations,
                and pending delivery
              </label>
            </div>
            {mode === "rebuild" && (
              <div className="d-flex flex-column gap-3 mt-3">
                <Alert
                  variant="warning"
                  role="note"
                  className="roster-import__warning"
                >
                  Rebuilding clears schedules, invitations, and pending
                  delivery. With invitations enabled below it sends a new
                  invitation to every imported participant; otherwise everyone
                  starts as Not sent and gets no reminders until you send
                  invitations.
                </Alert>
                <div className="row">
                  <div className="col-12 col-md-6">
                    <FormField
                      label={`Type ${event.code} to confirm`}
                      className="roster-import__confirmation-field"
                    >
                      <input
                        className="form-control"
                        aria-label="Rebuild confirmation code"
                        value={confirmationCode}
                        onChange={(event) =>
                          setConfirmationCode(event.target.value)
                        }
                        autoComplete="off"
                      />
                    </FormField>
                  </div>
                </div>
              </div>
            )}
            <div className="form-check mt-3">
              <input
                id={sendInvitationsId}
                className="form-check-input"
                type="checkbox"
                checked={sendInvitations}
                onChange={(event) => setSendInvitations(event.target.checked)}
              />
              <label className="form-check-label" htmlFor={sendInvitationsId}>
                Send invitations to newly added people
              </label>
            </div>
          </fieldset>

          <div className="d-flex flex-wrap gap-2">
            <AppButton
              variant="outlined"
              icon={<ChevronLeftIcon />}
              onClick={() => setPhase("mapping")}
              disabled={busy}
            >
              Back
            </AppButton>
            <AppButton
              variant={mode === "rebuild" ? "danger-filled" : "filled"}
              icon={mode === "rebuild" ? <WarningIcon /> : <ImportIcon />}
              busy={busy}
              onClick={handleCommit}
              disabled={commitDisabled}
            >
              {busy
                ? "Importing…"
                : mode === "rebuild"
                  ? sendInvitations
                    ? "Rebuild participant list and send invitations"
                    : "Rebuild participant list"
                  : sendInvitations
                    ? "Merge participants and invite new people"
                    : "Merge participants"}
            </AppButton>
          </div>
        </div>
      )}

      {phase === "complete" && (
        <div className="roster-import__complete d-flex flex-column gap-3">
          <Alert
            variant="success"
            role="status"
            className="roster-import__status"
          >
            {status}
          </Alert>
          <div className="d-flex flex-wrap gap-2">
            <AppButton icon={<ArrowRightIcon />} onClick={onClose}>
              Return to participants
            </AppButton>
          </div>
        </div>
      )}
      {phase !== "complete" && status && (
        <Alert
          variant="info"
          role="status"
          className="roster-import__status mt-3"
        >
          {status}
        </Alert>
      )}
      {error && (
        <Alert
          variant="danger"
          role="alert"
          className="roster-import__error mt-3"
        >
          {error}
        </Alert>
      )}
    </Panel>
  );
}
