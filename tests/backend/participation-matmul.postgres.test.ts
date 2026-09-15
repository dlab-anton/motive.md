import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createAgentDispatchRouter, createJoinDispatchRouter, createParticipationRouters, createParticipationService,
  MATMUL_4X4X4_PARTICIPATION_PROFILE, type ParticipationService } from '../../server/participation/index.ts';
import { type MatmulWitness } from '../../src/lib/matmul.ts';
import { canonicalWitnessJson } from '../../src/lib/matmul-schemes.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

/** Split one product's output row in two: a valid scheme with one more product than the reference. */
function worsen(witness: MatmulWitness): MatmulWitness {
  const w = witness.w[0]; const first = w.findIndex(entry => entry !== 0);
  const head = w.map((entry, index) => index === first ? entry : 0); const tail = w.map((entry, index) => index === first ? 0 : entry);
  return { ...witness, rank: witness.rank + 1, u: [witness.u[0], ...witness.u], v: [witness.v[0], ...witness.v], w: [head, tail, ...witness.w.slice(1)] };
}

pgDescribe('matmul-4x4x4 participation beside circle-packing on isolated PostgreSQL', () => {
  const databaseName = `motive_matmul_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let circle: ParticipationService; let matmul: ParticipationService; let issuer: string;
  let matmulAssignmentId: string; let circleAssignmentId: string; let reference: string;
  const tokenSecret = `test-only-${'m'.repeat(48)}`;

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    issuer = `operator:matmul-test-${randomUUID()}`;
    const ledger = new LedgerKernel(pool);
    for (const slug of ['circle-packing', 'matmul-4x4x4']) {
      await ledger.createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug, visibility: 'PUBLIC', revisionContent: { title: `Isolated ${slug}` } });
    }
    circle = createParticipationService(pool, { tokenSecret, issuerActorId: issuer });
    matmul = createParticipationService(pool, { tokenSecret, issuerActorId: issuer, profile: MATMUL_4X4X4_PARTICIPATION_PROFILE });
    circleAssignmentId = (await circle.ensureWorkOrder()).id;
    matmulAssignmentId = (await matmul.ensureWorkOrder()).id;
    reference = await readFile('public/projects/matmul-4x4x4/reference-witness.json', 'utf8');
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('pins the matmul work order to the integer checker profile and keeps it apart from circle-packing', async () => {
    const work = await pool.query('SELECT work_order_key,terms,project_id::text FROM motive.work_orders WHERE id=$1', [matmulAssignmentId]);
    expect(work.rows[0].work_order_key).toBe('matmul-4x4x4-external');
    expect(work.rows[0].terms).toMatchObject({ agreement_id: 'matmul-4x4x4-external-v1', allowed_effects: ['submit-data-only-matmul-scheme'],
      external: { artifact: { formats: ['motive.matmul.witness.v1'], max_bytes: 32768 } } });
    expect(work.rows[0].terms.input_commit).toBe('f1e033dc772abbfa0546cc8eeb04ae92c4de2358ee29ff9a653cf32fec3cd260');
    expect(matmulAssignmentId).not.toBe(circleAssignmentId);
    const projection = await matmul.publicProjection();
    expect(projection.project).toMatchObject({ slug: 'matmul-4x4x4', visibility: 'PUBLIC', lifecycle: 'NOT_STARTED' });
    await expect(matmul.join(`account:${randomUUID()}`, 'Wrong Slug', { projectSlug: 'circle-packing', publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('checks integer schemes exactly, orders the best result by fewest products, and retains a rejected circle witness as evidence', async () => {
    const owner = `account:${randomUUID()}`;
    const joined = await matmul.join(owner, 'Scheme Tester', { projectSlug: 'matmul-4x4x4', publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    expect(joined.assignment).toMatchObject({ id: matmulAssignmentId, projectSlug: 'matmul-4x4x4', status: 'AVAILABLE' });
    expect(joined.credential.projectSlug).toBe('matmul-4x4x4');
    const stored = await pool.query('SELECT license_acceptance_ref FROM motive.participation_agent_tokens WHERE id=$1', [joined.credential.id]);
    expect(stored.rows[0].license_acceptance_ref).toBe('matmul-reference-terms-v1');
    const context = await matmul.authenticateBearer(joined.token);

    // A valid but worse scheme first, so the ordering direction is observable.
    const worse = canonicalWitnessJson(worsen(JSON.parse(reference) as MatmulWitness));
    const claimOne = await matmul.claimAssignment(context, matmulAssignmentId, `claim-${randomUUID()}`);
    const worseSubmission = await matmul.submitWitness(context, matmulAssignmentId, { leaseEpoch: claimOne.leaseEpoch!, witness: worse }, `submit-${randomUUID()}`);
    expect(worseSubmission).toMatchObject({ reportStatus: 'VALID', exactScore: '50', exceedsReference: false, acceptance: 'PENDING' });
    expect(worseSubmission.artifactHref).toBe(`/api/public/projects/matmul-4x4x4/submissions/${worseSubmission.id}/artifact`);
    await matmul.completeAssignment(context, matmulAssignmentId, { leaseEpoch: claimOne.leaseEpoch!, submissionId: worseSubmission.id }, `complete-${randomUUID()}`);
    expect((await matmul.publicProjection()).bestChecked?.id).toBe(worseSubmission.id);

    const claimTwo = await matmul.claimAssignment(context, matmulAssignmentId, `claim-${randomUUID()}`);
    const submission = await matmul.submitWitness(context, matmulAssignmentId, { leaseEpoch: claimTwo.leaseEpoch!, witness: reference }, `submit-${randomUUID()}`);
    expect(submission).toMatchObject({ reportStatus: 'VALID', exactScore: '49', exceedsReference: false });
    expect((await matmul.publicArtifact(submission.id)).bytes.toString('utf8')).toBe(reference);
    const report = await matmul.publicReport(submission.id);
    expect(report).toMatchObject({ reportStatus: 'VALID', exactScore: '49', binding: { submissionId: submission.id, workOrderId: matmulAssignmentId,
      checker: { format: 'motive.matmul.local-check.v1', sourceDigest: 'sha256:c7755859bab212047e4dddf10728d5fa92cfcbad24eb9a938685277003b99d51' } } });
    expect((report.report as { format: string; result: { ok: boolean; report: { rank: number } } })).toMatchObject({ format: 'motive.matmul.checked-report.v1', result: { ok: true, report: { rank: 49 } } });
    const artifact = await pool.query('SELECT witness_format,exact_score,exceeds_reference FROM motive.participation_submission_artifacts WHERE submission_id=$1', [submission.id]);
    expect(artifact.rows[0]).toEqual({ witness_format: 'motive.matmul.witness.v1', exact_score: '49', exceeds_reference: false });
    await matmul.completeAssignment(context, matmulAssignmentId, { leaseEpoch: claimTwo.leaseEpoch!, submissionId: submission.id }, `complete-${randomUUID()}`);
    const projection = await matmul.publicProjection();
    expect(projection.bestChecked?.id).toBe(submission.id);
    expect(projection).toMatchObject({ totalSubmissions: 2, project: { slug: 'matmul-4x4x4', lifecycle: 'RESULTS_AVAILABLE' } });
    await expect(matmul.publicGeometryComparison(submission.id, worseSubmission.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // A circle-packing witness is data, not a scheme: it is checked, rejected and retained as evidence.
    const circleWitness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    const claimThree = await matmul.claimAssignment(context, matmulAssignmentId, `claim-${randomUUID()}`);
    const rejected = await matmul.submitWitness(context, matmulAssignmentId, { leaseEpoch: claimThree.leaseEpoch!, witness: circleWitness }, `submit-${randomUUID()}`);
    expect(rejected).toMatchObject({ reportStatus: 'REJECTED', exactScore: null, exceedsReference: null });
    expect((await matmul.publicReport(rejected.id)).report).toMatchObject({ result: { ok: false, error: { code: 'MALFORMED_STRUCTURE' } } });
    await matmul.completeAssignment(context, matmulAssignmentId, { leaseEpoch: claimThree.leaseEpoch!, submissionId: rejected.id }, `complete-${randomUUID()}`);
    expect((await matmul.publicProjection()).bestChecked?.id).toBe(submission.id);

    // Circle-packing sees none of it.
    expect((await circle.publicProjection())).toMatchObject({ totalSubmissions: 0, project: { slug: 'circle-packing' } });
    expect((await circle.getMe(owner)).credentials).toEqual([]);
    expect((await matmul.getMe(owner)).credentials.map(item => item.projectSlug)).toEqual(['matmul-4x4x4']);
  }, 30_000);

  it('dispatches shared join and agent routes to the credential’s project', async () => {
    const circleRouters = createParticipationRouters({ service: circle, isActorActive: async () => true });
    const matmulRouters = createParticipationRouters({ service: matmul, isActorActive: async () => true });
    const additional = [{ profile: MATMUL_4X4X4_PARTICIPATION_PROFILE, service: matmul, routers: matmulRouters }];
    const owner = `account:${randomUUID()}`;
    const app = express();
    app.use(express.json());
    app.use('/api/participation', (_req, res, next) => { res.locals.actorId = owner; res.locals.accountName = 'Dispatch Tester'; next(); });
    app.use('/api/participation', createJoinDispatchRouter({ additional }));
    app.use('/api/participation/projects/matmul-4x4x4', matmulRouters.accountRouter);
    app.use('/api/participation', circleRouters.accountRouter);
    app.use('/api/agent', createAgentDispatchRouter({ pool, defaultRouter: circleRouters.agentRouter, additional }));
    const server = app.listen(0); await once(server, 'listening');
    const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const join = async (projectSlug: string) => {
        const response = await fetch(`${origin}/api/participation/join`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `join-${randomUUID()}` },
          body: JSON.stringify({ projectSlug, publishDisplayName: true, acceptReferenceTerms: true }) });
        expect(response.status).toBe(201);
        return await response.json() as { token: string; assignment: { projectSlug: string; id: string } };
      };
      const matmulJoin = await join('matmul-4x4x4'); const circleJoin = await join('circle-packing');
      expect(matmulJoin.assignment).toMatchObject({ projectSlug: 'matmul-4x4x4', id: matmulAssignmentId });
      expect(circleJoin.assignment).toMatchObject({ projectSlug: 'circle-packing', id: circleAssignmentId });
      const unknown = await fetch(`${origin}/api/participation/join`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `join-${randomUUID()}` },
        body: JSON.stringify({ projectSlug: 'nope', publishDisplayName: true, acceptReferenceTerms: true }) });
      expect(unknown.status).toBe(400);

      const queue = async (token: string) => {
        const response = await fetch(`${origin}/api/agent/work-queue`, { headers: { Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        return await response.json() as { assignment: { projectSlug: string; id: string } };
      };
      expect((await queue(matmulJoin.token)).assignment).toMatchObject({ projectSlug: 'matmul-4x4x4', id: matmulAssignmentId });
      expect((await queue(circleJoin.token)).assignment).toMatchObject({ projectSlug: 'circle-packing', id: circleAssignmentId });
      const bogus = await fetch(`${origin}/api/agent/work-queue`, { headers: { Authorization: 'Bearer motive_agent_not_a_token' } });
      expect(bogus.status).toBe(401);

      const me = async (path: string) => (await (await fetch(`${origin}${path}`)).json()) as { projectSlug: string; credentials: Array<{ projectSlug: string }> };
      expect((await me('/api/participation/me'))).toMatchObject({ projectSlug: 'circle-packing', credentials: [{ projectSlug: 'circle-packing' }] });
      expect((await me('/api/participation/projects/matmul-4x4x4/me'))).toMatchObject({ projectSlug: 'matmul-4x4x4', credentials: [{ projectSlug: 'matmul-4x4x4' }] });
    } finally { server.close(); await once(server, 'close'); }
  }, 30_000);
});
