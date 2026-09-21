"use client";

import { useId, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import { AvailabilityLegend } from "@/components/ui/Availability";
import { CopyIcon, GroupIcon, VirtualIcon } from "@/components/ui/icons";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";

function blockedSlotIndices(slotGroups) {
  const blocked = new Set();
  for (const group of Array.isArray(slotGroups) ? slotGroups : []) {
    for (const slot of group?.slots || []) {
      if (slot?.blocked) blocked.add(slot.index);
    }
  }
  return blocked;
}

// Organizer-blocked indices are hidden in the grid and ignored by results,
// so they never drive the copy button or the replace confirmation.
function schedulesMatch(first = [], second = [], blocked = new Set()) {
  return (
    first.length === second.length &&
    first.every(
      (value, index) =>
        blocked.has(index) || Number(value) === Number(second[index]),
    )
  );
}

function hasAvailability(schedule = [], blocked = new Set()) {
  return schedule.some(
    (value, index) => !blocked.has(index) && Number(value) > 0,
  );
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
  // Organizer-blocked slots render grey-striped in the grid, so the legend
  // needs a "Blocked" item even when the availability legend is hidden.
  const blockedIndices = blockedSlotIndices(slotGroups);
  const hasBlocked = blockedIndices.size > 0;

  const copySchedule = (source, target) => {
    onCopy?.(source, target);
    setPendingCopy(null);
    setActiveChannel(target);
  };

  const requestCopy = () => {
    if (schedulesMatch(schedule, targetSchedule, blockedIndices)) return;
    if (hasAvailability(targetSchedule, blockedIndices)) {
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
            disabled={
              readOnly ||
              schedulesMatch(schedule, targetSchedule, blockedIndices)
            }
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

      {!showValues &&
        (legend ? (
          <AvailabilityLegend
            virtual={channel === "virtual"}
            hasBlocked={hasBlocked}
          />
        ) : hasBlocked ? (
          <AvailabilityLegend
            virtual={channel === "virtual"}
            hasBlocked
            blockedOnly
          />
        ) : null)}

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
