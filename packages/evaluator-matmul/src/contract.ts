import { createHash } from 'node:crypto';
import { canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import {
  MATMUL_4X4X4_REFERENCE_RANK,
  MATMUL_MAX_ABS_COEFFICIENT,
  MATMUL_MAX_BYTES,
  MATMUL_WITNESS_FORMAT,
  type MatmulCheck,
} from '../../../src/lib/matmul.ts';

export const MATMUL_EVALUATOR_PROFILE_FORMAT = 'motive.matmul.evaluator-profile/0.1' as const;
export const MATMUL_EVALUATOR_REPORT_FORMAT = 'motive.matmul.evaluator-report/0.1' as const;
export const MATMUL_CANDIDATE_PATH = 'candidate.json' as const;
export const MATMUL_CANDIDATE_MEDIA_TYPE = 'application/json' as const;
/** SHA-256 of `src/lib/matmul.ts`; the checker is pinned by this profile. */
export const MATMUL_CHECKER_SOURCE_DIGEST =
  'sha256:c7755859bab212047e4dddf10728d5fa92cfcbad24eb9a938685277003b99d51' as const;
/** SHA-256 of `public/projects/matmul-4x4x4/reference-witness.json`. */
export const MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST =
  'sha256:f1e033dc772abbfa0546cc8eeb04ae92c4de2358ee29ff9a653cf32fec3cd260' as const;

export type MatmulEvaluatorProfile = {
  format: typeof MATMUL_EVALUATOR_PROFILE_FORMAT;
  profile_id: 'matmul-4x4x4-z-exact-v1';
  candidate: {
    relative_path: typeof MATMUL_CANDIDATE_PATH;
    media_type: typeof MATMUL_CANDIDATE_MEDIA_TYPE;
    witness_format: typeof MATMUL_WITNESS_FORMAT;
    shape: readonly [4, 4, 4];
    ring: 'Z';
    maximum_bytes: typeof MATMUL_MAX_BYTES;
    maximum_abs_coefficient: typeof MATMUL_MAX_ABS_COEFFICIENT;
  };
  checker: {
    format: 'motive.matmul.local-check.v1';
    version: 1;
    source_digest: typeof MATMUL_CHECKER_SOURCE_DIGEST;
  };
  reference: {
    witness_digest: typeof MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST;
    exact_objective: '49';
  };
};

export const MATMUL_4X4X4_EVALUATOR_PROFILE: MatmulEvaluatorProfile = Object.freeze({
  format: MATMUL_EVALUATOR_PROFILE_FORMAT,
  profile_id: 'matmul-4x4x4-z-exact-v1',
  candidate: Object.freeze({
    relative_path: MATMUL_CANDIDATE_PATH,
    media_type: MATMUL_CANDIDATE_MEDIA_TYPE,
    witness_format: MATMUL_WITNESS_FORMAT,
    shape: Object.freeze([4, 4, 4] as const),
    ring: 'Z',
    maximum_bytes: MATMUL_MAX_BYTES,
    maximum_abs_coefficient: MATMUL_MAX_ABS_COEFFICIENT,
  }),
  checker: Object.freeze({
    format: 'motive.matmul.local-check.v1',
    version: 1,
    source_digest: MATMUL_CHECKER_SOURCE_DIGEST,
  }),
  reference: Object.freeze({
    witness_digest: MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST,
    exact_objective: String(MATMUL_4X4X4_REFERENCE_RANK) as '49',
  }),
});

export const MATMUL_4X4X4_EVALUATOR_PROFILE_DIGEST = digestCanonicalJson(MATMUL_4X4X4_EVALUATOR_PROFILE);

export type MatmulEvaluatorReport = {
  format: typeof MATMUL_EVALUATOR_REPORT_FORMAT;
  binding: {
    project_id: string;
    project_revision: number;
    work_order_id: string;
    attempt_id: string;
    worker_environment_id: string;
    agreement_id: string;
    terms_digest: Digest;
    input_digest: Digest;
    inference_profile_digest: Digest;
    artifact_manifest_digest: Digest;
    candidate_digest: Digest;
    evaluation_profile_digest: Digest;
  };
  checker: MatmulEvaluatorProfile['checker'];
  outcome: 'VALID' | 'REJECTED';
  result: MatmulCheck;
  human_acceptance: { status: 'PENDING'; decision_id: null };
};

export type MatmulEvaluatorErrorCode = 'PROFILE_INVALID';

export class MatmulEvaluatorError extends Error {
  constructor(readonly code: MatmulEvaluatorErrorCode, message: string) {
    super(message);
    this.name = 'MatmulEvaluatorError';
  }
}

export function matmulByteDigest(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function requireMatmulEvaluatorProfile(value: unknown, expectedDigest: Digest): MatmulEvaluatorProfile {
  let actualDigest: Digest;
  try { actualDigest = digestCanonicalJson(value); }
  catch { throw new MatmulEvaluatorError('PROFILE_INVALID', 'Matmul evaluator profile is not canonical JSON data.'); }
  if (actualDigest !== expectedDigest || expectedDigest !== MATMUL_4X4X4_EVALUATOR_PROFILE_DIGEST
      || canonicalJson(value) !== canonicalJson(MATMUL_4X4X4_EVALUATOR_PROFILE)) {
    throw new MatmulEvaluatorError('PROFILE_INVALID', 'Matmul evaluator profile does not match the reviewed ⟨4,4,4⟩ integer profile.');
  }
  return MATMUL_4X4X4_EVALUATOR_PROFILE;
}
