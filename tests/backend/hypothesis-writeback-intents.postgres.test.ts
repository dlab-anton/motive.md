import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import {
  createHypothesisDeliveryIntentService, DeliveryIntentError, type HypothesisDeliveryIntentService,
} from '../../server/research-memory/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('Hypothesis writeback preparation on isolated PostgreSQL', () => {
  const databaseName = `motive_hypothesis_intent_${randomUUID().replaceAll('-', '')}`;
  const operator = `operator:${randomUUID()}`; const owner = `account:${randomUUID()}`;
  const contributor = `account:${randomUUID()}`; const activeActors = new Set([owner, contributor]);
  let admin: Pool; let pool: Pool; let participation: ParticipationService;
  let service: HypothesisDeliveryIntentService; let projectId: string; let scopeId: string;
  let firstSubmissionId: string; let secondSubmissionId: string;

  async function insertScope(targetProjectId: string, status: 'CONNECTED' | 'REPLACEMENT_PENDING' = 'CONNECTED') {
    const id = randomUUID(); const digest = `sha256:${'a'.repeat(64)}`;
    await pool.query(`INSERT INTO motive.project_research_scopes
      (id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,channel_snapshot,
       channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
       api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','https://engine.invalid/api/v1',$3,$4,'circle-packing',$5::jsonb,
        $6,$7,$8,$9,'1.8.0',$10,$11,$12,clock_timestamp())`,
    [id,targetProjectId,randomUUID(),randomUUID(),JSON.stringify({ name: 'circle-packing', goal: 'Isolated test' }),
      digest,Buffer.alloc(32,7),`sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'7'.repeat(40),status,owner]);
    return id;
  }

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 10 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await new LedgerKernel(pool).createProject({ actorId: operator, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Isolated intent test' } });
    projectId = project.id;
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'OWNER',ARRAY['project:admin'],$4)`, [randomUUID(),projectId,owner,operator]);
    participation = createParticipationService(pool, { tokenSecret: `test-only-${'s'.repeat(48)}`, issuerActorId: operator });
    const workOrderId = (await participation.ensureCircleWorkOrder()).id;
    const joined = await participation.join(contributor, 'Source contributor', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await participation.authenticateBearer(joined.token);
    const claim = await participation.claimAssignment(context, workOrderId, `claim-${randomUUID()}`);
    const witness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    firstSubmissionId = (await participation.submitWitness(context, workOrderId, { leaseEpoch: claim.leaseEpoch!, witness,
      investigation: { format: 'motive.investigation.v1', proposal: 'Retain a checked candidate as a proposal.',
        expectation: 'The exact checker should reproduce the frozen reference.', conditions: ['Use the protected checker.'],
        observations: ['The checker produced an exact report.'], assessment: 'This is contributor interpretation only.',
        nextAction: 'Await independent review before any knowledge claim.' } }, `submit-${randomUUID()}`)).id;
    secondSubmissionId = (await participation.submitWitness(context, workOrderId, { leaseEpoch: claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}' }, `submit-${randomUUID()}`)).id;
    scopeId = await insertScope(projectId);
    service = createHypothesisDeliveryIntentService({ pool, isActorActive: actorId => activeActors.has(actorId) });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  it('allows a current owner and freezes exact source provenance without claiming support or delivery', async () => {
    const prepared = await service.prepare(owner, { projectSlug: 'circle-packing', scopeId,
      submissionId: firstSubmissionId, idempotencyKey: `prepare-${randomUUID()}` });
    expect(prepared).toMatchObject({ state: 'ENGINE_WRITE_UNAVAILABLE', disposition: 'PROPOSED_UNREVIEWED', replayed: false,
      payload: { assessment: { hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED' },
        scope: { projectId, scopeId }, attribution: { engineActor: `motive:project:${projectId}`,
          preparedBy: owner, originalContributor: contributor },
        source: { submission: { id: firstSubmissionId }, artifact: { witness: expect.any(String), witnessDigest: expect.stringMatching(/^sha256:/) },
          report: { body: expect.any(Object), digest: expect.stringMatching(/^sha256:/) }, investigation: expect.any(Object) } } });
    expect(prepared.requestDigest).toBe(digestCanonicalJson({ projectSlug: 'circle-packing', scopeId, submissionId: firstSubmissionId }));
    expect(prepared.payloadDigest).toBe(digestCanonicalJson(prepared.payload));
    expect(JSON.stringify(prepared.payload)).not.toContain('SUPPORTED');
    await expect(pool.query('UPDATE motive.hypothesis_writeback_intents SET state=state WHERE id=$1', [prepared.id]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM motive.hypothesis_writeback_intents WHERE id=$1', [prepared.id]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('denies contributors, inactive accounts, and a submission from another project scope', async () => {
    const input = { projectSlug: 'circle-packing', scopeId, submissionId: firstSubmissionId,
      idempotencyKey: `prepare-${randomUUID()}` };
    await expect(service.prepare(contributor, input)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    activeActors.delete(owner);
    await expect(service.prepare(owner, { ...input, idempotencyKey: `prepare-${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    activeActors.add(owner);
    const foreign = await new LedgerKernel(pool).createProject({ actorId: operator, idempotencyKey: randomUUID(),
      slug: `foreign-${randomUUID()}`, visibility: 'PUBLIC', revisionContent: { title: 'Foreign project' } });
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'OWNER',ARRAY['project:admin'],$4)`, [randomUUID(),foreign.id,owner,operator]);
    const foreignScope = await insertScope(foreign.id);
    await expect(service.prepare(owner, { projectSlug: foreign.slug, scopeId: foreignScope,
      submissionId: firstSubmissionId, idempotencyKey: `prepare-${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('atomically replays concurrent identical preparation with stable digests', async () => {
    const idempotencyKey = `prepare-${randomUUID()}`;
    const calls = await Promise.all(Array.from({ length: 6 }, () => service.prepare(owner,
      { projectSlug: 'circle-packing', scopeId, submissionId: firstSubmissionId, idempotencyKey })));
    expect(new Set(calls.map(item => item.id))).toHaveLength(1);
    expect(new Set(calls.map(item => item.requestDigest))).toHaveLength(1);
    expect(new Set(calls.map(item => item.payloadDigest))).toHaveLength(1);
    expect(calls.filter(item => !item.replayed)).toHaveLength(1);
    const stored = await pool.query('SELECT count(*)::integer AS count FROM motive.hypothesis_writeback_intents WHERE prepared_by_actor_id=$1 AND idempotency_key=$2', [owner,idempotencyKey]);
    expect(stored.rows[0].count).toBe(1);
  });

  it('returns an explicit conflict when the same actor and key changes submission', async () => {
    const idempotencyKey = `prepare-${randomUUID()}`;
    await service.prepare(owner, { projectSlug: 'circle-packing', scopeId, submissionId: firstSubmissionId, idempotencyKey });
    await expect(service.prepare(owner, { projectSlug: 'circle-packing', scopeId,
      submissionId: secondSubmissionId, idempotencyKey })).rejects.toEqual(expect.objectContaining<Partial<DeliveryIntentError>>({
        code: 'CONFLICT', statusCode: 409,
      }));
  });

  it('replays the frozen result after an explicit scope replacement while permission remains current', async () => {
    const idempotencyKey = `prepare-${randomUUID()}`;
    const original = await service.prepare(owner, { projectSlug: 'circle-packing', scopeId,
      submissionId: firstSubmissionId, idempotencyKey });
    const replacement = await insertScope(projectId, 'REPLACEMENT_PENDING');
    await pool.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1", [scopeId,replacement]);
    await pool.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1", [replacement]);
    const replay = await service.prepare(owner, { projectSlug: 'circle-packing', scopeId,
      submissionId: firstSubmissionId, idempotencyKey });
    expect(replay).toMatchObject({ id: original.id, payloadDigest: original.payloadDigest, replayed: true,
      payload: { scope: { scopeId } } });
  });
});
