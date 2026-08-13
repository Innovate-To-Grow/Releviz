"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppButton from "@/components/ui/AppButton";
import { ManagedScheduleDrawer } from "@/components/schedule/OrganizerPanels";
import { DeliveryRequestProgress } from "@/components/schedule/OrganizerScalePanels";
import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import { launchEvent, sendInvitations } from "@/lib/api/events";
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
  const [selected, setSelected] = useState(
    () => new Set(initialSelectedParticipantIds),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteErrors, setInviteErrors] = useState({});
  const [inviteFormStatus, setInviteFormStatus] = useState("");
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

  const updateSelected = useCallback(
    (updater) => {
      const next =
        typeof updater === "function" ? updater(selectedRef.current) : updater;
      selectedRef.current = next;
      setSelected(next);
      onSelectionChange?.([...next]);
    },
    [onSelectionChange],
  );

  const filters = useMemo(
    () => ({ search, group, submitted, invitationStatus }),
    [group, invitationStatus, search, submitted],
  );
  const inviteAllowed = event.status === "draft" || event.status === "open";

  const loadRoster = useCallback(async () => {
    const currentRequest = ++requestNumber.current;
    setLoading(true);
    setError("");
    try {
      const token = await getToken();
      const data = await fetchRoster(
        event.code,
        { page, pageSize, ...filters },
        token,
      );
      if (currentRequest !== requestNumber.current) return;
      setParticipants(data.participants || []);
      setPagination(data.pagination || { page, pageSize, total: 0, pages: 1 });
      setStats(
        data.stats || { total: 0, submitted: 0, notSubmitted: 0, groups: [] },
      );
      const recoveredDelivery =
        data.latestDeliveryRequest ||
        data.deliveryRequest ||
        data.deliveryRequests?.[0];
      if (recoveredDelivery) onDeliveryRequestChange?.(recoveredDelivery);
    } catch (requestError) {
      if (currentRequest === requestNumber.current) {
        setError(requestError.message || "Unable to load this roster.");
      }
    } finally {
      if (currentRequest === requestNumber.current) setLoading(false);
    }
  }, [event.code, filters, getToken, onDeliveryRequestChange, page, pageSize]);

  const showInviteForm = () => {
    setShowImport(false);
    setShowInvite(true);
    setTimeout(() => inviteNameInput.current?.focus(), 0);
  };

  const closeInviteForm = () => {
    setShowInvite(false);
    setInviteName("");
    setInviteEmail("");
    setInviteErrors({});
    setInviteFormStatus("");
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
    setInviteFormStatus("");
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
        "Reopen this event before adding and inviting another person.",
      );
      return;
    }

    let addedParticipant = null;
    inviteRequestInFlight.current = true;
    setInviteBusy(true);
    try {
      const token = await getToken();
      const created = await createManagedParticipant(
        event.code,
        { name: normalizedName, email: normalizedEmail },
        token,
      );
      addedParticipant = created.participant || null;
      if (!addedParticipant?.id) {
        throw new Error("The participant was added without a roster ID.");
      }

      updateSelected((current) => new Set([...current, addedParticipant.id]));
      onResultsInvalidated?.();
      if (!inviteIdempotencyKey.current) {
        inviteIdempotencyKey.current = crypto.randomUUID();
      }

      const invitationResult =
        event.status === "draft"
          ? await launchEvent(
              event.code,
              {
                expectedVersion: event.version,
                idempotencyKey: inviteIdempotencyKey.current,
                selection: { participantIds: [addedParticipant.id] },
              },
              token,
            )
          : await sendInvitations(
              event.code,
              {
                emails: [normalizedEmail],
                idempotencyKey: inviteIdempotencyKey.current,
              },
              token,
            );

      if (event.status === "draft" && invitationResult.event) {
        setEvent?.(invitationResult.event);
      }
      const nextDeliveryRequest = invitationDeliveryRequest(invitationResult);
      if (nextDeliveryRequest) {
        onDeliveryRequestChange?.(nextDeliveryRequest);
      }

      setPage(1);
      await loadRoster();
      setInviteFormStatus(
        `${addedParticipant.name || normalizedName} was added and their invitation was queued.`,
      );
      setInviteName("");
      setInviteEmail("");
      setInviteErrors({});
      setInviteFormError("");
      inviteIdempotencyKey.current = "";
      setTimeout(() => inviteNameInput.current?.focus(), 0);
    } catch (requestError) {
      if (requestError.event) setEvent?.(requestError.event);
      if (addedParticipant) {
        setPage(1);
        await loadRoster();
        setInviteFormError(
          `${addedParticipant.name || normalizedName} was added to the roster, but the invitation was not sent. ${
            requestError.message || "Try again to send it."
          }`,
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

  const patchRow = async (participant, updates) => {
    setError("");
    setStatus("");
    try {
      const token = await getToken();
      const data = await patchRosterParticipant(
        event.code,
        participant.id,
        { ...updates, expectedVersion: participant.version },
        token,
      );
      const updated = data.participant || { ...participant, ...updates };
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id
            ? { ...candidate, ...updated }
            : candidate,
        ),
      );
      setStatus(`${participant.name} was updated.`);
      if (data.resultsRevision !== undefined)
        onResultsInvalidated?.(data.resultsRevision);
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
  const editorAllowed = ["draft", "open", "closed"].includes(event.status);
  const rosterMutable = editorAllowed;

  return (
    <div className="roster-panel">
      <section className="md-card roster-panel__controls">
        <div className="roster-panel__header">
          <div>
            <h2 className="roster-panel__title">Roster</h2>
            <p className="roster-panel__summary">
              {stats.total || 0} people · {stats.submitted || 0} submitted ·{" "}
              {stats.notSubmitted || 0} awaiting response
            </p>
          </div>
          <div className="roster-panel__header-actions">
            <AppButton
              onClick={showInviteForm}
              disabled={!inviteAllowed || inviteBusy}
              aria-expanded={showInvite}
              aria-controls="roster-invite-form"
            >
              Invite person
            </AppButton>
            <AppButton
              variant="outlined"
              onClick={() => {
                const nextShowImport = !showImport;
                setShowImport(nextShowImport);
                if (nextShowImport) closeInviteForm();
              }}
              disabled={!rosterMutable || inviteBusy}
              aria-expanded={showImport}
            >
              {showImport ? "Hide import" : "Import roster"}
            </AppButton>
          </div>
        </div>

        {!rosterMutable && (
          <p role="note" className="roster-panel__note">
            Reopen this event from Overview before changing or rebuilding its
            roster.
          </p>
        )}
        {rosterMutable && !inviteAllowed && (
          <p role="note" className="roster-panel__note">
            Reopen responses from Overview before inviting another person.
          </p>
        )}

        {showInvite && (
          <form
            id="roster-invite-form"
            className="roster-invite-form"
            aria-labelledby="roster-invite-title"
            noValidate
            onSubmit={submitInvitation}
          >
            <div className="roster-invite-form__header">
              <div>
                <h3
                  id="roster-invite-title"
                  className="roster-invite-form__title"
                >
                  Invite someone to respond
                </h3>
                <p className="roster-invite-form__description">
                  Add one person and email them a secure link to fill in their
                  availability.
                </p>
              </div>
            </div>

            {event.status === "draft" && (
              <p className="roster-invite-form__note">
                Sending the first invitation opens this event for responses and
                emails only this person.
              </p>
            )}

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
                    setInviteFormStatus("");
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
                <span
                  id="roster-invite-name-error"
                  className="roster-invite-form__field-error"
                  role={inviteErrors.name ? "alert" : undefined}
                >
                  {inviteErrors.name}
                </span>
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
                    setInviteFormStatus("");
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
                <span
                  id="roster-invite-email-error"
                  className="roster-invite-form__field-error"
                  role={inviteErrors.email ? "alert" : undefined}
                >
                  {inviteErrors.email}
                </span>
              </div>
            </div>

            {inviteFormStatus && (
              <p
                className="roster-invite-form__status"
                role="status"
                aria-live="polite"
              >
                {inviteFormStatus}
              </p>
            )}

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

        <div className="roster-panel__filters">
          <div className="roster-panel__filter roster-panel__filter--search">
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

        <details className="roster-panel__bulk">
          <summary className="roster-panel__bulk-summary">
            Bulk weight and inclusion
          </summary>
          <div className="roster-panel__bulk-controls">
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
            <label className="roster-panel__check">
              <input
                className="roster-panel__bulk-checkbox"
                aria-label="Apply bulk weight"
                type="checkbox"
                checked={bulkApplyWeight}
                onChange={(event) => setBulkApplyWeight(event.target.checked)}
              />
              Apply weight
            </label>
            <label className="roster-panel__field">
              Weight value
              <input
                className="roster-panel__bulk-control roster-panel__bulk-control--number"
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
            <label className="roster-panel__check">
              <input
                className="roster-panel__bulk-checkbox"
                aria-label="Apply bulk included status"
                type="checkbox"
                checked={bulkApplyIncluded}
                onChange={(event) => setBulkApplyIncluded(event.target.checked)}
              />
              Apply included status
            </label>
            <label className="roster-panel__check">
              <input
                className="roster-panel__bulk-checkbox"
                aria-label="Bulk included"
                type="checkbox"
                checked={bulkIncluded}
                disabled={!bulkApplyIncluded}
                onChange={(event) => setBulkIncluded(event.target.checked)}
              />{" "}
              Included
            </label>
            <AppButton
              onClick={applyBulk}
              disabled={bulkBusy || !rosterMutable}
            >
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
              `Imported ${receipt.importedCount || 0} people: ${receipt.createdCount || 0} created and ${receipt.updatedCount || 0} updated.`,
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
          <p className="roster-panel__empty">
            No roster entries match these filters.
          </p>
        ) : (
          <div className="roster-panel__table-scroll">
            <table className="roster-table">
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      className="roster-table__checkbox roster-table__checkbox--select-all"
                      aria-label="Select all on page"
                      type="checkbox"
                      checked={allOnPageSelected}
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
                    <td className="roster-table__person">
                      <strong>{participant.name}</strong>
                      <small className="roster-table__meta">
                        {participant.email || "No email"} ·{" "}
                        {accountLabel(participant)}
                      </small>
                    </td>
                    <td>
                      <input
                        className="roster-table__input roster-table__input--group"
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
                        className="roster-table__input roster-table__input--weight"
                        aria-label={`Weight for ${participant.name}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        defaultValue={participant.weight ?? 1}
                        disabled={!rosterMutable}
                        onBlur={(event) =>
                          Number(event.target.value) !==
                            Number(participant.weight ?? 1) &&
                          patchRow(participant, {
                            weight: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="roster-table__checkbox roster-table__checkbox--included"
                        aria-label={`Include ${participant.name}`}
                        type="checkbox"
                        checked={Boolean(participant.included)}
                        disabled={!rosterMutable}
                        onChange={(event) =>
                          patchRow(participant, {
                            included: event.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="roster-table__status-cell">
                      <span
                        className={`roster-status roster-status--response roster-status--${
                          participant.submitted ? "submitted" : "not-submitted"
                        }`}
                      >
                        {participant.submitted ? "Submitted" : "Not submitted"}
                      </span>
                    </td>
                    <td className="roster-table__status-cell">
                      <span
                        className={`roster-status roster-status--invitation roster-status--${deliveryStatusVariant(
                          participant,
                        )}`}
                      >
                        {deliveryLabel(participant)}
                      </span>
                    </td>
                    <td className="roster-table__actions">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
}
