"use client";

import { useState } from "react";
import AppButton from "@/components/ui/AppButton";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";

function schedulesMatch(first = [], second = []) {
  return (
    first.length === second.length &&
    first.every((value, index) => Number(value) === Number(second[index]))
  );
}

function hasAvailability(schedule = []) {
  return schedule.some((value) => Number(value) > 0);
}

export default function ScheduleChannelEditor({
  mode,
  slotGroups,
  inperson,
  virtual,
  readOnly,
  showValues = false,
  onInpersonPaint,
  onVirtualPaint,
  onCopy,
}) {
  const [activeChannel, setActiveChannel] = useState(
    mode === "virtual" ? "virtual" : "inperson",
  );
  const [pendingCopy, setPendingCopy] = useState(null);

  const schedules = { inperson, virtual };
  const channel = mode === "mixed" ? activeChannel : mode;
  const otherChannel = channel === "inperson" ? "virtual" : "inperson";
  const schedule = schedules[channel] || [];
  const targetSchedule = schedules[otherChannel] || [];
  const channelLabel = channel === "virtual" ? "Virtual" : "In-Person";
  const targetLabel = otherChannel === "virtual" ? "Virtual" : "In-Person";

  const copySchedule = (source, target) => {
    onCopy?.(source, target);
    setPendingCopy(null);
    setActiveChannel(target);
  };

  const requestCopy = () => {
    if (schedulesMatch(schedule, targetSchedule)) return;
    if (hasAvailability(targetSchedule)) {
      setPendingCopy({ source: channel, target: otherChannel });
      return;
    }
    copySchedule(channel, otherChannel);
  };

  return (
    <div className="schedule-channel-editor">
      {mode === "mixed" && (
        <div className="schedule-channel-editor__toolbar">
          <div
            className="schedule-channel-tabs"
            role="tablist"
            aria-label="Schedule channel"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeChannel === "inperson"}
              onClick={() => {
                setActiveChannel("inperson");
                setPendingCopy(null);
              }}
            >
              In person
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeChannel === "virtual"}
              onClick={() => {
                setActiveChannel("virtual");
                setPendingCopy(null);
              }}
            >
              Virtual
            </button>
          </div>
          <AppButton
            variant="outlined"
            onClick={requestCopy}
            disabled={readOnly || schedulesMatch(schedule, targetSchedule)}
          >
            Copy {channelLabel} to {targetLabel}
          </AppButton>
        </div>
      )}

      {pendingCopy && (
        <div
          className="schedule-copy-confirmation"
          role="alertdialog"
          aria-labelledby="schedule-copy-title"
          aria-describedby="schedule-copy-description"
        >
          <div>
            <strong id="schedule-copy-title">
              Replace {targetLabel} availability?
            </strong>
            <p id="schedule-copy-description">
              This copies every {channelLabel} value and replaces the current{" "}
              {targetLabel} schedule.
            </p>
          </div>
          <div>
            <AppButton
              variant="outlined"
              onClick={() =>
                copySchedule(pendingCopy.source, pendingCopy.target)
              }
            >
              Replace schedule
            </AppButton>
            <AppButton variant="outlined" onClick={() => setPendingCopy(null)}>
              Cancel
            </AppButton>
          </div>
        </div>
      )}

      <ScheduleGrid
        schedule={schedule}
        slotGroups={slotGroups}
        readOnly={readOnly}
        showValues={showValues}
        onCellPaint={channel === "virtual" ? onVirtualPaint : onInpersonPaint}
        label={mode === "mixed" ? channelLabel : undefined}
        virtual={channel === "virtual"}
      />
    </div>
  );
}
