"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MdCheckCircle,
  MdExpandMore,
  MdGroups,
  MdSearch,
} from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { ManagedScheduleDrawer } from "@/components/schedule/OrganizerPanels";
import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import {
  createManagedParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import {
  fetchRoster,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
} from "@/lib/api/roster";

function groupValue(participant) {
  return (
    participant.group ?? participant.groupName ?? participant.group_name ?? ""
  );
}

function accountLabel(participant) {
  return participant.accountAccess === "temporary"
    ? "Temporary"
    : "Full account";
}

function deliveryLabel(participant) {
  const value = participant.invitationStatus || "not_sent";
  return String(value)
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function deliveryStatusVariant(participant) {
  switch (participant.invitationStatus || "not_sent") {
    case "invited":
      return "invited";
    case "opened":
      return "opened";
    case "submitted":
      return "submitted";
    default:
      return "not-sent";
  }
}

function invitationDeliveryRequest(data) {
  if (data?.deliveryRequest) return data.deliveryRequest;
  if (!data?.deliveryRequestId) return null;
  return {
    id: data.deliveryRequestId,
    operation: "invitation",
    recipientCount: data.recipientCount || 0,
    delivery: data.delivery || {},
  };
}

function fullNameError(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Full name is required.";
  if (normalized.length > 100)
    return "Full name must be 100 characters or fewer.";
  return "";
}

function emailAddressError(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Email address is required.";
  if (normalized.length > 254)
    return "Email address must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    return "Enter a valid email address.";
  return "";
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

const RosterPanel = forwardRef(function RosterPanel(
  { event, setEvent, getToken, onResultsInvalidated, onDeliveryRequestChange },
  forwardedRef,
) {
  const [participants, setParticipants] = useState([]);
  const [rowDrafts, setRowDrafts] = useState({});
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 50,
    total: 0,
    pages: 1,
  });
  const [stats, setStats] = useState({
    total: 0,
    submitted: 0,
    notSubmitted: 0,
    groups: [],
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [invitationStatus, setInvitationStatus] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteErrors, setInviteErrors] = useState({});
  const [inviteNotice, setInviteNotice] = useState("");
  const [inviteFormError, setInviteFormError] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
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
  const inviteIdempotencyKey = useRef("");
  const inviteRequestInFlight = useRef(false);
  const inviteNameInput = useRef(null);
  const inviteEmailInput = useRef(null);
  const selectedRef = useRef(selected);
  const participantsRef = useRef(participants);
  const rowMutationQueuesRef = useRef(new Map());

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const updateSelected = useCallback((updater) => {
    const next =
      typeof updater === "function" ? updater(selectedRef.current) : updater;
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const filters = useMemo(
    () => ({ search, group, submitted, invitationStatus }),
    [group, invitationStatus, search, submitted],
  );
  const inviteAllowed = event.status === "active";

  const loadRoster = useCallback(
    async (providedToken, { throwOnError = false } = {}) => {
      const currentRequest = ++requestNumber.current;
      setLoading(true);
      setError("");
      try {
        const token =
          providedToken === undefined ? await getToken() : providedToken;
        const data = await fetchRoster(
          event.code,
          { page, pageSize, ...filters },
          token,
        );
        if (currentRequest !== requestNumber.current) return;
        const nextParticipants = data.participants || [];
        participantsRef.current = nextParticipants;
        setParticipants(nextParticipants);
        setPagination(
          data.pagination || { page, pageSize, total: 0, pages: 1 },
        );
        setStats(
          data.stats || { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
        );
        const recoveredDelivery =
          data.latestDeliveryRequest ||
          data.deliveryRequest ||
          data.deliveryRequests?.[0];
        if (recoveredDelivery) onDeliveryRequestChange?.(recoveredDelivery);
        return data;
      } catch (requestError) {
        if (currentRequest === requestNumber.current) {
          setError(requestError.message || "Unable to load this roster.");
        }
        if (throwOnError) throw requestError;
        return null;
      } finally {
        if (currentRequest === requestNumber.current) setLoading(false);
      }
    },
    [event.code, filters, getToken, onDeliveryRequestChange, page, pageSize],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      refresh: (token) => loadRoster(token, { throwOnError: true }),
    }),
    [loadRoster],
  );

  const showInviteForm = () => {
    setShowImport(false);
    setShowInvite(true);
    setInviteNotice("");
    setInviteFormError("");
    setInviteErrors({});
    setTimeout(() => inviteNameInput.current?.focus(), 0);
  };

  const closeInviteForm = () => {
    setShowInvite(false);
    setInviteName("");
    setInviteEmail("");
    setInviteErrors({});
    setInviteFormError("");
    inviteIdempotencyKey.current = "";
  };

  const submitInvitation = async (submitEvent) => {
    submitEvent.preventDefault();
    if (inviteRequestInFlight.current) return;
    const normalizedName = inviteName.trim();
    const normalizedEmail = inviteEmail.trim().toLowerCase();
    const nextErrors = {
      name: fullNameError(inviteName),
      email: emailAddressError(inviteEmail),
    };
    setInviteErrors(nextErrors);
    setInviteNotice("");
    setInviteFormError("");
    setError("");
    setStatus("");

    if (nextErrors.name || nextErrors.email) {
      if (nextErrors.name) inviteNameInput.current?.focus();
      else inviteEmailInput.current?.focus();
      return;
    }
    if (!inviteAllowed) {
      setInviteFormError(
        "Reactivate this event before adding and inviting another person.",
      );
      return;
    }

    let addedParticipant = null;
    inviteRequestInFlight.current = true;
    setInviteBusy(true);
    try {
      const token = await getToken();
      if (!inviteIdempotencyKey.current) {
        inviteIdempotencyKey.current = crypto.randomUUID();
      }
      const data = await createManagedParticipant(
        event.code,
        {
          name: normalizedName,
          email: normalizedEmail,
          idempotencyKey: inviteIdempotencyKey.current,
        },
        token,
      );
      addedParticipant = data.participant || null;
      if (!addedParticipant?.id) {
        throw new Error("The participant was added without a roster ID.");
      }

      updateSelected((current) => new Set([...current, addedParticipant.id]));
      onResultsInvalidated?.();
      const autoInvitedCount = data.autoInvitedCount || 0;
      const nextDeliveryRequest = invitationDeliveryRequest(data);
      if (nextDeliveryRequest && autoInvitedCount > 0) {
        onDeliveryRequestChange?.(nextDeliveryRequest);
      }

      setPage(1);
      await loadRoster();
      setInviteNotice(
        autoInvitedCount > 0
          ? `${addedParticipant.name || normalizedName} is ready to respond. Their invitation was queued.`
          : `${addedParticipant.name || normalizedName} is already on this roster. No new invitation was sent.`,
      );
      setShowInvite(false);
      setInviteName("");
      setInviteEmail("");
      setInviteErrors({});
      setInviteFormError("");
      inviteIdempotencyKey.current = "";
      setTimeout(() =>
        document.getElementById("roster-invite-trigger")?.focus(),
      );
    } catch (requestError) {
      if (requestError.event) setEvent?.(requestError.event);
      if (
        requestError.errorCode === "event_not_active" ||
        requestError.event?.status === "closed"
      ) {
        setInviteFormError(
          "This event is closed. Reactivate it before adding participants.",
        );
      } else {
        setInviteFormError(
          requestError.message || "Unable to add and invite this person.",
        );
      }
    } finally {
      inviteRequestInFlight.current = false;
      setInviteBusy(false);
    }
  };

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

  useEffect(() => {
    if (event.status === "active") return;

    setStatus("");
    setError("");
    setShowImport(false);
    setShowInvite(false);
    setInviteName("");
    setInviteEmail("");
    setInviteErrors({});
    setInviteNotice("");
    setInviteFormError("");
    inviteIdempotencyKey.current = "";

    updateSelected(new Set());
    setBulkScope("selected");
    setBulkApplyWeight(false);
    setBulkWeight(1);
    setBulkApplyIncluded(false);
    setBulkIncluded(true);
    setBulkGroup("");
    bulkIdempotencyKey.current = "";

    setEditor(null);
    setEditorName("");
    setEditorInperson([]);
    setEditorVirtual([]);
    setEditorValue(1);
    setEditorError("");
    setEditorStatus("");
    setEditorConflict(null);
  }, [event.status, updateSelected]);

  const patchRow = async (participant, updates) => {
    const previous =
      rowMutationQueuesRef.current.get(participant.id) || Promise.resolve();
    const request = previous
      .catch(() => {})
      .then(async () => {
        setError("");
        setStatus("");
        const latest =
          participantsRef.current.find(
            (candidate) => candidate.id === participant.id,
          ) || participant;
        try {
          const token = await getToken();
          const data = await patchRosterParticipant(
            event.code,
            participant.id,
            { ...updates, expectedVersion: latest.version },
            token,
          );
          const updated = data.participant || { ...latest, ...updates };
          setParticipants((current) => {
            const next = current.map((candidate) =>
              candidate.id === participant.id
                ? { ...candidate, ...updated }
                : candidate,
            );
            participantsRef.current = next;
            return next;
          });
          setStatus(`${latest.name} was updated.`);
          if (data.resultsRevision !== undefined)
            onResultsInvalidated?.(data.resultsRevision);
          return true;
        } catch (requestError) {
          setError(requestError.message || `Unable to update ${latest.name}.`);
          if (requestError.status === 409) await loadRoster();
          return false;
        }
      });
    rowMutationQueuesRef.current.set(participant.id, request);
    const saved = await request;
    if (rowMutationQueuesRef.current.get(participant.id) === request) {
      rowMutationQueuesRef.current.delete(participant.id);
    }
    return saved;
  };

  const rowDraftValue = (participant, field, serverValue) =>
    Object.hasOwn(rowDrafts[participant.id] || {}, field)
      ? rowDrafts[participant.id][field]
      : serverValue;

  const updateRowDraft = (participantId, field, value) => {
    setRowDrafts((current) => ({
      ...current,
      [participantId]: { ...current[participantId], [field]: value },
    }));
  };

  const clearRowDraft = (participantId, field, expectedValue) => {
    setRowDrafts((current) => {
      const currentRow = current[participantId];
      if (!currentRow || String(currentRow[field]) !== String(expectedValue))
        return current;
      const nextRow = { ...currentRow };
      delete nextRow[field];
      const next = { ...current };
      if (Object.keys(nextRow).length) next[participantId] = nextRow;
      else delete next[participantId];
      return next;
    });
  };

  const saveRowDraft = async (participant, field, value, serverValue) => {
    if (String(value) === String(serverValue)) {
      clearRowDraft(participant.id, field, value);
      return;
    }
    await patchRow(participant, { [field]: value });
    // On failure this restores the authoritative prop; on success patchRow has
    // already replaced that prop with the server-normalized response.
    clearRowDraft(participant.id, field, value);
  };

  const bulkTarget = () => {
    if (bulkScope === "selected") return { participantIds: [...selected] };
    if (bulkScope === "group") {
      return { group: bulkGroup === "__ungrouped__" ? "" : bulkGroup };
    }
    const activeFilters = Object.fromEntries(
      Object.entries(filters).filter(
        ([, value]) => value !== "" && value !== undefined,
      ),
    );
    return {
      filter:
        Object.keys(activeFilters).length > 0 ? activeFilters : { all: true },
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
    if (!bulkIdempotencyKey.current)
      bulkIdempotencyKey.current = crypto.randomUUID();
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
        token,
      );
      setStatus(
        `Updated ${data.updatedCount ?? data.matchedCount ?? 0} roster entries.`,
      );
      updateSelected(new Set());
      bulkIdempotencyKey.current = "";
      if (data.resultsRevision !== undefined)
        onResultsInvalidated?.(data.resultsRevision);
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
      setError(
        requestError.message ||
          `Unable to load ${participant.name}'s schedule.`,
      );
    }
  };

  const closeEditor = () => {
    const dirty =
      editor &&
      (editorName !== editor.name ||
        JSON.stringify(editorInperson) !==
          JSON.stringify(editor.inpersonArray) ||
        JSON.stringify(editorVirtual) !== JSON.stringify(editor.virtualArray));
    if (
      dirty &&
      !window.confirm(
        "Discard the unsaved changes to this participant's schedule?",
      )
    ) {
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
        token,
      );
      const updated = {
        ...editor,
        ...data.participant,
        inpersonArray: (
          data.participant.availabilityInperson || editorInperson
        ).map(Number),
        virtualArray: (
          data.participant.availabilityVirtual || editorVirtual
        ).map(Number),
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
            requestError.participant.availabilityInperson ||
            editor.inpersonArray
          ).map(Number),
          virtualArray: (
            requestError.participant.availabilityVirtual || editor.virtualArray
          ).map(Number),
        };
        setEditorConflict(conflict);
        setEditorError(
          "This response changed after you opened it. Reload the latest response.",
        );
      } else if (
        requestError.status === 403 &&
        (requestError.errorCode || requestError.code) ===
          "organizer_edit_full_account"
      ) {
        setEditor(null);
        setError(
          "This person now has a full account, so organizer editing is no longer allowed.",
        );
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
    ? stats.groups
        .map((item) => (typeof item === "string" ? item : item.name))
        .filter(Boolean)
    : Object.keys(stats.groups || {});
  const groups = groupNames.map((name) => ({ value: name, label: name }));
  if (
    Array.isArray(stats.groups) &&
    stats.groups.some(
      (item) => (typeof item === "string" ? item : item.name) === "",
    )
  ) {
    groups.unshift({ value: "__ungrouped__", label: "Ungrouped" });
  }
  const allOnPageSelected =
    participants.length > 0 &&
    participants.every((participant) => selected.has(participant.id));
  const editorAllowed = event.status === "active";
  const rosterMutable = event.status === "active";
  const hasActiveFilters = Boolean(
    searchInput.trim() || search || group || submitted || invitationStatus,
  );
  const hasRosterEntries = (stats.total || 0) > 0;
  const isTrulyEmpty =
    !loading && !hasActiveFilters && !hasRosterEntries && !error;
  const showRosterTools = hasActiveFilters || hasRosterEntries;
  const showPagination = !loading && (pagination.total || 0) > 25;

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setGroup("");
    setSubmitted("");
    setInvitationStatus("");
    setPage(1);
  };

  return (
    <div
      className={`roster-panel${isTrulyEmpty ? " roster-panel--empty" : ""}`}
    >
      <section className="md-card roster-panel__controls">
        <div className="roster-panel__header">
          <div>
            <h3 id="organizer-roster-heading" className="roster-panel__title">
              Roster
            </h3>
            <div className="roster-panel__stats" aria-label="Roster summary">
              <span className="roster-panel__stat">
                <strong>{stats.total || 0}</strong>{" "}
                {(stats.total || 0) === 1 ? "person" : "people"}
              </span>
              <span className="roster-panel__stat">
                <strong>{stats.submitted || 0}</strong> submitted
              </span>
              <span className="roster-panel__stat">
                <strong>{stats.notSubmitted || 0}</strong> awaiting response
              </span>
            </div>
          </div>
          {rosterMutable && (
            <div
              className="roster-panel__header-actions"
              role="group"
              aria-label="Roster actions"
            >
              <AppButton
                id="roster-invite-trigger"
                variant={showInvite ? "outlined" : "filled"}
                onClick={showInvite ? closeInviteForm : showInviteForm}
                disabled={inviteBusy}
                aria-expanded={showInvite}
                aria-controls="roster-invite-form"
              >
                {showInvite ? "Close invite" : "Invite person"}
              </AppButton>
              <AppButton
                variant="outlined"
                onClick={() => {
                  const nextShowImport = !showImport;
                  setShowImport(nextShowImport);
                  if (nextShowImport) {
                    closeInviteForm();
                    setInviteNotice("");
                  }
                }}
                disabled={inviteBusy}
                aria-expanded={showImport}
              >
                {showImport ? "Hide import" : "Import roster"}
              </AppButton>
            </div>
          )}
        </div>

        {!rosterMutable && (
          <p role="note" className="roster-panel__note">
            {event.status === "closed"
              ? "This roster is read-only while responses are closed. Reactivate the event to make changes."
              : "Reactivate this event before changing its roster."}
          </p>
        )}

        {inviteNotice && (
          <p
            className="roster-panel__invite-notice"
            role="status"
            aria-live="polite"
          >
            <MdCheckCircle aria-hidden="true" />
            <span>{inviteNotice}</span>
          </p>
        )}

        {showInvite && rosterMutable && (
          <form
            id="roster-invite-form"
            className="roster-invite-form"
            aria-labelledby="roster-invite-title"
            noValidate
            onSubmit={submitInvitation}
          >
            <div className="roster-invite-form__header">
              <div>
                <h4
                  id="roster-invite-title"
                  className="roster-invite-form__title"
                >
                  Invite someone to respond
                </h4>
                <p className="roster-invite-form__description">
                  Add one person and email them a secure link to fill in their
                  availability.
                </p>
              </div>
            </div>

            <div className="roster-invite-form__fields">
              <div className="roster-panel__field roster-invite-form__field">
                <label htmlFor="roster-invite-name">Full name</label>
                <input
                  ref={inviteNameInput}
                  id="roster-invite-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  value={inviteName}
                  disabled={inviteBusy}
                  aria-invalid={Boolean(inviteErrors.name)}
                  aria-describedby={
                    inviteErrors.name ? "roster-invite-name-error" : undefined
                  }
                  onChange={(changeEvent) => {
                    setInviteName(changeEvent.target.value);
                    setInviteErrors((current) => ({ ...current, name: "" }));
                    setInviteFormError("");
                    inviteIdempotencyKey.current = "";
                  }}
                  onBlur={() =>
                    setInviteErrors((current) => ({
                      ...current,
                      name: fullNameError(inviteName),
                    }))
                  }
                />
                {inviteErrors.name && (
                  <span
                    id="roster-invite-name-error"
                    className="roster-invite-form__field-error"
                    role="alert"
                  >
                    {inviteErrors.name}
                  </span>
                )}
              </div>

              <div className="roster-panel__field roster-invite-form__field">
                <label htmlFor="roster-invite-email">Email address</label>
                <input
                  ref={inviteEmailInput}
                  id="roster-invite-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  value={inviteEmail}
                  disabled={inviteBusy}
                  aria-invalid={Boolean(inviteErrors.email)}
                  aria-describedby={
                    inviteErrors.email ? "roster-invite-email-error" : undefined
                  }
                  onChange={(changeEvent) => {
                    setInviteEmail(changeEvent.target.value);
                    setInviteErrors((current) => ({
                      ...current,
                      email: "",
                    }));
                    setInviteFormError("");
                    inviteIdempotencyKey.current = "";
                  }}
                  onBlur={() =>
                    setInviteErrors((current) => ({
                      ...current,
                      email: emailAddressError(inviteEmail),
                    }))
                  }
                />
                {inviteErrors.email && (
                  <span
                    id="roster-invite-email-error"
                    className="roster-invite-form__field-error"
                    role="alert"
                  >
                    {inviteErrors.email}
                  </span>
                )}
              </div>
            </div>

            {inviteFormError && (
              <p
                className="roster-invite-form__error"
                role="alert"
                aria-live="assertive"
              >
                {inviteFormError}
              </p>
            )}

            <div className="roster-invite-form__actions">
              <AppButton
                variant="text"
                onClick={closeInviteForm}
                disabled={inviteBusy}
              >
                Cancel
              </AppButton>
              <AppButton type="submit" disabled={inviteBusy || !inviteAllowed}>
                {inviteBusy ? "Adding and sending…" : "Add and send invitation"}
              </AppButton>
            </div>
          </form>
        )}

        {showRosterTools && (
          <div
            className="roster-panel__filters"
            role="search"
            aria-label="Roster filters"
          >
            <div className="roster-panel__filter roster-panel__filter--search">
              <MdSearch
                className="roster-panel__search-icon"
                aria-hidden="true"
              />
              <input
                className="roster-panel__filter-control roster-panel__filter-control--search"
                aria-label="Search roster"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search name or email"
              />
            </div>
            <div className="roster-panel__filter">
              <select
                className="roster-panel__filter-control"
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
            </div>
            <div className="roster-panel__filter">
              <select
                className="roster-panel__filter-control"
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
            </div>
            <div className="roster-panel__filter">
              <select
                className="roster-panel__filter-control"
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
          </div>
        )}

        {rosterMutable && hasRosterEntries && (
          <details
            className="roster-panel__bulk"
            aria-label="Bulk roster actions"
          >
            <summary className="roster-panel__bulk-summary">
              <span className="roster-panel__bulk-copy">
                <span className="roster-panel__bulk-title">Bulk actions</span>
                <small>
                  {selected.size} selected · Change weight or inclusion
                </small>
              </span>
              <MdExpandMore
                className="roster-panel__bulk-icon"
                aria-hidden="true"
              />
            </summary>
            <div className="roster-panel__bulk-controls">
              <div className="roster-panel__bulk-targets">
                <label className="roster-panel__field">
                  Apply to
                  <select
                    className="roster-panel__bulk-control"
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
                  <label className="roster-panel__field">
                    Group
                    <select
                      className="roster-panel__bulk-control"
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
              </div>

              <div className="roster-panel__bulk-changes">
                <fieldset className="roster-panel__bulk-setting">
                  <legend>Weight</legend>
                  <div className="roster-panel__bulk-setting-row">
                    <label className="roster-panel__check">
                      <input
                        className="roster-panel__bulk-checkbox"
                        aria-label="Apply bulk weight"
                        type="checkbox"
                        checked={bulkApplyWeight}
                        onChange={(event) =>
                          setBulkApplyWeight(event.target.checked)
                        }
                      />
                      Change weight
                    </label>
                    <label className="roster-panel__field roster-panel__field--compact">
                      Set to
                      <input
                        className="roster-panel__bulk-control roster-panel__bulk-control--number"
                        aria-label="Bulk weight"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={bulkWeight}
                        disabled={!bulkApplyWeight}
                        onChange={(event) =>
                          setBulkWeight(Number(event.target.value))
                        }
                      />
                    </label>
                  </div>
                </fieldset>

                <fieldset className="roster-panel__bulk-setting">
                  <legend>Inclusion</legend>
                  <div className="roster-panel__bulk-setting-row">
                    <label className="roster-panel__check">
                      <input
                        className="roster-panel__bulk-checkbox"
                        aria-label="Apply bulk included status"
                        type="checkbox"
                        checked={bulkApplyIncluded}
                        onChange={(event) =>
                          setBulkApplyIncluded(event.target.checked)
                        }
                      />
                      Change inclusion
                    </label>
                    <div className="roster-panel__field roster-panel__field--compact">
                      <span>Set to</span>
                      <label className="roster-panel__check">
                        <input
                          className="roster-panel__bulk-checkbox"
                          aria-label="Bulk included"
                          type="checkbox"
                          checked={bulkIncluded}
                          disabled={!bulkApplyIncluded}
                          onChange={(event) =>
                            setBulkIncluded(event.target.checked)
                          }
                        />
                        Included
                      </label>
                    </div>
                  </div>
                </fieldset>
              </div>

              <div className="roster-panel__bulk-footer">
                <p className="roster-panel__bulk-hint">
                  {bulkScope === "selected"
                    ? selected.size > 0
                      ? `${selected.size} participant${selected.size === 1 ? "" : "s"} will be updated.`
                      : "Select participants in the list before applying changes."
                    : bulkScope === "group"
                      ? "Changes apply to everyone in the chosen group."
                      : "Changes apply to everyone matching the current filters."}
                </p>
                <AppButton
                  onClick={applyBulk}
                  disabled={bulkBusy || !rosterMutable}
                >
                  {bulkBusy ? "Applying…" : "Apply update"}
                </AppButton>
              </div>
            </div>
          </details>
        )}
      </section>

      {showImport && rosterMutable && (
        <RosterImportWizard
          event={event}
          getToken={getToken}
          onEventChange={setEvent}
          onCommitted={(data) => {
            const receipt = data?.receipt || {};
            if (receipt.mode === "rebuild") {
              updateSelected(new Set());
            }
            if (data?.event) {
              setEvent?.(data.event);
            }
            const nextDeliveryRequest = invitationDeliveryRequest(data);
            if (nextDeliveryRequest) {
              onDeliveryRequestChange?.(nextDeliveryRequest);
            }
            const importedCount = receipt.importedCount || 0;
            const createdCount = receipt.createdCount || 0;
            const updatedCount = receipt.updatedCount || 0;
            const invitedCount =
              data?.autoInvitedCount ?? receipt.invitedCount ?? createdCount;
            setStatus(
              createdCount > 0 || invitedCount > 0
                ? `Imported ${importedCount} people: ${createdCount} added, ${updatedCount} updated. ${invitedCount} invitation${invitedCount === 1 ? "" : "s"} queued.`
                : `Imported ${importedCount} people: no new participants were added, so no invitations were sent.`,
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
        className="md-card roster-panel__list"
        aria-label="Roster entries"
      >
        {loading ? (
          <p className="roster-panel__empty roster-panel__empty--loading">
            Loading roster…
          </p>
        ) : participants.length === 0 ? (
          !showInvite &&
          !showImport &&
          !error && (
            <div className="roster-panel__empty-state">
              <span className="roster-panel__empty-icon" aria-hidden="true">
                {hasActiveFilters ? <MdSearch /> : <MdGroups />}
              </span>
              <div className="roster-panel__empty-copy">
                <h4>
                  {hasActiveFilters
                    ? "No matching participants"
                    : "No participants yet"}
                </h4>
                <p>
                  {hasActiveFilters
                    ? "Try a different search or clear the current filters."
                    : rosterMutable
                      ? "Invite someone or import a roster to start collecting availability."
                      : "This event does not have any participants."}
                </p>
              </div>
              {hasActiveFilters && (
                <AppButton variant="text" onClick={clearFilters}>
                  Clear filters
                </AppButton>
              )}
            </div>
          )
        ) : (
          <div className="roster-panel__table-scroll">
            <table className="roster-table">
              <caption className="roster-table__caption">
                Roster participants
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      className="roster-table__checkbox roster-table__checkbox--select-all"
                      aria-label="Select all on page"
                      type="checkbox"
                      checked={allOnPageSelected}
                      disabled={!rosterMutable}
                      onChange={(event) =>
                        updateSelected(
                          event.target.checked
                            ? new Set([
                                ...selected,
                                ...participants.map(
                                  (participant) => participant.id,
                                ),
                              ])
                            : new Set(
                                [...selected].filter(
                                  (id) =>
                                    !participants.some(
                                      (participant) => participant.id === id,
                                    ),
                                ),
                              ),
                        )
                      }
                    />
                  </th>
                  <th scope="col">Person</th>
                  <th scope="col">Settings</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((participant) => (
                  <tr
                    className="roster-table__row"
                    key={participant.id}
                    data-roster-participant-id={participant.id}
                  >
                    <td>
                      <input
                        className="roster-table__checkbox roster-table__checkbox--select-row"
                        aria-label={`Select ${participant.name}`}
                        type="checkbox"
                        checked={selected.has(participant.id)}
                        disabled={!rosterMutable}
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
                    <th scope="row" className="roster-table__person">
                      <strong>{participant.name}</strong>
                      <small className="roster-table__meta">
                        {participant.email || "No email"} ·{" "}
                        {accountLabel(participant)}
                      </small>
                      <div className="roster-table__person-action">
                        {participant.canOrganizerEditAvailability ? (
                          <AppButton
                            variant="outlined"
                            onClick={() => openEditor(participant)}
                            disabled={!editorAllowed}
                          >
                            Edit schedule
                          </AppButton>
                        ) : (
                          <span className="roster-table__self-managed">
                            Self-managed
                          </span>
                        )}
                      </div>
                    </th>
                    <td className="roster-table__settings-cell">
                      <div className="roster-table__settings">
                        <label className="roster-table__setting-group">
                          <span className="roster-table__setting-label">
                            Group
                          </span>
                          <input
                            className="roster-table__input roster-table__input--group"
                            aria-label={`Group for ${participant.name}`}
                            placeholder="Ungrouped"
                            value={rowDraftValue(
                              participant,
                              "group",
                              groupValue(participant),
                            )}
                            disabled={!rosterMutable}
                            onChange={(event) =>
                              updateRowDraft(
                                participant.id,
                                "group",
                                event.target.value,
                              )
                            }
                            onBlur={(event) =>
                              void saveRowDraft(
                                participant,
                                "group",
                                event.target.value,
                                groupValue(participant),
                              )
                            }
                          />
                        </label>
                        <div className="roster-table__priority">
                          <label className="roster-table__priority-field">
                            <span>Weight</span>
                            <input
                              className="roster-table__input roster-table__input--weight"
                              aria-label={`Weight for ${participant.name}`}
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={rowDraftValue(
                                participant,
                                "weight",
                                participant.weight ?? 1,
                              )}
                              disabled={!rosterMutable}
                              onChange={(event) =>
                                updateRowDraft(
                                  participant.id,
                                  "weight",
                                  event.target.value,
                                )
                              }
                              onBlur={(event) =>
                                void saveRowDraft(
                                  participant,
                                  "weight",
                                  Number(event.target.value),
                                  Number(participant.weight ?? 1),
                                )
                              }
                            />
                          </label>
                          <label className="roster-table__included-control">
                            <input
                              className="roster-table__checkbox roster-table__checkbox--included"
                              aria-label={`Include ${participant.name}`}
                              type="checkbox"
                              checked={Boolean(participant.included)}
                              disabled={!rosterMutable}
                              onChange={(event) =>
                                void patchRow(participant, {
                                  included: event.target.checked,
                                })
                              }
                            />
                            <span>Included</span>
                          </label>
                        </div>
                      </div>
                    </td>
                    <td className="roster-table__progress-cell">
                      <div className="roster-table__progress">
                        <span
                          className={`roster-status roster-status--response roster-status--${
                            participant.submitted
                              ? "submitted"
                              : "not-submitted"
                          }`}
                        >
                          <span className="roster-status__label">Response</span>
                          {participant.submitted
                            ? "Submitted"
                            : "Not submitted"}
                        </span>
                        <span
                          className={`roster-status roster-status--invitation roster-status--${deliveryStatusVariant(
                            participant,
                          )}`}
                        >
                          <span className="roster-status__label">Invite</span>
                          {deliveryLabel(participant)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showPagination && (
          <div className="roster-panel__pagination">
            <label className="roster-panel__page-size">
              Rows per page{" "}
              <select
                className="roster-panel__page-size-select"
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
            <div className="roster-panel__pagination-actions">
              <AppButton
                variant="outlined"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </AppButton>
              <span className="roster-panel__page-count">
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
        )}
      </section>

      {status && (
        <p
          role="status"
          className="roster-panel__message roster-panel__message--status"
        >
          {status}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="roster-panel__message roster-panel__message--error"
        >
          {error}
        </p>
      )}

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
            current.map((value, currentIndex) =>
              currentIndex === index ? editorValue : value,
            ),
          )
        }
        onVirtualPaint={(index) =>
          setEditorVirtual((current) =>
            current.map((value, currentIndex) =>
              currentIndex === index ? editorValue : value,
            ),
          )
        }
        onCopy={(source, target) => {
          const next = [
            ...(source === "inperson" ? editorInperson : editorVirtual),
          ];
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
});

export default RosterPanel;
