import { assertDigest, canonicalJson, digestCanonicalJson, validateWorkOrderTerms, type Digest, type WorkOrderTerms } from '../../domain/src/contracts.ts';
import { checkCirclePackingWitness } from '../../../src/lib/circle-packing.ts';
import {
  CIRCLE_EVALUATOR_REPORT_FORMAT,
  CircleEvaluatorError,
  circleByteDigest,
  requireCircleEvaluatorProfile,
  type CircleEvaluatorProfile,
  type CircleEvaluatorReport,
  type TrustedCircleEvaluatorReportCapture,
} from './contract.ts';

export type CheckedCircleCandidate = {
  projectId: string;
  workOrderId: string;
  attemptId: string;
  workerEnvironmentId: string;
  termsDigest: Digest;
  inputDigest: Digest;
  inferenceProfileDigest: Digest;
  artifactManifestDigest: Digest;
  candidateDigest: Digest;
  candidateBytes: Uint8Array;
};

export type EvaluateCircleCandidateInput = {
  candidate: CheckedCircleCandidate;
  workOrderTerms: unknown;
  evaluationProfile: unknown;
  evaluationProfileDigest: Digest;
};

function fail(code: ConstructorParameters<typeof CircleEvaluatorError>[0], message: string): never {
  throw new CircleEvaluatorError(code, message);
}

function terms(input: EvaluateCircleCandidateInput): WorkOrderTerms {
  let value: WorkOrderTerms;
  try { value = validateWorkOrderTerms(input.workOrderTerms); }
  catch { return fail('BINDING_MISMATCH', 'Work-order terms are invalid.'); }
  let digest: Digest;
  try { digest = digestCanonicalJson(value); }
  catch { return fail('BINDING_MISMATCH', 'Work-order terms are not canonical JSON data.'); }
  if (digest !== input.candidate.termsDigest || value.project_id !== input.candidate.projectId
      || value.evaluation.profile_digest !== input.evaluationProfileDigest
      || value.hosted.inference.profile_digest !== input.candidate.inferenceProfileDigest
      || value.evaluation.human_acceptance_required !== true || value.hosted.enabled !== true) {
    fail('BINDING_MISMATCH', 'Candidate, immutable work-order terms, and evaluation profile do not match.');
  }
  return value;
}

/**
 * Pure trusted-evaluator core. The candidate must come from
 * `SealedCircleCandidateReader`; caller-supplied IDs do not establish origin.
 * It evaluates data only and creates no acceptance decision.
 */
export function evaluateCheckedCircleCandidate(input: EvaluateCircleCandidateInput): TrustedCircleEvaluatorReportCapture {
  if (!input || typeof input !== 'object' || !(input.candidate?.candidateBytes instanceof Uint8Array)) {
    fail('INPUT_INVALID', 'Circle evaluation input is invalid.');
  }
  const ids = [input.candidate.projectId, input.candidate.workOrderId, input.candidate.attemptId, input.candidate.workerEnvironmentId];
  if (ids.some(value => typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
    fail('IDENTITY_INVALID', 'Circle evaluation identities must be UUIDs.');
  }
  try {
    assertDigest(input.candidate.termsDigest, 'termsDigest');
    assertDigest(input.candidate.inputDigest, 'inputDigest');
    assertDigest(input.candidate.inferenceProfileDigest, 'inferenceProfileDigest');
    assertDigest(input.candidate.artifactManifestDigest, 'artifactManifestDigest');
    assertDigest(input.candidate.candidateDigest, 'candidateDigest');
    assertDigest(input.evaluationProfileDigest, 'evaluationProfileDigest');
  } catch { return fail('BINDING_MISMATCH', 'Circle evaluation contains an invalid binding digest.'); }
  const profile: CircleEvaluatorProfile = requireCircleEvaluatorProfile(input.evaluationProfile, input.evaluationProfileDigest);
  const frozenTerms = terms(input);
  if (input.candidate.candidateBytes.byteLength < 1
      || input.candidate.candidateBytes.byteLength > profile.candidate.maximum_bytes
      || circleByteDigest(input.candidate.candidateBytes) !== input.candidate.candidateDigest) {
    fail('CANDIDATE_DIGEST_MISMATCH', 'Candidate bytes do not match the sealed candidate digest and limits.');
  }
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(input.candidate.candidateBytes); }
  catch { return fail('CANDIDATE_INVALID', 'Candidate is not valid UTF-8.'); }
  const checked = checkCirclePackingWitness(source);
  // Some strict-parser diagnostics contain a worker-controlled JSON key. Keep
  // the checker classification while ensuring retained/public report bytes do
  // not echo arbitrary candidate text.
  const result = !checked.ok && checked.error.code === 'DUPLICATE_KEY'
    ? { ok: false as const, error: { code: checked.error.code, message: 'Witness contains a duplicate JSON object key.' } }
    : checked;
  const report: CircleEvaluatorReport = {
    format: CIRCLE_EVALUATOR_REPORT_FORMAT,
    binding: {
      project_id: input.candidate.projectId,
      project_revision: frozenTerms.project_revision,
      work_order_id: input.candidate.workOrderId,
      attempt_id: input.candidate.attemptId,
      worker_environment_id: input.candidate.workerEnvironmentId,
      agreement_id: frozenTerms.agreement_id,
      terms_digest: input.candidate.termsDigest,
      input_digest: input.candidate.inputDigest,
      inference_profile_digest: input.candidate.inferenceProfileDigest,
      artifact_manifest_digest: input.candidate.artifactManifestDigest,
      candidate_digest: input.candidate.candidateDigest,
      evaluation_profile_digest: input.evaluationProfileDigest,
    },
    checker: profile.checker,
    outcome: result.ok ? 'VALID' : 'REJECTED',
    result,
    human_acceptance: { status: 'PENDING', decision_id: null },
  };
  const bytes = Buffer.from(canonicalJson(report), 'utf8');
  return { bytes, expected_raw_report_digest: circleByteDigest(bytes), report };
}
