"use client";

import { EmailIcon, ReminderIcon, SendIcon } from "@/components/ui/icons";
import { formatDateTimeInTimezone } from "@/lib/format";
import MenuButton from "@/components/schedule/participants/MenuButton";

/**
 * The header's Email menu: invite everyone still uninvited, send reminders to
 * invited people who have not submitted, and a line saying when the next
 * automatic reminder goes out, in the event's zone with the zone named (as
 * the event details show the response deadline).
 */
export default function EmailMenu({
  notInvitedCount = 0,
  remindCount = 0,
  reminders = null,
  onInviteAll,
  onSendReminders,
  disabled = false,
}) {
  const nextAt =
    reminders?.enabled && reminders?.nextAt
      ? formatDateTimeInTimezone(reminders.nextAt, reminders.timezone, {
          timeZoneName: "short",
        })
      : null;
  return (
    <MenuButton
      label="Email"
      icon={<EmailIcon />}
      disabled={disabled}
      header={
        nextAt ? `Next automatic reminder: ${nextAt}` : "Reminders are off"
      }
      items={[
        {
          key: "invite",
          label: `Invite everyone not invited yet (${notInvitedCount})…`,
          icon: <SendIcon />,
          onSelect: onInviteAll,
        },
        {
          key: "remind",
          label: `Send reminders (${remindCount})…`,
          icon: <ReminderIcon />,
          // A run while reminders are off queues nobody.
          disabled: remindCount === 0 || !reminders?.enabled,
          onSelect: onSendReminders,
        },
      ]}
    />
  );
}
