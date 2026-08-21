"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import ScheduleGrid from "@/components/schedule/ScheduleGrid";

const CHANNEL_TABS = [
  { id: "inperson", label: "In person" },
  { id: "virtual", label: "Virtual" },
];

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
 * Availability editor for one or both meeting channels. In mixed mode the two
 * channels are separate tab panels, and copying between them asks first when
 * the target already has answers.
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
}) {
  const [activeChannel, setActiveChannel] = useState(
    mode === "virtual" ? "virtual" : "inperson",
  );
  const [pendingCopy, setPendingCopy] = useState(null);
  const tabsId = useId();

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

  const grid = (
    <ScheduleGrid
      schedule={schedule}
      slotGroups={slotGroups}
      readOnly={readOnly}
      showValues={showValues}
      onCellPaint={channel === "virtual" ? onVirtualPaint : onInpersonPaint}
      label={mode === "mixed" ? channelLabel : undefined}
    />
  );

  return (
    <div className="rv-stack rv-stack--md">
      {mode === "mixed" && (
        <div className="rv-split">
          <Tabs
            label="Schedule channel"
            tabs={CHANNEL_TABS}
            activeId={activeChannel}
            idPrefix={tabsId}
            onChange={(nextChannel) => {
              setActiveChannel(nextChannel);
              setPendingCopy(null);
            }}
          />
          <Button
            size="sm"
            icon="copy"
            onClick={requestCopy}
            disabled={readOnly || schedulesMatch(schedule, targetSchedule)}
          >
            Copy {channelLabel} to {targetLabel}
          </Button>
        </div>
      )}

      {pendingCopy && (
        <div
          role="alertdialog"
          aria-labelledby="schedule-copy-title"
          aria-describedby="schedule-copy-description"
          className="rv-callout rv-callout--warning"
        >
          <div className="rv-callout__body">
            <p className="rv-callout__title" id="schedule-copy-title">
              Replace {targetLabel} availability?
            </p>
            <p id="schedule-copy-description">
              This copies every {channelLabel} value and replaces the current{" "}
              {targetLabel} schedule.
            </p>
            <div className="rv-btn-row">
              <Button
                variant="primary"
                onClick={() =>
                  copySchedule(pendingCopy.source, pendingCopy.target)
                }
              >
                Replace schedule
              </Button>
              <Button onClick={() => setPendingCopy(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {mode === "mixed" ? (
        <TabPanel idPrefix={tabsId} id={channel}>
          {grid}
        </TabPanel>
      ) : (
        grid
      )}
    </div>
  );
}
