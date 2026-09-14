import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import type { ImmutableObjectStore } from '../../packages/artifact-storage/src/types.ts';
import { digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import { PostgresEvidenceStore } from '../../packages/evidence/src/store.ts';
import type { EvaluationProjection } from '../../packages/evidence/src/types.ts';
import { profile } from '../../packages/evaluator-lean/src/runtime-profile.fixture.ts';
import { DurableEvaluatorCoordinator, type EvaluatorCoordinatorDependencies, type EvaluatorLaunchPlan, type EvaluatorRuntime } from '../../packages/orchestration/src/evaluator-coordinator.ts';
import { DurableEvaluatorReports } from '../../packages/orchestration/src/evaluator-reports.ts';
import { createLearningCoordinator } from '../../packages/orchestration/src/learning-coordinator.ts';
import type { WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { EnvironmentHandle, ProviderObservation } from '../../packages/orchestration/src/store-types.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const hash = digestCanonicalJson('synthetic evaluator lifecycle fixture');
const sha = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const running: ProviderObservation = { providerStatus: 'running', providerTerminal: false, state: 'ACTIVE' };
const stopped: ProviderObservation = { providerStatus: 'stopped', providerTerminal: true, state: 'TERMINATED' };
const reviewBinding = (value: EvaluationProjection) => ({ attemptId: value.attemptId, artifactManifestDigest: value.artifactManifestDigest,
  termsDigest: value.termsDigest, evaluatorProfileDigest: value.evaluatorProfileDigest, rawReportDigest: value.rawReportDigest });

describe.skipIf(!databaseUrl)('local evaluator lifecycle with PostgreSQL and synthetic provider', () => {
  let pool: Pool, ledger: LedgerKernel, store: PostgresOrchestrationStore, evidence: PostgresEvidenceStore;
  const cleanup: Array<() => Promise<void>> = [];
  const checkpoints: unknown[] = [];
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12, query_timeout: 5000, connectionTimeoutMillis: 2000 });
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool); store = new PostgresOrchestrationStore(pool); evidence = new PostgresEvidenceStore(pool);
  });
  beforeEach(async () => { await ledger.setControllerSpending({ actorId: 'evaluator-lifecycle-test', idempotencyKey: randomUUID(), enabled: true, reason: 'Synthetic local rehearsal only' }); });
  afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
  afterAll(async () => {
    try { await ledger?.setControllerSpending({ actorId: 'evaluator-lifecycle-test', idempotencyKey: randomUUID(), enabled: false, reason: 'Local rehearsal complete' }); }
    finally { await pool?.end(); }
    if (process.env.MOTIVE_LOOP_EVIDENCE_PATH) await writeFile(process.env.MOTIVE_LOOP_EVIDENCE_PATH, JSON.stringify({
      format: 'motive.local-learning-loop-rehearsal/0.1', capturedAt: new Date().toISOString(),
      scope: 'Real PostgreSQL application lifecycle with synthetic provider/checker observations; not a Lean or cloud execution claim.',
      purpose: 'Check that one bounded attempt preserves evidence and distinguishes automated outcomes from authorized acceptance.',
      checkpoints,
    }, null, 2));
  });

  async function setup(outcome: 'VERIFIED' | 'REJECTED' | 'INCONCLUSIVE' = 'VERIFIED') {
    const actorId = `researcher:${randomUUID()}`, ownerId = `loop:${randomUUID()}`;
    const project = await ledger.createProject({ actorId, idempotencyKey: randomUUID(), slug: `loop-${randomUUID()}`, visibility: 'PRIVATE',
      revisionContent: { title: 'Propose/Test/Update synthetic rehearsal', purpose: 'Test the frozen target and retain only justified conclusions.' } });
    const source = await ledger.createFundingSource({ actorId, idempotencyKey: randomUUID(), authorizedAmount: '10', metadata: { synthetic: true } });
    const grant = await ledger.createGrant({ actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id, limitAmount: '5' });
    const work = await ledger.createWorkOrder({ actorId, idempotencyKey: randomUUID(), projectId: project.id, workOrderKey: 'loop-fixture', revision: 1, state: 'READY', terms: {
      format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1, agreement_id: `agreement:${randomUUID()}`,
      objective: 'Check a candidate against the frozen formal statement; do not infer general method performance.', input_commit: 'c'.repeat(40),
      allowed_effects: ['read-approved-inputs', 'submit-artifact'],
      hosted: { enabled: true, inference: { currency: 'USD', ceiling: '2.000000000000', profile_digest: hash }, maximum_runtime_seconds: 120 },
      external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120, late_submission_policy: 'reject', review_admission: 'manual',
        artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true } },
      evaluation: { profile_digest: digestCanonicalJson(profile), human_acceptance_required: true },
    } });
    const attempt = await ledger.reserveAttempt({ actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: work.id,
      ceilingAmount: '2', profileDigest: hash, inputDigest: hash });
    const authorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: source.id,
      sourceAccountRef: `synthetic:${source.id}`, actorId, limitUsd: '3', expiresAt: new Date(Date.now() + 600000).toISOString() });
    const lease = await store.acquireLease(attempt.id, ownerId, 300);
    const workerPlan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: work.id, termsDigest: attempt.termsDigest,
      inputDigest: hash, inferenceProfileDigest: hash, actorId, infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1',
      capabilityTtlSeconds: 120, command: { executable: '/usr/local/bin/codex', args: ['exec', 'synthetic fixture'] },
      sandbox: { format: 'motive.sandbox-profile/0.1', profileDigest: hash, protectedRuntime: defineProtectedRuntime(hash),
        trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40), materialDigest: hash, buildRecipeDigest: hash },
        timeoutMs: 120000, commandTimeoutMs: 60000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
        egress: { gateway: [{ url: 'https://gateway.example.com/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
          artifacts: [{ url: 'https://artifacts.example.com/upload/', methods: ['PUT'], pathMatch: 'prefix' }] },
        artifacts: { maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 8192 } } };
    const reserved = await store.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: hash, profileSnapshot: workerPlan.sandbox as unknown as Record<string, unknown>,
      launchPlanDigest: digestCanonicalJson(workerPlan), infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1' });
    await store.claimEffect(lease, reserved.effect.effectId);
    await store.recordCreateResult(lease, reserved.effect.effectId, { provider: 'synthetic', externalId: `worker:${randomUUID()}`, sessionId: randomUUID() });
    await store.recordObservation(lease, reserved.environment.id, running);
    await ledger.issueRunCapability({ actorId, idempotencyKey: randomUUID(), attemptId: attempt.id, ttlSeconds: 120 });
    const artifact = await store.recordArtifactSeal(lease, reserved.environment.id, { manifestDigest: hash, receiptId: `sealed:${randomUUID()}` });
    const stop = await store.requestStop(lease, reserved.environment.id, { preserveEvaluation: true });
    await store.claimEffect(lease, stop.effect.effectId);
    await store.recordStopResult(lease, stop.effect.effectId, stopped);
    const plan: EvaluatorLaunchPlan = { format: 'motive.evaluator-launch/0.1', workOrderId: work.id, termsDigest: attempt.termsDigest,
      inputDigest: attempt.inputDigest, evaluatorProfileDigest: digestCanonicalJson(profile), evaluatorProfile: profile,
      artifactManifestDigest: hash,
      infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1',
      command: { executable: '/opt/evaluator/bin/trusted-launcher', args: [], timeoutMs: 60000 } };
    const objects = new Map<string, Uint8Array>();
    const objectStore: ImmutableObjectStore = {
      async putIfAbsent(input) {
        const parts: Uint8Array[] = []; for await (const chunk of input.body) parts.push(Uint8Array.from(chunk));
        const bytes = Buffer.concat(parts);
        if (objects.has(input.objectKey)) return { status: 'EXISTS', objectId: input.objectKey };
        objects.set(input.objectKey, bytes); return { status: 'CREATED', objectId: input.objectKey };
      },
      async readObject(input) {
        const bytes = objects.get(input.objectKey);
        return bytes ? { declaredBytes: bytes.length, body: (async function* () { yield bytes; })() } : null;
      },
    };
    const calls: string[] = [];
    let remote: EnvironmentHandle | null = null, terminal = false;
    const switches = { createResponseLoss: false, commandResponseLoss: false, stopResponseLoss: false, evidenceResponseLoss: false,
      captureUnavailable: false, captureReadFailure: false, commandRunning: false, unconfigured: false, registryUnavailable: false };
    const runtime: EvaluatorRuntime = {
      async assertReady() {},
      async create(environment, _plan, operationId) {
        expect((await store.getExecution(attempt.id))!.effects.find(effect => effect.effectId === operationId)?.state).toBe('CLAIMED');
        calls.push('create'); remote = { provider: 'synthetic', externalId: `evaluator:${environment.id}`, sessionId: randomUUID() };
        if (switches.createResponseLoss) throw new Error('Synthetic create response lost');
        return remote;
      },
      async recoverCreate(environment) { calls.push('recover-create'); expect(remote?.externalId).toBe(`evaluator:${environment.id}`); return remote; },
      async observe(environment) { expect(environment.sessionId).toBe(remote?.sessionId); return terminal ? stopped : running; },
      async start(_environment, _plan, operationId) {
        expect((await store.getExecution(attempt.id))!.effects.find(effect => effect.effectId === operationId)?.state).toBe('CLAIMED');
        calls.push('command');
        if (switches.commandResponseLoss) throw new Error('Synthetic command response lost');
        return { providerCommandId: 'synthetic-command-1' };
      },
      async observeCommand(_environment, id) { expect(id).toBe('synthetic-command-1'); return { state: switches.commandRunning ? 'RUNNING' : 'EXITED' }; },
      async capture() {
        calls.push('capture');
        if (switches.captureReadFailure) throw new Error('Synthetic temporary capture read failure');
        if (switches.captureUnavailable) return null;
        // Explicit synthetic checker observations; this suite does not establish native isolation.
        const facts = Buffer.from(JSON.stringify({ format: 'motive.comparator-facts/0.1', outcome,
          current_stage: outcome === 'VERIFIED' ? 'complete' : outcome === 'REJECTED' ? 'statement_comparison' : 'solution_build',
          rejection_stage: outcome === 'REJECTED' ? 'statement_comparison' : null,
          protected_build: outcome !== 'INCONCLUSIVE', toolchain_and_export: outcome !== 'INCONCLUSIVE', exported_terms: outcome !== 'INCONCLUSIVE',
          statement_comparison: outcome === 'VERIFIED', transitive_axioms: outcome === 'VERIFIED', kernel_replay: outcome === 'VERIFIED',
          used_transitive_axioms: outcome === 'VERIFIED' ? [] : null }));
        const bytes = Buffer.from(JSON.stringify({ format: 'motive.lean-comparator-report/0.2', evaluator_profile_digest: plan.evaluatorProfileDigest,
          challenge_digest: profile.challenge.challenge_digest, dependency_lock_digest: profile.challenge.dependency_lock_digest,
          trusted_build_config_digest: profile.challenge.trusted_build_config_digest, solution_artifact_manifest_digest: hash,
          runtime_digest: digestCanonicalJson(profile.runtime), runtime_preflight: { af_unix_denied: true, landlock_enforced: true, namespace_identity: true, descendants_reaped: true, protected_report_capture: true },
          input_preflight: { trusted_challenge: true, trusted_dependencies: true, candidate_source_only: true },
          facts_capture: { bytes_base64: facts.toString('base64'), digest: sha(facts) } }));
        return { bytes, expected_raw_report_digest: sha(bytes) };
      },
      async stop(_environment, operationId) {
        expect((await store.getExecution(attempt.id))!.effects.find(effect => effect.effectId === operationId)?.state).toBe('CLAIMED');
        calls.push('stop'); terminal = true;
        if (switches.stopResponseLoss) throw new Error('Synthetic stop response lost');
        return stopped;
      },
    };
    let recorded: EvaluationProjection | null = null;
    const deps: EvaluatorCoordinatorDependencies = { store, ledger, reports: new DurableEvaluatorReports(objectStore),
      resolvePlan: async () => { if (switches.registryUnavailable) throw new Error('Synthetic registry outage'); return switches.unconfigured ? null : plan; }, runtime, ownerId, leaseSeconds: 300,
      evidence: { async recordTrustedEvaluatorCapture(input) {
        recorded = await evidence.recordTrustedEvaluatorCapture(input);
        if (!terminal && recorded.outcome === 'VERIFIED') {
          await expect(evidence.decideAcceptance({ actorId, idempotencyKey: randomUUID(), evaluationId: recorded.id,
            decision: 'ACCEPTED', expectedReview: reviewBinding(recorded) })).rejects.toMatchObject({ code: 'REVIEW_NOT_READY' });
        }
        if (switches.evidenceResponseLoss) { switches.evidenceResponseLoss = false; throw new Error('Synthetic evidence commit response lost'); }
        return recorded;
      } } };
    cleanup.push(async () => {
      const lease = await store.acquireLease(attempt.id, deps.ownerId, 300);
      for (const environment of (await store.getExecution(attempt.id))!.environments) {
        if (['TERMINATED', 'ABANDONED'].includes(environment.state)) continue;
        if (!environment.externalId && (await store.getExecution(attempt.id))!.effects.find(item => item.environmentId === environment.id && item.kind === 'CREATE')?.state === 'INTENT_RECORDED') {
          await store.abandonReservedEnvironment(lease, environment.id); continue;
        }
        await store.recordObservation(lease, environment.id, stopped);
      }
    });
    const noWorkerEffect = async (): Promise<never> => { throw new Error('Sealed worker handoff must not dispatch another worker effect'); };
    return { actorId, attempt, lease, plan, calls, switches, deps, objects, artifact, get recorded() { return recorded; },
      async loopStep() {
        return createLearningCoordinator({ store, ledger, ownerId: deps.ownerId, leaseSeconds: 300, resolvePlan: async () => workerPlan,
          adapter: () => ({ create: noWorkerEffect, observe: noWorkerEffect, discoverOwned: noWorkerEffect, startCommand: noWorkerEffect, observeCommand: noWorkerEffect, stop: noWorkerEffect }),
          artifacts: { assertReady: noWorkerEffect, seal: noWorkerEffect },
          orphanProvider: { discover: async () => ({ sandboxes: [], complete: true }), stopOwned: noWorkerEffect } }, deps).reconcileAttempt(attempt.id);
      },
      coordinator: () => new DurableEvaluatorCoordinator(deps), async step() { return new DurableEvaluatorCoordinator(deps).reconcileAttempt(attempt.id); } };
  }

  it('retries failed input preparation before claiming CREATE and forwards the prepared bytes once', async () => {
    const fixture = await setup();
    fixture.deps.runtime.prepareCreate = async () => { throw new Error('sealed storage temporarily unavailable'); };
    await expect(fixture.step()).rejects.toThrow('sealed storage temporarily unavailable');
    const pending = (await store.getExecution(fixture.attempt.id))!;
    const evaluator = pending.environments.find(item => item.kind === 'EVALUATOR')!;
    expect(pending.effects.find(item => item.environmentId === evaluator.id && item.kind === 'CREATE')?.state).toBe('INTENT_RECORDED');
    expect(fixture.calls).toEqual([]);
    const prepared = { fixture: 'verified sealed bytes' };
    fixture.deps.runtime.prepareCreate = async () => prepared;
    const create = fixture.deps.runtime.create;
    fixture.deps.runtime.create = async (environment, plan, operationId, actual) => {
      expect(actual).toBe(prepared);
      return create(environment, plan, operationId, actual);
    };
    expect((await fixture.step()).status).toBe('RUNNING');
    expect((await fixture.step()).status).toBe('RUNNING');
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'command', 'capture', 'stop']);
  });

  it.each(['VERIFIED', 'REJECTED', 'INCONCLUSIVE'] as const)('retains %s evidence, tears down, and preserves a separate review decision', async outcome => {
    const fixture = await setup(outcome);
    expect((await fixture.step()).status).toBe('RUNNING');
    expect((await fixture.step()).status).toBe('RUNNING');
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.recorded?.outcome).toBe(outcome);
    expect(fixture.recorded?.assessment.human_acceptance.status).toBe('PENDING');
    expect(fixture.calls).toEqual(['create', 'command', 'capture', 'stop']);
    expect((await ledger.getAttempt(fixture.attempt.id))?.executionStatus).toBe('WAITING_ACCEPTANCE');
    expect((await fixture.step()).evaluationId).toBe(fixture.recorded?.id);
    expect(fixture.calls).toHaveLength(4);
    const evaluation = fixture.recorded!;
    await expect(evidence.decideAcceptance({ actorId: 'untrusted-caller', idempotencyKey: randomUUID(), evaluationId: evaluation.id,
      decision: 'ACCEPTED', expectedReview: reviewBinding(evaluation) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const decision = { actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: evaluation.id,
      decision: 'ACCEPTED' as const, expectedReview: reviewBinding(evaluation) };
    if (outcome === 'VERIFIED') expect((await evidence.decideAcceptance(decision)).decision).toBe('ACCEPTED');
    else await expect(evidence.decideAcceptance(decision)).rejects.toMatchObject({ code: 'EVALUATION_NOT_VERIFIED' });
    expect(fixture.objects.size).toBe(1);
    checkpoints.push({
      propose: { expectation: `The ${outcome} fixture is retained unchanged and cannot bypass review.`,
        baseline: { attemptId: fixture.attempt.id, termsDigest: evaluation.termsDigest, artifactManifestDigest: evaluation.artifactManifestDigest },
        assessment: 'Assert persisted outcome, one dispatch, teardown, and independent review authorization.' },
      test: { evaluationId: evaluation.id, rawReportDigest: evaluation.rawReportDigest, outcome, calls: fixture.calls,
        exactRawReportRetained: true, noEnvironmentDuringReview: true, unauthorizedReviewDenied: true },
      update: { applicationBehavior: 'Expected lifecycle behavior observed in this synthetic-provider PostgreSQL test.',
        theoremOrMethodClaim: 'UNCHANGED: synthetic checker output is not a proof or a method-performance experiment.',
        nextDecision: outcome === 'INCONCLUSIVE' ? 'Diagnose the test failure before changing a claim.' : 'Proceed to native-host integration validation.',
        limits: ['Provider operations and checker observations are simulated.', 'No hypothesis conclusion was automatically approved.'] },
    });
  });

  it.each(['createResponseLoss', 'commandResponseLoss', 'stopResponseLoss', 'evidenceResponseLoss'] as const)('recovers %s with one dispatch and retained original evidence', async fault => {
    const fixture = await setup(); fixture.switches[fault] = true;
    let done = false;
    for (let pass = 0; pass < 6; pass++) {
      try { if ((await fixture.step()).status === 'REVIEW_READY') { done = true; break; } }
      catch (error) { expect(String(error)).toContain('Synthetic evidence commit response lost'); }
    }
    expect(done).toBe(true);
    expect(fixture.calls.filter(call => call === 'create')).toHaveLength(1);
    expect(fixture.calls.filter(call => call === 'command')).toHaveLength(1);
    expect(fixture.calls.filter(call => call === 'stop')).toHaveLength(1);
    expect(fixture.recorded?.outcome).toBe(fault === 'commandResponseLoss' ? 'INCONCLUSIVE' : 'VERIFIED');
    expect(fixture.calls.filter(call => call === 'capture')).toHaveLength(fault === 'commandResponseLoss' ? 0 : 1);
  });

  it('treats missing protected output as inconclusive with no known axiom set', async () => {
    const fixture = await setup(); fixture.switches.captureUnavailable = true;
    await fixture.step(); await fixture.step(); await fixture.step();
    expect(fixture.recorded?.outcome).toBe('INCONCLUSIVE');
    expect(fixture.recorded?.assessment.used_transitive_axioms).toBeNull();
  });

  it('a temporary capture read failure leaves no unavailable report and recovers the actual result', async () => {
    const fixture = await setup(); await fixture.step(); await fixture.step();
    fixture.switches.captureReadFailure = true;
    await expect(fixture.step()).rejects.toThrow('temporary capture read failure');
    expect(fixture.objects.size).toBe(0);
    expect(fixture.calls).not.toContain('stop');
    fixture.switches.captureReadFailure = false;
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.recorded?.outcome).toBe('VERIFIED');
  });

  it('hands the sealed worker phase to the evaluator through the shared coordinator', async () => {
    const fixture = await setup();
    expect((await fixture.loopStep()).status).toBe('RUNNING');
    expect((await fixture.loopStep()).status).toBe('RUNNING');
    expect((await fixture.loopStep()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'command', 'capture', 'stop']);
  });

  it('a registry outage preserves already running work and later captures it without fresh dispatch', async () => {
    const fixture = await setup(); await fixture.step(); await fixture.step();
    fixture.switches.registryUnavailable = true; fixture.switches.commandRunning = true;
    expect((await fixture.step()).status).toBe('RUNNING');
    expect(fixture.objects.size).toBe(0); expect(fixture.calls).not.toContain('stop');
    fixture.switches.commandRunning = false;
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.recorded?.outcome).toBe('VERIFIED');
  });

  it('user cancellation preserves an already completed report without reopening the attempt', async () => {
    const fixture = await setup(); await fixture.step(); await fixture.step();
    await ledger.requestAttemptCancellation({ actorId: fixture.actorId, idempotencyKey: randomUUID(), attemptId: fixture.attempt.id, reason: 'Synthetic cancel race' });
    await fixture.step();
    expect(fixture.recorded?.outcome).toBe('VERIFIED');
    const attempt = await ledger.getAttempt(fixture.attempt.id);
    expect(attempt?.cancellationRequestedAt).not.toBeNull();
    expect(attempt?.executionStatus).not.toBe('WAITING_ACCEPTANCE');
  });

  it('controller takeover preserves a completed command report using the frozen plan', async () => {
    const fixture = await setup(); await fixture.step(); await fixture.step();
    await pool.query("UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1", [fixture.attempt.id]);
    fixture.deps.ownerId = `replacement:${randomUUID()}`;
    fixture.switches.unconfigured = true;
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'command', 'capture', 'stop']);
    expect(fixture.recorded?.outcome).toBe('VERIFIED');
  });

  it('a lost object PUT response replays the report claim without another capture or command', async () => {
    const fixture = await setup(); await fixture.step(); await fixture.step();
    const retain = fixture.deps.reports.retain.bind(fixture.deps.reports);
    let first = true;
    fixture.deps.reports.retain = async (...args) => {
      const result = await retain(...args);
      if (first) { first = false; throw new Error('Synthetic object PUT response lost'); }
      return result;
    };
    await expect(fixture.step()).rejects.toThrow('object PUT response lost');
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'command', 'capture', 'stop']);
  });

  it('concurrent reconciliations share create/command claims and one immutable report', async () => {
    const fixture = await setup();
    for (let i = 0; i < 4; i++) {
      const results = await Promise.allSettled([fixture.step(), fixture.step()]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
    expect(fixture.calls.filter(call => call === 'create')).toHaveLength(1);
    expect(fixture.calls.filter(call => call === 'command')).toHaveLength(1);
    expect(fixture.calls.filter(call => call === 'stop')).toHaveLength(1);
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    const evaluator = (await store.getExecution(fixture.attempt.id))!.environments.find(item => item.kind === 'EVALUATOR')!;
    const changed = Buffer.from('{}');
    await expect(fixture.deps.reports.retain(evaluator.id, { bytes: changed, expected_raw_report_digest: sha(changed) })).rejects.toThrow('EVALUATOR_REPORT_CONFLICT');
  });

  it('changed or removed launch configuration only cleans up existing work', async () => {
    const fixture = await setup(); await fixture.step();
    fixture.plan.command.args.push('changed-after-freeze');
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'stop']);
    fixture.switches.unconfigured = true;
    expect((await fixture.step()).status).toBe('REVIEW_READY');
  });

  it('a superseded lease never starts the old command and records inconclusive teardown', async () => {
    const fixture = await setup(); await fixture.step();
    await pool.query("UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1", [fixture.attempt.id]);
    fixture.deps.ownerId = `replacement:${randomUUID()}`;
    expect((await fixture.step()).status).toBe('REVIEW_READY');
    expect(fixture.calls).toEqual(['create', 'stop']);
    expect(fixture.recorded?.outcome).toBe('INCONCLUSIVE');
  });
});
