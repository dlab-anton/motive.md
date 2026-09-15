/**
 * Per-project participation profile. Everything the external contribution
 * loop needs to know about one project's checker, reference and work-order
 * terms lives here, so the service itself carries no project literals.
 *
 * The circle-packing profile reproduces the values the service used before
 * profiles existed, byte for byte where they are digested (the evaluation
 * profile, the work-order terms and the report envelope).
 */
import { checkCirclePackingWitness, type CirclePackingCheck } from '../../src/lib/circle-packing.ts';
import { compareCirclePackingWitnesses } from '../../src/lib/circle-packing-equivalence.ts';
import { checkMatmulWitness, MATMUL_4X4X4_PROFILE, MATMUL_4X4X4_REFERENCE_RANK, MATMUL_MAX_ABS_COEFFICIENT,
  MATMUL_WITNESS_FORMAT, type MatmulCheck } from '../../src/lib/matmul.ts';

export type CheckedWitnessOutcome =
  | { ok: true; exactScore: string; exceedsReference: boolean; result: CirclePackingCheck | MatmulCheck }
  | { ok: false; result: CirclePackingCheck | MatmulCheck };

export type ParticipationProjectProfile = {
  slug: string;
  unavailableMessage: string;
  workOrderKey: string;
  workOrderRevision: number;
  agreementId: string;
  /** Frozen input identity recorded as the work order input and every submission's base commit. */
  referenceCommit: string;
  referenceWitnessDigest: string;
  /** Whether a larger or a smaller exact score is better. */
  objectiveDirection: 'MAXIMIZE' | 'MINIMIZE';
  checker: { format: string; version: number; sourceDigest: string };
  witnessFormat: string;
  /** Hard cap enforced by the service and by the artifact table's byte constraint. */
  maximumWitnessBytes: number;
  licenseRef: string;
  allowedEffects: readonly string[];
  workOrderObjective: string;
  artifactManifestFormat: string;
  reportFormat: string;
  /** Canonicalised and digested into the work order's evaluation profile digest. */
  evaluationProfile: Record<string, unknown>;
  check: (witness: string) => CheckedWitnessOutcome;
  /** Exact structural comparison of two valid witnesses, where a family defines one. */
  compareWitnesses?: (left: string, right: string) => ReturnType<typeof compareCirclePackingWitnesses>;
};

const CIRCLE_CHECKER_SOURCE_DIGEST = 'sha256:a2f9904fe0359edda76b41b6c840b2ff219288c9cb8671d85376c1b1c0693559';
const CIRCLE_REFERENCE_WITNESS_DIGEST = 'sha256:4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e';
const CIRCLE_REFERENCE_SCORE = '5.29109518547430697';

export const CIRCLE_PACKING_PARTICIPATION_PROFILE: ParticipationProjectProfile = Object.freeze({
  slug: 'circle-packing',
  unavailableMessage: 'The public circle-packing project is unavailable.',
  workOrderKey: 'circle-packing-external',
  workOrderRevision: 1,
  agreementId: 'circle-packing-external-v1',
  referenceCommit: '80f08aa72d9d85d7d9d2a871825b46bdec471bb2',
  referenceWitnessDigest: CIRCLE_REFERENCE_WITNESS_DIGEST,
  objectiveDirection: 'MAXIMIZE',
  checker: Object.freeze({ format: 'motive.csqv.local-check.v1', version: 1, sourceDigest: CIRCLE_CHECKER_SOURCE_DIGEST }),
  witnessFormat: 'motive.csqv.witness.v1',
  maximumWitnessBytes: 32768,
  licenseRef: 'circle-packing-reference-terms-v1',
  allowedEffects: Object.freeze(['submit-data-only-circle-witness']),
  workOrderObjective: `Run one bounded N=101 witness test, retain its exact checker outcome, and compare its radius sum with ${CIRCLE_REFERENCE_SCORE}.`,
  artifactManifestFormat: 'motive.external-circle-artifact/0.1',
  reportFormat: 'motive.csqv.checked-report.v1',
  evaluationProfile: Object.freeze({ format: 'motive.csqv.local-check.v1', version: 1,
    sourceDigest: CIRCLE_CHECKER_SOURCE_DIGEST, n: 101,
    witnessFormat: 'motive.csqv.witness.v1', maximumBytes: 32768, maximumDecimalPlaces: 18,
    referenceWitnessDigest: CIRCLE_REFERENCE_WITNESS_DIGEST }),
  check: witness => {
    const checked = checkCirclePackingWitness(witness);
    return checked.ok
      ? { ok: true, exactScore: checked.report.objective.exact_decimal,
        exceedsReference: checked.report.objective.versus_frozen_reference_5_29109518547430697 === 'greater', result: checked }
      : { ok: false, result: checked };
  },
  compareWitnesses: compareCirclePackingWitnesses,
});

const MATMUL_CHECKER_SOURCE_DIGEST = 'sha256:c7755859bab212047e4dddf10728d5fa92cfcbad24eb9a938685277003b99d51';
const MATMUL_REFERENCE_WITNESS_SHA256 = 'f1e033dc772abbfa0546cc8eeb04ae92c4de2358ee29ff9a653cf32fec3cd260';
/** The artifact table caps witnesses at 32 KiB; a 4×4 scheme needs a few KiB. */
const MATMUL_PARTICIPATION_MAX_BYTES = 32768;
const MATMUL_PARTICIPATION_CHECK_PROFILE = Object.freeze({ ...MATMUL_4X4X4_PROFILE, maximumBytes: MATMUL_PARTICIPATION_MAX_BYTES });

export const MATMUL_4X4X4_PARTICIPATION_PROFILE: ParticipationProjectProfile = Object.freeze({
  slug: 'matmul-4x4x4',
  unavailableMessage: 'The public matmul-4x4x4 project is unavailable.',
  workOrderKey: 'matmul-4x4x4-external',
  workOrderRevision: 1,
  agreementId: 'matmul-4x4x4-external-v1',
  // The frozen reference is constructed, not fetched; its witness digest is the input identity.
  referenceCommit: MATMUL_REFERENCE_WITNESS_SHA256,
  referenceWitnessDigest: `sha256:${MATMUL_REFERENCE_WITNESS_SHA256}`,
  objectiveDirection: 'MINIMIZE',
  checker: Object.freeze({ format: 'motive.matmul.local-check.v1', version: 1, sourceDigest: MATMUL_CHECKER_SOURCE_DIGEST }),
  witnessFormat: MATMUL_WITNESS_FORMAT,
  maximumWitnessBytes: MATMUL_PARTICIPATION_MAX_BYTES,
  licenseRef: 'matmul-reference-terms-v1',
  allowedEffects: Object.freeze(['submit-data-only-matmul-scheme']),
  workOrderObjective: `Run one bounded 4×4×4 integer-scheme test, retain its exact checker outcome, and compare its number of products with ${MATMUL_4X4X4_REFERENCE_RANK}.`,
  artifactManifestFormat: 'motive.external-matmul-artifact/0.1',
  reportFormat: 'motive.matmul.checked-report.v1',
  evaluationProfile: Object.freeze({ format: 'motive.matmul.local-check.v1', version: 1,
    sourceDigest: MATMUL_CHECKER_SOURCE_DIGEST, shape: [4, 4, 4], ring: 'Z',
    witnessFormat: MATMUL_WITNESS_FORMAT, maximumBytes: MATMUL_PARTICIPATION_MAX_BYTES,
    maximumAbsCoefficient: MATMUL_MAX_ABS_COEFFICIENT,
    referenceWitnessDigest: `sha256:${MATMUL_REFERENCE_WITNESS_SHA256}`, referenceRank: MATMUL_4X4X4_REFERENCE_RANK }),
  check: witness => {
    const checked = checkMatmulWitness(witness, MATMUL_PARTICIPATION_CHECK_PROFILE);
    return checked.ok
      ? { ok: true, exactScore: String(checked.report.rank), exceedsReference: checked.report.versus_frozen_reference === 'less', result: checked }
      : { ok: false, result: checked };
  },
});

/** Projects the participation loop can serve besides the default circle-packing project. */
export const ADDITIONAL_PARTICIPATION_PROFILES: readonly ParticipationProjectProfile[] = Object.freeze([MATMUL_4X4X4_PARTICIPATION_PROFILE]);

export const PARTICIPATION_PROFILES: readonly ParticipationProjectProfile[] = Object.freeze([
  CIRCLE_PACKING_PARTICIPATION_PROFILE, ...ADDITIONAL_PARTICIPATION_PROFILES]);

export function participationProfileForSlug(slug: string): ParticipationProjectProfile | null {
  return PARTICIPATION_PROFILES.find(profile => profile.slug === slug) ?? null;
}
