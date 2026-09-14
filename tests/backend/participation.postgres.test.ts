import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationRouters, createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { createResearchMemoryService } from '../../server/research-memory/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('external participation lifecycle on isolated PostgreSQL', () => {
  const databaseName = `motive_participation_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let service: ParticipationService; let issuer: string; let assignmentId: string;
  const tokenSecret = `test-only-${'s'.repeat(48)}`;

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    issuer = `operator:participation-test-${randomUUID()}`;
    const project = await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Isolated circle test' } });
    expect(project.currentRevision).toBe(1);
    const researchMemory = createResearchMemoryService({ pool, vaultKey: Buffer.alloc(32, 7),
      fetch: async () => { throw new Error('Participation validation must not read upstream research.'); } });
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      validateResearchContext: researchMemory.assertContext.bind(researchMemory),
      validateResearchReferences: researchMemory.assertReferences.bind(researchMemory) });
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

  it('keeps tokens hashed, claims with fencing, stores exact immutable evidence, and accepts a checked non-improvement independently', async () => {
    const checkerBytes = await readFile('src/lib/circle-packing.ts');
    expect(createHash('sha256').update(checkerBytes).digest('hex')).toBe('a2f9904fe0359edda76b41b6c840b2ff219288c9cb8671d85376c1b1c0693559');
    expect((await service.publicProjection()).bestChecked).toBeNull();
    const owner = `account:${randomUUID()}`; const joinKey = `join-${randomUUID()}`;
    
    const joined = await service.join(owner, 'Visible Tester', { projectSlug: 'circle-packing',
      publishDisplayName: true, acceptReferenceTerms: true }, joinKey);
    expect(joined.assignment).toMatchObject({ id: assignmentId, credentialId: joined.credential.id,
      status: 'AVAILABLE', claimId: null });
    expect(joined.credential).toMatchObject({ agentName: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/),
      modelName: null, lastSeenAt: null });
    expect(joined.token).toMatch(/^motive_agent_/);
    const stored = await pool.query('SELECT token_digest,owner_actor_id FROM motive.participation_agent_tokens WHERE id=$1', [joined.credential.id]);
    expect(JSON.stringify(stored.rows)).not.toContain(joined.token);
    expect(stored.rows[0].token_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const replay = await service.join(owner, 'Visible Tester', { projectSlug: 'circle-packing',
      publishDisplayName: true, acceptReferenceTerms: true }, joinKey);
    expect(replay.token).toBe(joined.token);
    expect(replay.credential.agentName).toBe(joined.credential.agentName);
    await expect(service.join(owner, 'Visible Tester', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, joinKey)).rejects.toMatchObject({ code: 'CONFLICT' });

    const context = await service.authenticateBearer(joined.token);
    const observed = await service.getAgentAssignment(context);
    expect(observed.credential).toMatchObject({ id: joined.credential.id, lastSeenAt: expect.any(String) });
    expect(observed.assignment.credentialId).toBe(joined.credential.id);
    const claimed = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    expect(claimed).toMatchObject({ credentialId: joined.credential.id, status: 'ACTIVE', leaseEpoch: 1 });
    const renewed = await service.renewAssignment(context, assignmentId, { leaseEpoch: 1 }, `renew-${randomUUID()}`);
    expect(renewed.leaseEpoch).toBe(1);
    const referenceWitness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    const weakerWitness = JSON.parse(referenceWitness) as { circles: Array<{ r: string }> };
    weakerWitness.circles[0]!.r = '0.06';
    const witness = JSON.stringify(weakerWitness);
    const submissionInput={leaseEpoch:1,witness};const submissionKey=`submit-${randomUUID()}`;
    const submission = await service.submitWitness(context, assignmentId, submissionInput, submissionKey);
    expect(submission).toMatchObject({ reportStatus: 'VALID', exactScore: '5.2827607400177646', exceedsReference: false,
      acceptance: 'PENDING', investigationHref: null });
    expect((await service.publicArtifact(submission.id)).bytes.toString('utf8')).toBe(witness);
    const report = await service.publicReport(submission.id);
    expect(report).toMatchObject({ reportStatus: 'VALID', binding: { submissionId: submission.id, workOrderId: assignmentId,
      leaseEpoch: 1, artifactDigest: submission.artifactSha256,
      checker: { sourceDigest: 'sha256:a2f9904fe0359edda76b41b6c840b2ff219288c9cb8671d85376c1b1c0693559' } } });
    expect(await service.completeAssignment(context, assignmentId, { leaseEpoch: 1, submissionId: submission.id }, `complete-${randomUUID()}`))
      .toMatchObject({ credentialId: joined.credential.id, status: 'COMPLETED' });
    expect((await service.getMe(owner)).assignments.find(item => item.credentialId === joined.credential.id))
      .toMatchObject({ status: 'COMPLETED' });
    const legacyEventId = randomUUID();
    const circleProject = await pool.query('SELECT project_id FROM motive.work_orders WHERE id=$1', [assignmentId]);
    await pool.query(`INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
      VALUES($1,$2,'work_claim',$3,'external.assignment_claimed',$4::jsonb,$5)`,
    [legacyEventId, circleProject.rows[0].project_id, randomUUID(), JSON.stringify({ contributor_id: joined.credential.id }), context.actorId]);

    const foreignEventId = randomUUID();
    const foreignProject = await new LedgerKernel(pool).createProject({ actorId: issuer,
      idempotencyKey: randomUUID(), slug: `foreign-${randomUUID()}`, visibility: 'PUBLIC',
      revisionContent: { title: 'Foreign isolated project' } });
    await pool.query(`INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
      VALUES($1,$2,'work_claim',$3,'external.assignment_claimed',$4::jsonb,$5)`,
    [foreignEventId, foreignProject.id, randomUUID(), JSON.stringify({ contributor_display_name: 'Foreign name' }), context.actorId]);

    await pool.query(`UPDATE motive.memberships SET role='OWNER' WHERE actor_id=$1`, [owner]);
    await expect(service.reviewSubmission(owner, submission.id, { decision: 'ACCEPTED', rationale: 'Self review is forbidden.' }, `review-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reviewer=`account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY[]::text[],$4)`,[randomUUID(),circleProject.rows[0].project_id,reviewer,issuer]);
    expect((await service.getMe(reviewer)).canReview).toBe(true);
    const reviewKey=`review-${randomUUID()}`;
    const reviewed = await service.reviewSubmission(reviewer, submission.id, { decision: 'ACCEPTED', rationale: 'Exact reference reproduction retained as checked evidence.' }, reviewKey);
    expect(reviewed.acceptance).toBe('ACCEPTED');
    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2`,
      [circleProject.rows[0].project_id,reviewer]);
    expect((await service.getMe(reviewer)).canReview).toBe(false);
    await expect(service.reviewSubmission(reviewer,submission.id,{decision:'ACCEPTED',rationale:'Exact reference reproduction retained as checked evidence.'},reviewKey))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    const publicState = await service.publicProjection();
    expect(publicState).toMatchObject({ totalSubmissions: 1, acceptedResults: 1 });
    expect(publicState.project.lifecycle).toBe('RESULTS_AVAILABLE');
    expect(publicState.bestChecked?.id).toBe(submission.id);
    expect(publicState.bestAccepted?.id).toBe(submission.id);
    const membership = await pool.query('SELECT id::text FROM motive.memberships WHERE project_id=$1 AND actor_id=$2', [circleProject.rows[0].project_id,owner]);
    expect(publicState.contributors).toEqual([expect.objectContaining({ id: membership.rows[0].id,displayName: 'Visible Tester', submissionCount: 1,
      reviewedArtifactCount:0,reviewedSubmissionIds:[],publicSubmissionIds:[submission.id] })]);
    expect(publicState.privateContributionCount).toBe(0);
    for (const type of ['ASSIGNMENT_CLAIMED', 'SUBMISSION_CHECKED', 'ASSIGNMENT_COMPLETED'] as const) {
      expect(publicState.activity).toContainEqual(expect.objectContaining({ type, contributorDisplayName: 'Visible Tester' }));
    }
    expect(publicState.activity).toContainEqual(expect.objectContaining({ id: legacyEventId,
      contributorDisplayName: 'Visible Tester' }));
    expect(publicState.activity.some(item => item.id === foreignEventId)).toBe(false);
    expect(JSON.stringify(publicState)).not.toContain(owner);
    const privateJoined=await service.join(owner,'Visible Tester',{projectSlug:'circle-packing',publishDisplayName:false,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const privateContext=await service.authenticateBearer(privateJoined.token);const privateClaim=await service.claimAssignment(privateContext,assignmentId,`claim-${randomUUID()}`);
    const privateSubmission=await service.submitWitness(privateContext,assignmentId,
      {leaseEpoch:privateClaim.leaseEpoch!,witness:referenceWitness},`submit-${randomUUID()}`);
    await service.completeAssignment(privateContext,assignmentId,{leaseEpoch:privateClaim.leaseEpoch!,submissionId:privateSubmission.id},`complete-${randomUUID()}`);
    const mixed=await service.publicProjection();const named=mixed.contributors.find(item=>item.id===membership.rows[0].id)!;
    expect(named).toMatchObject({displayName:'Visible Tester',submissionCount:1,publicSubmissionIds:[submission.id]});
    expect(named.publicSubmissionIds).not.toContain(privateSubmission.id);expect(mixed.privateContributionCount).toBe(1);
    expect(mixed.bestChecked).toMatchObject({id:privateSubmission.id,exactScore:'5.29109518547430697',acceptance:'PENDING'});
    expect(mixed.bestAccepted?.id).toBe(submission.id);

    const tieOwner=`account:${randomUUID()}`;
    const tieJoined=await service.join(tieOwner,'Tie Tester',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const tieContext=await service.authenticateBearer(tieJoined.token);
    const tieClaim=await service.claimAssignment(tieContext,assignmentId,`claim-${randomUUID()}`);
    const tieSubmission=await service.submitWitness(tieContext,assignmentId,
      {leaseEpoch:tieClaim.leaseEpoch!,witness:referenceWitness},`submit-${randomUUID()}`);
    await service.completeAssignment(tieContext,assignmentId,
      {leaseEpoch:tieClaim.leaseEpoch!,submissionId:tieSubmission.id},`complete-${randomUUID()}`);
    const expectedTieWinner=[privateSubmission,tieSubmission]
      .sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id))[0]!;
    const tied=await service.publicProjection();
    expect(tied.bestChecked?.id).toBe(expectedTieWinner.id);
    expect(tied.bestAccepted?.id).toBe(submission.id);
  }, 20_000);

  it('releases, revokes and rejoins without reviving an old token, and completes a rejected check as evidence', async () => {
    const owner = `account:${randomUUID()}`;
    
    const first = await service.join(owner, 'Private Tester', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const firstContext = await service.authenticateBearer(first.token);
    const claim = await service.claimAssignment(firstContext, assignmentId, `claim-${randomUUID()}`);
    expect(await service.releaseAssignment(firstContext, assignmentId, { leaseEpoch: claim.leaseEpoch! }, `release-${randomUUID()}`))
      .toMatchObject({ credentialId: first.credential.id, status: 'RELEASED' });
    expect((await service.getMe(owner)).assignments.find(item => item.credentialId === first.credential.id))
      .toMatchObject({ status: 'RELEASED' });
    const reclaimed = await service.claimAssignment(firstContext, assignmentId, `reclaim-${randomUUID()}`);
    expect(reclaimed).toMatchObject({ status: 'ACTIVE', leaseEpoch: 2 });
    await expect(service.renewAssignment(firstContext, assignmentId, { leaseEpoch: 1 }, `stale-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await service.revokeToken(owner, first.credential.id, `revoke-${randomUUID()}`);
    await expect(service.authenticateBearer(first.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const second = await service.join(owner, 'Private Tester', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const secondContext = await service.authenticateBearer(second.token);
    const secondClaim = await service.claimAssignment(secondContext, assignmentId, `claim-${randomUUID()}`);
    await expect(service.submitWitness(secondContext, assignmentId, { leaseEpoch: secondClaim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}', investigation: {
        format: 'motive.investigation.v1', proposal: '', expectation: 'No improvement expected.', conditions: ['Use the declared checker.'],
        observations: ['No local result.'], assessment: 'Incomplete.', nextAction: 'Submit a complete record.',
      } }, `invalid-investigation-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    const investigation = { format: 'motive.investigation.v1' as const,
      proposal: 'Test whether an empty coordinate list is accepted as an N=101 witness.',
      expectation: 'The protected checker should reject the candidate because it does not contain 101 circles.',
      conditions: ['Keep the witness in motive.csqv.witness.v1 format.', 'Use the current assignment lease epoch.'],
      observations: ['The protected checker returned a rejected report.', 'No exact objective was produced.'],
      assessment: 'The empty-list construction does not satisfy the declared witness shape; this interpretation remains agent-authored.',
      nextAction: 'Generate exactly 101 positive-radius circles before testing geometry.',
    };
    const scopeId = randomUUID();
    const emptySnapshot = { format: 'motive.research-context.v1', scopeId, projectSlug: 'circle-packing', channelName: 'circle-packing',
      channelGoal: 'Improve the frozen N=101 reference.', hypotheses: [], hypothesesTotal: 0, hypothesesTruncated: false,
      activeHypothesesTotal: 0, archivedHypothesesTotal: 0, insights: [], insightsTotal: 0, insightsTruncated: false,
      page: { activeOffset: 0, archivedOffset: 0, insightOffset: 0, activeLimit: 6, archivedLimit: 6, insightLimit: 20 } };
    const researchContext = { scopeId, snapshotId: randomUUID(), snapshotDigest: digestCanonicalJson(emptySnapshot) };
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,$11)`,[scopeId,secondContext.projectId,randomUUID(),randomUUID(),`sha256:${'e'.repeat(64)}`,
      Buffer.alloc(48,7),`sha256:${'f'.repeat(64)}`,`sha256:${'1'.repeat(64)}`,'7'.repeat(40),owner,new Date().toISOString()]);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',clock_timestamp())`,[researchContext.snapshotId,scopeId,secondContext.projectId,
      researchContext.snapshotDigest,JSON.stringify(emptySnapshot)]);
    await expect(service.submitWitness(secondContext, assignmentId, {
      leaseEpoch: secondClaim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: { ...investigation, researchReferences: [{ scopeId: randomUUID(), snapshotId: randomUUID(),
        snapshotDigest: `sha256:${'a'.repeat(64)}`, hypothesisId: randomUUID(), observedUpdatedAt: new Date().toISOString(), evidenceIds: [] }] },
    }, `unverified-research-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    const investigationWithContext = { ...investigation, researchContext };
    const rejected = await service.submitWitness(secondContext, assignmentId,
      { leaseEpoch: secondClaim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}', investigation: investigationWithContext }, `submit-${randomUUID()}`);
    expect(rejected).toMatchObject({ reportStatus: 'REJECTED', exactScore: null, exceedsReference: null,
      investigationHref: `/api/public/projects/circle-packing/submissions/${rejected.id}/investigation` });
    const publicInvestigation = await service.publicInvestigation(rejected.id);
    expect(publicInvestigation).toMatchObject({ submissionId: rejected.id,
      attribution: { kind: 'AGENT_DECLARED', agentName: second.credential.agentName, modelName: null },
      investigation: investigationWithContext, evidence: { reportStatus: 'REJECTED', exactScore: null }, interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' });
    const rejectedReport = await service.publicReport(rejected.id);
    expect(rejectedReport).toMatchObject({ reportStatus: 'REJECTED', report: {
      agentInvestigation: { attribution: { kind: 'AGENT_DECLARED' }, investigation: investigationWithContext }, result: { ok: false } } });
    expect(await service.completeAssignment(secondContext, assignmentId,
      { leaseEpoch: secondClaim.leaseEpoch!, submissionId: rejected.id }, `complete-${randomUUID()}`)).toMatchObject({ status: 'COMPLETED' });
    const privateState = await service.getMe(owner);
    const assignmentsByCredential = new Map(privateState.assignments.map(item => [item.credentialId, item]));
    expect(assignmentsByCredential.get(first.credential.id)).toMatchObject({ status: 'REVOKED' });
    expect(assignmentsByCredential.get(second.credential.id)).toMatchObject({ status: 'COMPLETED' });
    const publicState = await service.publicProjection();
    expect(publicState.contributors.some(item=>item.displayName==='Private Tester')).toBe(false);
    expect(publicState.privateContributionCount).toBe(2);
    const privateEvidence = publicState.activity.filter(item => item.submissionId === rejected.id);
    expect(privateEvidence).not.toHaveLength(0);
    expect(privateEvidence.every(item => item.contributorDisplayName === null)).toBe(true);
  }, 20_000);

  it('denies a still-unexpired token when its owning account is no longer active', async () => {
    const owner = `account:${randomUUID()}`;
    const joined = await service.join(owner, 'Deleted account', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const app = express();
    const { accountRouter, agentRouter } = createParticipationRouters({ service, isActorActive: actorId => actorId !== owner });
    app.use(express.json());
    app.use('/api/participation', (_req, res, next) => {
      res.locals.actorId = owner; res.locals.accountName = 'Deleted account'; next();
    }, accountRouter);
    app.use('/api/agent', agentRouter);
    const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind a TCP port.');
      const oldInput = await fetch(`http://127.0.0.1:${address.port}/api/participation/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `join-${randomUUID()}` },
        body: JSON.stringify({ projectSlug: 'circle-packing', agentName: 'Caller name', modelName: 'caller-model',
          publishDisplayName: false, acceptReferenceTerms: true }),
      });
      expect(oldInput.status).toBe(400);
      expect(await oldInput.json()).toMatchObject({ error: 'validation' });
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/assignment`,
        { headers: { Authorization: `Bearer ${joined.token}` } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    } finally { server.close(); await once(server, 'close'); }
  });
});
