"use client";

import { useEffect, useId, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import AppButton from "@/components/ui/AppButton";
import FormField from "@/components/ui/FormField";
import { AddIcon, SendIcon } from "@/components/ui/icons";
import Drawer from "@/components/schedule/participants/Drawer";
import { emailError, nameError, phoneError } from "@/lib/participants";

function resultLine(result) {
  const name = result.participant?.name || "They";
  if (result.alreadyExisted)
    return `${name} is already on the list, so nothing was added.`;
  if (result.participant?.organizerManaged) return `${name} was added.`;
  if (result.autoInvited)
    return `${name} was added and their invitation is queued.`;
  return `${name} was added. No invitation was sent.`;
}

/**
 * Side drawer for adding people one after another. Each attempt carries one
 * idempotency key that survives a retry of the same values and is replaced
 * as soon as a field changes or the add succeeds. After a success the
 * fields clear, Full name gets focus and the outcome is shown at the top.
 */
export default function AddPersonPanel({
  organizerEmail = "",
  addMyselfAvailable = false,
  readOnly = false,
  onAdd,
  onOpenPerson,
  onEnterSchedule,
  onAddMyself,
  onSendInvitation = null,
  onClose,
}) {
  const ids = useId();
  const formId = `${ids}-form`;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [noEmail, setNoEmail] = useState(false);
  const [errors, setErrors] = useState({});
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  // Bumped after a successful add so Full name is focused once the form is
  // enabled again (a disabled input cannot take focus).
  const [focusName, setFocusName] = useState(0);
  const keyRef = useRef("");
  const nameInput = useRef(null);
  const emailInput = useRef(null);
  const phoneInput = useRef(null);

  const busy = Boolean(busyAction);
  const locked = busy || readOnly;

  useEffect(() => {
    if (focusName) nameInput.current?.focus();
  }, [focusName]);

  const change = (setter, field) => (event) => {
    const value =
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.value;
    setter(value);
    keyRef.current = "";
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const submit = async (sendInvitation) => {
    if (locked) return;
    const nextErrors = {
      name: nameError(name),
      email: noEmail ? "" : emailError(email, { required: true }),
      phone: phoneError(phone),
    };
    setErrors(nextErrors);
    if (nextErrors.name) {
      nameInput.current?.focus();
      return;
    }
    if (nextErrors.email) {
      emailInput.current?.focus();
      return;
    }
    if (nextErrors.phone) {
      phoneInput.current?.focus();
      return;
    }
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    setBusyAction(sendInvitation ? "send" : "add");
    setError("");
    try {
      const outcome = await onAdd({
        name: name.trim(),
        email: noEmail ? "" : email.trim().toLowerCase(),
        phone: phone.trim(),
        organizerManaged: noEmail,
        sendInvitation: sendInvitation && !noEmail,
        idempotencyKey: keyRef.current,
      });
      setResult(outcome);
      keyRef.current = "";
      setName("");
      setEmail("");
      setPhone("");
      setErrors({});
      setFocusName((count) => count + 1);
    } catch (caught) {
      setError(caught?.message || "The person could not be added.");
    } finally {
      setBusyAction("");
    }
  };

  const added = result?.participant;
  const canSendLater =
    Boolean(added) &&
    result.alreadyExisted &&
    Boolean(onSendInvitation) &&
    !added.organizerManaged &&
    added.invitationStatus === "not_sent";

  return (
    <Drawer
      title="Add a person"
      onClose={onClose}
      busy={busy}
      closeLabel="Close add person"
      className="participants-add-panel"
      footer={
        <>
          {addMyselfAvailable && (
            <p className="small text-secondary mb-0 me-auto align-self-center">
              Answering this event yourself?{" "}
              <button
                type="button"
                className="btn btn-link btn-sm p-0 align-baseline"
                disabled={locked}
                onClick={onAddMyself}
              >
                Add myself
              </button>
            </p>
          )}
          <AppButton variant="text" onClick={onClose} disabled={busy}>
            Done
          </AppButton>
          {!noEmail && (
            <AppButton
              variant="outlined"
              icon={<SendIcon />}
              busy={busyAction === "send"}
              disabled={locked}
              onClick={() => void submit(true)}
            >
              Add and send invitation
            </AppButton>
          )}
          <AppButton
            type="submit"
            form={formId}
            icon={<AddIcon />}
            busy={busyAction === "add"}
            disabled={locked}
          >
            Add
          </AppButton>
        </>
      }
    >
      {result && (
        <Alert
          variant="success"
          role="status"
          className="participants-add-panel__result"
          actions={
            <>
              {added && added.organizerManaged && !result.alreadyExisted ? (
                <AppButton
                  variant="text"
                  size="sm"
                  className="p-0"
                  onClick={() => onEnterSchedule?.(added)}
                >
                  Enter their schedule
                </AppButton>
              ) : added ? (
                <AppButton
                  variant="text"
                  size="sm"
                  className="p-0"
                  onClick={() => onOpenPerson?.(added)}
                >
                  Open
                </AppButton>
              ) : null}
              {canSendLater && (
                <AppButton
                  variant="text"
                  size="sm"
                  className="p-0"
                  onClick={() => onSendInvitation(added)}
                >
                  Send invitation
                </AppButton>
              )}
            </>
          }
        >
          {resultLine(result)}
        </Alert>
      )}
      {readOnly && (
        <Alert variant="warning" role="status">
          This event is not taking changes right now, so nobody can be added.
        </Alert>
      )}
      <form
        id={formId}
        className="d-flex flex-column gap-3"
        noValidate
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void submit(false);
        }}
        onKeyDown={(keyEvent) => {
          // The submit button lives in the drawer footer, outside the form
          // element, so Enter in a field submits explicitly.
          if (
            keyEvent.key !== "Enter" ||
            keyEvent.target.tagName !== "INPUT" ||
            keyEvent.target.type === "checkbox"
          )
            return;
          keyEvent.preventDefault();
          void submit(false);
        }}
      >
        <FormField
          id={`${ids}-name`}
          label="Full name"
          required
          error={errors.name || null}
        >
          <input
            ref={nameInput}
            type="text"
            className="form-control"
            name="name"
            autoComplete="off"
            maxLength={100}
            value={name}
            disabled={locked}
            data-autofocus
            onChange={change(setName, "name")}
          />
        </FormField>
        {!noEmail && (
          <FormField
            id={`${ids}-email`}
            label="Email"
            required
            error={errors.email || null}
          >
            <input
              ref={emailInput}
              type="email"
              className="form-control"
              name="email"
              inputMode="email"
              autoComplete="off"
              maxLength={254}
              value={email}
              disabled={locked}
              onChange={change(setEmail, "email")}
            />
          </FormField>
        )}
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id={`${ids}-no-email`}
            checked={noEmail}
            disabled={locked}
            aria-describedby={`${ids}-no-email-help`}
            onChange={change(setNoEmail, "email")}
          />
          <label className="form-check-label" htmlFor={`${ids}-no-email`}>
            They have no email. I&apos;ll enter their schedule.
          </label>
          <div id={`${ids}-no-email-help`} className="form-text">
            Blank = filed under {organizerEmail || "your account email"}. They
            are never emailed.
          </div>
        </div>
        <FormField
          id={`${ids}-phone`}
          label="Phone"
          optional
          error={errors.phone || null}
        >
          <input
            ref={phoneInput}
            type="tel"
            className="form-control"
            name="phone"
            inputMode="tel"
            autoComplete="off"
            maxLength={32}
            value={phone}
            disabled={locked}
            onChange={change(setPhone, "phone")}
          />
        </FormField>
        {error && (
          <Alert variant="danger" role="alert">
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}
