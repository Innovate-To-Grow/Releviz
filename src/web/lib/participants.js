// Pure helpers for the organizer's Participants section: editing rules,
// validation messages, badge and sentence vocabulary, and small diffs. Every
// piece of UI copy that more than one component needs lives here so the
// wording stays identical everywhere.

export const UNGROUPED = "__ungrouped__";

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

export function nameError(value) {
  const name = String(value || "").trim();
  if (!name) return "Full name is required.";
  if (name.length > 100) return "Full name must be 100 characters or fewer.";
  return "";
}

export function emailError(value, { required = true } = {}) {
  const email = String(value || "").trim();
  if (!email) return required ? "Email address is required." : "";
  if (email.length > 254)
    return "Email address must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return "Enter a valid email address.";
  return "";
}

// Digits, spaces and + - ( ) . only, with 7 to 32 characters overall and at
// least seven digits among them. Blank is fine: the phone is optional.
export function phoneError(value) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  if (
    phone.length > 32 ||
    !/^[0-9 +().-]+$/.test(phone) ||
    phone.replace(/\D/g, "").length < 7
  )
    return "Enter a phone number with 7 to 32 digits.";
  return "";
}

export function weightError(value) {
  const text = String(value ?? "").trim();
  const weight = Number(text);
  if (!text || !Number.isFinite(weight) || weight < 0 || weight > 1)
    return "Enter a weight between 0 and 1.";
  return "";
}

// Mirrors the server's group-name rules so a bad name never leaves the page.
export function groupNameError(value) {
  const name = String(value || "").trim();
  if (!name) return "Enter a group name.";
  if (name.length > 100) return "Group names must be 100 characters or fewer.";
  if (name.includes(";") || name.includes(","))
    return "Group names cannot contain ; or ,.";
  if (name.toUpperCase() === "ALL") return "ALL is reserved for every group.";
  return "";
}

export function invitationBadge(participant) {
  if (participant.isOrganizer)
    return { status: "neutral", label: "—", plain: true };
  if (participant.organizerManaged)
    return { status: "neutral", label: "No email", plain: true };
  if (participant.invitationDelivery === "failed")
    return { status: "danger", label: "Failed" };
  if (participant.invitationDelivery === "queued")
    return { status: "info", label: "Sending…" };
  if (participant.invitationStatus === "accepted")
    return { status: "accepted", label: "Accepted" };
  if (participant.invitationStatus === "sent")
    return { status: "sent", label: "Sent" };
  return { status: "not-sent", label: "Not sent" };
}

export function responseBadge(participant) {
  return participant.submitted
    ? { status: "submitted", label: "Submitted" }
    : { status: "not-submitted", label: "Not submitted" };
}

// The person panel's one-line explanation of how this row is answered.
export function accountLine(participant) {
  if (participant.isOrganizer) return "Your own row.";
  if (participant.organizerManaged)
    return "No email of their own. You enter their schedule.";
  if (participant.accountAccess === "temporary")
    return "Invited by email. Signs in with their link, no account.";
  if (participant.canOrganizerEditAvailability)
    return "Has a Releviz account. You can enter their schedule until they answer themselves.";
  return "Answers with their own account.";
}

export function formatWeight(weight) {
  const number = Number(weight);
  if (!Number.isFinite(number)) return "";
  return String(Number(number.toFixed(4)));
}

// Second line of a row: how to reach the person (never the organizer's filing
// address for someone with no email of their own) plus the exceptions worth a
// glance: an unusual weight and being left out of the results.
export function contactLine(participant) {
  const tags = [];
  const weight = Number(participant.weight ?? 1);
  if (weight !== 1) tags.push(`Weight ${formatWeight(weight)}`);
  if (participant.included === false) tags.push("Left out of results");

  let text;
  if (participant.isOrganizer) text = "From your account";
  else if (participant.organizerManaged)
    text = "No email · you enter their schedule";
  else
    text = [participant.email, participant.phone]
      .filter((part) => Boolean(part && String(part).trim()))
      .join(" · ");
  return { text, tags };
}

export function describeSelection({ count, mode = "page", notOnPage = 0 }) {
  let text = `${count} selected`;
  if (mode === "all") text += " · everyone matching the filter";
  else if (notOnPage > 0) text += ` · ${notOnPage} not on this page`;
  return text;
}

export const INVITATION_FILTER_LABELS = {
  not_sent: "Not sent",
  queued: "Sending",
  failed: "Failed",
  sent: "Sent",
  accepted: "Accepted",
};

export function filterChips({
  search = "",
  group = "",
  submitted = "",
  invitationStatus = "",
  included = "",
} = {}) {
  const chips = [];
  const searchText = String(search || "").trim();
  if (searchText) chips.push({ key: "search", label: `Search: ${searchText}` });
  if (group)
    chips.push({
      key: "group",
      label: group === UNGROUPED ? "Group: No group" : `Group: ${group}`,
    });
  const submittedValue = String(submitted ?? "");
  if (submittedValue === "true" || submittedValue === "false")
    chips.push({
      key: "submitted",
      label: `Response: ${submittedValue === "true" ? "Submitted" : "Not submitted"}`,
    });
  if (invitationStatus && INVITATION_FILTER_LABELS[invitationStatus])
    chips.push({
      key: "invitationStatus",
      label: `Invitation: ${INVITATION_FILTER_LABELS[invitationStatus]}`,
    });
  const includedValue = String(included ?? "");
  if (includedValue === "true" || includedValue === "false")
    chips.push({
      key: "included",
      label: `Results: ${includedValue === "true" ? "Counted" : "Left out"}`,
    });
  return chips;
}

// Membership diff for PATCH: `current` and `next` are
// { allGroups: boolean, groupIds: number[] }. Empty lists and an unchanged
// allGroups flag are left out so the request carries only real changes.
export function buildGroupUpdates(current, next) {
  const before = new Set(current?.groupIds ?? []);
  const after = new Set(next?.groupIds ?? []);
  const updates = {};
  const addGroupIds = [...after].filter((id) => !before.has(id));
  const removeGroupIds = [...before].filter((id) => !after.has(id));
  if (addGroupIds.length) updates.addGroupIds = addGroupIds;
  if (removeGroupIds.length) updates.removeGroupIds = removeGroupIds;
  if (Boolean(next?.allGroups) !== Boolean(current?.allGroups))
    updates.allGroups = Boolean(next?.allGroups);
  return updates;
}

export function peopleCount(count) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}
