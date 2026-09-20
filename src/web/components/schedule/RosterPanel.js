"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import EmptyState from "@/components/ui/EmptyState";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EditIcon,
  GroupIcon,
  ImportIcon,
  InviteIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
} from "@/components/ui/icons";
import { ManagedScheduleDrawer } from "@/components/schedule/OrganizerPanels";
import RosterGroups, {
  UNGROUPED,
  groupFilterValue,
  summarizeGroups,
} from "@/components/schedule/RosterGroups";
import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import {
  createManagedParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import {
  createRosterGroup,
  deleteRosterGroup,
  fetchRoster,
  fetchRosterSchedule,
  patchRosterBulk,
  patchRosterParticipant,
  renameRosterGroup,
} from "@/lib/api/roster";

// The server formats a person's memberships as one cell string ("A; B", or
// "ALL; A" when they belong to every group), which is what the row edits.
function groupValue(participant) {
  return participant.group ?? "";
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
  const [bulkApplyGroups, setBulkApplyGroups] = useState(false);
  // add | remove | replace | clear, applied to the target group below.
  const [bulkGroupAction, setBulkGroupAction] = useState("add");
  const [bulkGroupTarget, setBulkGroupTarget] = useState("");
  const [bulkAllGroups, setBulkAllGroups] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [groupBusy, setGroupBusy] = useState("");
  const [editor, setEditor] = useState(null);
  const [editorName, setEditorName] = useState("");
  const [editorInperson, setEditorInperson] = useState([]);
  const [editorVirtual, setEditorVirtual] = useState([]);
  const [editorValue, setEditorValue] = useState(1);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorStatus, setEditorStatus] = useState("");
  const [editorConflict, setEditorConflict] = useState(null);
  // Rows whose last patch hit a newer version, shaped
  // { [participantId]: { name, participant, message } }. A row stays locked
  // until the organizer reloads the latest values.
  const [rowConflicts, setRowConflicts] = useState({});
  const requestNumber = useRef(0);
  const bulkIdempotencyKey = useRef("");
  const inviteIdempotencyKey = useRef("");
  const inviteRequestInFlight = useRef(false);
  const inviteNameInput = useRef(null);
  const inviteEmailInput = useRef(null);
  const selectedRef = useRef(selected);
  const participantsRef = useRef(participants);
  const rowConflictsRef = useRef(rowConflicts);
  const rowMutationQueuesRef = useRef(new Map());
  const controlIds = useId();

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const updateSelected = useCallback((updater) => {
    const next =
      typeof updater === "function" ? updater(selectedRef.current) : updater;
    selectedRef.current = next;
    setSelected(next);
  }, []);

  // loadRoster reads the conflicts through the ref so a reload can settle
  // them without re-creating the callback on every conflict change.
  const updateRowConflicts = useCallback((updater) => {
    const next =
      typeof updater === "function"
        ? updater(rowConflictsRef.current)
        : updater;
    rowConflictsRef.current = next;
    setRowConflicts(next);
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
        // A load that holds a conflicted row at the version the 409 carried
        // (or newer) has caught up with the other session: unlock the row
        // and drop the draft that would otherwise overlay the fresh values.
        // Rows off this page, or loaded at an older version, stay locked.
        const caughtUp = Object.keys(rowConflictsRef.current).filter(
          (participantId) => {
            const loaded = nextParticipants.find(
              (candidate) => candidate.id === participantId,
            );
            const conflict = rowConflictsRef.current[participantId];
            return (
              Boolean(loaded) &&
              Number(loaded.version) >= Number(conflict.participant.version)
            );
          },
        );
        if (caughtUp.length) {
          updateRowConflicts((current) => {
            const next = { ...current };
            for (const participantId of caughtUp) delete next[participantId];
            return next;
          });
          setRowDrafts((current) => {
            const next = { ...current };
            for (const participantId of caughtUp) delete next[participantId];
            return next;
          });
        }
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
    [
      event.code,
      filters,
      getToken,
      onDeliveryRequestChange,
      page,
      pageSize,
      updateRowConflicts,
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
    setBulkApplyGroups(false);
    setBulkGroupAction("add");
    setBulkGroupTarget("");
    setBulkAllGroups(false);
    bulkIdempotencyKey.current = "";

    setEditor(null);
    setEditorName("");
    setEditorInperson([]);
    setEditorVirtual([]);
    setEditorValue(1);
    setEditorError("");
    setEditorStatus("");
    setEditorConflict(null);
    updateRowConflicts({});
  }, [event.status, updateRowConflicts, updateSelected]);

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
          // The server recounts the groups so their shared weights stay true
          // without reloading the whole page of people.
          if (Array.isArray(data.groups))
            setStats((current) => ({ ...current, groups: data.groups }));
          return "saved";
        } catch (requestError) {
          if (requestError.status === 409 && requestError.participant) {
            // The server sent the row it now holds. Show the conflict and let
            // the organizer choose when to load it instead of refreshing the
            // roster behind their back.
            const conflictParticipant = requestError.participant;
            updateRowConflicts((current) => ({
              ...current,
              [participant.id]: {
                name: latest.name,
                participant: conflictParticipant,
                message: `${latest.name} was changed in another session. Reload the latest values before editing this row again.`,
              },
            }));
            return "conflict";
          }
          // Reload first: loadRoster clears the panel error when it starts.
          if (requestError.status === 409) await loadRoster();
          setError(requestError.message || `Unable to update ${latest.name}.`);
          return "failed";
        }
      });
    rowMutationQueuesRef.current.set(participant.id, request);
    const result = await request;
    if (rowMutationQueuesRef.current.get(participant.id) === request) {
      rowMutationQueuesRef.current.delete(participant.id);
    }
    return result;
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
    const result = await patchRow(participant, { [field]: value });
    // On failure this restores the authoritative prop; on success patchRow has
    // already replaced that prop with the server-normalized response. A
    // conflict keeps the typed value on screen until the organizer reloads
    // the row.
    if (result !== "conflict") clearRowDraft(participant.id, field, value);
  };

  const bulkTarget = () => {
    if (bulkScope === "selected") return { participantIds: [...selected] };
    if (bulkScope === "group") {
      return { group: bulkGroup === UNGROUPED ? "" : bulkGroup };
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
    if (!bulkApplyGroups && !bulkApplyWeight && !bulkApplyIncluded) {
      setError(
        "Choose a group, weight, included status, or a combination for this bulk update.",
      );
      return;
    }
    if (bulkApplyGroups && bulkGroupAction !== "clear" && !bulkGroupTarget) {
      setError("Choose a group for this bulk update.");
      return;
    }
    const updates = {};
    if (bulkApplyGroups) {
      // "clear" drops every membership (and the every-group flag on the
      // server); "Every group" on top of it re-sets the flag afterwards.
      if (bulkGroupAction === "add") updates.addGroups = [bulkGroupTarget];
      else if (bulkGroupAction === "remove")
        updates.removeGroups = [bulkGroupTarget];
      else if (bulkGroupAction === "replace") updates.group = bulkGroupTarget;
      else updates.group = "";
      if (bulkAllGroups) updates.allGroups = true;
    }
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

  // Group-level changes are bulk patches keyed by the group name (or by the
  // selected people when moving them); the roster reloads afterwards so head
  // counts and shared weights stay true.
  const applyGroupUpdate = async (target, updates, describe, busyKey) => {
    setError("");
    setStatus("");
    setGroupBusy(busyKey);
    try {
      const token = await getToken();
      const data = await patchRosterBulk(
        event.code,
        { ...target, updates, idempotencyKey: crypto.randomUUID() },
        token,
      );
      setStatus(describe(data.updatedCount ?? data.matchedCount ?? 0));
      if (data.resultsRevision !== undefined)
        onResultsInvalidated?.(data.resultsRevision);
      await loadRoster();
      return true;
    } catch (requestError) {
      setError(requestError.message || "Unable to update this group.");
      return false;
    } finally {
      setGroupBusy("");
    }
  };

  const peopleCount = (count) =>
    `${count} ${count === 1 ? "person" : "people"}`;

  const setGroupWeight = (name, weight) =>
    applyGroupUpdate(
      { group: name },
      { weight },
      (count) =>
        `Weight ${weight} now applies to ${peopleCount(count)} in ${name || "Ungrouped"}.`,
      groupFilterValue(name),
    );

  // Groups are rows of their own: creating, renaming and deleting one goes
  // through the group endpoints rather than a bulk patch of its members. The
  // response carries the recounted group stats; anything that changes the
  // cell strings on the rows (a rename or a delete) also reloads the roster.
  const applyGroupRequest = async (
    busyKey,
    request,
    { status: describe, fallback, onSuccess },
  ) => {
    setError("");
    setStatus("");
    setGroupBusy(busyKey);
    try {
      const token = await getToken();
      const data = await request(token);
      setStatus(describe);
      if (Array.isArray(data?.groups))
        setStats((current) => ({ ...current, groups: data.groups }));
      await onSuccess?.(data);
      return true;
    } catch (requestError) {
      setError(requestError.message || fallback);
      return false;
    } finally {
      setGroupBusy("");
    }
  };

  const createGroup = ({ name }) =>
    applyGroupRequest(
      "create",
      (token) => createRosterGroup(event.code, { name }, token),
      {
        status: `Created ${name}.`,
        fallback: `Unable to create ${name}.`,
        onSuccess: async (data) => {
          if (!Array.isArray(data?.groups)) await loadRoster();
        },
      },
    );

  const renameGroup = (entry, nextName) =>
    applyGroupRequest(
      groupFilterValue(entry.name),
      (token) =>
        renameRosterGroup(event.code, entry.id, { name: nextName }, token),
      {
        status: `Renamed ${entry.name} to ${nextName}.`,
        fallback: `Unable to rename ${entry.name}.`,
        onSuccess: async () => {
          // Changing the filter reloads the roster on its own.
          if (group === entry.name) setGroup(nextName);
          else await loadRoster();
        },
      },
    );

  const deleteGroup = (entry) =>
    applyGroupRequest(
      groupFilterValue(entry.name),
      (token) => deleteRosterGroup(event.code, entry.id, token),
      {
        status: `Deleted ${entry.name}.`,
        fallback: `Unable to delete ${entry.name}.`,
        onSuccess: async () => {
          if (group === entry.name) {
            setGroup("");
            setPage(1);
          } else {
            await loadRoster();
          }
        },
      },
    );

  const addSelectedToGroup = (name) =>
    applyGroupUpdate(
      { participantIds: [...selected] },
      { addGroups: [name] },
      (count) => `Added ${peopleCount(count)} to ${name}.`,
      groupFilterValue(name),
    );

  const removeSelectedFromGroup = (name) =>
    applyGroupUpdate(
      { participantIds: [...selected] },
      { removeGroups: [name] },
      (count) => `Removed ${peopleCount(count)} from ${name}.`,
      groupFilterValue(name),
    );

  // Only "" is offered now (Ungroup selected): the server clears every
  // membership and the every-group flag together.
  const moveSelectedToGroup = async (name) => {
    const moved = await applyGroupUpdate(
      { participantIds: [...selected] },
      { group: name },
      (count) =>
        name
          ? `Moved ${peopleCount(count)} to ${name}.`
          : `Removed ${peopleCount(count)} from their groups.`,
      groupFilterValue(name),
    );
    if (moved) updateSelected(new Set());
    return moved;
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
        // Reload first: loadRoster clears the panel error when it starts.
        loadRoster();
        setError(
          "This person now has a full account, so organizer editing is no longer allowed.",
        );
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

  // The reload button only renders while the row's conflict exists.
  const reloadRowConflict = (participantId) => {
    const conflict = rowConflicts[participantId];
    setParticipants((current) => {
      const next = current.map((candidate) =>
        candidate.id === participantId
          ? { ...candidate, ...conflict.participant }
          : candidate,
      );
      participantsRef.current = next;
      return next;
    });
    setRowDrafts((current) => {
      const next = { ...current };
      delete next[participantId];
      return next;
    });
    updateRowConflicts((current) => {
      const next = { ...current };
      delete next[participantId];
      return next;
    });
    setStatus(`Latest values loaded for ${conflict.name}.`);
    // Group head counts and shared weights come from the whole roster.
    void loadRoster();
  };

  const groupSummaries = summarizeGroups(stats.groups);
  const namedGroups = groupSummaries.filter((item) => item.name !== "");
  const groups = groupSummaries.map(({ name }) => ({
    value: groupFilterValue(name),
    label: name === "" ? "Ungrouped" : name,
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

  const readOnlyNote =
    event.status === "closed"
      ? "This roster is read-only while responses are closed. Reactivate the event to make changes."
      : "Reactivate this event before changing its roster.";
  const bulkHint =
    bulkScope === "selected"
      ? selected.size > 0
        ? `${selected.size} participant${selected.size === 1 ? "" : "s"} will be updated.`
        : "Select participants in the list before applying changes."
      : bulkScope === "group"
        ? "Changes apply to everyone in the chosen group."
        : "Changes apply to everyone matching the current filters.";
  const bulkApplyGroupsId = `${controlIds}-bulk-apply-groups`;
  const bulkGroupActionId = `${controlIds}-bulk-group-action`;
  const bulkGroupTargetId = `${controlIds}-bulk-group-target`;
  const bulkAllGroupsId = `${controlIds}-bulk-all-groups`;
  const groupListId = `${controlIds}-group-names`;
  const bulkApplyWeightId = `${controlIds}-bulk-apply-weight`;
  const bulkWeightId = `${controlIds}-bulk-weight`;
  const bulkApplyIncludedId = `${controlIds}-bulk-apply-included`;
  const bulkIncludedId = `${controlIds}-bulk-included`;
  const pageSizeId = `${controlIds}-page-size`;

  return (
    <div
      className={`roster-panel d-flex flex-column gap-3${
        isTrulyEmpty ? " roster-panel--empty" : ""
      }`}
    >
      <Panel
        className="roster-panel__controls"
        headingLevel={3}
        titleId="organizer-roster-heading"
        title="Roster"
        description={
          <span className="stat-row" aria-label="Roster summary">
            <span>
              <strong>{stats.total || 0}</strong>{" "}
              {(stats.total || 0) === 1 ? "person" : "people"}
            </span>
            <span>
              <strong>{stats.submitted || 0}</strong> submitted
            </span>
            <span>
              <strong>{stats.notSubmitted || 0}</strong> awaiting response
            </span>
            <span>
              <strong>{namedGroups.length}</strong>{" "}
              {namedGroups.length === 1 ? "group" : "groups"}
            </span>
          </span>
        }
        actions={
          rosterMutable ? (
            <div
              className="d-flex flex-wrap gap-2"
              role="group"
              aria-label="Roster actions"
            >
              <AppButton
                id="roster-invite-trigger"
                variant={showInvite ? "outlined" : "filled"}
                icon={<InviteIcon />}
                onClick={showInvite ? closeInviteForm : showInviteForm}
                disabled={inviteBusy}
                aria-expanded={showInvite}
                aria-controls="roster-invite-form"
              >
                {showInvite ? "Close invite" : "Invite person"}
              </AppButton>
              <AppButton
                variant="outlined"
                icon={<ImportIcon />}
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
          ) : null
        }
      >
        <div className="d-flex flex-column gap-3">
          {!rosterMutable && (
            <Alert variant="info" role="note" className="roster-panel__note">
              {readOnlyNote}
            </Alert>
          )}

          {inviteNotice && (
            <Alert
              variant="success"
              role="status"
              className="roster-panel__invite-notice"
            >
              {inviteNotice}
            </Alert>
          )}

          {showInvite && rosterMutable && (
            <form
              id="roster-invite-form"
              className="roster-invite-form border rounded p-3 bg-body-tertiary"
              aria-labelledby="roster-invite-title"
              noValidate
              onSubmit={submitInvitation}
            >
              <h4 id="roster-invite-title" className="h5 mb-1">
                Invite someone to respond
              </h4>
              <p className="text-secondary mb-3">
                Add one person and email them a secure link to fill in their
                availability.
              </p>

              <div className="form-row-2">
                <FormField
                  id="roster-invite-name"
                  label="Full name"
                  required
                  error={inviteErrors.name || null}
                  errorId="roster-invite-name-error"
                >
                  <input
                    ref={inviteNameInput}
                    name="name"
                    type="text"
                    className="form-control"
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
                </FormField>

                <FormField
                  id="roster-invite-email"
                  label="Email address"
                  required
                  error={inviteErrors.email || null}
                  errorId="roster-invite-email-error"
                >
                  <input
                    ref={inviteEmailInput}
                    name="email"
                    type="email"
                    className="form-control"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={254}
                    value={inviteEmail}
                    disabled={inviteBusy}
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
                </FormField>
              </div>

              {inviteFormError && (
                <Alert
                  variant="danger"
                  role="alert"
                  className="roster-invite-form__error mt-3"
                >
                  {inviteFormError}
                </Alert>
              )}

              <div className="d-flex flex-wrap justify-content-end gap-2 mt-3">
                <AppButton
                  variant="text"
                  onClick={closeInviteForm}
                  disabled={inviteBusy}
                >
                  Cancel
                </AppButton>
                <AppButton
                  type="submit"
                  icon={<SendIcon />}
                  busy={inviteBusy}
                  disabled={inviteBusy || !inviteAllowed}
                >
                  {inviteBusy
                    ? "Adding and sending…"
                    : "Add and send invitation"}
                </AppButton>
              </div>
            </form>
          )}

          {showRosterTools && (
            <div
              className="roster-panel__filters row g-2"
              role="search"
              aria-label="Roster filters"
            >
              <div className="col-12 col-xxl-6">
                <div className="input-group">
                  <span className="input-group-text" aria-hidden="true">
                    <SearchIcon />
                  </span>
                  <input
                    type="search"
                    className="form-control"
                    aria-label="Search roster"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Search name or email"
                  />
                </div>
              </div>
              <div className="col-12 col-sm-4 col-xxl-2">
                <select
                  className="form-select"
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
              <div className="col-12 col-sm-4 col-xxl-2">
                <select
                  className="form-select"
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
              <div className="col-12 col-sm-4 col-xxl-2">
                <select
                  className="form-select"
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

          {/* Groups can exist before anyone joins them, so the section shows
              whenever the roster has people (to create one) or groups. */}
          {(showRosterTools || groupSummaries.length > 0) && (
            <RosterGroups
              groups={groupSummaries}
              selectedCount={selected.size}
              activeGroup={group}
              readOnly={!rosterMutable}
              busyGroup={groupBusy}
              onShowGroup={(value) => {
                setGroup(value);
                setPage(1);
              }}
              onSetWeight={setGroupWeight}
              onRename={renameGroup}
              onDelete={deleteGroup}
              onAddSelected={addSelectedToGroup}
              onRemoveSelected={removeSelectedFromGroup}
              onMoveSelected={moveSelectedToGroup}
              onCreate={createGroup}
            />
          )}
          {/* Existing group names complete the per-person inputs. */}
          <datalist id={groupListId}>
            {namedGroups.map(({ name }) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          {rosterMutable && hasRosterEntries && (
            <details
              className="disclosure roster-panel__bulk"
              aria-label="Bulk roster actions"
            >
              <summary className="roster-panel__bulk-summary">
                <span className="disclosure__summary-copy">
                  <span className="d-block fw-semibold">Bulk actions</span>
                  <small className="text-secondary">
                    {selected.size} selected · Change groups, weight or
                    inclusion
                  </small>
                </span>
                <span className="disclosure__chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
              </summary>
              <div className="disclosure__content d-flex flex-column gap-3">
                <div className="row g-3">
                  <div className="col-12 col-md-6">
                    <FormField label="Apply to">
                      <select
                        className="form-select"
                        aria-label="Bulk update scope"
                        value={bulkScope}
                        onChange={(event) => setBulkScope(event.target.value)}
                      >
                        <option value="selected">Selected people</option>
                        <option value="filter">
                          Current search and filters
                        </option>
                        <option value="group">One group</option>
                      </select>
                    </FormField>
                  </div>
                  {bulkScope === "group" && (
                    <div className="col-12 col-md-6">
                      <FormField label="Group">
                        <select
                          className="form-select"
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
                      </FormField>
                    </div>
                  )}
                </div>

                <div className="row g-3">
                  <div className="col-12 col-md-4">
                    <fieldset className="roster-panel__bulk-setting">
                      <legend className="fs-6 fw-semibold mb-2">Groups</legend>
                      <div className="d-flex flex-wrap align-items-center gap-3">
                        <div className="form-check mb-0">
                          <input
                            id={bulkApplyGroupsId}
                            className="form-check-input"
                            aria-label="Apply bulk groups"
                            type="checkbox"
                            checked={bulkApplyGroups}
                            onChange={(event) =>
                              setBulkApplyGroups(event.target.checked)
                            }
                          />
                          <label
                            className="form-check-label"
                            htmlFor={bulkApplyGroupsId}
                          >
                            Change groups
                          </label>
                        </div>
                        <div className="d-flex flex-wrap align-items-center gap-2">
                          <select
                            id={bulkGroupActionId}
                            className="form-select form-select-sm w-auto"
                            aria-label="Bulk group action"
                            value={bulkGroupAction}
                            disabled={!bulkApplyGroups}
                            onChange={(event) =>
                              setBulkGroupAction(event.target.value)
                            }
                          >
                            <option value="add">Add to group</option>
                            <option value="remove">Remove from group</option>
                            <option value="replace">Replace with group</option>
                            <option value="clear">
                              Remove from every group
                            </option>
                          </select>
                          <select
                            id={bulkGroupTargetId}
                            className="form-select form-select-sm w-auto"
                            aria-label="Bulk target group"
                            value={bulkGroupTarget}
                            disabled={
                              !bulkApplyGroups || bulkGroupAction === "clear"
                            }
                            onChange={(event) =>
                              setBulkGroupTarget(event.target.value)
                            }
                          >
                            <option value="">Choose group</option>
                            {namedGroups.map(({ name }) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="form-check mb-0">
                          <input
                            id={bulkAllGroupsId}
                            className="form-check-input"
                            aria-label="Bulk every group"
                            type="checkbox"
                            checked={bulkAllGroups}
                            disabled={!bulkApplyGroups}
                            onChange={(event) =>
                              setBulkAllGroups(event.target.checked)
                            }
                          />
                          <label
                            className="form-check-label"
                            htmlFor={bulkAllGroupsId}
                          >
                            Every group
                          </label>
                        </div>
                      </div>
                    </fieldset>
                  </div>

                  <div className="col-12 col-md-4">
                    <fieldset className="roster-panel__bulk-setting">
                      <legend className="fs-6 fw-semibold mb-2">Weight</legend>
                      <div className="d-flex flex-wrap align-items-center gap-3">
                        <div className="form-check mb-0">
                          <input
                            id={bulkApplyWeightId}
                            className="form-check-input"
                            aria-label="Apply bulk weight"
                            type="checkbox"
                            checked={bulkApplyWeight}
                            onChange={(event) =>
                              setBulkApplyWeight(event.target.checked)
                            }
                          />
                          <label
                            className="form-check-label"
                            htmlFor={bulkApplyWeightId}
                          >
                            Change weight
                          </label>
                        </div>
                        <div className="d-flex align-items-center gap-2">
                          <label
                            className="small text-secondary mb-0"
                            htmlFor={bulkWeightId}
                          >
                            Set to
                          </label>
                          <input
                            id={bulkWeightId}
                            className="form-control form-control-sm"
                            style={{ width: "6rem" }}
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
                        </div>
                      </div>
                    </fieldset>
                  </div>

                  <div className="col-12 col-md-4">
                    <fieldset className="roster-panel__bulk-setting">
                      <legend className="fs-6 fw-semibold mb-2">
                        Inclusion
                      </legend>
                      <div className="d-flex flex-wrap align-items-center gap-3">
                        <div className="form-check mb-0">
                          <input
                            id={bulkApplyIncludedId}
                            className="form-check-input"
                            aria-label="Apply bulk included status"
                            type="checkbox"
                            checked={bulkApplyIncluded}
                            onChange={(event) =>
                              setBulkApplyIncluded(event.target.checked)
                            }
                          />
                          <label
                            className="form-check-label"
                            htmlFor={bulkApplyIncludedId}
                          >
                            Change inclusion
                          </label>
                        </div>
                        <div className="d-flex align-items-center gap-2">
                          <span className="small text-secondary">Set to</span>
                          <div className="form-check mb-0">
                            <input
                              id={bulkIncludedId}
                              className="form-check-input"
                              aria-label="Bulk included"
                              type="checkbox"
                              checked={bulkIncluded}
                              disabled={!bulkApplyIncluded}
                              onChange={(event) =>
                                setBulkIncluded(event.target.checked)
                              }
                            />
                            <label
                              className="form-check-label"
                              htmlFor={bulkIncludedId}
                            >
                              Included
                            </label>
                          </div>
                        </div>
                      </div>
                    </fieldset>
                  </div>
                </div>

                <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
                  <p className="roster-panel__bulk-hint small text-secondary mb-0">
                    {bulkHint}
                  </p>
                  <AppButton
                    variant="outlined"
                    icon={<CheckIcon />}
                    onClick={applyBulk}
                    busy={bulkBusy}
                    disabled={bulkBusy || !rosterMutable}
                  >
                    {bulkBusy ? "Applying…" : "Apply update"}
                  </AppButton>
                </div>
              </div>
            </details>
          )}
        </div>
      </Panel>

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

      <Panel className="roster-panel__list" aria-label="Roster entries">
        {loading ? (
          <LoadingState label="Loading roster…" />
        ) : participants.length === 0 ? (
          !showInvite &&
          !showImport &&
          !error && (
            <EmptyState
              icon={hasActiveFilters ? <SearchIcon /> : <GroupIcon />}
              headingLevel={4}
              title={
                hasActiveFilters
                  ? "No matching participants"
                  : "No participants yet"
              }
              actions={
                hasActiveFilters ? (
                  <AppButton variant="text" onClick={clearFilters}>
                    Clear filters
                  </AppButton>
                ) : null
              }
            >
              <p className="mb-0">
                {hasActiveFilters
                  ? "Try a different search or clear the current filters."
                  : rosterMutable
                    ? "Invite someone or import a roster to start collecting availability."
                    : "This event does not have any participants."}
              </p>
            </EmptyState>
          )
        ) : (
          <div className="table-shell">
            {/* The table scrolls sideways on narrow screens, so the wrapper is
                a focusable region for keyboard users. */}
            <div
              className="table-responsive"
              role="region"
              aria-label="Roster participants"
              tabIndex={0}
            >
              <table className="table table-hover align-middle roster-table">
                <caption className="visually-hidden">
                  Roster participants
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        className="form-check-input"
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
                  {participants.map((participant) => {
                    const groupId = `${controlIds}-group-${participant.id}`;
                    const groupHelpId = `${groupId}-help`;
                    const allGroupsId = `${controlIds}-all-groups-${participant.id}`;
                    const weightId = `${controlIds}-weight-${participant.id}`;
                    const includedId = `${controlIds}-included-${participant.id}`;
                    const rowLocked =
                      !rosterMutable || Boolean(rowConflicts[participant.id]);
                    return (
                      <tr
                        className="roster-table__row"
                        key={participant.id}
                        data-roster-participant-id={participant.id}
                      >
                        <td>
                          <input
                            className="form-check-input"
                            aria-label={`Select ${participant.name}`}
                            type="checkbox"
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
                        <th scope="row" className="roster-table__person">
                          <strong className="d-block">
                            {participant.name}
                          </strong>
                          <small className="d-block text-secondary">
                            {participant.email || "No email"} ·{" "}
                            {accountLabel(participant)}
                          </small>
                          <div className="mt-2">
                            {participant.canOrganizerEditAvailability ? (
                              <AppButton
                                variant="outlined"
                                size="sm"
                                icon={<EditIcon />}
                                onClick={() => openEditor(participant)}
                                disabled={!editorAllowed}
                              >
                                Edit schedule
                              </AppButton>
                            ) : (
                              <small className="text-secondary">
                                Self-managed
                              </small>
                            )}
                          </div>
                        </th>
                        <td className="roster-table__settings-cell">
                          <div className="d-flex flex-wrap align-items-end gap-2">
                            <div>
                              <label
                                className="form-label small text-secondary mb-1"
                                htmlFor={groupId}
                              >
                                Groups
                              </label>
                              <input
                                id={groupId}
                                className="form-control form-control-sm"
                                style={{ width: "11rem" }}
                                aria-label={`Groups for ${participant.name}`}
                                aria-describedby={groupHelpId}
                                list={groupListId}
                                placeholder="Ungrouped"
                                value={rowDraftValue(
                                  participant,
                                  "group",
                                  groupValue(participant),
                                )}
                                disabled={rowLocked}
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
                              <small
                                id={groupHelpId}
                                className="d-block text-secondary"
                              >
                                Separate names with ; or type ALL
                              </small>
                            </div>
                            <div className="form-check mb-1">
                              <input
                                id={allGroupsId}
                                className="form-check-input"
                                aria-label={`All groups for ${participant.name}`}
                                type="checkbox"
                                checked={Boolean(participant.allGroups)}
                                disabled={rowLocked}
                                onChange={(event) =>
                                  void patchRow(participant, {
                                    allGroups: event.target.checked,
                                  })
                                }
                              />
                              <label
                                className="form-check-label small"
                                htmlFor={allGroupsId}
                              >
                                Every group
                              </label>
                            </div>
                            <div>
                              <label
                                className="form-label small text-secondary mb-1"
                                htmlFor={weightId}
                              >
                                Weight
                              </label>
                              <input
                                id={weightId}
                                className="form-control form-control-sm"
                                style={{ width: "4.75rem" }}
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
                                disabled={rowLocked}
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
                            </div>
                            <div className="form-check mb-1">
                              <input
                                id={includedId}
                                className="form-check-input"
                                aria-label={`Include ${participant.name}`}
                                type="checkbox"
                                checked={Boolean(participant.included)}
                                disabled={rowLocked}
                                onChange={(event) =>
                                  void patchRow(participant, {
                                    included: event.target.checked,
                                  })
                                }
                              />
                              <label
                                className="form-check-label small"
                                htmlFor={includedId}
                              >
                                Included
                              </label>
                            </div>
                          </div>
                        </td>
                        <td className="roster-table__progress-cell">
                          <div className="d-flex flex-column gap-2 roster-table__progress">
                            <span className="d-flex flex-column align-items-start gap-1">
                              <small className="text-secondary">Response</small>
                              <StatusBadge
                                status={
                                  participant.submitted
                                    ? "submitted"
                                    : "not-submitted"
                                }
                              >
                                {participant.submitted
                                  ? "Submitted"
                                  : "Not submitted"}
                              </StatusBadge>
                            </span>
                            <span className="d-flex flex-column align-items-start gap-1">
                              <small className="text-secondary">Invite</small>
                              <StatusBadge
                                status={deliveryStatusVariant(participant)}
                              >
                                {deliveryLabel(participant)}
                              </StatusBadge>
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {showPagination && (
          <div className="pagination-row roster-panel__pagination">
            <div className="d-flex align-items-center gap-2">
              <label
                className="pagination-row__count mb-0"
                htmlFor={pageSizeId}
              >
                Rows per page
              </label>
              <select
                id={pageSizeId}
                className="form-select form-select-sm w-auto"
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
            </div>
            <div className="d-flex flex-wrap align-items-center gap-2">
              <AppButton
                variant="outlined"
                size="sm"
                icon={<ChevronLeftIcon />}
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </AppButton>
              <span className="pagination-row__count">
                Page {pagination.page || page} of {pagination.pages || 1}
              </span>
              <AppButton
                variant="outlined"
                size="sm"
                icon={<ChevronRightIcon />}
                disabled={page >= (pagination.pages || 1) || loading}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </AppButton>
            </div>
          </div>
        )}
      </Panel>

      {status && (
        <Alert
          variant="success"
          role="status"
          className="roster-panel__message roster-panel__message--status"
        >
          {status}
        </Alert>
      )}
      {Object.entries(rowConflicts).map(([participantId, conflict]) => (
        <Alert
          key={participantId}
          variant="danger"
          role="alert"
          className="roster-panel__message roster-panel__message--error"
          actions={
            <AppButton
              variant="outlined"
              icon={<RefreshIcon />}
              onClick={() => reloadRowConflict(participantId)}
            >
              Reload latest participant
            </AppButton>
          }
        >
          <p className="mb-0">{conflict.message}</p>
        </Alert>
      ))}
      {error && (
        <Alert
          variant="danger"
          role="alert"
          className="roster-panel__message roster-panel__message--error"
        >
          {error}
        </Alert>
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
