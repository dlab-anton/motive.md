import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { ControllerLease, EnvironmentHandle, ReserveEnvironmentInput } from '../../packages/orchestration/src/store-types.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const disposableDatabase = (() => {
  if (!databaseUrl) return false;
  const parsed = new URL(databaseUrl);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '55439'
    && /^\/motive_[a-z]+_[a-f0-9]{32}$/.test(parsed.pathname);
})();
if (databaseUrl && !disposableDatabase) throw new Error('Orchestration integration tests require a fresh UUID-named local database.');
const profileDigest = `sha256:${'a'.repeat(64)}` as const;
const evaluatorDigest = `sha256:${'b'.repeat(64)}` as const;
const inputDigest = `sha256:${'c'.repeat(64)}` as const;
const launchPlanDigest = `sha256:${'d'.repeat(64)}` as const;
const commandDigest = `sha256:${'e'.repeat(64)}` as const;
const controllerActor = 'orchestration-store-test-controller';

type Seed = {
  actorId: string;
  projectSlug: string;
  sourceId: string;
  attempt: AttemptProjection;
  authorizationId: string;
  lease: ControllerLease;
};

function handle(label: string, session = `session-${randomUUID()}`): EnvironmentHandle {
  return { provider: 'vercel', externalId: `motive-test-${label}-${randomUUID()}`, sessionId: session };
}

function reservation(seed: Seed, maximumCostUsd = '0.800000000000'): ReserveEnvironmentInput {
  return {
    kind: 'WORKER',
    profileDigest,
    profileSnapshot: { format: 'motive.sandbox-profile/0.1', trusted_source: 'test-snapshot' },
    launchPlanDigest,
    infrastructureAuthorizationId: seed.authorizationId,
    maximumCostUsd,
  };
}

describe.runIf(disposableDatabase)('PostgreSQL durable orchestration store', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  let store: PostgresOrchestrationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
    const status = await getPostgresSchemaStatus(pool);
    if (!status.exact) throw new Error(`Orchestration test schema is not exact: ${status.problems.join(' ')}`);
    ledger = new LedgerKernel(pool);
    store = new PostgresOrchestrationStore(pool);
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true,
      reason: 'PostgreSQL durable orchestration store test setup',
    });
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false,
        reason: 'PostgreSQL durable orchestration store tests complete',
      });
    } finally {
      await pool?.end();
    }
  });

  async function seed(options: { authorizationLimitUsd?: string; ownerId?: string } = {}): Promise<Seed> {
    const actorId = randomUUID();
    const projectSlug = `orchestration-${randomUUID()}`;
    const project = await ledger.createProject({
      actorId, idempotencyKey: randomUUID(), slug: projectSlug,
      visibility: 'PRIVATE', revisionContent: { title: 'Durable orchestration PostgreSQL fixture' },
    });
    const source = await ledger.createFundingSource({
      actorId, idempotencyKey: randomUUID(), authorizedAmount: '10.000000000000', metadata: { test: 'orchestration-store' },
    });
    const grant = await ledger.createGrant({
      actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id, limitAmount: '5.000000000000',
    });
    const workOrder = await ledger.createWorkOrder({
      actorId, idempotencyKey: randomUUID(), projectId: project.id,
      workOrderKey: `work-${randomUUID().replaceAll('-', '')}`, revision: 1, state: 'READY',
      terms: {
        format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1,
        agreement_id: `agreement-${randomUUID()}`, objective: 'Exercise durable orchestration.', input_commit: 'f'.repeat(40),
        allowed_effects: ['read-approved-inputs', 'submit-artifact'],
        hosted: { enabled: true, inference: { currency: 'USD', ceiling: '2.000000000000', profile_digest: profileDigest }, maximum_runtime_seconds: 120 },
        external: {
          enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
          late_submission_policy: 'reject', review_admission: 'manual',
          artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true },
        },
        evaluation: { profile_digest: evaluatorDigest, human_acceptance_required: true },
      },
    });
    const attempt = await ledger.reserveAttempt({
      actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: workOrder.id,
      ceilingAmount: '2.000000000000', profileDigest, inputDigest,
    });
    const authorizationId = randomUUID();
    await store.createInfrastructureAuthorization({
      id: authorizationId, sourceAccountId: source.id, sourceAccountRef: `cloud-account-${randomUUID()}`,
      actorId, limitUsd: options.authorizationLimitUsd ?? '2.000000000000',
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    const lease = await store.acquireLease(attempt.id, options.ownerId ?? `worker-${actorId}`, 300);
    return { actorId, projectSlug, sourceId: source.id, attempt, authorizationId, lease };
  }

  async function activate(seedValue: Seed, maximumCostUsd = '0.800000000000') {
    const planned = await store.reserveEnvironment(seedValue.lease, reservation(seedValue, maximumCostUsd));
    await expect(store.claimEffect(seedValue.lease, planned.effect.effectId)).resolves.toEqual({ effectId: planned.effect.effectId, claimed: true });
    const providerHandle = handle('worker');
    await store.recordCreateResult(seedValue.lease, planned.effect.effectId, providerHandle);
    const environment = await store.recordObservation(seedValue.lease, planned.environment.id, {
      providerStatus: 'running', state: 'ACTIVE', providerTerminal: false,
    });
    return { ...planned, providerHandle, environment };
  }

  async function stop(seedValue: Seed, environmentId: string) {
    const intent = await store.requestStop(seedValue.lease, environmentId);
    const claim = await store.claimEffect(seedValue.lease, intent.effect.effectId);
    if (claim.claimed) {
      await store.recordStopResult(seedValue.lease, intent.effect.effectId, {
        providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
      });
    }
  }

  it('keeps a live owner fenced, increments only after expiry, and preserves original environment identity', async () => {
    const seeded = await seed();
    const duplicate = await store.acquireLease(seeded.attempt.id, seeded.lease.ownerId, 300);
    expect(duplicate.epoch).toBe(seeded.lease.epoch);
    await expect(store.acquireLease(seeded.attempt.id, 'competing-owner', 300)).rejects.toMatchObject({ code: 'LEASE_HELD' });
    await pool.query(`UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`, [seeded.attempt.id]);
    const recovered = await store.acquireLease(seeded.attempt.id, 'competing-owner', 300);
    expect(recovered.epoch).toBe(seeded.lease.epoch + 1);
    const attempt = await pool.query(`SELECT lease_epoch FROM motive.attempts WHERE id = $1`, [seeded.attempt.id]);
    expect(Number(attempt.rows[0].lease_epoch)).toBe(recovered.epoch);
  });

  it('never accepts a historical result or unknown marker from a same-owner lease on another attempt', async () => {
    const sharedOwner = `shared-worker-${randomUUID()}`;
    const [first, second] = await Promise.all([seed({ ownerId: sharedOwner }), seed({ ownerId: sharedOwner })]);
    expect(first.lease.epoch).toBe(second.lease.epoch);
    const planned = await store.reserveEnvironment(first.lease, reservation(first));
    await expect(store.claimEffect(first.lease, planned.effect.effectId)).resolves.toMatchObject({ claimed: true });

    await expect(store.markEffectUnknown(second.lease, planned.effect.effectId, 'WRONG_ATTEMPT'))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await expect(store.recordCreateResult(second.lease, planned.effect.effectId, handle('cross-attempt')))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });

    const providerHandle = handle('correct-attempt');
    await store.recordCreateResult(first.lease, planned.effect.effectId, providerHandle);
    await store.recordObservation(first.lease, planned.environment.id, {
      providerStatus: 'running', state: 'ACTIVE', providerTerminal: false,
    });
    await stop(first, planned.environment.id);
  });

  it('does not let a lease takeover send an old create or command while retaining cleanup authority', async () => {
    const createSeed = await seed();
    const reserved = await store.reserveEnvironment(createSeed.lease, reservation(createSeed));
    await pool.query(`UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`, [createSeed.attempt.id]);
    const createTakeover = await store.acquireLease(createSeed.attempt.id, `takeover-${randomUUID()}`, 300);
    await expect(store.claimEffect(createTakeover, reserved.effect.effectId)).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await store.abandonReservedEnvironment(createTakeover, reserved.environment.id);

    const commandSeed = await seed();
    const active = await activate(commandSeed);
    const command = await store.planCommand(commandSeed.lease, active.environment.id, { commandDigest });
    await pool.query(`UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`, [commandSeed.attempt.id]);
    const commandTakeover = await store.acquireLease(commandSeed.attempt.id, `takeover-${randomUUID()}`, 300);
    await expect(store.planCommand(commandTakeover, active.environment.id, { commandDigest })).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await expect(store.claimEffect(commandTakeover, command.effect.effectId)).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    const stopIntent = await store.requestStop(commandTakeover, active.environment.id);
    await expect(store.claimEffect(commandTakeover, stopIntent.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await store.recordStopResult(commandTakeover, stopIntent.effect.effectId, {
      providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
    });
  });

  it('enforces the two-environment physical limit across expired leases and only releases an unclaimed create intent explicitly', async () => {
    const [first, second, third] = await Promise.all([seed(), seed(), seed()]);
    const firstReservation = await store.reserveEnvironment(first.lease, reservation(first));
    const secondReservation = await store.reserveEnvironment(second.lease, reservation(second));
    await expect(store.reserveEnvironment(third.lease, reservation(third))).rejects.toMatchObject({ code: 'PHYSICAL_CAPACITY_EXHAUSTED' });
    await pool.query(`UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`, [first.attempt.id]);
    const renewed = await store.acquireLease(first.attempt.id, first.lease.ownerId, 300);
    await expect(store.reserveEnvironment(third.lease, reservation(third))).rejects.toMatchObject({ code: 'PHYSICAL_CAPACITY_EXHAUSTED' });
    const abandoned = await store.abandonReservedEnvironment(renewed, firstReservation.environment.id);
    expect(abandoned.state).toBe('ABANDONED');
    const thirdReservation = await store.reserveEnvironment(third.lease, reservation(third));
    await store.abandonReservedEnvironment(second.lease, secondReservation.environment.id);
    await store.abandonReservedEnvironment(third.lease, thirdReservation.environment.id);
  });

  it('records one create and command handle, seals an artifact, and keeps known billing held through physical stop', async () => {
    const seeded = await seed({ authorizationLimitUsd: '1.000000000000' });
    const active = await activate(seeded);
    await expect(store.claimEffect(seeded.lease, active.effect.effectId)).resolves.toEqual({ effectId: active.effect.effectId, claimed: false });
    const command = await store.planCommand(seeded.lease, active.environment.id, { commandDigest });
    await expect(store.claimEffect(seeded.lease, command.effect.effectId)).resolves.toEqual({ effectId: command.effect.effectId, claimed: true });
    await store.recordCommandResult(seeded.lease, command.effect.effectId, { providerCommandId: `cmd-${randomUUID()}` });
    const execution = await store.getExecution(seeded.attempt.id);
    expect(execution?.effects.find(effect => effect.effectId === command.effect.effectId)?.providerCommandId).toMatch(/^cmd-/);
    await store.recordArtifactSeal(seeded.lease, active.environment.id, {
      manifestDigest: `sha256:${'f'.repeat(64)}`, receiptId: `receipt-${randomUUID()}`,
    });
    const intermediate = await store.settleInfrastructureUsage(seeded.lease, {
      environmentId: active.environment.id, actualCostUsd: '0.600000000000', providerUsageId: `usage-${randomUUID()}`,
    });
    expect(intermediate).toMatchObject({ heldUsd: '0.200000000000', consumedUsd: '0.600000000000', status: 'ACTIVE' });
    await stop(seeded, active.environment.id);
    const environmentAfterStop = await store.findEnvironment(active.providerHandle);
    expect(environmentAfterStop).toMatchObject({ state: 'TERMINATED', heldCostUsd: '0.200000000000' });
    const final = await store.settleInfrastructureUsage(seeded.lease, {
      environmentId: active.environment.id, actualCostUsd: '0.200000000000', providerUsageId: `usage-${randomUUID()}`, final: true,
    });
    expect(final).toMatchObject({ heldUsd: '0.000000000000', consumedUsd: '0.800000000000', status: 'ACTIVE' });
  });

  it('preserves a trusted partial artifact after cancellation without reopening paid work', async () => {
    const seeded = await seed();
    const active = await activate(seeded);
    await ledger.requestAttemptCancellation({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, reason: 'operator cancellation',
    });
    const sealed = await store.recordArtifactSeal(seeded.lease, active.environment.id, {
      manifestDigest: `sha256:${'9'.repeat(64)}`, receiptId: `partial-${randomUUID()}`,
    });
    expect(sealed).toMatchObject({ status: 'SEALED', manifestDigest: `sha256:${'9'.repeat(64)}` });
    // A handoff request must never reopen an existing cancellation boundary.
    await store.requestStop(seeded.lease, active.environment.id, { preserveEvaluation: true });
    await stop(seeded, active.environment.id);
    const attempt = await pool.query(`SELECT execution_status, admission_closed_at IS NOT NULL AS closed FROM motive.attempts WHERE id = $1`, [seeded.attempt.id]);
    expect(attempt.rows[0]).toEqual({ execution_status: 'CANCEL_REQUESTED', closed: true });
  });

  it('keeps a durable stop request visible when the provider is still provisioning', async () => {
    const seeded = await seed();
    const active = await activate(seeded);
    const stopIntent = await store.requestStop(seeded.lease, active.environment.id, { preserveEvaluation: true });
    expect((await ledger.getAttempt(seeded.attempt.id))?.admissionClosedAt).not.toBeNull();
    await expect(store.claimEffect(seeded.lease, stopIntent.effect.effectId)).resolves.toMatchObject({ claimed: true });
    const pending = await store.recordObservation(seeded.lease, active.environment.id, {
      providerStatus: 'pending', state: 'PROVISIONING', providerTerminal: false,
    });
    expect(pending.state).toBe('STOP_REQUESTED');
    await store.recordStopResult(seeded.lease, stopIntent.effect.effectId, {
      providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
    });
  });

  it('does not issue a worker command after its output has been sealed', async () => {
    const seeded = await seed();
    const active = await activate(seeded);
    const command = await store.planCommand(seeded.lease, active.environment.id, { commandDigest });
    await store.recordArtifactSeal(seeded.lease, active.environment.id, {
      manifestDigest: `sha256:${'8'.repeat(64)}`, receiptId: `sealed-before-command-${randomUUID()}`,
    });
    await expect(store.claimEffect(seeded.lease, command.effect.effectId)).rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });
    await expect(store.planCommand(seeded.lease, active.environment.id, { commandDigest })).rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });
    await stop(seeded, active.environment.id);
  });

  it('rejects a mismatched evaluator profile before reserving infrastructure', async () => {
    const seeded = await seed({ authorizationLimitUsd: '2.000000000000' });
    const active = await activate(seeded);
    await store.recordArtifactSeal(seeded.lease, active.environment.id, {
      manifestDigest: `sha256:${'7'.repeat(64)}`, receiptId: `evaluator-profile-${randomUUID()}`,
    });
    const evaluatorReservation = (digest: typeof profileDigest): ReserveEnvironmentInput => ({
      kind: 'EVALUATOR', profileDigest: digest,
      profileSnapshot: { format: 'motive.synthetic-evaluator-profile/0.1' },
      launchPlanDigest, infrastructureAuthorizationId: seeded.authorizationId, maximumCostUsd: '0.500000000000',
    });

    await expect(store.reserveEnvironment(seeded.lease, evaluatorReservation(profileDigest)))
      .rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });
    const afterRejected = await store.getExecution(seeded.attempt.id);
    expect(afterRejected?.environments).toHaveLength(1);
    const authorization = await pool.query(
      'SELECT held_usd::text AS held_usd FROM motive.infrastructure_authorizations WHERE id = $1',
      [seeded.authorizationId],
    );
    expect(authorization.rows[0]?.held_usd).toBe('0.800000000000');

    const evaluator = await store.reserveEnvironment(seeded.lease, evaluatorReservation(evaluatorDigest));
    expect(evaluator.environment).toMatchObject({ kind: 'EVALUATOR', profileDigest: evaluatorDigest });
    await store.abandonReservedEnvironment(seeded.lease, evaluator.environment.id);
    await stop(seeded, active.environment.id);
  });

  it('freezes evaluator launch bytes and fences one command-bound report across lease takeover', async () => {
    const seeded = await seed({ authorizationLimitUsd: '2.000000000000' });
    const active = await activate(seeded);
    await store.recordArtifactSeal(seeded.lease, active.environment.id, {
      manifestDigest: `sha256:${'6'.repeat(64)}`, receiptId: `evaluator-fence-${randomUUID()}`,
    });
    const plan = {
      format: 'motive.synthetic-evaluator-launch/0.1', evaluatorProfileDigest: evaluatorDigest,
      infrastructureAuthorizationId: seeded.authorizationId, command: { executable: '/bin/evaluate', args: [] },
    };
    const evaluatorInput: ReserveEnvironmentInput = {
      kind: 'EVALUATOR', profileDigest: evaluatorDigest,
      profileSnapshot: { format: 'motive.synthetic-evaluator-profile/0.1' },
      launchPlanDigest: digestCanonicalJson(plan), infrastructureAuthorizationId: seeded.authorizationId,
      maximumCostUsd: '0.500000000000',
    };
    const [first, replay] = await Promise.all([
      store.reserveEnvironment(seeded.lease, evaluatorInput),
      store.reserveEnvironment(seeded.lease, evaluatorInput),
    ]);
    expect(replay.effect.environmentId).toBe(first.environment.id);
    await expect(store.freezeEvaluatorLaunchPlan(seeded.lease, first.environment.id, plan)).resolves.toEqual(plan);
    await expect(store.freezeEvaluatorLaunchPlan(seeded.lease, first.environment.id, plan)).resolves.toEqual(plan);
    await expect(store.getEvaluatorLaunchPlan(seeded.lease, first.environment.id)).resolves.toEqual(plan);
    await expect(store.freezeEvaluatorLaunchPlan(seeded.lease, first.environment.id,
      { ...plan, command: { executable: '/bin/substituted', args: [] } }))
      .rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    await expect(store.claimEvaluatorReport(seeded.lease, first.environment.id,
      { reportDigest: `sha256:${'5'.repeat(64)}`, commandId: null }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });

    await expect(store.claimEffect(seeded.lease, first.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await store.recordCreateResult(seeded.lease, first.effect.effectId, handle('evaluator'));
    const evaluator = await store.recordObservation(seeded.lease, first.environment.id,
      { providerStatus: 'running', state: 'ACTIVE', providerTerminal: false });
    const command = await store.planCommand(seeded.lease, evaluator.id, { commandDigest });
    await expect(store.claimEffect(seeded.lease, command.effect.effectId)).resolves.toMatchObject({ claimed: true });
    const providerCommandId = `evaluator-command-${randomUUID()}`;
    await store.recordCommandResult(seeded.lease, command.effect.effectId, { providerCommandId });
    const report = { reportDigest: `sha256:${'4'.repeat(64)}` as const, commandId: providerCommandId };
    await expect(store.claimEvaluatorReport(seeded.lease, evaluator.id, report)).resolves.toEqual(report);
    await expect(store.claimEvaluatorReport(seeded.lease, evaluator.id,
      { ...report, reportDigest: `sha256:${'3'.repeat(64)}` }))
      .rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });

    await pool.query(`UPDATE motive.orchestration_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`,
      [seeded.attempt.id]);
    const takeover = await store.acquireLease(seeded.attempt.id, `evaluator-takeover-${randomUUID()}`, 300);
    await expect(store.getEvaluatorLaunchPlan(takeover, evaluator.id)).resolves.toEqual(plan);
    await expect(store.getEvaluatorReportClaim(takeover, evaluator.id)).resolves.toEqual(report);
    await expect(store.claimEvaluatorReport(takeover, evaluator.id, report)).resolves.toEqual(report);
    await expect(store.getEvaluatorReportClaim(seeded.lease, evaluator.id)).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await stop({ ...seeded, lease: takeover }, evaluator.id);
    await stop({ ...seeded, lease: takeover }, active.environment.id);
  });

  it('freezes a per-environment billing overrun even when the separate authorization still has capacity', async () => {
    const seeded = await seed({ authorizationLimitUsd: '2.000000000000' });
    const active = await activate(seeded, '0.500000000000');
    const settled = await store.settleInfrastructureUsage(seeded.lease, {
      environmentId: active.environment.id, actualCostUsd: '0.800000000000', providerUsageId: `overrun-${randomUUID()}`, final: true,
    });
    expect(settled).toMatchObject({ heldUsd: '0.000000000000', consumedUsd: '0.800000000000', deficitUsd: '0.000000000000', availableUsd: '1.200000000000', status: 'FROZEN' });
    const operations = await pool.query(`SELECT count(*)::int AS count FROM motive.request_operations WHERE attempt_id = $1`, [seeded.attempt.id]);
    expect(operations.rows[0].count).toBe(0);
    await stop(seeded, active.environment.id);
  });

  it('treats a replacement provider session as a separately counted orphan and releases it only on terminal observation', async () => {
    const externalId = `motive-orphan-${randomUUID()}`;
    const firstHandle: EnvironmentHandle = { provider: 'vercel', externalId, sessionId: `session-${randomUUID()}` };
    const first = await store.recordOrphan({
      kind: 'WORKER', handle: firstHandle, providerStatus: 'running', identityDigest: `sha256:${'1'.repeat(64)}`,
    });
    expect(await store.findEnvironment(firstHandle)).toMatchObject({ id: first.environment.id, state: 'ORPHANED' });
    await store.recordOrphanObservation(first.environment.id, { providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true });
    const replacementHandle: EnvironmentHandle = { provider: 'vercel', externalId, sessionId: `session-${randomUUID()}` };
    expect(await store.findEnvironment(replacementHandle)).toBeNull();
    const replacement = await store.recordOrphan({
      kind: 'WORKER', handle: replacementHandle, providerStatus: 'running', identityDigest: `sha256:${'2'.repeat(64)}`,
    });
    expect(replacement.environment).toMatchObject({ state: 'ORPHANED', orphanReason: 'PROVIDER_SESSION_REPLACED' });
    await store.recordOrphanObservation(replacement.environment.id, { providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true });
  });

  it('fences Trigger delivery acknowledgement and deferral with the current claim token', async () => {
    const eventId = randomUUID();
    const outboxId = randomUUID();
    const aggregateId = randomUUID();
    const topic = `orchestration-test-${randomUUID()}`;
    await pool.query(
      `INSERT INTO motive.events (id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'attempt', $2, 'orchestration-test', '{}'::jsonb)`,
      [eventId, aggregateId],
    );
    await pool.query(
      `INSERT INTO motive.outbox (id, event_id, aggregate_type, aggregate_id, topic, dedupe_key, payload)
       VALUES ($1, $2, 'attempt', $3, $4, $5, '{}'::jsonb)`,
      [outboxId, eventId, aggregateId, topic, `orchestration-test:${outboxId}`],
    );
    const first = await store.claimDeliveryBatch({ consumerId: 'orchestration-test', limit: 1, leaseMs: 60_000, topics: [topic] });
    expect(first).toHaveLength(1);
    await pool.query(`UPDATE motive.outbox SET delivery_claim_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1`, [outboxId]);
    const second = await store.claimDeliveryBatch({ consumerId: 'orchestration-test', limit: 1, leaseMs: 60_000, topics: [topic] });
    expect(second).toHaveLength(1);
    await expect(store.acknowledgeDelivery({ outboxId, claimToken: first[0].claimToken, triggerRunId: 'run-stale' })).resolves.toBe(false);
    await expect(store.deferDelivery({
      outboxId, claimToken: second[0].claimToken, retryAt: new Date(Date.now() + 60_000).toISOString(), errorCode: 'TEST_RETRY',
    })).resolves.toBe(true);
  });

  it('atomically leaves unrelated attempt wakes unclaimed under a project-lead activation scope', async () => {
    const supported = await seed(); const unrelated = await seed();
    const connectionId = randomUUID(); const budgetId = randomUUID();
    await pool.query(`INSERT INTO motive.provider_connections
      (id,owner_actor_id,provider,credential_ref,status,encrypted_credential,credential_fingerprint)
      VALUES($1,$2,'openrouter',$3,'CONNECTED',$4,$5)`,
    [connectionId, supported.actorId, `openrouter:${randomUUID()}`, Buffer.from('test-only'), digestCanonicalJson('credential')]);
    await pool.query(`INSERT INTO motive.provider_project_budgets
      (id,connection_id,owner_actor_id,project_id,source_id,grant_id,work_order_id,provider,model_id,limit_usd,status,
       idempotency_key,request_digest,beneficiary_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'openrouter','openai/gpt-6-astra',1,'ACTIVE',$8,$9,'operator:seed')`,
    [budgetId, connectionId, supported.actorId, supported.attempt.projectId, supported.sourceId,
      supported.attempt.grantId, supported.attempt.workOrderId, randomUUID(), digestCanonicalJson('budget')]);
    await pool.query(`INSERT INTO motive.provider_budget_activations
      (budget_id,assigned_agent_id,work_order_id,grant_id,attempt_id,profile_digest,idempotency_key,request_digest,status,beneficiary_actor_id)
      VALUES($1,NULL,$2,$3,$4,$5,$6,$7,'AWAITING_DISPATCH','operator:seed')`,
    [budgetId, supported.attempt.workOrderId, supported.attempt.grantId, supported.attempt.id,
      supported.attempt.profileDigest, randomUUID(), digestCanonicalJson('activation')]);

    const claims = await store.claimDeliveryBatch({ consumerId: 'circle-scope-test', limit: 10, leaseMs: 60_000,
      topics: ['attempt.reserved'], attemptScope: { kind: 'PROJECT_LEAD_ACTIVATION',
        projectSlug: supported.projectSlug, beneficiaryActorId: 'operator:seed' } });
    expect(claims.map(item => item.message.aggregateId)).toEqual([supported.attempt.id]);
    const foreign = await pool.query(`SELECT claimed_at,delivered_at FROM motive.outbox
      WHERE dedupe_key=$1`, [`attempt.reserved:${unrelated.attempt.id}`]);
    expect(foreign.rows[0]).toEqual({ claimed_at: null, delivered_at: null });
    await store.deferDelivery({ outboxId: claims[0].outboxId, claimToken: claims[0].claimToken,
      retryAt: new Date(Date.now() + 60_000).toISOString(), errorCode: 'TEST_COMPLETE' });
  });
});
