import {
  UNGROUPED,
  accountLine,
  buildGroupUpdates,
  contactLine,
  describeSelection,
  detailsEditable,
  emailError,
  filterChips,
  formatWeight,
  groupNameError,
  invitationBadge,
  nameEditable,
  nameError,
  peopleCount,
  phoneError,
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
