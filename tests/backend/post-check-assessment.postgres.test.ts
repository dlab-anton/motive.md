import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('post-check assessments on isolated PostgreSQL', () => {
  const databaseName = `motive_post_check_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:post-check-${randomUUID()}`;
  let admin: Pool;
  let pool: Pool;
  let service: ParticipationService;
  let assignmentId: string;

  beforeAll(async () => {
    const adminUrl = new URL(baseUrl!);
    adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl!);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Post-check assessment test' } });
    service = createParticipationService(pool, { tokenSecret: 'post-check-test-secret-that-is-longer-than-thirty-two-bytes',
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

  async function rejectedSubmission(owner = `account:${randomUUID()}`) {
    await activate(owner);
    const joined = await service.join(owner, 'Post-check tester', { projectSlug: 'circle-packing', publishDisplayName: true,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    const submission = await service.submitWitness(context, assignmentId, { leaseEpoch: claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}' }, `submit-${randomUUID()}`);
    await service.completeAssignment(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, submissionId: submission.id },
      `complete-${randomUUID()}`);
    const report = await service.publicReport(submission.id);
    return { owner, joined, context, submission, reportDigest: String(report.reportDigest) };
  }

  it('appends one agent-declared assessment after a completed rejected candidate and discovers it publicly without changing evidence or acceptance', async () => {
    const fixture = await rejectedSubmission();
    await service.reviewSubmission(issuer, fixture.submission.id,
      { decision: 'REJECTED', rationale: 'Retain the negative protected-check result.' }, `review-${randomUUID()}`);
    const before = await pool.query(`SELECT submission.provenance,submission.status,artifact.witness_digest,artifact.report_digest,
      artifact.report_body,review.decision FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id WHERE submission.id=$1`,
    [fixture.submission.id]);
    const originalDigest = digestCanonicalJson(before.rows[0]);
    const input = { reportDigest: fixture.reportDigest,
      assessment: 'The protected check rejected the empty candidate, so the construction does not meet the required witness shape.',
      nextAction: 'Generate exactly 101 positive-radius circles and submit a new candidate under a new claim.' };
    const key = `assess-${randomUUID()}`;
    const [first, replay] = await Promise.all([
      service.createPostCheckAssessment(fixture.context, fixture.submission.id, input, key),
      service.createPostCheckAssessment(fixture.context, fixture.submission.id, input, key),
    ]);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ submissionId: fixture.submission.id, reportDigest: fixture.reportDigest,
      assessment: input.assessment, nextAction: input.nextAction, disposition: 'AGENT_DECLARED_UNVERIFIED',
      attribution: { kind: 'AGENT_DECLARED', credentialId: fixture.joined.credential.id,
        agentName: fixture.joined.credential.agentName, contributorDisplayName: 'Post-check tester' } });
    expect(first.notice).toContain('do not indicate support or acceptance');
    expect(await service.createPostCheckAssessment(fixture.context, fixture.submission.id, input, `recover-${randomUUID()}`)).toEqual(first);
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id,
      { ...input, nextAction: 'Try a different next action.' }, key)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id,
      { ...input, assessment: 'A changed immutable interpretation.' }, `changed-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const discovered = await service.publicPostCheckAssessment(fixture.submission.id);
    expect(discovered).toEqual(first);
    const projection = await service.publicProjection();
    expect(projection.submissions.find(item => item.id === fixture.submission.id)?.postCheckAssessmentHref)
      .toBe(`/api/public/projects/circle-packing/submissions/${fixture.submission.id}/post-check-assessment`);
    const after = await pool.query(`SELECT submission.provenance,submission.status,artifact.witness_digest,artifact.report_digest,
      artifact.report_body,review.decision FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id WHERE submission.id=$1`,
    [fixture.submission.id]);
    expect(digestCanonicalJson(after.rows[0])).toBe(originalDigest);
    expect(projection.submissions.find(item => item.id === fixture.submission.id)?.acceptance).toBe('REJECTED');
    expect(projection.activity).toContainEqual(expect.objectContaining({ type: 'SUBMISSION_ASSESSED',
      submissionId: fixture.submission.id, contributorDisplayName: 'Post-check tester' }));
    expect(await pool.query('SELECT count(*)::integer AS count FROM motive.participation_post_check_assessments WHERE submission_id=$1',
      [fixture.submission.id])).toMatchObject({ rows: [{ count: 1 }] });
    expect((await pool.query(`SELECT request_digest,public_question,public_finding FROM motive.participation_post_check_assessments WHERE submission_id=$1`,[fixture.submission.id])).rows[0])
      .toEqual({request_digest:digestCanonicalJson({submissionId:fixture.submission.id,...input}),public_question:null,public_finding:null});
    await expect(pool.query('UPDATE motive.participation_post_check_assessments SET assessment=$2 WHERE submission_id=$1',
      [fixture.submission.id, 'Mutation is forbidden.'])).rejects.toThrow(/immutable/i);
    await expect(pool.query('DELETE FROM motive.participation_post_check_assessments WHERE submission_id=$1',
      [fixture.submission.id])).rejects.toThrow(/immutable/i);
  }, 20_000);

  it('retains an optional one-paragraph public summary in the immutable report-bound record',async()=>{
    const fixture=await rejectedSubmission();const publicSummary={question:'Did the checked candidate satisfy the circle-packing objective?',finding:'The protected checker rejected this candidate, so it did not establish an improvement.'};
    const input={reportDigest:fixture.reportDigest,assessment:'The protected report is retained as bounded evidence.',nextAction:'Try a structurally complete candidate.',publicSummary};const key=`summary-${randomUUID()}`;
    const first=await service.createPostCheckAssessment(fixture.context,fixture.submission.id,input,key);
    expect(first).toMatchObject({submissionId:fixture.submission.id,publicSummary,disposition:'AGENT_DECLARED_UNVERIFIED'});
    expect(await service.createPostCheckAssessment(fixture.context,fixture.submission.id,input,key)).toEqual(first);
    await expect(service.createPostCheckAssessment(fixture.context,fixture.submission.id,{...input,publicSummary:{...publicSummary,finding:'A different public finding.'}},key)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(service.createPostCheckAssessment(fixture.context,fixture.submission.id,{...input,publicSummary:{...publicSummary,finding:'A different public finding.'}},`changed-${randomUUID()}`)).rejects.toMatchObject({code:'CONFLICT'});
    const stored=(await pool.query(`SELECT request_digest,public_question,public_finding FROM motive.participation_post_check_assessments WHERE submission_id=$1`,[fixture.submission.id])).rows[0];
    expect(stored).toEqual({request_digest:digestCanonicalJson({submissionId:fixture.submission.id,...input}),public_question:publicSummary.question,public_finding:publicSummary.finding});
    await expect(pool.query(`UPDATE motive.participation_post_check_assessments SET public_finding='Changed.' WHERE submission_id=$1`,[fixture.submission.id])).rejects.toThrow(/immutable/i);
  },20_000);

  it('rejects malformed summaries in the service and partial summary pairs in PostgreSQL',async()=>{
    const fixture=await rejectedSubmission();const base={reportDigest:fixture.reportDigest,assessment:'Bounded assessment.',nextAction:'Bounded next action.'};
    await expect(service.createPostCheckAssessment(fixture.context,fixture.submission.id,{...base,publicSummary:{question:'Two lines\nare forbidden.',finding:'Finding.'}},`invalid-${randomUUID()}`)).rejects.toMatchObject({code:'VALIDATION'});
    const direct=(question:string|null,finding:string|null)=>pool.query(`INSERT INTO motive.participation_post_check_assessments
      (submission_id,project_id,agent_token_id,report_digest,assessment,next_action,request_digest,public_question,public_finding)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[fixture.submission.id,fixture.context.projectId,fixture.joined.credential.id,fixture.reportDigest,
      base.assessment,base.nextAction,digestCanonicalJson({question,finding}),question,finding]);
    for(const [question,finding] of [['Question without a finding?',null],['Question?','line one\nline two'],['Question?','control\u0085text'],
      ['Question?','separator\u2028text'],['\u00a0Question?','Finding.'],['Question?','Finding.\u3000'],['😀'.repeat(181),'Finding.']] as const){
      await expect(direct(question,finding)).rejects.toThrow(/public_summary_shape/i);
    }
  },20_000);

  it('serializes concurrent different assessments so exactly one immutable body wins', async () => {
    const fixture = await rejectedSubmission();
    const base = { reportDigest: fixture.reportDigest, assessment: 'The protected checker rejected this candidate.' };
    const outcomes = await Promise.allSettled([
      service.createPostCheckAssessment(fixture.context, fixture.submission.id,
        { ...base, nextAction: 'Generate a complete witness.' }, `race-a-${randomUUID()}`),
      service.createPostCheckAssessment(fixture.context, fixture.submission.id,
        { ...base, nextAction: 'Recheck the candidate generator.' }, `race-b-${randomUUID()}`),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(await pool.query('SELECT count(*)::integer AS count FROM motive.participation_post_check_assessments WHERE submission_id=$1',
      [fixture.submission.id])).toMatchObject({ rows: [{ count: 1 }] });
  }, 20_000);

  it('rejects the wrong report, another credential, revoked authority, inactive accounts, and revoked membership', async () => {
    const fixture = await rejectedSubmission();
    const input = { reportDigest: fixture.reportDigest, assessment: 'The protected checker rejected this candidate.',
      nextAction: 'Prepare a structurally complete candidate.' };
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id,
      { ...input, reportDigest: `sha256:${'0'.repeat(64)}` }, `wrong-report-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const other = await service.join(fixture.owner, 'Other credential', { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const otherContext = await service.authenticateBearer(other.token);
    await expect(service.createPostCheckAssessment(otherContext, fixture.submission.id, input,
      `other-${randomUUID()}`)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await service.revokeToken(fixture.owner, fixture.joined.credential.id, `revoke-${randomUUID()}`);
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id, input,
      `revoked-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const inactive = await rejectedSubmission();
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
      WHERE actor_id=$1`, [inactive.owner]);
    await expect(service.createPostCheckAssessment(inactive.context, inactive.submission.id,
      { ...input, reportDigest: inactive.reportDigest }, `inactive-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const noMembership = await rejectedSubmission();
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE actor_id=$1 AND project_id=$2',
      [noMembership.owner, noMembership.context.projectId]);
    await expect(service.createPostCheckAssessment(noMembership.context, noMembership.submission.id,
      { ...input, reportDigest: noMembership.reportDigest }, `membership-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  }, 20_000);

  it('enforces exact bounded input and hides missing assessment resources', async () => {
    const fixture = await rejectedSubmission();
    await expect(service.publicPostCheckAssessment(fixture.submission.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const base = { reportDigest: fixture.reportDigest, assessment: 'Useful assessment.', nextAction: 'Useful next action.' };
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id,
      { ...base, assessment: ` ${base.assessment}` }, `whitespace-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.createPostCheckAssessment(fixture.context, fixture.submission.id,
      { ...base, nextAction: 'x'.repeat(1001) }, `large-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
  }, 20_000);
});
