import {
  UNGROUPED,
  accountLine,
  activeRosterFilter,
  buildGroupUpdates,
  contactLine,
  countedInMessage,
  countsLine,
  describeSelection,
  detailsEditable,
  emailError,
  filterChips,
  formatWeight,
  groupNameError,
  groupPanelRows,
  invitationBadge,
  invitationToast,
  mixedPickerState,
  nameEditable,
  nameError,
  peopleCount,
  phoneError,
  pickerStateFromRows,
  reminderNextAt,
  responseBadge,
  weightError,
} from "@/lib/participants";

function person(overrides = {}) {
  return {
    id: "1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "",
    weight: 1,
    included: true,
    submitted: false,
    accountAccess: "temporary",
    organizerManaged: false,
    canOrganizerEditAvailability: true,
    isOrganizer: false,
    canOrganizerEditEmail: true,
    invitationStatus: "not_sent",
    invitationDelivery: null,
    ...overrides,
  };
}

describe("editing rules", () => {
  test("renames everyone the organizer still answers for", () => {
    expect(nameEditable(person())).toBe(true);
    expect(
      nameEditable(
        person({ organizerManaged: true, canOrganizerEditAvailability: false }),
      ),
    ).toBe(true);
    expect(nameEditable(person({ canOrganizerEditAvailability: false }))).toBe(
      false,
    );
    expect(nameEditable(person({ isOrganizer: true }))).toBe(false);
  });

  test("details stay editable while the email can change", () => {
    expect(detailsEditable(person())).toBe(true);
    expect(
      detailsEditable(
        person({
          canOrganizerEditAvailability: false,
          canOrganizerEditEmail: true,
        }),
      ),
    ).toBe(true);
    expect(
      detailsEditable(
        person({
          canOrganizerEditAvailability: false,
          canOrganizerEditEmail: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("validation messages", () => {
  test("name", () => {
    expect(nameError("")).toBe("Full name is required.");
    expect(nameError("   ")).toBe("Full name is required.");
    expect(nameError("x".repeat(101))).toBe(
      "Full name must be 100 characters or fewer.",
    );
    expect(nameError("Ada")).toBe("");
    expect(nameError(null)).toBe("Full name is required.");
  });

  test("email", () => {
    expect(emailError("")).toBe("Email address is required.");
    expect(emailError("", { required: false })).toBe("");
    expect(emailError(`${"a".repeat(250)}@x.io`)).toBe(
      "Email address must be 254 characters or fewer.",
    );
    expect(emailError("not-an-email")).toBe("Enter a valid email address.");
    expect(emailError("ada@example.com")).toBe("");
    expect(emailError(undefined, { required: true })).toBe(
      "Email address is required.",
    );
  });

  test("phone", () => {
    const message = "Enter a phone number with 7 to 32 digits.";
    expect(phoneError("")).toBe("");
    expect(phoneError(undefined)).toBe("");
    expect(phoneError("+1 (555) 010-2000")).toBe("");
    expect(phoneError("12345")).toBe(message);
    expect(phoneError("555-CALL-NOW")).toBe(message);
    expect(phoneError("1".repeat(33))).toBe(message);
  });

  test("weight", () => {
    const message = "Enter a weight between 0 and 1.";
    expect(weightError("")).toBe(message);
    expect(weightError(null)).toBe(message);
    expect(weightError("abc")).toBe(message);
    expect(weightError("-0.1")).toBe(message);
    expect(weightError(1.5)).toBe(message);
    expect(weightError("0")).toBe("");
    expect(weightError(0.5)).toBe("");
    expect(weightError("1")).toBe("");
  });

  test("group name", () => {
    expect(groupNameError("")).toBe("Enter a group name.");
    expect(groupNameError("x".repeat(101))).toBe(
      "Group names must be 100 characters or fewer.",
    );
    expect(groupNameError("a;b")).toBe("Group names cannot contain ; or ,.");
    expect(groupNameError("a,b")).toBe("Group names cannot contain ; or ,.");
    expect(groupNameError("all")).toBe("ALL is reserved for every group.");
    expect(groupNameError("Design")).toBe("");
  });
});

describe("badges", () => {
  test("invitation badge follows the delivery state before the status", () => {
    expect(invitationBadge(person({ isOrganizer: true }))).toEqual({
      status: "neutral",
      label: "—",
      plain: true,
    });
    expect(invitationBadge(person({ organizerManaged: true }))).toEqual({
      status: "neutral",
      label: "No email",
      plain: true,
    });
    expect(
      invitationBadge(
        person({ invitationDelivery: "failed", invitationStatus: "sent" }),
      ),
    ).toEqual({ status: "danger", label: "Failed" });
    expect(invitationBadge(person({ invitationDelivery: "queued" }))).toEqual({
      status: "info",
      label: "Sending…",
    });
    expect(invitationBadge(person({ invitationStatus: "accepted" }))).toEqual({
      status: "accepted",
      label: "Accepted",
    });
    expect(invitationBadge(person({ invitationStatus: "sent" }))).toEqual({
      status: "sent",
      label: "Sent",
    });
    expect(invitationBadge(person())).toEqual({
      status: "not-sent",
      label: "Not sent",
    });
    expect(invitationBadge(person({ invitationDelivery: undefined }))).toEqual({
      status: "not-sent",
      label: "Not sent",
    });
  });

  test("response badge", () => {
    expect(responseBadge(person({ submitted: true }))).toEqual({
      status: "submitted",
      label: "Submitted",
    });
    expect(responseBadge(person())).toEqual({
      status: "not-submitted",
      label: "Not submitted",
    });
  });
});

describe("sentences", () => {
  test("account line", () => {
    expect(accountLine(person({ isOrganizer: true }))).toBe("Your own row.");
    expect(accountLine(person({ organizerManaged: true }))).toBe(
      "No email of their own. You enter their schedule.",
    );
    expect(accountLine(person())).toBe(
      "Invited by email. Signs in with their link, no account.",
    );
    expect(accountLine(person({ accountAccess: "full" }))).toBe(
      "Has a Releviz account. You can enter their schedule until they answer themselves.",
    );
    expect(
      accountLine(
        person({ accountAccess: "full", canOrganizerEditAvailability: false }),
      ),
    ).toBe("Answers with their own account.");
  });

  test("contact line never shows the filing address of a no-email row", () => {
    expect(contactLine(person({ organizerManaged: true }))).toEqual({
      text: "No email · you enter their schedule",
      tags: [],
    });
    expect(contactLine(person({ isOrganizer: true }))).toEqual({
      text: "From your account",
      tags: [],
    });
    expect(contactLine(person({ phone: "+1 555 0100" }))).toEqual({
      text: "ada@example.com · +1 555 0100",
      tags: [],
    });
    expect(contactLine(person({ phone: "  " })).text).toBe("ada@example.com");
    expect(contactLine(person({ email: "", phone: "555" })).text).toBe("555");
  });

  test("contact line tags exceptions only", () => {
    expect(contactLine(person({ weight: 0.5, included: false })).tags).toEqual([
      "Weight 0.5",
      "Left out of results",
    ]);
    expect(contactLine(person({ weight: undefined })).tags).toEqual([]);
    expect(contactLine(person({ weight: 0 })).tags).toEqual(["Weight 0"]);
  });

  test("formatWeight trims trailing zeros", () => {
    expect(formatWeight(0.5)).toBe("0.5");
    expect(formatWeight("0.250")).toBe("0.25");
    expect(formatWeight(1)).toBe("1");
    expect(formatWeight(0.1 + 0.2)).toBe("0.3");
    expect(formatWeight("x")).toBe("");
  });

  test("describeSelection", () => {
    expect(describeSelection({ count: 3 })).toBe("3 selected");
    expect(describeSelection({ count: 3, mode: "page", notOnPage: 0 })).toBe(
      "3 selected",
    );
    expect(describeSelection({ count: 8, mode: "page", notOnPage: 5 })).toBe(
      "8 selected · 5 not on this page",
    );
    expect(describeSelection({ count: 40, mode: "all", notOnPage: 5 })).toBe(
      "40 selected · everyone matching the filter",
    );
  });

  test("peopleCount", () => {
    expect(peopleCount(1)).toBe("1 person");
    expect(peopleCount(0)).toBe("0 people");
    expect(peopleCount(4)).toBe("4 people");
  });

  test("countedInMessage agrees with the count", () => {
    expect(countedInMessage(1)).toBe("1 person now counts in the results.");
    expect(countedInMessage(0)).toBe("0 people now count in the results.");
    expect(countedInMessage(3)).toBe("3 people now count in the results.");
  });
});

describe("filter chips", () => {
  test("lists every active filter with its label", () => {
    expect(
      filterChips({
        search: " zed ",
        group: "Design",
        submitted: "true",
        invitationStatus: "failed",
        included: "false",
      }),
    ).toEqual([
      { key: "search", label: "Search: zed" },
      { key: "group", label: "Group: Design" },
      { key: "submitted", label: "Response: Submitted" },
      { key: "invitationStatus", label: "Invitation: Failed" },
      { key: "included", label: "Results: Left out" },
    ]);
  });

  test("names the ungrouped bucket and the other values", () => {
    expect(
      filterChips({
        group: UNGROUPED,
        submitted: false,
        invitationStatus: "queued",
        included: true,
      }),
    ).toEqual([
      { key: "group", label: "Group: No group" },
      { key: "submitted", label: "Response: Not submitted" },
      { key: "invitationStatus", label: "Invitation: Sending" },
      { key: "included", label: "Results: Counted" },
    ]);
  });

  test("ignores blank, unknown and null values", () => {
    expect(filterChips()).toEqual([]);
    expect(
      filterChips({
        search: "  ",
        group: "",
        submitted: null,
        invitationStatus: "bogus",
        included: null,
      }),
    ).toEqual([]);
    expect(filterChips({ included: undefined, submitted: undefined })).toEqual(
      [],
    );
  });
});

describe("buildGroupUpdates", () => {
  test("sends only what changed", () => {
    expect(
      buildGroupUpdates(
        { allGroups: false, groupIds: [1, 2] },
        { allGroups: false, groupIds: [2, 3] },
      ),
    ).toEqual({ addGroupIds: [3], removeGroupIds: [1] });
    expect(
      buildGroupUpdates(
        { allGroups: false, groupIds: [1] },
        { allGroups: true, groupIds: [1] },
      ),
    ).toEqual({ allGroups: true });
    expect(
      buildGroupUpdates(
        { allGroups: true, groupIds: [] },
        { allGroups: false, groupIds: [4] },
      ),
    ).toEqual({ addGroupIds: [4], allGroups: false });
  });

  test("is empty when nothing changed and tolerates missing shapes", () => {
    expect(
      buildGroupUpdates(
        { allGroups: false, groupIds: [1] },
        { allGroups: false, groupIds: [1] },
      ),
    ).toEqual({});
    expect(buildGroupUpdates(undefined, undefined)).toEqual({});
    expect(buildGroupUpdates(null, { groupIds: [9] })).toEqual({
      addGroupIds: [9],
    });
  });
});

describe("activeRosterFilter", () => {
  test("keeps only the active filters and trims them", () => {
    expect(
      activeRosterFilter({
        search: " zed ",
        group: "",
        submitted: "false",
        invitationStatus: "",
        included: "",
      }),
    ).toEqual({ search: "zed", submitted: "false" });
    expect(activeRosterFilter({ group: UNGROUPED, included: "true" })).toEqual({
      group: UNGROUPED,
      included: "true",
    });
  });

  test("selects everyone explicitly when nothing is filtered", () => {
    expect(activeRosterFilter()).toEqual({ all: true });
    expect(activeRosterFilter({ search: "  ", submitted: null })).toEqual({
      all: true,
    });
  });
});

describe("invitationToast", () => {
  test("counts the queued invitations and the skips that happened", () => {
    expect(invitationToast({ queuedCount: 1 })).toBe("Queued 1 invitation.");
    expect(
      invitationToast({
        queuedCount: 3,
        skipped: { alreadyInvited: 2, noEmail: 1, organizer: 1 },
      }),
    ).toBe(
      "Queued 3 invitations. Skipped 2 already invited and 1 without an email.",
    );
    expect(invitationToast({ queuedCount: 0, skipped: { noEmail: 4 } })).toBe(
      "Queued 0 invitations. Skipped 4 without an email.",
    );
    expect(
      invitationToast({ queuedCount: 2, skipped: { alreadyInvited: 1 } }),
    ).toBe("Queued 2 invitations. Skipped 1 already invited.");
    expect(invitationToast()).toBe("Queued 0 invitations.");
  });
});

describe("reminderNextAt", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const event = {
    status: "active",
    remindersEnabled: true,
    responseDeadline: "2026-09-10T12:00:00Z",
    reminderHoursBefore: 24,
  };

  test("is the reminder lead time before the deadline while it lies ahead", () => {
    expect(reminderNextAt(event, now)).toBe("2026-09-09T12:00:00.000Z");
  });

  test("is null when reminders are off, the event is not active, or it has passed", () => {
    expect(
      reminderNextAt({ ...event, remindersEnabled: false }, now),
    ).toBeNull();
    expect(reminderNextAt({ ...event, status: "closed" }, now)).toBeNull();
    expect(
      reminderNextAt({ ...event, responseDeadline: null }, now),
    ).toBeNull();
    expect(
      reminderNextAt(event, Date.parse("2026-09-09T13:00:00Z")),
    ).toBeNull();
    expect(
      reminderNextAt({ ...event, responseDeadline: "soon" }, now),
    ).toBeNull();
    expect(
      reminderNextAt({ ...event, reminderHoursBefore: "many" }, now),
    ).toBeNull();
    expect(reminderNextAt(null, now)).toBeNull();
  });
});

describe("countsLine", () => {
  test("reads people, responses and groups with singulars", () => {
    expect(
      countsLine({ total: 1, submitted: 1, notSubmitted: 0, groups: 1 }),
    ).toBe("1 person · 1 submitted · 0 not submitted · 1 group");
    expect(
      countsLine({ total: 12, submitted: 3, notSubmitted: 9, groups: 0 }),
    ).toBe("12 people · 3 submitted · 9 not submitted · 0 groups");
    expect(countsLine()).toBe(
      "0 people · 0 submitted · 0 not submitted · 0 groups",
    );
  });

  test("says how many of everyone are shown while filtering", () => {
    expect(
      countsLine({
        total: 12,
        shown: 4,
        submitted: 3,
        notSubmitted: 9,
        groups: 2,
        filtering: true,
      }),
    ).toBe("Showing 4 of 12 people · 3 submitted · 9 not submitted · 2 groups");
  });
});

describe("pickerStateFromRows", () => {
  const groups = [
    { id: 1, name: "Design" },
    { id: 2, name: "Sales" },
    { id: 3, name: "Empty" },
  ];
  const rows = [
    { id: "a", groups: [{ id: 1 }], allGroups: false },
    { id: "b", groups: [{ id: 1 }, { id: 2 }], allGroups: true },
  ];

  test("tells all, none and mixed per group with the member counts", () => {
    expect(pickerStateFromRows(rows, groups)).toEqual({
      state: {
        allGroups: "mixed",
        byGroup: { 1: "all", 2: "mixed", 3: "none" },
      },
      counts: { total: 2, allGroups: 1, byGroup: { 1: 2, 2: 1, 3: 0 } },
    });
  });

  test("starts from nothing for no rows and tolerates rows without groups", () => {
    expect(pickerStateFromRows([], groups).state).toEqual({
      allGroups: "none",
      byGroup: { 1: "none", 2: "none", 3: "none" },
    });
    expect(pickerStateFromRows([{ id: "c" }], [groups[0]])).toEqual({
      state: { allGroups: "none", byGroup: { 1: "none" } },
      counts: { total: 1, allGroups: 0, byGroup: { 1: 0 } },
    });
    expect(pickerStateFromRows()).toEqual({
      state: { allGroups: "none", byGroup: {} },
      counts: { total: 0, allGroups: 0, byGroup: {} },
    });
  });

  test("mixedPickerState starts every box mixed", () => {
    expect(mixedPickerState(groups)).toEqual({
      allGroups: "mixed",
      byGroup: { 1: "mixed", 2: "mixed", 3: "mixed" },
    });
    expect(mixedPickerState()).toEqual({ allGroups: "mixed", byGroup: {} });
  });
});

describe("groupPanelRows", () => {
  test("splits the named groups from the ungrouped bucket and counts who is included", () => {
    expect(
      groupPanelRows([
        { id: 1, name: "Design", count: 4, weight: 1, included: true },
        { id: 2, name: "Sales", count: 3, weight: null, included: null },
        { id: 3, name: "Left out", count: 2, weight: 0.5, included: false },
        { id: 4, name: "Empty", count: 0, weight: null, included: null },
        { id: null, name: "", count: 2, weight: 0.5, included: null },
      ]),
    ).toEqual({
      groups: [
        { id: 1, name: "Design", count: 4, weight: 1, includedCount: 4 },
        { id: 2, name: "Sales", count: 3, weight: null, includedCount: null },
        { id: 3, name: "Left out", count: 2, weight: 0.5, includedCount: 0 },
        { id: 4, name: "Empty", count: 0, weight: null, includedCount: 0 },
      ],
      ungrouped: { count: 2, weight: 0.5, includedCount: null },
    });
  });

  test("has an empty bucket without one, and ignores anything that is not a group", () => {
    expect(groupPanelRows([{ id: 1, name: "Design" }, "Design", null])).toEqual(
      {
        groups: [
          { id: 1, name: "Design", count: 0, weight: null, includedCount: 0 },
        ],
        ungrouped: { count: 0, weight: null, includedCount: 0 },
      },
    );
    expect(groupPanelRows()).toEqual({
      groups: [],
      ungrouped: { count: 0, weight: null, includedCount: 0 },
    });
    expect(groupPanelRows("nope").groups).toEqual([]);
  });
});
