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
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/Icon";
import { Badge, Callout, LoadingState, Stat } from "@/components/ui/Feedback";
import { Checkbox, Field, Select, TextInput } from "@/components/ui/Form";
import { Card, SectionHeader } from "@/components/ui/Surface";
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

const GROUP_WEIGHT_PRESETS = [
  { value: "1", label: "Full influence", display: "1×" },
  { value: "0.5", label: "Half influence", display: "0.5×" },
  { value: "0", label: "No influence", display: "0×" },
];

// Response state is a solid chip; invitation state is an outline chip prefixed
// with "Invite", so the two never read as the same signal.
const INVITATION_TONE = {
  not_sent: "warning",
  invited: "outline",
  opened: "outline",
  submitted: "outline",
};

function peopleLabel(count) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function groupValue(participant) {
  return (
    participant.group ?? participant.groupName ?? participant.group_name ?? ""
  );
}

function rosterGroupEntries(groupStats) {
  const entries = Array.isArray(groupStats)
    ? groupStats.map((item) =>
        typeof item === "string"
          ? { name: item, count: 0 }
          : { name: item?.name ?? "", count: Number(item?.count) || 0 },
      )
    : Object.entries(groupStats || {}).map(([name, count]) => ({
        name,
        count: Number(count) || 0,
      }));

  const mergedEntries = new Map();
  entries.forEach((entry) => {
    const name = String(entry.name || "").trim();
    const key = name ? name.toLocaleLowerCase() : "__ungrouped__";
    const existing = mergedEntries.get(key);
    if (existing) {
      existing.count += entry.count;
      return;
    }
    mergedEntries.set(key, {
      name,
      count: entry.count,
      key,
      label: name || "Ungrouped",
    });
  });

  return [...mergedEntries.values()].sort((left, right) => {
    if (left.key === right.key) return 0;
    if (left.key === "__ungrouped__") return 1;
    if (right.key === "__ungrouped__") return -1;
    return left.label.localeCompare(right.label);
  });
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
  const [loadedRosterFilterKey, setLoadedRosterFilterKey] = useState(null);
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [groupWeightDrafts, setGroupWeightDrafts] = useState({});
  const [groupWeightErrors, setGroupWeightErrors] = useState({});
  const [groupWeightBusy, setGroupWeightBusy] = useState("");
  const [groupWeightStatus, setGroupWeightStatus] = useState("");
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
  const groupWeightIdempotencyKeys = useRef(new Map());
  const groupWeightRequestInFlight = useRef(false);
  const inviteIdempotencyKey = useRef("");
  const inviteRequestInFlight = useRef(false);
  const inviteNameInput = useRef(null);
  const inviteEmailInput = useRef(null);
  const selectedRef = useRef(selected);
  const participantsRef = useRef(participants);
  const rowMutationQueuesRef = useRef(new Map());
  const rowGroupReloadsRef = useRef(new Set());

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
  const rosterFilterKey = useMemo(() => JSON.stringify(filters), [filters]);
  const inviteAllowed = event.status === "active";

  const loadRoster = useCallback(
    async (providedToken, { throwOnError = false } = {}) => {
      const currentRequest = ++requestNumber.current;
      const requestedFilterKey = rosterFilterKey;
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
        setLoadedRosterFilterKey(requestedFilterKey);
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
    [
      event.code,
      filters,
      getToken,
      onDeliveryRequestChange,
      page,
      pageSize,
      rosterFilterKey,
    ],
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
    setSelectedGroupKey("");
    setGroupWeightDrafts({});
    setGroupWeightErrors({});
    setGroupWeightBusy("");
    setGroupWeightStatus("");
    groupWeightIdempotencyKeys.current.clear();

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
          if (Object.hasOwn(updates, "group")) {
            rowGroupReloadsRef.current.add(participant.id);
          }
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
      if (rowGroupReloadsRef.current.delete(participant.id)) {
        await loadRoster();
      }
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

  const applyGroupWeight = async (groupEntry) => {
    if (groupWeightRequestInFlight.current || !rosterMutable) return;
    const rawWeight = String(groupWeightDrafts[groupEntry.key] ?? "").trim();
    const weight = Number(rawWeight);
    if (
      rawWeight === "" ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 1
    ) {
      setGroupWeightErrors((current) => ({
        ...current,
        [groupEntry.key]: "Enter a Weight from 0 to 1.",
      }));
      return;
    }

    setError("");
    setStatus("");
    setGroupWeightStatus("");
    setGroupWeightErrors((current) => ({
      ...current,
      [groupEntry.key]: "",
    }));
    groupWeightRequestInFlight.current = true;
    setGroupWeightBusy(groupEntry.key);

    let idempotencyKey = groupWeightIdempotencyKeys.current.get(groupEntry.key);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      groupWeightIdempotencyKeys.current.set(groupEntry.key, idempotencyKey);
    }

    try {
      const token = await getToken();
      const data = await patchRosterBulk(
        event.code,
        {
          group: groupEntry.name,
          updates: { weight },
          idempotencyKey,
        },
        token,
      );
      const matchedCount =
        data.matchedCount ?? data.updatedCount ?? groupEntry.count;
      setGroupWeightStatus(
        `${groupEntry.label} Weight set to ${weight} for ${matchedCount} ${matchedCount === 1 ? "person" : "people"}.`,
      );
      setGroupWeightDrafts((current) => ({
        ...current,
        [groupEntry.key]: "",
      }));
      groupWeightIdempotencyKeys.current.delete(groupEntry.key);
      if (data.resultsRevision !== undefined) {
        onResultsInvalidated?.(data.resultsRevision);
      }
      await loadRoster(token);
    } catch (requestError) {
      setGroupWeightErrors((current) => ({
        ...current,
        [groupEntry.key]:
          requestError.message ||
          `Unable to update the ${groupEntry.label} group.`,
      }));
    } finally {
      groupWeightRequestInFlight.current = false;
      setGroupWeightBusy("");
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

  const groupEntries = rosterGroupEntries(stats.groups);
  const selectedGroupEntry =
    groupEntries.find((entry) => entry.key === selectedGroupKey) ||
    groupEntries[0] ||
    null;
  const selectedGroupIndex = selectedGroupEntry
    ? groupEntries.indexOf(selectedGroupEntry)
    : -1;
  const selectedGroupDraft = selectedGroupEntry
    ? (groupWeightDrafts[selectedGroupEntry.key] ?? "")
    : "";
  const selectedGroupError = selectedGroupEntry
    ? groupWeightErrors[selectedGroupEntry.key] || ""
    : "";
  const selectedGroupErrorId = `roster-group-weight-error-${selectedGroupIndex}`;
  const selectedGroupHelpId = `roster-group-weight-help-${selectedGroupIndex}`;
  const groups = groupEntries.map(({ key, label, name }) => ({
    value: key === "__ungrouped__" ? key : name,
    label,
  }));
  const allOnPageSelected =
    participants.length > 0 &&
    participants.every((participant) => selected.has(participant.id));
  const editorAllowed = event.status === "active";
  const rosterMutable = event.status === "active";
  const hasActiveFilters = Boolean(
    searchInput.trim() || search || group || submitted || invitationStatus,
  );
  const hasRosterEntries = (stats.total || 0) > 0;
  const groupStatsReady = !loading && loadedRosterFilterKey === rosterFilterKey;
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

  const updateGroupWeightDraft = (groupEntry, value) => {
    setGroupWeightDrafts((current) => ({
      ...current,
      [groupEntry.key]: value,
    }));
    setGroupWeightErrors((current) => ({
      ...current,
      [groupEntry.key]: "",
    }));
    setGroupWeightStatus("");
    groupWeightIdempotencyKeys.current.delete(groupEntry.key);
  };

  return (
    <div className="rv-stack rv-stack--lg">
      <Card as="section">
        <SectionHeader
          as="h3"
          titleId="organizer-roster-heading"
          title="Roster"
          description="Groups decide how much each set of people counts. People are the individuals you invite."
          actions={
            rosterMutable ? (
              <div
                className="rv-btn-row"
                role="group"
                aria-label="Roster actions"
              >
                <Button
                  id="roster-invite-trigger"
                  size="sm"
                  variant="primary"
                  icon="plus"
                  onClick={showInvite ? closeInviteForm : showInviteForm}
                  disabled={inviteBusy}
                  aria-expanded={showInvite}
                  aria-controls="roster-invite-form"
                >
                  {showInvite ? "Close invite" : "Invite person"}
                </Button>
                <Button
                  size="sm"
                  icon="upload"
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
                </Button>
              </div>
            ) : null
          }
        />

        <div
          className="rv-grid rv-grid--3"
          aria-label="Roster summary"
          role="group"
        >
          <Stat
            label="On the roster"
            value={stats.total || 0}
            hint={(stats.total || 0) === 1 ? "person" : "people"}
          />
          <Stat
            tone="accent"
            label="Submitted"
            value={stats.submitted || 0}
            hint="responses received"
          />
          <Stat
            label="Awaiting response"
            value={stats.notSubmitted || 0}
            hint="not submitted yet"
          />
        </div>

        {!rosterMutable && (
          <Callout tone="warning" role="note">
            {event.status === "closed"
              ? "This roster is read-only while responses are closed. Reactivate the event to make changes."
              : "Reactivate this event before changing its roster."}
          </Callout>
        )}

        {inviteNotice && (
          <Callout tone="success" role="status" aria-live="polite">
            {inviteNotice}
          </Callout>
        )}

        {showInvite && rosterMutable && (
          <form
            id="roster-invite-form"
            aria-labelledby="roster-invite-title"
            className="rv-card rv-card--muted rv-card--compact"
            noValidate
            onSubmit={submitInvitation}
          >
            <div className="rv-stack rv-stack--xs">
              <h4 id="roster-invite-title">Invite someone to respond</h4>
              <p className="rv-field__hint">
                Add one person and email them a secure link to fill in their
                availability.
              </p>
            </div>

            <div className="rv-grid rv-grid--pair">
              <Field
                label="Full name"
                id="roster-invite-name"
                error={inviteErrors.name}
              >
                <TextInput
                  ref={inviteNameInput}
                  name="name"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  value={inviteName}
                  disabled={inviteBusy}
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
              </Field>

              <Field
                label="Email address"
                id="roster-invite-email"
                error={inviteErrors.email}
              >
                <TextInput
                  ref={inviteEmailInput}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  value={inviteEmail}
                  disabled={inviteBusy}
                  onChange={(changeEvent) => {
                    setInviteEmail(changeEvent.target.value);
                    setInviteErrors((current) => ({ ...current, email: "" }));
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
              </Field>
            </div>

            {inviteFormError && (
              <Callout tone="danger" role="alert" aria-live="assertive">
                {inviteFormError}
              </Callout>
            )}

            <div className="rv-btn-row rv-btn-row--stack rv-btn-row--end">
              <Button onClick={closeInviteForm} disabled={inviteBusy}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                icon="mail"
                busy={inviteBusy}
                disabled={inviteBusy || !inviteAllowed}
              >
                {inviteBusy ? "Adding and sending…" : "Add and send invitation"}
              </Button>
            </div>
          </form>
        )}
      </Card>

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

      <div role="region" aria-label="Roster management" className="rv-roster">
        {showRosterTools && (
          <Card
            as="section"
            aria-label="Roster groups"
            className="rv-card--compact"
          >
            <div className="rv-split">
              <div className="rv-stack rv-stack--xs rv-fill">
                <h4>Groups</h4>
                <p className="rv-field__hint">
                  Choose one to adjust everyone together.
                </p>
              </div>
              {!hasActiveFilters && groupEntries.length > 0 && (
                <Badge tone="outline">
                  {groupEntries.length}{" "}
                  {groupEntries.length === 1 ? "group" : "groups"}
                </Badge>
              )}
            </div>

            {hasActiveFilters ? (
              <Callout tone="info">
                <p>
                  Group Weight changes affect everyone in a group, including
                  people hidden by filters. Clear filters to manage full groups.
                </p>
                <div className="rv-btn-row">
                  <Button size="sm" onClick={clearFilters}>
                    Show all groups
                  </Button>
                </div>
              </Callout>
            ) : !groupStatsReady ? (
              <LoadingState inline message="Loading all groups…" />
            ) : (
              <>
                <div
                  role="group"
                  aria-label="Choose a group"
                  className="rv-group-picker"
                >
                  {groupEntries.map((groupEntry) => {
                    const active = selectedGroupEntry?.key === groupEntry.key;
                    return (
                      <button
                        key={groupEntry.key}
                        type="button"
                        className="rv-group-option"
                        aria-pressed={active}
                        disabled={Boolean(groupWeightBusy)}
                        onClick={() => {
                          setSelectedGroupKey(groupEntry.key);
                          setGroupWeightStatus("");
                        }}
                      >
                        <span className="rv-group-option__name">
                          {groupEntry.label}
                        </span>{" "}
                        <small className="rv-group-option__count">
                          {peopleLabel(groupEntry.count)}
                        </small>
                      </button>
                    );
                  })}
                </div>

                {selectedGroupEntry && (
                  <form
                    role="group"
                    aria-label={`${selectedGroupEntry.label} group`}
                    className="rv-weight-editor"
                    noValidate
                    onSubmit={(submitEvent) => {
                      submitEvent.preventDefault();
                      void applyGroupWeight(selectedGroupEntry);
                    }}
                  >
                    <div className="rv-stack rv-stack--xs">
                      <p className="rv-eyebrow">Adjust group</p>
                      <p className="rv-cluster rv-cluster--sm">
                        <strong>{selectedGroupEntry.label}</strong>{" "}
                        <small className="rv-group-option__count">
                          {peopleLabel(selectedGroupEntry.count)}
                        </small>
                      </p>
                      <p id={selectedGroupHelpId} className="rv-field__hint">
                        Weight decides how much this group counts when Releviz
                        ranks meeting times. Full influence counts everyone
                        normally; no influence keeps them on the roster but
                        leaves them out of the ranking.
                      </p>
                    </div>

                    <div
                      role="group"
                      aria-label={`Quick Weight for ${selectedGroupEntry.label} group`}
                      className="rv-weight-presets"
                    >
                      {GROUP_WEIGHT_PRESETS.map((preset) => (
                        <button
                          key={preset.value}
                          type="button"
                          className="rv-weight-preset"
                          aria-pressed={selectedGroupDraft === preset.value}
                          disabled={!rosterMutable || Boolean(groupWeightBusy)}
                          onClick={() =>
                            updateGroupWeightDraft(
                              selectedGroupEntry,
                              preset.value,
                            )
                          }
                        >
                          <strong className="rv-weight-preset__value">
                            {preset.display}
                          </strong>{" "}
                          <span className="rv-weight-preset__label">
                            {preset.label}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="rv-input-group">
                      <Field label="Custom Weight" className="rv-fill">
                        <TextInput
                          className="rv-input--numeric"
                          aria-label={`Weight for ${selectedGroupEntry.label} group`}
                          aria-invalid={selectedGroupError ? "true" : undefined}
                          aria-describedby={
                            selectedGroupError
                              ? `${selectedGroupHelpId} ${selectedGroupErrorId}`
                              : selectedGroupHelpId
                          }
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          placeholder="0–1"
                          value={selectedGroupDraft}
                          disabled={
                            !rosterMutable ||
                            !groupStatsReady ||
                            Boolean(groupWeightBusy)
                          }
                          onChange={(changeEvent) =>
                            updateGroupWeightDraft(
                              selectedGroupEntry,
                              changeEvent.target.value,
                            )
                          }
                        />
                      </Field>
                      <Button
                        type="submit"
                        variant="primary"
                        aria-label={`Apply Weight to ${selectedGroupEntry.label} group`}
                        busy={groupWeightBusy === selectedGroupEntry.key}
                        disabled={
                          !rosterMutable ||
                          !groupStatsReady ||
                          Boolean(groupWeightBusy) ||
                          String(selectedGroupDraft).trim() === ""
                        }
                      >
                        {groupWeightBusy === selectedGroupEntry.key
                          ? "Applying…"
                          : `Apply to ${selectedGroupEntry.count}`}
                      </Button>
                    </div>
                    <p className="rv-field__hint">
                      This updates every person in {selectedGroupEntry.label} (
                      {peopleLabel(selectedGroupEntry.count)}).
                    </p>
                    {selectedGroupError && (
                      <Callout
                        id={selectedGroupErrorId}
                        tone="danger"
                        role="alert"
                        bare
                      >
                        {selectedGroupError}
                      </Callout>
                    )}
                  </form>
                )}
              </>
            )}

            {groupWeightStatus && (
              <Callout tone="success" role="status" aria-live="polite" bare>
                {groupWeightStatus}
              </Callout>
            )}
          </Card>
        )}

        <div
          role="region"
          aria-label="Roster people"
          className="rv-stack rv-stack--md"
        >
          {showRosterTools && (
            <div
              role="search"
              aria-label="Roster filters"
              className="rv-roster-filters"
            >
              <TextInput
                aria-label="Search roster"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search name or email"
              />
              <Select
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
              </Select>
              <Select
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
              </Select>
              <Select
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
              </Select>
            </div>
          )}

          {rosterMutable && hasRosterEntries && (
            <details
              aria-label="Bulk roster actions"
              className="rv-disclosure"
              open={bulkOpen}
              onToggle={(toggleEvent) =>
                setBulkOpen(toggleEvent.currentTarget.open)
              }
            >
              <summary className="rv-disclosure__summary">
                <span className="rv-disclosure__summary-text">
                  <span className="rv-disclosure__title">
                    Edit multiple people
                  </span>
                  <small className="rv-disclosure__hint">
                    {selected.size} selected · Change Weight or inclusion
                  </small>
                </span>
                <Icon name="chevronDown" className="rv-disclosure__chevron" />
              </summary>
              <div className="rv-disclosure__content rv-stack rv-stack--md">
                <div className="rv-grid rv-grid--pair">
                  <Field label="Apply to">
                    <Select
                      aria-label="Bulk update scope"
                      value={bulkScope}
                      onChange={(event) => setBulkScope(event.target.value)}
                    >
                      <option value="selected">Selected people</option>
                      <option value="filter">Current search and filters</option>
                      <option value="group">One group</option>
                    </Select>
                  </Field>
                  {bulkScope === "group" && (
                    <Field label="Group">
                      <Select
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
                      </Select>
                    </Field>
                  )}
                </div>

                <div className="rv-grid rv-grid--pair">
                  <fieldset className="rv-fieldset">
                    <legend className="rv-fieldset__legend">Weight</legend>
                    <Checkbox
                      label="Change weight"
                      aria-label="Apply bulk weight"
                      checked={bulkApplyWeight}
                      onChange={(event) =>
                        setBulkApplyWeight(event.target.checked)
                      }
                    />
                    <Field label="Set to">
                      <TextInput
                        className="rv-input--numeric"
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
                    </Field>
                  </fieldset>

                  <fieldset className="rv-fieldset">
                    <legend className="rv-fieldset__legend">Inclusion</legend>
                    <Checkbox
                      label="Change inclusion"
                      aria-label="Apply bulk included status"
                      checked={bulkApplyIncluded}
                      onChange={(event) =>
                        setBulkApplyIncluded(event.target.checked)
                      }
                    />
                    <Checkbox
                      label="Included"
                      aria-label="Bulk included"
                      checked={bulkIncluded}
                      disabled={!bulkApplyIncluded}
                      onChange={(event) =>
                        setBulkIncluded(event.target.checked)
                      }
                    />
                  </fieldset>
                </div>

                <Callout tone="info">
                  {bulkScope === "selected"
                    ? selected.size > 0
                      ? `${selected.size} participant${selected.size === 1 ? "" : "s"} will be updated.`
                      : "Select participants in the list before applying changes."
                    : bulkScope === "group"
                      ? "Changes apply to everyone in the chosen group."
                      : "Changes apply to everyone matching the current filters."}
                </Callout>
                <div className="rv-btn-row rv-btn-row--end">
                  <Button
                    variant="primary"
                    onClick={applyBulk}
                    busy={bulkBusy}
                    disabled={bulkBusy || !rosterMutable}
                  >
                    {bulkBusy ? "Applying…" : "Apply update"}
                  </Button>
                </div>
              </div>
            </details>
          )}

          <section
            aria-label="Roster entries"
            className="rv-stack rv-stack--sm"
          >
            {loading ? (
              <LoadingState message="Loading roster…" />
            ) : participants.length === 0 ? (
              !showInvite &&
              !showImport &&
              !error && (
                <div className="rv-state">
                  <Icon name="users" className="rv-state__icon" />
                  <h4 className="rv-state__title">
                    {hasActiveFilters
                      ? "No matching participants"
                      : "No participants yet"}
                  </h4>
                  <p className="rv-state__description">
                    {hasActiveFilters
                      ? "Try a different search or clear the current filters."
                      : rosterMutable
                        ? "Invite someone or import a roster to start collecting availability."
                        : "This event does not have any participants."}
                  </p>
                  {hasActiveFilters && (
                    <Button onClick={clearFilters}>Clear filters</Button>
                  )}
                </div>
              )
            ) : (
              <div className="rv-table-wrap">
                <table className="rv-people" role="table">
                  <caption className="rv-visually-hidden">
                    Roster participants
                  </caption>
                  <thead role="rowgroup">
                    <tr role="row">
                      <th
                        scope="col"
                        role="columnheader"
                        className="rv-people__select"
                      >
                        <Checkbox
                          tight
                          aria-label="Select all on page"
                          label={
                            <span className="rv-visually-hidden">
                              Select all on page
                            </span>
                          }
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
                                          (participant) =>
                                            participant.id === id,
                                        ),
                                    ),
                                  ),
                            )
                          }
                        />
                      </th>
                      <th scope="col" role="columnheader">
                        Person
                      </th>
                      <th scope="col" role="columnheader">
                        Settings
                      </th>
                      <th scope="col" role="columnheader">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {participants.map((participant) => (
                      <tr
                        key={participant.id}
                        role="row"
                        data-roster-participant-id={participant.id}
                      >
                        <td role="cell" className="rv-people__select">
                          <Checkbox
                            tight
                            aria-label={`Select ${participant.name}`}
                            label={
                              <span className="rv-visually-hidden">
                                Select {participant.name}
                              </span>
                            }
                            checked={selected.has(participant.id)}
                            disabled={!rosterMutable}
                            onChange={(event) =>
                              updateSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked)
                                  next.add(participant.id);
                                else next.delete(participant.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <th scope="row" role="rowheader">
                          <span className="rv-person__name">
                            {participant.name}
                          </span>
                          <span className="rv-person__email">
                            {participant.email || "No email"}
                          </span>
                          <span className="rv-cluster rv-cluster--sm rv-person__tags">
                            <Badge tone="outline">
                              {accountLabel(participant)}
                            </Badge>
                            {participant.canOrganizerEditAvailability ? (
                              <Button
                                size="sm"
                                icon="calendar"
                                onClick={() => openEditor(participant)}
                                disabled={!editorAllowed}
                              >
                                Edit schedule
                              </Button>
                            ) : (
                              <span className="rv-field__hint">
                                Manages own schedule
                              </span>
                            )}
                          </span>
                        </th>
                        <td role="cell">
                          <div className="rv-person__settings">
                            <Field label="Group" className="rv-field--inline">
                              <TextInput
                                size="sm"
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
                            </Field>
                            <Field label="Weight" className="rv-field--inline">
                              <TextInput
                                size="sm"
                                className="rv-input--numeric"
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
                            </Field>
                            <Checkbox
                              tight
                              label="Count in results"
                              aria-label={`Include ${participant.name}`}
                              checked={Boolean(participant.included)}
                              disabled={!rosterMutable}
                              onChange={(event) =>
                                void patchRow(participant, {
                                  included: event.target.checked,
                                })
                              }
                            />
                          </div>
                        </td>
                        <td role="cell">
                          <div className="rv-person__status">
                            <Badge
                              tone={
                                participant.submitted ? "success" : "neutral"
                              }
                              icon={
                                participant.submitted ? "checkCircle" : "clock"
                              }
                            >
                              <span className="rv-visually-hidden">
                                Response:
                              </span>{" "}
                              {participant.submitted
                                ? "Submitted"
                                : "Not submitted"}
                            </Badge>
                            <Badge
                              tone={
                                INVITATION_TONE[
                                  participant.invitationStatus || "not_sent"
                                ] || "outline"
                              }
                              icon="mail"
                            >
                              Invite · {deliveryLabel(participant)}
                            </Badge>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {showPagination && (
                  <div className="rv-pagination">
                    <label className="rv-cluster rv-cluster--sm">
                      Rows per page{" "}
                      <Select
                        size="sm"
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
                      </Select>
                    </label>
                    <div className="rv-pagination__controls">
                      <Button
                        size="sm"
                        icon="chevronLeft"
                        disabled={page <= 1 || loading}
                        onClick={() => setPage((current) => current - 1)}
                      >
                        Previous
                      </Button>
                      <span>
                        Page {pagination.page || page} of{" "}
                        {pagination.pages || 1}
                      </span>
                      <Button
                        size="sm"
                        iconEnd="chevronRight"
                        disabled={page >= (pagination.pages || 1) || loading}
                        onClick={() => setPage((current) => current + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {status && (
        <Callout tone="success" role="status">
          {status}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
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
