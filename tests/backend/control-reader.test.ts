import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import type { Digest } from '../../packages/domain/src/contracts.ts';
import { PostgresEvidenceStore } from '../../packages/evidence/src/index.ts';
import { createPublicRepository } from '../../server/control/public-repository.ts';

const url = process.env.MOTIVE_TEST_DATABASE_URL;

describe.skipIf(!url)('control reader database role', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    const provisioning = await readFile(new URL('../../deploy/sql/control-reader.sql', import.meta.url), 'utf8');
    await pool.query(provisioning);
  });

  afterAll(async () => { await pool?.end(); });

  async function withReader<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE motive_control_reader');
      return await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  async function expectDenied(client: PoolClient, sql: string): Promise<void> {
    await client.query('SAVEPOINT before_denied_statement');
    try {
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT before_denied_statement');
    }
  }

  it('allows the exact readiness and public projection reads', async () => {
    await withReader(async client => {
      expect((await getPostgresSchemaStatus(client)).exact).toBe(true);
      const repository = createPublicRepository(client);
      await expect(repository.listPublicProjects()).resolves.toBeInstanceOf(Array);
      await expect(repository.getProject('math', null)).resolves.toSatisfy(value => value === null || value.slug === 'math');
      await expect(repository.getSupport('unregistered-test-actor')).resolves.toEqual([]);
    });
  });

  it('denies writes and columns outside the public projections', async () => {
    await withReader(async client => {
      await expectDenied(client, "UPDATE motive.projects SET visibility = 'PRIVATE' WHERE FALSE");
      await expectDenied(client, "INSERT INTO motive.events (id, aggregate_type, aggregate_id, event_type, payload) VALUES ('00000000-0000-0000-0000-000000000001', 'test', '00000000-0000-0000-0000-000000000001', 'test', '{}')");
      await expectDenied(client, 'SELECT created_by FROM motive.projects LIMIT 0');
      await expectDenied(client, 'SELECT source_id FROM motive.grants LIMIT 0');
      const routine = await client.query<{ executable: boolean }>(
        "SELECT has_function_privilege(current_user, 'motive.reject_immutable_mutation()', 'EXECUTE') AS executable",
      );
      expect(routine.rows[0]?.executable).toBe(false);
    });
  });

  it('runs member-scoped evidence reads through the restricted role', async () => {
    const ledger = new LedgerKernel(pool);
    const actorId = `control-reader-owner:${randomUUID()}`;
    const digest = (value: string): Digest => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    await ledger.setControllerSpending({
      actorId: 'control-reader-test-controller', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Create a private reader projection fixture',
    });
    let attemptId: string;
    try {
      const project = await ledger.createProject({
        actorId, idempotencyKey: randomUUID(), slug: `reader-evidence-${randomUUID()}`,
        visibility: 'PRIVATE', revisionContent: { title: 'Restricted evidence reader fixture' },
      });
      const source = await ledger.createFundingSource({
        actorId, idempotencyKey: randomUUID(), authorizedAmount: '2.000000000000', metadata: { test: 'control-reader' },
      });
      const grant = await ledger.createGrant({
        actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id,
        limitAmount: '1.000000000000',
      });
      const evaluatorProfileDigest = digest('control-reader-evaluator-profile');
      const workOrder = await ledger.createWorkOrder({
        actorId, idempotencyKey: randomUUID(), projectId: project.id,
        workOrderKey: `reader-${randomUUID().replaceAll('-', '')}`, revision: 1, state: 'READY',
        terms: {
          format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1,
          agreement_id: `reader-agreement-${randomUUID()}`, objective: 'Exercise restricted evidence reads.',
          input_commit: 'a'.repeat(40), allowed_effects: ['read-approved-inputs'],
          hosted: {
            enabled: true,
            inference: { currency: 'USD', ceiling: '1.000000000000', profile_digest: digest('control-reader-inference-profile') },
            maximum_runtime_seconds: 60,
          },
          external: {
            enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 60,
            late_submission_policy: 'reject', review_admission: 'manual',
            artifact: { formats: ['motive.patch/0.1'], max_bytes: 1_024, license_acceptance_required: true },
          },
          evaluation: { profile_digest: evaluatorProfileDigest, human_acceptance_required: true },
        },
      });
      const attempt = await ledger.reserveAttempt({
        actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: workOrder.id,
        ceilingAmount: '1.000000000000', profileDigest: digest('control-reader-inference-profile'),
        inputDigest: digest('control-reader-input'),
      });
      attemptId = attempt.id;
    } finally {
      await ledger.setControllerSpending({
        actorId: 'control-reader-test-controller', idempotencyKey: randomUUID(), enabled: false,
        reason: 'Restricted evidence reader fixture complete',
      });
    }

    await withReader(async client => {
      // The evidence read methods issue only SELECTs, so a role-restricted
      // PoolClient is the exact runtime surface they need here.
      const evidence = new PostgresEvidenceStore(client as unknown as Pool);
      await expect(evidence.findAttemptEvidenceForMember({ actorId, attemptId })).resolves.toEqual({
        attemptId,
        workOrderId: expect.any(String),
        termsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        artifact: null,
        evaluations: [],
      });
      await expect(evidence.findAttemptEvidenceForMember({ actorId: 'foreign-reader', attemptId })).resolves.toBeNull();
      await expect(evidence.findEvaluationForMember({
        actorId, evaluationId: randomUUID(),
      })).resolves.toBeNull();
    });
  });

  it('denies sensitive evidence columns and every evidence write', async () => {
    await withReader(async client => {
      // These are the complete column sets used by the redacted store reads.
      await expect(client.query(`SELECT id, project_id, work_order_id, attempt_id,
        artifact_environment_id, evaluator_environment_id, artifact_manifest_digest,
        terms_digest, evaluator_profile_digest, challenge_digest, dependency_lock_digest,
        trusted_build_config_digest, raw_report_digest, assessment_digest, outcome, created_at
        FROM motive.evaluations LIMIT 0`)).resolves.toBeDefined();
      await expect(client.query('SELECT id, evaluation_id, decision, created_at FROM motive.acceptance_decisions LIMIT 0')).resolves.toBeDefined();

      for (const sql of [
        'SELECT * FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_profile FROM motive.evaluations LIMIT 0',
        'SELECT assessment FROM motive.evaluations LIMIT 0',
        'SELECT artifact_receipt_id FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_provider FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_external_id FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_session_id FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_lease_epoch FROM motive.evaluations LIMIT 0',
        'SELECT evaluator_controller_generation FROM motive.evaluations LIMIT 0',
        'SELECT * FROM motive.acceptance_decisions LIMIT 0',
        'SELECT decided_by_actor_id FROM motive.acceptance_decisions LIMIT 0',
        'SELECT rationale FROM motive.acceptance_decisions LIMIT 0',
        'SELECT project_id FROM motive.acceptance_decisions LIMIT 0',
        'SELECT work_order_id FROM motive.acceptance_decisions LIMIT 0',
        'SELECT attempt_id FROM motive.acceptance_decisions LIMIT 0',
        'SELECT * FROM motive.attempts LIMIT 0',
        'SELECT profile_digest FROM motive.attempts LIMIT 0',
        'SELECT input_digest FROM motive.attempts LIMIT 0',
        'SELECT grant_id FROM motive.attempts LIMIT 0',
        'SELECT source_id FROM motive.attempts LIMIT 0',
        'SELECT ceiling_amount FROM motive.attempts LIMIT 0',
        'SELECT consumed_amount FROM motive.attempts LIMIT 0',
        'SELECT * FROM motive.orchestration_artifact_seals LIMIT 0',
        'SELECT receipt_id FROM motive.orchestration_artifact_seals LIMIT 0',
        `INSERT INTO motive.evaluations (id) VALUES ('${randomUUID()}')`,
        `INSERT INTO motive.acceptance_decisions (id) VALUES ('${randomUUID()}')`,
        'UPDATE motive.evaluations SET outcome = outcome WHERE FALSE',
        'DELETE FROM motive.acceptance_decisions WHERE FALSE',
      ]) await expectDenied(client, sql);
    });
  });
});
