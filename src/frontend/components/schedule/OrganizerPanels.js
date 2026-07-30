"use client";

import { useState } from "react";
import { GoVerified, GoUnverified } from "react-icons/go";
import {
  MdArchive,
  MdArrowDownward,
  MdArrowUpward,
  MdDeleteOutline,
  MdEmail,
  MdLockOpen,
  MdLogin,
  MdNotificationsActive,
  MdOutlineLock,
  MdRefresh,
  MdSave,
} from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import EventDetailsGrid from "@/components/event/EventDetailsGrid";
import ScheduleChannelEditor from "@/components/schedule/ScheduleChannelEditor";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";
import { zonedLocalDateTimeToIso } from "@/lib/time";
import "@material/web/checkbox/checkbox.js";
import "@material/web/slider/slider.js";
import "@material/web/textfield/outlined-text-field.js";

export function OrganizerHeader({ onRefresh }) {
  return (
    <div
      style={{
        marginBottom: "32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "16px",
      }}
    >
      <div>
        <h2
          className="organizer-title"
          style={{
            color: "var(--md-sys-color-primary)",
            margin: "0 0 4px 0",
            fontSize: "1.8rem",
          }}
        >
          Organizer Dashboard
        </h2>
        <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: 0 }}>
          Manage participants and find the best meeting time.
        </p>
      </div>
      <AppButton onClick={onRefresh} variant="outlined" icon={<MdRefresh />}>
        Refresh
      </AppButton>
    </div>
  );
}

export function RecommendationsPanel({
  event,
  recommendations,
  recommendationBasis,
  onUseRecommendation,
}) {
  return (
    <div
      className="md-card"
      style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "14px" }}
    >
      <div>
        <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>
          Recommended Meeting Times
        </h3>
        <p style={{ margin: "4px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
          Ranked by required-participant conflicts first, then weighted and unweighted availability.
          Each recommendation covers one {event.slotMinutes}-minute slot.
        </p>
      </div>
      {recommendations.length > 0 ? (
        <ol
          style={{
            display: "grid",
            gap: "10px",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {recommendations.map((recommendation) => (
            <li
              key={`${recommendation.channel}:${recommendation.slotIndex}`}
              style={{
                alignItems: "center",
                border: "1px solid var(--md-sys-color-surface-variant)",
                borderRadius: "10px",
                display: "flex",
                flexWrap: "wrap",
                gap: "12px",
                justifyContent: "space-between",
                padding: "12px",
              }}
            >
              <div>
                <strong>
                  #{recommendation.rank} · {recommendation.label}
                </strong>
                <p
                  style={{
                    color: "var(--md-sys-color-on-surface-variant)",
                    margin: "4px 0 0",
                  }}
                >
                  {recommendation.channel === "inperson" ? "In person" : "Virtual"} ·{" "}
                  {(recommendation.weightedAvailability * 100).toFixed(0)}% weighted ·{" "}
                  {recommendation.fullyAvailableParticipantTotal} fully available ·{" "}
                  {recommendation.requiredParticipantConflictTotal} required conflict(s)
                </p>
              </div>
              <AppButton variant="outlined" onClick={() => onUseRecommendation(recommendation)}>
                Use recommendation {recommendation.rank}
              </AppButton>
            </li>
          ))}
        </ol>
      ) : (
        <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
          {recommendationBasis?.status === "no_future_slots"
            ? "No future configured slots are available to recommend."
            : "Recommendations appear after at least one valid schedule is submitted."}
        </p>
      )}
    </div>
  );
}

export function FinalMeetingPanel({
  event,
  finalStart,
  setFinalStart,
  finalEnd,
  setFinalEnd,
  finalChannel,
  setFinalChannel,
  finalLocation,
  setFinalLocation,
  clearFinalReview,
  onReview,
  onConfirm,
  reviewing,
  confirming,
  finalReview,
  reviewIsCurrent,
  finalDelivery,
  status,
  error,
}) {
  return (
    <div
      className="md-card"
      style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <div>
        <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Final Meeting</h3>
        <p style={{ margin: "4px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
          Review attendance for one valid event time, then confirm it to lock responses and send
          calendar invitations.
        </p>
      </div>

      {event.status === "finalized" && event.finalMeeting ? (
        <div
          style={{
            padding: "14px",
            borderRadius: "10px",
            background: "var(--md-sys-color-surface-container-low)",
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>
            {new Date(event.finalMeeting.startsAt).toLocaleString([], {
              timeZone: event.timezone,
            })}{" "}
            –{" "}
            {new Date(event.finalMeeting.endsAt).toLocaleString([], {
              timeZone: event.timezone,
            })}
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
            {event.timezone} · {event.finalMeeting.channel} · {event.finalMeeting.location}
          </p>
          <p style={{ margin: "8px 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
            Reopen the event to cancel this calendar invitation and choose a different time.
          </p>
        </div>
      ) : event.status === "open" || event.status === "closed" ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "12px",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Final start</span>
              <input
                type="datetime-local"
                value={finalStart}
                onChange={(changeEvent) => {
                  setFinalStart(changeEvent.target.value);
                  clearFinalReview();
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Final end</span>
              <input
                type="datetime-local"
                value={finalEnd}
                onChange={(changeEvent) => {
                  setFinalEnd(changeEvent.target.value);
                  clearFinalReview();
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Meeting method</span>
              <select
                value={finalChannel}
                onChange={(changeEvent) => {
                  setFinalChannel(changeEvent.target.value);
                  clearFinalReview();
                }}
              >
                {event.mode !== "virtual" && <option value="inperson">In person</option>}
                {event.mode !== "inperson" && <option value="virtual">Virtual</option>}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Location or meeting link</span>
              <input
                value={finalLocation}
                onChange={(changeEvent) => {
                  setFinalLocation(changeEvent.target.value);
                  clearFinalReview();
                }}
                maxLength={500}
              />
            </label>
          </div>
          <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
            Times are interpreted in <strong>{event.timezone || "UTC"}</strong>.
          </p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <AppButton variant="outlined" onClick={onReview} disabled={reviewing || confirming}>
              {reviewing ? "Reviewing..." : "Review Attendance"}
            </AppButton>
            <AppButton
              onClick={onConfirm}
              disabled={confirming || reviewing || !finalReview || !reviewIsCurrent}
            >
              {confirming ? "Confirming..." : "Confirm Final Time"}
            </AppButton>
          </div>
        </>
      ) : (
        <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
          Open or close this event before confirming a final meeting time.
        </p>
      )}

      {finalReview && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "8px",
            }}
          >
            {[
              { label: "Available", value: finalReview.availableParticipantTotal },
              { label: "Partially available", value: finalReview.partialParticipantTotal },
              { label: "Unavailable", value: finalReview.unavailableParticipantTotal },
              { label: "Unanswered", value: finalReview.unansweredParticipantTotal },
              { label: "Excluded", value: finalReview.excludedParticipantTotal },
              { label: "Required conflicts", value: finalReview.requiredConflictTotal },
            ].map((metric) => (
              <div
                key={metric.label}
                style={{
                  padding: "10px",
                  border: "1px solid var(--md-sys-color-surface-variant)",
                  borderRadius: "8px",
                }}
              >
                <span style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
                  {metric.label}
                </span>
                <strong style={{ display: "block", fontSize: "1.2rem" }}>{metric.value}</strong>
              </div>
            ))}
          </div>
          {finalReview.participants?.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {finalReview.participants.map((participant) => (
                <li key={participant.participantId}>
                  {participant.name}: {participant.status}
                  {participant.required ? " (required)" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {finalDelivery && (
        <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
          Confirmation delivery: {finalDelivery.sent} sent, {finalDelivery.pending} pending,{" "}
          {finalDelivery.retry} retrying, {finalDelivery.permanentFailure} failed.
        </p>
      )}
      <div aria-live="polite">
        {status && <p style={{ color: "var(--md-sys-color-primary)", margin: 0 }}>{status}</p>}
        {error && <p style={{ color: "var(--md-sys-color-error)", margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

export function LifecyclePanel({
  event,
  activeParticipantCount,
  submittedCount,
  countedResponseTotal,
  unansweredParticipantTotal,
  excludedParticipantTotal,
  deadline,
  setDeadline,
  changing,
  onChange,
  error,
}) {
  const deadlineValue = deadline
    ? zonedLocalDateTimeToIso(deadline, event.timezone || "UTC")
    : null;
  return (
    <div
      className="md-card"
      style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "12px" }}
    >
      <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Event Details</h3>
      <EventDetailsGrid
        event={event}
        extraCards={[
          { label: "Participants", value: activeParticipantCount },
          { label: "Submitted", value: `${submittedCount} / ${activeParticipantCount}` },
          { label: "Counted", value: countedResponseTotal },
          { label: "Awaiting", value: unansweredParticipantTotal },
          { label: "Excluded", value: excludedParticipantTotal },
        ]}
      />
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Response deadline</span>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(changeEvent) => setDeadline(changeEvent.target.value)}
          />
        </label>
        <AppButton
          variant="outlined"
          disabled={changing || event.status === "finalized" || event.status === "archived"}
          onClick={() => onChange(event.status, deadlineValue)}
        >
          Save Deadline
        </AppButton>
        {event.status === "open" ? (
          <AppButton
            variant="outlined"
            icon={<MdOutlineLock />}
            disabled={changing}
            onClick={() => onChange("closed")}
          >
            Close Event
          </AppButton>
        ) : (
          <AppButton
            variant="outlined"
            icon={<MdLockOpen />}
            disabled={changing}
            onClick={() => onChange("open", deadlineValue)}
          >
            Reopen Event
          </AppButton>
        )}
        {event.status !== "archived" && (
          <AppButton
            variant="outlined"
            icon={<MdArchive />}
            disabled={changing}
            onClick={() => onChange("archived")}
          >
            Archive Event
          </AppButton>
        )}
      </div>
      {error && <p style={{ margin: 0, color: "var(--md-sys-color-error)" }}>{error}</p>}
    </div>
  );
}

export function InvitationsPanel({
  invitations,
  inviteEmails,
  setInviteEmails,
  inviteMessage,
  setInviteMessage,
  inviteStatus,
  inviteError,
  sendingInvites,
  sendingReminders,
  onSendInvitations,
  onSendReminders,
}) {
  return (
    <div
      className="md-card"
      style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div>
          <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Email Invitations</h3>
          <p style={{ margin: "4px 0 0 0", color: "var(--md-sys-color-on-surface-variant)" }}>
            Send the schedule link and calendar reminder to participants.
          </p>
        </div>
        <AppButton
          variant="outlined"
          icon={<MdNotificationsActive />}
          onClick={onSendReminders}
          disabled={sendingReminders}
        >
          {sendingReminders ? "Sending..." : "Send Reminders"}
        </AppButton>
      </div>

      <md-outlined-text-field
        label="Invite emails"
        value={inviteEmails}
        onInput={(inputEvent) => setInviteEmails(inputEvent.target.value)}
        placeholder="name@example.com, teammate@example.com"
        style={{ width: "100%" }}
      ></md-outlined-text-field>
      <textarea
        value={inviteMessage}
        onChange={(changeEvent) => setInviteMessage(changeEvent.target.value)}
        maxLength={1000}
        placeholder="Optional message"
        style={{
          minHeight: "80px",
          resize: "vertical",
          padding: "12px",
          borderRadius: "8px",
          border: "1px solid var(--md-sys-color-outline)",
          background: "var(--md-sys-color-surface)",
          color: "var(--md-sys-color-on-surface)",
          font: "inherit",
        }}
      />
      <AppButton
        onClick={onSendInvitations}
        disabled={sendingInvites || !inviteEmails.trim()}
        icon={<MdEmail />}
      >
        {sendingInvites ? "Sending..." : "Send Invitations"}
      </AppButton>
      {inviteStatus && (
        <p style={{ color: "var(--md-sys-color-primary)", margin: 0 }}>{inviteStatus}</p>
      )}
      {inviteError && (
        <p style={{ color: "var(--md-sys-color-error)", margin: 0 }}>{inviteError}</p>
      )}
      {invitations.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {invitations.map((invitation) => (
            <div
              key={invitation.id || invitation.email}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid var(--md-sys-color-surface-variant)",
                background: "var(--md-sys-color-surface-container-low)",
                flexWrap: "wrap",
              }}
            >
              <span>{invitation.email}</span>
              <span
                style={{
                  alignItems: "center",
                  display: "inline-flex",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <span style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
                  {invitation.statusLabel || invitation.status}
                </span>
                {invitation.awaitingReminder && (
                  <span
                    style={{
                      background: "var(--md-sys-color-surface-variant)",
                      borderRadius: "999px",
                      color: "var(--md-sys-color-on-surface-variant)",
                      fontSize: "0.78rem",
                      padding: "3px 8px",
                    }}
                  >
                    Awaiting reminder
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WeightAnalysisPanel({
  event,
  mode,
  participants,
  weights,
  weightedInperson,
  weightedVirtual,
  inpersonDetails,
  virtualDetails,
  countedResponseTotal,
  unansweredParticipantTotal,
  excludedParticipantTotal,
  totalWeight,
  requiredConflictTotal,
  saveState,
  saveError,
  disabled,
  onCheckAll,
  onIncludedChange,
  onWeightChange,
  onRequiredChange,
  onRetry,
}) {
  const [activeChannel, setActiveChannel] = useState(mode === "virtual" ? "virtual" : "inperson");
  const [query, setQuery] = useState("");
  const visibleParticipants = query
    ? participants.filter((participant) =>
        participant.name.toLowerCase().includes(query.toLowerCase())
      )
    : participants;
  const channel = mode === "mixed" ? activeChannel : mode;
  const schedule = channel === "virtual" ? weightedVirtual : weightedInperson;
  const participantDetails = channel === "virtual" ? virtualDetails : inpersonDetails;
  const saveMessages = {
    saved: "All weight changes saved.",
    saving: "Saving weight changes…",
    unsaved: "Unsaved weight changes.",
    failed: saveError || "Weight changes could not be saved.",
  };

  return (
    <section className="weight-analysis md-card" aria-labelledby="weight-analysis-title">
      <div className="weight-analysis__heading">
        <div>
          <h3 id="weight-analysis-title">Weight Analysis</h3>
          <p>
            Adjust participant influence and watch the weighted availability values and colors
            update immediately.
          </p>
        </div>
        <div
          className={`weight-save-state weight-save-state--${saveState}`}
          role={saveState === "failed" ? "alert" : "status"}
          aria-live="polite"
        >
          <span>{saveMessages[saveState] || saveMessages.saved}</span>
          {saveState === "failed" && (
            <AppButton variant="outlined" onClick={onRetry}>
              Retry
            </AppButton>
          )}
        </div>
      </div>

      {disabled && (
        <p className="weight-analysis__locked" role="note">
          Weight controls are locked while this event is {event.status}.
        </p>
      )}

      <div className="weight-analysis__layout">
        <div className="weight-analysis__controls">
          <div className="weight-analysis__toolbar">
            <input
              type="search"
              value={query}
              onChange={(changeEvent) => setQuery(changeEvent.target.value)}
              placeholder="Search participants"
              aria-label="Search weight controls"
            />
            <div>
              <AppButton
                variant="outlined"
                onClick={() => onCheckAll(true)}
                disabled={disabled || participants.length === 0}
              >
                Include all
              </AppButton>
              <AppButton
                variant="outlined"
                onClick={() => onCheckAll(false)}
                disabled={disabled || participants.length === 0}
              >
                Exclude all
              </AppButton>
            </div>
          </div>

          <div className="weight-analysis__participant-list">
            {visibleParticipants.map((participant) => {
              const participantWeight = weights[participant.id] || {
                weight: 1,
                included: 1,
                required: 0,
              };
              const included = Boolean(participantWeight.included);
              return (
                <article
                  className="weight-control"
                  data-participant-id={participant.id}
                  key={participant.id}
                >
                  <div className="weight-control__name">
                    <label>
                      <md-checkbox
                        aria-label={`Include ${participant.name}`}
                        checked={included}
                        disabled={disabled}
                        onInput={(inputEvent) =>
                          onIncludedChange(participant.id, inputEvent.target.checked)
                        }
                      ></md-checkbox>
                      <strong>{participant.name}</strong>
                    </label>
                    <span
                      title={participant.submitted ? "Submitted" : "Not submitted"}
                      aria-label={participant.submitted ? "Submitted" : "Not submitted"}
                    >
                      {participant.submitted ? (
                        <GoVerified aria-hidden="true" />
                      ) : (
                        <GoUnverified aria-hidden="true" />
                      )}
                    </span>
                  </div>
                  <div className="weight-control__slider">
                    <span>Weight</span>
                    <md-slider
                      aria-label={`${participant.name} weight`}
                      min="0"
                      max="1"
                      step="0.01"
                      value={participantWeight.weight}
                      disabled={disabled || !included}
                      onInput={(inputEvent) =>
                        onWeightChange(participant.id, Number(inputEvent.target.value))
                      }
                    ></md-slider>
                    <output aria-live="off">{Number(participantWeight.weight).toFixed(2)}</output>
                  </div>
                  <label className="weight-control__required">
                    <input
                      type="checkbox"
                      checked={Boolean(participantWeight.required)}
                      disabled={disabled || !included}
                      onChange={(changeEvent) =>
                        onRequiredChange(participant.id, changeEvent.target.checked)
                      }
                    />
                    Required participant
                  </label>
                </article>
              );
            })}
            {participants.length === 0 && <p>No participants have joined this event yet.</p>}
            {participants.length > 0 && visibleParticipants.length === 0 && (
              <p>No participants match this search.</p>
            )}
          </div>
        </div>

        <div className="weight-analysis__preview">
          <div className="weight-analysis__preview-card">
            <div className="weight-analysis__preview-heading">
              <div>
                <h3>Group Availability</h3>
                <p>
                  Counted {countedResponseTotal}; awaiting {unansweredParticipantTotal}; excluded{" "}
                  {excludedParticipantTotal}; total weight {totalWeight.toFixed(2)}.
                  {requiredConflictTotal > 0
                    ? ` ${requiredConflictTotal} slot(s) conflict with a required participant.`
                    : ""}
                </p>
              </div>
              {mode === "mixed" && (
                <div className="schedule-channel-tabs" role="tablist" aria-label="Result channel">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeChannel === "inperson"}
                    onClick={() => setActiveChannel("inperson")}
                  >
                    In person
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeChannel === "virtual"}
                    onClick={() => setActiveChannel("virtual")}
                  >
                    Virtual
                  </button>
                </div>
              )}
            </div>
            {event.location && <p className="weight-analysis__location">{event.location}</p>}
            <ScheduleGrid
              schedule={schedule}
              slotGroups={event.slotGroups}
              readOnly
              showValues
              label={
                mode === "mixed"
                  ? `${channel === "virtual" ? "Virtual" : "In-Person"} Availability`
                  : "Availability"
              }
              participantDetails={participantDetails}
              virtual={channel === "virtual"}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function OrganizerSchedulePanel({
  event,
  mode,
  user,
  joined,
  participantName,
  inperson,
  virtual,
  responsesOpen,
  saving,
  onJoin,
  onInpersonPaint,
  onVirtualPaint,
  onCopy,
  onSave,
}) {
  return (
    <div className="md-card">
      <h3 style={{ margin: "0 0 16px 0", color: "var(--md-sys-color-on-surface)" }}>My Schedule</h3>
      {!joined ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
            Join this event with your account to submit the organizer schedule.
          </p>
          <AppButton onClick={onJoin} icon={<MdLogin />} disabled={!responsesOpen}>
            Join as {user.displayName}
          </AppButton>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <p style={{ margin: 0, color: "var(--md-sys-color-on-surface-variant)" }}>
            Editing as <strong>{participantName}</strong>. Click cells to toggle availability.
          </p>
          <ScheduleChannelEditor
            mode={mode}
            slotGroups={event.slotGroups}
            inperson={inperson}
            virtual={virtual}
            readOnly={!responsesOpen}
            onInpersonPaint={onInpersonPaint}
            onVirtualPaint={onVirtualPaint}
            onCopy={onCopy}
          />
          {!responsesOpen && (
            <p style={{ margin: 0, color: "var(--md-sys-color-error)" }}>
              Organizer availability is locked while this event is not open or its deadline has
              passed.
            </p>
          )}
          <AppButton onClick={onSave} disabled={saving || !responsesOpen} icon={<MdSave />}>
            {saving ? "Saving..." : "Confirm"}
          </AppButton>
        </div>
      )}
    </div>
  );
}

export function ParticipantManagerPanel({
  activeParticipants,
  hiddenParticipants,
  filteredParticipants,
  groups,
  groupNames,
  searchQuery,
  setSearchQuery,
  showHidden,
  setShowHidden,
  hidingParticipantId,
  onGroupChange,
  onMoveParticipant,
  onHideParticipant,
  onUnhideParticipant,
}) {
  return (
    <div className="md-card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <h3 style={{ margin: 0, color: "var(--md-sys-color-on-surface)" }}>Participants</h3>
      </div>

      <md-outlined-text-field
        label="Search participants"
        value={searchQuery}
        onInput={(inputEvent) => setSearchQuery(inputEvent.target.value)}
        style={{ width: "100%", marginBottom: "16px" }}
      ></md-outlined-text-field>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {groupNames.map((groupName) => (
          <div key={groupName || "__ungrouped"}>
            {groupName && (
              <h4
                style={{
                  margin: "8px 0",
                  color: "var(--md-sys-color-secondary)",
                  fontSize: "0.95rem",
                }}
              >
                {groupName}
              </h4>
            )}
            {groups[groupName].map((participant) => {
              return (
                <div
                  key={participant.id}
                  data-management-participant-id={participant.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    padding: "16px",
                    border: "1px solid var(--md-sys-color-surface-variant)",
                    borderRadius: "12px",
                    backgroundColor: "var(--md-sys-color-surface-container-low)",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <strong style={{ fontWeight: "600", fontSize: "1.1rem" }}>
                        {participant.name}
                      </strong>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span
                        style={{
                          color: participant.submitted
                            ? "var(--md-sys-color-primary)"
                            : "var(--md-sys-color-outline)",
                        }}
                        title={participant.submitted ? "Submitted" : "Not submitted"}
                      >
                        {participant.submitted ? (
                          <GoVerified size={20} />
                        ) : (
                          <GoUnverified size={20} />
                        )}
                      </span>
                      <button
                        onClick={() => onMoveParticipant(participant.id, "up")}
                        title="Move up"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--md-sys-color-on-surface-variant)",
                          padding: "4px",
                        }}
                      >
                        <MdArrowUpward size={18} />
                      </button>
                      <button
                        onClick={() => onMoveParticipant(participant.id, "down")}
                        title="Move down"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--md-sys-color-on-surface-variant)",
                          padding: "4px",
                        }}
                      >
                        <MdArrowDownward size={18} />
                      </button>
                      <AppButton
                        variant="outlined"
                        icon={<MdDeleteOutline />}
                        onClick={() => onHideParticipant(participant)}
                        disabled={hidingParticipantId === participant.id}
                        className="app-btn-danger"
                      >
                        {hidingParticipantId === participant.id ? "Hiding..." : "Hide"}
                      </AppButton>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--md-sys-color-on-surface-variant)",
                      }}
                    >
                      Group
                    </span>
                    <input
                      type="text"
                      value={participant.group_name || ""}
                      onChange={(changeEvent) =>
                        onGroupChange(participant.id, changeEvent.target.value)
                      }
                      placeholder="(none)"
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: "1px solid var(--md-sys-color-outline)",
                        fontSize: "0.85rem",
                        background: "var(--md-sys-color-surface)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {activeParticipants.length === 0 && (
          <p
            style={{
              color: "var(--md-sys-color-on-surface-variant)",
              fontStyle: "italic",
              textAlign: "center",
            }}
          >
            No participants yet. Share the event link!
          </p>
        )}
      </div>

      {hiddenParticipants.length > 0 && (
        <div style={{ marginTop: "24px" }}>
          <button
            onClick={() => setShowHidden((value) => !value)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--md-sys-color-on-surface-variant)",
              fontSize: "0.9rem",
              fontWeight: "500",
              padding: 0,
            }}
          >
            {showHidden ? "▼" : "▶"} Hidden Participants ({hiddenParticipants.length})
          </button>
          {showHidden && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                marginTop: "12px",
              }}
            >
              {hiddenParticipants.map((participant) => (
                <div
                  key={participant.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 16px",
                    border: "1px solid var(--md-sys-color-surface-variant)",
                    borderRadius: "8px",
                    opacity: 0.6,
                  }}
                >
                  <span>{participant.name}</span>
                  <AppButton
                    variant="outlined"
                    onClick={() => onUnhideParticipant(participant)}
                    disabled={hidingParticipantId === participant.id}
                  >
                    {hidingParticipantId === participant.id ? "..." : "Unhide"}
                  </AppButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {filteredParticipants.length === 0 && activeParticipants.length > 0 && (
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>
          No participants match this search.
        </p>
      )}
    </div>
  );
}

export function IndividualSchedulesPanel({ event, mode, activeParticipants, weights }) {
  if (activeParticipants.length === 0) return null;

  return (
    <details className="md-card individual-schedules" style={{ marginBottom: "24px" }}>
      <summary>
        Individual Schedules <span>({activeParticipants.length})</span>
      </summary>
      <div className="individual-schedules__list">
        {activeParticipants.map((participant) => {
          const participantWeight = weights[participant.id] || {
            weight: 1,
            included: 1,
            required: 0,
          };
          return (
            <article key={participant.id}>
              <div className="individual-schedules__heading">
                <h4>{participant.name}</h4>
                <span>Weight: {Number(participantWeight.weight).toFixed(2)}</span>
              </div>
              <div className="individual-schedules__grids">
                {mode !== "virtual" && (
                  <ScheduleGrid
                    schedule={participant.inpersonArray}
                    slotGroups={event.slotGroups}
                    readOnly
                    showValues
                    label={mode === "mixed" ? "In-Person" : "Availability"}
                  />
                )}
                {mode !== "inperson" && (
                  <ScheduleGrid
                    schedule={participant.virtualArray}
                    slotGroups={event.slotGroups}
                    readOnly
                    showValues
                    label={mode === "mixed" ? "Virtual" : "Availability"}
                    virtual
                  />
                )}
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}
