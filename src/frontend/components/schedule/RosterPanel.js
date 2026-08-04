"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { ManagedScheduleDrawer } from "@/components/schedule/OrganizerPanels";
import { DeliveryRequestProgress } from "@/components/schedule/OrganizerScalePanels";
import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import { updateParticipant } from "@/lib/api/participants";
import {
  fetchRoster,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
} from "@/lib/api/roster";

function groupValue(participant) {
  return participant.group ?? participant.groupName ?? participant.group_name ?? "";
}

function accountLabel(participant) {
  return participant.accountAccess === "temporary" ? "Temporary" : "Full account";
}

function deliveryLabel(participant) {
  const value = participant.invitationStatus || "not_sent";
  return String(value)
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function participantFromSchedule(data, slotCount) {
  const summary = data.participant || {};
  const schedule = data.schedule || {};
  const participantId = summary.memberId || summary.member_id || summary.id;
  return {
    ...summary,
    id: participantId,
    rosterId: summary.id,
    name: summary.name || "Participant",
    inpersonArray: Array.isArray(schedule.availabilityInperson)
      ? schedule.availabilityInperson.map(Number)
      : Array(slotCount).fill(0),
    virtualArray: Array.isArray(schedule.availabilityVirtual)
      ? schedule.availabilityVirtual.map(Number)
      : Array(slotCount).fill(0),
    submitted: Boolean(schedule.submitted),
    version: schedule.version ?? summary.version,
  };
}

export default function RosterPanel({
  event,
  setEvent,
  getToken,
  onResultsInvalidated,
  initialSelectedParticipantIds = [],
  onSelectionChange,
  onRosterRebuilt,
  deliveryRequest,
  onDeliveryRequestChange,
}) {
  const [participants, setParticipants] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0, pages: 1 });
  const [stats, setStats] = useState({ total: 0, submitted: 0, notSubmitted: 0, groups: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [invitationStatus, setInvitationStatus] = useState("");
  const [selected, setSelected] = useState(() => new Set(initialSelectedParticipantIds));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [bulkScope, setBulkScope] = useState("selected");
  const [bulkApplyWeight, setBulkApplyWeight] = useState(false);
  const [bulkWeight, setBulkWeight] = useState(1);
  const [bulkApplyIncluded, setBulkApplyIncluded] = useState(false);
  const [bulkIncluded, setBulkIncluded] = useState(true);
  const [bulkGroup, setBulkGroup] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [editorName, setEditorName] = useState("");
  const [editorInperson, setEditorInperson] = useState([]);
  const [editorVirtual, setEditorVirtual] = useState([]);
  const [editorValue, setEditorValue] = useState(1);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorStatus, setEditorStatus] = useState("");
  const [editorConflict, setEditorConflict] = useState(null);
  const requestNumber = useRef(0);
  const bulkIdempotencyKey = useRef("");
  const selectedRef = useRef(selected);

  const updateSelected = useCallback(
    (updater) => {
      const next = typeof updater === "function" ? updater(selectedRef.current) : updater;
      selectedRef.current = next;
      setSelected(next);
      onSelectionChange?.([...next]);
    },
    [onSelectionChange]
  );

  const filters = useMemo(
    () => ({ search, group, submitted, invitationStatus }),
    [group, invitationStatus, search, submitted]
  );

  const loadRoster = useCallback(async () => {
    const currentRequest = ++requestNumber.current;
    setLoading(true);
    setError("");
    try {
      const token = await getToken();
      const data = await fetchRoster(event.code, { page, pageSize, ...filters }, token);
      if (currentRequest !== requestNumber.current) return;
      setParticipants(data.participants || []);
      setPagination(data.pagination || { page, pageSize, total: 0, pages: 1 });
      setStats(data.stats || { total: 0, submitted: 0, notSubmitted: 0, groups: [] });
      const recoveredDelivery =
        data.latestDeliveryRequest || data.deliveryRequest || data.deliveryRequests?.[0];
      if (recoveredDelivery) onDeliveryRequestChange?.(recoveredDelivery);
    } catch (requestError) {
      if (currentRequest === requestNumber.current) {
        setError(requestError.message || "Unable to load this roster.");
      }
    } finally {
      if (currentRequest === requestNumber.current) setLoading(false);
    }
  }, [event.code, filters, getToken, onDeliveryRequestChange, page, pageSize]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(loadRoster, 0);
    return () => clearTimeout(timer);
  }, [loadRoster]);

  const patchRow = async (participant, updates) => {
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const data = await patchRosterParticipant(
        event.code,
        participant.id,
        { ...updates, expectedVersion: participant.version },
        token
      );
      const updated = data.participant || { ...participant, ...updates };
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id ? { ...candidate, ...updated } : candidate
        )
      );
      setStatus(`${participant.name} was updated.`);
      if (data.resultsRevision !== undefined) onResultsInvalidated?.(data.resultsRevision);
    } catch (requestError) {
      setError(requestError.message || `Unable to update ${participant.name}.`);
      if (requestError.status === 409) loadRoster();
    }
  };

  const bulkTarget = () => {
    if (bulkScope === "selected") return { participantIds: [...selected] };
    if (bulkScope === "group") {
      return { group: bulkGroup === "__ungrouped__" ? "" : bulkGroup };
    }
    const activeFilters = Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== "" && value !== undefined)
    );
    return {
      filter: Object.keys(activeFilters).length > 0 ? activeFilters : { all: true },
    };
  };

  const applyBulk = async () => {
    setError("");
    setStatus("");
    if (bulkScope === "selected" && selected.size === 0) {
      setError("Select at least one person for this bulk update.");
      return;
    }
    if (bulkScope === "group" && !bulkGroup) {
      setError("Choose a group for this bulk update.");
      return;
    }
    if (!bulkApplyWeight && !bulkApplyIncluded) {
      setError("Choose weight, included status, or both for this bulk update.");
      return;
    }
    const updates = {};
    if (bulkApplyWeight) updates.weight = bulkWeight;
    if (bulkApplyIncluded) updates.included = bulkIncluded;
    if (!bulkIdempotencyKey.current) bulkIdempotencyKey.current = crypto.randomUUID();
    setBulkBusy(true);
    try {
      const token = await getToken();
      const data = await patchRosterBulk(
        event.code,
        {
          ...bulkTarget(),
          updates,
          idempotencyKey: bulkIdempotencyKey.current,
        },
        token
      );
      setStatus(`Updated ${data.updatedCount ?? data.matchedCount ?? 0} roster entries.`);
      updateSelected(new Set());
      bulkIdempotencyKey.current = "";
      if (data.resultsRevision !== undefined) onResultsInvalidated?.(data.resultsRevision);
      await loadRoster();
    } catch (requestError) {
      setError(requestError.message || "Unable to apply the bulk update.");
    } finally {
      setBulkBusy(false);
    }
  };

  const openEditor = async (participant) => {
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const data = await fetchRosterSchedule(event.code, participant.id, token);
      const loaded = participantFromSchedule(data, event.slotCount || 0);
      setEditor(loaded);
      setEditorName(loaded.name);
      setEditorInperson(loaded.inpersonArray);
      setEditorVirtual(loaded.virtualArray);
      setEditorValue(1);
      setEditorError("");
      setEditorStatus("");
      setEditorConflict(null);
    } catch (requestError) {
      setError(requestError.message || `Unable to load ${participant.name}'s schedule.`);
    }
  };

  const closeEditor = () => {
    const dirty =
      editor &&
      (editorName !== editor.name ||
        JSON.stringify(editorInperson) !== JSON.stringify(editor.inpersonArray) ||
        JSON.stringify(editorVirtual) !== JSON.stringify(editor.virtualArray));
    if (dirty && !window.confirm("Discard the unsaved changes to this participant's schedule?")) {
      return;
    }
    setEditor(null);
    setEditorConflict(null);
  };

  const saveEditor = async (submit) => {
    if (!editor) return;
    setEditorSaving(true);
    setEditorError("");
    setEditorStatus("");
    try {
      const token = await getToken();
      const data = await updateParticipant(
        event.code,
        editor.id,
        {
          name: editorName.trim(),
          availabilityInperson: editorInperson,
          availabilityVirtual: editorVirtual,
          submitted: submit ? 1 : 0,
          expectedVersion: editor.version,
        },
        token
      );
      const updated = {
        ...editor,
        ...data.participant,
        inpersonArray: (data.participant.availabilityInperson || editorInperson).map(Number),
        virtualArray: (data.participant.availabilityVirtual || editorVirtual).map(Number),
      };
      setEditor(updated);
      setEditorName(updated.name);
      setEditorInperson(updated.inpersonArray);
      setEditorVirtual(updated.virtualArray);
      setEditorStatus(submit ? "Schedule submitted." : "Draft saved.");
      onResultsInvalidated?.();
      loadRoster();
    } catch (requestError) {
      if (requestError.status === 409 && requestError.participant) {
        const conflict = {
          ...requestError.participant,
          id: requestError.participant.id || editor.id,
          inpersonArray: (
            requestError.participant.availabilityInperson || editor.inpersonArray
          ).map(Number),
          virtualArray: (requestError.participant.availabilityVirtual || editor.virtualArray).map(
            Number
          ),
        };
        setEditorConflict(conflict);
        setEditorError("This response changed after you opened it. Reload the latest response.");
      } else if (
        requestError.status === 403 &&
        (requestError.errorCode || requestError.code) === "organizer_edit_full_account"
      ) {
        setEditor(null);
        setError("This person now has a full account, so organizer editing is no longer allowed.");
        loadRoster();
      } else {
        setEditorError(requestError.message || "Unable to save this schedule.");
      }
    } finally {
      setEditorSaving(false);
    }
  };

  const reloadConflict = () => {
    if (!editorConflict) return;
    setEditor(editorConflict);
    setEditorName(editorConflict.name);
    setEditorInperson(editorConflict.inpersonArray);
    setEditorVirtual(editorConflict.virtualArray);
    setEditorConflict(null);
    setEditorError("");
    setEditorStatus("Latest response loaded.");
  };

  const groupNames = Array.isArray(stats.groups)
    ? stats.groups.map((item) => (typeof item === "string" ? item : item.name)).filter(Boolean)
    : Object.keys(stats.groups || {});
  const groups = groupNames.map((name) => ({ value: name, label: name }));
  if (
    Array.isArray(stats.groups) &&
    stats.groups.some((item) => (typeof item === "string" ? item : item.name) === "")
  ) {
    groups.unshift({ value: "__ungrouped__", label: "Ungrouped" });
  }
  const allOnPageSelected =
    participants.length > 0 && participants.every((participant) => selected.has(participant.id));
  const editorAllowed = ["draft", "open", "closed"].includes(event.status);
  const rosterMutable = editorAllowed;

  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <section className="md-card" style={{ display: "grid", gap: "16px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Roster</h2>
            <p style={{ margin: "4px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
              {stats.total || 0} people · {stats.submitted || 0} submitted ·{" "}
              {stats.notSubmitted || 0} awaiting response
            </p>
          </div>
          <AppButton onClick={() => setShowImport((current) => !current)} disabled={!rosterMutable}>
            {showImport ? "Hide import" : "Import roster"}
          </AppButton>
        </div>

        {!rosterMutable && (
          <p role="note" style={{ margin: 0 }}>
            Reopen this event from Overview before changing or rebuilding its roster.
          </p>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(220px, 2fr) repeat(3, minmax(150px, 1fr))",
            gap: "10px",
          }}
        >
          <input
            aria-label="Search roster"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name or email"
          />
          <select
            aria-label="Filter by group"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All groups</option>
            {groups.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by response"
            value={submitted}
            onChange={(event) => {
              setSubmitted(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any response</option>
            <option value="true">Submitted</option>
            <option value="false">Not submitted</option>
          </select>
          <select
            aria-label="Filter by invitation"
            value={invitationStatus}
            onChange={(event) => {
              setInvitationStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any invitation</option>
            <option value="not_sent">Not sent</option>
            <option value="invited">Invited</option>
            <option value="opened">Opened</option>
            <option value="submitted">Submitted</option>
          </select>
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Bulk weight and inclusion
          </summary>
          <div
            style={{
              display: "flex",
              gap: "10px",
              flexWrap: "wrap",
              alignItems: "end",
              paddingTop: "12px",
            }}
          >
            <label style={{ display: "grid", gap: "5px" }}>
              Apply to
              <select
                aria-label="Bulk update scope"
                value={bulkScope}
                onChange={(event) => setBulkScope(event.target.value)}
              >
                <option value="selected">Selected people</option>
                <option value="filter">Current search and filters</option>
                <option value="group">One group</option>
              </select>
            </label>
            {bulkScope === "group" && (
              <label style={{ display: "grid", gap: "5px" }}>
                Group
                <select
                  aria-label="Bulk update group"
                  value={bulkGroup}
                  onChange={(event) => setBulkGroup(event.target.value)}
                >
                  <option value="">Choose group</option>
                  {groups.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label style={{ display: "flex", gap: "7px", alignItems: "center", minHeight: "42px" }}>
              <input
                aria-label="Apply bulk weight"
                type="checkbox"
                checked={bulkApplyWeight}
                onChange={(event) => setBulkApplyWeight(event.target.checked)}
              />
              Apply weight
            </label>
            <label style={{ display: "grid", gap: "5px" }}>
              Weight value
              <input
                aria-label="Bulk weight"
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={bulkWeight}
                disabled={!bulkApplyWeight}
                onChange={(event) => setBulkWeight(Number(event.target.value))}
              />
            </label>
            <label style={{ display: "flex", gap: "7px", alignItems: "center", minHeight: "42px" }}>
              <input
                aria-label="Apply bulk included status"
                type="checkbox"
                checked={bulkApplyIncluded}
                onChange={(event) => setBulkApplyIncluded(event.target.checked)}
              />
              Apply included status
            </label>
            <label style={{ display: "flex", gap: "7px", alignItems: "center", minHeight: "42px" }}>
              <input
                aria-label="Bulk included"
                type="checkbox"
                checked={bulkIncluded}
                disabled={!bulkApplyIncluded}
                onChange={(event) => setBulkIncluded(event.target.checked)}
              />{" "}
              Included
            </label>
            <AppButton onClick={applyBulk} disabled={bulkBusy || !rosterMutable}>
              {bulkBusy ? "Applying…" : "Apply update"}
            </AppButton>
          </div>
        </details>
      </section>

      {showImport && (
        <RosterImportWizard
          event={event}
          getToken={getToken}
          onCommitted={(data) => {
            const receipt = data?.receipt || {};
            if (receipt.mode === "rebuild") {
              updateSelected(new Set());
              onRosterRebuilt?.();
            }
            if (data?.event) {
              setEvent?.(data.event);
            }
            setStatus(
              `Imported ${receipt.importedCount || 0} people: ${receipt.createdCount || 0} created and ${receipt.updatedCount || 0} updated.`
            );
            setShowImport(false);
            setPage(1);
            loadRoster();
            onResultsInvalidated?.();
          }}
          onClose={() => setShowImport(false)}
        />
      )}

      <section
        className="md-card"
        aria-label="Roster entries"
        style={{ display: "grid", gap: "14px" }}
      >
        {loading ? (
          <p>Loading roster…</p>
        ) : participants.length === 0 ? (
          <p>No roster entries match these filters.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      aria-label="Select all on page"
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={(event) =>
                        updateSelected(
                          event.target.checked
                            ? new Set([
                                ...selected,
                                ...participants.map((participant) => participant.id),
                              ])
                            : new Set(
                                [...selected].filter(
                                  (id) => !participants.some((participant) => participant.id === id)
                                )
                              )
                        )
                      }
                    />
                  </th>
                  <th scope="col">Person</th>
                  <th scope="col">Group</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Included</th>
                  <th scope="col">Response</th>
                  <th scope="col">Invitation</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((participant) => (
                  <tr key={participant.id} data-roster-participant-id={participant.id}>
                    <td>
                      <input
                        aria-label={`Select ${participant.name}`}
                        type="checkbox"
                        checked={selected.has(participant.id)}
                        onChange={(event) =>
                          updateSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(participant.id);
                            else next.delete(participant.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <strong>{participant.name}</strong>
                      <small style={{ display: "block" }}>
                        {participant.email || "No email"} · {accountLabel(participant)}
                      </small>
                    </td>
                    <td>
                      <input
                        aria-label={`Group for ${participant.name}`}
                        defaultValue={groupValue(participant)}
                        disabled={!rosterMutable}
                        onBlur={(event) =>
                          event.target.value !== groupValue(participant) &&
                          patchRow(participant, { group: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Weight for ${participant.name}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        defaultValue={participant.weight ?? 1}
                        disabled={!rosterMutable}
                        onBlur={(event) =>
                          Number(event.target.value) !== Number(participant.weight ?? 1) &&
                          patchRow(participant, { weight: Number(event.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Include ${participant.name}`}
                        type="checkbox"
                        checked={Boolean(participant.included)}
                        disabled={!rosterMutable}
                        onChange={(event) =>
                          patchRow(participant, { included: event.target.checked })
                        }
                      />
                    </td>
                    <td>{participant.submitted ? "Submitted" : "Not submitted"}</td>
                    <td>{deliveryLabel(participant)}</td>
                    <td>
                      {participant.canOrganizerEditAvailability ? (
                        <AppButton
                          variant="outlined"
                          onClick={() => openEditor(participant)}
                          disabled={!editorAllowed}
                        >
                          Edit schedule
                        </AppButton>
                      ) : (
                        <span>Self-managed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label>
            Rows per page{" "}
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <AppButton
              variant="outlined"
              disabled={page <= 1 || loading}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </AppButton>
            <span>
              Page {pagination.page || page} of {pagination.pages || 1}
            </span>
            <AppButton
              variant="outlined"
              disabled={page >= (pagination.pages || 1) || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </AppButton>
          </div>
        </div>
      </section>

      {status && (
        <p role="status" style={{ color: "var(--md-sys-color-primary)" }}>
          {status}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--md-sys-color-error)" }}>
          {error}
        </p>
      )}

      <DeliveryRequestProgress
        key={deliveryRequest?.id || "no-roster-delivery"}
        initialRequest={deliveryRequest}
        getToken={getToken}
        onChange={onDeliveryRequestChange}
      />

      <ManagedScheduleDrawer
        event={event}
        mode={event.mode || "inperson"}
        participant={editor}
        participantName={editorName}
        setParticipantName={setEditorName}
        inperson={editorInperson}
        virtual={editorVirtual}
        availabilityValue={editorValue}
        onAvailabilityValueChange={setEditorValue}
        responsesOpen={editorAllowed}
        saving={editorSaving}
        error={editorError}
        status={editorStatus}
        conflictParticipant={editorConflict}
        onInpersonPaint={(index) =>
          setEditorInperson((current) =>
            current.map((value, currentIndex) => (currentIndex === index ? editorValue : value))
          )
        }
        onVirtualPaint={(index) =>
          setEditorVirtual((current) =>
            current.map((value, currentIndex) => (currentIndex === index ? editorValue : value))
          )
        }
        onCopy={(source, target) => {
          const next = [...(source === "inperson" ? editorInperson : editorVirtual)];
          if (target === "inperson") setEditorInperson(next);
          else setEditorVirtual(next);
        }}
        onSaveDraft={() => saveEditor(false)}
        onSubmit={() => saveEditor(true)}
        onReloadLatest={reloadConflict}
        onClose={closeEditor}
      />
    </div>
  );
}
