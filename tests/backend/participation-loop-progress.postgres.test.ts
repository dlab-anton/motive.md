import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('participation loop progress on isolated PostgreSQL', () => {
  const databaseName = `motive_loop_progress_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:loop-progress-${randomUUID()}`;
  let admin: Pool; let pool: Pool; let service: ParticipationService; let assignmentId: string;

  beforeAll(async () => {
    const adminUrl = new URL(baseUrl!); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl!); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Loop progress test' } });
    service = createParticipationService(pool, { tokenSecret: 'loop-progress-test-secret-that-is-longer-than-thirty-two-bytes',
      issuerActorId: issuer });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function activate(owner: string) {
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
  }

  async function join(activeService: ParticipationService, owner: string, label: string) {
    return activeService.join(owner, label, { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
  }

  async function claim(activeService: ParticipationService, token: string) {
    const context = await activeService.authenticateBearer(token);
    const assignment = await activeService.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    return { context, assignment };
  }

  it('counts durable history and only current eligible active agents without treating a check as a completed cycle', async () => {
    const primaryOwner = `account:${randomUUID()}`; await activate(primaryOwner);
    const completedCredential = await join(service, primaryOwner, 'Completed credential');
    const completedClaim = await claim(service, completedCredential.token);
    const witness = '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}';
    const completedSubmission = await service.submitWitness(completedClaim.context, assignmentId,
      { leaseEpoch: completedClaim.assignment.leaseEpoch!, witness }, `submit-${randomUUID()}`);
    const updatedWithoutCompletion = await service.submitWitness(completedClaim.context, assignmentId,
      { leaseEpoch: completedClaim.assignment.leaseEpoch!, witness }, `submit-${randomUUID()}`);
    const completionKey = `complete-${randomUUID()}`;
    for (let replay = 0; replay < 2; replay++) await service.completeAssignment(completedClaim.context, assignmentId,
      { leaseEpoch: completedClaim.assignment.leaseEpoch!, submissionId: completedSubmission.id }, completionKey);
    expect((await service.getMe(primaryOwner)).loopProgress?.find(item => item.credentialId === completedCredential.credential.id)?.xp).toBe(0);
    for (const submission of [completedSubmission, updatedWithoutCompletion]) {
      const report = await service.publicReport(submission.id);
      const input = { reportDigest: String(report.reportDigest), assessment: 'The protected checker rejected this bounded candidate.',
        nextAction: 'Try a different complete candidate.' };
      const key = `update-${randomUUID()}`;
      await service.createPostCheckAssessment(completedClaim.context, submission.id, input, key);
      await service.createPostCheckAssessment(completedClaim.context, submission.id, input, key);
    }

    const activeCredential = await join(service, primaryOwner, 'Active credential');
    await claim(service, activeCredential.token);
    const releasedCredential = await join(service, primaryOwner, 'Released credential');
    const releasedClaim = await claim(service, releasedCredential.token);
    await service.releaseAssignment(releasedClaim.context, assignmentId,
      { leaseEpoch: releasedClaim.assignment.leaseEpoch! }, `release-${randomUUID()}`);

    const secondActiveOwner = `account:${randomUUID()}`; await activate(secondActiveOwner);
    const secondActive = await join(service, secondActiveOwner, 'Second active'); await claim(service, secondActive.token);

    const inactiveOwner = `account:${randomUUID()}`; await activate(inactiveOwner);
    const inactive = await join(service, inactiveOwner, 'Inactive account'); await claim(service, inactive.token);
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
      WHERE actor_id=$1`, [inactiveOwner]);

    const revokedMemberOwner = `account:${randomUUID()}`; await activate(revokedMemberOwner);
    const revokedMember = await join(service, revokedMemberOwner, 'Revoked member'); await claim(service, revokedMember.token);
    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE actor_id=$1`, [revokedMemberOwner]);

    const revokedTokenOwner = `account:${randomUUID()}`; await activate(revokedTokenOwner);
    const revokedToken = await join(service, revokedTokenOwner, 'Revoked token'); await claim(service, revokedToken.token);
    await service.revokeToken(revokedTokenOwner, revokedToken.credential.id, `revoke-${randomUUID()}`);

    const expiredOwner = `account:${randomUUID()}`; await activate(expiredOwner);
    const pastService = createParticipationService(pool, {
      tokenSecret: 'loop-progress-test-secret-that-is-longer-than-thirty-two-bytes', issuerActorId: issuer,
      now: () => new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const expired = await join(pastService, expiredOwner, 'Expired credential'); await claim(pastService, expired.token);

    const privateState = await service.getMe(primaryOwner);
    expect(privateState.loopProgress).toHaveLength(3);
    expect(privateState.loopProgress?.find(item => item.credentialId === completedCredential.credential.id)).toEqual({
      credentialId: completedCredential.credential.id, completedAttempts: 1, checkedSubmissions: 2,
      recordedUpdates: 2, completedCycles: 1, acceptedDistinctFindings: 0, xp: 100,
    });
    for (const credential of [activeCredential, releasedCredential]) {
      expect(privateState.loopProgress?.find(item => item.credentialId === credential.credential.id)).toEqual({
        credentialId: credential.credential.id, completedAttempts: 0, checkedSubmissions: 0,
        recordedUpdates: 0, completedCycles: 0, acceptedDistinctFindings: 0, xp: 0,
      });
    }

    const publicState = await service.publicProjection();
    expect(publicState.loopProgress).toEqual({ activeAgents: 2, completedAttempts: 1, checkedSubmissions: 2,
      recordedUpdates: 2, completedCycles: 1 });
    expect(publicState.activeAssignments).toBeGreaterThan(publicState.loopProgress!.activeAgents);
  }, 30_000);
});
