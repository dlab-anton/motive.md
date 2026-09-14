import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel, type AttemptProjection, type CapabilityAdmissionMetadata } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const profileDigest = `sha256:${'a'.repeat(64)}` as const;
const alternateProfileDigest = `sha256:${'d'.repeat(64)}` as const;
const evaluatorDigest = `sha256:${'b'.repeat(64)}` as const;
const inputDigest = `sha256:${'c'.repeat(64)}` as const;
const controllerActor = 'gateway-capability-test-controller';

type Seed = {
  actorId: string;
  projectId: string;
  sourceId: string;
  grantId: string;
  workOrderId: string;
  attempt: AttemptProjection;
};

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

postgresDescribe('PostgreSQL run capability and gateway dispatch boundary', () => {
  let pool: Pool;
  let ledger: LedgerKernel;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const status = await getPostgresSchemaStatus(pool);
    if (!status.exact) throw new Error(`Gateway capability test schema is not exact: ${status.problems.join(' ')}`);
    ledger = new LedgerKernel(pool);
  });

  beforeEach(async () => {
    await ledger.setControllerSpending({
      actorId: controllerActor,
      idempotencyKey: randomUUID(),
      enabled: true,
      reason: 'Gateway capability PostgreSQL test setup',
    });
  });

  it('revokes grant admission and durably wakes its active attempt for teardown atomically', async () => {
    const seed = await seedAttempt();
    const before = await ledger.getAttempt(seed.attempt.id);
    const idempotencyKey = randomUUID();
    await ledger.revokeGrant({ actorId: seed.actorId, idempotencyKey, grantId: seed.grantId, reason: 'Operator stopped funding' });
    await ledger.revokeGrant({ actorId: seed.actorId, idempotencyKey, grantId: seed.grantId, reason: 'Operator stopped funding' });
    const after = await ledger.getAttempt(seed.attempt.id);
    expect(after?.executionStatus).toBe('CANCEL_REQUESTED');
    expect(after?.admissionClosedAt).not.toBeNull();
    expect(after?.cancellationRequestedAt).not.toBeNull();
    expect(after?.availableAmount).toBe(before?.availableAmount);
    expect(after?.consumedAmount).toBe(before?.consumedAmount);
    const wake = await pool.query(`SELECT aggregate_id, payload FROM motive.outbox
      WHERE topic = 'attempt.cancel-requested' AND aggregate_id = $1`, [seed.attempt.id]);
    expect(wake.rows).toHaveLength(1);
    expect(wake.rows[0].payload).toMatchObject({ attempt_id: seed.attempt.id, grant_id: seed.grantId });
    await expect(ledger.issueRunCapability({ actorId: seed.actorId, idempotencyKey: randomUUID(), attemptId: seed.attempt.id })).rejects.toThrow();
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: controllerActor,
        idempotencyKey: randomUUID(),
        enabled: false,
        reason: 'Gateway capability PostgreSQL tests complete',
      });
    } finally {
      await pool?.end();
    }
  });

  async function seedAttempt(): Promise<Seed> {
    const actorId = `gateway-capability:${randomUUID()}`;
    const project = await ledger.createProject({
      actorId,
      idempotencyKey: randomUUID(),
      slug: `gateway-capability-${randomUUID()}`,
      visibility: 'PRIVATE',
      revisionContent: { title: 'Gateway capability fixture', purpose: 'Exercise durable capability admission.' },
    });
    const source = await ledger.createFundingSource({
      actorId,
      idempotencyKey: randomUUID(),
      authorizedAmount: '10.000000000000',
      metadata: { test: 'gateway-capability' },
    });
    const grant = await ledger.createGrant({
      actorId,
      idempotencyKey: randomUUID(),
      sourceId: source.id,
      projectId: project.id,
      limitAmount: '5.000000000000',
    });
    const work = await ledger.createWorkOrder({
      actorId,
      idempotencyKey: randomUUID(),
      projectId: project.id,
      workOrderKey: `gateway-capability-${randomUUID().replaceAll('-', '')}`,
      revision: 1,
      state: 'READY',
      terms: {
        format: 'motive.work-order/0.1',
        project_id: project.id,
        project_revision: 1,
        agreement_id: `gateway-capability-${randomUUID()}`,
        objective: 'Exercise the ledger-backed capability boundary.',
        input_commit: 'd'.repeat(40),
        allowed_effects: ['read-approved-inputs', 'submit-artifact'],
        hosted: {
          enabled: true,
          inference: { currency: 'USD', ceiling: '2.000000000000', profile_digest: profileDigest },
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
      actorId,
      idempotencyKey: randomUUID(),
      grantId: grant.id,
      workOrderId: work.id,
      ceilingAmount: '2.000000000000',
      profileDigest,
      inputDigest,
    });
    return { actorId, projectId: project.id, sourceId: source.id, grantId: grant.id, workOrderId: work.id, attempt };
  }

  async function issue(seed: Seed, ttlSeconds = 120) {
    return ledger.issueRunCapability({
      actorId: seed.actorId,
      idempotencyKey: randomUUID(),
      attemptId: seed.attempt.id,
      ttlSeconds,
    });
  }

  async function admit(
    capability: string,
    maximumExposure = '0.100000000000',
    idempotencyKey = randomUUID(),
    admissionMetadata?: CapabilityAdmissionMetadata,
  ) {
    return ledger.admitCapabilityRequest({
      token: capability,
      requestBody: { model: 'local-gateway-model', input: [{ role: 'user', content: 'bounded fixture request' }] },
      maximumExposure,
      profileDigest,
      idempotencyKey,
      admissionMetadata,
    });
  }

  it('stores only a hash and scopes the returned context to the exact funding and lease chain', async () => {
    const seeded = await seedAttempt();
    const issued = await issue(seeded);
    expect(issued.capability).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(issued.context).toMatchObject({
      projectId: seeded.projectId,
      attemptId: seeded.attempt.id,
      grantId: seeded.grantId,
      sourceId: seeded.sourceId,
      profileDigest,
      leaseEpoch: seeded.attempt.leaseEpoch,
      controllerGeneration: seeded.attempt.controllerGeneration,
      issuedByActorId: seeded.actorId,
      revokedAt: null,
    });
    expect(await ledger.getRunCapabilityContext(issued.capability)).toEqual(issued.context);
    const stored = await pool.query(
      `SELECT token_hash, to_jsonb(rc)::text AS capability_row,
              (SELECT response::text FROM motive.idempotency_records
               WHERE actor_id = $2 AND action = 'run-capability.issue' ORDER BY created_at DESC LIMIT 1) AS idempotency_response
       FROM motive.run_capabilities rc WHERE id = $1`,
      [issued.context.capabilityId, seeded.actorId],
    );
    expect(stored.rows[0].token_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(issued.capability);
    expect(stored.rows[0].capability_row).not.toContain(issued.capability);
    expect(stored.rows[0].idempotency_response).not.toContain(issued.capability);
    const plaintextInAudit = await pool.query(
      `SELECT 'events' AS location FROM motive.events WHERE payload::text LIKE '%' || $1 || '%'
       UNION ALL
       SELECT 'outbox' AS location FROM motive.outbox WHERE payload::text LIKE '%' || $1 || '%'
       UNION ALL
       SELECT 'journal' AS location FROM motive.ledger_entries WHERE account LIKE '%' || $1 || '%'`,
      [issued.capability],
    );
    expect(plaintextInAudit.rows).toEqual([]);
  });

  it('does not replay a bearer from an idempotency record or mint a second one', async () => {
    const seeded = await seedAttempt();
    const idempotencyKey = randomUUID();
    const first = await ledger.issueRunCapability({ actorId: seeded.actorId, idempotencyKey, attemptId: seeded.attempt.id, ttl: 120 });
    await expect(ledger.issueRunCapability({ actorId: seeded.actorId, idempotencyKey, attemptId: seeded.attempt.id, ttl: 120 }))
      .rejects.toMatchObject({ code: 'CAPABILITY_ISSUANCE_REPLAY' });
    const count = await pool.query('SELECT count(*)::int AS count FROM motive.run_capabilities WHERE attempt_id = $1', [seeded.attempt.id]);
    expect(count.rows[0].count).toBe(1);
    expect(await ledger.getRunCapabilityContext(first.capability)).toMatchObject({ capabilityId: first.context.capabilityId });
  });

  it('clamps the default lifetime to the frozen hosted runtime and rejects a longer explicit lifetime', async () => {
    const seeded = await seedAttempt();
    const defaultIssued = await ledger.issueRunCapability({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      attemptId: seeded.attempt.id,
    });
    const stored = await pool.query(
      `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS lifetime_seconds
       FROM motive.run_capabilities WHERE id = $1`,
      [defaultIssued.context.capabilityId],
    );
    expect(stored.rows[0].lifetime_seconds).toBeLessThanOrEqual(120);
    await expect(ledger.issueRunCapability({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      attemptId: seeded.attempt.id,
      ttlSeconds: 121,
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('persists only bounded gateway-derived admission metadata before an uncertain provider outcome', async () => {
    const seeded = await seedAttempt();
    const issued = await issue(seeded);
    const metadata: CapabilityAdmissionMetadata = {
      credentialRef: 'fixture:source-bound-credential',
      requestedModel: 'motive-local-mock-v1',
      profileId: 'gateway-local-test',
      rawBodyDigest: digestCanonicalJson({ model: 'local-gateway-model', input: [{ role: 'user', content: 'bounded fixture request' }] }),
      normalizedBodyDigest: digestCanonicalJson({ model: 'local-gateway-model', input: [{ role: 'user', content: 'bounded fixture request' }] }),
      normalizations: [{ field: 'max_output_tokens', from: 'omitted', to: 256 }],
    };
    const operation = await admit(issued.capability, '0.100000000000', randomUUID(), metadata);
    expect(operation.admissionMetadata).toEqual(metadata);
    await ledger.markOperationUnknown({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      reason: 'synthetic truncated transport',
    });
    const persisted = await pool.query(
      'SELECT admission_metadata FROM motive.request_operations WHERE provider_operation_id = $1',
      [operation.providerOperationId],
    );
    expect(persisted.rows[0].admission_metadata).toEqual(metadata);
    await expect(ledger.admitCapabilityRequest({
      token: issued.capability,
      requestBody: { prompt: 'invalid metadata' },
      maximumExposure: '0.100000000000',
      profileDigest,
      admissionMetadata: { ...metadata, credentialRef: 'fixture:still-safe', unexpected: 'must reject' } as CapabilityAdmissionMetadata,
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a wrong bearer and does not accept a spoofed operator identity for mint or revoke', async () => {
    const seeded = await seedAttempt();
    const wrongToken = 'x'.repeat(43);
    expect(await ledger.getRunCapabilityContext(wrongToken)).toBeNull();
    await expect(admit(wrongToken)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    await expect(ledger.issueRunCapability({
      actorId: `spoofed:${randomUUID()}`,
      idempotencyKey: randomUUID(),
      attemptId: seeded.attempt.id,
    })).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN' });
    const issued = await issue(seeded);
    await expect(ledger.revokeRunCapability({
      actorId: `spoofed:${randomUUID()}`,
      idempotencyKey: randomUUID(),
      capabilityId: issued.context.capabilityId,
    })).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN' });
  });

  it('rejects a profile mismatch and a lease fence that changed after minting', async () => {
    const profileSeed = await seedAttempt();
    const profileCapability = await issue(profileSeed);
    await expect(ledger.admitCapabilityRequest({
      token: profileCapability.capability,
      requestBody: { prompt: 'wrong profile' },
      maximumExposure: '0.100000000000',
      profileDigest: alternateProfileDigest,
    })).rejects.toMatchObject({ code: 'VALIDATION' });

    const leaseSeed = await seedAttempt();
    const leaseCapability = await issue(leaseSeed);
    await pool.query(
      'UPDATE motive.attempts SET lease_epoch = lease_epoch + 1, updated_at = clock_timestamp() WHERE id = $1',
      [leaseSeed.attempt.id],
    );
    await expect(admit(leaseCapability.capability)).rejects.toMatchObject({ code: 'LEASE_FENCED' });

    const dispatchSeed = await seedAttempt();
    const dispatchCapability = await issue(dispatchSeed);
    const issuing = await admit(dispatchCapability.capability);
    await pool.query(
      'UPDATE motive.attempts SET lease_epoch = lease_epoch + 1, updated_at = clock_timestamp() WHERE id = $1',
      [dispatchSeed.attempt.id],
    );
    await expect(ledger.claimOperationForDispatch({
      actorId: dispatchSeed.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: issuing.providerOperationId,
      dispatcherId: 'gateway-lease-fence',
      invocationToken: randomUUID(),
    })).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    const held = await pool.query('SELECT status FROM motive.request_operations WHERE provider_operation_id = $1', [issuing.providerOperationId]);
    expect(held.rows[0].status).toBe('ISSUING');
  });

  it('uses the database clock for expiry and fences controller generations after recovery', async () => {
    const expiringSeed = await seedAttempt();
    const expiring = await issue(expiringSeed, 1);
    await wait(1_150);
    expect(await ledger.getRunCapabilityContext(expiring.capability)).toBeNull();
    await expect(admit(expiring.capability)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });

    const generationSeed = await seedAttempt();
    const generationCapability = await issue(generationSeed);
    const issuing = await admit(generationCapability.capability);
    await ledger.freezeForRecovery({ actorId: controllerActor, idempotencyKey: randomUUID(), reason: 'generation fence fixture' });
    await ledger.setControllerSpending({ actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true, reason: 'generation fence fixture resumed' });
    await expect(ledger.claimOperationForDispatch({
      actorId: generationSeed.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: issuing.providerOperationId,
      dispatcherId: 'gateway-generation-fence',
      invocationToken: randomUUID(),
    })).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await expect(admit(generationCapability.capability)).rejects.toMatchObject({ code: 'LEASE_FENCED' });
    const held = await pool.query('SELECT status FROM motive.request_operations WHERE provider_operation_id = $1', [issuing.providerOperationId]);
    expect(held.rows[0].status).toBe('ISSUING');
  });

  it('rechecks revocation after advisory preflight, while preserving a prior in-flight operation for reconciliation', async () => {
    const seeded = await seedAttempt();
    const issued = await issue(seeded);
    expect(await ledger.getRunCapabilityContext(issued.capability)).toMatchObject({ capabilityId: issued.context.capabilityId });
    const operation = await admit(issued.capability);
    const claim = await ledger.claimOperationForDispatch({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      dispatcherId: 'gateway-capability-revocation-test',
      invocationToken: randomUUID(),
    });
    expect(claim).toMatchObject({ claimed: true, operation: { status: 'IN_FLIGHT' } });
    const revoked = await ledger.revokeRunCapability({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      attemptId: seeded.attempt.id,
      reason: 'revoked after preflight',
    });
    expect(revoked).toHaveLength(1);
    expect(await ledger.getRunCapabilityContext(issued.capability)).toBeNull();
    await expect(admit(issued.capability)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    const persisted = await pool.query('SELECT status FROM motive.request_operations WHERE provider_operation_id = $1', [operation.providerOperationId]);
    expect(persisted.rows[0].status).toBe('IN_FLIGHT');
  });

  it('keeps a pre-cancellation admitted operation dispatchable under its unchanged lease fence', async () => {
    const seeded = await seedAttempt();
    const issued = await issue(seeded);
    const operation = await admit(issued.capability);
    await ledger.requestAttemptCancellation({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      attemptId: seeded.attempt.id,
      reason: 'cancel after committed admission',
    });
    const claim = await ledger.claimOperationForDispatch({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      dispatcherId: 'gateway-cancellation-policy',
      invocationToken: randomUUID(),
    });
    expect(claim).toMatchObject({ claimed: true, operation: { status: 'IN_FLIGHT' } });
  });

  it('allows exactly one concurrent dispatch claimant and records provider identities without replacement', async () => {
    const seeded = await seedAttempt();
    const issued = await issue(seeded);
    const operation = await admit(issued.capability);
    const [left, right] = await Promise.all([
      ledger.claimOperationForDispatch({
        actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
        dispatcherId: 'gateway-dispatcher-left', invocationToken: randomUUID(),
      }),
      ledger.claimOperationForDispatch({
        actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
        dispatcherId: 'gateway-dispatcher-right', invocationToken: randomUUID(),
      }),
    ]);
    expect([left, right].filter(result => result.claimed)).toHaveLength(1);
    expect((await ledger.claimOperationForDispatch({
      actorId: seeded.actorId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
      dispatcherId: 'gateway-dispatcher-retry', invocationToken: randomUUID(),
    })).claimed).toBe(false);
    const durableClaim = await pool.query(
      `SELECT status, dispatch_claimed_by, dispatch_invocation_hash
       FROM motive.request_operations WHERE provider_operation_id = $1`,
      [operation.providerOperationId],
    );
    expect(durableClaim.rows[0]).toMatchObject({ status: 'IN_FLIGHT' });
    expect(durableClaim.rows[0].dispatch_claimed_by).toMatch(/^gateway-dispatcher-(left|right)$/);
    expect(durableClaim.rows[0].dispatch_invocation_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    await ledger.recordOperationProviderIdentity({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      providerRequestId: 'provider-request-early',
    });
    const identified = await ledger.recordOperationProviderIdentity({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      providerResponseId: 'provider-response-created',
    });
    expect(identified).toMatchObject({ status: 'IN_FLIGHT' });
    await expect(ledger.recordOperationProviderIdentity({
      actorId: seeded.actorId,
      idempotencyKey: randomUUID(),
      providerOperationId: operation.providerOperationId,
      providerRequestId: 'different-provider-request',
    })).rejects.toMatchObject({ code: 'PROVIDER_IDENTITY_CONFLICT' });
    const identities = await pool.query(
      `SELECT provider_request_id, provider_response_id FROM motive.request_operations
       WHERE provider_operation_id = $1`,
      [operation.providerOperationId],
    );
    expect(identities.rows[0]).toEqual({
      provider_request_id: 'provider-request-early',
      provider_response_id: 'provider-response-created',
    });
  });
});
