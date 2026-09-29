"use client";

import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import StatusBadge from "@/components/ui/StatusBadge";
import { EditIcon } from "@/components/ui/icons";
import { IconMenuButton } from "@/components/schedule/participants/MenuButton";
import { contactLine, responseBadge } from "@/lib/participants";

export const ROW_COLUMNS = 5;

function groupsText(participant) {
  if (participant.allGroups) return "Every group";
  const names = (participant.groups ?? []).map((group) => group.name);
  return names.length ? names.join(", ") : "";
}

/**
 * One participant: a two-line name block that opens the person panel, their
 * groups, the one response badge, the schedule action and the ⋯ menu. A
 * version conflict adds a notice row underneath.
 */
export default function ParticipantRow({
  participant,
  selected = false,
  selectable = true,
  readOnly = false,
  openLink = false,
  conflict = null,
  onToggleSelect,
  onOpen,
  onEditSchedule,
  onSendInvitation,
  onToggleIncluded,
  onRemove,
  onApplyAgain,
  onDismissConflict,
}) {
  const p = participant;
  const line = contactLine(p);
  const response = responseBadge(p, { openLink });
  const groups = groupsText(p);
  const answersThemselves = !p.canOrganizerEditAvailability && !p.isOrganizer;
  const columns = selectable ? ROW_COLUMNS : ROW_COLUMNS - 1;

  const menuItems = [
    { key: "details", label: "Details", onSelect: () => onOpen?.(p) },
    {
      key: "invite",
      label:
        p.invitationStatus !== "not_sent"
          ? "Resend invitation"
          : "Send invitation",
      hidden: Boolean(p.organizerManaged || p.isOrganizer),
      disabled: readOnly,
      onSelect: () => onSendInvitation?.(p),
    },
    {
      key: "included",
      label: p.included ? "Leave out of results" : "Count in results",
      disabled: readOnly,
      onSelect: () => onToggleIncluded?.(p),
    },
    {
      key: "remove",
      label: "Remove from event…",
      danger: true,
      disabled: readOnly,
      onSelect: () => onRemove?.(p),
    },
  ];

  return (
    <>
      {/* Roles are explicit because the narrow-screen layout changes the
          display of table parts, and some browsers then drop the semantics. */}
      <tr
        role="row"
        className={`participants-row${selected ? " participants-row--selected" : ""}`}
        data-roster-participant-id={p.id}
      >
        {selectable && (
          <td role="cell" className="participants-table__select">
            <input
              className="form-check-input"
              type="checkbox"
              aria-label={`Select ${p.name}`}
              checked={selected}
              disabled={readOnly}
              onChange={(event) => onToggleSelect?.(p.id, event.target.checked)}
            />
          </td>
        )}
        <th scope="row" role="rowheader" className="participants-table__name">
          <button
            type="button"
            className="participants-row__name"
            onClick={() => onOpen?.(p)}
          >
            <span className="participants-row__title">
              {p.name}
              {p.isOrganizer && " (you)"}
            </span>
            <span className="participants-row__meta">
              {line.text && (
                <span className="participants-row__contact">{line.text}</span>
              )}
              {line.tags.map((tag) => (
                <span key={tag} className="participants-tag">
                  {tag}
                </span>
              ))}
            </span>
          </button>
          {groups && (
            <span
              className="participants-row__groups-inline small text-secondary"
              aria-hidden="true"
            >
              {groups}
            </span>
          )}
        </th>
        <td role="cell" className="participants-table__groups">
          {groups || (
            <>
              <span className="text-secondary" aria-hidden="true">
                —
              </span>
              <span className="visually-hidden">No group</span>
            </>
          )}
        </td>
        <td role="cell" className="participants-table__response">
          <StatusBadge status={response.status}>{response.label}</StatusBadge>
        </td>
        <td role="cell" className="participants-table__actions">
          <div className="participants-row__actions">
            {answersThemselves ? (
              <span
                className="small text-secondary participants-row__self"
                title={`${p.name} answered with their own account, so only they can change it.`}
              >
                Answers themselves
              </span>
            ) : (
              <AppButton
                size="sm"
                variant="outlined"
                icon={<EditIcon />}
                onClick={() => onEditSchedule?.(p)}
              >
                {p.isOrganizer ? "Edit my schedule" : "Edit schedule"}
              </AppButton>
            )}
            <IconMenuButton
              ariaLabel={`Actions for ${p.name}`}
              items={menuItems}
            />
          </div>
        </td>
      </tr>
      {conflict && (
        <tr role="row" className="participants-row__notice">
          <td role="cell" colSpan={columns}>
            <Alert
              variant="warning"
              role="status"
              actions={
                <>
                  <AppButton
                    size="sm"
                    variant="outlined"
                    onClick={() => onApplyAgain?.(p)}
                  >
                    Apply again
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="text"
                    onClick={() => onDismissConflict?.(p)}
                  >
                    Dismiss
                  </AppButton>
                </>
              }
            >
              {conflict.message}
            </Alert>
          </td>
        </tr>
      )}
    </>
  );
}
