"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";
import useAutosaveNavigationGuard from "@/components/schedule/useAutosaveNavigationGuard";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import {
  AvailabilityChoice,
  availabilityLabel,
  startingAvailabilityValue,
  startingBrushValue,
} from "@/components/ui/Availability";
import BrandLogo from "@/components/ui/BrandLogo";
import LoadingState from "@/components/ui/LoadingState";
import {
  RefreshIcon,
  SendIcon,
  SignOutIcon,
  TimezoneIcon,
  UpgradeIcon,
} from "@/components/ui/icons";
import PageHeader from "@/components/ui/PageHeader";
import Panel from "@/components/ui/Panel";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  fetchTempAccessSession,
  logoutTempAccess,
  openTempAccess,
  updateTempAccessParticipant,
} from "@/lib/api/tempAccess";
import { navigateTo, replaceUrl } from "@/lib/navigation";

function invitationStorageKey(code) {
  return `releviz.temp-access.invitation:${code}`;
}

function readStoredInvitation(code) {
  try {
    return window.sessionStorage.getItem(invitationStorageKey(code)) || "";
  } catch {
    return "";
  }
}

function storeInvitation(code, token) {
  try {
    window.sessionStorage.setItem(invitationStorageKey(code), token);
  } catch {
    // The token remains in component memory when session storage is unavailable.
  }
}

function forgetInvitation(code) {
  try {
    window.sessionStorage.removeItem(invitationStorageKey(code));
  } catch {
    // Nothing else is persisted locally.
  }
}

function unwrapAccessPayload(payload = {}) {
  const session =
    payload.session && typeof payload.session === "object"
      ? payload.session
      : {};
  return {
    event: payload.event || session.event || null,
    participant: payload.participant || session.participant || null,
    email: payload.email || session.email || "",
  };
}

function scheduleLength(event, participant) {
  if (Number.isInteger(event?.slotCount) && event.slotCount >= 0)
    return event.slotCount;
  const largestIndex = (event?.slotGroups || []).reduce(
    (largest, group) =>
      Math.max(
        largest,
        ...(group?.slots || []).map((slot) =>
          Number.isInteger(slot?.index) ? slot.index : -1,
        ),
      ),
    -1,
  );
  return Math.max(
    largestIndex + 1,
    participant?.availabilityInperson?.length || 0,
    participant?.availabilityVirtual?.length || 0,
  );
}

function normalizedSchedule(values, length) {
  return Array.from({ length }, (_, index) => Number(values?.[index] || 0));
}

const BLOCKED_SLOTS_NOTE =
  "Grey striped times are blocked by the organizer and do not apply to this event.";
const OPEN_THROTTLED_MESSAGE =
  "Too many attempts. Wait a moment and try again.";
const OPEN_FAILED_MESSAGE =
  "We could not open your invitation. Check your connection and try again.";
const SESSION_EXPIRED_MESSAGE =
  "This temporary session has expired. Open the link in your invitation email again to continue.";
const NO_INVITATION = { code: "", token: "" };

// Organizer-blocked slots keep their index but never take availability: the
// grid refuses to paint them, and bulk fills leave them at 0.
function blockedSlotIndices(slotGroups) {
  const blocked = new Set();
  for (const group of slotGroups || []) {
    for (const slot of group?.slots || []) {
      if (slot?.blocked) blocked.add(slot.index);
    }
  }
  return blocked;
}

function makeUpgradeHref(eventCode) {
  const next = `/event?code=${encodeURIComponent(eventCode)}`;
  const params = new URLSearchParams({
    upgrade: "temporary",
    code: eventCode,
    next,
  });
  return `/signup?${params.toString()}`;
}

export default function TempAccessClient() {
  const searchParams = useSearchParams();
  const eventCode = (searchParams.get("code") || "").trim();
  const urlInvitation = (searchParams.get("invitation") || "").trim();

  const [phase, setPhase] = useState(urlInvitation ? "opening" : "loading");
  const [openError, setOpenError] = useState("");
  const [openAttempt, setOpenAttempt] = useState(0);
  const [access, setAccess] = useState(null);
  // The brush starts opposite to the event's starting level so people paint
  // over the times that differ from the default.
  const startingBrush = startingBrushValue(access?.event);
  const [availabilityValue, setAvailabilityValue] = useState(startingBrush);
  // Once the session loads (or the setting changes) the brush follows it.
  const [brushBaseline, setBrushBaseline] = useState(startingBrush);
  if (brushBaseline !== startingBrush) {
    setBrushBaseline(startingBrush);
    setAvailabilityValue(startingBrush);
  }
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState("idle");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState(null);
  const [conflictReloadPending, setConflictReloadPending] = useState(false);
  const [serverWriteLock, setServerWriteLock] = useState("");
  const [sessionEndMessage, setSessionEndMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [upgradePending, setUpgradePending] = useState(false);
  const [responseDeadlinePassed, setResponseDeadlinePassed] = useState(false);

  const participantVersionRef = useRef(null);
  const scheduleInpersonRef = useRef([]);
  const scheduleVirtualRef = useRef([]);
  const draftDirtyRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const autosaveInFlightRef = useRef(null);
  const autosavePendingRef = useRef(false);
  const autosaveRunnerRef = useRef(null);
  const draftSaveStateRef = useRef("idle");
  // Keeps the token when session storage is unavailable, so a retry or the
  // re-render after the URL is stripped still opens the same invitation.
  const invitationRef = useRef(NO_INVITATION);
  const openStartedRef = useRef("");

  const applyParticipant = useCallback(
    (participant, event = access?.event) => {
      if (!participant || !event) return;
      const length = scheduleLength(event, participant);
      const inperson = normalizedSchedule(
        participant.availabilityInperson,
        length,
      );
      const virtual = normalizedSchedule(
        participant.availabilityVirtual,
        length,
      );
      participantVersionRef.current = participant.version;
      scheduleInpersonRef.current = inperson;
      scheduleVirtualRef.current = virtual;
      draftDirtyRef.current = false;
      autosavePendingRef.current = false;
      setScheduleInperson(inperson);
      setScheduleVirtual(virtual);
      setSubmitted(Boolean(participant.submitted));
      setDraftSaveState(participant.submitted ? "submitted" : "saved");
      setDraftSaveError("");
      setSaveConflict(null);
      setConflictReloadPending(false);
      setAccess((current) => (current ? { ...current, participant } : current));
    },
    [access?.event],
  );

  const applyAccessPayload = useCallback((payload) => {
    const next = unwrapAccessPayload(payload);
    if (!next.event || !next.participant) {
      throw new Error("Temporary access response is incomplete.");
    }
    const length = scheduleLength(next.event, next.participant);
    const inperson = normalizedSchedule(
      next.participant.availabilityInperson,
      length,
    );
    const virtual = normalizedSchedule(
      next.participant.availabilityVirtual,
      length,
    );
    participantVersionRef.current = next.participant.version;
    scheduleInpersonRef.current = inperson;
    scheduleVirtualRef.current = virtual;
    draftDirtyRef.current = false;
    autosavePendingRef.current = false;
    setScheduleInperson(inperson);
    setScheduleVirtual(virtual);
    setSubmitted(Boolean(next.participant.submitted));
    setDraftSaveState(next.participant.submitted ? "submitted" : "saved");
    setDraftSaveError("");
    setSaveConflict(null);
    setConflictReloadPending(false);
    setServerWriteLock("");
    setSessionEndMessage("");
    setAccess(next);
    setPhase("access");
  }, []);

  const endTemporaryAccess = useCallback((message) => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    draftDirtyRef.current = false;
    autosavePendingRef.current = false;
    draftSaveStateRef.current = "idle";
    setAccess(null);
    setDraftSaveState("idle");
    setDraftSaveError("");
    setSaveConflict(null);
    setConflictReloadPending(false);
    setServerWriteLock("");
    setSessionEndMessage(message);
    setPhase("session-ended");
  }, []);

  const reconcileRejectedWrite = useCallback(
    async (error) => {
      const accountUpgraded =
        error.status === 403 &&
        (error.errorCode === "temp_account_upgraded" ||
          (!error.errorCode && /full access/i.test(error.message || "")));
      if (error.status === 401 || accountUpgraded) {
        endTemporaryAccess(
          accountUpgraded
            ? "This account now has full access. Sign in with the full account to continue."
            : SESSION_EXPIRED_MESSAGE,
        );
        return;
      }

      // A lifecycle or exclusion denial is authoritative even if refreshing the
      // latest payload fails. Lock first so the page cannot keep queuing writes.
      setServerWriteLock(
        error.message || "This response can no longer be changed.",
      );

      try {
        const payload = await fetchTempAccessSession(eventCode);
        applyAccessPayload(payload);
        setServerWriteLock(
          error.message || "This response can no longer be changed.",
        );
        return;
      } catch (sessionError) {
        if (sessionError.status === 401 || sessionError.status === 403) {
          endTemporaryAccess(
            error.status === 403
              ? "This temporary access is no longer active. Sign in with the full account or open the link in your invitation email again."
              : SESSION_EXPIRED_MESSAGE,
          );
          return;
        }
      }

      setDraftSaveState("failed");
      setDraftSaveError(
        error.message || "This response can no longer be changed.",
      );
    },
    [applyAccessPayload, endTemporaryAccess, eventCode],
  );

  useEffect(() => {
    if (!eventCode) {
      return;
    }

    const remembered =
      invitationRef.current.code === eventCode
        ? invitationRef.current.token
        : "";
    const token =
      urlInvitation || readStoredInvitation(eventCode) || remembered;
    if (urlInvitation) {
      storeInvitation(eventCode, urlInvitation);
      const url = new URL(window.location.href);
      url.searchParams.delete("invitation");
      replaceUrl(`${url.pathname}${url.search}${url.hash}`);
    }
    let active = true;
    async function start() {
      // An explicit (or just-stored) invitation represents an identity choice.
      // Never let an older same-event cookie silently replace that identity.
      if (token) {
        // React re-runs this effect (Strict Mode, and again once the URL is
        // stripped), so one attempt for one link must send one request. Only
        // the request that still owns this key may touch state, and it does
        // not depend on this run staying mounted.
        const requestKey = `${eventCode}:${token}:${openAttempt}`;
        if (openStartedRef.current === requestKey) return;
        openStartedRef.current = requestKey;
        invitationRef.current = { code: eventCode, token };
        setPhase("opening");
        try {
          const payload = await openTempAccess({
            code: eventCode,
            invitationToken: token,
          });
          if (openStartedRef.current !== requestKey) return;
          applyAccessPayload(payload);
          forgetInvitation(eventCode);
          invitationRef.current = NO_INVITATION;
        } catch (error) {
          if (openStartedRef.current !== requestKey) return;
          if (error.status === 404) {
            setPhase("inactive");
            return;
          }
          setOpenError(
            error.status === 429 ? OPEN_THROTTLED_MESSAGE : OPEN_FAILED_MESSAGE,
          );
          setPhase("open-failed");
        }
        return;
      }

      try {
        const payload = await fetchTempAccessSession(eventCode);
        if (!active) return;
        applyAccessPayload(payload);
        return;
      } catch {
        if (!active) return;
      }

      setPhase("unavailable");
    }
    void start();
    return () => {
      active = false;
    };
  }, [applyAccessPayload, eventCode, openAttempt, urlInvitation]);

  useEffect(() => {
    const deadline = access?.event?.responseDeadline;
    if (!deadline) {
      const timer = window.setTimeout(
        () => setResponseDeadlinePassed(false),
        0,
      );
      return () => window.clearTimeout(timer);
    }
    let timer;
    const refreshDeadline = () => {
      const remaining = new Date(deadline).getTime() - new Date().getTime();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setResponseDeadlinePassed(true);
        return;
      }
      setResponseDeadlinePassed(false);
      timer = window.setTimeout(
        refreshDeadline,
        Math.min(remaining, 2_147_483_647),
      );
    };
    timer = window.setTimeout(refreshDeadline, 0);
    return () => window.clearTimeout(timer);
  }, [access?.event?.responseDeadline]);

  const responseChangesDisabled =
    !access?.event ||
    access.event.status !== "active" ||
    responseDeadlinePassed ||
    Boolean(serverWriteLock);
  const blockedIndices = useMemo(
    () => blockedSlotIndices(access?.event?.slotGroups),
    [access?.event?.slotGroups],
  );
  const hasBlockedSlots = blockedIndices.size > 0;

  const runAutosave = useCallback(async () => {
    if (autosaveInFlightRef.current) {
      autosavePendingRef.current = true;
      return autosaveInFlightRef.current;
    }
    if (!draftDirtyRef.current) return true;
    if (responseChangesDisabled) {
      setDraftSaveState("failed");
      setDraftSaveError(
        "Responses are locked, so this draft could not be saved.",
      );
      return false;
    }
    if (participantVersionRef.current === null) return false;

    const inperson = [...scheduleInpersonRef.current];
    const virtual = [...scheduleVirtualRef.current];
    const fingerprint = JSON.stringify([inperson, virtual]);
    const expectedVersion = participantVersionRef.current;
    autosavePendingRef.current = false;
    setDraftSaveState("saving");
    setDraftSaveError("");
    setSaveConflict(null);

    const request = (async () => {
      try {
        const { participant } = await updateTempAccessParticipant(eventCode, {
          availabilityInperson: inperson,
          availabilityVirtual: virtual,
          submitted: 0,
          expectedVersion,
        });
        participantVersionRef.current = participant.version;
        setSubmitted(false);
        setAccess((current) =>
          current
            ? {
                ...current,
                participant: { ...current.participant, ...participant },
              }
            : current,
        );
        const currentFingerprint = JSON.stringify([
          scheduleInpersonRef.current,
          scheduleVirtualRef.current,
        ]);
        draftDirtyRef.current = currentFingerprint !== fingerprint;
        autosavePendingRef.current = draftDirtyRef.current;
        // Updated at once, not after the render: the upgrade navigates as
        // soon as this save is answered, and the leave-page warning reads it.
        draftSaveStateRef.current = draftDirtyRef.current ? "saving" : "saved";
        setDraftSaveState(draftSaveStateRef.current);
        return true;
      } catch (error) {
        draftDirtyRef.current = true;
        setDraftSaveState("failed");
        if (error.status === 409 && error.participant) {
          setSaveConflict(error.participant);
          setDraftSaveError(
            "This schedule changed somewhere else. Reload the latest response before editing again.",
          );
        } else if (
          error.status === 401 ||
          error.status === 403 ||
          (error.status === 409 && !error.participant)
        ) {
          await reconcileRejectedWrite(error);
        } else {
          setDraftSaveError(error.message || "Draft autosave failed.");
        }
        return false;
      }
    })();

    autosaveInFlightRef.current = request;
    const saved = await request;
    autosaveInFlightRef.current = null;
    if (saved && autosavePendingRef.current && draftDirtyRef.current) {
      autosaveTimerRef.current = window.setTimeout(() => {
        void autosaveRunnerRef.current?.();
      }, 0);
    }
    return saved;
  }, [eventCode, reconcileRejectedWrite, responseChangesDisabled]);

  useEffect(() => {
    autosaveRunnerRef.current = runAutosave;
  }, [runAutosave]);

  useEffect(() => {
    draftSaveStateRef.current = draftSaveState;
  }, [draftSaveState]);

  const queueAutosave = useCallback(() => {
    draftDirtyRef.current = true;
    autosavePendingRef.current = true;
    setSubmitted(false);
    setDraftSaveState("saving");
    setDraftSaveError("");
    setSaveConflict(null);
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      void autosaveRunnerRef.current?.();
    }, 700);
  }, []);

  const flushPendingDraft = useCallback(async () => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    while (draftDirtyRef.current || autosaveInFlightRef.current) {
      const saved = await autosaveRunnerRef.current?.();
      if (!saved) return false;
    }
    return true;
  }, []);

  const hasPendingDraft = useCallback(
    () =>
      draftDirtyRef.current ||
      Boolean(autosaveInFlightRef.current) ||
      draftSaveStateRef.current === "saving" ||
      draftSaveStateRef.current === "failed",
    [],
  );

  useAutosaveNavigationGuard({
    hasPending: hasPendingDraft,
    flush: flushPendingDraft,
    pending: draftSaveState === "saving" || draftSaveState === "failed",
  });

  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (
        !draftDirtyRef.current &&
        draftSaveStateRef.current !== "saving" &&
        draftSaveStateRef.current !== "failed"
      ) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, []);

  const paintCell = useCallback(
    (channel, index) => {
      const scheduleRef =
        channel === "inperson" ? scheduleInpersonRef : scheduleVirtualRef;
      if (Number(scheduleRef.current[index]) === availabilityValue) return;
      const next = [...scheduleRef.current];
      next[index] = availabilityValue;
      scheduleRef.current = next;
      if (channel === "inperson") setScheduleInperson(next);
      else setScheduleVirtual(next);
      queueAutosave();
    },
    [availabilityValue, queueAutosave],
  );

  const handleInpersonPaint = useCallback(
    (index) => paintCell("inperson", index),
    [paintCell],
  );
  const handleVirtualPaint = useCallback(
    (index) => paintCell("virtual", index),
    [paintCell],
  );

  const copySchedule = (source, target) => {
    const sourceValues =
      source === "inperson"
        ? scheduleInpersonRef.current
        : scheduleVirtualRef.current;
    const next = [...sourceValues];
    if (target === "inperson") {
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
    } else {
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
    }
    queueAutosave();
  };

  const fillAll = (value) => {
    if (responseChangesDisabled) return;
    const mode = access?.event?.mode || "inperson";
    const length = scheduleLength(access?.event, access?.participant);
    const filled = () =>
      Array.from({ length }, (_, index) =>
        blockedIndices.has(index) ? 0 : value,
      );
    if (mode !== "virtual") {
      const next = filled();
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
    }
    if (mode !== "inperson") {
      const next = filled();
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
    }
    queueAutosave();
  };

  const reloadLatestResponse = async () => {
    if (!saveConflict || conflictReloadPending) return;
    const conflictParticipant = saveConflict;
    setConflictReloadPending(true);
    try {
      applyAccessPayload(await fetchTempAccessSession(eventCode));
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        endTemporaryAccess(
          "This temporary access is no longer active. Open the link in your invitation email again or sign in with the full account.",
        );
        return;
      }

      // The conflict payload is still the latest version returned by the
      // rejected write, so it is a safe fallback.
      applyParticipant(conflictParticipant, access?.event);
    } finally {
      setConflictReloadPending(false);
    }
  };

  const submitSchedule = async () => {
    setIsSubmitting(true);
    setSubmitError("");
    try {
      const saved = await flushPendingDraft();
      if (!saved) {
        setSubmitError("Resolve the draft save before submitting.");
        return;
      }
      const { participant } = await updateTempAccessParticipant(eventCode, {
        submitted: 1,
        expectedVersion: participantVersionRef.current,
      });
      applyParticipant(participant, access.event);
      setSubmitted(true);
      setDraftSaveState("submitted");
      try {
        applyAccessPayload(await fetchTempAccessSession(eventCode));
      } catch {
        // Submission succeeded even when re-reading the session fails.
      }
    } catch (error) {
      if (error.status === 409 && error.participant) {
        setSaveConflict(error.participant);
        setDraftSaveState("failed");
        setDraftSaveError(
          "This schedule changed somewhere else. Reload the latest response before submitting.",
        );
      } else if (
        error.status === 401 ||
        error.status === 403 ||
        (error.status === 409 && !error.participant)
      ) {
        await reconcileRejectedWrite(error);
      }
      if (![401, 403].includes(error.status)) {
        setSubmitError(error.message || "Failed to submit availability.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const logout = async () => {
    if (logoutPending || upgradePending) return;
    setLogoutPending(true);
    setSubmitError("");
    const saved = await flushPendingDraft();
    if (!saved) {
      setSubmitError(
        "Your latest changes could not be saved. Resolve the save error before signing out.",
      );
      setLogoutPending(false);
      return;
    }
    try {
      await logoutTempAccess(eventCode);
    } catch {
      setSubmitError(
        "Sign out could not be confirmed. This temporary session may still be active; try again before leaving this device.",
      );
      setLogoutPending(false);
      return;
    }
    forgetInvitation(eventCode);
    setAccess(null);
    setPhase("logged-out");
    setLogoutPending(false);
  };

  if (!eventCode) {
    return (
      <CenteredStatus
        title="Access link required"
        message="Open the temporary access link in your invitation email."
      />
    );
  }

  if (phase === "loading" || phase === "opening") {
    return (
      <CenteredStatus
        title="Opening event access…"
        message={
          phase === "opening"
            ? "Opening your invitation…"
            : "Please wait while we check this event link."
        }
        busy
      />
    );
  }

  if (phase === "inactive") {
    return (
      <CenteredStatus
        title="This invitation link isn't active"
        message="It may have been replaced by a newer invitation, or the organizer changed the address it was sent to. Ask the organizer to send it again, or sign in if you have a Releviz account."
      />
    );
  }

  if (phase === "open-failed") {
    return (
      <CenteredStatus title="Invitation not opened" failure={openError}>
        <AppButton
          fullWidth
          autoFocus
          onClick={() => setOpenAttempt((attempt) => attempt + 1)}
        >
          Try again
        </AppButton>
      </CenteredStatus>
    );
  }

  if (
    phase === "unavailable" ||
    phase === "logged-out" ||
    phase === "session-ended"
  ) {
    return (
      <CenteredStatus
        title={
          phase === "logged-out"
            ? "You are signed out"
            : phase === "session-ended"
              ? "Temporary access ended"
              : "Access link required"
        }
        message={
          phase === "logged-out"
            ? "Open the link in your invitation email whenever you need to access this event again."
            : phase === "session-ended"
              ? sessionEndMessage
              : "Open the temporary access link in your invitation email. The link only works for its event."
        }
      />
    );
  }

  const event = access.event;
  const participant = access.participant;
  const mode = event.mode || "inperson";
  const startingValue = startingAvailabilityValue(event);
  const startsAvailable = startingValue === 1;
  const startingLabel = availabilityLabel(startingValue);
  const upgradeHref = event.code ? makeUpgradeHref(event.code) : "";
  const leavingPage = logoutPending || upgradePending;

  const upgradeToFullAccess = async (clickEvent) => {
    clickEvent.preventDefault();
    if (!upgradeHref || leavingPage) return;
    setUpgradePending(true);
    setSubmitError("");
    const saved = await flushPendingDraft();
    if (!saved) {
      setSubmitError(
        "Your latest changes could not be saved. Resolve the save error before upgrading.",
      );
      setUpgradePending(false);
      return;
    }
    navigateTo(upgradeHref);
  };

  return (
    <main className="temp-access-page">
      <header className="app-header">
        <nav className="navbar navbar-expand flex-wrap" aria-label="Site">
          <div className="app-header-identity">
            <BrandLogo
              alt="Releviz"
              className="brand-logo brand-logo--header"
              priority
            />
            <span className="badge rounded-pill text-bg-primary">
              Temporary event access
            </span>
          </div>
          <AppButton
            variant="outlined"
            icon={<SignOutIcon />}
            className="ms-auto flex-shrink-0"
            busy={logoutPending}
            disabled={leavingPage}
            onClick={() => void logout()}
          >
            {logoutPending ? "Signing out…" : "Sign out"}
          </AppButton>
        </nav>
      </header>

      <div className="page-shell page-shell--wide">
        <PageHeader
          eyebrow={`You are responding as ${participant.name}`}
          title={event.name}
          lede={
            startsAvailable
              ? "Every time starts as Available. Paint Busy over the times that do not work for you."
              : "Choose a status, then click or drag across the times that work for you."
          }
          actions={
            upgradeHref ? (
              // The shared outlined style, like Sign out above: Bootstrap's
              // outline-primary blue is only 4.26:1 on the page background.
              // It saves pending changes itself, with its own saving state and
              // failure message, so the autosave guard lets its click through.
              <Link
                className={`btn btn-outline-secondary app-btn${leavingPage ? " disabled" : ""}`}
                href={upgradeHref}
                aria-disabled={leavingPage}
                data-autosave-guard="self"
                onClick={(clickEvent) => void upgradeToFullAccess(clickEvent)}
              >
                <span className="app-btn-icon" aria-hidden="true">
                  <UpgradeIcon />
                </span>
                <span className="app-btn-label">
                  {upgradePending
                    ? "Saving before upgrade…"
                    : "Upgrade to full access"}
                </span>
              </Link>
            ) : null
          }
        />

        <div className="d-flex flex-column gap-4">
          <Panel as="div">
            <EventDetailsGrid event={event} />
          </Panel>

          {/* Temporary participants only see and edit their own calendar. */}
          <div className="participant-columns">
            <Panel
              as="section"
              aria-labelledby="your-schedule-heading"
              headingLevel={2}
              titleId="your-schedule-heading"
              title="Your schedule"
              description="Changes save automatically to the shared response."
              actions={
                submitted ? (
                  <StatusBadge status="submitted">Submitted</StatusBadge>
                ) : null
              }
            >
              <div className="d-flex flex-column gap-3">
                <div>
                  <div className="schedule-toolbar mb-2">
                    <div className="schedule-toolbar__group">
                      <p className="schedule-toolbar__label">Mark times as</p>
                      <AvailabilityChoice
                        value={availabilityValue}
                        onChange={setAvailabilityValue}
                        disabled={responseChangesDisabled || leavingPage}
                        label="Availability status"
                        virtual={mode === "virtual"}
                        className="flex-wrap"
                      />
                    </div>
                    <div className="schedule-toolbar__actions">
                      <AppButton
                        variant="outlined"
                        size="sm"
                        disabled={responseChangesDisabled || leavingPage}
                        onClick={() => fillAll(availabilityValue)}
                      >
                        Apply to all
                      </AppButton>
                      <AppButton
                        variant="outlined"
                        size="sm"
                        disabled={responseChangesDisabled || leavingPage}
                        onClick={() => fillAll(startingValue)}
                      >
                        Mark all {startingLabel}
                      </AppButton>
                    </div>
                  </div>
                  <p className="small text-secondary mb-0">
                    <span className="icon-inline me-1" aria-hidden="true">
                      <TimezoneIcon />
                    </span>
                    Times shown in {event.timezone || "UTC"}
                  </p>
                </div>

                {hasBlockedSlots && (
                  <Alert variant="info" role="note">
                    {BLOCKED_SLOTS_NOTE}
                  </Alert>
                )}

                <ScheduleChannelEditor
                  mode={mode}
                  slotGroups={event.slotGroups || []}
                  inperson={scheduleInperson}
                  virtual={scheduleVirtual}
                  startingValue={startingValue}
                  readOnly={
                    responseChangesDisabled ||
                    leavingPage ||
                    Boolean(saveConflict)
                  }
                  onInpersonPaint={handleInpersonPaint}
                  onVirtualPaint={handleVirtualPaint}
                  onCopy={copySchedule}
                  legend={false}
                />

                {draftSaveState !== "idle" && (
                  <Alert
                    variant={
                      draftSaveState === "failed"
                        ? "danger"
                        : draftSaveState === "submitted"
                          ? "success"
                          : "info"
                    }
                    role={draftSaveState === "failed" ? "alert" : "status"}
                    actions={
                      draftSaveState === "failed" ? (
                        saveConflict ? (
                          <AppButton
                            variant="outlined"
                            size="sm"
                            icon={<RefreshIcon />}
                            busy={conflictReloadPending}
                            disabled={conflictReloadPending}
                            onClick={() => void reloadLatestResponse()}
                          >
                            {conflictReloadPending
                              ? "Reloading…"
                              : "Reload latest response"}
                          </AppButton>
                        ) : !responseChangesDisabled ? (
                          <AppButton
                            variant="outlined"
                            size="sm"
                            onClick={() => void runAutosave()}
                          >
                            Retry save
                          </AppButton>
                        ) : null
                      ) : null
                    }
                  >
                    <span>
                      {draftSaveState === "saving" && "Saving draft…"}
                      {draftSaveState === "saved" &&
                        "Draft saved. Submit when you are ready."}
                      {draftSaveState === "submitted" && "Schedule submitted."}
                      {draftSaveState === "failed" &&
                        (draftSaveError || "Draft autosave failed.")}
                    </span>
                  </Alert>
                )}

                {responseChangesDisabled && (
                  <Alert variant="warning" role="status">
                    {serverWriteLock
                      ? serverWriteLock
                      : event.status !== "active"
                        ? `Responses are locked while this event is ${event.status}.`
                        : "The response deadline has passed."}
                  </Alert>
                )}
                {submitError && (
                  <Alert variant="danger" role="alert">
                    {submitError}
                  </Alert>
                )}
                <div className="d-flex justify-content-end">
                  <AppButton
                    icon={<SendIcon />}
                    busy={isSubmitting}
                    disabled={
                      isSubmitting ||
                      responseChangesDisabled ||
                      leavingPage ||
                      Boolean(saveConflict)
                    }
                    onClick={() => void submitSchedule()}
                  >
                    {isSubmitting
                      ? "Submitting…"
                      : submitted
                        ? "Update availability"
                        : "Submit availability"}
                  </AppButton>
                </div>
              </div>
            </Panel>
          </div>

          <Alert as="aside" variant="info" role={null}>
            This session can only access this event. Create a full account to
            manage all of your events in one place.
          </Alert>
        </div>
      </div>
    </main>
  );
}

function CenteredStatus({
  title,
  message = "Please wait while we check this event link.",
  busy = false,
  failure = "",
  children = null,
}) {
  return (
    <main className="auth-page">
      <section className="auth-panel text-center" aria-busy={busy || undefined}>
        <BrandLogo
          alt="Releviz"
          className="brand-logo brand-logo--auth mx-auto"
          priority
        />
        <div>
          <span className="eyebrow">Temporary event access</span>
          <h1>{title}</h1>
          {busy ? (
            <LoadingState label={message} className="p-0" />
          ) : failure ? (
            <Alert variant="danger" className="text-start">
              {failure}
            </Alert>
          ) : (
            <p className="text-secondary mb-0">{message}</p>
          )}
        </div>
        {children}
      </section>
    </main>
  );
}
