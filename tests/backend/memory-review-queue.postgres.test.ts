import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { createHypothesisSubmissionAdmissionService,
  createHypothesisSubmissionDeliveryService } from '../../server/research-memory/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const vaultKey = Buffer.alloc(32, 41);
const apiBaseUrl = 'https://engine.invalid/api/v1';

function localDatabaseUrls(raw: string, databaseName: string) {
  let source: URL;
  try { source = new URL(raw); } catch { throw new Error('MOTIVE_TEST_DATABASE_URL must be a valid local PostgreSQL URL.'); }
  const currentDatabase = decodeURIComponent(source.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !['127.0.0.1', 'localhost'].includes(source.hostname)
    || source.search || source.hash || !currentDatabase
    || ['motive_app_local', 'motive_test'].includes(currentDatabase)) {
    throw new Error('MOTIVE_TEST_DATABASE_URL must name an isolated-safe local PostgreSQL database without URL overrides.');
  }
  const admin = new URL(source); admin.pathname = '/postgres';
  const isolated = new URL(source); isolated.pathname = `/${databaseName}`;
  return { admin: admin.toString(), isolated: isolated.toString() };
}

describe('memory review queue database URL boundary', () => {
  it('rejects remote, malformed, shared, query-overridden, and fragment-bearing sources without reflecting them', () => {
    const samples = ['not a url', 'postgres://secret@db.example/motive_source',
      'postgres://user:secret@127.0.0.1/motive_test', 'postgres://user:secret@127.0.0.1/source?host=db.example',
      'postgres://user:secret@127.0.0.1/source#override'];
    for (const sample of samples) {
      let message = ''; try { localDatabaseUrls(sample, `motive_memory_queue_${randomUUID().replaceAll('-', '')}`); }
      catch (error) { message = error instanceof Error ? error.message : ''; }
      expect(message).toMatch(/^MOTIVE_TEST_DATABASE_URL must/); expect(message).not.toContain(sample);
      expect(message).not.toContain('secret');
    }
  });
});

pgDescribe('shared-memory admission queue on isolated PostgreSQL', () => {
  const databaseName = `motive_memory_queue_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:${randomUUID()}`;
  const owner = `account:${randomUUID()}`;
  const reviewer = `account:${randomUUID()}`;
  const active = new Set([owner, reviewer]);
  let admin: Pool | undefined; let pool: Pool | undefined; let databaseCreated = false;
  let participation: ParticipationService; let projectId: string; let workOrderId: string; let scopeId: string;
  let witness: string;
  let admission: ReturnType<typeof createHypothesisSubmissionAdmissionService>;
  let engineCalls = 0;

  beforeAll(async () => {
    const urls = localDatabaseUrls(baseUrl!, databaseName);
    admin = new Pool({ connectionString: urls.admin, max: 1, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
    await admin.query(`CREATE DATABASE ${databaseName}`); databaseCreated = true;
    pool = new Pool({ connectionString: urls.isolated, max: 8, statement_timeout: 30_000,
      query_timeout: 35_000, connectionTimeoutMillis: 10_000 });
    await applyPostgresMigrations(pool); expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Memory review queue test' } })).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [owner, owner.slice(8), reviewer, reviewer.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$5),($4,$2,$6,'REVIEWER',ARRAY['project:review'],$5)`,
    [randomUUID(), projectId, owner, randomUUID(), issuer, reviewer]);
    participation = createParticipationService(pool, { tokenSecret: `memory-queue-${'s'.repeat(48)}`,
      issuerActorId: issuer, isActorActive: actorId => active.has(actorId) });
    workOrderId = (await participation.ensureCircleWorkOrder()).id;
    witness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8'); scopeId = randomUUID();
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,
      'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [scopeId, projectId, apiBaseUrl, randomUUID(), randomUUID(), `sha256:${'a'.repeat(64)}`,
      encryptSecret(vaultKey, `he_${'f'.repeat(43)}`, `research-scope:v1:${scopeId}:${projectId}`),
      `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, '7'.repeat(40), owner]);
    const delivery = createHypothesisSubmissionDeliveryService({ pool, vaultKey,
      isActorActive: actorId => active.has(actorId), fetch: async () => { engineCalls += 1; throw new Error('Engine must not be called.'); } });
    admission = createHypothesisSubmissionAdmissionService({ pool, vaultKey,
      isActorActive: actorId => active.has(actorId), sender: delivery });
  }, 45_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        if (databaseCreated) {
          await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
          await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
          expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount).toBe(0);
        }
      } finally { await admin.end(); }
    }
  });

  async function setSubmissionClock(value: string) {
    await pool!.query(`ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT '${value}'::timestamptz`);
  }

  async function completed(label: string, options: { contributor?: string; investigation?: boolean;
    postCheck?: boolean; completion?: boolean } = {}) {
    const contributor = options.contributor ?? `account:${randomUUID()}`;
    active.add(contributor);
    await pool!.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()) ON CONFLICT DO NOTHING`, [contributor, contributor.slice(8)]);
    const joined = await participation.join(contributor, `Contributor ${label}`,
      { projectSlug: 'circle-packing', publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await participation.authenticateBearer(joined.token);
    const claim = await participation.claimAssignment(context, workOrderId, `claim-${randomUUID()}`);
    if (claim.leaseEpoch === null) throw new Error('Claim lease is missing.');
    const hasInvestigation = options.investigation !== false;
    if (hasInvestigation) await participation.declareAssignmentIntent(context, workOrderId, {
      leaseEpoch: claim.leaseEpoch, proposal: `Pre-test ${label} proposal.`, expectation: `Pre-test ${label} expectation.`,
      conditions: ['Use the frozen checker.'],
    }, `intent-${randomUUID()}`);
    const investigation = hasInvestigation ? { format: 'motive.investigation.v1' as const,
      proposal: `Final ${label} proposal.`, expectation: `Final ${label} expectation.`, conditions: ['Use the frozen checker.'],
      observations: ['The immutable witness was checked.'], assessment: 'The result is bounded to this experiment.',
      nextAction: 'Independent shared-memory review.' } : undefined;
    const submission = await participation.submitWitness(context, workOrderId,
      { leaseEpoch: claim.leaseEpoch, witness, ...(investigation ? { investigation } : {}) }, `submit-${randomUUID()}`);
    const report = await pool!.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1', [submission.id]);
    if (options.postCheck !== false) await participation.createPostCheckAssessment(context, submission.id, {
      reportDigest: String(report.rows[0].report_digest), assessment: 'The exact checker result is ready for independent review.',
      nextAction: 'Assess whether this package belongs in shared memory.',
    }, `post-${randomUUID()}`);
    if (options.completion !== false) await participation.completeAssignment(context, workOrderId,
      { leaseEpoch: claim.leaseEpoch, submissionId: submission.id }, `complete-${randomUUID()}`);
    return { submissionId: submission.id, contributor, tokenId: joined.credential.id };
  }

  async function foreignSubmissionCursor(sourceSubmissionId: string) {
    const foreignProject = (await new LedgerKernel(pool!).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: `foreign-${randomUUID()}`, visibility: 'PUBLIC', revisionContent: { title: 'Foreign cursor' } })).id;
    const workId = randomUUID(), claimId = randomUUID(), tokenId = randomUUID(), submissionId = randomUUID();
    await pool!.query(`INSERT INTO motive.work_orders(id,project_id,work_order_key,revision,project_revision,terms_format,terms,terms_digest,created_by)
      SELECT $1,$2,'foreign-work',revision,1,terms_format,terms,terms_digest,$3 FROM motive.work_orders WHERE id=$4`,
    [workId, foreignProject, issuer, workOrderId]);
    await pool!.query(`INSERT INTO motive.participation_agent_tokens(id,project_id,owner_actor_id,agent_name,public_display_name,
      token_digest,token_hint,license_acceptance_ref,expires_at) VALUES($1,$2,$3,'Foreign agent','Foreign contributor',$4,$5,'foreign-test',clock_timestamp()+interval '1 day')`,
    [tokenId, foreignProject, `account:${randomUUID()}`, `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0')}`, tokenId.replaceAll('-', '').slice(0, 12)]);
    const source = (await pool!.query('SELECT terms_digest FROM motive.work_orders WHERE id=$1', [workId])).rows[0];
    await pool!.query(`INSERT INTO motive.work_claims(id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at,released_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'RELEASED',clock_timestamp()+interval '1 hour',clock_timestamp())`,
    [claimId, foreignProject, workId, `agent:${tokenId}`, source.terms_digest]);
    await pool!.query(`INSERT INTO motive.submissions(id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,
      lease_epoch,format,base_commit,artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      SELECT $1,$2,$3,1,'EXTERNAL',$4,$5,1,'motive.submission/0.1',base_commit,artifact_manifest_digest,provenance,
        'unmetered_external','foreign-test',status FROM motive.submissions WHERE id=$6`,
    [submissionId, foreignProject, workId, `agent:${tokenId}`, claimId, sourceSubmissionId]);
    await pool!.query(`INSERT INTO motive.participation_submission_artifacts(submission_id,project_id,agent_token_id,witness_format,
      witness_bytes,witness_digest,report,report_body,report_digest,exact_score,exceeds_reference,contributor_display_name)
      SELECT $1,$2,$3,witness_format,witness_bytes,witness_digest,report,report_body,report_digest,exact_score,exceeds_reference,
        'Foreign contributor' FROM motive.participation_submission_artifacts WHERE submission_id=$4`,
    [submissionId, foreignProject, tokenId, sourceSubmissionId]);
    return submissionId;
  }

  it('pages initial evaluator-ready admissions before delivery and preserves a reviewed cursor without side effects', async () => {
    const eligible: Awaited<ReturnType<typeof completed>>[] = [];
    try {
      for (let index = 0; index < 19; index += 1) {
        await setSubmissionClock(new Date(Date.parse('2030-01-01T00:00:00.000Z') - index * 1000).toISOString());
        eligible.push(await completed(`eligible-${index}`));
      }
      await setSubmissionClock('2029-01-01T00:00:00.123456Z');
      eligible.push(await completed('eligible-tie-a'), await completed('eligible-tie-b'));
    } finally { await pool!.query('ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT clock_timestamp()'); }
    const tied = [eligible[19]!, eligible[20]!].sort((left, right) => right.submissionId.localeCompare(left.submissionId));
    const tieCount = await pool!.query('SELECT count(*)::int count FROM motive.submissions WHERE id=ANY($1::uuid[]) AND created_at=$2',
      [[tied[0].submissionId, tied[1].submissionId], '2029-01-01T00:00:00.123456Z']);
    expect(tieCount.rows[0].count).toBe(2);

    let incomplete: Awaited<ReturnType<typeof completed>>, noPostCheck: Awaited<ReturnType<typeof completed>>,
      noInvestigation: Awaited<ReturnType<typeof completed>>, selfA: Awaited<ReturnType<typeof completed>>,
      selfB: Awaited<ReturnType<typeof completed>>;
    try {
      await setSubmissionClock('2031-01-01T00:00:05.000001Z'); incomplete = await completed('incomplete', { completion: false });
      await setSubmissionClock('2031-01-01T00:00:04.000001Z'); noPostCheck = await completed('no-post-check', { postCheck: false });
      await setSubmissionClock('2031-01-01T00:00:03.000001Z'); noInvestigation = await completed('no-investigation', { investigation: false });
      await setSubmissionClock('2031-01-01T00:00:02.000001Z'); selfA = await completed('self-a', { contributor: reviewer });
      await setSubmissionClock('2031-01-01T00:00:01.000001Z'); selfB = await completed('self-b', { contributor: reviewer });
    } finally { await pool!.query('ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT clock_timestamp()'); }

    const retired = eligible[0]!;
    await pool!.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1', [retired.tokenId]);
    await pool!.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',
      [projectId, retired.contributor]);
    active.delete(retired.contributor);

    const writeCounts = async () => (await pool!.query(`SELECT
      (SELECT count(*)::int FROM motive.hypothesis_writeback_intents) intents,
      (SELECT count(*)::int FROM motive.hypothesis_submission_deliveries) deliveries,
      (SELECT count(*)::int FROM motive.hypothesis_submission_delivery_operations) operations`)).rows[0];
    const before = await writeCounts(); const callsBefore = engineCalls;
    const first = await participation.memoryReviewQueue(reviewer);
    expect(first.format).toBe('motive.research-journal-page/0.1'); expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe(tied[0].submissionId); expect(await writeCounts()).toEqual(before);
    expect(engineCalls).toBe(callsBefore);
    expect(first.items.map(item => item.submission.id)).toContain(retired.submissionId);
    for (const item of first.items) expect(item.update).toMatchObject({ completed: true, assessmentTiming: 'AFTER_CHECK',
      memoryReview: { latestDecision: null, hasEngineRecords: false } });
    const excluded = [incomplete, noPostCheck, noInvestigation, selfA, selfB].map(item => item.submissionId);
    expect(first.items.some(item => excluded.includes(item.submission.id))).toBe(false);
    expect(JSON.stringify(first)).not.toContain(reviewer);

    const preview = await admission.prepareAdmissionPreview(reviewer, first.nextCursor!);
    await admission.decideAdmission(reviewer, first.nextCursor!, { packageDigest: preview.packageDigest,
      expectedDecisionId: null, decision: 'ADMIT', rationale: 'This exact package is useful shared research.' },
    `review-cursor-${randomUUID()}`);
    expect(engineCalls).toBe(callsBefore);
    const second = await participation.memoryReviewQueue(reviewer, first.nextCursor!);
    expect(second.items.map(item => item.submission.id)).toEqual([tied[1].submissionId]);
    expect(second.nextCursor).toBeNull();
    const refreshed = await participation.memoryReviewQueue(reviewer);
    expect(refreshed.items.map(item => item.submission.id)).not.toContain(tied[0].submissionId);

    await expect(participation.memoryReviewQueue(reviewer, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const foreignCursor = await foreignSubmissionCursor(eligible[1]!.submissionId);
    await expect(participation.memoryReviewQueue(reviewer, foreignCursor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 180_000);

  it('requires current local, external, and project reviewer authority', async () => {
    const contributor = `account:${randomUUID()}`; active.add(contributor);
    await pool!.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [contributor, contributor.slice(8)]);
    await pool!.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'CONTRIBUTOR',ARRAY['external:claim','external:submit'],$4)`, [randomUUID(), projectId, contributor, issuer]);
    await expect(participation.memoryReviewQueue(contributor)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    active.delete(reviewer);
    await expect(participation.memoryReviewQueue(reviewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    active.add(reviewer);
    const localInactive = `account:${randomUUID()}`, revoked = `account:${randomUUID()}`;
    active.add(localInactive); active.add(revoked);
    await pool!.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,deletion_requested_at,created_at) VALUES
      ($1,'supabase',$2,'DELETION_PENDING',clock_timestamp(),clock_timestamp()),
      ($3,'supabase',$4,'ACTIVE',NULL,clock_timestamp())`, [localInactive, localInactive.slice(8), revoked, revoked.slice(8)]);
    await pool!.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by,revoked_at) VALUES
      ($1,$2,$3,'REVIEWER',ARRAY['project:review'],$6,NULL),
      ($4,$2,$5,'REVIEWER',ARRAY['project:review'],$6,clock_timestamp())`,
    [randomUUID(), projectId, localInactive, randomUUID(), revoked, issuer]);
    await expect(participation.memoryReviewQueue(localInactive)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(participation.memoryReviewQueue(revoked)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 30_000);
});
