import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SubmissionSummary } from '../../src/lib/participation.ts';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, ParticipationError, type ParticipationAgentContext, type ParticipationService } from './service.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
type Lookups = { submissionById(client: PoolClient, id: string): Promise<SubmissionSummary>;
  submissionsByIds(client: PoolClient, ids: string[]): Promise<SubmissionSummary[]> };
type Agent = { context: ParticipationAgentContext; claimId: string; leaseEpoch: number };

pgDescribe('batched submission summaries on isolated PostgreSQL', () => {
  const databaseName = `motive_projection_batch_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:projection-batch-${randomUUID()}`; const owner = `account:${randomUUID()}`;
  const tokenSecret = 'projection-batch-test-secret-longer-than-thirty-two-bytes';
  let admin: Pool; let pool: Pool; let testUrl: string; let service: ParticipationService; let projectId: string;
  let assignmentId: string; const seeded: string[] = [];

  async function participant(actor: string, name: string, publish: boolean): Promise<Agent> {
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()) ON CONFLICT(actor_id) DO NOTHING`, [actor, randomUUID()]);
    const joined = await service.join(actor, name, { projectSlug: 'circle-packing', publishDisplayName: publish,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    return { context, claimId: claim.claimId!, leaseEpoch: claim.leaseEpoch! };
  }

  async function insertSubmission(agent: Agent, index: number): Promise<string> {
    const id = randomUUID(); const valid = index % 5 === 0; const createdAt = new Date(Date.parse('2026-09-20T00:00:00.000Z') + index * 1_000).toISOString();
    const reportBody = { format: 'projection-batch-test-report', submissionId: id }; const reportDigest = digestCanonicalJson(reportBody);
    const provenance = index % 4 === 0 ? { investigation: { attribution: { kind: 'AGENT_DECLARED', agentName: 'Batch Agent',
      modelName: null, contributorDisplayName: null }, investigation: { format: 'motive.investigation.v1', proposal: `Try move ${index}.`,
      expectation: 'The score changes.', conditions: ['Use the exact checker.'], observations: ['The checker ran.'],
      assessment: 'The move was checked.', nextAction: 'Try another move.' }, interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' } } : {};
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status,created_at)
      SELECT $1,$2,$3,work.revision,'EXTERNAL','agent:' || token.id::text,$4,$5,'motive.submission/0.1',$6,$7,
        $8::jsonb,'unmetered_external',token.license_acceptance_ref,$9,$10::timestamptz
      FROM motive.work_orders work JOIN motive.participation_agent_tokens token ON token.id=$11 WHERE work.id=$3`,
    [id, projectId, assignmentId, agent.claimId, agent.leaseEpoch, '0'.repeat(40), digestCanonicalJson({ kind: 'projection-batch-manifest', id }),
      JSON.stringify(provenance), valid ? 'PENDING_EVALUATION' : 'REJECTED', createdAt, agent.context.tokenId]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,
       report_digest,exact_score,exceeds_reference,contributor_display_name,created_at)
      SELECT $1,$2,token.id,'motive.csqv.witness.v1',$3,$4,$5,$6::jsonb,$7,$8,$9,token.public_display_name,$10::timestamptz
      FROM motive.participation_agent_tokens token WHERE token.id=$11`, [id, projectId, Buffer.from(`{"batch":"${id}"}`),
      digestCanonicalJson({ kind: 'projection-batch-witness', id }), valid ? 'VALID' : 'REJECTED', JSON.stringify(reportBody), reportDigest,
      valid ? `2.${600 + index}` : null, valid ? false : null, createdAt, agent.context.tokenId]);
    if (index % 6 === 0) await pool.query(`INSERT INTO motive.participation_submission_reviews(submission_id,project_id,decision,reviewer_actor_id,rationale)
      VALUES($1,$2,$3,$4,'Batch review.')`, [id, projectId, valid ? 'ACCEPTED' : 'REJECTED', issuer]);
    if (index % 7 === 0) await pool.query(`INSERT INTO motive.participation_post_check_assessments
      (submission_id,project_id,agent_token_id,report_digest,assessment,next_action,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, projectId, agent.context.tokenId, reportDigest, 'Checked after the report.', 'Try another move.', digestCanonicalJson({ id, kind: 'post' })]);
    if (index % 8 === 0) await pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,trial_results_bytes,
       trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,'sha256:' || encode(sha256($5),'hex'),$6,
       'sha256:' || encode(sha256($6),'hex'),$7)`, [id, projectId, agent.context.tokenId, reportDigest, Buffer.from(`solver ${index}`),
      Buffer.from(`trial ${index}`), digestCanonicalJson({ id, kind: 'reproducibility' })]);
    return id;
  }

  beforeAll(async () => {
    const source = new URL(baseUrl!); expect(['localhost', '127.0.0.1']).toContain(source.hostname);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres'; admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated = new URL(source); isolated.pathname = `/${databaseName}`; testUrl = isolated.toString();
    pool = new Pool({ connectionString: testUrl, max: 4 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Projection batch test' } })).id;
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
    const named = await participant(owner, 'Named contributor', true);
    const hidden = await participant(`account:${randomUUID()}`, 'Private contributor', false);
    for (let index = 0; index < 55; index += 1) seeded.push(await insertSubmission(index % 3 === 0 ? hidden : named, index));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  it('returns exactly the per-id summaries in input order and keeps the missing-id error', async () => {
    const client = await pool.connect(); const lookups = service as unknown as Lookups;
    try {
      const ids = [seeded[7]!, seeded[0]!, seeded[54]!, seeded[16]!, seeded[0]!, seeded[35]!, seeded[48]!, seeded[21]!];
      const single: SubmissionSummary[] = []; for (const id of ids) single.push(await lookups.submissionById(client, id));
      const batched = await lookups.submissionsByIds(client, ids);
      expect(batched).toEqual(single); expect(batched.map(item => item.id)).toEqual(ids);
      expect(JSON.stringify(batched)).toBe(JSON.stringify(single));
      expect(new Set(batched.map(item => item.acceptance))).toEqual(new Set(['ACCEPTED', 'REJECTED', 'PENDING']));
      expect(batched.some(item => item.investigationHref) && batched.some(item => !item.investigationHref)).toBe(true);
      expect(batched.some(item => item.postCheckAssessmentHref) && batched.some(item => item.reproducibilityHref)).toBe(true);
      expect(batched.some(item => item.contributorDisplayName === null) && batched.some(item => item.contributorDisplayName)).toBe(true);
      expect(await lookups.submissionsByIds(client, [])).toEqual([]);
      const missing = randomUUID();
      await expect(lookups.submissionById(client, missing)).rejects.toEqual(new ParticipationError('NOT_FOUND', 'Submission not found.'));
      const failed = await lookups.submissionsByIds(client, [ids[0]!, missing]).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(ParticipationError);
      expect(failed).toMatchObject({ code: 'NOT_FOUND', message: 'Submission not found.' });
    } finally { client.release(); }
  });

  it('projects the newest fifty public and owner submissions with one summary query each', async () => {
    const expected = seeded.slice(-50).reverse(); const client = await pool.connect(); const lookups = service as unknown as Lookups;
    let single: SubmissionSummary[] = [];
    try { single = []; for (const id of expected) single.push(await lookups.submissionById(client, id)); }
    finally { client.release(); }
    const countedPool = new Pool({ connectionString: testUrl, max: 1 }); const statements: string[] = [];
    const instrumented = new WeakSet<PoolClient>(); const connect = countedPool.connect.bind(countedPool);
    Object.defineProperty(countedPool, 'connect', { value: async () => {
      const connected = await connect(); const query = connected.query.bind(connected);
      if (!instrumented.has(connected)) {
        connected.query = ((...args: unknown[]) => { if (typeof args[0] === 'string') statements.push(args[0]);
          return (query as unknown as (...values: unknown[]) => unknown)(...args); }) as PoolClient['query'];
        instrumented.add(connected);
      }
      return connected;
    } });
    try {
      const counted = createParticipationService(countedPool, { tokenSecret, issuerActorId: issuer });
      const projection = await counted.publicProjection();
      expect(projection.submissions).toEqual(single); expect(JSON.stringify(projection.submissions)).toBe(JSON.stringify(single));
      expect(projection.bestChecked?.id).toBe(seeded[50]); expect(projection.bestAccepted?.id).toBe(seeded[30]);
      expect(statements.filter(sql => sql.includes('WHERE submission.id=ANY($1::uuid[])'))).toHaveLength(1);
      expect(statements.filter(sql => sql.includes('WHERE submission.id=$1')).length).toBeLessThanOrEqual(3);
      statements.length = 0;
      const me = await counted.getMe(owner); const ownerIds = seeded.filter((_id, index) => index % 3 !== 0).slice(-50).reverse();
      expect(me.submissions.map(item => item.id)).toEqual(ownerIds);
      expect(statements.filter(sql => sql.includes('WHERE submission.id=ANY($1::uuid[])'))).toHaveLength(1);
      expect(statements.filter(sql => sql.includes('WHERE submission.id=$1'))).toHaveLength(0);
    } finally { await countedPool.end(); }
  }, 30_000);
});
