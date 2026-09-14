import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';
import type { DeclareAssignmentIntentInput } from '../../src/lib/participation.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const tokenSecret = 'claim-intent-test-secret-longer-than-thirty-two-bytes';
const input = (leaseEpoch: number, proposal = 'Test whether a bounded perturbation improves the current baseline.'):
  DeclareAssignmentIntentInput => ({ leaseEpoch, proposal,
    expectation: 'The protected checker will report a larger exact score.',
    conditions: ['Use the current work-order terms.', 'Compare with the frozen reference.'] });
const finalInvestigation = (proposal: string) => ({ format: 'motive.investigation.v1' as const, proposal,
  expectation: 'The protected checker will report the exact outcome.', conditions: ['Use the current work-order terms.'],
  observations: ['The protected checker returned a report.'], assessment: 'The result is bounded to this candidate.',
  nextAction: 'Choose another test after reviewing the report.' });
const protocol = (purpose: ExperimentProtocol['purpose'] = 'EXPLORATORY', seed = '17'): ExperimentProtocol => ({
  format: 'motive.experiment-protocol.v1', procedure: 'claim-intent-test/v1',
  inputs: [{ name: 'seed', value: seed }, { name: 'limit.seconds', value: '30' }], purpose });

pgDescribe('participation claim intents on isolated PostgreSQL', () => {
  const databaseName = `motive_claim_intent_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:claim-intent-${randomUUID()}`;
  let admin: Pool; let pool: Pool; let service: ParticipationService; let assignmentId: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Claim intent test' } });
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end(); }
  });

  async function participant(name = 'Intent researcher', publish = true) {
    const owner = `account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
    const joined = await service.join(owner, name, { projectSlug: 'circle-packing', publishDisplayName: publish,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    return { owner, joined, context, claim };
  }

  it('records one private-citation-capable declaration, replays it, and publishes only bounded consented fields', async () => {
    const fixture = await participant(); const body = input(fixture.claim.leaseEpoch!); const key = `intent-${randomUUID()}`;
    const first = await service.declareAssignmentIntent(fixture.context, assignmentId, body, key);
    expect(first.intent).toMatchObject({ claimId: fixture.claim.claimId, leaseEpoch: 1, workOrderRevision: 1,
      proposal: body.proposal, expectation: body.expectation, conditions: body.conditions, declaredAt: expect.any(String) });
    expect(await service.declareAssignmentIntent(fixture.context, assignmentId, body, key)).toEqual(first);
    await expect(service.declareAssignmentIntent(fixture.context, assignmentId,
      { ...body, proposal: 'Changed under the same key.' }, key)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await service.declareAssignmentIntent(fixture.context, assignmentId, body, `recover-${randomUUID()}`)).intent)
      .toEqual(first.intent);
    await expect(service.declareAssignmentIntent(fixture.context, assignmentId,
      { ...body, proposal: 'A different immutable plan.' }, `changed-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const publicState = await service.publicProjection();
    expect(publicState.activeResearchIntents).toContainEqual(expect.objectContaining({ assignmentId,
      claimId: fixture.claim.claimId, agentName: fixture.joined.credential.agentName,
      contributorDisplayName: 'Intent researcher', proposal: body.proposal, expiresAt: expect.any(String) }));
    const serialized = JSON.stringify(publicState.activeResearchIntents);
    expect(serialized).not.toContain(fixture.owner); expect(serialized).not.toContain(fixture.joined.credential.id);
    expect(publicState.activity).toContainEqual(expect.objectContaining({ type: 'ASSIGNMENT_INTENT_DECLARED' }));

    const race = await participant('Concurrent researcher');
    const outcomes = await Promise.allSettled([
      service.declareAssignmentIntent(race.context, assignmentId, input(race.claim.leaseEpoch!, 'Concurrent plan A.'), `race-a-${randomUUID()}`),
      service.declareAssignmentIntent(race.context, assignmentId, input(race.claim.leaseEpoch!, 'Concurrent plan B.'), `race-b-${randomUUID()}`),
    ]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(item => item.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect((await pool.query('SELECT count(*)::integer AS count FROM motive.participation_claim_intents WHERE claim_id=$1',
      [race.claim.claimId])).rows[0].count).toBe(1);
  }, 30_000);

  it('serializes declaration against submission so no intent can be recorded retrospectively', async () => {
    const fixture = await participant('Race researcher'); const declared = input(fixture.claim.leaseEpoch!, 'Race declaration.');
    const results = await Promise.allSettled([
      service.declareAssignmentIntent(fixture.context, assignmentId, declared, `intent-race-${randomUUID()}`),
      service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!,
        witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
        investigation: finalInvestigation('Final notes for the concurrent submission.') }, `submit-race-${randomUUID()}`),
    ]);
    expect(results[1]?.status).toBe('fulfilled');
    const stored = await pool.query(`SELECT intent.created_at AS intent_created_at,submission.created_at AS submission_created_at
      FROM motive.submissions submission LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=submission.claim_id
      WHERE submission.claim_id=$1`, [fixture.claim.claimId]);
    expect(stored.rowCount).toBe(1);
    if (results[0]?.status === 'fulfilled') {
      expect(stored.rows[0].intent_created_at).not.toBeNull();
      expect(new Date(stored.rows[0].intent_created_at).getTime()).toBeLessThanOrEqual(new Date(stored.rows[0].submission_created_at).getTime());
    } else {
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
      expect(stored.rows[0].intent_created_at).toBeNull();
    }
  }, 20_000);

  it('rejects stale, foreign, revoked, inactive, removed, expired, released, and post-submission authority', async () => {
    const stale = await participant();
    await expect(service.declareAssignmentIntent(stale.context, assignmentId, input(stale.claim.leaseEpoch! + 1),
      `stale-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });
    const forged: ParticipationAgentContext = { ...stale.context, tokenId: randomUUID() };
    await expect(service.declareAssignmentIntent(forged, assignmentId, input(stale.claim.leaseEpoch!),
      `foreign-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const submitted = await participant();
    await service.submitWitness(submitted.context, assignmentId, { leaseEpoch: submitted.claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}' }, `submit-${randomUUID()}`);
    await expect(service.declareAssignmentIntent(submitted.context, assignmentId, input(submitted.claim.leaseEpoch!),
      `late-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const revoked = await participant(); await service.declareAssignmentIntent(revoked.context, assignmentId,
      input(revoked.claim.leaseEpoch!), `before-revoke-${randomUUID()}`);
    await service.revokeToken(revoked.owner, revoked.joined.credential.id, `revoke-${randomUUID()}`);
    await expect(service.declareAssignmentIntent(revoked.context, assignmentId, input(revoked.claim.leaseEpoch!),
      `revoked-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const inactive = await participant(); await service.declareAssignmentIntent(inactive.context, assignmentId,
      input(inactive.claim.leaseEpoch!), `before-inactive-${randomUUID()}`);
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',
      deletion_requested_at=clock_timestamp() WHERE actor_id=$1`, [inactive.owner]);
    await expect(service.declareAssignmentIntent(inactive.context, assignmentId, input(inactive.claim.leaseEpoch!),
      `inactive-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const removed = await participant(); await service.declareAssignmentIntent(removed.context, assignmentId,
      input(removed.claim.leaseEpoch!), `before-removed-${randomUUID()}`);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE actor_id=$1', [removed.owner]);
    await expect(service.declareAssignmentIntent(removed.context, assignmentId, input(removed.claim.leaseEpoch!),
      `removed-${randomUUID()}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const expired = await participant(); await service.declareAssignmentIntent(expired.context, assignmentId,
      input(expired.claim.leaseEpoch!), `before-expiry-${randomUUID()}`);
    await pool.query(`UPDATE motive.work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.claim.claimId]);
    const future = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      now: () => new Date(Date.now() + 16 * 60 * 1000) });
    await expect(future.declareAssignmentIntent(expired.context, assignmentId, input(expired.claim.leaseEpoch!),
      `expired-${randomUUID()}`)).rejects.toMatchObject({ code: 'EXPIRED' });
    const released = await participant(); await service.declareAssignmentIntent(released.context, assignmentId,
      input(released.claim.leaseEpoch!), `before-release-${randomUUID()}`);
    await service.releaseAssignment(released.context, assignmentId,
      { leaseEpoch: released.claim.leaseEpoch! }, `release-${randomUUID()}`);
    await expect(service.declareAssignmentIntent(released.context, assignmentId, input(released.claim.leaseEpoch!),
      `released-${randomUUID()}`)).rejects.toMatchObject({ code: 'CONFLICT' });
    const activeClaimIds = new Set((await service.publicProjection()).activeResearchIntents?.map(item => item.claimId));
    for (const claimId of [revoked.claim.claimId, inactive.claim.claimId, removed.claim.claimId, expired.claim.claimId, released.claim.claimId]) {
      expect(activeClaimIds.has(claimId!)).toBe(false);
    }
    expect((await pool.query(`SELECT count(*)::integer AS count FROM motive.participation_claim_intents
      WHERE claim_id=ANY($1::uuid[])`, [[revoked.claim.claimId, inactive.claim.claimId, removed.claim.claimId,
        expired.claim.claimId, released.claim.claimId]])).rows[0].count).toBe(5);
  }, 40_000);

  it('retains the initial declaration across renew, final investigation, completion, and a later claim', async () => {
    const fixture = await participant('Historical researcher'); const initial = input(fixture.claim.leaseEpoch!, 'Initial plan.');
    await service.declareAssignmentIntent(fixture.context, assignmentId, initial, `intent-${randomUUID()}`);
    const renewed = await service.renewAssignment(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch! }, `renew-${randomUUID()}`);
    expect(renewed.intent?.proposal).toBe('Initial plan.');
    await expect(service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}' }, `missing-notes-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const final = finalInvestigation('Final investigation differs from the initial plan.');
    const submission = await service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}', investigation: final }, `submit-${randomUUID()}`);
    await service.completeAssignment(fixture.context, assignmentId,
      { leaseEpoch: fixture.claim.leaseEpoch!, submissionId: submission.id }, `complete-${randomUUID()}`);
    expect((await service.getMe(fixture.owner)).assignments[0]?.intent?.proposal).toBe('Initial plan.');
    expect(await service.publicInvestigation(submission.id)).toMatchObject({ investigation: { proposal: final.proposal },
      claimIntent: { claimId: fixture.claim.claimId, proposal: 'Initial plan.' } });
    expect((await service.publicProjection()).activeResearchIntents).not.toContainEqual(expect.objectContaining({ claimId: fixture.claim.claimId }));

    const next = await service.claimAssignment(fixture.context, assignmentId, `next-claim-${randomUUID()}`);
    expect(next.claimId).not.toBe(fixture.claim.claimId); expect(next.leaseEpoch).toBe(2); expect(next.intent).toBeNull();
    await service.declareAssignmentIntent(fixture.context, assignmentId, input(next.leaseEpoch!, 'Second claim plan.'), `next-intent-${randomUUID()}`);
    expect((await pool.query(`SELECT count(*)::integer AS count FROM motive.participation_claim_intents
      WHERE agent_token_id=$1`, [fixture.joined.credential.id])).rows[0].count).toBe(2);
    await expect(pool.query('UPDATE motive.participation_claim_intents SET proposal=$2 WHERE claim_id=$1',
      [fixture.claim.claimId, 'rewrite'])).rejects.toThrow(/immutable/i);
  }, 30_000);

  it('holds current-account authority through citation validation without exhausting a two-connection pool', async () => {
    const fixture = await participant('Lock researcher'); let entered!: () => void; let resume!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const resumePromise = new Promise<void>(resolve => { resume = resolve; });
    const guarded = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      validateResearchContext: async (_project, _context, client) => { await client.query('SELECT 1'); entered(); await resumePromise; } });
    const body = { ...input(fixture.claim.leaseEpoch!), researchContext: { scopeId: randomUUID(), snapshotId: randomUUID(),
      snapshotDigest: `sha256:${'a'.repeat(64)}` } };
    const declaring = guarded.declareAssignmentIntent(fixture.context, assignmentId, body, `lock-${randomUUID()}`);
    await enteredPromise;
    let accountChanged = false;
    const changing = pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
      WHERE actor_id=$1`, [fixture.owner]).then(() => { accountChanged = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(accountChanged).toBe(false);
    resume(); await declaring; await changing; expect(accountChanged).toBe(true);
    expect((await pool.query('SELECT count(*)::integer AS count FROM motive.participation_claim_intents WHERE claim_id=$1',
      [fixture.claim.claimId])).rows[0].count).toBe(1);
  }, 20_000);

  it('does not present paused work as active research while preserving raw active-assignment history', async () => {
    const fixture = await participant('Paused researcher');
    await service.declareAssignmentIntent(fixture.context, assignmentId, input(fixture.claim.leaseEpoch!), `pause-${randomUUID()}`);
    await pool.query(`UPDATE motive.work_order_states SET state='PAUSED',state_revision=state_revision+1,updated_at=clock_timestamp()
      WHERE work_order_id=$1`, [assignmentId]);
    try {
      const projection = await service.publicProjection();
      expect(projection.activeAssignments).toBeGreaterThan(0);
      expect(projection.loopProgress?.activeAgents).toBe(0);
      expect(projection.activeResearchIntents).toEqual([]);
    } finally {
      await pool.query(`UPDATE motive.work_order_states SET state='READY',state_revision=state_revision+1,updated_at=clock_timestamp()
        WHERE work_order_id=$1`, [assignmentId]);
    }
  });

  it('returns bounded exact protocol matches without reserving replication or losing historical plans', async () => {
    const fixtures: Awaited<ReturnType<typeof participant>>[] = [];
    for (let index = 0; index < 22; index += 1) {
      const fixture = await participant(`Protocol researcher ${index}`);
      const declared = { ...input(fixture.claim.leaseEpoch!, `Protocol plan ${index}.`),
        experimentProtocol: { ...protocol(index === 1 ? 'CONTROL' : 'EXPLORATORY'),
          inputs: [...protocol().inputs].reverse() } };
      await service.declareAssignmentIntent(fixture.context, assignmentId, declared, `protocol-${index}-${randomUUID()}`);
      fixtures.push(fixture);
    }
    await pool.query('ALTER TABLE motive.participation_claim_intents DISABLE TRIGGER participation_claim_intents_immutable');
    try {
      await pool.query(`UPDATE motive.participation_claim_intents SET created_at='2026-09-09T12:34:56.123456Z'
        WHERE claim_id=ANY($1::uuid[])`, [fixtures.map(item => item.claim.claimId)]);
    } finally {
      await pool.query('ALTER TABLE motive.participation_claim_intents ENABLE TRIGGER participation_claim_intents_immutable');
    }
    const completed = fixtures[1]!;
    await expect(service.submitWitness(completed.context, assignmentId, {
      leaseEpoch: completed.claim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: finalInvestigation('Missing declared protocol.'),
    }, `protocol-omitted-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.submitWitness(completed.context, assignmentId, {
      leaseEpoch: completed.claim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: { ...finalInvestigation('Changed declared protocol.'), experimentProtocol: protocol('CONTROL', '18') },
    }, `protocol-changed-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    const completedSubmission = await service.submitWitness(completed.context, assignmentId, {
      leaseEpoch: completed.claim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: { ...finalInvestigation('Completed protocol plan.'), experimentProtocol: protocol('CONTROL') },
    }, `protocol-submit-${randomUUID()}`);
    await service.completeAssignment(completed.context, assignmentId,
      { leaseEpoch: completed.claim.leaseEpoch!, submissionId: completedSubmission.id }, `protocol-complete-${randomUUID()}`);
    const released = fixtures[2]!;
    await service.releaseAssignment(released.context, assignmentId,
      { leaseEpoch: released.claim.leaseEpoch!, stopReason: 'Stopped after the frozen input became unavailable.' }, `protocol-release-${randomUUID()}`);
    await pool.query(`UPDATE motive.work_claims SET status='EXPIRED',expires_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`, [fixtures[3]!.claim.claimId]);

    const first = await service.experimentProtocolMatches(fixtures[0]!.context,
      { ...protocol('REPLICATION'), inputs: [...protocol().inputs].reverse() });
    expect(first.experimentProtocol.inputs.map(item => item.name)).toEqual(['limit.seconds', 'seed']);
    expect(first.matches).toHaveLength(20); expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.experimentProtocolMatches(fixtures[0]!.context, protocol('REPLICATION'), first.nextCursor!);
    expect(second.matches).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const matches = [...first.matches, ...second.matches];
    expect(new Set(matches.map(item => item.claimId)).size).toBe(22);
    expect(matches.find(item => item.claimId === completed.claim.claimId)).toMatchObject({ status: 'COMPLETED',
      purpose: 'CONTROL', proposal: 'Protocol plan 1.', submission: { submissionId: completedSubmission.id } });
    expect(matches.find(item => item.claimId === released.claim.claimId)).toMatchObject({ status: 'RELEASED',
      stopReason: 'Stopped after the frozen input became unavailable.' });
    expect(matches.find(item => item.claimId === fixtures[3]!.claim.claimId)).toMatchObject({ status: 'EXPIRED' });
    expect((await service.experimentProtocolMatches(fixtures[0]!.context, protocol('EXPLORATORY', '18'))).matches).toEqual([]);
    await expect(service.experimentProtocolMatches(fixtures[0]!.context, protocol('EXPLORATORY', '18'), first.nextCursor!))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const posthoc = await participant('Posthoc protocol researcher');
    await service.declareAssignmentIntent(posthoc.context, assignmentId,
      input(posthoc.claim.leaseEpoch!, 'Plan without a structured protocol.'), `posthoc-intent-${randomUUID()}`);
    await expect(service.submitWitness(posthoc.context, assignmentId, {
      leaseEpoch: posthoc.claim.leaseEpoch!, witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',
      investigation: { ...finalInvestigation('Attempted posthoc protocol.'), experimentProtocol: protocol() },
    }, `posthoc-submit-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    const old = await pool.query(`SELECT experiment_protocol,protocol_fingerprint FROM motive.participation_claim_intents
      WHERE experiment_protocol IS NULL LIMIT 1`);
    expect(old.rows[0]).toEqual({ experiment_protocol: null, protocol_fingerprint: null });
  }, 90_000);
});
