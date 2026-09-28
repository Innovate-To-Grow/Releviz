"use client";

import MixedCheckbox from "@/components/schedule/participants/MixedCheckbox";
import ParticipantRow, {
  ROW_COLUMNS,
} from "@/components/schedule/participants/ParticipantRow";
import { peopleCount } from "@/lib/participants";

/**
 * The participant list: a sticky-header table with page selection, a helper
 * row for extending the selection to everyone matching the filter, and one
 * ParticipantRow per person. Empty and loading states belong to the parent.
 */
export default function ParticipantTable({
  participants = [],
  selectedIds = new Set(),
  selectAllMode = false,
  selectable = true,
  total = participants.length,
  conflicts = {},
  readOnly = false,
  onToggleSelect,
  onTogglePage,
  onSelectAllMatching,
  onOpen,
  onEditSchedule,
  onSendInvitation,
  onToggleIncluded,
  onRemove,
  onApplyAgain,
  onDismissConflict,
}) {
  const pageCount = participants.length;
  const selectedOnPage = participants.filter((participant) =>
    selectedIds.has(participant.id),
  ).length;
  const allOnPageSelected = pageCount > 0 && selectedOnPage === pageCount;
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected;
  const columns = selectable ? ROW_COLUMNS : ROW_COLUMNS - 1;

  let helper = null;
  if (selectAllMode)
    helper = `Everyone matching the filter is selected (${total}).`;
  else if (allOnPageSelected && total > pageCount)
    helper = (
      <>
        All {peopleCount(pageCount)} on this page are selected.{" "}
        <button
          type="button"
          className="btn btn-link btn-sm p-0 align-baseline"
          onClick={onSelectAllMatching}
        >
          Select all {total} matching
        </button>
      </>
    );

  return (
    <div className="table-shell participants-table-shell">
      {/* The table scrolls sideways on narrow screens, so the wrapper is a
          focusable region for keyboard users. */}
      <div
        className="table-responsive"
        role="region"
        aria-label="Participant table"
        tabIndex={0}
      >
        <table className="table align-middle participants-table">
          <caption className="visually-hidden">Participants</caption>
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="participants-table__select">
                  <MixedCheckbox
                    className="form-check-input"
                    aria-label="Select everyone on this page"
                    checked={allOnPageSelected}
                    mixed={someOnPageSelected}
                    disabled={readOnly || pageCount === 0}
                    onChange={(event) => onTogglePage?.(event.target.checked)}
                  />
                </th>
              )}
              <th scope="col" className="participants-table__name">
                Name
              </th>
              <th scope="col" className="participants-table__groups">
                Groups
              </th>
              <th scope="col" className="participants-table__response">
                Response
              </th>
              <th scope="col" className="participants-table__invitation">
                Invitation
              </th>
              <th scope="col" className="participants-table__actions">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {helper && (
              <tr className="participants-table__helper">
                <td colSpan={columns}>
                  <p className="small text-secondary mb-0" role="status">
                    {helper}
                  </p>
                </td>
              </tr>
            )}
            {participants.map((participant) => (
              <ParticipantRow
                key={participant.id}
                participant={participant}
                selected={selectedIds.has(participant.id)}
                selectable={selectable}
                readOnly={readOnly}
                conflict={conflicts[participant.id] ?? null}
                onToggleSelect={onToggleSelect}
                onOpen={onOpen}
                onEditSchedule={onEditSchedule}
                onSendInvitation={onSendInvitation}
                onToggleIncluded={onToggleIncluded}
                onRemove={onRemove}
                onApplyAgain={onApplyAgain}
                onDismissConflict={onDismissConflict}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
