import { createHash } from 'node:crypto';
import { canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import {
  CSQV_MAX_BYTES,
  CSQV_MAX_DECIMAL_PLACES,
  CSQV_N,
  CSQV_WITNESS_FORMAT,
  type CirclePackingCheck,
} from '../../../src/lib/circle-packing.ts';

export const CIRCLE_EVALUATOR_PROFILE_FORMAT = 'motive.csqv.evaluator-profile/0.1' as const;
export const CIRCLE_EVALUATOR_REPORT_FORMAT = 'motive.csqv.evaluator-report/0.1' as const;
export const CIRCLE_CANDIDATE_PATH = 'candidate.json' as const;
export const CIRCLE_CANDIDATE_MEDIA_TYPE = 'application/json' as const;
export const CIRCLE_CHECKER_SOURCE_DIGEST =
  'sha256:a2f9904fe0359edda76b41b6c840b2ff219288c9cb8671d85376c1b1c0693559' as const;
export const CIRCLE_REFERENCE_WITNESS_DIGEST =
  'sha256:4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e' as const;

export type CircleEvaluatorProfile = {
  format: typeof CIRCLE_EVALUATOR_PROFILE_FORMAT;
  profile_id: 'circle-packing-n101-exact-v1';
  candidate: {
    relative_path: typeof CIRCLE_CANDIDATE_PATH;
    media_type: typeof CIRCLE_CANDIDATE_MEDIA_TYPE;
    witness_format: typeof CSQV_WITNESS_FORMAT;
    n: typeof CSQV_N;
    maximum_bytes: typeof CSQV_MAX_BYTES;
    maximum_decimal_places: typeof CSQV_MAX_DECIMAL_PLACES;
  };
  checker: {
    format: 'motive.csqv.local-check.v1';
    version: 1;
    source_digest: typeof CIRCLE_CHECKER_SOURCE_DIGEST;
  };
  reference: {
    witness_digest: typeof CIRCLE_REFERENCE_WITNESS_DIGEST;
    exact_objective: '5.29109518547430697';
  };
};

export const CIRCLE_EVALUATOR_PROFILE: CircleEvaluatorProfile = Object.freeze({
  format: CIRCLE_EVALUATOR_PROFILE_FORMAT,
  profile_id: 'circle-packing-n101-exact-v1',
  candidate: Object.freeze({
    relative_path: CIRCLE_CANDIDATE_PATH,
    media_type: CIRCLE_CANDIDATE_MEDIA_TYPE,
    witness_format: CSQV_WITNESS_FORMAT,
    n: CSQV_N,
    maximum_bytes: CSQV_MAX_BYTES,
    maximum_decimal_places: CSQV_MAX_DECIMAL_PLACES,
  }),
  checker: Object.freeze({
    format: 'motive.csqv.local-check.v1',
    version: 1,
    source_digest: CIRCLE_CHECKER_SOURCE_DIGEST,
  }),
  reference: Object.freeze({
    witness_digest: CIRCLE_REFERENCE_WITNESS_DIGEST,
    exact_objective: '5.29109518547430697',
  }),
});

export const CIRCLE_EVALUATOR_PROFILE_DIGEST = digestCanonicalJson(CIRCLE_EVALUATOR_PROFILE);

export type CircleEvaluatorReport = {
  format: typeof CIRCLE_EVALUATOR_REPORT_FORMAT;
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
  checker: CircleEvaluatorProfile['checker'];
  outcome: 'VALID' | 'REJECTED';
  result: CirclePackingCheck;
  human_acceptance: { status: 'PENDING'; decision_id: null };
};

export type TrustedCircleEvaluatorReportCapture = {
  bytes: Uint8Array;
  expected_raw_report_digest: Digest;
  report: CircleEvaluatorReport;
};

export type CircleEvaluatorErrorCode =
  | 'INPUT_INVALID'
  | 'IDENTITY_INVALID'
  | 'PROFILE_INVALID'
  | 'BINDING_MISMATCH'
  | 'ARTIFACT_UNAVAILABLE'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'CANDIDATE_UNAVAILABLE'
  | 'CANDIDATE_INVALID'
  | 'CANDIDATE_DIGEST_MISMATCH'
  | 'INVESTIGATION_UNAVAILABLE'
  | 'INVESTIGATION_INVALID'
  | 'INVESTIGATION_DIGEST_MISMATCH'
  | 'ABORTED';

export class CircleEvaluatorError extends Error {
  constructor(readonly code: CircleEvaluatorErrorCode, message: string) {
    super(message);
    this.name = 'CircleEvaluatorError';
  }
}

export function circleByteDigest(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function requireCircleEvaluatorProfile(value: unknown, expectedDigest: Digest): CircleEvaluatorProfile {
  let actualDigest: Digest;
  try { actualDigest = digestCanonicalJson(value); }
  catch { throw new CircleEvaluatorError('PROFILE_INVALID', 'Circle evaluator profile is not canonical JSON data.'); }
  if (actualDigest !== expectedDigest || expectedDigest !== CIRCLE_EVALUATOR_PROFILE_DIGEST
      || canonicalJson(value) !== canonicalJson(CIRCLE_EVALUATOR_PROFILE)) {
    throw new CircleEvaluatorError('PROFILE_INVALID', 'Circle evaluator profile does not match the reviewed N=101 profile.');
  }
  return CIRCLE_EVALUATOR_PROFILE;
}
