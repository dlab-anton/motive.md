import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createHypothesisSubmissionAdmissionService, createHypothesisSubmissionDeliveryService } from '../../server/research-memory/index.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('owner reviewer management on isolated PostgreSQL', () => {
  const databaseName = `motive_project_reviewers_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:reviewer-test-${randomUUID()}`;
  const ownerId = randomUUID(); const owner = `account:${ownerId}`;
  let admin: Pool; let pool: Pool; let projectId: string; let service: ParticipationService;
  const remotelyActive = new Set<string>([owner]);
  const remoteCalls: string[] = [];

  async function identity(accountId = randomUUID()) {
    const actorId = `account:${accountId}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [actorId, accountId]);
    remotelyActive.add(actorId);
    return { accountId, actorId };
  }

  async function membership(actorId: string, role: 'OWNER'|'STEWARD'|'SUPPORTER'|'CONTRIBUTOR'|'REVIEWER',
    scopes: string[] = []) {
    const id = randomUUID();
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, projectId, actorId, role, scopes, owner]);
    return id;
  }

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Reviewer test' } })).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, ownerId]);
    await membership(owner, 'OWNER', ['project:admin']);
    service = createParticipationService(pool, { tokenSecret: `test-only-${'s'.repeat(48)}`, issuerActorId: issuer,
      isActorActive: async actorId => { remoteCalls.push(actorId); return remotelyActive.has(actorId); } });
    await service.ensureCircleWorkOrder();
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('grants, lists, removes, and replays without leaking management authority', async () => {
    const target = await identity(); await membership(target.actorId, 'CONTRIBUTOR',
      ['external:claim', 'external:submit', 'custom:retained']);
    expect(await service.getMe(owner)).toMatchObject({ canReview: true, canManageReviewers: true });
    expect(await service.getMe(target.actorId)).toMatchObject({ canReview: false, canManageReviewers: false });

    const grantKey = `grant-${randomUUID()}`;
    const granted = await service.grantProjectReviewer(owner, target.accountId, grantKey);
    expect(granted).toEqual({ format: 'motive.project-reviewer-change/0.1', projectSlug: 'circle-packing',
      accountId: target.accountId, action: 'GRANT', changed: true, replayed: false });
    expect(await service.getMe(target.actorId)).toMatchObject({ canReview: true, canManageReviewers: false });
    await expect(service.projectReviewers(target.actorId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await service.projectReviewers(owner)).toEqual({ format: 'motive.project-reviewers/0.1',
      projectSlug: 'circle-packing', reviewers: [{ accountId: target.accountId }] });

    expect(await service.grantProjectReviewer(owner, target.accountId, grantKey))
      .toMatchObject({ changed: true, replayed: true });
    const callsBeforeConflict = remoteCalls.length;
    await expect(service.grantProjectReviewer(owner, randomUUID(), grantKey)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(remoteCalls.length).toBe(callsBeforeConflict + 1);

    const contributor = await identity();
    const workOrderId = (await service.ensureCircleWorkOrder()).id;
    const joinedContributor = await service.join(contributor.actorId, 'Reviewer test contributor', {
      projectSlug: 'circle-packing', publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const contributorContext = await service.authenticateBearer(joinedContributor.token);
    await service.claimAssignment(contributorContext, workOrderId, `claim-${randomUUID()}`);
    const submission = await service.submitWitness(contributorContext, workOrderId, { leaseEpoch: 1,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: { format: 'motive.investigation.v1', proposal: 'Check one bounded candidate.',
        expectation: 'The protected checker records an exact negative result.', conditions: ['Use the checker.'],
        observations: ['The candidate is incomplete.'], assessment: 'This does not establish support.',
        nextAction: 'An independent reviewer may assess the exact package.' } }, `submit-${randomUUID()}`);
    const artifact = await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',
      [submission.id]);
    await service.createPostCheckAssessment(contributorContext, submission.id, {
      reportDigest: String(artifact.rows[0].report_digest), assessment: 'The report rejects this bounded candidate.',
      nextAction: 'Retain only after independent review.' }, `assess-${randomUUID()}`);
    const scopeId = randomUUID(); const vaultKey = Buffer.alloc(32, 4);
    const apiBase = 'https://reviewer-management.invalid/api/v1';
    const encrypted = encryptSecret(vaultKey, `he_${'k'.repeat(43)}`, `research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,
      'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [scopeId, projectId, apiBase, randomUUID(), randomUUID(), `sha256:${'a'.repeat(64)}`, encrypted,
      `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, '7'.repeat(40), owner]);
    const isActorActive = async (actorId: string) => remotelyActive.has(actorId);
    const delivery = createHypothesisSubmissionDeliveryService({ pool, vaultKey, isActorActive,
      fetch: async () => { throw new Error('No engine call is permitted.'); } });
    const admission = createHypothesisSubmissionAdmissionService({ pool, vaultKey, isActorActive, sender: delivery,
      agentTokenSecret: `reviewer-management-${'x'.repeat(48)}` });
    await delivery.sync(owner, { projectSlug: 'circle-packing', scopeId, submissionId: submission.id,
      idempotencyKey: `delivery-${randomUUID()}`, approvedApiBaseUrl: apiBase,
      contract: PINNED_REVIEWED_WRITEBACK_CONTRACT, execute: false });
    const preview = await admission.prepareAdmissionPreview(target.actorId, submission.id);
    const oldAccess = await admission.issueAgentAccess(target.actorId, submission.id, {
      packageDigest: preview.packageDigest, expectedDecisionId: null }, `access-${randomUUID()}`);
    await expect(admission.authenticateReviewAgent(oldAccess.token)).resolves.toMatchObject({ reviewerActorId: target.actorId });

    const removed = await service.removeProjectReviewer(owner, target.accountId, `remove-${randomUUID()}`);
    expect(removed).toMatchObject({ action: 'REMOVE', changed: true, replayed: false });
    expect((await pool.query(`SELECT revoked_at IS NOT NULL AS revoked FROM motive.hypothesis_submission_admission_agent_access
      WHERE id=$1`, [oldAccess.access.id])).rows[0].revoked).toBe(true);
    await expect(admission.authenticateReviewAgent(oldAccess.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    let stored = await pool.query('SELECT role,scopes FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, target.actorId]);
    expect(stored.rows[0]).toMatchObject({ role: 'CONTRIBUTOR',
      scopes: expect.arrayContaining(['external:claim', 'external:submit', 'custom:retained']) });
    expect(stored.rows[0].scopes).not.toContain('project:review');
    await service.grantProjectReviewer(owner, target.accountId, `regrant-${randomUUID()}`);
    await expect(admission.authenticateReviewAgent(oldAccess.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const refreshed = await admission.prepareAdmissionPreview(target.actorId, submission.id);
    const newAccess = await admission.issueAgentAccess(target.actorId, submission.id, {
      packageDigest: refreshed.packageDigest, expectedDecisionId: null }, `access-${randomUUID()}`);
    await expect(admission.authenticateReviewAgent(newAccess.token)).resolves.toMatchObject({ reviewerActorId: target.actorId });
    await service.removeProjectReviewer(owner, target.accountId, `remove-${randomUUID()}`);
    await expect(admission.authenticateReviewAgent(newAccess.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await service.grantProjectReviewer(owner, target.accountId, grantKey))
      .toMatchObject({ action: 'GRANT', changed: true, replayed: true });
    stored = await pool.query('SELECT role FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, target.actorId]);
    expect(stored.rows[0].role).toBe('CONTRIBUTOR');
    const joined = await service.join(target.actorId, 'Contributor', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    expect(joined.token).toMatch(/^motive_agent_/);
    expect(await service.getMe(target.actorId)).toMatchObject({ canReview: false, canManageReviewers: false });
  }, 20_000);

  it('handles new, concurrent, inactive, revoked, protected, and cleanup targets without duplicate effects', async () => {
    const fresh = await identity(); const key = `fresh-${randomUUID()}`;
    const changes = await Promise.all([
      service.grantProjectReviewer(owner, fresh.accountId, key),
      service.grantProjectReviewer(owner, fresh.accountId, key),
    ]);
    expect(changes.map(item => item.replayed).sort()).toEqual([false, true]);
    expect(changes.every(item => item.changed)).toBe(true);
    let rows = await pool.query(`SELECT membership.role,membership.scopes,count(event.id)::integer AS events
      FROM motive.memberships membership LEFT JOIN motive.events event
        ON event.aggregate_id=membership.id AND event.event_type='participation.reviewer_granted'
      WHERE membership.project_id=$1 AND membership.actor_id=$2 GROUP BY membership.id`, [projectId, fresh.actorId]);
    expect(rows.rows[0]).toMatchObject({ role: 'REVIEWER', events: 1,
      scopes: expect.arrayContaining(['external:claim', 'external:submit', 'project:review']) });

    const cleanupKey = `cleanup-${randomUUID()}`;
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',
      deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [fresh.actorId]);
    await pool.query(`UPDATE motive.account_identities SET status='DELETED',
      deleted_at=clock_timestamp() WHERE actor_id=$1`, [fresh.actorId]);
    remotelyActive.delete(fresh.actorId);
    expect((await service.projectReviewers(owner)).reviewers).toContainEqual({ accountId: fresh.accountId });
    expect(await service.removeProjectReviewer(owner, fresh.accountId, cleanupKey))
      .toMatchObject({ action: 'REMOVE', changed: true });
    rows = await pool.query('SELECT role,scopes FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, fresh.actorId]);
    expect(rows.rows[0]).toMatchObject({ role: 'CONTRIBUTOR',
      scopes: expect.arrayContaining(['external:claim', 'external:submit']) });
    expect(await service.grantProjectReviewer(owner, fresh.accountId, key))
      .toMatchObject({ action: 'GRANT', changed: true, replayed: true });
    expect((await pool.query('SELECT role FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, fresh.actorId])).rows[0].role).toBe('CONTRIBUTOR');
    expect((await pool.query(`SELECT count(*)::integer AS count FROM motive.events
      WHERE event_type='participation.reviewer_granted' AND aggregate_id=(
        SELECT id FROM motive.memberships WHERE project_id=$1 AND actor_id=$2)`, [projectId, fresh.actorId])).rows[0].count).toBe(1);
    expect(await service.getMe(fresh.actorId)).toMatchObject({ canReview: false, canManageReviewers: false });
    const legacyActor = `account:${randomUUID()}`; await membership(legacyActor, 'REVIEWER', ['project:review']);
    expect(await service.getMe(legacyActor)).toMatchObject({ canReview: true, canManageReviewers: false });

    const bareContributor = await identity(); await membership(bareContributor.actorId, 'CONTRIBUTOR', []);
    expect(await service.removeProjectReviewer(owner, bareContributor.accountId, `bare-${randomUUID()}`))
      .toMatchObject({ changed: false });
    expect((await pool.query('SELECT scopes FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, bareContributor.actorId])).rows[0].scopes).toEqual([]);

    const inactive = await identity();
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',
      deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [inactive.actorId]);
    await expect(service.grantProjectReviewer(owner, inactive.accountId, `inactive-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Reviewer account is unavailable.' });
    const remoteInactive = await identity(); remotelyActive.delete(remoteInactive.actorId);
    await expect(service.grantProjectReviewer(owner, remoteInactive.accountId, `remote-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Reviewer account is unavailable.' });
    await expect(service.grantProjectReviewer(owner, randomUUID(), `missing-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Reviewer account is unavailable.' });

    const racing = await identity(); let releaseRemote!: () => void; let observedRemote!: () => void;
    const remoteReleased = new Promise<void>(resolve => { releaseRemote = resolve; });
    const remoteObserved = new Promise<void>(resolve => { observedRemote = resolve; });
    const racingService = createParticipationService(pool, { tokenSecret: `test-only-${'r'.repeat(48)}`, issuerActorId: issuer,
      isActorActive: async actorId => {
        if (actorId === racing.actorId) { observedRemote(); await remoteReleased; }
        return remotelyActive.has(actorId);
      } });
    const racingGrant = racingService.grantProjectReviewer(owner, racing.accountId, `race-${randomUUID()}`);
    await remoteObserved;
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',
      deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [racing.actorId]);
    releaseRemote();
    await expect(racingGrant).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Reviewer account is unavailable.' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',
      [projectId, racing.actorId])).rows[0].count).toBe(0);

    const revoked = await identity(); await membership(revoked.actorId, 'CONTRIBUTOR', ['external:claim']);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',
      [projectId, revoked.actorId]);
    await expect(service.grantProjectReviewer(owner, revoked.accountId, `revoked-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const steward = await identity(); await membership(steward.actorId, 'STEWARD');
    await expect(service.grantProjectReviewer(owner, steward.accountId, `steward-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.projectReviewers(steward.actorId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const supporter = await identity(); await membership(supporter.actorId, 'SUPPORTER', ['support:retained']);
    expect(await service.grantProjectReviewer(owner, supporter.accountId, `supporter-${randomUUID()}`))
      .toMatchObject({ changed: true });

    await expect(service.grantProjectReviewer(owner, ownerId, `self-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const outsider = await identity(); await membership(outsider.actorId, 'CONTRIBUTOR');
    const callsBeforeOutsider = remoteCalls.length;
    await expect(service.grantProjectReviewer(outsider.actorId, randomUUID(), `forged-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(remoteCalls.length).toBe(callsBeforeOutsider);

    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',
      deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [owner]);
    await expect(service.grantProjectReviewer(owner, fresh.accountId, key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 20_000);
});
