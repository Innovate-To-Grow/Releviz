"use client";

import { useId, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import { Badge, Callout, Stat } from "@/components/ui/Feedback";
import {
  Checkbox,
  Field,
  Radio,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui/Form";
import { Card, SectionHeader } from "@/components/ui/Surface";
import {
  cancelRosterImport,
  commitRosterImport,
  configureRosterImport,
  createRosterImport,
  fetchRosterImportRows,
} from "@/lib/api/roster";

const FIELD_OPTIONS = [
  ["name", "Name", true],
  ["email", "Email", true],
  ["group", "Group", false],
  ["weight", "Weight", false],
  ["included", "Included", false],
];

function normalizedHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function suggestedMapping(headers = [], current = {}) {
  const aliases = {
    name: ["name", "fullname", "participant", "participantname"],
    email: ["email", "emailaddress", "mail"],
    group: ["group", "team", "department", "organization"],
    weight: ["weight", "priority"],
    included: ["included", "include", "counted"],
  };
  const result = Object.fromEntries(
    Object.entries(current).map(([field, value]) => [
      field,
      Number.isInteger(value) || /^\d+$/.test(String(value))
        ? String(value)
        : "",
    ]),
  );
  FIELD_OPTIONS.forEach(([field]) => {
    if (result[field] !== undefined && result[field] !== "") return;
    const match = headers.findIndex((header) =>
      aliases[field].includes(normalizedHeader(header)),
    );
    if (match >= 0) result[field] = String(match);
  });
  return result;
}

function importFrom(data) {
  return data?.import || data?.rosterImport || data || null;
}

const SOURCE_TABS = [
  { id: "file", label: "File upload" },
  { id: "paste", label: "Paste spreadsheet" },
];

const PHASE_STEPS = [
  { id: "source", label: "Source" },
  { id: "mapping", label: "Map columns" },
  { id: "preview", label: "Review" },
  { id: "complete", label: "Done" },
];

function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <div className="rv-pagination">
      <span>
        Page {pagination.page} of {pagination.pages}
      </span>
      <div className="rv-pagination__controls">
        <Button
          size="sm"
          icon="chevronLeft"
          disabled={pagination.page <= 1}
          onClick={() => onPage(pagination.page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          iconEnd="chevronRight"
          disabled={pagination.page >= pagination.pages}
          onClick={() => onPage(pagination.page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function rowValidation(row) {
  if (!row.valid) {
    return {
      tone: "danger",
      text: (row.errors || []).join(" · ") || "Invalid",
    };
  }
  if (row.duplicate === "identical") {
    return { tone: "warning", text: "Identical duplicate merged" };
  }
  if (row.duplicate === "conflict") {
    return { tone: "warning", text: "Conflicting duplicate" };
  }
  return { tone: "success", text: "Ready" };
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
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const idempotencyKey = useRef("");
  const sourceTabsId = useId();

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
      setError(requestError.message || "Unable to read this roster source.");
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
        requestError.message || "Unable to validate the roster mapping.",
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

  const handleCommit = async () => {
    setError("");
    setStatus("");
    if (mode === "rebuild" && confirmationCode !== event.code) {
      setError("Enter the event code exactly to confirm a roster rebuild.");
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
          ...(mode === "rebuild" ? { confirmationCode } : {}),
        },
        token,
      );
      const receipt = data.receipt || {};
      const importedCount = receipt.importedCount || 0;
      const createdCount = receipt.createdCount || 0;
      const updatedCount = receipt.updatedCount || 0;
      const invitedCount =
        data.autoInvitedCount ?? receipt.invitedCount ?? createdCount;
      setStatus(
        createdCount > 0 || invitedCount > 0
          ? `Imported ${importedCount} people: ${createdCount} added, ${updatedCount} updated. ${invitedCount} invitation${invitedCount === 1 ? "" : "s"} queued.`
          : `Imported ${importedCount} people: no new participants were added, so no invitations were sent.`,
      );
      setPhase("complete");
      onCommitted?.(data);
    } catch (requestError) {
      if (requestError.event) onEventChange?.(requestError.event);
      setError(
        requestError.code === "event_not_active" ||
          requestError.event?.status === "closed"
          ? "This event is closed. Reactivate it before committing this roster."
          : requestError.message || "Unable to commit this roster.",
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

  const activeStepIndex = PHASE_STEPS.findIndex((step) => step.id === phase);

  return (
    <Card as="section" aria-labelledby="roster-import-heading">
      <SectionHeader
        as="h3"
        titleId="roster-import-heading"
        title="Import roster"
        description={
          phase === "source"
            ? "Upload a CSV/XLSX file or paste cells from a spreadsheet."
            : phase === "mapping"
              ? "Choose a worksheet and map its columns."
              : phase === "preview"
                ? "Review validation issues before changing the event roster."
                : "The roster import was committed successfully."
        }
        actions={
          onClose ? (
            <Button
              size="sm"
              icon="close"
              onClick={handleCancel}
              disabled={busy}
            >
              Close
            </Button>
          ) : null
        }
      />

      <ol className="rv-steps-rail" aria-label="Import progress">
        {PHASE_STEPS.map((step, index) => (
          <li
            key={step.id}
            className="rv-steps-rail__item"
            aria-current={step.id === phase ? "step" : undefined}
            data-state={
              index < activeStepIndex
                ? "done"
                : index === activeStepIndex
                  ? "current"
                  : "todo"
            }
          >
            <span className="rv-steps-rail__index" aria-hidden="true">
              {index + 1}
            </span>
            {step.label}
          </li>
        ))}
      </ol>

      {phase === "source" && (
        <>
          <Tabs
            label="Roster source"
            tabs={SOURCE_TABS}
            activeId={sourceType}
            idPrefix={sourceTabsId}
            onChange={setSourceType}
          />
          <TabPanel
            idPrefix={sourceTabsId}
            id={sourceType}
            className="rv-stack rv-stack--md"
          >
            {sourceType === "file" ? (
              <label className="rv-file">
                <span className="rv-field__label">CSV or XLSX file</span>
                <input
                  aria-label="CSV or XLSX file"
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
                <small className="rv-field__hint">
                  Maximum compressed size: 5 MiB. Legacy .xls files and formulas
                  are not supported.
                </small>
              </label>
            ) : (
              <Field
                label="Rows copied from Google Sheets or Excel"
                hint="Include a header row so the columns can be matched automatically."
              >
                <TextArea
                  aria-label="Pasted roster rows"
                  rows={9}
                  value={pastedText}
                  onChange={(event) => setPastedText(event.target.value)}
                  placeholder={
                    "name\temail\tgroup\nAda\tada@example.com\tFaculty"
                  }
                />
              </Field>
            )}
            <div className="rv-btn-row rv-btn-row--end">
              <Button
                variant="primary"
                iconEnd="arrowRight"
                onClick={handleSource}
                busy={busy}
                disabled={busy}
              >
                {busy ? "Reading…" : "Continue to mapping"}
              </Button>
            </div>
          </TabPanel>
        </>
      )}

      {phase === "mapping" && (
        <div className="rv-stack rv-stack--lg">
          <div className="rv-grid rv-grid--pair">
            {record?.worksheets?.length > 1 && (
              <Field label="Worksheet">
                <Select
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
                </Select>
              </Field>
            )}
            <Field
              label="Header row"
              hint="The row that contains the column names."
            >
              <TextInput
                className="rv-input--numeric"
                type="number"
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
            </Field>
          </div>

          <div className="rv-stack rv-stack--sm">
            <p className="rv-field__label">Match your columns</p>
            <div className="rv-grid rv-grid--2">
              {FIELD_OPTIONS.map(([field, label, mandatory]) => (
                <Field key={field} label={label} required={mandatory}>
                  <Select
                    value={mapping[field] || ""}
                    onChange={(event) =>
                      setMapping((current) => ({
                        ...current,
                        [field]: event.target.value || undefined,
                      }))
                    }
                  >
                    <option value="">
                      {mandatory ? "Select a column" : "Use default"}
                    </option>
                    {headers.map((header, index) => (
                      <option key={`${index}:${header}`} value={String(index)}>
                        {header || `Column ${index + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </div>

          <fieldset className="rv-fieldset">
            <legend className="rv-fieldset__legend">
              Defaults for unmapped columns
            </legend>
            <div className="rv-grid rv-grid--pair">
              <Field label="Default group">
                <TextInput
                  value={defaults.group}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      group: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Default weight">
                <TextInput
                  className="rv-input--numeric"
                  type="number"
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
              </Field>
            </div>
            <Checkbox
              label="Include by default"
              checked={Boolean(defaults.included)}
              onChange={(event) =>
                setDefaults((current) => ({
                  ...current,
                  included: event.target.checked,
                }))
              }
            />
          </fieldset>

          <div className="rv-btn-row rv-btn-row--end">
            <Button
              icon="chevronLeft"
              onClick={() => setPhase("source")}
              disabled={busy}
            >
              Back
            </Button>
            <Button
              variant="primary"
              iconEnd="arrowRight"
              onClick={handleConfigure}
              busy={busy}
              disabled={busy}
            >
              {busy ? "Validating…" : "Preview rows"}
            </Button>
          </div>
        </div>
      )}

      {phase === "preview" && (
        <div className="rv-stack rv-stack--lg">
          <div className="rv-grid rv-grid--4">
            {[
              ["Selected", record?.summary?.selected],
              ["Valid", record?.summary?.valid],
              ["Invalid", record?.summary?.invalid],
              ["Conflicts", record?.summary?.conflicts],
            ].map(([label, value]) => (
              <Stat key={label} label={label} value={value || 0} />
            ))}
          </div>

          <div className="rv-table-wrap">
            <div className="rv-table-scroll">
              <table className="rv-table">
                <caption className="rv-visually-hidden">
                  Rows detected in the imported file
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Use</th>
                    <th scope="col">Row</th>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Group</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Included</th>
                    <th scope="col">Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const validation = rowValidation(row);
                    return (
                      <tr key={row.id}>
                        <td>
                          <Checkbox
                            tight
                            aria-label={`Select row ${row.rowNumber}`}
                            label={
                              <span className="rv-visually-hidden">
                                Select row {row.rowNumber}
                              </span>
                            }
                            checked={Boolean(row.selected)}
                            disabled={busy}
                            onChange={(event) =>
                              updateRow(row, { selected: event.target.checked })
                            }
                          />
                        </td>
                        <td className="rv-input--numeric">{row.rowNumber}</td>
                        <td>
                          <TextInput
                            size="sm"
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
                          <TextInput
                            size="sm"
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
                        </td>
                        <td>
                          <TextInput
                            size="sm"
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
                          <TextInput
                            size="sm"
                            className="rv-input--numeric"
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
                          <Checkbox
                            tight
                            aria-label={`Included for row ${row.rowNumber}`}
                            label={
                              <span className="rv-visually-hidden">
                                Included for row {row.rowNumber}
                              </span>
                            }
                            checked={Boolean(row.included)}
                            disabled={busy}
                            onChange={(event) =>
                              updateRow(row, { included: event.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <Badge tone={validation.tone}>
                            {validation.text}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              pagination={pagination}
              onPage={(page) =>
                loadRows(record, page).catch((requestError) =>
                  setError(requestError.message),
                )
              }
            />
          </div>

          <fieldset className="rv-fieldset">
            <legend className="rv-fieldset__legend">Import behavior</legend>
            <p className="rv-field__hint">
              New participants receive an invitation automatically. Existing
              participants are updated without another email.
            </p>
            <Radio
              name="import-mode"
              value="merge"
              label="Merge with the current roster and preserve schedules"
              checked={mode === "merge"}
              onChange={() => setMode("merge")}
            />
            <Radio
              name="import-mode"
              value="rebuild"
              label="Rebuild the roster and clear schedules, invitations, and pending delivery"
              checked={mode === "rebuild"}
              onChange={() => setMode("rebuild")}
            />
            {mode === "rebuild" && (
              <Callout tone="danger" role="note">
                <p>
                  Rebuilding clears schedules, invitations, and pending
                  delivery, then sends a new invitation to every imported
                  participant.
                </p>
                <Field
                  label="Rebuild confirmation code"
                  hint={`Type ${event.code} to confirm.`}
                >
                  <TextInput
                    value={confirmationCode}
                    onChange={(event) =>
                      setConfirmationCode(event.target.value)
                    }
                    autoComplete="off"
                  />
                </Field>
              </Callout>
            )}
          </fieldset>

          <div className="rv-btn-row rv-btn-row--end">
            <Button
              icon="chevronLeft"
              onClick={() => setPhase("mapping")}
              disabled={busy}
            >
              Back
            </Button>
            <Button
              variant={mode === "rebuild" ? "danger" : "primary"}
              onClick={handleCommit}
              busy={busy}
              disabled={
                busy ||
                !record?.summary?.valid ||
                (mode === "rebuild" && confirmationCode !== event.code)
              }
            >
              {busy
                ? "Importing…"
                : mode === "rebuild"
                  ? "Rebuild roster and send invitations"
                  : "Merge roster and invite new people"}
            </Button>
          </div>
        </div>
      )}

      {phase === "complete" && (
        <div className="rv-stack rv-stack--md">
          <Callout tone="success" role="status">
            {status}
          </Callout>
          <div className="rv-btn-row rv-btn-row--end">
            <Button variant="primary" onClick={onClose}>
              Return to roster
            </Button>
          </div>
        </div>
      )}
      {phase !== "complete" && status && (
        <Callout tone="info" role="status">
          {status}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </Card>
  );
}
