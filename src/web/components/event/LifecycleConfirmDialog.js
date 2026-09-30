"use client";

import ConfirmDialog from "@/components/ui/ConfirmDialog";

/**
 * What closing or archiving an event does, put to the organizer before it
 * happens. Reactivating undoes either, but neither is free: people stop being
 * able to respond, and invitation and reminder emails still waiting to go out
 * are canceled for good.
 */
export default function LifecycleConfirmDialog({
  action,
  event,
  busy = false,
  onConfirm,
  onClose,
}) {
  const archiving = action === "archived";
  const wasAccepting = event.status === "active";

  return (
    <ConfirmDialog
      title={archiving ? "Archive this event?" : "Close responses?"}
      confirmLabel={archiving ? "Archive event" : "Close responses"}
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {archiving ? (
        <>
          <p>
            The event becomes read-only and moves to Archived on your dashboard.
            {wasAccepting && " People can no longer respond."}
          </p>
          {event.finalMeeting ? (
            <p className="mb-0">
              The confirmed meeting stays as it is and nobody is emailed.
              Reactivating the event later cancels it and emails the people it
              reached.
            </p>
          ) : (
            <p className="mb-0">
              {wasAccepting &&
                "Invitation and reminder emails still waiting to go out are canceled. "}
              Nobody is emailed about the change, and you can reactivate the
              event at any time.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            Nobody can submit or change a schedule while responses are closed,
            and the participant list becomes read-only. You can still pick and
            finalize a time.
          </p>
          <p className="mb-0">
            Invitation and reminder emails still waiting to go out are canceled
            and automatic reminders stop. Nobody is emailed about the change,
            and you can reactivate the event at any time.
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}
