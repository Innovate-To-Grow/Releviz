"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MdLogout, MdRefresh, MdSend, MdUpgrade } from "react-icons/md";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import AppButton from "@/components/ui/AppButton";
import BrandLogo from "@/components/ui/BrandLogo";
import {
  fetchTempAccessSession,
  logoutTempAccess,
  requestTempAccessCode,
  updateTempAccessParticipant,
  verifyTempAccess,
} from "@/lib/api/tempAccess";
import { navigateTo, replaceUrl } from "@/lib/navigation";
import styles from "./temp-access.module.css";

const AVAILABILITY_CHOICES = [
  { label: "Busy", value: 0 },
  { label: "If needed", value: 0.5 },
  { label: "Available", value: 1 },
];

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
  const session = payload.session && typeof payload.session === "object" ? payload.session : {};
  return {
    event: payload.event || session.event || null,
    participant: payload.participant || session.participant || null,
    email: payload.email || session.email || "",
    results: payload.results ?? session.results ?? null,
    canViewResults: Boolean(payload.canViewResults ?? session.canViewResults),
  };
}

function scheduleLength(event, participant) {
  if (Number.isInteger(event?.slotCount) && event.slotCount >= 0) return event.slotCount;
  const largestIndex = (event?.slotGroups || []).reduce(
    (largest, group) =>
      Math.max(
        largest,
        ...(group?.slots || []).map((slot) => (Number.isInteger(slot?.index) ? slot.index : -1))
      ),
    -1
  );
  return Math.max(
    largestIndex + 1,
    participant?.availabilityInperson?.length || 0,
    participant?.availabilityVirtual?.length || 0
  );
}

function normalizedSchedule(values, length) {
  return Array.from({ length }, (_, index) => Number(values?.[index] || 0));
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

  const [phase, setPhase] = useState("loading");
  const [invitationToken, setInvitationToken] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [requestState, setRequestState] = useState("idle");
  const [requestMessage, setRequestMessage] = useState("");
  const [access, setAccess] = useState(null);
  const [availabilityValue, setAvailabilityValue] = useState(1);
  const [scheduleInperson, setScheduleInperson] = useState([]);
  const [scheduleVirtual, setScheduleVirtual] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState("idle");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState(null);
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
  const requestStartedRef = useRef("");
  const resultsRefreshRevisionRef = useRef(0);

  const applyParticipant = useCallback(
    (participant, event = access?.event) => {
      if (!participant || !event) return;
      const length = scheduleLength(event, participant);
      const inperson = normalizedSchedule(participant.availabilityInperson, length);
      const virtual = normalizedSchedule(participant.availabilityVirtual, length);
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
      setAccess((current) => (current ? { ...current, participant } : current));
    },
    [access?.event]
  );

  const applyAccessPayload = useCallback((payload) => {
    const next = unwrapAccessPayload(payload);
    if (!next.event || !next.participant) {
      throw new Error("Temporary access response is incomplete.");
    }
    const length = scheduleLength(next.event, next.participant);
    const inperson = normalizedSchedule(next.participant.availabilityInperson, length);
    const virtual = normalizedSchedule(next.participant.availabilityVirtual, length);
    participantVersionRef.current = next.participant.version;
    scheduleInpersonRef.current = inperson;
    scheduleVirtualRef.current = virtual;
    draftDirtyRef.current = false;
    autosavePendingRef.current = false;
    resultsRefreshRevisionRef.current += 1;
    setScheduleInperson(inperson);
    setScheduleVirtual(virtual);
    setSubmitted(Boolean(next.participant.submitted));
    setDraftSaveState(next.participant.submitted ? "submitted" : "saved");
    setDraftSaveError("");
    setSaveConflict(null);
    setAccess(next);
    setPhase("access");
  }, []);

  const refreshResultsAfterDraft = useCallback(async () => {
    const revision = resultsRefreshRevisionRef.current + 1;
    resultsRefreshRevisionRef.current = revision;
    setAccess((current) =>
      current ? { ...current, canViewResults: false, results: null } : current
    );
    try {
      const latest = unwrapAccessPayload(await fetchTempAccessSession(eventCode));
      if (resultsRefreshRevisionRef.current !== revision) return;
      setAccess((current) =>
        current
          ? {
              ...current,
              canViewResults: latest.canViewResults,
              results: latest.canViewResults ? latest.results : null,
            }
          : current
      );
    } catch {
      // The conservative state above prevents stale or no-longer-authorized results.
    }
  }, [eventCode]);

  const sendCode = useCallback(
    async (token, { automatic = false } = {}) => {
      if (!eventCode || !token) return false;
      setRequestState("sending");
      setRequestMessage("");
      setVerificationError("");
      try {
        await requestTempAccessCode({ code: eventCode, invitationToken: token });
        setRequestState("sent");
        setRequestMessage(
          "If this access link is valid, a six-digit code has been sent to its email address."
        );
        return true;
      } catch {
        setRequestState("error");
        setRequestMessage(
          automatic
            ? "We could not start verification. Try sending the code again."
            : "We could not send a new code. Wait a moment and try again."
        );
        return false;
      }
    },
    [eventCode]
  );

  useEffect(() => {
    if (!eventCode) {
      return;
    }

    const token = urlInvitation || readStoredInvitation(eventCode);
    if (urlInvitation) {
      storeInvitation(eventCode, urlInvitation);
      const url = new URL(window.location.href);
      url.searchParams.delete("invitation");
      replaceUrl(`${url.pathname}${url.search}${url.hash}`);
    }
    let active = true;
    async function start() {
      try {
        const payload = await fetchTempAccessSession(eventCode);
        if (!active) return;
        forgetInvitation(eventCode);
        setInvitationToken("");
        applyAccessPayload(payload);
        return;
      } catch {
        if (!active) return;
      }

      if (!token) {
        setPhase("unavailable");
        return;
      }

      setInvitationToken(token);
      setPhase("code");
      const requestKey = `${eventCode}:${token}`;
      if (requestStartedRef.current !== requestKey) {
        requestStartedRef.current = requestKey;
        await sendCode(token, { automatic: true });
      }
    }
    void start();
    return () => {
      active = false;
    };
  }, [applyAccessPayload, eventCode, sendCode, urlInvitation]);

  useEffect(() => {
    const deadline = access?.event?.responseDeadline;
    if (!deadline) {
      const timer = window.setTimeout(() => setResponseDeadlinePassed(false), 0);
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
      timer = window.setTimeout(refreshDeadline, Math.min(remaining, 2_147_483_647));
    };
    timer = window.setTimeout(refreshDeadline, 0);
    return () => window.clearTimeout(timer);
  }, [access?.event?.responseDeadline]);

  const responseChangesDisabled =
    !access?.event || access.event.status !== "open" || responseDeadlinePassed;

  const runAutosave = useCallback(async () => {
    if (autosaveInFlightRef.current) {
      autosavePendingRef.current = true;
      return autosaveInFlightRef.current;
    }
    if (!draftDirtyRef.current) return true;
    if (responseChangesDisabled) {
      setDraftSaveState("failed");
      setDraftSaveError("Responses are locked, so this draft could not be saved.");
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
            ? { ...current, participant: { ...current.participant, ...participant } }
            : current
        );
        void refreshResultsAfterDraft();
        const currentFingerprint = JSON.stringify([
          scheduleInpersonRef.current,
          scheduleVirtualRef.current,
        ]);
        draftDirtyRef.current = currentFingerprint !== fingerprint;
        autosavePendingRef.current = draftDirtyRef.current;
        setDraftSaveState(draftDirtyRef.current ? "saving" : "saved");
        return true;
      } catch (error) {
        draftDirtyRef.current = true;
        setDraftSaveState("failed");
        if (error.status === 409 && error.participant) {
          setSaveConflict(error.participant);
          setDraftSaveError(
            "This schedule changed somewhere else. Reload the latest response before editing again."
          );
        } else if (error.status === 401) {
          setDraftSaveError(
            "This temporary session has expired. Reopen your access link to continue."
          );
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
  }, [eventCode, refreshResultsAfterDraft, responseChangesDisabled]);

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
      if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const verifyCode = async (event) => {
    event.preventDefault();
    if (!invitationToken || !/^\d{6}$/.test(verificationCode)) {
      setVerificationError("Enter the six-digit code from your email.");
      return;
    }
    setVerificationError("");
    setRequestState("verifying");
    try {
      const payload = await verifyTempAccess({
        code: eventCode,
        invitationToken,
        verificationCode,
      });
      forgetInvitation(eventCode);
      setInvitationToken("");
      setVerificationCode("");
      applyAccessPayload(payload);
    } catch (error) {
      setRequestState("sent");
      setVerificationError(
        error.status === 429
          ? "Too many attempts. Request a new code after waiting a moment."
          : "That code could not be verified. Check the code or request a new one."
      );
    }
  };

  const paintCell = useCallback(
    (channel, index) => {
      const scheduleRef = channel === "inperson" ? scheduleInpersonRef : scheduleVirtualRef;
      if (Number(scheduleRef.current[index]) === availabilityValue) return;
      const next = [...scheduleRef.current];
      next[index] = availabilityValue;
      scheduleRef.current = next;
      if (channel === "inperson") setScheduleInperson(next);
      else setScheduleVirtual(next);
      queueAutosave();
    },
    [availabilityValue, queueAutosave]
  );

  const handleInpersonPaint = useCallback((index) => paintCell("inperson", index), [paintCell]);
  const handleVirtualPaint = useCallback((index) => paintCell("virtual", index), [paintCell]);

  const copySchedule = (source, target) => {
    const sourceValues =
      source === "inperson" ? scheduleInpersonRef.current : scheduleVirtualRef.current;
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
    if (mode !== "virtual") {
      const next = Array(length).fill(value);
      scheduleInpersonRef.current = next;
      setScheduleInperson(next);
    }
    if (mode !== "inperson") {
      const next = Array(length).fill(value);
      scheduleVirtualRef.current = next;
      setScheduleVirtual(next);
    }
    queueAutosave();
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
        // Submission succeeded even when the optional results refresh fails.
      }
    } catch (error) {
      if (error.status === 409 && error.participant) {
        setSaveConflict(error.participant);
        setDraftSaveState("failed");
        setDraftSaveError(
          "This schedule changed somewhere else. Reload the latest response before submitting."
        );
      }
      setSubmitError(error.message || "Failed to submit availability.");
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
        "Your latest changes could not be saved. Resolve the save error before signing out."
      );
      setLogoutPending(false);
      return;
    }
    try {
      await logoutTempAccess(eventCode);
    } catch {
      // Clearing the local view is safe even if the server session already expired.
    } finally {
      forgetInvitation(eventCode);
      setAccess(null);
      setPhase("logged-out");
      setLogoutPending(false);
    }
  };

  if (!eventCode) {
    return (
      <CenteredStatus
        title="Access link required"
        message="Open the temporary access link in your invitation email."
      />
    );
  }

  if (phase === "loading") {
    return <CenteredStatus title="Opening event access…" />;
  }

  if (phase === "unavailable" || phase === "logged-out") {
    return (
      <CenteredStatus
        title={phase === "logged-out" ? "You are signed out" : "Access link required"}
        message={
          phase === "logged-out"
            ? "Reopen the invitation email whenever you need to access this event again."
            : "Open the temporary access link in your invitation email. The link only works for its event."
        }
      />
    );
  }

  if (phase === "code") {
    return (
      <main className={styles.authPage}>
        <section className={styles.authCard} aria-labelledby="temp-access-heading">
          <BrandLogo alt="Releviz" className={styles.authLogo} priority />
          <div>
            <p className={styles.eyebrow}>Temporary event access</p>
            <h1 id="temp-access-heading">Check your email</h1>
            <p className={styles.muted}>
              Enter the six-digit code sent to the email address connected to this invitation. The
              code expires after 10 minutes.
            </p>
          </div>
          {requestMessage && (
            <p
              className={requestState === "error" ? styles.errorNotice : styles.infoNotice}
              role={requestState === "error" ? "alert" : "status"}
            >
              {requestMessage}
            </p>
          )}
          <form className={styles.codeForm} onSubmit={verifyCode}>
            <label htmlFor="temporary-verification-code">Verification code</label>
            <input
              id="temporary-verification-code"
              value={verificationCode}
              onChange={(event) =>
                setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoFocus
              required
            />
            {verificationError && (
              <p className={styles.fieldError} role="alert">
                {verificationError}
              </p>
            )}
            <AppButton
              type="submit"
              fullWidth
              disabled={requestState === "sending" || requestState === "verifying"}
            >
              {requestState === "verifying" ? "Verifying…" : "Verify and open schedule"}
            </AppButton>
          </form>
          <AppButton
            variant="outlined"
            fullWidth
            disabled={requestState === "sending" || requestState === "verifying"}
            onClick={() => void sendCode(invitationToken)}
          >
            {requestState === "sending" ? "Sending…" : "Send a new code"}
          </AppButton>
          <p className={styles.securityNote}>
            This verification only grants access to this event. It does not sign you in to a full
            Releviz account.
          </p>
        </section>
      </main>
    );
  }

  const event = access.event;
  const participant = access.participant;
  const mode = event.mode || "inperson";
  const results = access.results;
  const avgInperson =
    results?.channels?.inperson?.unweighted || Array(scheduleLength(event, participant)).fill(0);
  const avgVirtual =
    results?.channels?.virtual?.unweighted || Array(scheduleLength(event, participant)).fill(0);
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
        "Your latest changes could not be saved. Resolve the save error before upgrading."
      );
      setUpgradePending(false);
      return;
    }
    navigateTo(upgradeHref);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brandBlock}>
          <BrandLogo alt="Releviz" className={styles.headerLogo} priority />
          <span className={styles.accessBadge}>Temporary event access</span>
        </div>
        <AppButton
          variant="outlined"
          icon={<MdLogout />}
          disabled={leavingPage}
          onClick={() => void logout()}
        >
          {logoutPending ? "Signing out…" : "Sign out"}
        </AppButton>
      </header>

      <div className={styles.content}>
        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>You are responding as {participant.name}</p>
            <h1>{event.name}</h1>
            <p className={styles.muted}>
              Choose a status, then click or drag across the times that work for you.
            </p>
          </div>
          {upgradeHref && (
            <Link
              className={styles.upgradeLink}
              href={upgradeHref}
              aria-disabled={leavingPage}
              onClick={(clickEvent) => void upgradeToFullAccess(clickEvent)}
            >
              <MdUpgrade aria-hidden="true" />
              {upgradePending ? "Saving before upgrade…" : "Upgrade to full access"}
            </Link>
          )}
        </section>

        <EventDetailsGrid event={event} />

        <div className={access.canViewResults && results ? styles.twoPane : undefined}>
          <section className={styles.scheduleCard} aria-labelledby="your-schedule-heading">
            <div className={styles.sectionHeading}>
              <div>
                <h2 id="your-schedule-heading">Your schedule</h2>
                <p className={styles.muted}>Changes save automatically to the shared response.</p>
              </div>
              {submitted && <span className={styles.submittedBadge}>Submitted</span>}
            </div>

            <div className={styles.controls}>
              <p>Mark times as</p>
              <div className={styles.choiceRow} role="group" aria-label="Availability status">
                {AVAILABILITY_CHOICES.map((choice) => (
                  <AppButton
                    key={choice.value}
                    variant={availabilityValue === choice.value ? "filled" : "outlined"}
                    aria-pressed={availabilityValue === choice.value}
                    disabled={responseChangesDisabled || leavingPage}
                    onClick={() => setAvailabilityValue(choice.value)}
                  >
                    {choice.label}
                  </AppButton>
                ))}
              </div>
              <div className={styles.choiceRow}>
                <AppButton
                  variant="outlined"
                  disabled={responseChangesDisabled || leavingPage}
                  onClick={() => fillAll(availabilityValue)}
                >
                  Apply to all
                </AppButton>
                <AppButton
                  variant="outlined"
                  disabled={responseChangesDisabled || leavingPage}
                  onClick={() => fillAll(0)}
                >
                  Mark all Busy
                </AppButton>
              </div>
            </div>

            <ScheduleChannelEditor
              mode={mode}
              slotGroups={event.slotGroups || []}
              inperson={scheduleInperson}
              virtual={scheduleVirtual}
              readOnly={responseChangesDisabled || leavingPage || Boolean(saveConflict)}
              onInpersonPaint={handleInpersonPaint}
              onVirtualPaint={handleVirtualPaint}
              onCopy={copySchedule}
            />

            {draftSaveState !== "idle" && (
              <div
                className={draftSaveState === "failed" ? styles.errorNotice : styles.saveNotice}
                role={draftSaveState === "failed" ? "alert" : "status"}
                aria-live={draftSaveState === "failed" ? "assertive" : "polite"}
              >
                <span>
                  {draftSaveState === "saving" && "Saving draft…"}
                  {draftSaveState === "saved" && "Draft saved. Submit when you are ready."}
                  {draftSaveState === "submitted" && "Schedule submitted."}
                  {draftSaveState === "failed" && (draftSaveError || "Draft autosave failed.")}
                </span>
                {draftSaveState === "failed" &&
                  (saveConflict ? (
                    <AppButton
                      variant="outlined"
                      icon={<MdRefresh />}
                      onClick={() => applyParticipant(saveConflict, event)}
                    >
                      Reload latest response
                    </AppButton>
                  ) : (
                    <AppButton variant="outlined" onClick={() => void runAutosave()}>
                      Retry save
                    </AppButton>
                  ))}
              </div>
            )}

            {responseChangesDisabled && (
              <p className={styles.fieldError} role="status">
                {event.status !== "open"
                  ? `Responses are locked while this event is ${event.status}.`
                  : "The response deadline has passed."}
              </p>
            )}
            {submitError && (
              <p className={styles.fieldError} role="alert">
                {submitError}
              </p>
            )}
            <div className={styles.submitRow}>
              <AppButton
                icon={<MdSend />}
                disabled={
                  isSubmitting || responseChangesDisabled || leavingPage || Boolean(saveConflict)
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
          </section>

          {access.canViewResults && results && (
            <section className={styles.resultsCard} aria-labelledby="group-availability-heading">
              <h2 id="group-availability-heading">Group availability</h2>
              <p className={styles.muted}>
                Based on {results.countedResponseTotal || 0} submitted response(s).{" "}
                {results.unansweredParticipantTotal || 0} participant(s) are still unanswered.
              </p>
              <div className={styles.resultGrids}>
                {mode !== "virtual" && (
                  <ScheduleGrid
                    schedule={avgInperson}
                    slotGroups={event.slotGroups || []}
                    readOnly
                    showValues
                    label={mode === "mixed" ? "In-Person Availability" : "Availability"}
                  />
                )}
                {mode !== "inperson" && (
                  <ScheduleGrid
                    schedule={avgVirtual}
                    slotGroups={event.slotGroups || []}
                    readOnly
                    showValues
                    label={mode === "mixed" ? "Virtual Availability" : "Availability"}
                    virtual
                  />
                )}
              </div>
            </section>
          )}
        </div>

        <aside className={styles.restrictedNote}>
          This session can only access this event. Create a full account to manage all of your
          events in one place.
        </aside>
      </div>
    </main>
  );
}

function CenteredStatus({ title, message = "Please wait while we check this event link." }) {
  return (
    <main className={styles.authPage}>
      <section className={styles.authCard}>
        <BrandLogo alt="Releviz" className={styles.authLogo} priority />
        <h1>{title}</h1>
        <p className={styles.muted}>{message}</p>
      </section>
    </main>
  );
}
