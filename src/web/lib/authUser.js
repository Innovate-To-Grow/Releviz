export function normalizeAuthUser(user) {
  if (!user || typeof user !== "object") return null;

  const id = user.id || user.memberUuid || user.member_uuid || null;
  const firstName = user.firstName ?? user.first_name ?? "";
  const middleName = user.middleName ?? user.middle_name ?? "";
  const lastName = user.lastName ?? user.last_name ?? "";
  const email = user.email || "";
  const displayName =
    user.displayName ||
    [firstName, middleName, lastName].filter(Boolean).join(" ") ||
    email;

  return {
    ...user,
    id,
    memberUuid: user.memberUuid || user.member_uuid || id,
    email,
    firstName,
    middleName,
    lastName,
    displayName,
    emailVerified: user.emailVerified ?? user.email_verified ?? false,
    primaryEmailId: user.primaryEmailId ?? user.primary_email_id ?? null,
    emailSubscribe: user.emailSubscribe ?? user.email_subscribe ?? false,
    isActive: user.isActive ?? user.is_active ?? false,
    dateJoined: user.dateJoined ?? user.date_joined ?? null,
    profileImage: user.profileImage ?? user.profile_image ?? null,
    isStaff: user.isStaff ?? user.is_staff ?? false,
  };
}
