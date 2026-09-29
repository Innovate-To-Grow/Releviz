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
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import EmptyState from "@/components/ui/EmptyState";
import FormField from "@/components/ui/FormField";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import Panel from "@/components/ui/Panel";
import { startingBrushValue } from "@/components/ui/Availability";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GroupIcon,
  ImportIcon,
  SearchIcon,
} from "@/components/ui/icons";
import { ManagedScheduleDrawer } from "@/components/schedule/OrganizerPanels";
import RosterImportWizard from "@/components/schedule/RosterImportWizard";
import EmailSendDialog from "@/components/schedule/email/EmailSendDialog";
import AddPersonPanel from "@/components/schedule/participants/AddPersonPanel";
import {
  DeadlineBanner,
  LeftOutBanner,
  ReadOnlyBanner,
} from "@/components/schedule/participants/Banners";
import EmailMenu from "@/components/schedule/participants/EmailMenu";
import {
  FilterButton,
  FilterChips,
} from "@/components/schedule/participants/FilterPopover";
import GroupFilterButton from "@/components/schedule/participants/GroupFilterButton";
import GroupPicker from "@/components/schedule/participants/GroupPicker";
import ManageGroupsPanel from "@/components/schedule/participants/ManageGroupsPanel";
import ParticipantTable from "@/components/schedule/participants/ParticipantTable";
import PersonPanel from "@/components/schedule/participants/PersonPanel";
import SelectionBar from "@/components/schedule/participants/SelectionBar";
import SendInvitationsDialog from "@/components/schedule/participants/SendInvitationsDialog";
import {
  ToastRegion,
  useToasts,
} from "@/components/schedule/participants/Toasts";
import { sendReminders } from "@/lib/api/events";
import {
  createManagedParticipant,
  joinEvent,
  updateParticipant,
} from "@/lib/api/participants";
import {
  createRosterGroup,
  deleteRosterGroup,
  deleteRosterParticipant,
  fetchRoster,
  fetchRosterSchedule,
  includeOnlyRosterGroup,
  patchRosterBulk,
  patchRosterParticipant,
  renameRosterGroup,
  sendRosterInvitations,
} from "@/lib/api/roster";
import {
  activeRosterFilter,
  countsLine,
  filterChips,
  formatWeight,
  groupNameError,
  groupPanelRows,
  invitationToast,
  mixedPickerState,
  peopleCount,
  pickerStateFromRows,
  reminderNextAt,
} from "@/lib/participants";
import { rosterImportStatusMessage } from "@/lib/roster-import-status";

const EMPTY_STATS = { total: 0, submitted: 0, notSubmitted: 0, groups: [] };
const EMPTY_PAGINATION = { page: 1, pageSize: 50, total: 0, pages: 1 };
// How often a passed deadline is noticed without a reload.
const DEADLINE_CHECK_MS = 60000;
// Bulk changes to more people than fit on one page are confirmed first.
const BULK_CONFIRM_ABOVE = 25;

const OWNED_RESPONSE_CODES = new Set([
  "organizer_edit_participant_owned",
  "organizer_edit_full_account", // legacy backend during a split release
]);

function ownedResponseMessage(name) {
  return `${name} now manages their own response, so you can no longer edit their schedule.`;
}

function conflictMessage(name) {
  return `${name} was changed in another session, so your change wasn't saved. The latest values are shown.`;
}

// The person panel keeps its draft on a conflict, so there its Save is the
// "apply again".
function panelConflictMessage(name) {
  return `${name} was changed in another session, so your change wasn't saved. Save again to apply it on top of the latest values.`;
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

function reminderDeliveryRequest(data) {
  if (data?.deliveryRequest) return data.deliveryRequest;
  if (!data?.deliveryRequestId) return null;
  return {
    id: data.deliveryRequestId,
    operation: "reminder",
    recipientCount: data.recipientCount,
    delivery: data.delivery,
  };
}

// The counts the send dialog shows, from a preview reply, with the email
// the first recipient would get and who that is.
function previewFromResponse(data) {
  const skipped = data?.skipped || {};
  return {
    willSend: data?.willSend ?? 0,
    alreadyInvited: skipped.alreadyInvited ?? 0,
    noEmail: skipped.noEmail ?? 0,
    inFlight: skipped.inFlight ?? 0,
    organizer: skipped.organizer ?? 0,
    total: data?.requestedCount ?? 0,
    email: data?.email ?? null,
    sample: data?.sample ?? null,
  };
}

// The reminder dialog's lines: who gets one now and who was already
// reminded for this deadline (each only when there is someone), and who a
// run never emails.
function ReminderSummary({ wouldEnqueue, alreadyReminded }) {
  return (
    <div className="d-flex flex-column gap-2">
      <ul className="list-unstyled d-flex flex-column gap-2 mb-0 participants-send-summary">
        {wouldEnqueue > 0 && (
          <li>
            {wouldEnqueue === 1
              ? "1 invited person who hasn't submitted will get a reminder"
              : `${wouldEnqueue} invited people who haven't submitted will get a reminder`}
          </li>
        )}
        {alreadyReminded > 0 && (
          <li>
            {alreadyReminded === 1
              ? "1 was already reminded for this deadline and is skipped"
              : `${alreadyReminded} were already reminded for this deadline and are skipped`}
          </li>
        )}
      </ul>
      <p className="small text-secondary mb-0">
        People never invited, people without an email, and you are skipped.
      </p>
    </div>
  );
}

const reminders = (count) =>
  `${count} ${count === 1 ? "reminder" : "reminders"}`;

// What a reminder run did, in the dialog's terms. The run's request also
// lists people already reminded for this deadline (its `recipientCount`),
// whose existing reminder is reused, so the count queued is `enqueued` and
// the rest were skipped.
function reminderResultMessage(data) {
  const queued = Number(data?.enqueued) || 0;
  const skipped = Number(data?.deduplicated) || 0;
  const message = `Queued ${reminders(queued)}.`;
  return skipped > 0
    ? `${message} Skipped ${skipped} already reminded.`
    : message;
}

function participantFromSchedule(data, slotCount) {
  const summary = data.participant || {};
  const schedule = data.schedule || {};
  const participantId = summary.memberId || summary.member_id || summary.id;
  return {
    ...summary,
    id: participantId,
    rosterId: summary.id,
    rowVersion: summary.version,
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

function sameArrays(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutKey(object, key) {
  if (!Object.hasOwn(object, key)) return object;
  const next = { ...object };
  delete next[key];
  return next;
}

// The delivery card sits above the workspace sections.
function scrollToDelivery() {
  document
    .querySelector(".organizer-workspace__delivery")
    ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

const RosterPanel = forwardRef(function RosterPanel(
  {
    event,
    setEvent,
    getToken,
    onResultsInvalidated,
    onDeliveryRequestChange,
    onEditDeadline,
  },
  forwardedRef,
) {
  const [participants, setParticipants] = useState([]);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [stats, setStats] = useState(EMPTY_STATS);
  // Whole-list counts (never filtered) for the summary line, the banners
  // and the Email menu; null until a listing carries them.
  const [overall, setOverall] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [invitationStatus, setInvitationStatus] = useState("");
  const [included, setIncluded] = useState("");
  // Explicit ids survive paging; select-all mode means everyone matching
  // the filter, however many pages that is.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectAllMode, setSelectAllMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  // Whether the organizer answers as a participant too; null until loaded.
  const [organizerOnRoster, setOrganizerOnRoster] = useState(null);
  // The clock the deadline banner is judged against.
  const [now, setNow] = useState(() => Date.now());
  // One side panel at a time: null | { type: "person", id, participant }
  // | { type: "add" } | { type: "groups" } | { type: "import" }.
  const [openPanel, setOpenPanel] = useState(null);
  // Rows whose last change hit a newer version, shaped
  // { [participantId]: { message, updates } }; the row shows the latest
  // values with Apply again / Dismiss.
  const [rowConflicts, setRowConflicts] = useState({});
  const [personBusy, setPersonBusy] = useState(false);
  // { selector, preview, resend, resendPreview, busy, error,
  // clearSelection, onSettled } while open.
  const [sendDialog, setSendDialog] = useState(null);
  // { preview, busy, error } while open: `preview` is the reminders
  // preview reply, with its counts, `email` and `sample`.
  const [reminderDialog, setReminderDialog] = useState(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  // { title, groups, state, counts, resolve?, onApply? } while open.
  const [groupPicker, setGroupPicker] = useState(null);
  const [newGroup, setNewGroup] = useState(null);
  const [bulkConfirm, setBulkConfirm] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [groupsBusyKey, setGroupsBusyKey] = useState("");
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [addingSelf, setAddingSelf] = useState(false);
  const [countingEveryone, setCountingEveryone] = useState(false);
  const [editor, setEditor] = useState(null);
  const [editorInperson, setEditorInperson] = useState([]);
  const [editorVirtual, setEditorVirtual] = useState([]);
  // The drawer brush starts opposite to the event's starting level, matching
  // what participants see in their own editor.
  const startingBrush = startingBrushValue(event);
  const [editorValue, setEditorValue] = useState(startingBrush);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorStatus, setEditorStatus] = useState("");
  const [editorSaved, setEditorSaved] = useState(false);
  const [editorConflict, setEditorConflict] = useState(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [draftConfirmOpen, setDraftConfirmOpen] = useState(false);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const requestNumber = useRef(0);
  // The whole-roster digest the last listing carried, for the workspace's
  // live sync to compare against its activity poll. Null until loaded.
  const activityRef = useRef(null);
  const participantsRef = useRef(participants);
  const statsRef = useRef(stats);
  const searchRef = useRef("");
  const rowMutationQueuesRef = useRef(new Map());
  // Counts the group stats this session took from its own changes. A
  // listing requested before one of them carries older groups, so it keeps
  // the groups on screen, as a reload never moves a row backwards either.
  const groupsEpochRef = useRef(0);
  const sectionRef = useRef(null);
  const headingRef = useRef(null);
  // The import sheet's outcome, shown as a toast once the sheet closes.
  const importResultRef = useRef("");
  const controlIds = useId();

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  const filters = useMemo(
    () => ({ search, group, submitted, invitationStatus, included }),
    [group, included, invitationStatus, search, submitted],
  );

  // Group stats a change of this session returned: newer than any listing
  // already in flight.
  const applyGroupStats = useCallback((groups) => {
    groupsEpochRef.current += 1;
    setStats((current) => ({ ...current, groups }));
  }, []);

  // A silent load (the workspace's live sync) swaps the page in place: the
  // table stays mounted so focus, selection, open panels and drafts
  // survive, and a failure is reported to the caller instead of the panel.
  const loadRoster = useCallback(
    async (providedToken, { throwOnError = false, silent = false } = {}) => {
      const currentRequest = ++requestNumber.current;
      const groupsEpoch = groupsEpochRef.current;
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const token =
          providedToken === undefined ? await getToken() : providedToken;
        const data = await fetchRoster(
          event.code,
          { page, pageSize, ...filters },
          token,
        );
        if (currentRequest !== requestNumber.current) return null;
        activityRef.current = data.activity || null;
        // A row this session already holds at a newer version (a change that
        // landed while the listing was in flight) keeps its values: a reload
        // never moves a row backwards.
        const previous = participantsRef.current;
        const nextParticipants = (data.participants || []).map((loaded) => {
          const held = previous.find((candidate) => candidate.id === loaded.id);
          return held && Number(held.version) > Number(loaded.version)
            ? held
            : loaded;
        });
        participantsRef.current = nextParticipants;
        setParticipants(nextParticipants);
        const nextPagination = data.pagination || {
          page,
          pageSize,
          total: 0,
          pages: 1,
        };
        setPagination(nextPagination);
        const loadedStats = data.stats || EMPTY_STATS;
        setStats(
          groupsEpoch === groupsEpochRef.current
            ? loadedStats
            : (current) => ({ ...loadedStats, groups: current.groups }),
        );
        setOverall(data.overall || null);
        if (typeof data.organizerOnRoster === "boolean")
          setOrganizerOnRoster(data.organizerOnRoster);
        setLoaded(true);
        setError("");
        setNow(Date.now());
        // A page past the end (people removed elsewhere) falls back to the
        // last one, which the page change reloads.
        const pages = Number(nextPagination.pages || 0);
        if (pages > 0 && page > pages) setPage(pages);
        const recoveredDelivery =
          data.latestDeliveryRequest ||
          data.deliveryRequest ||
          data.deliveryRequests?.[0];
        if (recoveredDelivery) onDeliveryRequestChange?.(recoveredDelivery);
        return data;
      } catch (requestError) {
        if (!silent && currentRequest === requestNumber.current) {
          setError(
            requestError.message || "Unable to load the participant list.",
          );
        }
        if (throwOnError) throw requestError;
        return null;
      } finally {
        if (currentRequest === requestNumber.current) setLoading(false);
      }
    },
    [event.code, filters, getToken, onDeliveryRequestChange, page, pageSize],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectAllMode(false);
  }, []);

  // Filter changes start from page one and drop a selection of "everyone
  // matching", since that no longer means the same people.
  const applyFilters = useCallback((patch) => {
    if (Object.hasOwn(patch, "group")) setGroup(patch.group);
    if (Object.hasOwn(patch, "submitted")) setSubmitted(patch.submitted);
    if (Object.hasOwn(patch, "invitationStatus"))
      setInvitationStatus(patch.invitationStatus);
    if (Object.hasOwn(patch, "included")) setIncluded(patch.included);
    setPage(1);
    setSelectAllMode(false);
  }, []);

  const clearSearch = useCallback(() => {
    searchRef.current = "";
    setSearchInput("");
    setSearch("");
  }, []);

  const clearFilters = useCallback(() => {
    clearSearch();
    applyFilters({
      group: "",
      submitted: "",
      invitationStatus: "",
      included: "",
    });
  }, [applyFilters, clearSearch]);

  const showFailedInvitations = useCallback(() => {
    clearSearch();
    applyFilters({
      group: "",
      submitted: "",
      invitationStatus: "failed",
      included: "",
    });
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    headingRef.current?.focus?.({ preventScroll: true });
  }, [applyFilters, clearSearch]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      refresh: (token, { silent = false } = {}) =>
        loadRoster(token, { throwOnError: true, silent }),
      activity: () => activityRef.current,
      showFailedInvitations,
    }),
    [loadRoster, showFailedInvitations],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      if (next === searchRef.current) return;
      searchRef.current = next;
      setSearch(next);
      setPage(1);
      setSelectAllMode(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(loadRoster, 0);
    return () => clearTimeout(timer);
  }, [loadRoster]);

  const active = event.status === "active";
  const deadlineAt = event.responseDeadline
    ? Date.parse(event.responseDeadline)
    : NaN;
  const deadlinePassed =
    active && Number.isFinite(deadlineAt) && deadlineAt <= now;
  const mutable = active && !deadlinePassed;

  useEffect(() => {
    if (!active || !Number.isFinite(deadlineAt)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), DEADLINE_CHECK_MS);
    return () => clearInterval(timer);
  }, [active, deadlineAt]);

  // Leaving the active state closes everything that could change the list.
  useEffect(() => {
    if (active) return;
    setOpenPanel(null);
    setSendDialog(null);
    setReminderDialog(null);
    setGroupPicker(null);
    setNewGroup(null);
    setBulkConfirm(null);
    setRemoveTarget(null);
    setSelectedIds(new Set());
    setSelectAllMode(false);
    setRowConflicts({});
    setEditor(null);
    setEditorInperson([]);
    setEditorVirtual([]);
    setEditorValue(startingBrush);
    setEditorError("");
    setEditorStatus("");
    setEditorSaved(false);
    setEditorConflict(null);
    setDiscardConfirmOpen(false);
    setDraftConfirmOpen(false);
  }, [active, startingBrush]);

  const replaceRow = (participantId, patch) => {
    setParticipants((current) => {
      const next = current.map((candidate) =>
        candidate.id === participantId ? { ...candidate, ...patch } : candidate,
      );
      participantsRef.current = next;
      return next;
    });
    // A panel opened for someone the page does not list (from the create
    // reply, say) follows the change too, so its version stays current.
    setOpenPanel((current) =>
      current?.type === "person" && current.id === participantId
        ? {
            ...current,
            participant: {
              ...current.participant,
              ...patch,
              id: current.participant.id,
            },
          }
        : current,
    );
  };

  const clearConflict = (participantId) =>
    setRowConflicts((current) => withoutKey(current, participantId));

  // Every change to one row goes through here, one at a time per row and
  // always against the version this session holds. A newer version on the
  // server replaces the row with what it now holds and marks the conflict
  // on the row (Apply again / Dismiss) unless the caller keeps the change
  // itself, as the person panel does.
  const patchRow = async (
    participant,
    updates,
    { markConflict = true } = {},
  ) => {
    const previous =
      rowMutationQueuesRef.current.get(participant.id) || Promise.resolve();
    const request = previous
      .catch(() => {})
      .then(async () => {
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
          replaceRow(participant.id, updated);
          clearConflict(participant.id);
          if (data.resultsRevision !== undefined)
            onResultsInvalidated?.(data.resultsRevision);
          // The server recounts the groups so their shared weights stay true
          // without reloading the whole page of people.
          if (Array.isArray(data.groups)) applyGroupStats(data.groups);
          return { status: "saved", data, name: latest.name };
        } catch (requestError) {
          if (requestError.status === 409 && requestError.participant) {
            replaceRow(participant.id, requestError.participant);
            if (markConflict) {
              setRowConflicts((current) => ({
                ...current,
                [participant.id]: {
                  message: conflictMessage(latest.name),
                  updates,
                },
              }));
            }
            return { status: "conflict", name: latest.name };
          }
          // Reload first: loadRoster clears the panel error when it starts.
          if (requestError.status === 409) await loadRoster();
          return {
            status: "failed",
            name: latest.name,
            message: requestError.message || `Unable to update ${latest.name}.`,
          };
        }
      });
    rowMutationQueuesRef.current.set(participant.id, request);
    const result = await request;
    if (rowMutationQueuesRef.current.get(participant.id) === request) {
      rowMutationQueuesRef.current.delete(participant.id);
    }
    return result;
  };

  const toastSuccess = (message, action = null) =>
    pushToast({ tone: "success", message, action });
  const toastFailure = (message) => pushToast({ tone: "danger", message });

  // Selection ------------------------------------------------------------

  const toggleSelect = (participantId, checked) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(participantId);
      else next.delete(participantId);
      return next;
    });
    if (!checked) setSelectAllMode(false);
  };

  const togglePage = (checked) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      participants.forEach((participant) => {
        if (checked) next.add(participant.id);
        else next.delete(participant.id);
      });
      return next;
    });
    if (!checked) setSelectAllMode(false);
  };

  const selectedCount = selectAllMode
    ? Number(pagination.total || 0)
    : selectedIds.size;
  const notOnPage = [...selectedIds].filter(
    (participantId) =>
      !participants.some((participant) => participant.id === participantId),
  ).length;

  const selectionSelector = () =>
    selectAllMode
      ? { filter: activeRosterFilter(filters) }
      : { participantIds: [...selectedIds] };

  // Bulk changes -----------------------------------------------------------

  const runBulk = async (target, updates, describe) => {
    setBulkBusy(true);
    try {
      const token = await getToken();
      const data = await patchRosterBulk(
        event.code,
        { ...target, updates, idempotencyKey: crypto.randomUUID() },
        token,
      );
      toastSuccess(describe(data.updatedCount ?? data.matchedCount ?? 0));
      if (data.resultsRevision !== undefined)
        onResultsInvalidated?.(data.resultsRevision);
      await loadRoster();
      return true;
    } catch (requestError) {
      toastFailure(requestError.message || "Unable to apply this change.");
      return false;
    } finally {
      setBulkBusy(false);
    }
  };

  // A change to the selection: confirmed first when it reaches beyond a
  // page's worth of people.
  const runSelectionBulk = (updates, describe) => {
    const action = () => runBulk(selectionSelector(), updates, describe);
    if (selectAllMode || selectedCount > BULK_CONFIRM_ABOVE) {
      setBulkConfirm({ count: selectedCount, action });
    } else void action();
  };

  const confirmBulk = async () => {
    const { action } = bulkConfirm;
    setBulkConfirm(null);
    await action();
  };

  const namedGroups = useMemo(
    () =>
      (stats.groups || []).filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.id !== null &&
          entry.id !== undefined &&
          entry.name !== "",
      ),
    [stats.groups],
  );
  const groupRows = useMemo(() => groupPanelRows(stats.groups), [stats.groups]);

  // Group names for the bulk endpoint, read from the latest stats so a group
  // created inside the picker is known too.
  const groupNamesFor = (ids = []) =>
    ids
      .map(
        (groupId) =>
          (statsRef.current.groups || []).find((entry) => entry.id === groupId)
            ?.name,
      )
      .filter(Boolean);

  const bulkGroupUpdates = ({ addGroupIds, removeGroupIds, allGroups }) => {
    const updates = {};
    const addGroups = groupNamesFor(addGroupIds);
    const removeGroups = groupNamesFor(removeGroupIds);
    if (addGroups.length) updates.addGroups = addGroups;
    if (removeGroups.length) updates.removeGroups = removeGroups;
    if (typeof allGroups === "boolean") updates.allGroups = allGroups;
    return updates;
  };

  const openSelectionGroupPicker = () => {
    const rows = participants.filter((participant) =>
      selectedIds.has(participant.id),
    );
    const picker = selectAllMode
      ? { state: mixedPickerState(namedGroups), counts: null }
      : pickerStateFromRows(rows, namedGroups);
    setGroupPicker({
      title: `Groups for ${selectedCount} selected people`,
      groups: namedGroups.map(({ id, name }) => ({ id, name })),
      state: picker.state,
      counts: picker.counts,
      onApply: (result) =>
        runSelectionBulk(
          bulkGroupUpdates(result),
          (count) => `Updated groups for ${peopleCount(count)}.`,
        ),
    });
  };

  // Invitations ----------------------------------------------------------

  // Fills the open send dialog's preview for `selector`: the plain one, or
  // the one that emails the already-invited again too. A reply for a
  // dialog that has since closed or moved on is dropped.
  const loadSendPreview = async (selector, resend) => {
    const patch = (changes) =>
      setSendDialog((current) =>
        current && current.selector === selector
          ? { ...current, ...changes }
          : current,
      );
    try {
      const token = await getToken();
      const data = await sendRosterInvitations(
        event.code,
        { ...selector, preview: true, resend },
        token,
      );
      patch({
        [resend ? "resendPreview" : "preview"]: previewFromResponse(data),
      });
    } catch (requestError) {
      patch({
        error: requestError.message || "Unable to check who can be invited.",
      });
    }
  };

  // Opens the send dialog for a selection (`participantIds` or `filter`)
  // and previews who would be emailed, and with what, before anything is
  // sent. `onSettled` hears whether the invitations went out (true) or the
  // dialog closed without sending them (false).
  const openSendDialog = (
    selector,
    { clearSelection: clear = false, onSettled = null } = {},
  ) => {
    setSendDialog({
      selector,
      preview: null,
      resend: false,
      resendPreview: null,
      busy: false,
      error: "",
      clearSelection: clear,
      onSettled,
    });
    void loadSendPreview(selector, false);
  };

  // `Email them again too` shows the email the first person would get with
  // the already-invited counted in; that preview is asked for once.
  const changeResend = (resend) => {
    const { selector, resendPreview } = sendDialog;
    setSendDialog((current) => ({ ...current, resend, error: "" }));
    if (resend && !resendPreview) void loadSendPreview(selector, true);
  };

  const closeSendDialog = (sent) => {
    sendDialog?.onSettled?.(sent);
    setSendDialog(null);
  };

  const confirmSend = async ({ resend }) => {
    const { selector, clearSelection: clear } = sendDialog;
    setSendDialog((current) => ({ ...current, busy: true, error: "" }));
    try {
      const token = await getToken();
      const data = await sendRosterInvitations(
        event.code,
        { ...selector, resend, idempotencyKey: crypto.randomUUID() },
        token,
      );
      toastSuccess(invitationToast(data), {
        label: "View progress",
        onClick: scrollToDelivery,
      });
      if (data.deliveryRequest?.recipientCount > 0) {
        onDeliveryRequestChange?.(data.deliveryRequest);
      }
      closeSendDialog(true);
      if (clear) clearSelection();
      await loadRoster();
    } catch (requestError) {
      if (requestError.status === 429) {
        closeSendDialog(false);
        toastFailure(
          "Too many invitation requests. Try again in a few minutes.",
        );
        return;
      }
      setSendDialog((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: requestError.message || "Unable to send invitations.",
            }
          : current,
      );
    }
  };

  const previewReminders = async () => {
    if (reminderBusy) return;
    setReminderBusy(true);
    try {
      const token = await getToken();
      const data = await sendReminders(event.code, { preview: true }, token);
      // The preview's count ignores the reminders setting, but a run with
      // reminders off queues nobody, so it is not offered. An older reply
      // without the flag defers to the event on screen.
      if (!(data?.remindersEnabled ?? event.remindersEnabled)) {
        pushToast({
          tone: "warning",
          sticky: true,
          message:
            "Reminders are off for this event, so nobody would be emailed. Turn them on in the event settings first.",
        });
        return;
      }
      setReminderDialog({ preview: data, busy: false, error: "" });
    } catch (requestError) {
      toastFailure(
        requestError.message || "Unable to check who can be reminded.",
      );
    } finally {
      setReminderBusy(false);
    }
  };

  // A failed run keeps the dialog open on its confirmation, with the error.
  const confirmReminders = async () => {
    setReminderDialog((current) => ({ ...current, busy: true, error: "" }));
    try {
      const token = await getToken();
      const data = await sendReminders(
        event.code,
        { idempotencyKey: crypto.randomUUID() },
        token,
      );
      const request = reminderDeliveryRequest(data);
      onDeliveryRequestChange?.(request);
      toastSuccess(reminderResultMessage(data));
      setReminderDialog(null);
    } catch (requestError) {
      setReminderDialog((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: requestError.message || "Unable to queue reminders.",
            }
          : current,
      );
    }
  };

  // Groups -----------------------------------------------------------------

  const runGroupAction = async (busyKey, action) => {
    setGroupsBusyKey(busyKey);
    try {
      return await action();
    } finally {
      setGroupsBusyKey("");
    }
  };

  // Creating a group answers with the new group and the recounted stats.
  const createGroup = async (name) => {
    const token = await getToken();
    const data = await createRosterGroup(event.code, { name }, token);
    if (Array.isArray(data?.groups)) applyGroupStats(data.groups);
    else await loadRoster();
    toastSuccess(`Created group ${name}.`);
    return (
      data?.group ||
      data?.groups?.find((entry) => entry.name === name) || { id: null, name }
    );
  };

  const renameGroup = async (entry, nextName) => {
    const token = await getToken();
    const data = await renameRosterGroup(
      event.code,
      entry.id,
      { name: nextName },
      token,
    );
    if (Array.isArray(data?.groups)) applyGroupStats(data.groups);
    toastSuccess(`Renamed ${entry.name} to ${nextName}.`);
    // Changing the filter reloads the roster on its own.
    if (group === entry.name) setGroup(nextName);
    else await loadRoster();
    return true;
  };

  const deleteGroup = async (entry) => {
    const token = await getToken();
    const data = await deleteRosterGroup(event.code, entry.id, token);
    if (Array.isArray(data?.groups)) applyGroupStats(data.groups);
    toastSuccess(`Deleted ${entry.name}.`);
    if (group === entry.name) applyFilters({ group: "" });
    else await loadRoster();
    return true;
  };

  // Group-wide weight and counting are bulk patches keyed by the group name
  // ("" for the people in no group); the roster reloads afterwards so head
  // counts and shared values stay true.
  const groupBulk = async (entry, updates, describe) => {
    const token = await getToken();
    const data = await patchRosterBulk(
      event.code,
      {
        group: entry.id === null ? "" : entry.name,
        updates,
        idempotencyKey: crypto.randomUUID(),
      },
      token,
    );
    toastSuccess(describe(data.updatedCount ?? data.matchedCount ?? 0));
    if (data.resultsRevision !== undefined)
      onResultsInvalidated?.(data.resultsRevision);
    await loadRoster();
    return true;
  };

  const countOnlyGroup = async (entry) => {
    const token = await getToken();
    const data = await includeOnlyRosterGroup(event.code, entry.id, token);
    if (Array.isArray(data?.groups)) applyGroupStats(data.groups);
    toastSuccess(`Only ${entry.name} counts in the results now.`);
    if (data?.resultsRevision !== undefined)
      onResultsInvalidated?.(data.resultsRevision);
    await loadRoster();
    return true;
  };

  const selectGroupPeople = (entry) => {
    setOpenPanel(null);
    applyFilters({ group: entry.name });
    setSelectedIds(new Set());
    setSelectAllMode(true);
  };

  const groupBusyKeyFor = (prefix, entry) =>
    `${prefix}:${entry.id === null ? "ungrouped" : entry.id}`;

  const openNewGroup = () => {
    if (!mutable) return;
    setNewGroup({ name: "", error: "", busy: false });
  };

  const submitNewGroup = async (submitEvent) => {
    submitEvent.preventDefault();
    const message = groupNameError(newGroup.name);
    if (message) {
      setNewGroup((current) => ({ ...current, error: message }));
      return;
    }
    setNewGroup((current) => ({ ...current, busy: true, error: "" }));
    try {
      await createGroup(newGroup.name.trim());
      setNewGroup(null);
    } catch (requestError) {
      setNewGroup((current) => ({
        ...current,
        busy: false,
        error: requestError.message || "Unable to create this group.",
      }));
    }
  };

  const countEveryone = async () => {
    setCountingEveryone(true);
    try {
      const token = await getToken();
      const data = await patchRosterBulk(
        event.code,
        {
          filter: { all: true },
          updates: { included: true },
          idempotencyKey: crypto.randomUUID(),
        },
        token,
      );
      toastSuccess("Everyone counts in the results again.");
      if (data.resultsRevision !== undefined)
        onResultsInvalidated?.(data.resultsRevision);
      await loadRoster();
    } catch (requestError) {
      toastFailure(requestError.message || "Unable to change the results.");
    } finally {
      setCountingEveryone(false);
    }
  };

  // Rows -------------------------------------------------------------------

  const openPerson = (participant) =>
    setOpenPanel({ type: "person", id: participant.id, participant });

  const reportRowResult = (result, onSaved) => {
    if (result.status === "saved") onSaved(result);
    else if (result.status === "failed") toastFailure(result.message);
  };

  const toggleIncluded = async (participant) => {
    const nextIncluded = !participant.included;
    const result = await patchRow(participant, { included: nextIncluded });
    reportRowResult(result, ({ name }) =>
      toastSuccess(
        nextIncluded
          ? `${name} now counts in the results.`
          : `${name} is left out of the results.`,
      ),
    );
  };

  // Re-runs the change a conflict stopped, against the version now shown.
  const applyAgain = async (participant) => {
    const conflict = rowConflicts[participant.id];
    if (!conflict) return;
    clearConflict(participant.id);
    const result = await patchRow(participant, conflict.updates);
    reportRowResult(result, ({ name }) => toastSuccess(`${name} was updated.`));
  };

  // The panel commits its draft only when the save landed: on a conflict it
  // keeps the typed values, stays unsaved, and its next Save runs against
  // the version the row now holds.
  const savePerson = async (participant, updates) => {
    setPersonBusy(true);
    try {
      const result = await patchRow(participant, updates, {
        markConflict: false,
      });
      if (result.status === "failed") throw new Error(result.message);
      if (result.status === "conflict")
        throw new Error(panelConflictMessage(result.name));
      if (result.status === "saved") {
        if (updates.email) {
          toastSuccess("Saved. The new address hasn't been invited yet.", {
            label: "Send invitation",
            onClick: () => openSendDialog({ participantIds: [participant.id] }),
          });
        } else toastSuccess("Saved.");
      }
    } finally {
      setPersonBusy(false);
    }
  };

  // The person panel's group picker: resolves with the diff to apply to the
  // panel's draft, or null when the picker is closed without applying.
  const openPersonGroupPicker = (participant, state) =>
    new Promise((resolve) => {
      setGroupPicker({
        title: `Groups for ${participant.name}`,
        groups: namedGroups.map(({ id, name }) => ({ id, name })),
        state,
        counts: null,
        resolve,
      });
    });

  const closeGroupPicker = (result = null) => {
    const picker = groupPicker;
    setGroupPicker(null);
    picker?.resolve?.(result);
    if (result) picker?.onApply?.(result);
  };

  // Add people ---------------------------------------------------------------

  const addPerson = async ({
    name,
    email,
    phone,
    organizerManaged,
    sendInvitation,
    idempotencyKey,
  }) => {
    let data;
    try {
      const token = await getToken();
      data = await createManagedParticipant(
        event.code,
        {
          name,
          email,
          phone,
          organizerManaged,
          idempotencyKey,
          sendInvitation,
        },
        token,
      );
    } catch (requestError) {
      if (requestError.event) setEvent?.(requestError.event);
      if (
        requestError.errorCode === "event_not_active" ||
        requestError.event?.status === "closed"
      ) {
        throw new Error(
          "This event is closed. Reactivate it before adding participants.",
        );
      }
      throw new Error(requestError.message || "Unable to add this person.");
    }
    const added = data.participant || null;
    if (!added?.id) throw new Error("The participant was added without an ID.");
    onResultsInvalidated?.();
    const autoInvitedCount = data.autoInvitedCount || 0;
    const nextDeliveryRequest = invitationDeliveryRequest(data);
    if (nextDeliveryRequest && autoInvitedCount > 0) {
      onDeliveryRequestChange?.(nextDeliveryRequest);
    }
    setPage(1);
    await loadRoster();
    return {
      participant: await rosterRowFor(added),
      alreadyExisted: data.created === false && !data.restored,
      autoInvited: autoInvitedCount > 0,
    };
  };

  // The create reply describes the member (its id is the member's, and it
  // carries none of the roster-only fields), so the person handed back to
  // the add panel is their roster row: the one on the reloaded page, or
  // else the one the schedule endpoint reads by member id.
  const rosterRowFor = async (added) => {
    const listed = participantsRef.current.find(
      (row) => row.memberId === added.id,
    );
    if (listed) return listed;
    try {
      const token = await getToken();
      const data = await fetchRosterSchedule(event.code, added.id, token);
      return data.participant || added;
    } catch {
      // They were added; the reply stands in until the row is listed.
      return added;
    }
  };

  // Schedule drawer ----------------------------------------------------------

  const openEditor = async (participant) => {
    try {
      const token = await getToken();
      const data = await fetchRosterSchedule(event.code, participant.id, token);
      // The organizer's own row is theirs to answer, never someone else's.
      if (
        data.participant?.canOrganizerEditAvailability === false &&
        !data.participant?.isOrganizer
      ) {
        // Claimed since the roster loaded.
        void loadRoster();
        toastFailure(ownedResponseMessage(participant.name));
        return;
      }
      const loaded = participantFromSchedule(data, event.slotCount || 0);
      setOpenPanel(null);
      setEditor(loaded);
      setEditorInperson(loaded.inpersonArray);
      setEditorVirtual(loaded.virtualArray);
      setEditorValue(startingBrush);
      setEditorError("");
      setEditorStatus("");
      setEditorSaved(false);
      setEditorConflict(null);
    } catch (requestError) {
      toastFailure(
        requestError.message ||
          `Unable to load ${participant.name}'s schedule.`,
      );
    }
  };

  // The organizer joins their own event like any participant; their row then
  // opens straight in the schedule editor.
  const addMyself = async () => {
    if (addingSelf) return;
    setAddingSelf(true);
    try {
      const token = await getToken();
      const data = await joinEvent(event.code, token);
      onResultsInvalidated?.();
      await loadRoster();
      if (data?.participant?.id) {
        toastSuccess("You're on the list. Your schedule is open.");
        await openEditor({
          id: data.participant.id,
          name: data.participant.name || "You",
        });
      } else toastSuccess("You're on the list.");
    } catch (requestError) {
      toastFailure(
        requestError.message || "Unable to add you as a participant.",
      );
    } finally {
      setAddingSelf(false);
    }
  };

  const closeEditor = () => {
    // The drawer also fires onClose for Escape while a dialog of its own is
    // open; ignore those so one keypress closes only the dialog.
    if (discardConfirmOpen || draftConfirmOpen) return;
    const dirty =
      editor &&
      (!sameArrays(editorInperson, editor.inpersonArray) ||
        !sameArrays(editorVirtual, editor.virtualArray));
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setEditor(null);
    setEditorConflict(null);
  };

  const discardEditorChanges = () => {
    setDiscardConfirmOpen(false);
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
          // The organizer's own name comes from their account.
          ...(editor.isOrganizer ? {} : { name: editor.name }),
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
      setEditorInperson(updated.inpersonArray);
      setEditorVirtual(updated.virtualArray);
      setEditorStatus(submit ? "Schedule submitted." : "Draft saved.");
      setEditorSaved(true);
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
        OWNED_RESPONSE_CODES.has(requestError.errorCode || requestError.code)
      ) {
        const name = editor.name;
        setEditor(null);
        setDiscardConfirmOpen(false);
        void loadRoster();
        toastFailure(ownedResponseMessage(name));
      } else {
        setEditorError(requestError.message || "Unable to save this schedule.");
      }
    } finally {
      setEditorSaving(false);
    }
  };

  // Saving a submitted response as a draft takes it out of the results, so
  // that is confirmed first.
  const requestSaveDraft = () => {
    if (editor?.submitted) setDraftConfirmOpen(true);
    else void saveEditor(false);
  };

  const reloadConflict = () => {
    if (!editorConflict) return;
    setEditor(editorConflict);
    setEditorInperson(editorConflict.inpersonArray);
    setEditorVirtual(editorConflict.virtualArray);
    setEditorConflict(null);
    setEditorError("");
    setEditorStatus("Latest response loaded.");
  };

  const editorRow = editor
    ? participants.find((candidate) => candidate.id === editor.rosterId)
    : null;
  const editorLeftOut = Boolean(
    editor &&
    (editorRow ? editorRow.included === false : editor.included === false),
  );
  const editorOwn = Boolean(editor?.isOrganizer);
  const editorResponsesOpen = active && !(deadlinePassed && editorOwn);

  const countEditorIn = async () => {
    if (!editor) return;
    const row = editorRow || {
      id: editor.rosterId,
      name: editor.name,
      version: editor.rowVersion,
    };
    const result = await patchRow(row, { included: true });
    reportRowResult(result, ({ name }) => {
      setEditor((current) =>
        current ? { ...current, included: true } : current,
      );
      toastSuccess(`${name} now counts in the results.`);
    });
  };

  // Removal ------------------------------------------------------------------

  const confirmRemove = async () => {
    const target = removeTarget;
    if (!target || removeBusy) return;
    setRemoveBusy(true);
    try {
      const token = await getToken();
      const data = await deleteRosterParticipant(event.code, target.id, token);
      setRemoveTarget(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
      clearConflict(target.id);
      setOpenPanel((current) =>
        current?.type === "person" && current.id === target.id ? null : current,
      );
      if (Array.isArray(data?.groups)) applyGroupStats(data.groups);
      onResultsInvalidated?.(data?.resultsRevision);
      await loadRoster();
      toastSuccess(`${target.name} was removed from the event.`);
    } catch (requestError) {
      setRemoveTarget(null);
      toastFailure(requestError.message || `Unable to remove ${target.name}.`);
    } finally {
      setRemoveBusy(false);
    }
  };

  // Import -------------------------------------------------------------------

  const handleImportCommitted = (data) => {
    const receipt = data?.receipt || {};
    if (receipt.mode === "rebuild") clearSelection();
    if (data?.event) setEvent?.(data.event);
    const nextDeliveryRequest = invitationDeliveryRequest(data);
    if (nextDeliveryRequest) onDeliveryRequestChange?.(nextDeliveryRequest);
    importResultRef.current = rosterImportStatusMessage({
      receipt,
      autoInvitedCount: data?.autoInvitedCount,
      sendInvitations: data?.sendInvitations,
    });
    setPage(1);
    void loadRoster();
    onResultsInvalidated?.();
  };

  const closeImport = () => {
    setOpenPanel(null);
    if (importResultRef.current) {
      toastSuccess(importResultRef.current);
      importResultRef.current = "";
    }
  };

  // Layout -------------------------------------------------------------------

  const reminderCount = Number(reminderDialog?.preview?.wouldEnqueue ?? 0);
  const reminderSample =
    reminderDialog?.preview?.sample?.name ||
    reminderDialog?.preview?.sample?.email;
  const total = Number(overall?.total ?? stats.total ?? 0);
  const chips = filterChips(filters);
  const hasActiveFilters = chips.length > 0;
  const trulyEmpty = loaded && !hasActiveFilters && total === 0;
  const showToolbar = loaded && !trulyEmpty;
  const showPagination =
    loaded && !loading && Number(pagination.total || 0) > 25;
  const lockReason = !active
    ? "Responses are closed, so this list is read-only."
    : deadlinePassed
      ? "The response deadline has passed, so people can't be added, invited or changed."
      : "";
  const summary = countsLine({
    total,
    shown: Number(pagination.total || 0),
    submitted: Number(overall?.submitted ?? stats.submitted ?? 0),
    notSubmitted: Number(overall?.notSubmitted ?? stats.notSubmitted ?? 0),
    groups: namedGroups.length,
    filtering: hasActiveFilters,
  });
  const excludedCount = Number(overall?.excluded ?? stats.excluded ?? 0);
  const panelPerson =
    openPanel?.type === "person"
      ? participants.find((candidate) => candidate.id === openPanel.id) ||
        openPanel.participant
      : null;
  const panelIndex = panelPerson
    ? participants.findIndex((candidate) => candidate.id === panelPerson.id)
    : -1;
  const panelPosition =
    panelIndex >= 0 ? { index: panelIndex, total: participants.length } : null;
  const movePerson = (step) => {
    const next = participants[panelIndex + step];
    if (next) openPerson(next);
  };
  const pageSizeId = `${controlIds}-page-size`;

  const removeChip = (key) => {
    if (key === "search") clearSearch();
    else applyFilters({ [key]: "" });
  };

  const listBody = !loaded ? (
    loading ? (
      <LoadingState label="Loading participants…" />
    ) : null
  ) : trulyEmpty ? (
    <EmptyState
      icon={<GroupIcon />}
      headingLevel={4}
      title="No participants yet"
      actions={
        mutable ? (
          <>
            <AppButton onClick={() => setOpenPanel({ type: "add" })}>
              + Add person
            </AppButton>
            <AppButton
              variant="outlined"
              icon={<ImportIcon />}
              onClick={() => setOpenPanel({ type: "import" })}
            >
              Import a spreadsheet
            </AppButton>
            {organizerOnRoster === false && (
              <AppButton
                variant="outlined"
                busy={addingSelf}
                disabled={addingSelf}
                onClick={() => void addMyself()}
              >
                Add myself
              </AppButton>
            )}
          </>
        ) : null
      }
    >
      {mutable ? (
        <>
          <p className="mb-2">
            Add people one at a time or import a list. Nobody is emailed until
            you invite them.
          </p>
          <p className="mb-0 small text-secondary">
            Setting up groups first?{" "}
            <button
              type="button"
              className="btn btn-link btn-sm p-0 align-baseline"
              onClick={() => setOpenPanel({ type: "groups" })}
            >
              Create a group
            </button>
          </p>
        </>
      ) : (
        <p className="mb-0">This event does not have any participants.</p>
      )}
    </EmptyState>
  ) : participants.length === 0 ? (
    <EmptyState
      icon={<SearchIcon />}
      headingLevel={4}
      title="No matching participants."
    >
      <p className="mb-0">
        Try another search, or{" "}
        <button
          type="button"
          className="btn btn-link btn-sm p-0 align-baseline"
          onClick={clearFilters}
        >
          Clear all
        </button>
      </p>
    </EmptyState>
  ) : (
    <ParticipantTable
      participants={participants}
      selectedIds={selectedIds}
      selectAllMode={selectAllMode}
      total={Number(pagination.total || 0)}
      conflicts={rowConflicts}
      readOnly={!mutable}
      onToggleSelect={toggleSelect}
      onTogglePage={togglePage}
      onSelectAllMatching={() => setSelectAllMode(true)}
      onOpen={openPerson}
      onEditSchedule={(participant) => void openEditor(participant)}
      onSendInvitation={(participant) =>
        openSendDialog({ participantIds: [participant.id] })
      }
      onToggleIncluded={(participant) => void toggleIncluded(participant)}
      onRemove={setRemoveTarget}
      onApplyAgain={(participant) => void applyAgain(participant)}
      onDismissConflict={(participant) => clearConflict(participant.id)}
    />
  );

  return (
    <div
      ref={sectionRef}
      className="participants-section d-flex flex-column gap-3"
    >
      <Panel
        className="participants-panel"
        headingLevel={3}
        titleId="organizer-roster-heading"
        headingRef={headingRef}
        headingProps={{ tabIndex: -1 }}
        title="Participants"
        description={summary}
        actions={
          <div
            className="d-flex flex-wrap gap-2"
            role="group"
            aria-label="Participant actions"
          >
            {mutable && (
              <EmailMenu
                notInvitedCount={Number(overall?.notInvited ?? 0)}
                remindCount={Number(overall?.remindable ?? 0)}
                reminders={{
                  enabled: Boolean(event.remindersEnabled),
                  nextAt: reminderNextAt(event, now),
                  timezone: event.timezone,
                }}
                disabled={reminderBusy}
                onInviteAll={() =>
                  openSendDialog({ filter: { invitationStatus: "not_sent" } })
                }
                onSendReminders={() => void previewReminders()}
              />
            )}
            <AppButton
              variant="outlined"
              icon={<ImportIcon />}
              disabled={!mutable}
              title={lockReason || undefined}
              onClick={() => setOpenPanel({ type: "import" })}
            >
              Import
            </AppButton>
            <AppButton
              disabled={!mutable}
              title={lockReason || undefined}
              onClick={() => setOpenPanel({ type: "add" })}
            >
              + Add person
            </AppButton>
          </div>
        }
      >
        <div className="d-flex flex-column gap-3">
          {!active && <ReadOnlyBanner />}
          {deadlinePassed && (
            <DeadlineBanner
              deadline={event.responseDeadline}
              timezone={event.timezone}
              onEdit={onEditDeadline}
            />
          )}
          {loaded && excludedCount > 0 && (
            <LeftOutBanner
              count={excludedCount}
              busy={countingEveryone}
              readOnly={!mutable}
              onShow={() => applyFilters({ included: "false" })}
              onCountEveryone={() => void countEveryone()}
            />
          )}

          {showToolbar && (
            <div
              className="participants-toolbar"
              role="search"
              aria-label="Participant filters"
            >
              <div className="input-group participants-toolbar__search">
                <span className="input-group-text" aria-hidden="true">
                  <SearchIcon />
                </span>
                <input
                  type="search"
                  className="form-control"
                  aria-label="Search participants"
                  placeholder="Search name, email, phone or group"
                  value={searchInput}
                  onChange={(changeEvent) =>
                    setSearchInput(changeEvent.target.value)
                  }
                />
              </div>
              <GroupFilterButton
                value={group}
                groups={namedGroups}
                everyoneCount={total}
                noGroupCount={groupRows.ungrouped.count}
                onChange={(value) => applyFilters({ group: value })}
                onNewGroup={openNewGroup}
                onManageGroups={() => setOpenPanel({ type: "groups" })}
              />
              <FilterButton
                value={{ submitted, invitationStatus, included }}
                onChange={(next) => applyFilters(next)}
              />
            </div>
          )}
          {showToolbar && (
            <FilterChips
              chips={chips}
              onRemove={removeChip}
              onClearAll={clearFilters}
            />
          )}

          {error && (
            <Alert
              variant="danger"
              role="alert"
              actions={
                <AppButton
                  variant="outlined"
                  size="sm"
                  onClick={() => void loadRoster()}
                >
                  Try again
                </AppButton>
              }
            >
              {error}
            </Alert>
          )}

          <div
            className="participants-list"
            aria-busy={loading && loaded ? "true" : undefined}
          >
            {listBody}
            {showPagination && (
              <div className="pagination-row participants-pagination">
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
                    onChange={(changeEvent) => {
                      setPageSize(Number(changeEvent.target.value));
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
          </div>

          {selectedCount > 0 && (
            <SelectionBar
              count={selectedCount}
              mode={selectAllMode ? "all" : "page"}
              notOnPage={selectAllMode ? 0 : notOnPage}
              busy={bulkBusy}
              readOnly={!mutable}
              onClear={clearSelection}
              onSendInvitation={() =>
                openSendDialog(selectionSelector(), { clearSelection: true })
              }
              onGroups={openSelectionGroupPicker}
              onSetWeight={(weight) =>
                runSelectionBulk(
                  { weight },
                  (count) =>
                    `Set weight ${formatWeight(weight)} for ${peopleCount(count)}.`,
                )
              }
              onCountIn={() =>
                runSelectionBulk(
                  { included: true },
                  (count) => `${peopleCount(count)} now count in the results.`,
                )
              }
              onLeaveOut={() =>
                runSelectionBulk(
                  { included: false },
                  (count) => `Left ${peopleCount(count)} out of the results.`,
                )
              }
            />
          )}
        </div>
      </Panel>

      <ToastRegion toasts={toasts} onDismiss={dismissToast} />

      {panelPerson && (
        <PersonPanel
          participant={panelPerson}
          groups={namedGroups.map(({ id, name }) => ({ id, name }))}
          position={panelPosition}
          onPrev={() => movePerson(-1)}
          onNext={() => movePerson(1)}
          busy={personBusy}
          conflict={
            rowConflicts[panelPerson.id]
              ? { message: rowConflicts[panelPerson.id].message }
              : null
          }
          readOnly={!active}
          deadlinePassed={deadlinePassed}
          dialogOpen={Boolean(removeTarget || sendDialog)}
          onSave={(updates) => savePerson(panelPerson, updates)}
          onClose={() => setOpenPanel(null)}
          onEditSchedule={(participant) => void openEditor(participant)}
          onSendInvitation={(participant) =>
            openSendDialog({ participantIds: [participant.id] })
          }
          onRemove={setRemoveTarget}
          onOpenGroupPicker={(state) =>
            openPersonGroupPicker(panelPerson, state)
          }
        />
      )}

      {openPanel?.type === "add" && (
        <AddPersonPanel
          addMyselfAvailable={organizerOnRoster === false}
          readOnly={!mutable}
          dialogOpen={Boolean(sendDialog)}
          onAdd={addPerson}
          onOpenPerson={openPerson}
          onEnterSchedule={(participant) => void openEditor(participant)}
          onAddMyself={() => void addMyself()}
          onSendInvitation={(participant) =>
            new Promise((resolve) =>
              openSendDialog(
                { participantIds: [participant.id] },
                { onSettled: resolve },
              ),
            )
          }
          onClose={() => setOpenPanel(null)}
        />
      )}

      {openPanel?.type === "groups" && (
        <ManageGroupsPanel
          groups={groupRows.groups}
          ungrouped={groupRows.ungrouped}
          totals={{ total }}
          busyKey={groupsBusyKey}
          readOnly={!mutable}
          onSetWeight={(entry, weight) =>
            runGroupAction(groupBusyKeyFor("weight", entry), () =>
              groupBulk(
                entry,
                { weight },
                (count) =>
                  `Set weight ${formatWeight(weight)} for ${peopleCount(count)}.`,
              ),
            )
          }
          onSetIncluded={(entry, nextIncluded) =>
            runGroupAction(groupBusyKeyFor("included", entry), () =>
              groupBulk(entry, { included: nextIncluded }, (count) =>
                nextIncluded
                  ? `${peopleCount(count)} now count in the results.`
                  : `Left ${peopleCount(count)} out of the results.`,
              ),
            )
          }
          onCountOnly={(entry) =>
            runGroupAction(groupBusyKeyFor("countOnly", entry), () =>
              countOnlyGroup(entry),
            )
          }
          onDelete={(entry) =>
            runGroupAction(groupBusyKeyFor("delete", entry), () =>
              deleteGroup(entry),
            )
          }
          onRename={(entry, nextName) =>
            runGroupAction(groupBusyKeyFor("rename", entry), () =>
              renameGroup(entry, nextName),
            )
          }
          onCreate={(name) => runGroupAction("create", () => createGroup(name))}
          onSelectPeople={selectGroupPeople}
          onClose={() => setOpenPanel(null)}
        />
      )}

      {openPanel?.type === "import" && (
        <RosterImportWizard
          event={event}
          getToken={getToken}
          onEventChange={setEvent}
          onCommitted={handleImportCommitted}
          onSendInvitations={(participantIds) =>
            openSendDialog({ participantIds })
          }
          onClose={closeImport}
        />
      )}

      {groupPicker && (
        <GroupPicker
          title={groupPicker.title}
          groups={groupPicker.groups}
          state={groupPicker.state}
          counts={groupPicker.counts}
          busy={bulkBusy}
          onApply={(result) => closeGroupPicker(result)}
          onClose={() => closeGroupPicker(null)}
          onCreateGroup={createGroup}
        />
      )}

      {sendDialog && (
        <SendInvitationsDialog
          preview={sendDialog.preview}
          resendPreview={sendDialog.resendPreview}
          resend={sendDialog.resend}
          onResendChange={changeResend}
          error={sendDialog.error}
          busy={sendDialog.busy}
          onConfirm={confirmSend}
          onClose={() => {
            if (!sendDialog.busy) closeSendDialog(false);
          }}
        />
      )}

      {reminderDialog && (
        <EmailSendDialog
          title="Send reminders"
          recipientCount={reminderCount}
          recipientsSummary={
            <ReminderSummary
              wouldEnqueue={reminderCount}
              alreadyReminded={Number(
                reminderDialog.preview?.alreadyReminded ?? 0,
              )}
            />
          }
          email={reminderDialog.preview?.email ?? null}
          emailNote={
            reminderSample
              ? `Shown for ${reminderSample}. Each person gets their own private link.`
              : null
          }
          error={reminderDialog.error}
          busy={reminderDialog.busy}
          confirmTitle={
            reminderCount === 1
              ? "Remind 1 invited person who hasn't submitted?"
              : `Remind ${reminderCount} invited people who haven't submitted?`
          }
          confirmBody={
            <p className="mb-0">
              Emails go out right away and can&apos;t be recalled. Anyone
              already reminded since the deadline was set isn&apos;t emailed
              again.
            </p>
          }
          sendLabel={`Send ${reminders(reminderCount)}`}
          emptyMessage="Nobody needs a reminder right now."
          onConfirm={confirmReminders}
          onClose={() => {
            if (!reminderDialog.busy) setReminderDialog(null);
          }}
        />
      )}

      {newGroup && (
        <Modal
          as="form"
          size="sm"
          title="New group"
          busy={newGroup.busy}
          noValidate
          onClose={() => {
            if (!newGroup.busy) setNewGroup(null);
          }}
          onSubmit={(submitEvent) => void submitNewGroup(submitEvent)}
          footer={
            <>
              <AppButton
                variant="text"
                disabled={newGroup.busy}
                onClick={() => setNewGroup(null)}
              >
                Cancel
              </AppButton>
              <AppButton
                type="submit"
                busy={newGroup.busy}
                disabled={newGroup.busy}
              >
                Create
              </AppButton>
            </>
          }
        >
          <FormField label="Group name" error={newGroup.error || null}>
            <input
              type="text"
              className="form-control"
              maxLength={100}
              value={newGroup.name}
              disabled={newGroup.busy}
              data-autofocus
              onChange={(changeEvent) =>
                setNewGroup((current) => ({
                  ...current,
                  name: changeEvent.target.value,
                  error: "",
                }))
              }
            />
          </FormField>
        </Modal>
      )}

      {bulkConfirm && (
        <ConfirmDialog
          title={`Apply to ${peopleCount(bulkConfirm.count)}?`}
          confirmLabel="Apply"
          onConfirm={() => void confirmBulk()}
          onClose={() => setBulkConfirm(null)}
        >
          <p className="mb-0">
            This changes everyone selected, including people not on this page.
          </p>
        </ConfirmDialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Remove ${removeTarget.name} from the event?`}
          confirmLabel="Remove person"
          busy={removeBusy}
          onConfirm={() => void confirmRemove()}
          onClose={() => {
            if (!removeBusy) setRemoveTarget(null);
          }}
        >
          <p>
            Their schedule, group memberships and invitation are deleted, and
            any invitation link already sent stops working. This cannot be
            undone.
          </p>
          <p className="mb-0 text-secondary">
            To keep their answers but leave them out of the results, use Leave
            out of results instead.
          </p>
        </ConfirmDialog>
      )}

      <ManagedScheduleDrawer
        event={event}
        mode={event.mode || "inperson"}
        participant={editor}
        inperson={editorInperson}
        virtual={editorVirtual}
        availabilityValue={editorValue}
        onAvailabilityValueChange={setEditorValue}
        responsesOpen={editorResponsesOpen}
        lockReason={
          active && editorOwn && deadlinePassed
            ? "The response deadline has passed, so your own answers can't change."
            : undefined
        }
        leftOut={editorLeftOut}
        countInAllowed={mutable}
        saved={editorSaved}
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
        onCountIn={() => void countEditorIn()}
        onSaveDraft={requestSaveDraft}
        onSubmit={() => void saveEditor(true)}
        onReloadLatest={reloadConflict}
        onClose={closeEditor}
      />

      {draftConfirmOpen && editor && (
        <ConfirmDialog
          title="Save as a draft?"
          confirmLabel="Save as draft"
          onConfirm={() => {
            setDraftConfirmOpen(false);
            void saveEditor(false);
          }}
          onClose={() => setDraftConfirmOpen(false)}
        >
          <p className="mb-0">
            This takes {editor.name}&apos;s answers out of the results until you
            submit again.
          </p>
        </ConfirmDialog>
      )}

      {discardConfirmOpen && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          onConfirm={discardEditorChanges}
          onClose={() => setDiscardConfirmOpen(false)}
        >
          <p className="mb-0">
            You have unsaved changes to this participant&apos;s schedule.
            Discard them?
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
});

export default RosterPanel;
