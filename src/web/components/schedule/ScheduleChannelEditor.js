"use client";

import { useId, useRef, useState } from "react";
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
  const tabsId = useId();
  const tabRefs = useRef({});

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

  const selectChannel = (nextChannel, { focus = false } = {}) => {
    setActiveChannel(nextChannel);
    setPendingCopy(null);
    if (focus) tabRefs.current[nextChannel]?.focus();
  };

  const handleTabKeyDown = (event) => {
    const channels = ["inperson", "virtual"];
    const currentIndex = channels.indexOf(activeChannel);
    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % channels.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + channels.length) % channels.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = channels.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectChannel(channels[nextIndex], { focus: true });
  };

  return (
    <div>
      {mode === "mixed" && (
        <div>
          <div role="tablist" aria-label="Schedule channel">
            <button
              type="button"
              role="tab"
              id={`${tabsId}-inperson-tab`}
              aria-controls={`${tabsId}-inperson-panel`}
              aria-selected={activeChannel === "inperson"}
              tabIndex={activeChannel === "inperson" ? 0 : -1}
              ref={(node) => {
                tabRefs.current.inperson = node;
              }}
              onClick={() => selectChannel("inperson")}
              onKeyDown={handleTabKeyDown}
            >
              In person
            </button>
            <button
              type="button"
              role="tab"
              id={`${tabsId}-virtual-tab`}
              aria-controls={`${tabsId}-virtual-panel`}
              aria-selected={activeChannel === "virtual"}
              tabIndex={activeChannel === "virtual" ? 0 : -1}
              ref={(node) => {
                tabRefs.current.virtual = node;
              }}
              onClick={() => selectChannel("virtual")}
              onKeyDown={handleTabKeyDown}
            >
              Virtual
            </button>
          </div>
          <AppButton
            onClick={requestCopy}
            disabled={readOnly || schedulesMatch(schedule, targetSchedule)}
          >
            Copy {channelLabel} to {targetLabel}
          </AppButton>
        </div>
      )}

      {pendingCopy && (
        <div
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
              onClick={() =>
                copySchedule(pendingCopy.source, pendingCopy.target)
              }
            >
              Replace schedule
            </AppButton>
            <AppButton onClick={() => setPendingCopy(null)}>Cancel</AppButton>
          </div>
        </div>
      )}

      <div
        role={mode === "mixed" ? "tabpanel" : undefined}
        id={mode === "mixed" ? `${tabsId}-${channel}-panel` : undefined}
        aria-labelledby={
          mode === "mixed" ? `${tabsId}-${channel}-tab` : undefined
        }
      >
        <ScheduleGrid
          schedule={schedule}
          slotGroups={slotGroups}
          readOnly={readOnly}
          showValues={showValues}
          onCellPaint={channel === "virtual" ? onVirtualPaint : onInpersonPaint}
          label={mode === "mixed" ? channelLabel : undefined}
        />
      </div>
    </div>
  );
}
