import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

pgDescribe('participation reproducibility files on isolated PostgreSQL', () => {
  const databaseName = `motive_reproducibility_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:reproducibility-${randomUUID()}`;
  const tokenSecret = 'reproducibility-test-secret-longer-than-thirty-two-bytes';
  let admin: Pool; let pool: Pool; let service: ParticipationService; let assignmentId: string;

  beforeAll(async () => {
    const adminUrl = new URL(baseUrl!); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl!); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 16 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Reproducibility test' } });
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  async function activate(owner: string) {
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
  }

  async function checked(owner = `account:${randomUUID()}`, complete = true) {
    await activate(owner);
    const joined = await service.join(owner, 'Reproducibility tester', { projectSlug: 'circle-packing', publishDisplayName: true,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    const submission = await service.submitWitness(context, assignmentId, { leaseEpoch: claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}' }, `submit-${randomUUID()}`);
    if (complete) await service.completeAssignment(context, assignmentId,
      { leaseEpoch: claim.leaseEpoch!, submissionId: submission.id }, `complete-${randomUUID()}`);
    const report = await service.publicReport(submission.id);
    return { owner, joined, context, submission, reportDigest: String(report.reportDigest) };
  }

  it('appends checksummed public source and trial bytes after completion without changing checked evidence or acceptance', async () => {
    const fixture = await checked(); const solverSource = 'for i in range(3):\n    print(i)\n'; const trialResults = 'trial=1 score=0\ntrial=2 score=1\n';
    const before = await pool.query(`SELECT submission.provenance,submission.artifact_manifest_digest,submission.status,
      artifact.witness_digest,artifact.report_digest,artifact.report_body,review.decision
      FROM motive.submissions submission JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id WHERE submission.id=$1`, [fixture.submission.id]);
    const originalDigest = digestCanonicalJson(before.rows[0]);
    const input = { reportDigest: fixture.reportDigest, solverSource, trialResults };
    const created = await service.createSubmissionReproducibility(fixture.context, fixture.submission.id, input, `repro-${randomUUID()}`);
    expect(created).toMatchObject({ format: 'motive.submission-reproducibility.public.v1', submissionId: fixture.submission.id,
      reportDigest: fixture.reportDigest, attribution: { kind: 'AGENT_DECLARED', credentialId: fixture.joined.credential.id,
        contributorDisplayName: 'Reproducibility tester' }, disposition: 'AGENT_DECLARED_UNVERIFIED' });
    expect(created.notice).toContain('did not execute or check');
    expect(created.files).toEqual([
      expect.objectContaining({ role: 'SOLVER_SOURCE', name: 'solver-source.txt', bytes: Buffer.byteLength(solverSource), digest: hash(solverSource) }),
      expect.objectContaining({ role: 'TRIAL_RESULTS', name: 'trial-results.txt', bytes: Buffer.byteLength(trialResults), digest: hash(trialResults) }),
    ]);
    expect(await service.publicSubmissionReproducibility(fixture.submission.id)).toEqual(created);
    expect(await service.publicSubmissionReproducibilityFile(fixture.submission.id, 'SOLVER_SOURCE'))
      .toMatchObject({ bytes: Buffer.from(solverSource), digest: hash(solverSource), name: 'solver-source.txt' });
    expect(await service.publicSubmissionReproducibilityFile(fixture.submission.id, 'TRIAL_RESULTS'))
      .toMatchObject({ bytes: Buffer.from(trialResults), digest: hash(trialResults), name: 'trial-results.txt' });
    const summary = (await service.publicProjection()).submissions.find(item => item.id === fixture.submission.id);
    expect(summary?.reproducibilityHref).toBe(`/api/public/projects/circle-packing/submissions/${fixture.submission.id}/reproducibility`);
    expect(summary?.acceptance).toBe('PENDING');
    const after = await pool.query(`SELECT submission.provenance,submission.artifact_manifest_digest,submission.status,
      artifact.witness_digest,artifact.report_digest,artifact.report_body,review.decision
      FROM motive.submissions submission JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id WHERE submission.id=$1`, [fixture.submission.id]);
    expect(digestCanonicalJson(after.rows[0])).toBe(originalDigest);
  }, 20_000);

  it('replays identical requests, recovers by body under a different key, and serializes concurrent different bodies', async () => {
    const fixture = await checked(); const input = { reportDigest: fixture.reportDigest, solverSource: 'source-v1', trialResults: 'trial-v1' };
    const key = `repro-${randomUUID()}`;
    const first = await service.createSubmissionReproducibility(fixture.context, fixture.submission.id, input, key);
    expect(await service.createSubmissionReproducibility(fixture.context, fixture.submission.id, input, key)).toEqual(first);
    expect(await service.createSubmissionReproducibility(fixture.context, fixture.submission.id, input, `recover-${randomUUID()}`)).toEqual(first);
    await expect(service.createSubmissionReproducibility(fixture.context, fixture.submission.id,
      { ...input, trialResults: 'changed' }, `changed-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const concurrent = await checked(); const common = { reportDigest: concurrent.reportDigest, solverSource: 'source' };
    const outcomes = await Promise.allSettled([
      service.createSubmissionReproducibility(concurrent.context, concurrent.submission.id,
        { ...common, trialResults: 'trial-a' }, `race-a-${randomUUID()}`),
      service.createSubmissionReproducibility(concurrent.context, concurrent.submission.id,
        { ...common, trialResults: 'trial-b' }, `race-b-${randomUUID()}`),
    ]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(item => item.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(await pool.query(`SELECT count(*)::integer AS count FROM motive.participation_submission_reproducibility
      WHERE submission_id=$1`, [concurrent.submission.id])).toMatchObject({ rows: [{ count: 1 }] });
  }, 20_000);

  it('rejects wrong reports and credentials that are foreign, expired, revoked, inactive, or no longer members', async () => {
    const target = await checked(); const input = { reportDigest: target.reportDigest, solverSource: 'source', trialResults: 'trial' };
    await expect(service.createSubmissionReproducibility(target.context, target.submission.id,
      { ...input, reportDigest: `sha256:${'f'.repeat(64)}` }, `wrong-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });
    const sameOwnerOther = await service.join(target.owner, 'Other credential', { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const otherContext = await service.authenticateBearer(sameOwnerOther.token);
    await expect(service.createSubmissionReproducibility(otherContext, target.submission.id, input, `other-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = await checked();
    await expect(service.createSubmissionReproducibility(foreign.context, target.submission.id, input, `foreign-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    const expiredService = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      now: () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000) });
    await expect(expiredService.createSubmissionReproducibility(target.context, target.submission.id, input, `expired-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const revoked = await checked(); await service.revokeToken(revoked.owner, revoked.joined.credential.id, `revoke-${randomUUID()}`);
    await expect(service.createSubmissionReproducibility(revoked.context, revoked.submission.id,
      { ...input, reportDigest: revoked.reportDigest }, `revoked-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const inactive = await checked(); await pool.query(`UPDATE motive.account_identities
      SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [inactive.owner]);
    await expect(service.createSubmissionReproducibility(inactive.context, inactive.submission.id,
      { ...input, reportDigest: inactive.reportDigest }, `inactive-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const removed = await checked(); await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE actor_id=$1`, [removed.owner]);
    await expect(service.createSubmissionReproducibility(removed.context, removed.submission.id,
      { ...input, reportDigest: removed.reportDigest }, `removed-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  }, 30_000);

  it('enforces byte checksums, exact DB binding, and immutable rows', async () => {
    const fixture = await checked(); const source = Buffer.from('source'); const trials = Buffer.from('trials');
    const parameters = [fixture.submission.id, fixture.context.projectId, fixture.context.tokenId, fixture.reportDigest,
      source, hash(source), trials, hash(trials), hash('request')];
    await expect(pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
       trial_results_bytes,trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [...parameters.slice(0, 5), hash('wrong-source'), ...parameters.slice(6)])).rejects.toThrow();
    await expect(pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
       trial_results_bytes,trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [...parameters.slice(0, 2), randomUUID(), ...parameters.slice(3)])).rejects.toThrow(/exact submission credential/i);
    await pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
       trial_results_bytes,trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, parameters);
    await expect(pool.query(`UPDATE motive.participation_submission_reproducibility SET trial_results_bytes=$2 WHERE submission_id=$1`,
      [fixture.submission.id, Buffer.from('changed')])).rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM motive.participation_submission_reproducibility WHERE submission_id=$1`,
      [fixture.submission.id])).rejects.toThrow(/immutable/i);
    const emptyFixture = await checked();
    await expect(pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
       trial_results_bytes,trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [emptyFixture.submission.id, emptyFixture.context.projectId, emptyFixture.context.tokenId, emptyFixture.reportDigest,
      Buffer.alloc(0), hash(Buffer.alloc(0)), trials, hash(trials), hash('empty')])).rejects.toThrow();
  }, 30_000);
});
