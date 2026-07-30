"use client";

import { useState, useEffect, useContext, useCallback, useMemo, useRef } from "react";
import EventContext from "@/components/event/EventContext";
import {
  FinalMeetingPanel,
  IndividualSchedulesPanel,
  InvitationsPanel,
  LifecyclePanel,
  OrganizerHeader,
  OrganizerSchedulePanel,
  ParticipantManagerPanel,
  RecommendationsPanel,
  WeightAnalysisPanel,
} from "@/components/schedule/OrganizerPanels";
import {
  deleteParticipant,
  fetchParticipantsIncludeHidden,
  joinEvent,
  unhideParticipant,
  updateParticipant,
} from "@/lib/api/participants";
import { fetchWeights, updateWeights } from "@/lib/api/weights";
import { useAuth } from "@/components/auth/AuthContext";
import {
  fetchEventResults,
  fetchFinalization,
  fetchInvitations,
  confirmFinalMeeting,
  previewFinalMeeting,
  sendInvitations,
  sendReminders,
  updateEventLifecycle,
} from "@/lib/api/events";
import { formatIsoForDateTimeLocal, zonedLocalDateTimeToIso } from "@/lib/time";
import { buildWeightedPreview } from "@/lib/weightedPreview";

function OrganizerView() {
  const { event, setEvent, numSlots } = useContext(EventContext);
  const { user, loading: authLoading, getToken } = useAuth();
  const mode = event?.mode || "inperson";

  const [participants, setParticipants] = useState([]);
  const [weights, setWeights] = useState({}); // { participantId: { weight, included } }
  const [results, setResults] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [weightSaveState, setWeightSaveState] = useState("saved");
  const [weightSaveError, setWeightSaveError] = useState("");

  const weightsRef = useRef({});
  useEffect(() => {
    weightsRef.current = weights;
  }, [weights]);
  const saveTimer = useRef(null);
  const weightRevisionRef = useRef(0);
  const weightSaveInFlightRef = useRef(false);
  const queuedWeightSaveRef = useRef(null);
  const flushWeightSaveRef = useRef(null);
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Organizer self-schedule state
  const [myParticipantId, setMyParticipantId] = useState("");
  const [myParticipantVersion, setMyParticipantVersion] = useState(null);
  const [myParticipantName, setMyParticipantName] = useState("");
  const [myJoined, setMyJoined] = useState(false);
  const [myInperson, setMyInperson] = useState([]);
  const [myVirtual, setMyVirtual] = useState([]);
  const [mySaving, setMySaving] = useState(false);
  const myPaintValueRef = useRef({ inperson: 1, virtual: 1 });
  const [hidingParticipantId, setHidingParticipantId] = useState("");
  const [hideError, setHideError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [invitations, setInvitations] = useState([]);
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");
  const [sendingInvites, setSendingInvites] = useState(false);
  const [sendingReminders, setSendingReminders] = useState(false);
  const inviteRequestRef = useRef({ fingerprint: "", idempotencyKey: "" });
  const reminderRequestRef = useRef("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [changingLifecycle, setChangingLifecycle] = useState(false);
  const [lifecycleDeadline, setLifecycleDeadline] = useState("");
  const [finalStart, setFinalStart] = useState("");
  const [finalEnd, setFinalEnd] = useState("");
  const [finalChannel, setFinalChannel] = useState(
    event?.mode === "virtual" ? "virtual" : "inperson"
  );
  const [finalLocation, setFinalLocation] = useState(event?.location || "");
  const [finalReview, setFinalReview] = useState(null);
  const [finalDelivery, setFinalDelivery] = useState(null);
  const [finalizationError, setFinalizationError] = useState("");
  const [finalizationStatus, setFinalizationStatus] = useState("");
  const [reviewingFinal, setReviewingFinal] = useState(false);
  const [confirmingFinal, setConfirmingFinal] = useState(false);
  const [finalRequestKey, setFinalRequestKey] = useState("");
  const [reviewFingerprint, setReviewFingerprint] = useState("");

  useEffect(() => {
    if (!event.responseDeadline) {
      setLifecycleDeadline("");
      return;
    }
    setLifecycleDeadline(
      formatIsoForDateTimeLocal(event.responseDeadline, event.timezone || "UTC")
    );
  }, [event.responseDeadline, event.timezone]);

  useEffect(() => {
    const meeting = event.finalMeeting;
    if (meeting) {
      setFinalStart(formatIsoForDateTimeLocal(meeting.startsAt, event.timezone || "UTC"));
      setFinalEnd(formatIsoForDateTimeLocal(meeting.endsAt, event.timezone || "UTC"));
      setFinalChannel(meeting.channel);
      setFinalLocation(meeting.location || "");
      return;
    }
    const firstSlot =
      event.daySelectionType === "specific_dates" ? event.slotGroups?.[0]?.slots?.[0] : null;
    if (firstSlot?.startsAt && firstSlot?.endsAt) {
      setFinalStart(formatIsoForDateTimeLocal(firstSlot.startsAt, event.timezone || "UTC"));
      setFinalEnd(formatIsoForDateTimeLocal(firstSlot.endsAt, event.timezone || "UTC"));
    } else {
      setFinalStart("");
      setFinalEnd("");
    }
    setFinalChannel(event.mode === "virtual" ? "virtual" : "inperson");
    setFinalLocation(event.location || "");
    setFinalReview(null);
    setFinalDelivery(null);
    setFinalRequestKey("");
    setReviewFingerprint("");
  }, [
    event.code,
    event.daySelectionType,
    event.finalMeeting,
    event.location,
    event.mode,
    event.slotGroups,
    event.timezone,
  ]);

  // Load participants and weights in parallel
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const [participantsRes, weightsRes, invitationsRes, resultsRes, finalizationRes] =
          await Promise.all([
            fetchParticipantsIncludeHidden(event.code, token),
            fetchWeights(event.code, token),
            fetchInvitations(event.code, token),
            fetchEventResults(event.code, token),
            event.finalMeeting
              ? fetchFinalization(event.code, token).catch(() => null)
              : Promise.resolve(null),
          ]);

        const parsed = participantsRes.participants.map((p) => ({
          ...p,
          inpersonArray: p.availabilityInperson.map(Number),
          virtualArray: p.availabilityVirtual.map(Number),
        }));
        setParticipants(parsed);

        const map = {};
        weightsRes.weights.forEach((w) => {
          map[w.participant_id] = {
            weight: w.weight,
            included: w.included,
            required: w.required,
          };
        });
        weightsRef.current = map;
        setWeights(map);
        queuedWeightSaveRef.current = null;
        weightRevisionRef.current = 0;
        setWeightSaveState("saved");
        setWeightSaveError("");
        setInvitations(invitationsRes.invitations || []);
        setResults(resultsRes.results);
        if (finalizationRes) {
          setFinalReview(finalizationRes.finalMeeting?.attendance || null);
          setFinalDelivery(finalizationRes.delivery || null);
        }

        const mine = parsed.find((participant) => participant.user_id === user?.id);
        if (mine) {
          setMyParticipantId(mine.id);
          setMyParticipantVersion(mine.version);
          setMyParticipantName(mine.name);
          setMyInperson(mine.inpersonArray);
          setMyVirtual(mine.virtualArray);
          setMyJoined(true);
        }
      } catch (err) {
        console.error("Failed to load data", err);
      }
    }
    if (user?.id) {
      load();
    }
  }, [event.code, event.finalMeeting, refreshKey, user?.id, getToken]);

  const flushWeightSave = useCallback(async () => {
    if (weightSaveInFlightRef.current || !queuedWeightSaveRef.current) return;

    const pending = queuedWeightSaveRef.current;
    queuedWeightSaveRef.current = null;
    weightSaveInFlightRef.current = true;
    setWeightSaveState("saving");
    setWeightSaveError("");

    try {
      const payload = Object.entries(pending.weights).map(([participantId, weight]) => ({
        participantId,
        weight: weight.weight,
        included: weight.included,
        required: weight.required,
      }));
      const token = await getToken();
      const data = await updateWeights(event.code, payload, token);
      if (pending.revision === weightRevisionRef.current) {
        if (data.results) setResults(data.results);
        setWeightSaveState("saved");
      }
    } catch (err) {
      if (pending.revision === weightRevisionRef.current) {
        queuedWeightSaveRef.current = pending;
        setWeightSaveState("failed");
        setWeightSaveError(err.message || "Unable to save participant weights.");
      }
    } finally {
      weightSaveInFlightRef.current = false;
      if (
        queuedWeightSaveRef.current &&
        queuedWeightSaveRef.current.revision !== pending.revision
      ) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          flushWeightSaveRef.current?.();
        }, 0);
      }
    }
  }, [event.code, getToken]);

  useEffect(() => {
    flushWeightSaveRef.current = flushWeightSave;
  }, [flushWeightSave]);

  const queueWeightSave = useCallback((next, { immediate = false } = {}) => {
    weightRevisionRef.current += 1;
    queuedWeightSaveRef.current = {
      revision: weightRevisionRef.current,
      weights: next,
    };
    setWeightSaveState("unsaved");
    setWeightSaveError("");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => {
        saveTimer.current = null;
        flushWeightSaveRef.current?.();
      },
      immediate ? 0 : 500
    );
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (beforeUnloadEvent) => {
      if (weightSaveState === "saved") return;
      beforeUnloadEvent.preventDefault();
      beforeUnloadEvent.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [weightSaveState]);

  const handleWeightChange = (participantId, val) => {
    const current = weightsRef.current[participantId] ?? {
      weight: 1.0,
      included: 1,
      required: 0,
    };
    const next = { ...weightsRef.current, [participantId]: { ...current, weight: val } };
    weightsRef.current = next;
    setWeights(next);
    queueWeightSave(next);
  };

  const handleIncludedChange = (participantId, val) => {
    const current = weightsRef.current[participantId] ?? {
      weight: 1.0,
      included: 1,
      required: 0,
    };
    const next = { ...weightsRef.current, [participantId]: { ...current, included: val ? 1 : 0 } };
    weightsRef.current = next;
    setWeights(next);
    queueWeightSave(next, { immediate: true });
  };

  const handleRequiredChange = (participantId, val) => {
    const current = weightsRef.current[participantId] ?? {
      weight: 1.0,
      included: 1,
      required: 0,
    };
    const next = {
      ...weightsRef.current,
      [participantId]: { ...current, required: val ? 1 : 0 },
    };
    weightsRef.current = next;
    setWeights(next);
    queueWeightSave(next, { immediate: true });
  };

  const retryWeightSave = () => {
    if (!queuedWeightSaveRef.current) return;
    setWeightSaveState("unsaved");
    setWeightSaveError("");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      flushWeightSaveRef.current?.();
    }, 0);
  };

  const handleMyJoin = async () => {
    try {
      const token = await getToken();
      const { participant } = await joinEvent(event.code, token);
      setMyParticipantId(participant.id);
      setMyParticipantVersion(participant.version);
      setMyParticipantName(participant.name);
      setMyInperson(participant.availabilityInperson.map(Number));
      setMyVirtual(participant.availabilityVirtual.map(Number));
      setMyJoined(true);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to join:", err);
    }
  };

  const handleMyInpersonPaint = (idx, interaction) => {
    setMyInperson((prev) => {
      const phase = interaction?.phase || "start";
      if (phase === "start" || phase === "keyboard") {
        myPaintValueRef.current.inperson = Number(prev[idx]) > 0 ? 0 : 1;
      }
      const n = [...prev];
      n[idx] = myPaintValueRef.current.inperson;
      return n;
    });
  };

  const handleMyVirtualPaint = (idx, interaction) => {
    setMyVirtual((prev) => {
      const phase = interaction?.phase || "start";
      if (phase === "start" || phase === "keyboard") {
        myPaintValueRef.current.virtual = Number(prev[idx]) > 0 ? 0 : 1;
      }
      const n = [...prev];
      n[idx] = myPaintValueRef.current.virtual;
      return n;
    });
  };

  const handleMyCopySchedule = (source, target) => {
    const next = [...(source === "inperson" ? myInperson : myVirtual)];
    if (target === "inperson") setMyInperson(next);
    else setMyVirtual(next);
  };

  const handleMySave = async () => {
    if (!myParticipantId) return;
    setMySaving(true);
    try {
      const token = await getToken();
      const { participant } = await updateParticipant(
        event.code,
        myParticipantId,
        {
          availabilityInperson: myInperson,
          availabilityVirtual: myVirtual,
          submitted: 1,
          expectedVersion: myParticipantVersion,
        },
        token
      );
      setMyParticipantVersion(participant.version);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setMySaving(false);
    }
  };

  const handleHideParticipant = async (participant) => {
    if (!participant?.id) return;
    setHideError("");
    setHidingParticipantId(participant.id);
    try {
      const token = await getToken();
      await deleteParticipant(event.code, participant.id, token);
      setParticipants((prev) =>
        prev.map((p) => (p.id === participant.id ? { ...p, hidden: 1 } : p))
      );
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setHideError(`Failed to hide participant: ${err.message}`);
    } finally {
      setHidingParticipantId("");
    }
  };

  const handleUnhideParticipant = async (participant) => {
    if (!participant?.id) return;
    setHideError("");
    setHidingParticipantId(participant.id);
    try {
      const token = await getToken();
      await unhideParticipant(event.code, participant.id, token);
      setParticipants((prev) =>
        prev.map((p) => (p.id === participant.id ? { ...p, hidden: 0 } : p))
      );
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setHideError(`Failed to unhide participant: ${err.message}`);
    } finally {
      setHidingParticipantId("");
    }
  };

  const handleGroupChange = async (participantId, groupName) => {
    try {
      const token = await getToken();
      const { participant } = await updateParticipant(
        event.code,
        participantId,
        { groupName },
        token
      );
      setParticipants((prev) =>
        prev.map((p) =>
          p.id === participantId
            ? { ...p, group_name: participant.group_name, version: participant.version }
            : p
        )
      );
    } catch (err) {
      console.error("Failed to update group:", err);
    }
  };

  const handleMoveParticipant = async (participantId, direction) => {
    const sorted = [...activeParticipants].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    const idx = sorted.findIndex((p) => p.id === participantId);
    if ((direction === "up" && idx <= 0) || (direction === "down" && idx >= sorted.length - 1))
      return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const myOrder = sorted[idx].sort_order ?? idx;
    const theirOrder = sorted[swapIdx].sort_order ?? swapIdx;
    try {
      const token = await getToken();
      const [firstResult, secondResult] = await Promise.all([
        updateParticipant(event.code, sorted[idx].id, { sortOrder: theirOrder }, token),
        updateParticipant(event.code, sorted[swapIdx].id, { sortOrder: myOrder }, token),
      ]);
      setParticipants((prev) =>
        prev.map((p) => {
          if (p.id === sorted[idx].id) return { ...p, ...firstResult.participant };
          if (p.id === sorted[swapIdx].id) return { ...p, ...secondResult.participant };
          return p;
        })
      );
    } catch (err) {
      console.error("Failed to reorder:", err);
    }
  };

  const handleCheckAll = (included) => {
    const next = { ...weightsRef.current };
    activeParticipants.forEach((p) => {
      const current = next[p.id] ?? { weight: 1.0, included: 1, required: 0 };
      next[p.id] = { ...current, included: included ? 1 : 0 };
    });
    weightsRef.current = next;
    setWeights(next);
    queueWeightSave(next, { immediate: true });
  };

  const handleSendInvitations = async () => {
    setInviteError("");
    setInviteStatus("");
    setSendingInvites(true);
    try {
      const emails = inviteEmails
        .split(/[\s,;]+/)
        .map((email) => email.trim())
        .filter(Boolean);
      const message = inviteMessage.trim();
      const fingerprint = JSON.stringify({ emails, message });
      if (inviteRequestRef.current.fingerprint !== fingerprint) {
        inviteRequestRef.current = {
          fingerprint,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      const token = await getToken();
      const data = await sendInvitations(
        event.code,
        {
          emails,
          message,
          idempotencyKey: inviteRequestRef.current.idempotencyKey,
        },
        token
      );
      setInvitations(data.invitations || []);
      setInviteEmails("");
      inviteRequestRef.current = { fingerprint: "", idempotencyKey: "" };
      const delivery = data.delivery || {};
      const waiting = (delivery.pending || 0) + (delivery.processing || 0) + (delivery.retry || 0);
      if (waiting || delivery.permanentFailure) {
        setInviteStatus(
          `Accepted ${data.recipientCount || 0} invitation(s): ${delivery.sent || 0} sent, ` +
            `${waiting} awaiting delivery, ${delivery.permanentFailure || 0} failed permanently.`
        );
      } else if (data.deduplicated && !data.enqueued) {
        setInviteStatus(`No duplicate invitations sent; ${delivery.sent || 0} already delivered.`);
      } else {
        setInviteStatus(`Sent ${delivery.sent || 0} invitation(s).`);
      }
    } catch (err) {
      setInviteError(`Failed to send invitations: ${err.message}`);
    } finally {
      setSendingInvites(false);
    }
  };

  const handleSendReminders = async () => {
    setInviteError("");
    setInviteStatus("");
    setSendingReminders(true);
    try {
      if (!reminderRequestRef.current) {
        reminderRequestRef.current = crypto.randomUUID();
      }
      const token = await getToken();
      const data = await sendReminders(
        event.code,
        { idempotencyKey: reminderRequestRef.current },
        token
      );
      const refreshed = await fetchInvitations(event.code, token);
      setInvitations(refreshed.invitations || []);
      reminderRequestRef.current = "";
      const delivery = data.delivery || {};
      const waiting = (delivery.pending || 0) + (delivery.processing || 0) + (delivery.retry || 0);
      if (waiting || delivery.permanentFailure) {
        setInviteStatus(
          `Accepted ${data.recipientCount || 0} reminder(s): ${delivery.sent || 0} sent, ` +
            `${waiting} awaiting delivery, ${delivery.permanentFailure || 0} failed permanently.`
        );
      } else if (data.deduplicated && !data.enqueued) {
        setInviteStatus(`No duplicate reminders sent; ${delivery.sent || 0} already delivered.`);
      } else {
        setInviteStatus(`Sent ${delivery.sent || 0} reminder(s).`);
      }
    } catch (err) {
      setInviteError(`Failed to send reminders: ${err.message}`);
    } finally {
      setSendingReminders(false);
    }
  };

  const handleLifecycleChange = async (status, responseDeadline = undefined) => {
    setLifecycleError("");
    setChangingLifecycle(true);
    try {
      const token = await getToken();
      const data = await updateEventLifecycle(
        event.code,
        {
          status,
          expectedVersion: event.version,
          responseDeadline,
        },
        token
      );
      setEvent(data.event);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setLifecycleError(`Failed to update event: ${err.message}`);
    } finally {
      setChangingLifecycle(false);
    }
  };

  const finalFormFingerprint = JSON.stringify([
    finalStart,
    finalEnd,
    finalChannel,
    finalLocation.trim(),
    event.timezone,
  ]);

  const clearFinalReview = () => {
    setFinalReview(null);
    setFinalDelivery(null);
    setFinalRequestKey("");
    setReviewFingerprint("");
    setFinalizationStatus("");
  };

  const handleUseRecommendation = (recommendation) => {
    clearFinalReview();
    setFinalStart(
      formatIsoForDateTimeLocal(recommendation.suggestedStartsAt, event.timezone || "UTC")
    );
    setFinalEnd(formatIsoForDateTimeLocal(recommendation.suggestedEndsAt, event.timezone || "UTC"));
    setFinalChannel(recommendation.channel);
    setFinalizationError("");
    setFinalizationStatus(
      `Recommendation #${recommendation.rank} loaded. Review attendance before confirming.`
    );
  };

  const finalPayload = () => {
    if (!finalStart || !finalEnd) {
      throw new Error("Choose both a final start and end time.");
    }
    return {
      startsAt: zonedLocalDateTimeToIso(finalStart, event.timezone || "UTC"),
      endsAt: zonedLocalDateTimeToIso(finalEnd, event.timezone || "UTC"),
      channel: finalChannel,
      location: finalLocation.trim(),
    };
  };

  const handleReviewFinal = async () => {
    setFinalizationError("");
    setFinalizationStatus("");
    setReviewingFinal(true);
    try {
      const payload = finalPayload();
      const token = await getToken();
      const data = await previewFinalMeeting(event.code, payload, token);
      setFinalReview(data.attendance);
      setReviewFingerprint(finalFormFingerprint);
      setFinalRequestKey(crypto.randomUUID());
      setFinalizationStatus(
        "Attendance review is current. Confirm when you are ready to lock responses."
      );
    } catch (err) {
      setFinalizationError(`Unable to review this time: ${err.message}`);
    } finally {
      setReviewingFinal(false);
    }
  };

  const handleConfirmFinal = async () => {
    if (!finalReview || reviewFingerprint !== finalFormFingerprint) {
      setFinalizationError("Review attendance again before confirming this time.");
      return;
    }
    setFinalizationError("");
    setFinalizationStatus("");
    setConfirmingFinal(true);
    try {
      const payload = finalPayload();
      const token = await getToken();
      const data = await confirmFinalMeeting(
        event.code,
        {
          ...payload,
          expectedVersion: event.version,
          idempotencyKey: finalRequestKey || crypto.randomUUID(),
        },
        token
      );
      setEvent(data.event);
      setFinalReview(data.finalMeeting?.attendance || null);
      setFinalDelivery(data.delivery || null);
      const failed = (data.delivery?.retry || 0) + (data.delivery?.permanentFailure || 0);
      setFinalizationStatus(
        failed
          ? "Final time is locked. Some confirmation emails are queued for retry."
          : `Final time is locked. Sent ${data.delivery?.sent || 0} confirmation email(s).`
      );
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setFinalizationError(`Unable to confirm this time: ${err.message}`);
    } finally {
      setConfirmingFinal(false);
    }
  };

  const activeParticipants = participants
    .filter((p) => !p.hidden)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const hiddenParticipants = participants.filter((p) => p.hidden);
  const filteredParticipants = searchQuery
    ? activeParticipants.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : activeParticipants;

  // Group participants by group_name
  const groups = {};
  filteredParticipants.forEach((p) => {
    const gn = p.group_name || "";
    if (!groups[gn]) groups[gn] = [];
    groups[gn].push(p);
  });
  const groupNames = Object.keys(groups).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  const previewResults = useMemo(
    () =>
      buildWeightedPreview({
        participants,
        weights,
        mode,
        slotCount: numSlots,
      }),
    [mode, numSlots, participants, weights]
  );
  const weightedInperson = previewResults.channels?.inperson?.weighted ?? Array(numSlots).fill(0);
  const weightedVirtual = previewResults.channels?.virtual?.weighted ?? Array(numSlots).fill(0);
  const recommendations = results?.recommendations ?? [];
  const recommendationBasis = results?.recommendationBasis ?? null;
  const submittedCount = activeParticipants.filter((p) => p.submitted).length;
  const countedResponseTotal = previewResults.countedResponseTotal;
  const unansweredParticipantTotal = previewResults.unansweredParticipantTotal;
  const excludedParticipantTotal = previewResults.excludedParticipantTotal;
  const totalWeight = previewResults.calculationBasis.weighted.totalWeight;
  const requiredConflictTotal = Object.values(
    previewResults.requiredParticipantConflicts.channels || {}
  ).reduce((total, conflicts) => total + conflicts.length, 0);
  const responseDeadlinePassed =
    event.responseDeadline && Date.now() >= new Date(event.responseDeadline).getTime();
  const responsesOpen = event.status === "open" && !responseDeadlinePassed;
  const weightChangesDisabled = ["finalized", "archived"].includes(event.status);

  const inpersonDetails = activeParticipants
    .filter((p) => {
      const w = weights[p.id] ?? { weight: 1.0, included: 1, required: 0 };
      return p.submitted && w.included && p.inpersonArray.length === numSlots;
    })
    .map((p) => ({ name: p.name, schedule: p.inpersonArray }));

  const virtualDetails = activeParticipants
    .filter((p) => {
      const w = weights[p.id] ?? { weight: 1.0, included: 1, required: 0 };
      return p.submitted && w.included && p.virtualArray.length === numSlots;
    })
    .map((p) => ({ name: p.name, schedule: p.virtualArray }));

  if (authLoading || !user) {
    return (
      <div
        className="page-pad"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "calc(100vh - 76px)",
        }}
      >
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ maxWidth: "1400px", margin: "0 auto" }}>
      <OrganizerHeader onRefresh={() => setRefreshKey((key) => key + 1)} />

      <WeightAnalysisPanel
        event={event}
        mode={mode}
        participants={activeParticipants}
        weights={weights}
        weightedInperson={weightedInperson}
        weightedVirtual={weightedVirtual}
        inpersonDetails={inpersonDetails}
        virtualDetails={virtualDetails}
        countedResponseTotal={countedResponseTotal}
        unansweredParticipantTotal={unansweredParticipantTotal}
        excludedParticipantTotal={excludedParticipantTotal}
        totalWeight={totalWeight}
        requiredConflictTotal={requiredConflictTotal}
        saveState={weightSaveState}
        saveError={weightSaveError}
        disabled={weightChangesDisabled}
        onCheckAll={handleCheckAll}
        onIncludedChange={handleIncludedChange}
        onWeightChange={handleWeightChange}
        onRequiredChange={handleRequiredChange}
        onRetry={retryWeightSave}
      />

      <LifecyclePanel
        event={event}
        activeParticipantCount={activeParticipants.length}
        submittedCount={submittedCount}
        countedResponseTotal={countedResponseTotal}
        unansweredParticipantTotal={unansweredParticipantTotal}
        excludedParticipantTotal={excludedParticipantTotal}
        deadline={lifecycleDeadline}
        setDeadline={setLifecycleDeadline}
        changing={changingLifecycle}
        onChange={handleLifecycleChange}
        error={lifecycleError}
      />

      <InvitationsPanel
        invitations={invitations}
        inviteEmails={inviteEmails}
        setInviteEmails={setInviteEmails}
        inviteMessage={inviteMessage}
        setInviteMessage={setInviteMessage}
        inviteStatus={inviteStatus}
        inviteError={inviteError}
        sendingInvites={sendingInvites}
        sendingReminders={sendingReminders}
        onSendInvitations={handleSendInvitations}
        onSendReminders={handleSendReminders}
      />

      <div style={{ marginBottom: "24px" }}>
        <OrganizerSchedulePanel
          event={event}
          mode={mode}
          user={user}
          joined={myJoined}
          participantName={myParticipantName}
          inperson={myInperson}
          virtual={myVirtual}
          responsesOpen={responsesOpen}
          saving={mySaving}
          onJoin={handleMyJoin}
          onInpersonPaint={handleMyInpersonPaint}
          onVirtualPaint={handleMyVirtualPaint}
          onCopy={handleMyCopySchedule}
          onSave={handleMySave}
        />
      </div>

      <RecommendationsPanel
        event={event}
        recommendations={recommendations}
        recommendationBasis={recommendationBasis}
        onUseRecommendation={handleUseRecommendation}
      />

      <IndividualSchedulesPanel
        event={event}
        mode={mode}
        activeParticipants={activeParticipants}
        weights={weights}
      />

      <FinalMeetingPanel
        event={event}
        finalStart={finalStart}
        setFinalStart={setFinalStart}
        finalEnd={finalEnd}
        setFinalEnd={setFinalEnd}
        finalChannel={finalChannel}
        setFinalChannel={setFinalChannel}
        finalLocation={finalLocation}
        setFinalLocation={setFinalLocation}
        clearFinalReview={clearFinalReview}
        onReview={handleReviewFinal}
        onConfirm={handleConfirmFinal}
        reviewing={reviewingFinal}
        confirming={confirmingFinal}
        finalReview={finalReview}
        reviewIsCurrent={reviewFingerprint === finalFormFingerprint}
        finalDelivery={finalDelivery}
        status={finalizationStatus}
        error={finalizationError}
      />

      <ParticipantManagerPanel
        activeParticipants={activeParticipants}
        hiddenParticipants={hiddenParticipants}
        filteredParticipants={filteredParticipants}
        groups={groups}
        groupNames={groupNames}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        showHidden={showHidden}
        setShowHidden={setShowHidden}
        hidingParticipantId={hidingParticipantId}
        onGroupChange={handleGroupChange}
        onMoveParticipant={handleMoveParticipant}
        onHideParticipant={handleHideParticipant}
        onUnhideParticipant={handleUnhideParticipant}
      />

      {hideError && (
        <p
          style={{
            color: "var(--md-sys-color-error)",
            margin: "16px 0 0 0",
            fontSize: "0.9rem",
          }}
        >
          {hideError}
        </p>
      )}
    </div>
  );
}

export default OrganizerView;
