"use client";

import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import { formatDateTimeInTimezone } from "@/lib/format";

/** Whole-list notice that some people are not counted in the results. */
export function LeftOutBanner({
  count,
  onShow,
  onCountEveryone,
  busy = false,
  readOnly = false,
}) {
  if (!count) return null;
  return (
    <Alert
      variant="info"
      role="status"
      className="participants-banner"
      actions={
        <>
          <AppButton variant="text" size="sm" className="p-0" onClick={onShow}>
            Show them
          </AppButton>
          <AppButton
            variant="text"
            size="sm"
            className="p-0"
            busy={busy}
            disabled={busy || readOnly}
            onClick={onCountEveryone}
          >
            Count everyone again
          </AppButton>
        </>
      }
    >
      {count === 1
        ? "1 person is left out of the results."
        : `${count} people are left out of the results.`}
    </Alert>
  );
}

/** Active event whose response deadline is in the past. */
export function DeadlineBanner({ deadline, onEdit }) {
  return (
    <Alert
      variant="warning"
      role="status"
      className="participants-banner"
      actions={
        onEdit ? (
          <AppButton variant="text" size="sm" className="p-0" onClick={onEdit}>
            Change deadline
          </AppButton>
        ) : null
      }
    >
      The response deadline ({formatDateTimeInTimezone(deadline)}) has passed,
      so people can&apos;t be added, invited or changed. You can still enter
      schedules for people you answer for.
    </Alert>
  );
}

/** Event that is not active: the list can be looked at but not changed. */
export function ReadOnlyBanner() {
  return (
    <Alert variant="secondary" role="status" className="participants-banner">
      Responses are closed, so this list is read-only. Reactivate the event to
      make changes.
    </Alert>
  );
}
