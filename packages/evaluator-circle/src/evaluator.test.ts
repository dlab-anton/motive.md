import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import { canonicalJson, digestCanonicalJson, type Digest, type WorkOrderTerms } from '../../domain/src/contracts.ts';
import type { ArtifactSealProjection } from '../../orchestration/src/store-types.ts';
import {
  CIRCLE_CHECKER_SOURCE_DIGEST,
  CIRCLE_EVALUATOR_PROFILE,
  CIRCLE_EVALUATOR_PROFILE_DIGEST,
  SealedCircleCandidateReader,
  SealedCircleInvestigationReader,
  SealedCirclePackingEvaluator,
  circleByteDigest,
  evaluateCheckedCircleCandidate,
} from './index.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const workOrderId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const workerEnvironmentId = '44444444-4444-4444-8444-444444444444';
const inputDigest = digestCanonicalJson('input');
const inferenceProfileDigest = digestCanonicalJson('inference');
const referenceBytes = readFileSync(new URL('../../../public/projects/circle-packing/reference-witness.json', import.meta.url));

const stream = (bytes: Uint8Array): AsyncIterable<Uint8Array> => (async function* () { yield Uint8Array.from(bytes); })();
const token = (path: string) => createHash('sha256').update(path).digest('hex');

function workOrderTerms(): WorkOrderTerms {
  return {
    format: 'motive.work-order/0.1', project_id: projectId, project_revision: 2,
    agreement_id: 'circle-packing-independent-evaluation-v1', objective: 'Check one exact N=101 witness.',
    input_commit: '8'.repeat(40), allowed_effects: ['submit-data-only-circle-witness'],
    hosted: { enabled: true, inference: { currency: 'USD', ceiling: '1', profile_digest: inferenceProfileDigest }, maximum_runtime_seconds: 120 },
    external: { enabled: false, claim_required: true, max_active_claims: 1, max_lease_seconds: 60,
      late_submission_policy: 'reject', review_admission: 'manual',
      artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
    evaluation: { profile_digest: CIRCLE_EVALUATOR_PROFILE_DIGEST, human_acceptance_required: true },
  };
}

function fixture(candidateBytes = referenceBytes) {
  const terms = workOrderTerms();
  const termsDigest = digestCanonicalJson(terms);
  const prefix = `projects/${projectId}/attempts/${attemptId}/seals/${workerEnvironmentId}`;
  const candidateKey = `${prefix}/files/${token('candidate.json')}`;
  const logBytes = Buffer.from('worker diagnostic');
  const logKey = `${prefix}/files/${token('worker.log')}`;
  const manifest = {
    format: 'motive.artifact-manifest/0.1', project_id: projectId, work_order_id: workOrderId,
    attempt_id: attemptId, environment_id: workerEnvironmentId, terms_digest: termsDigest, input_digest: inputDigest,
    inference_profile_digest: inferenceProfileDigest, sandbox_profile_digest: digestCanonicalJson('sandbox'),
    launch_plan_digest: digestCanonicalJson('launch'), command_digest: digestCanonicalJson('command'),
    controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'worker-command', exitCode: 0 }, capture_status: 'COMPLETE',
    files: [
      { relative_path: 'candidate.json', media_type: 'application/json', availability: 'REQUIRED', bytes: candidateBytes.byteLength,
        digest: circleByteDigest(candidateBytes), object_key: candidateKey },
      { relative_path: 'worker.log', media_type: 'text/plain', availability: 'REQUIRED', bytes: logBytes.byteLength,
        digest: circleByteDigest(logBytes), object_key: logKey },
    ], missing_files: [], total_bytes: candidateBytes.byteLength + logBytes.byteLength,
    human_acceptance: { status: 'PENDING', decision_id: null },
  };
  let manifestBytes = Buffer.from(canonicalJson(manifest));
  const objects = new Map<string, Uint8Array>([[`${prefix}/manifest.json`, manifestBytes], [candidateKey, candidateBytes], [logKey, logBytes]]);
  const reads: string[] = [];
  const store: Pick<ImmutableObjectStore, 'readObject'> = { async readObject(input) {
    reads.push(input.objectKey); const bytes = objects.get(input.objectKey);
    return bytes ? { body: stream(bytes), declaredBytes: bytes.byteLength } : null;
  } };
  const contextResolver = { resolve: vi.fn(async () => ({ projectId, workerEnvironmentId })) };
  const reader = new SealedCircleCandidateReader({ store, contextResolver });
  const attempt = { id: attemptId, projectId, workOrderId, termsDigest, inputDigest, profileDigest: inferenceProfileDigest };
  const seal = (): ArtifactSealProjection => ({ environmentId: workerEnvironmentId, attemptId,
    manifestDigest: circleByteDigest(manifestBytes), receiptId: 'receipt', status: 'SEALED', failureCode: null, createdAt: new Date(0).toISOString() });
  const read = () => reader.read({ attempt, artifactSeal: seal(), signal: new AbortController().signal });
  const replaceManifest = () => { manifestBytes = Buffer.from(canonicalJson(manifest)); objects.set(`${prefix}/manifest.json`, manifestBytes); };
  return { terms, manifest, objects, candidateKey, logKey, reads, read, replaceManifest, seal, attempt, contextResolver, store };
}

describe('sealed circle evaluator', () => {
  it('reads only candidate.json from the authenticated seal and emits the exact baseline numeric result', async () => {
    const f = fixture();
    const evaluator = new SealedCirclePackingEvaluator({ store: f.store, contextResolver: f.contextResolver });
    const capture = await evaluator.evaluate({ attempt: f.attempt, artifactSeal: f.seal(), signal: new AbortController().signal,
      workOrderTerms: f.terms, evaluationProfile: CIRCLE_EVALUATOR_PROFILE,
      evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST });
    expect(f.reads).toEqual([expect.stringMatching(/\/manifest\.json$/), f.candidateKey]);
    expect(f.reads).not.toContain(f.logKey);
    expect(capture.report).toMatchObject({
      outcome: 'VALID',
      binding: { artifact_manifest_digest: f.seal().manifestDigest, candidate_digest: circleByteDigest(referenceBytes),
        evaluation_profile_digest: CIRCLE_EVALUATOR_PROFILE_DIGEST },
      result: { ok: true, report: { official: false,
        objective: { exact_decimal: '5.29109518547430697', versus_frozen_reference_5_29109518547430697: 'equal' } } },
      human_acceptance: { status: 'PENDING', decision_id: null },
    });
    expect(circleByteDigest(capture.bytes)).toBe(capture.expected_raw_report_digest);
    expect(Buffer.from(capture.bytes).toString('utf8')).toBe(canonicalJson(capture.report));
    expect(Buffer.from(capture.bytes).toString('utf8')).not.toContain('VERIFIED');
  });

  it('reads bounded investigation bytes through the same immutable seal binding and preserves legacy absence', async () => {
    const legacy = fixture();
    const legacyReader = new SealedCircleInvestigationReader({ store: legacy.store, contextResolver: legacy.contextResolver });
    await expect(legacyReader.read({ attempt: legacy.attempt, artifactSeal: legacy.seal(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'NOT_PROVIDED', investigationDigest: null, investigationBytes: null,
        artifactManifestDigest: legacy.seal().manifestDigest });

    const f = fixture();
    const bytes = Buffer.from(JSON.stringify({ format: 'motive.investigation.v1', proposal: 'Try the frozen baseline.',
      expectation: 'Match the exact reference.', conditions: ['Use N=101.'], observations: ['The exact score matched.'],
      assessment: 'The baseline was reproduced.', nextAction: 'Try a bounded perturbation.' }));
    const prefix = `projects/${projectId}/attempts/${attemptId}/seals/${workerEnvironmentId}`;
    const objectKey = `${prefix}/files/${token('investigation.json')}`;
    f.manifest.files.push({ relative_path: 'investigation.json', media_type: 'application/json', availability: 'OPTIONAL_ON_FAILURE',
      bytes: bytes.byteLength, digest: circleByteDigest(bytes), object_key: objectKey });
    f.manifest.files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
    f.manifest.total_bytes += bytes.byteLength; f.objects.set(objectKey, bytes); f.replaceManifest();
    const reader = new SealedCircleInvestigationReader({ store: f.store, contextResolver: f.contextResolver });
    const read = () => reader.read({ attempt: f.attempt, artifactSeal: f.seal(), signal: new AbortController().signal });
    await expect(read()).resolves.toMatchObject({ status: 'PRESENT', investigationDigest: circleByteDigest(bytes),
      artifactManifestDigest: f.seal().manifestDigest });
    f.objects.set(objectKey, Buffer.from('{}'));
    await expect(read()).rejects.toMatchObject({ code: 'INVESTIGATION_DIGEST_MISMATCH' });
  });

  it('retains an exact tiny-overlap rejection as a numerical evaluator result', async () => {
    const witness = JSON.parse(referenceBytes.toString('utf8')) as { circles: Array<{ x: string; y: string; r: string }> };
    // Shift circle 40 toward circle 20 by 3e-14. The exact squared overlap is
    // about 1.686e-15; the checker must reject it without tolerance or repair.
    witness.circles[39].x = '0.7644985568772291';
    const f = fixture(Buffer.from(JSON.stringify(witness)));
    const capture = evaluateCheckedCircleCandidate({ candidate: await f.read(), workOrderTerms: f.terms,
      evaluationProfile: CIRCLE_EVALUATOR_PROFILE, evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST });
    expect(capture.report).toMatchObject({ outcome: 'REJECTED', result: { ok: false, error: { code: 'OVERLAP' } } });
    expect(capture.report.human_acceptance.status).toBe('PENDING');
  });

  it('rejects storage substitutions and immutable terms/profile mismatches before evaluation', async () => {
    const changedObject = fixture(); changedObject.objects.set(changedObject.candidateKey, Buffer.from('{}'));
    await expect(changedObject.read()).rejects.toMatchObject({ code: 'CANDIDATE_DIGEST_MISMATCH' });

    const untrustedContext = fixture(); untrustedContext.contextResolver.resolve.mockResolvedValueOnce({
      projectId: '99999999-9999-4999-8999-999999999999', workerEnvironmentId,
    });
    await expect(untrustedContext.read()).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });

    const inferenceSubstitution = fixture(); inferenceSubstitution.manifest.inference_profile_digest = digestCanonicalJson('other-inference');
    inferenceSubstitution.replaceManifest();
    await expect(inferenceSubstitution.read()).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });

    const f = fixture(); const candidate = await f.read();
    await expect(() => evaluateCheckedCircleCandidate({ candidate, workOrderTerms: { ...f.terms, project_revision: 3 },
      evaluationProfile: CIRCLE_EVALUATOR_PROFILE, evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST }))
      .toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    await expect(() => evaluateCheckedCircleCandidate({ candidate, workOrderTerms: f.terms,
      evaluationProfile: { ...CIRCLE_EVALUATOR_PROFILE, profile_id: 'other' }, evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST }))
      .toThrowError(expect.objectContaining({ code: 'PROFILE_INVALID' }));
  });

  it('pins the reviewed profile to the checker source bytes used by the evaluator', () => {
    const checker = readFileSync(new URL('../../../src/lib/circle-packing.ts', import.meta.url));
    expect(`sha256:${createHash('sha256').update(checker).digest('hex')}` as Digest).toBe(CIRCLE_CHECKER_SOURCE_DIGEST);
  });

  it('does not retain worker-controlled duplicate-key text in report bytes', async () => {
    const secretLookingKey = 'OPENROUTER_API_KEY_sk-worker-controlled';
    const malformed = Buffer.from(`{"format":"motive.csqv.witness.v1","n":101,"circles":[],"${secretLookingKey}":1,"${secretLookingKey}":2}`);
    const f = fixture(malformed);
    const capture = evaluateCheckedCircleCandidate({ candidate: await f.read(), workOrderTerms: f.terms,
      evaluationProfile: CIRCLE_EVALUATOR_PROFILE, evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST });
    expect(capture.report).toMatchObject({ outcome: 'REJECTED', result: { ok: false,
      error: { code: 'DUPLICATE_KEY', message: 'Witness contains a duplicate JSON object key.' } } });
    expect(Buffer.from(capture.bytes).toString('utf8')).not.toContain(secretLookingKey);
  });
});
