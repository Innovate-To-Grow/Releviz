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

// The Response column's one badge: the answer once there is one, otherwise
// how far the invitation got. People nobody invites have no invitation state,
// and neither does anyone in an open-link event who never got one.
export function responseBadge(participant, { openLink = false } = {}) {
  if (participant.submitted) return { status: "submitted", label: "Submitted" };
  if (participant.isOrganizer || participant.organizerManaged)
    return { status: "not-submitted", label: "Not submitted" };
  if (participant.invitationDelivery === "failed")
    return { status: "danger", label: "Invite failed" };
  if (participant.invitationDelivery === "queued")
    return { status: "info", label: "Sending invite…" };
  if (participant.invitationStatus === "accepted")
    return { status: "draft", label: "Started" };
  if (participant.invitationStatus === "sent")
    return { status: "sent", label: "Invited" };
  if (openLink) return { status: "not-submitted", label: "Not submitted" };
  return { status: "not-sent", label: "Not invited" };
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

// The Filter popover's single Response group. Each option is a pair of the
// API's `submitted` and `invitationStatus` query parameters.
export const RESPONSE_FILTER_OPTIONS = [
  { key: "", label: "Any", params: { submitted: "", invitationStatus: "" } },
  {
    key: "submitted",
    label: "Submitted",
    params: { submitted: "true", invitationStatus: "" },
  },
  {
    key: "not_submitted",
    label: "Not submitted",
    params: { submitted: "false", invitationStatus: "" },
  },
  {
    key: "not_invited",
    label: "Not invited yet",
    params: { submitted: "false", invitationStatus: "not_sent" },
  },
  {
    key: "sending",
    label: "Sending invite",
    params: { submitted: "", invitationStatus: "queued" },
  },
  {
    key: "failed",
    label: "Invite failed",
    params: { submitted: "", invitationStatus: "failed" },
  },
  {
    key: "invited",
    label: "Invited",
    params: { submitted: "false", invitationStatus: "sent" },
  },
  {
    key: "started",
    label: "Started",
    params: { submitted: "false", invitationStatus: "accepted" },
  },
];

const INVITATION_STATUS_KEYS = {
  queued: "sending",
  failed: "failed",
  not_sent: "not_invited",
  sent: "invited",
  accepted: "started",
};

// Which option the two API parameters amount to. Sending and failed ignore
// `submitted`, so the failed-invitations banner and the list it opens agree.
export function responseFilterKey({
  submitted = "",
  invitationStatus = "",
} = {}) {
  const status = String(invitationStatus ?? "");
  if (Object.hasOwn(INVITATION_STATUS_KEYS, status))
    return INVITATION_STATUS_KEYS[status];
  const answered = String(submitted ?? "");
  if (answered === "true") return "submitted";
  if (answered === "false") return "not_submitted";
  return "";
}

export function responseFilterParams(key) {
  const option = RESPONSE_FILTER_OPTIONS.find((item) => item.key === key);
  return { ...(option ?? RESPONSE_FILTER_OPTIONS[0]).params };
}

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
  const responseKey = responseFilterKey({ submitted, invitationStatus });
  if (responseKey)
    chips.push({
      key: "response",
      label: `Response: ${RESPONSE_FILTER_OPTIONS.find((item) => item.key === responseKey).label}`,
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

// The API selector for "everyone matching the current filters": the active
// filter values, or an explicit `all` when nothing is filtered.
export function activeRosterFilter({
  search = "",
  group = "",
  submitted = "",
  invitationStatus = "",
  included = "",
} = {}) {
  const active = Object.fromEntries(
    Object.entries({ search, group, submitted, invitationStatus, included })
      .map(([key, value]) => [key, String(value ?? "").trim()])
      .filter(([, value]) => value !== ""),
  );
  return Object.keys(active).length ? active : { all: true };
}

// The toast after a send: how many were queued and, when any, who was
// skipped and why.
export function invitationToast({ queuedCount = 0, skipped = null } = {}) {
  const queued = `Queued ${queuedCount} ${queuedCount === 1 ? "invitation" : "invitations"}.`;
  const parts = [];
  const alreadyInvited = Number(skipped?.alreadyInvited || 0);
  const noEmail = Number(skipped?.noEmail || 0);
  if (alreadyInvited) parts.push(`${alreadyInvited} already invited`);
  if (noEmail) parts.push(`${noEmail} without an email`);
  return parts.length ? `${queued} Skipped ${parts.join(" and ")}.` : queued;
}

// When the next automatic reminder goes out: `reminderHoursBefore` hours
// before the response deadline, while reminders are on, the event is active
// and that moment is still ahead.
export function reminderNextAt(event, now = Date.now()) {
  if (
    !event?.remindersEnabled ||
    event.status !== "active" ||
    !event.responseDeadline
  )
    return null;
  const deadline = Date.parse(event.responseDeadline);
  const hours = Number(event.reminderHoursBefore);
  if (!Number.isFinite(deadline) || !Number.isFinite(hours)) return null;
  const at = deadline - hours * 3600000;
  return at > now ? new Date(at).toISOString() : null;
}

// The section's summary line under the Participants heading.
export function countsLine({
  total = 0,
  shown = 0,
  submitted = 0,
  notSubmitted = 0,
  groups = 0,
  filtering = false,
} = {}) {
  const first = filtering
    ? `Showing ${shown} of ${total} people`
    : peopleCount(total);
  return `${first} · ${submitted} submitted · ${notSubmitted} not submitted · ${groups} ${groups === 1 ? "group" : "groups"}`;
}

// Group picker state for the selected rows on a page: per group (and for the
// every-group flag) whether all, none or some of them are members, with the
// member counts shown beside each box.
export function pickerStateFromRows(rows = [], groups = []) {
  const total = rows.length;
  const stateOf = (count) =>
    total === 0 || count === 0 ? "none" : count === total ? "all" : "mixed";
  const everyGroup = rows.filter((row) => Boolean(row.allGroups)).length;
  const state = { allGroups: stateOf(everyGroup), byGroup: {} };
  const counts = { total, allGroups: everyGroup, byGroup: {} };
  groups.forEach((group) => {
    const count = rows.filter((row) =>
      (row.groups ?? []).some((member) => member.id === group.id),
    ).length;
    counts.byGroup[group.id] = count;
    state.byGroup[group.id] = stateOf(count);
  });
  return { state, counts };
}

// Picker state when the selection reaches beyond the page (select-all mode):
// nothing is known about everyone, so every box starts mixed.
export function mixedPickerState(groups = []) {
  return {
    allGroups: "mixed",
    byGroup: Object.fromEntries(groups.map((group) => [group.id, "mixed"])),
  };
}

// The rows of the Manage groups panel from the listing's `stats.groups`: the
// named groups and the trailing ungrouped bucket. A group whose members are
// only partly counted comes back with `included: null` and no count, which
// the panel shows as "Some" (`includedCount: null`).
export function groupPanelRows(groups = []) {
  const named = [];
  let ungrouped = { count: 0, weight: null, includedCount: 0 };
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    if (!group || typeof group !== "object") return;
    const count = Number(group.count || 0);
    const row = {
      id: group.id ?? null,
      name: group.name || "",
      count,
      weight: group.weight ?? null,
      includedCount:
        group.included === true
          ? count
          : group.included === false || count === 0
            ? 0
            : null,
    };
    if (row.id === null || row.name === "") {
      ungrouped = {
        count: row.count,
        weight: row.weight,
        includedCount: row.includedCount,
      };
    } else named.push(row);
  });
  return { groups: named, ungrouped };
}
