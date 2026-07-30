import { buildWeightedPreview } from "@/lib/weightedPreview";

function participant(id, inpersonArray, virtualArray, overrides = {}) {
  return {
    id,
    hidden: 0,
    submitted: 1,
    inpersonArray,
    virtualArray,
    ...overrides,
  };
}

describe("buildWeightedPreview", () => {
  test("matches weighted mixed-mode aggregation rules", () => {
    const result = buildWeightedPreview({
      mode: "mixed",
      slotCount: 2,
      participants: [
        participant("first", [1, 0], [0.5, 1]),
        participant("second", [0, 1], [1, 0.5]),
        participant("unanswered", [0, 0], [0, 0], { submitted: 0 }),
        participant("hidden", [1, 1], [1, 1], { hidden: 1 }),
        participant("excluded", [1, 1], [1, 1]),
      ],
      weights: {
        first: { weight: 0.5, included: 1, required: 1 },
        second: { weight: 1, included: 1, required: 0 },
        unanswered: { weight: 1, included: 1, required: 1 },
        hidden: { weight: 1, included: 1, required: 1 },
        excluded: { weight: 1, included: 0, required: 1 },
      },
    });

    expect(result.channels.inperson.unweighted).toEqual([0.5, 0.5]);
    expect(result.channels.inperson.weighted).toEqual([0.3333, 0.6667]);
    expect(result.channels.virtual.unweighted).toEqual([0.75, 0.75]);
    expect(result.channels.virtual.weighted).toEqual([0.8333, 0.6667]);
    expect(result.calculationBasis.weighted).toEqual({
      participantTotal: 2,
      totalWeight: 1.5,
    });
    expect(result.countedResponseTotal).toBe(2);
    expect(result.unansweredParticipantTotal).toBe(1);
    expect(result.excludedParticipantTotal).toBe(2);
    expect(result.requiredParticipantConflicts).toEqual({
      unansweredRequiredParticipantTotal: 1,
      excludedRequiredParticipantTotal: 2,
      channels: {
        inperson: [{ slotIndex: 1, requiredParticipantTotal: 1 }],
        virtual: [],
      },
    });
  });

  test("excludes invalid submissions and handles zero total weight", () => {
    const result = buildWeightedPreview({
      mode: "inperson",
      slotCount: 2,
      participants: [participant("zero", [1, 1], []), participant("invalid", [1], [])],
      weights: {
        zero: { weight: 0, included: 1, required: 0 },
        invalid: { weight: 1, included: 1, required: 0 },
      },
    });

    expect(result.channels.inperson.weighted).toEqual([0, 0]);
    expect(result.channels.inperson.unweighted).toEqual([1, 1]);
    expect(result.calculationBasis.weighted).toEqual({
      participantTotal: 0,
      totalWeight: 0,
    });
    expect(result.exclusionReasons.invalidResponse).toBe(1);
  });
});
