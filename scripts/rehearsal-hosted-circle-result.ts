import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import type { ImmutableObjectStore } from '../packages/artifact-storage/src/types.ts';
import { canonicalJson, digestCanonicalJson, type WorkOrderTerms } from '../packages/domain/src/contracts.ts';
import { CIRCLE_EVALUATOR_PROFILE_DIGEST, circleByteDigest } from '../packages/evaluator-circle/src/index.ts';
import type { WorkerLaunchPlan } from '../packages/orchestration/src/coordinator.ts';
import { PostgresOrchestrationStore } from '../packages/orchestration/src/store.ts';
import { defineProtectedRuntime } from '../packages/sandbox-vercel/src/protected-runtime.ts';
import { createCircleResultsService } from '../server/circle-results/index.ts';

const stream = (bytes: Uint8Array): AsyncIterable<Uint8Array> => (async function* () { yield Uint8Array.from(bytes); })();
const token = (path: string) => createHash('sha256').update(path).digest('hex');

export const REHEARSAL_HOSTED_INVESTIGATION = {
  format: 'motive.investigation.v1' as const,
  proposal: 'Reproduce the frozen N=101 arrangement through the hosted path and retain the result as a baseline.',
  expectation: 'The independent checker should confirm a valid packing equal to the frozen reference, without establishing an improvement.',
  conditions: ['Use the published 101-circle coordinate witness unchanged.', 'Apply the exact local boundary and pairwise non-overlap checks.'],
  observations: ['The sealed candidate matched the published reference bytes.', 'The exact checker returned 5.29109518547430697, equal to the frozen reference.'],
  assessment: 'This non-improving result confirms the hosted checking path for the baseline; it does not support a better-packing claim.',
  nextAction: 'Test a bounded search change and retain its valid result even when it does not improve the reference.',
};

/** Creates only disposable, explicitly synthetic provider state, then invokes the real sealed-data evaluator service. */
export async function seedRehearsalHostedCircleResult(pool: Pool, objects: Map<string, Uint8Array>) {
  const ledger = new LedgerKernel(pool); const store = new PostgresOrchestrationStore(pool);
  const project = await pool.query("SELECT id FROM motive.projects WHERE slug='circle-packing' AND visibility='PUBLIC'");
  if (project.rowCount !== 1) throw new Error('Disposable circle-packing project is unavailable.');
  const projectId = project.rows[0].id as string; const operator = 'operator:seed';
  const researcher = 'account:isolated-hosted-researcher';
  await ledger.setControllerSpending({ actorId: operator, idempotencyKey: randomUUID(), enabled: true, reason: 'disposable hosted-result browser rehearsal' });
  const source = await ledger.createFundingSource({ actorId: operator, idempotencyKey: randomUUID(), authorizedAmount: '10', metadata: { rehearsal: true } });
  const grant = await ledger.createGrant({ actorId: operator, idempotencyKey: randomUUID(), sourceId: source.id, projectId,
    beneficiaryActorId: researcher, limitAmount: '5' });
  const inferenceProfileDigest = digestCanonicalJson('isolated-browser-openai-astra-profile');
  const terms: WorkOrderTerms = { format: 'motive.work-order/0.1', project_id: projectId, project_revision: 1,
    agreement_id: 'agreement:isolated-hosted-circle-review-v1', objective: 'Reproduce and exactly check the frozen N=101 reference.',
    input_commit: 'e'.repeat(40), allowed_effects: ['read-approved-inputs', 'write-isolated-workspace', 'submit-data-only-witness'],
    hosted: { enabled: true, inference: { currency: 'USD', ceiling: '2', profile_digest: inferenceProfileDigest }, maximum_runtime_seconds: 120 },
    external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
      late_submission_policy: 'reject', review_admission: 'manual',
      artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
    evaluation: { profile_digest: CIRCLE_EVALUATOR_PROFILE_DIGEST, human_acceptance_required: true } };
  const work = await ledger.createWorkOrder({ actorId: operator, idempotencyKey: randomUUID(), projectId,
    workOrderKey: 'rehearsal-hosted-circle', revision: 1, terms, state: 'READY' });
  const attempt = await ledger.reserveAttempt({ actorId: operator, idempotencyKey: randomUUID(), grantId: grant.id,
    workOrderId: work.id, ceilingAmount: '2', profileDigest: inferenceProfileDigest, inputDigest: digestCanonicalJson('isolated-browser-hosted-input') });

  const connectionId = randomUUID(); const budgetId = randomUUID();
  await pool.query(`INSERT INTO motive.provider_connections
    (id,owner_actor_id,provider,credential_ref,status,encrypted_credential,credential_fingerprint,provider_metadata)
    VALUES($1,$2,'openrouter',$3,'CONNECTED',$4,$5,'{"rehearsal":true}')`,
  [connectionId, operator, `openrouter:${randomUUID()}`, Buffer.from('isolated-encrypted-placeholder'), digestCanonicalJson('isolated-credential')]);
  await pool.query(`INSERT INTO motive.provider_project_budgets
    (id,connection_id,owner_actor_id,project_id,source_id,grant_id,work_order_id,provider,model_id,limit_usd,status,
     idempotency_key,request_digest,beneficiary_actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'openrouter','openai/gpt-6-astra',2,'ACTIVE',$8,$9,$10)`,
  [budgetId, connectionId, operator, projectId, source.id, grant.id, work.id, randomUUID(), digestCanonicalJson('isolated-budget'), researcher]);
  await pool.query(`INSERT INTO motive.provider_budget_activations
    (budget_id,work_order_id,grant_id,attempt_id,profile_digest,idempotency_key,request_digest,status,beneficiary_actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'AWAITING_DISPATCH',$8)`,
  [budgetId, work.id, grant.id, attempt.id, inferenceProfileDigest, randomUUID(), digestCanonicalJson('isolated-activation'), researcher]);

  const authorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: source.id,
    sourceAccountRef: `isolated:${source.id}`, actorId: operator, limitUsd: '2', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const lease = await store.acquireLease(attempt.id, `isolated-hosted:${randomUUID()}`, 300);
  const sandboxDigest = digestCanonicalJson('isolated-sandbox');
  const plan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: work.id, termsDigest: attempt.termsDigest,
    inputDigest: attempt.inputDigest, inferenceProfileDigest, actorId: researcher, infrastructureAuthorizationId: authorization.id,
    maximumCostUsd: '1', capabilityTtlSeconds: 120, command: { executable: '/usr/local/bin/codex', args: ['exec', 'isolated fixture only'] },
    sandbox: { format: 'motive.sandbox-profile/0.1', profileDigest: sandboxDigest,
      protectedRuntime: defineProtectedRuntime(digestCanonicalJson('isolated-runtime')),
      trustedSource: { kind: 'snapshot', snapshotId: 'snap_IsolatedCircle1', sourceCommit: 'f'.repeat(40),
        materialDigest: digestCanonicalJson('isolated-source'), buildRecipeDigest: digestCanonicalJson('isolated-recipe') },
      timeoutMs: 120000, commandTimeoutMs: 60000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [], artifacts: [] }, artifacts: { maxFiles: 1, maxFileBytes: 32768, maxTotalBytes: 32768 } } };
  const reserved = await store.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: sandboxDigest,
    profileSnapshot: plan.sandbox as unknown as Record<string, unknown>, launchPlanDigest: digestCanonicalJson(plan),
    infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1' });
  await store.claimEffect(lease, reserved.effect.effectId);
  await store.recordCreateResult(lease, reserved.effect.effectId, { provider: 'synthetic-browser-rehearsal',
    externalId: `isolated-worker:${randomUUID()}`, sessionId: randomUUID() });
  await store.recordObservation(lease, reserved.environment.id, { providerStatus: 'running', providerTerminal: false, state: 'ACTIVE' });

  const candidate = Buffer.from(await readFile('public/projects/circle-packing/reference-witness.json'));
  const investigation = Buffer.from(canonicalJson(REHEARSAL_HOSTED_INVESTIGATION));
  const prefix = `projects/${projectId}/attempts/${attempt.id}/seals/${reserved.environment.id}`;
  const candidateKey = `${prefix}/files/${token('candidate.json')}`;
  const investigationKey = `${prefix}/files/${token('investigation.json')}`;
  const manifest = { format: 'motive.artifact-manifest/0.1', project_id: projectId, work_order_id: work.id,
    attempt_id: attempt.id, environment_id: reserved.environment.id, terms_digest: attempt.termsDigest, input_digest: attempt.inputDigest,
    inference_profile_digest: inferenceProfileDigest, sandbox_profile_digest: sandboxDigest,
    launch_plan_digest: digestCanonicalJson(plan), command_digest: digestCanonicalJson(plan.command),
    controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'isolated-worker-command', exitCode: 0 }, capture_status: 'COMPLETE',
    files: [
      { relative_path: 'candidate.json', media_type: 'application/json', availability: 'REQUIRED', bytes: candidate.byteLength,
        digest: circleByteDigest(candidate), object_key: candidateKey },
      { relative_path: 'investigation.json', media_type: 'application/json', availability: 'OPTIONAL_ON_FAILURE', bytes: investigation.byteLength,
        digest: circleByteDigest(investigation), object_key: investigationKey },
    ], missing_files: [], total_bytes: candidate.byteLength + investigation.byteLength,
    human_acceptance: { status: 'PENDING', decision_id: null } };
  const manifestBytes = Buffer.from(canonicalJson(manifest)); objects.set(`${prefix}/manifest.json`, manifestBytes);
  objects.set(candidateKey, candidate); objects.set(investigationKey, investigation);
  await store.recordArtifactSeal(lease, reserved.environment.id, { manifestDigest: circleByteDigest(manifestBytes), receiptId: `isolated:${randomUUID()}` });
  const stop = await store.requestStop(lease, reserved.environment.id, { preserveEvaluation: true }); await store.claimEffect(lease, stop.effect.effectId);
  await store.recordStopResult(lease, stop.effect.effectId, { providerStatus: 'stopped', providerTerminal: true, state: 'TERMINATED' });
  const objectStore: Pick<ImmutableObjectStore, 'readObject'> = { async readObject(input) {
    const bytes = objects.get(input.objectKey); return bytes ? { body: stream(bytes), declaredBytes: bytes.byteLength } : null;
  } };
  const result = await createCircleResultsService({ pool, objects: objectStore }).evaluateAttempt(attempt.id);
  if (result.status !== 'VALID' || result.exactScore !== '5.29109518547430697' || result.exceedsReference !== false) {
    throw new Error('Disposable hosted reference did not produce the expected exact numerical result.');
  }
  return result;
}
