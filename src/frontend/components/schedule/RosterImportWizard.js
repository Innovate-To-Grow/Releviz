"use client";

import { useMemo, useRef, useState } from "react";
import AppButton from "@/components/ui/AppButton";
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
      Number.isInteger(value) || /^\d+$/.test(String(value)) ? String(value) : "",
    ])
  );
  FIELD_OPTIONS.forEach(([field]) => {
    if (result[field] !== undefined && result[field] !== "") return;
    const match = headers.findIndex((header) => aliases[field].includes(normalizedHeader(header)));
    if (match >= 0) result[field] = String(match);
  });
  return result;
}

function importFrom(data) {
  return data?.import || data?.rosterImport || data || null;
}

function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "center", justifyContent: "end" }}>
      <AppButton
        variant="outlined"
        disabled={pagination.page <= 1}
        onClick={() => onPage(pagination.page - 1)}
      >
        Previous
      </AppButton>
      <span>
        Page {pagination.page} of {pagination.pages}
      </span>
      <AppButton
        variant="outlined"
        disabled={pagination.page >= pagination.pages}
        onClick={() => onPage(pagination.page + 1)}
      >
        Next
      </AppButton>
    </div>
  );
}

export default function RosterImportWizard({ event, getToken, onCommitted, onClose }) {
  const [sourceType, setSourceType] = useState("file");
  const [file, setFile] = useState(null);
  const [pastedText, setPastedText] = useState("");
  const [record, setRecord] = useState(null);
  const [worksheet, setWorksheet] = useState("");
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState({});
  const [defaults, setDefaults] = useState({ group: "", weight: 1, included: true });
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [phase, setPhase] = useState("source");
  const [mode, setMode] = useState("merge");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const idempotencyKey = useRef("");

  const selectedSheet = useMemo(
    () => record?.worksheets?.find((candidate) => candidate.name === worksheet) || null,
    [record, worksheet]
  );
  const headers =
    record?.selectedWorksheet === worksheet &&
    Number(record?.headerRow) === Number(headerRow) &&
    record?.headers?.length
      ? record.headers
      : selectedSheet?.headers || [];

  const loadRows = async (importRecord = record, page = 1, tokenOverride = null) => {
    if (!importRecord?.id) return;
    const token = tokenOverride || (await getToken());
    const data = await fetchRosterImportRows(
      event.code,
      importRecord.id,
      { page, pageSize: 50 },
      token
    );
    setRecord(importFrom(data) || importRecord);
    setRows(data.rows || []);
    setPagination(
      data.pagination || { page, pageSize: 50, total: data.rows?.length || 0, pages: 1 }
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
        token
      );
      const nextRecord = importFrom(data);
      setRecord(nextRecord);
      const nextWorksheet =
        nextRecord?.selectedWorksheet ||
        (nextRecord?.worksheets?.length === 1 ? nextRecord.worksheets[0].name : "");
      const nextHeaders =
        nextRecord?.worksheets?.find((candidate) => candidate.name === nextWorksheet)?.headers ||
        [];
      setWorksheet(nextWorksheet);
      setHeaderRow(nextRecord?.headerRow || 1);
      setMapping(suggestedMapping(nextHeaders, nextRecord?.columnMapping || {}));
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
      (record?.selectedWorksheet !== worksheet || Number(record?.headerRow) !== Number(headerRow));
    if (needsHeaderRefresh) {
      setBusy(true);
      try {
        const token = await getToken();
        const data = await configureRosterImport(
          event.code,
          record.id,
          { worksheet, headerRow },
          token
        );
        const nextRecord = importFrom(data);
        const nextHeaders = nextRecord?.headers || [];
        setRecord(nextRecord);
        setMapping(suggestedMapping(nextHeaders));
        setStatus("Columns loaded from the selected header row. Check the mapping, then preview.");
      } catch (requestError) {
        setError(requestError.message || "Unable to load columns from this header row.");
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
        token
      );
      const nextRecord = importFrom(data);
      setRecord(nextRecord);
      await loadRows(nextRecord, 1, token);
      setPhase("preview");
    } catch (requestError) {
      setError(requestError.message || "Unable to validate the roster mapping.");
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
        token
      );
      setRecord(importFrom(data));
      await loadRows(importFrom(data), pagination?.page || 1, token);
    } catch (requestError) {
      setError(requestError.message || "Unable to update this row.");
    } finally {
      setBusy(false);
    }
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
        token
      );
      const receipt = data.receipt || {};
      setStatus(
        `Imported ${receipt.importedCount ?? receipt.createdCount ?? 0} people: ${receipt.createdCount || 0} created and ${receipt.updatedCount || 0} updated.`
      );
      setPhase("complete");
      onCommitted?.(data);
    } catch (requestError) {
      setError(requestError.message || "Unable to commit this roster.");
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

  return (
    <section
      className="md-card"
      aria-labelledby="roster-import-heading"
      style={{ display: "grid", gap: "18px" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          alignItems: "start",
        }}
      >
        <div>
          <h3 id="roster-import-heading" style={{ margin: 0 }}>
            Import roster
          </h3>
          <p style={{ margin: "5px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
            {phase === "source" && "Upload a CSV/XLSX file or paste cells from a spreadsheet."}
            {phase === "mapping" && "Choose a worksheet and map its columns."}
            {phase === "preview" && "Review validation issues before changing the event roster."}
            {phase === "complete" && "The roster import was committed successfully."}
          </p>
        </div>
        {onClose && (
          <AppButton variant="text" onClick={handleCancel} disabled={busy}>
            Close
          </AppButton>
        )}
      </div>

      {phase === "source" && (
        <>
          <div role="tablist" aria-label="Roster source" style={{ display: "flex", gap: "8px" }}>
            <AppButton
              variant={sourceType === "file" ? "filled" : "outlined"}
              onClick={() => setSourceType("file")}
            >
              File upload
            </AppButton>
            <AppButton
              variant={sourceType === "paste" ? "filled" : "outlined"}
              onClick={() => setSourceType("paste")}
            >
              Paste spreadsheet
            </AppButton>
          </div>
          {sourceType === "file" ? (
            <label style={{ display: "grid", gap: "8px" }}>
              <strong>CSV or XLSX file</strong>
              <input
                aria-label="CSV or XLSX file"
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
              <small>
                Maximum compressed size: 5 MiB. Legacy .xls files and formulas are not supported.
              </small>
            </label>
          ) : (
            <label style={{ display: "grid", gap: "8px" }}>
              <strong>Rows copied from Google Sheets or Excel</strong>
              <textarea
                aria-label="Pasted roster rows"
                rows={9}
                value={pastedText}
                onChange={(event) => setPastedText(event.target.value)}
                placeholder={"name\temail\tgroup\nAda\tada@example.com\tFaculty"}
              />
            </label>
          )}
          <div>
            <AppButton onClick={handleSource} disabled={busy}>
              {busy ? "Reading…" : "Continue to mapping"}
            </AppButton>
          </div>
        </>
      )}

      {phase === "mapping" && (
        <>
          {record?.worksheets?.length > 1 && (
            <label style={{ display: "grid", gap: "6px" }}>
              <strong>Worksheet</strong>
              <select
                value={worksheet}
                onChange={(event) => {
                  const name = event.target.value;
                  const selected = record.worksheets.find((item) => item.name === name);
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
            </label>
          )}
          <label style={{ display: "grid", gap: "6px", maxWidth: "220px" }}>
            <strong>Header row</strong>
            <input
              type="number"
              min="1"
              value={headerRow}
              onChange={(event) => {
                const nextHeaderRow = Number(event.target.value);
                setHeaderRow(nextHeaderRow);
                setMapping(
                  nextHeaderRow === Number(selectedSheet?.defaultHeaderRow || 1)
                    ? suggestedMapping(selectedSheet?.headers || [])
                    : {}
                );
              }}
            />
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: "12px",
            }}
          >
            {FIELD_OPTIONS.map(([field, label, mandatory]) => (
              <label key={field} style={{ display: "grid", gap: "6px" }}>
                <strong>
                  {label}
                  {mandatory ? " *" : ""}
                </strong>
                <select
                  value={mapping[field] || ""}
                  onChange={(event) =>
                    setMapping((current) => ({
                      ...current,
                      [field]: event.target.value || undefined,
                    }))
                  }
                >
                  <option value="">{mandatory ? "Select a column" : "Use default"}</option>
                  {headers.map((header, index) => (
                    <option key={`${index}:${header}`} value={String(index)}>
                      {header || `Column ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: "12px",
            }}
          >
            <label style={{ display: "grid", gap: "6px" }}>
              <strong>Default group</strong>
              <input
                value={defaults.group}
                onChange={(event) =>
                  setDefaults((current) => ({ ...current, group: event.target.value }))
                }
              />
            </label>
            <label style={{ display: "grid", gap: "6px" }}>
              <strong>Default weight</strong>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={defaults.weight}
                onChange={(event) =>
                  setDefaults((current) => ({ ...current, weight: Number(event.target.value) }))
                }
              />
            </label>
            <label
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                alignSelf: "end",
                minHeight: "42px",
              }}
            >
              <input
                type="checkbox"
                checked={Boolean(defaults.included)}
                onChange={(event) =>
                  setDefaults((current) => ({ ...current, included: event.target.checked }))
                }
              />{" "}
              Include by default
            </label>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <AppButton variant="outlined" onClick={() => setPhase("source")} disabled={busy}>
              Back
            </AppButton>
            <AppButton onClick={handleConfigure} disabled={busy}>
              {busy ? "Validating…" : "Preview rows"}
            </AppButton>
          </div>
        </>
      )}

      {phase === "preview" && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
            {[
              ["Selected", record?.summary?.selected],
              ["Valid", record?.summary?.valid],
              ["Invalid", record?.summary?.invalid],
              ["Conflicts", record?.summary?.conflicts],
            ].map(([label, value]) => (
              <span key={label}>
                <strong>{value || 0}</strong> {label.toLowerCase()}
              </span>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                {rows.map((row) => (
                  <tr key={row.id} style={{ opacity: row.selected ? 1 : 0.6 }}>
                    <td>
                      <input
                        aria-label={`Select row ${row.rowNumber}`}
                        type="checkbox"
                        checked={Boolean(row.selected)}
                        disabled={busy}
                        onChange={(event) => updateRow(row, { selected: event.target.checked })}
                      />
                    </td>
                    <td>{row.rowNumber}</td>
                    <td>
                      <input
                        aria-label={`Name for row ${row.rowNumber}`}
                        defaultValue={row.name || ""}
                        onBlur={(event) =>
                          event.target.value !== (row.name || "") &&
                          updateRow(row, { name: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Email for row ${row.rowNumber}`}
                        defaultValue={row.email || ""}
                        onBlur={(event) =>
                          event.target.value !== (row.email || "") &&
                          updateRow(row, { email: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Group for row ${row.rowNumber}`}
                        defaultValue={row.group || ""}
                        onBlur={(event) =>
                          event.target.value !== (row.group || "") &&
                          updateRow(row, { group: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Weight for row ${row.rowNumber}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        defaultValue={row.weight ?? 1}
                        onBlur={(event) =>
                          Number(event.target.value) !== Number(row.weight ?? 1) &&
                          updateRow(row, { weight: Number(event.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Included for row ${row.rowNumber}`}
                        type="checkbox"
                        checked={Boolean(row.included)}
                        onChange={(event) => updateRow(row, { included: event.target.checked })}
                      />
                    </td>
                    <td>
                      {!row.valid
                        ? (row.errors || []).join(" · ") || "Invalid"
                        : row.duplicate === "identical"
                          ? "Identical duplicate merged"
                          : row.duplicate === "conflict"
                            ? "Conflicting duplicate"
                            : "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            pagination={pagination}
            onPage={(page) =>
              loadRows(record, page).catch((requestError) => setError(requestError.message))
            }
          />
          <fieldset
            style={{
              display: "grid",
              gap: "10px",
              border: "1px solid var(--md-sys-color-outline)",
              borderRadius: "10px",
            }}
          >
            <legend>Import behavior</legend>
            <label>
              <input
                type="radio"
                name="import-mode"
                value="merge"
                checked={mode === "merge"}
                onChange={() => setMode("merge")}
              />{" "}
              Merge with the current roster and preserve schedules
            </label>
            <label>
              <input
                type="radio"
                name="import-mode"
                value="rebuild"
                checked={mode === "rebuild"}
                onChange={() => setMode("rebuild")}
              />{" "}
              Rebuild the roster and clear schedules, invitations, and pending delivery
            </label>
            {mode === "rebuild" && (
              <label style={{ display: "grid", gap: "6px", maxWidth: "360px" }}>
                <strong>Type {event.code} to confirm</strong>
                <input
                  aria-label="Rebuild confirmation code"
                  value={confirmationCode}
                  onChange={(event) => setConfirmationCode(event.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
          </fieldset>
          <div style={{ display: "flex", gap: "10px" }}>
            <AppButton variant="outlined" onClick={() => setPhase("mapping")} disabled={busy}>
              Back
            </AppButton>
            <AppButton
              onClick={handleCommit}
              disabled={
                busy ||
                !record?.summary?.valid ||
                (mode === "rebuild" && confirmationCode !== event.code)
              }
            >
              {busy ? "Importing…" : mode === "rebuild" ? "Rebuild roster" : "Merge roster"}
            </AppButton>
          </div>
        </>
      )}

      {phase === "complete" && (
        <div>
          <p role="status" style={{ color: "var(--md-sys-color-primary)" }}>
            {status}
          </p>
          <AppButton onClick={onClose}>Return to roster</AppButton>
        </div>
      )}
      {phase !== "complete" && status && (
        <p role="status" style={{ color: "var(--md-sys-color-primary)", margin: 0 }}>
          {status}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--md-sys-color-error)", margin: 0 }}>
          {error}
        </p>
      )}
    </section>
  );
}
