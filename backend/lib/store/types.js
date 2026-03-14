export function toApiEvent(event) {
  const result = {
    code: event.eventCode,
    name: event.name,
    startHour: event.startHour,
    endHour: event.endHour,
    days: Array.isArray(event.days) && event.days.length > 0 ? event.days : [1, 2, 3, 4, 5],
    mode: ["inperson", "virtual", "mixed"].includes(event.mode) ? event.mode : "inperson",
    location: event.location || "",
    organizerUserId: event.organizerUserId || null,
    participantVerification: event.participantVerification || "none",
    participantViewPermission: event.participantViewPermission || "own_only",
    daySelectionType: event.daySelectionType || "days_of_week",
    createdAt: event.createdAt,
  };
  if (event.specificDates) {
    result.specificDates = event.specificDates;
  }
  return result;
}

export function toApiParticipant(participant) {
  return {
    id: participant.participantId,
    event_id: participant.eventId,
    name: participant.participantName,
    schedule_inperson: participant.scheduleInperson,
    schedule_virtual: participant.scheduleVirtual,
    submitted: participant.submitted ? 1 : 0,
    hidden: participant.hidden ? 1 : 0,
    group_name: participant.groupName || null,
    sort_order: participant.sortOrder !== undefined ? participant.sortOrder : null,
    created_at: participant.createdAt,
  };
}

export function toApiUser(user) {
  return {
    id: user.userId,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

export function toApiWeight(weight) {
  return {
    participant_name: weight.participantName,
    weight: Number(weight.weight),
    included: weight.included ? 1 : 0,
  };
}
