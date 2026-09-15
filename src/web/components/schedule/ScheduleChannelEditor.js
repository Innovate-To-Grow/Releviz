"use client";

import { useId, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import { AvailabilityLegend } from "@/components/ui/Availability";
import { CopyIcon, GroupIcon, VirtualIcon } from "@/components/ui/icons";
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

/**
 * Single- or dual-channel availability editor.
 *
 * Mixed events keep independent In-person and Virtual schedules behind an
 * accessible tablist. Copying one channel over another asks for confirmation
 * whenever the target already contains availability.
 */
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
  legend = true,
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

  const tabs = [
    { key: "inperson", label: "In person", Icon: GroupIcon },
    { key: "virtual", label: "Virtual", Icon: VirtualIcon },
  ];

  return (
    <div className="schedule-channel-editor">
      {mode === "mixed" && (
        <div className="schedule-channel-editor__toolbar">
          <ul
            className="nav nav-pills schedule-channel-tabs"
            role="tablist"
            aria-label="Schedule channel"
          >
            {tabs.map(({ key, label, Icon }) => (
              <li className="nav-item" role="presentation" key={key}>
                <button
                  type="button"
                  role="tab"
                  className={`nav-link${activeChannel === key ? " active" : ""}`}
                  id={`${tabsId}-${key}-tab`}
                  aria-controls={`${tabsId}-${key}-panel`}
                  aria-selected={activeChannel === key}
                  tabIndex={activeChannel === key ? 0 : -1}
                  ref={(node) => {
                    tabRefs.current[key] = node;
                  }}
                  onClick={() => selectChannel(key)}
                  onKeyDown={handleTabKeyDown}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
          <AppButton
            variant="outlined"
            size="sm"
            icon={<CopyIcon />}
            onClick={requestCopy}
            disabled={readOnly || schedulesMatch(schedule, targetSchedule)}
          >
            Copy {channelLabel} to {targetLabel}
          </AppButton>
        </div>
      )}

      {pendingCopy && (
        <Alert
          variant="warning"
          role="alertdialog"
          aria-labelledby="schedule-copy-title"
          aria-describedby="schedule-copy-description"
          actions={
            <>
              <AppButton
                variant="filled"
                size="sm"
                onClick={() =>
                  copySchedule(pendingCopy.source, pendingCopy.target)
                }
              >
                Replace schedule
              </AppButton>
              <AppButton
                variant="outlined"
                size="sm"
                onClick={() => setPendingCopy(null)}
              >
                Cancel
              </AppButton>
            </>
          }
        >
          <strong id="schedule-copy-title" className="d-block mb-1">
            Replace {targetLabel} availability?
          </strong>
          <p id="schedule-copy-description" className="mb-0">
            This copies every {channelLabel} value and replaces the current{" "}
            {targetLabel} schedule.
          </p>
        </Alert>
      )}

      {legend && !showValues && (
        <AvailabilityLegend virtual={channel === "virtual"} />
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
          virtual={channel === "virtual"}
        />
      </div>
    </div>
  );
}
