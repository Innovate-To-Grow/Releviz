import { rosterImportStatusMessage } from "@/lib/roster-import-status";

describe("rosterImportStatusMessage", () => {
  test("reports the queued invitations when sending was enabled", () => {
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 3, createdCount: 2, updatedCount: 1 },
        autoInvitedCount: 2,
        sendInvitations: true,
      }),
    ).toBe("Imported 3 people: 2 added, 1 updated. 2 invitations queued.");
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 1, createdCount: 1, updatedCount: 0 },
        autoInvitedCount: 1,
        sendInvitations: true,
      }),
    ).toBe("Imported 1 people: 1 added, 0 updated. 1 invitation queued.");
  });

  test("says nothing was sent when a sending import added nobody new", () => {
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 2, createdCount: 0, updatedCount: 2 },
        autoInvitedCount: 0,
        sendInvitations: true,
      }),
    ).toBe(
      "Imported 2 people: no new participants were added, so no invitations were sent.",
    );
  });

  test("uses the add-only wording when sending was disabled", () => {
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 4, createdCount: 3, updatedCount: 1 },
        autoInvitedCount: 0,
        sendInvitations: false,
      }),
    ).toBe("Imported 4 people: 3 added, 1 updated. No invitations were sent.");
    expect(rosterImportStatusMessage({ sendInvitations: false })).toBe(
      "Imported 0 people: 0 added, 0 updated. No invitations were sent.",
    );
  });

  test("defaults to sending and falls back through the receipt counts", () => {
    // Callers that omit the flag get today's wording.
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 2, createdCount: 2, updatedCount: 0 },
        autoInvitedCount: 2,
      }),
    ).toBe("Imported 2 people: 2 added, 0 updated. 2 invitations queued.");
    // Without an autoInvitedCount the receipt's invitedCount is used, then
    // the created count.
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 2, createdCount: 0, invitedCount: 1 },
      }),
    ).toBe("Imported 2 people: 0 added, 0 updated. 1 invitation queued.");
    expect(
      rosterImportStatusMessage({
        receipt: { importedCount: 2, createdCount: 2 },
      }),
    ).toBe("Imported 2 people: 2 added, 0 updated. 2 invitations queued.");
    expect(rosterImportStatusMessage({ receipt: null })).toBe(
      "Imported 0 people: no new participants were added, so no invitations were sent.",
    );
  });
});
