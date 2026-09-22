export function rosterImportStatusMessage({
  receipt,
  autoInvitedCount,
  sendInvitations = true,
}) {
  const summary = receipt || {};
  const importedCount = summary.importedCount || 0;
  const createdCount = summary.createdCount || 0;
  const updatedCount = summary.updatedCount || 0;
  if (!sendInvitations) {
    return `Imported ${importedCount} people: ${createdCount} added, ${updatedCount} updated. No invitations were sent.`;
  }
  const invitedCount = autoInvitedCount ?? summary.invitedCount ?? createdCount;
  return createdCount > 0 || invitedCount > 0
    ? `Imported ${importedCount} people: ${createdCount} added, ${updatedCount} updated. ${invitedCount} invitation${invitedCount === 1 ? "" : "s"} queued.`
    : `Imported ${importedCount} people: no new participants were added, so no invitations were sent.`;
}
