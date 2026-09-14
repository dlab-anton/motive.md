import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { LedgerKernelError } from '../../packages/accounting/src/errors.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
if (!databaseUrl) {
  // Vitest reports the suite as skipped. This deliberately does not use SQLite
  // or a mock because row locking and SKIP LOCKED semantics are the subject.
  console.warn('SKIPPED: PostgreSQL ledger tests require MOTIVE_TEST_DATABASE_URL; SQLite is intentionally unsupported.');
}

const postgresDescribe = databaseUrl ? describe : describe.skip;
const profileDigest = `sha256:${'a'.repeat(64)}` as const;
const evaluatorDigest = `sha256:${'b'.repeat(64)}` as const;
const inputDigest = `sha256:${'c'.repeat(64)}` as const;
const controllerActor = 'ledger-test-controller';

type Seed = {
  actorId: string;
  projectId: string;
  sourceId: string;
  grantId: string;
  attempt: AttemptProjection;
};

postgresDescribe('PostgreSQL ledger kernel concurrency', () => {
  let pool: Pool;
  let ledger: LedgerKernel;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const status = await getPostgresSchemaStatus(pool);
    if (!status.exact) throw new Error(`Ledger test schema is not exact: ${status.problems.join(' ')}`);
    ledger = new LedgerKernel(pool);
  });

  beforeEach(async () => {
    // Explicitly enable the local test controller. Repeated enable calls are a
    // no-op and do not issue a duplicate outbox effect.
    await ledger.setControllerSpending({
      actorId: controllerActor,
      idempotencyKey: randomUUID(),
      enabled: true,
      reason: 'PostgreSQL ledger test setup',
    });
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false,
        reason: 'PostgreSQL ledger tests complete; keep local controller disabled',
      });
    } finally {
      await pool?.end();
    }
  });

  async function project(actorId: string) {
    return ledger.createProject({
      actorId,
      idempotencyKey: randomUUID(),
      slug: `ledger-${randomUUID()}`,
      visibility: 'PRIVATE',
      revisionContent: { title: 'Ledger test', purpose: 'Real PostgreSQL concurrency fixture' },
    });
  }

  async function seedAttempt(options: { grantLimit?: string; attemptCeiling?: string } = {}): Promise<Seed> {
    const actorId = randomUUID();
    const createdProject = await project(actorId);
    const source = await ledger.createFundingSource({
      actorId, idempotencyKey: randomUUID(), authorizedAmount: '10.000000000000', metadata: { test: true },
    });
    const grant = await ledger.createGrant({
      actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: createdProject.id,
      limitAmount: options.grantLimit ?? '5.000000000000',
    });
    const workOrder = await ledger.createWorkOrder({
      actorId,
      idempotencyKey: randomUUID(),
      projectId: createdProject.id,
      workOrderKey: `work-${randomUUID().replaceAll('-', '')}`,
      revision: 1,
      state: 'READY',
      terms: {
        format: 'motive.work-order/0.1',
        project_id: createdProject.id,
        project_revision: 1,
        agreement_id: `agreement-${randomUUID()}`,
        objective: 'Exercise the bounded accounting kernel.',
        input_commit: 'd'.repeat(40),
        allowed_effects: ['read-approved-inputs', 'submit-artifact'],
        hosted: {
          enabled: true,
          inference: { currency: 'USD', ceiling: options.attemptCeiling ?? '2.000000000000', profile_digest: profileDigest },
          maximum_runtime_seconds: 120,
        },
        external: {
          enabled: false,
          claim_required: false,
          max_active_claims: 1,
          max_lease_seconds: 120,
          late_submission_policy: 'reject',
          review_admission: 'manual',
          artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true },
        },
        evaluation: { profile_digest: evaluatorDigest, human_acceptance_required: true },
      },
    });
    const attempt = await ledger.reserveAttempt({
      actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: workOrder.id,
      ceilingAmount: options.attemptCeiling ?? '2.000000000000', profileDigest, inputDigest,
    });
    return { actorId, projectId: createdProject.id, sourceId: source.id, grantId: grant.id, attempt };
  }

  it('serializes competing source allocations so only one finite grant is admitted', async () => {
    const actorId = randomUUID();
    const source = await ledger.createFundingSource({
      actorId, idempotencyKey: randomUUID(), authorizedAmount: '5.000000000000',
      metadata: { synthetic: true, purpose: 'PostgreSQL concurrency test' },
    });
    const [firstProject, secondProject] = await Promise.all([project(actorId), project(actorId)]);
    const results = await Promise.allSettled([
      ledger.createGrant({ actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: firstProject.id, limitAmount: '3.000000000000' }),
      ledger.createGrant({ actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: secondProject.id, limitAmount: '3.000000000000' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'INSUFFICIENT_SOURCE_CAPACITY' } });
    const row = await pool.query(`SELECT allocated_amount::text, consumed_amount::text FROM motive.funding_sources WHERE id = $1`, [source.id]);
    expect(row.rows[0]).toEqual({ allocated_amount: '3.000000000000', consumed_amount: '0.000000000000' });
  });

  it('returns the same admission for a matching idempotency key and rejects a changed body', async () => {
    const seeded = await seedAttempt();
    const idempotencyKey = randomUUID();
    const input = {
      actorId: seeded.actorId, idempotencyKey, attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'prove bounded work' }, maximumExposure: '1.400000000000',
    };
    const [left, right] = await Promise.all([ledger.admitRequest(input), ledger.admitRequest(input)]);
    expect(left.providerOperationId).toBe(right.providerOperationId);
    const reservations = await pool.query(`SELECT count(*)::int AS count FROM motive.reservations WHERE operation_id = $1`, [left.providerOperationId]);
    expect(reservations.rows[0].count).toBe(1);
    await expect(ledger.admitRequest({ ...input, maximumExposure: '1.300000000000' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('orders cancellation and request admission on the same durable boundary', async () => {
    const seeded = await seedAttempt();
    const admission = ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'race request' }, maximumExposure: '1.000000000000',
    });
    const cancellation = ledger.requestAttemptCancellation({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, reason: 'race cancellation',
    });
    const [admissionResult, cancelled] = await Promise.allSettled([admission, cancellation]);
    expect(cancelled.status).toBe('fulfilled');
    if (cancelled.status !== 'fulfilled') throw cancelled.reason;
    if (admissionResult.status === 'fulfilled') {
      expect(Date.parse(admissionResult.value.admittedAt)).toBeLessThanOrEqual(Date.parse(cancelled.value.admissionClosedAt ?? ''));
    } else {
      expect(admissionResult.reason).toBeInstanceOf(LedgerKernelError);
      expect((admissionResult.reason as LedgerKernelError).code).toBe('ADMISSION_CLOSED');
    }
    await expect(ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'must be rejected after boundary' }, maximumExposure: '0.500000000000',
    })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
  });

  it('holds unknown issuance, resolves it authoritatively, and preserves a late bill after financial closure', async () => {
    const seeded = await seedAttempt();
    const operation = await ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'unknown then reconcile' }, maximumExposure: '1.400000000000',
    });
    await ledger.markOperationUnknown({ actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId, reason: 'network response ambiguous' });
    await expect(ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'must remain held' }, maximumExposure: '0.100000000000',
    })).rejects.toMatchObject({ code: 'OPERATION_IN_FLIGHT' });
    await ledger.settleOperation({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      actualCost: '1.300000000000', providerUsageId: `settle-${randomUUID()}`,
    });
    await ledger.closeAttempt({ actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id });
    await ledger.closeGrant({ actorId: seeded.actorId, idempotencyKey: randomUUID(), grantId: seeded.grantId });
    const late = await ledger.recordLateUsage({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      providerUsageId: `late-${randomUUID()}`, additionalCost: '0.200000000000',
    });
    expect(late.recorded).toBe(true);
    const grant = await ledger.getGrantForIssuer(seeded.grantId, seeded.actorId);
    expect(grant).toMatchObject({ status: 'CLOSED', consumedAmount: '1.500000000000' });
    const source = await pool.query(`SELECT status, consumed_amount::text, allocated_amount::text FROM motive.funding_sources WHERE id = $1`, [seeded.sourceId]);
    expect(source.rows[0]).toEqual({ status: 'FROZEN', consumed_amount: '1.500000000000', allocated_amount: '0.000000000000' });
    const usage = await pool.query(`SELECT kind, amount::text FROM motive.usage_records WHERE operation_id = $1 ORDER BY recorded_at`, [operation.providerOperationId]);
    expect(usage.rows).toEqual([{ kind: 'SETTLEMENT', amount: '1.300000000000' }, { kind: 'LATE_ADJUSTMENT', amount: '0.200000000000' }]);
    const unknown = await pool.query(`SELECT resolved_at IS NOT NULL AS resolved FROM motive.accounting_incidents WHERE operation_id = $1 AND kind = 'UNKNOWN_ISSUANCE'`, [operation.providerOperationId]);
    expect(unknown.rows[0].resolved).toBe(true);
  });

  it('uses remaining envelope/source holds for a late bill before closure and de-duplicates its provider usage identity', async () => {
    const seeded = await seedAttempt();
    const operation = await ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'late before financial closure' }, maximumExposure: '1.400000000000',
    });
    await ledger.settleOperation({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      actualCost: '1.300000000000', providerUsageId: `initial-${randomUUID()}`,
    });
    const availableBefore = await pool.query(
      `SELECT (authorized_amount - allocated_amount - consumed_amount)::text AS available FROM motive.funding_sources WHERE id = $1`,
      [seeded.sourceId],
    );
    const usageId = `late-before-close-${randomUUID()}`;
    const first = await ledger.recordLateUsage({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      providerUsageId: usageId, additionalCost: '0.500000000000',
    });
    const duplicate = await ledger.recordLateUsage({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      providerUsageId: usageId, additionalCost: '0.500000000000',
    });
    expect(first.recorded).toBe(true);
    expect(duplicate.recorded).toBe(false);
    const availableAfter = await pool.query(
      `SELECT (authorized_amount - allocated_amount - consumed_amount)::text AS available,
        consumed_amount::text, allocated_amount::text FROM motive.funding_sources WHERE id = $1`,
      [seeded.sourceId],
    );
    expect(availableBefore.rows[0].available).toBe('5.000000000000');
    expect(availableAfter.rows[0]).toEqual({ available: '5.000000000000', consumed_amount: '1.800000000000', allocated_amount: '3.200000000000' });
    const holds = await pool.query(
      `SELECT kind, held_amount::text FROM motive.reservations
       WHERE grant_id = $1 AND kind IN ('SOURCE_GRANT', 'GRANT_ATTEMPT')
       ORDER BY CASE kind WHEN 'SOURCE_GRANT' THEN 1 WHEN 'GRANT_ATTEMPT' THEN 2 END`,
      [seeded.grantId],
    );
    expect(holds.rows).toEqual([{ kind: 'SOURCE_GRANT', held_amount: '3.200000000000' }, { kind: 'GRANT_ATTEMPT', held_amount: '0.200000000000' }]);
  });

  it('settles the same operation once under concurrent identical idempotency and rejects a changed settlement body', async () => {
    const seeded = await seedAttempt();
    const operation = await ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'concurrent settlement' }, maximumExposure: '1.400000000000',
    });
    const idempotencyKey = randomUUID();
    const settlement = {
      actorId: seeded.actorId, idempotencyKey, providerOperationId: operation.providerOperationId,
      actualCost: '1.300000000000', providerUsageId: `concurrent-settlement-${randomUUID()}`,
    };
    const [left, right] = await Promise.all([ledger.settleOperation(settlement), ledger.settleOperation(settlement)]);
    expect(left.operation.providerOperationId).toBe(right.operation.providerOperationId);
    const usage = await pool.query(`SELECT count(*)::int AS count FROM motive.usage_records WHERE operation_id = $1`, [operation.providerOperationId]);
    const outbox = await pool.query(`SELECT count(*)::int AS count FROM motive.outbox WHERE dedupe_key = $1`, [`provider-operation.settled:${operation.providerOperationId}`]);
    expect(usage.rows[0].count).toBe(1);
    expect(outbox.rows[0].count).toBe(1);
    await expect(ledger.settleOperation({ ...settlement, actualCost: '1.200000000000' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('preserves an actual overrun, freezes future spending, and reconstructs consumed totals from the journal', async () => {
    const seeded = await seedAttempt({ grantLimit: '5.000000000000', attemptCeiling: '2.000000000000' });
    const operation = await ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'overrun fixture' }, maximumExposure: '1.400000000000',
    });
    const settled = await ledger.settleOperation({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      actualCost: '6.000000000000', providerUsageId: `overrun-${randomUUID()}`,
    });
    expect(settled.overrunAmount).toBe('4.600000000000');
    const grant = await ledger.getGrantForIssuer(seeded.grantId, seeded.actorId);
    const attempt = await ledger.getAttempt(seeded.attempt.id);
    expect(grant).toMatchObject({ status: 'FROZEN', consumedAmount: '6.000000000000', availableAmount: '0.000000000000', deficitAmount: '1.000000000000' });
    expect(attempt).toMatchObject({ consumedAmount: '6.000000000000', availableAmount: '0.000000000000', deficitAmount: '4.000000000000' });
    const sourceConsumedAccount = `source:${seeded.sourceId}:consumed`;
    const journal = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS signed_total
       FROM motive.ledger_entries WHERE account = $1`,
      [sourceConsumedAccount],
    );
    expect(journal.rows[0].signed_total).toBe('6.000000000000');
    const reservation = await pool.query(
      `SELECT original_amount::text, held_amount::text, settled_amount::text, released_amount::text
       FROM motive.reservations WHERE operation_id = $1`,
      [operation.providerOperationId],
    );
    expect(reservation.rows[0]).toEqual({
      original_amount: '1.400000000000', held_amount: '0.000000000000', settled_amount: '1.400000000000', released_amount: '0.000000000000',
    });
  });

  it('fences an old attempt generation after a recovery freeze', async () => {
    const seeded = await seedAttempt();
    const frozen = await ledger.freezeForRecovery({ actorId: controllerActor, idempotencyKey: randomUUID(), reason: 'restore rehearsal' });
    expect(frozen.spendingEnabled).toBe(false);
    await ledger.setControllerSpending({ actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true, reason: 'restore reconciliation complete' });
    await expect(ledger.admitRequest({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), attemptId: seeded.attempt.id, leaseEpoch: seeded.attempt.leaseEpoch,
      profileDigest, requestBody: { prompt: 'old capability must not spend' }, maximumExposure: '0.100000000000',
    })).rejects.toMatchObject({ code: 'LEASE_FENCED' });
  });

  it('rejects a request operation whose source/grant chain belongs to another project', async () => {
    const left = await seedAttempt();
    const right = await seedAttempt();
    await expect(pool.query(
      `INSERT INTO motive.request_operations (
        provider_operation_id, attempt_id, grant_id, source_id, request_sequence, request_body_digest, profile_digest, reserved_amount,
        admission_lease_epoch, admission_controller_generation
      ) VALUES ($1, $2, $3, $4, 1, $5, $6, '0.100000000000', $7, $8)`,
      [
        randomUUID(), left.attempt.id, right.grantId, right.sourceId, `sha256:${'e'.repeat(64)}`, profileDigest,
        left.attempt.leaseEpoch, left.attempt.controllerGeneration,
      ],
    )).rejects.toMatchObject({ code: '23503' });
  });
});
