"use client";

import { useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import Modal from "@/components/ui/Modal";
import { CheckIcon } from "@/components/ui/icons";

// A person whose name comes from their own account (they joined, or it is the
// organizer's row) keeps it; everyone the organizer still answers for can be
// renamed.
export function nameEditable(participant) {
  return (
    !participant.isOrganizer &&
    Boolean(
      participant.organizerManaged || participant.canOrganizerEditAvailability,
    )
  );
}

export function detailsEditable(participant) {
  return (
    nameEditable(participant) || Boolean(participant.canOrganizerEditEmail)
  );
}

function nameError(value) {
  const name = String(value || "").trim();
  if (!name) return "Full name is required.";
  if (name.length > 100) return "Full name must be 100 characters or fewer.";
  return "";
}

function emailError(value, { required }) {
  const email = String(value || "").trim();
  if (!email) return required ? "Email address is required." : "";
  if (email.length > 254)
    return "Email address must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return "Enter a valid email address.";
  return "";
}

function lockedEmailHelp(participant) {
  if (participant.isOrganizer)
    return "Your own address comes from your account settings.";
  return "They have already signed in or answered, so their address can no longer be changed. Remove them and add them again if it is wrong.";
}

/**
 * Correct a roster entry's name and email. The email can change only until
 * the person signs in or answers; a new address gets a fresh, unsent
 * invitation. A person with no email of their own gets one here, which makes
 * them invitable. Only changed fields are sent.
 */
export default function RosterPersonDialog({
  participant,
  busy = false,
  error = "",
  onSave,
  onClose,
}) {
  const managed = Boolean(participant.organizerManaged);
  const initialEmail = managed ? "" : participant.email || "";
  const canRename = nameEditable(participant);
  const canChangeEmail = Boolean(participant.canOrganizerEditEmail);
  const [name, setName] = useState(participant.name || "");
  const [email, setEmail] = useState(initialEmail);
  const [errors, setErrors] = useState({});

  const submit = (submitEvent) => {
    submitEvent.preventDefault();
    const nextErrors = {
      name: canRename ? nameError(name) : "",
      email: canChangeEmail ? emailError(email, { required: !managed }) : "",
    };
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.email) return;
    const updates = {};
    if (canRename && name.trim() !== participant.name)
      updates.name = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (canChangeEmail && normalizedEmail && normalizedEmail !== initialEmail)
      updates.email = normalizedEmail;
    onSave(updates);
  };

  return (
    <Modal
      as="form"
      title={`Edit ${participant.name}`}
      description="Fix a name or an email address entered by mistake."
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      noValidate
      footer={
        <>
          <AppButton variant="text" onClick={onClose} disabled={busy}>
            Cancel
          </AppButton>
          <AppButton
            type="submit"
            icon={<CheckIcon />}
            busy={busy}
            disabled={busy}
          >
            Save details
          </AppButton>
        </>
      }
    >
      <div className="d-flex flex-column gap-3">
        <FormField
          id="roster-person-name"
          label="Full name"
          required={canRename}
          help={
            canRename
              ? null
              : participant.isOrganizer
                ? "Your name comes from your account settings."
                : "They set their own name in their Releviz account."
          }
          error={errors.name || null}
          errorId="roster-person-name-error"
        >
          <input
            type="text"
            className="form-control"
            autoComplete="off"
            maxLength={100}
            value={name}
            disabled={busy || !canRename}
            data-autofocus={canRename ? true : undefined}
            onChange={(changeEvent) => {
              setName(changeEvent.target.value);
              setErrors((current) => ({ ...current, name: "" }));
            }}
          />
        </FormField>
        <FormField
          id="roster-person-email"
          label="Email address"
          required={canChangeEmail && !managed}
          optional={canChangeEmail && managed}
          help={
            !canChangeEmail
              ? lockedEmailHelp(participant)
              : managed
                ? "They have no email of their own yet. Add one to invite them later; their schedule stays as you entered it."
                : "A new address gets a fresh invitation that is not sent until you send it."
          }
          error={errors.email || null}
          errorId="roster-person-email-error"
        >
          <input
            type="email"
            className="form-control"
            inputMode="email"
            autoComplete="off"
            maxLength={254}
            placeholder={managed ? "No email" : undefined}
            value={email}
            disabled={busy || !canChangeEmail}
            data-autofocus={!canRename && canChangeEmail ? true : undefined}
            onChange={(changeEvent) => {
              setEmail(changeEvent.target.value);
              setErrors((current) => ({ ...current, email: "" }));
            }}
          />
        </FormField>
        {error && (
          <Alert variant="danger" role="alert" className="mb-0">
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
