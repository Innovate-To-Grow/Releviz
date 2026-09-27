"use client";

import { useId, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import FormField from "@/components/ui/FormField";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EditIcon,
  SendIcon,
} from "@/components/ui/icons";
import Drawer from "@/components/schedule/participants/Drawer";
import { formatDateTimeInTimezone } from "@/lib/format";
import {
  accountLine,
  buildGroupUpdates,
  emailError,
  formatWeight,
  invitationBadge,
  nameEditable,
  nameError,
  phoneError,
  weightError,
} from "@/lib/participants";

function draftFrom(participant) {
  return {
    name: participant.name || "",
    email: participant.organizerManaged ? "" : participant.email || "",
    phone: participant.phone || "",
    included: participant.included !== false,
    weight: formatWeight(participant.weight ?? 1),
    allGroups: Boolean(participant.allGroups),
    groupIds: (participant.groups ?? []).map((group) => group.id),
  };
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const known = new Set(left);
  return right.every((id) => known.has(id));
}

// Only what the organizer touched, normalised the way the API stores it.
function changesBetween(initial, draft, { canRename, canChangeEmail }) {
  const changes = {};
  const name = draft.name.trim();
  if (canRename && name !== initial.name) changes.name = name;
  const email = draft.email.trim().toLowerCase();
  if (canChangeEmail && email !== initial.email) changes.email = email;
  const phone = draft.phone.trim();
  if (phone !== initial.phone) changes.phone = phone;
  if (draft.included !== initial.included) changes.included = draft.included;
  if (String(draft.weight).trim() !== initial.weight)
    changes.weight = Number(draft.weight);
  if (
    draft.allGroups !== initial.allGroups ||
    !sameIds(initial.groupIds, draft.groupIds)
  )
    Object.assign(
      changes,
      buildGroupUpdates(
        { allGroups: initial.allGroups, groupIds: initial.groupIds },
        { allGroups: draft.allGroups, groupIds: draft.groupIds },
      ),
    );
  return changes;
}

/**
 * Side drawer with everything about one participant: contact details,
 * groups, whether and how much they count, and their invitation. Save sends
 * only the fields that changed; closing or moving to another person with
 * unsaved edits asks first.
 */
export default function PersonPanel(props) {
  if (!props.participant) return null;
  return <PersonPanelForm key={props.participant.id} {...props} />;
}

function PersonPanelForm({
  participant,
  groups = [],
  position = null,
  onPrev,
  onNext,
  busy = false,
  error = "",
  conflict = null,
  readOnly = false,
  deadlinePassed = false,
  onSave,
  onClose,
  onEditSchedule,
  onSendInvitation,
  onRemove,
  onOpenGroupPicker,
}) {
  const ids = useId();
  const p = participant;
  const [initial, setInitial] = useState(() => draftFrom(p));
  const [draft, setDraft] = useState(() => draftFrom(p));
  const [errors, setErrors] = useState({});
  const [localError, setLocalError] = useState("");
  const [pending, setPending] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const canRename = nameEditable(p);
  const canChangeEmail = Boolean(p.canOrganizerEditEmail);
  const managed = Boolean(p.organizerManaged);
  const locked = busy || readOnly || deadlinePassed;
  const changes = changesBetween(initial, draft, { canRename, canChangeEmail });
  const dirty = Object.keys(changes).length > 0;
  const invitation = invitationBadge(p);
  const answersThemselves = !p.canOrganizerEditAvailability && !p.isOrganizer;
  const title = p.isOrganizer ? `${p.name} (you)` : p.name;

  const update = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const guard = (action) => {
    if (dirty) setPending(action);
    else if (action === "prev") onPrev?.();
    else if (action === "next") onNext?.();
    else onClose?.();
  };

  const confirmPending = () => {
    const action = pending;
    setPending(null);
    setDraft(initial);
    if (action === "prev") onPrev?.();
    else if (action === "next") onNext?.();
    else onClose?.();
  };

  const save = async (submitEvent) => {
    submitEvent.preventDefault();
    if (locked || !dirty) return;
    const nextErrors = {
      name: canRename ? nameError(draft.name) : "",
      email: canChangeEmail
        ? emailError(draft.email, { required: !managed })
        : "",
      phone: phoneError(draft.phone),
      weight: weightError(draft.weight),
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    setLocalError("");
    try {
      await onSave(changes);
      const saved = {
        ...draft,
        name: draft.name.trim(),
        email: draft.email.trim().toLowerCase(),
        phone: draft.phone.trim(),
        weight: formatWeight(draft.weight),
      };
      setInitial(saved);
      setDraft(saved);
    } catch (caught) {
      setLocalError(caught?.message || "The changes could not be saved.");
    }
  };

  const openGroupPicker = async () => {
    setPickerOpen(true);
    try {
      const result = await onOpenGroupPicker({
        allGroups: draft.allGroups ? "all" : "none",
        byGroup: Object.fromEntries(draft.groupIds.map((id) => [id, "all"])),
      });
      if (!result) return;
      setDraft((current) => {
        const remove = new Set(result.removeGroupIds ?? []);
        const groupIds = current.groupIds.filter((id) => !remove.has(id));
        (result.addGroupIds ?? []).forEach((id) => {
          if (!groupIds.includes(id)) groupIds.push(id);
        });
        return {
          ...current,
          groupIds,
          allGroups:
            typeof result.allGroups === "boolean"
              ? result.allGroups
              : current.allGroups,
        };
      });
    } finally {
      setPickerOpen(false);
    }
  };

  const groupName = (id) =>
    groups.find((group) => group.id === id)?.name ??
    p.groups?.find((group) => group.id === id)?.name ??
    `Group ${id}`;

  const nameHelp = canRename
    ? null
    : p.isOrganizer
      ? "From your account settings"
      : "They set their own name in their Releviz account.";
  const emailHelp = canChangeEmail
    ? managed
      ? "They are never emailed until they have an address of their own."
      : null
    : p.isOrganizer
      ? "From your account settings"
      : `${p.name} already signed in, so this address can't change. Remove ${p.name} and add them again if it is wrong.`;

  const sentOn = p.invitationSentAt
    ? `Sent on ${formatDateTimeInTimezone(p.invitationSentAt)}`
    : invitation.label;

  return (
    <>
      <Drawer
        title={title}
        subtitle={accountLine(p)}
        eyebrow={
          position ? (
            <div className="participants-person__nav">
              <button
                type="button"
                className="btn btn-link btn-sm p-0 participants-person__nav-button"
                aria-label="Previous person"
                disabled={busy || position.index <= 0}
                onClick={() => guard("prev")}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <span className="participants-person__position">
                {position.index + 1} of {position.total}
              </span>
              <button
                type="button"
                className="btn btn-link btn-sm p-0 participants-person__nav-button"
                aria-label="Next person"
                disabled={busy || position.index >= position.total - 1}
                onClick={() => guard("next")}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </div>
          ) : null
        }
        onClose={() => guard("close")}
        busy={busy}
        dialogOpen={pending !== null || pickerOpen}
        closeLabel="Close details"
        className="participants-person-panel"
        footer={
          <>
            <AppButton
              variant="danger"
              className="me-auto"
              disabled={locked}
              onClick={() => onRemove?.(p)}
            >
              Remove from event…
            </AppButton>
            <AppButton
              variant="text"
              onClick={() => guard("close")}
              disabled={busy}
            >
              Cancel
            </AppButton>
            <AppButton
              type="submit"
              form={`${ids}-form`}
              icon={<CheckIcon />}
              busy={busy}
              disabled={locked || !dirty}
            >
              Save
            </AppButton>
          </>
        }
      >
        {conflict && (
          <Alert variant="warning" role="status">
            {conflict.message}
          </Alert>
        )}
        {(error || localError) && (
          <Alert variant="danger" role="alert">
            {error || localError}
          </Alert>
        )}
        <div className="participants-person__schedule">
          {answersThemselves ? (
            <span
              className="small text-secondary"
              title={`${p.name} answered with their own account, so only they can change it.`}
            >
              Answers themselves
            </span>
          ) : (
            <AppButton
              size="sm"
              variant="outlined"
              icon={<EditIcon />}
              disabled={busy}
              onClick={() => onEditSchedule?.(p)}
            >
              {p.isOrganizer ? "Edit my schedule" : "Edit schedule"}
            </AppButton>
          )}
        </div>

        <form
          id={`${ids}-form`}
          className="participants-person__form"
          noValidate
          onSubmit={save}
        >
          <section
            className="participants-person__section"
            aria-labelledby={`${ids}-contact`}
          >
            <h3 id={`${ids}-contact`} className="h6">
              Contact
            </h3>
            <FormField
              id={`${ids}-name`}
              label="Full name"
              required={canRename}
              help={nameHelp}
              error={errors.name || null}
            >
              <input
                type="text"
                className="form-control"
                autoComplete="off"
                maxLength={100}
                value={draft.name}
                disabled={locked || !canRename}
                onChange={(event) => update("name", event.target.value)}
              />
            </FormField>
            <FormField
              id={`${ids}-email`}
              label="Email"
              required={canChangeEmail && !managed}
              help={emailHelp}
              error={errors.email || null}
            >
              <input
                type="email"
                className="form-control"
                inputMode="email"
                autoComplete="off"
                maxLength={254}
                placeholder={
                  managed ? "Add their email to invite them" : undefined
                }
                value={draft.email}
                disabled={locked || !canChangeEmail}
                onChange={(event) => update("email", event.target.value)}
              />
            </FormField>
            <FormField
              id={`${ids}-phone`}
              label="Phone"
              help="Never used to contact them"
              error={errors.phone || null}
            >
              <input
                type="tel"
                className="form-control"
                inputMode="tel"
                autoComplete="off"
                maxLength={32}
                value={draft.phone}
                disabled={locked}
                onChange={(event) => update("phone", event.target.value)}
              />
            </FormField>
          </section>

          <section
            className="participants-person__section"
            aria-labelledby={`${ids}-groups`}
          >
            <h3 id={`${ids}-groups`} className="h6">
              Groups
            </h3>
            <ul
              className="participants-chips list-unstyled"
              aria-label="Groups"
            >
              {draft.allGroups ? (
                <li>
                  <span className="participants-chip participants-chip--static">
                    Every group, including groups added later
                  </span>
                </li>
              ) : draft.groupIds.length ? (
                draft.groupIds.map((id) => (
                  <li key={id}>
                    <span className="participants-chip participants-chip--static">
                      {groupName(id)}
                    </span>
                  </li>
                ))
              ) : (
                <li className="small text-secondary">No group</li>
              )}
            </ul>
            <AppButton
              variant="text"
              size="sm"
              className="p-0"
              disabled={locked || pickerOpen}
              onClick={() => void openGroupPicker()}
            >
              + Add to group
            </AppButton>
          </section>

          <section
            className="participants-person__section"
            aria-labelledby={`${ids}-results`}
          >
            <h3 id={`${ids}-results`} className="h6">
              In the results
            </h3>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id={`${ids}-included`}
                checked={draft.included}
                disabled={locked}
                onChange={(event) => update("included", event.target.checked)}
              />
              <label className="form-check-label" htmlFor={`${ids}-included`}>
                Count {p.name}&apos;s answers
              </label>
            </div>
            <FormField
              id={`${ids}-weight`}
              label="Weight"
              help={`At 0, ${p.name} counts only in the unweighted score.`}
              error={errors.weight || null}
              className="participants-person__weight"
            >
              <input
                type="number"
                className="form-control"
                inputMode="decimal"
                min="0"
                max="1"
                step="0.05"
                value={draft.weight}
                disabled={locked}
                onChange={(event) => update("weight", event.target.value)}
              />
            </FormField>
          </section>

          {!p.isOrganizer && !managed && (
            <section
              className="participants-person__section"
              aria-labelledby={`${ids}-invitation`}
            >
              <h3 id={`${ids}-invitation`} className="h6">
                Invitation
              </h3>
              <div className="d-flex flex-wrap align-items-center gap-2">
                <StatusBadge status={invitation.status}>
                  {p.invitationStatus === "sent" && !p.invitationDelivery
                    ? sentOn
                    : invitation.label}
                </StatusBadge>
                <AppButton
                  size="sm"
                  variant="outlined"
                  icon={<SendIcon />}
                  disabled={locked || p.invitationDelivery === "queued"}
                  onClick={() => onSendInvitation?.(p)}
                >
                  {p.invitationStatus === "not_sent"
                    ? "Send invitation"
                    : "Resend"}
                </AppButton>
              </div>
            </section>
          )}
        </form>
      </Drawer>
      {pending && (
        <ConfirmDialog
          title="Discard your changes?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={confirmPending}
          onClose={() => setPending(null)}
        >
          <p className="mb-0">
            Your changes to {p.name} haven&apos;t been saved.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
