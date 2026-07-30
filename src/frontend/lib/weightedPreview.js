function resultChannels(mode) {
  if (mode === "virtual") return ["virtual"];
  if (mode === "mixed") return ["inperson", "virtual"];
  return ["inperson"];
}

function participantSchedule(participant, channel, slotCount) {
  const value = participant?.[`${channel}Array`];
  if (!Array.isArray(value) || value.length !== slotCount) return null;
  const parsed = value.map(Number);
  if (parsed.some((item) => !Number.isFinite(item) || item < 0 || item > 1)) return null;
  return parsed;
}

function roundScore(value) {
  return Number(value.toFixed(4));
}

export function buildWeightedPreview({
  participants = [],
  weights = {},
  mode = "inperson",
  slotCount = 0,
}) {
  const channels = resultChannels(mode);
  const counted = [];
  const unanswered = [];
  const excluded = [];

  participants.forEach((participant) => {
    const weight = weights[participant.id] ?? {
      weight: 1,
      included: 1,
      required: 0,
    };
    const required = Boolean(weight.required);

    if (participant.hidden) {
      excluded.push({ reason: "hidden", required });
      return;
    }
    if (!weight.included) {
      excluded.push({ reason: "organizerExcluded", required });
      return;
    }
    if (!participant.submitted) {
      unanswered.push({ required });
      return;
    }

    const availability = {};
    for (const channel of channels) {
      const schedule = participantSchedule(participant, channel, slotCount);
      if (!schedule) {
        excluded.push({ reason: "invalidResponse", required });
        return;
      }
      availability[channel] = schedule;
    }

    counted.push({
      availability,
      required,
      weight: Number(weight.weight),
    });
  });

  const unweightedTotals = Object.fromEntries(
    channels.map((channel) => [channel, Array(slotCount).fill(0)])
  );
  const weightedTotals = Object.fromEntries(
    channels.map((channel) => [channel, Array(slotCount).fill(0)])
  );
  const requiredConflicts = Object.fromEntries(
    channels.map((channel) => [channel, Array(slotCount).fill(0)])
  );
  let totalWeight = 0;
  let weightedParticipantTotal = 0;

  counted.forEach((entry) => {
    const weightValue = Number.isFinite(entry.weight) ? entry.weight : 0;
    if (weightValue > 0) {
      totalWeight += weightValue;
      weightedParticipantTotal += 1;
    }
    channels.forEach((channel) => {
      entry.availability[channel].forEach((value, index) => {
        unweightedTotals[channel][index] += value;
        if (weightValue > 0) weightedTotals[channel][index] += value * weightValue;
        if (entry.required && value <= 0) requiredConflicts[channel][index] += 1;
      });
    });
  });

  const countedResponseTotal = counted.length;
  const channelResults = Object.fromEntries(
    channels.map((channel) => [
      channel,
      {
        unweighted: unweightedTotals[channel].map((value) =>
          countedResponseTotal ? roundScore(value / countedResponseTotal) : 0
        ),
        weighted: weightedTotals[channel].map((value) =>
          totalWeight ? roundScore(value / totalWeight) : 0
        ),
      },
    ])
  );
  const exclusionReasons = Object.fromEntries(
    ["hidden", "organizerExcluded", "invalidResponse"].map((reason) => [
      reason,
      excluded.filter((entry) => entry.reason === reason).length,
    ])
  );

  return {
    countedResponseTotal,
    unansweredParticipantTotal: unanswered.length,
    excludedParticipantTotal: excluded.length,
    exclusionReasons,
    calculationBasis: {
      unweighted: { participantTotal: countedResponseTotal },
      weighted: {
        participantTotal: weightedParticipantTotal,
        totalWeight: roundScore(totalWeight),
      },
    },
    requiredParticipantConflicts: {
      unansweredRequiredParticipantTotal: unanswered.filter((entry) => entry.required).length,
      excludedRequiredParticipantTotal: excluded.filter((entry) => entry.required).length,
      channels: Object.fromEntries(
        channels.map((channel) => [
          channel,
          requiredConflicts[channel]
            .map((requiredParticipantTotal, slotIndex) => ({
              slotIndex,
              requiredParticipantTotal,
            }))
            .filter((entry) => entry.requiredParticipantTotal > 0),
        ])
      ),
    },
    channels: channelResults,
  };
}
