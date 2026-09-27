"use client";

import { useId, useMemo, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import FormField from "@/components/ui/FormField";
import Modal from "@/components/ui/Modal";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ImportIcon,
  SendIcon,
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
import { parsePastedTable } from "@/lib/pasteTable";
import { rosterImportStatusMessage } from "@/lib/roster-import-status";

const FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "group", label: "Group" },
  { key: "phone", label: "Phone" },
  { key: "weight", label: "Weight" },
  { key: "included", label: "Included" },
];

const STEPS = ["Source", "Columns", "Review", "Done"];

const SOURCE_TABS = [
  { key: "file", label: "Upload a file", Icon: SpreadsheetIcon },
  { key: "paste", label: "Paste from a spreadsheet", Icon: CopyIcon },
];

const SHOW_OPTIONS = [
  ["all", "All rows"],
  ["needs_fix", "Needs fixing"],
  ["skipped", "Skipped"],
];

const PHASE_STEP = { source: 1, mapping: 2, preview: 3, complete: 4 };

const PHASE_DESCRIPTION = {
  source: "Upload a CSV/XLSX file or paste cells from a spreadsheet.",
  mapping:
    "Check which column fills each field. We matched them by their headers.",
  preview: "Review validation issues before changing the event's participants.",
  complete: "The participant import was committed successfully.",
};

const PAGE_SIZE = 50;
const PASTE_PREVIEW_ROWS = 6;
const EXPIRED_MESSAGE = "This import expired after 24 hours.";
const INITIAL_DEFAULTS = { group: "", weight: "1", included: true };

function importFrom(data) {
  return data?.import || data?.rosterImport || data || null;
}

// The server sends column indexes as numbers; <select> values are strings.
function mappingFrom(columnMapping) {
  return Object.fromEntries(
    Object.entries(columnMapping || {})
      .filter(([, value]) => value !== null && value !== undefined)
      .filter(([, value]) => value !== "")
      .map(([field, value]) => [field, String(value)]),
  );
}

function count(number, singular, plural = `${singular}s`) {
  return `${number} ${number === 1 ? singular : plural}`;
}

function people(number) {
  return count(number, "person", "people");
}

// The redesigned summary keys, with the older total/selected/valid/invalid
// keys as a fallback while the API still sends only those.
function summaryCounts(summary) {
  const values = summary || {};
  const total = values.total || 0;
  const selected = values.selected || 0;
  const mergedDuplicates = values.mergedDuplicates ?? 0;
  return {
    ready: values.ready ?? values.valid ?? 0,
    needsFix: values.needsFix ?? values.invalid ?? 0,
    mergedDuplicates,
    skipped: values.skipped ?? Math.max(total - selected - mergedDuplicates, 0),
  };
}

function summaryLine({ ready, needsFix, mergedDuplicates, skipped }) {
  return [
    `${ready} ready`,
    `${needsFix} ${needsFix === 1 ? "needs" : "need"} fixing`,
    `${count(mergedDuplicates, "duplicate")} merged`,
    `${skipped} skipped`,
  ].join(" · ");
}

// Mirrors the server's identity rule: people the organizer manages (no email
// of their own) are the same person by name, everyone else by email.
function identityKey(row) {
  const email = String(row.email || "")
    .trim()
    .toLowerCase();
  const name = String(row.name || "")
    .trim()
    .toLowerCase();
  const managed = row.organizerManaged ?? !email;
  const value = managed ? name : email;
  return value ? `${managed ? "name" : "email"}:${value}` : null;
}

function isMergedCopy(row) {
  return !row.selected && row.duplicate === "identical";
}

function rowStatus(row, rows) {
  const key = identityKey(row);
  const samePerson = (candidate) =>
    candidate.id !== row.id && key !== null && identityKey(candidate) === key;
  if (isMergedCopy(row)) {
    const survivor = rows.find(
      (candidate) => candidate.selected && samePerson(candidate),
    );
    return {
      tone: "info",
      dimmed: true,
      text: survivor
        ? `Merged into row ${survivor.rowNumber}`
        : "Merged into an identical row",
    };
  }
  if (!row.selected) return { tone: "neutral", dimmed: true, text: "Skipped" };
  if (!row.valid) {
    return {
      tone: "danger",
      text: `Needs fixing: ${row.errors?.[0] || "check this row"}`,
    };
  }
  const merged = rows.filter(
    (candidate) => isMergedCopy(candidate) && samePerson(candidate),
  );
  if (merged.length) {
    return {
      tone: "success",
      text: `Ready, merged with ${merged.length === 1 ? "row" : "rows"} ${merged
        .map((candidate) => candidate.rowNumber)
        .join(", ")}`,
    };
  }
  return { tone: "success", text: "Ready" };
}

function matchesShow(row, show) {
  if (show === "needs_fix") return Boolean(row.selected) && !row.valid;
  if (show === "skipped") return !row.selected;
  return true;
}

function isGone(requestError) {
  return requestError?.status === 404 || requestError?.status === 410;
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

function Pagination({ pagination, disabled, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <div className="pagination-row import-sheet__pagination">
      <div className="d-flex flex-wrap align-items-center gap-2 ms-auto">
        <AppButton
          variant="outlined"
          size="sm"
          icon={<ChevronLeftIcon />}
          disabled={disabled || pagination.page <= 1}
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
          disabled={disabled || pagination.page >= pagination.pages}
          onClick={() => onPage(pagination.page + 1)}
        >
          Next
        </AppButton>
      </div>
    </div>
  );
}

function PastePreview({ table }) {
  if (!table.rows.length) {
    return (
      <p className="import-sheet__paste-empty text-secondary mb-0">
        Paste rows to see a preview.
      </p>
    );
  }
  const preview = table.rows.slice(0, PASTE_PREVIEW_ROWS);
  const columns = Array.from({ length: table.columns }, (_, index) => index);
  return (
    <div className="import-sheet__paste-preview">
      <p className="mb-2 small text-secondary">
        Found {count(table.rows.length, "row")} and{" "}
        {count(table.columns, "column")}
      </p>
      <div className="table-shell">
        <div className="table-responsive">
          <table
            className="table table-sm table-borderless mb-0"
            aria-label="Pasted preview"
          >
            <tbody>
              {preview.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column) => (
                    <td key={column} className="font-monospace">
                      {row[column] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// The import itself never emails anyone. When it put people on the list who
// could be invited (those it added, or everyone for a rebuild), the Done
// step offers to review their invitations: the sheet closes and
// `onSendInvitations(participantIds)` asks the participant list to open its
// send dialog for them.
export default function RosterImportWizard({
  event,
  getToken,
  onEventChange,
  onCommitted,
  onSendInvitations,
  onClose,
}) {
  const [sourceType, setSourceType] = useState("file");
  const [file, setFile] = useState(null);
  const [pastedText, setPastedText] = useState("");
  const [sourceRows, setSourceRows] = useState(null);
  const [record, setRecord] = useState(null);
  const [worksheet, setWorksheet] = useState("");
  const [headerRow, setHeaderRow] = useState("1");
  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false);
  const [mapping, setMapping] = useState({});
  const [defaults, setDefaults] = useState(INITIAL_DEFAULTS);
  const [rows, setRows] = useState([]);
  const [rowDrafts, setRowDrafts] = useState({});
  const [rowsEdited, setRowsEdited] = useState(false);
  const [pagination, setPagination] = useState(null);
  const [show, setShow] = useState("all");
  const [phase, setPhase] = useState("source");
  const [mode, setMode] = useState("merge");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [result, setResult] = useState(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const idempotencyKey = useRef("");
  const sourceTabsId = useId();
  const fieldIds = useId();
  const sourceTabRefs = useRef({});

  const pasted = useMemo(() => parsePastedTable(pastedText), [pastedText]);
  const headers = record?.headers || [];
  const sampleRowNumber = Number(record?.headerRow || 1) + 1;
  const sampleRow =
    record?.sampleRow ?? (sourceRows ? sourceRows[sampleRowNumber - 1] : null);
  const counts = summaryCounts(record?.summary);

  const adoptRecord = (next) => {
    setRecord(next);
    setWorksheet(next?.selectedWorksheet || "");
    setHeaderRow(String(next?.headerRow || 1));
    setMapping(mappingFrom(next?.columnMapping));
  };

  const failWith = (requestError, fallback) => {
    if (requestError?.event) onEventChange?.(requestError.event);
    if (requestError?.status === 410) {
      setExpired(true);
      setError(EXPIRED_MESSAGE);
      return;
    }
    setError(requestError?.message || fallback);
  };

  // A preview that is already gone (expired, or cancelled elsewhere) needs
  // no cancelling; anything else is a real failure.
  const discardPreview = async (importId, token) => {
    try {
      await cancelRosterImport(event.code, importId, token);
    } catch (requestError) {
      if (!isGone(requestError)) throw requestError;
    }
  };

  const loadRows = async (importRecord, page, token, showValue = show) => {
    const data = await fetchRosterImportRows(
      event.code,
      importRecord.id,
      {
        page,
        pageSize: PAGE_SIZE,
        show: showValue === "all" ? undefined : showValue,
      },
      token,
    );
    setRecord(importFrom(data) || importRecord);
    // The page is filtered here too, so an API that ignores `show` still
    // shows only the rows asked for.
    setRows((data.rows || []).filter((row) => matchesShow(row, showValue)));
    setRowDrafts({});
    setPagination(
      data.pagination || {
        page,
        pageSize: PAGE_SIZE,
        total: data.rows?.length || 0,
        pages: 1,
      },
    );
  };

  const resetToSource = ({ clearSource = false } = {}) => {
    setFile(null);
    if (clearSource) setPastedText("");
    setSourceRows(null);
    setRecord(null);
    setWorksheet("");
    setHeaderRow("1");
    setSheetSettingsOpen(false);
    setMapping({});
    setDefaults(INITIAL_DEFAULTS);
    setRows([]);
    setRowDrafts({});
    setRowsEdited(false);
    setPagination(null);
    setShow("all");
    setMode("merge");
    setConfirmationCode("");
    setError("");
    setExpired(false);
    setResult(null);
    idempotencyKey.current = "";
    setPhase("source");
  };

  const handleSource = async () => {
    setError("");
    if (sourceType === "file") {
      if (!file) return setError("Choose a .csv or .xlsx file first.");
      if (!/\.(csv|xlsx)$/i.test(file.name))
        return setError("Only .csv and .xlsx files are supported.");
      if (file.size > 5 * 1024 * 1024)
        return setError("The compressed file must be 5 MiB or smaller.");
    } else if (!pasted.rows.length) {
      return setError("Paste rows copied from Google Sheets or Excel first.");
    }
    setBusy(true);
    try {
      const token = await getToken();
      // One server preview per source: the previous one goes first.
      if (record?.id) await discardPreview(record.id, token);
      const data = await createRosterImport(
        event.code,
        sourceType === "file" ? { file } : { pastedText },
        token,
      );
      const next = importFrom(data);
      adoptRecord(next);
      setSourceRows(sourceType === "paste" ? pasted.rows : null);
      setDefaults({
        group: next?.defaults?.group || "",
        weight: String(next?.defaults?.weight ?? 1),
        included: next?.defaults?.included ?? true,
      });
      setSheetSettingsOpen((next?.worksheets?.length || 0) > 1);
      setRowsEdited(false);
      setExpired(false);
      setPhase("mapping");
    } catch (requestError) {
      failWith(requestError, "Unable to read this import source.");
    } finally {
      setBusy(false);
    }
  };

  // Worksheet and header-row changes go to the server at once so it can
  // suggest the mapping for the new headers.
  const applySheetSettings = async (changes) => {
    setError("");
    setBusy(true);
    try {
      const token = await getToken();
      const data = await configureRosterImport(
        event.code,
        record.id,
        changes,
        token,
      );
      adoptRecord(importFrom(data));
    } catch (requestError) {
      failWith(requestError, "Unable to load columns from this header row.");
    } finally {
      setBusy(false);
    }
  };

  const changeWorksheet = (name) => {
    setWorksheet(name);
    if (name) void applySheetSettings({ worksheet: name });
  };

  const changeHeaderRow = (value) => {
    setHeaderRow(value);
    const nextHeaderRow = Number(value);
    if (
      Number.isInteger(nextHeaderRow) &&
      nextHeaderRow >= 1 &&
      nextHeaderRow !== Number(record?.headerRow)
    ) {
      void applySheetSettings({ headerRow: nextHeaderRow });
    }
  };

  // One column fills one field: picking it elsewhere clears the earlier pick.
  const selectColumn = (field, value) => {
    setMapping((current) => {
      const next = { ...current };
      Object.keys(next).forEach((other) => {
        if (other !== field && value && next[other] === value)
          delete next[other];
      });
      if (value) next[field] = value;
      else delete next[field];
      return next;
    });
  };

  const handleConfigure = async () => {
    setError("");
    if (!record?.selectedWorksheet) {
      setError("Choose a worksheet before mapping columns.");
      return;
    }
    if (!mapping.name || !mapping.email) {
      setError("Map both the name and email columns.");
      return;
    }
    const weight = defaults.weight === "" ? NaN : Number(defaults.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      setError("Enter a weight between 0 and 1.");
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      const data = await configureRosterImport(
        event.code,
        record.id,
        {
          columnMapping: mapping,
          defaults: {
            group: defaults.group,
            weight,
            included: defaults.included,
          },
        },
        token,
      );
      const next = importFrom(data);
      setRecord(next);
      setRowsEdited(false);
      setShow("all");
      await loadRows(next, 1, token, "all");
      setPhase("preview");
    } catch (requestError) {
      failWith(requestError, "Unable to validate the column mapping.");
    } finally {
      setBusy(false);
    }
  };

  const applyRowUpdates = async (rowUpdates, fallback) => {
    setError("");
    setBusy(true);
    try {
      const token = await getToken();
      const data = await configureRosterImport(
        event.code,
        record.id,
        { rowUpdates },
        token,
      );
      setRowsEdited(true);
      await loadRows(importFrom(data), pagination?.page || 1, token);
      return true;
    } catch (requestError) {
      failWith(requestError, fallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updateRow = (row, updates) =>
    applyRowUpdates([{ id: row.id, ...updates }], "Unable to update this row.");

  const selectPage = (selected) =>
    applyRowUpdates(
      rows.map((row) => ({ id: row.id, selected })),
      "Unable to update these rows.",
    );

  const changePage = (page) => {
    setError("");
    setBusy(true);
    getToken()
      .then((token) => loadRows(record, page, token))
      .catch((requestError) =>
        failWith(requestError, "Unable to load this page."),
      )
      .finally(() => setBusy(false));
  };

  const changeShow = (value) => {
    setShow(value);
    setError("");
    setBusy(true);
    getToken()
      .then((token) => loadRows(record, 1, token, value))
      .catch((requestError) =>
        failWith(requestError, "Unable to load these rows."),
      )
      .finally(() => setBusy(false));
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

  const handleSourceTabKeyDown = (keyEvent) => {
    const sources = SOURCE_TABS.map((tab) => tab.key);
    const currentIndex = sources.indexOf(sourceType);
    let nextIndex;
    if (keyEvent.key === "ArrowRight" || keyEvent.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % sources.length;
    } else if (keyEvent.key === "ArrowLeft" || keyEvent.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + sources.length) % sources.length;
    } else if (keyEvent.key === "Home") {
      nextIndex = 0;
    } else if (keyEvent.key === "End") {
      nextIndex = sources.length - 1;
    } else {
      return;
    }
    keyEvent.preventDefault();
    selectSourceType(sources[nextIndex], { focus: true });
  };

  const handleCommit = async () => {
    setError("");
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
          // Invitations are reviewed and sent from the participant list.
          sendInvitations: false,
          ...(mode === "rebuild" ? { confirmationCode } : {}),
        },
        token,
      );
      const committed = { ...data, sendInvitations: false };
      setResult(committed);
      setPhase("complete");
      onCommitted?.(committed);
    } catch (requestError) {
      failWith(requestError, "Unable to commit this import.");
    } finally {
      setBusy(false);
    }
  };

  // Closing with a live preview asks first; with nothing created yet, an
  // expired preview, or a finished import there is nothing to lose.
  const requestClose = () => {
    if (busy) return;
    if (record?.id && !result && !expired) {
      setConfirmingDiscard(true);
      return;
    }
    onClose?.();
  };

  const confirmDiscard = async () => {
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      await discardPreview(record.id, token);
      onClose?.();
    } catch (requestError) {
      setConfirmingDiscard(false);
      setError(requestError.message || "Unable to cancel this import.");
    } finally {
      setBusy(false);
    }
  };

  const sampleFor = (field) => {
    const index = mapping[field];
    if (index === undefined || !Array.isArray(sampleRow)) return "—";
    const value = sampleRow[Number(index)];
    return value === undefined || value === null || String(value).trim() === ""
      ? "(empty)"
      : String(value);
  };

  const defaultGroupHelpId = `${fieldIds}-default-group-help`;
  const includedDefaultId = `${fieldIds}-included-default`;
  const showId = `${fieldIds}-show`;
  const mergeModeId = `${fieldIds}-mode-merge`;
  const rebuildModeId = `${fieldIds}-mode-rebuild`;

  const sheetName =
    record?.selectedWorksheet ||
    (record?.worksheets?.length > 1 ? "not chosen yet" : "Pasted data");
  const codeConfirmed =
    mode !== "rebuild" ||
    confirmationCode.trim().toUpperCase() === String(event.code).toUpperCase();
  const commitBlocker =
    counts.needsFix > 0
      ? `Fix or skip ${count(counts.needsFix, "row")} to continue.`
      : counts.ready === 0
        ? "Select at least one row."
        : "";
  const commitDisabled =
    busy || expired || Boolean(commitBlocker) || !codeConfirmed;
  const commitLabel = busy
    ? "Importing…"
    : mode === "rebuild"
      ? `Replace the list with ${people(counts.ready)}`
      : `Import ${people(counts.ready)}`;
  const selectedOnPage = rows.filter((row) => row.selected).length;
  const allOnPageSelected = rows.length > 0 && selectedOnPage === rows.length;

  const receipt = result?.receipt || {};
  // A rebuild starts everyone over as Not sent, so all of them are up for
  // an invitation; a merge offers only the people it added.
  const invitableIds =
    (mode === "rebuild"
      ? result?.importedParticipantIds
      : result?.addedParticipantIds) || [];
  const reviewInvitations = () => {
    onClose?.();
    onSendInvitations?.(invitableIds);
  };

  const footer =
    phase === "source" ? (
      <AppButton
        icon={<ArrowRightIcon />}
        busy={busy}
        onClick={handleSource}
        disabled={busy}
      >
        {busy ? "Reading…" : "Continue"}
      </AppButton>
    ) : phase === "mapping" ? (
      <>
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
          disabled={busy || expired}
        >
          {busy ? "Validating…" : "Preview rows"}
        </AppButton>
      </>
    ) : phase === "preview" ? (
      <>
        {commitBlocker && (
          <span className="import-sheet__footer-note">{commitBlocker}</span>
        )}
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
          {commitLabel}
        </AppButton>
      </>
    ) : (
      <>
        <AppButton
          variant="outlined"
          onClick={() => resetToSource({ clearSource: true })}
        >
          Import another list
        </AppButton>
        <AppButton
          variant={invitableIds.length > 0 ? "outlined" : "filled"}
          icon={<ArrowRightIcon />}
          onClick={() => onClose?.()}
        >
          Back to participants
        </AppButton>
        {invitableIds.length > 0 && (
          <AppButton icon={<SendIcon />} onClick={reviewInvitations}>
            Review and send invitations ({invitableIds.length})…
          </AppButton>
        )}
      </>
    );

  return (
    <>
      <Modal
        size="xl"
        title="Import participants"
        description={PHASE_DESCRIPTION[phase]}
        labelledBy="roster-import-heading"
        className="import-sheet"
        busy={busy}
        onClose={requestClose}
        footer={footer}
      >
        <StepIndicator phase={phase} />

        {error && (
          <Alert
            variant="danger"
            role="alert"
            className="import-sheet__error mb-3"
            actions={
              expired ? (
                <AppButton
                  variant="outlined"
                  size="sm"
                  onClick={() => resetToSource()}
                >
                  Start again
                </AppButton>
              ) : null
            }
          >
            {error}
          </Alert>
        )}

        {phase === "source" && (
          <div className="d-flex flex-column gap-3">
            <ul
              className="nav nav-pills import-sheet__source-switcher"
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
                    data-autofocus={sourceType === key ? "" : undefined}
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
                  help="Up to 5 MiB. Formulas in the columns you import are rejected."
                >
                  <input
                    type="file"
                    className="form-control"
                    aria-label="CSV or XLSX file"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={busy}
                    onChange={(changeEvent) =>
                      setFile(changeEvent.target.files?.[0] || null)
                    }
                  />
                </FormField>
              ) : (
                <>
                  <FormField label="Rows copied from Google Sheets or Excel">
                    <textarea
                      className="form-control font-monospace"
                      aria-label="Pasted participant rows"
                      rows={7}
                      value={pastedText}
                      disabled={busy}
                      onChange={(changeEvent) =>
                        setPastedText(changeEvent.target.value)
                      }
                      placeholder={
                        "name\temail\tgroup\nAda\tada@example.com\tFaculty; Team 3"
                      }
                    />
                  </FormField>
                  <PastePreview table={pasted} />
                </>
              )}
            </div>
          </div>
        )}

        {phase === "mapping" && record && (
          <div className="d-flex flex-column gap-3">
            <div className="table-shell">
              <div className="table-responsive">
                <table className="table table-sm align-middle import-sheet__fields mb-0">
                  <caption className="visually-hidden">
                    Fields and the columns that fill them
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Column in your sheet</th>
                      <th scope="col">Row {sampleRowNumber} shows</th>
                      <th scope="col">
                        If the cell is empty or there is no column
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {FIELDS.map(({ key, label, required }) => (
                      <tr key={key}>
                        <th scope="row" className="import-sheet__field">
                          {label}
                          {required ? " *" : ""}
                        </th>
                        <td>
                          <select
                            className="form-select form-select-sm"
                            aria-label={`Column for ${label}`}
                            value={mapping[key] || ""}
                            disabled={busy}
                            onChange={(changeEvent) =>
                              selectColumn(key, changeEvent.target.value)
                            }
                          >
                            <option value="">No column</option>
                            {headers.map((header, index) => (
                              <option
                                key={`${index}:${header}`}
                                value={String(index)}
                              >
                                {header || `Column ${index + 1}`}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="import-sheet__sample">
                          {sampleFor(key)}
                        </td>
                        <td className="import-sheet__fallback">
                          {key === "name" && "—"}
                          {key === "email" &&
                            "No email: you enter their schedule"}
                          {key === "phone" && "Left blank"}
                          {key === "group" &&
                            (mapping.group ? (
                              "No group"
                            ) : (
                              <div className="import-sheet__default-group">
                                <input
                                  className="form-control form-control-sm"
                                  aria-label="Default group"
                                  aria-describedby={defaultGroupHelpId}
                                  placeholder="Everyone goes into…"
                                  value={defaults.group}
                                  disabled={busy}
                                  onChange={(changeEvent) =>
                                    setDefaults((current) => ({
                                      ...current,
                                      group: changeEvent.target.value,
                                    }))
                                  }
                                />
                                <div
                                  id={defaultGroupHelpId}
                                  className="form-text"
                                >
                                  Blank = no group. ALL = every group. Separate
                                  several names with ; or ,
                                </div>
                              </div>
                            ))}
                          {key === "weight" && (
                            <div className="d-flex align-items-center gap-2">
                              <span>Weight</span>
                              <input
                                type="number"
                                className="form-control form-control-sm import-sheet__default-weight"
                                aria-label="Default weight"
                                min="0"
                                max="1"
                                step="0.05"
                                value={defaults.weight}
                                disabled={busy}
                                onChange={(changeEvent) =>
                                  setDefaults((current) => ({
                                    ...current,
                                    weight: changeEvent.target.value,
                                  }))
                                }
                              />
                            </div>
                          )}
                          {key === "included" && (
                            <div className="form-check mb-0">
                              <input
                                id={includedDefaultId}
                                className="form-check-input"
                                type="checkbox"
                                checked={Boolean(defaults.included)}
                                disabled={busy}
                                onChange={(changeEvent) =>
                                  setDefaults((current) => ({
                                    ...current,
                                    included: changeEvent.target.checked,
                                  }))
                                }
                              />
                              <label
                                className="form-check-label"
                                htmlFor={includedDefaultId}
                              >
                                Counted in results
                              </label>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="import-sheet__sheet-line mb-0">
              Sheet: {sheetName}, headers in row {record.headerRow} ·{" "}
              <button
                type="button"
                className="btn btn-link btn-sm p-0 align-baseline"
                aria-expanded={sheetSettingsOpen}
                onClick={() => setSheetSettingsOpen((open) => !open)}
              >
                change
              </button>
            </p>
            {sheetSettingsOpen && (
              <fieldset className="import-sheet__sheet-settings">
                <legend className="visually-hidden">Sheet settings</legend>
                <div className="row g-3 align-items-end">
                  {record.worksheets?.length > 1 && (
                    <div className="col-12 col-md-6">
                      <FormField label="Worksheet">
                        <select
                          className="form-select"
                          value={worksheet}
                          disabled={busy}
                          onChange={(changeEvent) =>
                            changeWorksheet(changeEvent.target.value)
                          }
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
                        disabled={busy}
                        onChange={(changeEvent) =>
                          changeHeaderRow(changeEvent.target.value)
                        }
                      />
                    </FormField>
                  </div>
                </div>
              </fieldset>
            )}

            {rowsEdited && (
              <Alert variant="warning" role="note" className="mt-1">
                Previewing again resets edits made on the Review step.
              </Alert>
            )}
          </div>
        )}

        {phase === "preview" && (
          <div className="d-flex flex-column gap-3">
            <div className="import-sheet__review-bar">
              <p className="import-sheet__summary mb-0">
                {summaryLine(counts)}
              </p>
              <div className="d-flex align-items-center gap-2">
                <label htmlFor={showId} className="mb-0 text-secondary">
                  Show
                </label>
                <select
                  id={showId}
                  className="form-select form-select-sm w-auto"
                  value={show}
                  disabled={busy}
                  onChange={(changeEvent) =>
                    changeShow(changeEvent.target.value)
                  }
                >
                  {SHOW_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="table-shell">
              <div
                className="table-responsive"
                role="region"
                aria-label="Imported rows awaiting review"
                tabIndex={0}
              >
                <table className="table table-sm align-middle import-sheet__rows">
                  <caption className="visually-hidden">
                    Imported rows awaiting review
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          aria-label="Use every row on this page"
                          checked={allOnPageSelected}
                          disabled={busy || rows.length === 0}
                          ref={(node) => {
                            if (node)
                              node.indeterminate =
                                selectedOnPage > 0 && !allOnPageSelected;
                          }}
                          onChange={(changeEvent) =>
                            selectPage(changeEvent.target.checked)
                          }
                        />
                      </th>
                      <th scope="col">Row</th>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Group</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Weight</th>
                      <th scope="col">Count</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const status = rowStatus(row, rows);
                      return (
                        <tr
                          key={row.id}
                          className={status.dimmed ? "opacity-50" : undefined}
                        >
                          <td>
                            <input
                              className="form-check-input"
                              aria-label={`Select row ${row.rowNumber}`}
                              type="checkbox"
                              checked={Boolean(row.selected)}
                              disabled={busy}
                              onChange={(changeEvent) =>
                                updateRow(row, {
                                  selected: changeEvent.target.checked,
                                })
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
                              onChange={(changeEvent) =>
                                updateRowDraft(
                                  row.id,
                                  "name",
                                  changeEvent.target.value,
                                )
                              }
                              onBlur={(blurEvent) =>
                                void saveRowDraft(
                                  row,
                                  "name",
                                  blurEvent.target.value,
                                  row.name || "",
                                )
                              }
                            />
                          </td>
                          <td>
                            <input
                              className="form-control form-control-sm"
                              aria-label={`Email for row ${row.rowNumber}`}
                              value={rowDraftValue(
                                row,
                                "email",
                                row.email || "",
                              )}
                              disabled={busy}
                              onChange={(changeEvent) =>
                                updateRowDraft(
                                  row.id,
                                  "email",
                                  changeEvent.target.value,
                                )
                              }
                              onBlur={(blurEvent) =>
                                void saveRowDraft(
                                  row,
                                  "email",
                                  blurEvent.target.value,
                                  row.email || "",
                                )
                              }
                            />
                            {row.organizerManaged && (
                              <small className="d-block text-secondary mt-1">
                                No email: you enter their schedule
                              </small>
                            )}
                          </td>
                          <td>
                            <input
                              className="form-control form-control-sm"
                              aria-label={`Group for row ${row.rowNumber}`}
                              value={rowDraftValue(
                                row,
                                "group",
                                row.group || "",
                              )}
                              disabled={busy}
                              onChange={(changeEvent) =>
                                updateRowDraft(
                                  row.id,
                                  "group",
                                  changeEvent.target.value,
                                )
                              }
                              onBlur={(blurEvent) =>
                                void saveRowDraft(
                                  row,
                                  "group",
                                  blurEvent.target.value,
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
                              value={rowDraftValue(
                                row,
                                "phone",
                                row.phone || "",
                              )}
                              disabled={busy}
                              onChange={(changeEvent) =>
                                updateRowDraft(
                                  row.id,
                                  "phone",
                                  changeEvent.target.value,
                                )
                              }
                              onBlur={(blurEvent) =>
                                void saveRowDraft(
                                  row,
                                  "phone",
                                  blurEvent.target.value,
                                  row.phone || "",
                                )
                              }
                            />
                          </td>
                          <td>
                            <input
                              className="form-control form-control-sm"
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
                              onChange={(changeEvent) =>
                                updateRowDraft(
                                  row.id,
                                  "weight",
                                  changeEvent.target.value,
                                )
                              }
                              onBlur={(blurEvent) =>
                                void saveRowDraft(
                                  row,
                                  "weight",
                                  Number(blurEvent.target.value),
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
                              onChange={(changeEvent) =>
                                updateRow(row, {
                                  included: changeEvent.target.checked,
                                })
                              }
                            />
                          </td>
                          <td>
                            <StatusBadge
                              status={status.tone}
                              className="import-sheet__status"
                            >
                              {status.text}
                            </StatusBadge>
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
              disabled={busy}
              onPage={changePage}
            />

            <fieldset className="import-sheet__apply">
              <legend className="fs-6 fw-semibold mb-2">
                Apply to the participant list
              </legend>
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
                  Add and update people. Schedules, invitations and history are
                  kept.
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
                  Replace the whole list. Deletes every schedule, invitation and
                  pending email.
                </label>
              </div>
              {mode === "rebuild" && (
                <div className="import-sheet__rebuild d-flex flex-column gap-3 mt-3">
                  <Alert variant="warning" role="note">
                    Rebuilding clears schedules, invitations, and pending
                    delivery. Everyone starts as Not sent and gets no reminders
                    until you send invitations, which you can review once the
                    import is done.
                  </Alert>
                  <FormField
                    label={`Type ${event.code} to confirm`}
                    className="import-sheet__confirmation-field"
                  >
                    <input
                      className="form-control"
                      aria-label="Rebuild confirmation code"
                      value={confirmationCode}
                      onChange={(changeEvent) =>
                        setConfirmationCode(changeEvent.target.value)
                      }
                      autoComplete="off"
                    />
                  </FormField>
                </div>
              )}
            </fieldset>
          </div>
        )}

        {phase === "complete" && result && (
          <div className="import-sheet__done d-flex flex-column gap-3">
            <Alert variant="success" role="status">
              {rosterImportStatusMessage({
                receipt,
                autoInvitedCount: result.autoInvitedCount,
                sendInvitations: false,
              })}
            </Alert>
          </div>
        )}
      </Modal>

      {confirmingDiscard && (
        <ConfirmDialog
          title="Discard this import?"
          confirmLabel="Discard import"
          busy={busy}
          onConfirm={confirmDiscard}
          onClose={() => setConfirmingDiscard(false)}
        >
          <p className="mb-0">
            The rows you previewed and any edits are thrown away. Nothing has
            changed on the participant list.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
