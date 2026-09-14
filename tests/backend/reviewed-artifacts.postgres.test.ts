import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService, ParticipationError, type ParticipationAgentContext,
  type ParticipationService } from '../../server/participation/index.ts';
import { createHypothesisSubmissionAdmissionService, createHypothesisSubmissionDeliveryService,
  type HypothesisSubmissionAdmissionService, type HypothesisSubmissionDeliveryService } from '../../server/research-memory/index.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const apiBase = 'https://engine.invalid/api/v1';
const vaultKey = Buffer.alloc(32, 23);
const tokenSecret = `reviewed-artifacts-${'s'.repeat(48)}`;

type Participant = { actor: string; context: ParticipationAgentContext; membershipId: string };
type Admitted = { submissionId: string; witnessDigest: string; rationale: string; reviewId: string };

pgDescribe('public contributor reviewed artifacts on isolated PostgreSQL', () => {
  const databaseName = `motive_reviewed_artifacts_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:reviewed-artifacts-${randomUUID()}`;
  const owner = `account:${randomUUID()}`; const reviewer = `account:${randomUUID()}`;
  const active = new Set([owner, reviewer]);
  let admin: Pool; let pool: Pool; let testUrl: string; let projectId: string; let workOrderId: string;
  let scopeId: string; let witnessSeed = 0; let engineCalls = 0;
  let participation: ParticipationService; let delivery: HypothesisSubmissionDeliveryService;
  let admission: HypothesisSubmissionAdmissionService; let referenceWitness: string;
  let retainedContributorId = '';

  beforeAll(async () => {
    const source = new URL(baseUrl!); expect(['localhost', '127.0.0.1']).toContain(source.hostname);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated = new URL(source); isolated.pathname = `/${databaseName}`; testUrl = isolated.toString();
    pool = new Pool({ connectionString: testUrl, max: 16 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Reviewed artifact history test' } })).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [owner, owner.slice(8), reviewer, reviewer.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$5),($4,$2,$6,'STEWARD',ARRAY['project:review'],$5)`,
    [randomUUID(), projectId, owner, randomUUID(), issuer, reviewer]);
    participation = createParticipationService(pool, { tokenSecret, issuerActorId: issuer });
    workOrderId = (await participation.ensureCircleWorkOrder()).id;
    referenceWitness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    scopeId = await insertScope('1');
    delivery = createHypothesisSubmissionDeliveryService({ pool, vaultKey, isActorActive: actor => active.has(actor),
      fetch: async () => { engineCalls += 1; throw new Error('Engine must not be called by reviewed-artifact history tests.'); },
      timeoutMs: 1_000 });
    admission = createHypothesisSubmissionAdmissionService({ pool, vaultKey,
      isActorActive: actor => active.has(actor), sender: delivery });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  async function insertScope(seed: string, status = 'CONNECTED') {
    const id = randomUUID(); const apiKey = `he_${seed.repeat(43)}`;
    const encrypted = encryptSecret(vaultKey, apiKey, `research-scope:v1:${id}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,$12,$11,clock_timestamp())`,
    [id, projectId, apiBase, randomUUID(), randomUUID(), `sha256:${seed.repeat(64)}`, encrypted,
      `sha256:${seed.repeat(64)}`, `sha256:${seed.repeat(64)}`, seed.repeat(40), owner, status]);
    return id;
  }

  async function participant(name: string, publish: boolean, actor = `account:${randomUUID()}`): Promise<Participant> {
    active.add(actor);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()) ON CONFLICT(actor_id) DO NOTHING`, [actor, actor.slice(8)]);
    const joined = await participation.join(actor, name, { projectSlug: 'circle-packing', publishDisplayName: publish,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await participation.authenticateBearer(joined.token);
    await participation.claimAssignment(context, workOrderId, `claim-${randomUUID()}`);
    const membership = await pool.query('SELECT id::text FROM motive.memberships WHERE project_id=$1 AND actor_id=$2', [projectId, actor]);
    return { actor, context, membershipId: String(membership.rows[0].id) };
  }

  async function submit(current: Participant, witness?: string) {
    const serial = witnessSeed++; const body = witness ?? referenceWitness.replace(/\s*}\s*$/, `,"reviewed_artifact_seed":${serial}}`);
    const result = await participation.submitWitness(current.context, workOrderId, { leaseEpoch: 1, witness: body,
      investigation: { format: 'motive.investigation.v1', proposal: `Retain bounded artifact ${serial}.`,
        expectation: 'The protected checker records the exact submitted bytes.', conditions: ['Use the frozen checker.'],
        observations: ['A deterministic test artifact was submitted.'], assessment: 'Review remains independent.',
        nextAction: 'Inspect the exact retained report.' } }, `submit-${randomUUID()}`);
    const report = await pool.query(`SELECT report_digest,witness_digest FROM motive.participation_submission_artifacts
      WHERE submission_id=$1`, [result.id]);
    await participation.createPostCheckAssessment(current.context, result.id, { reportDigest: String(report.rows[0].report_digest),
      assessment: 'The checked artifact remains bounded public evidence.', nextAction: 'Apply an independent retention decision.' },
    `post-${randomUUID()}`);
    return { submissionId: result.id, witness: body, witnessDigest: String(report.rows[0].witness_digest).slice(7) };
  }

  async function prepare(submissionId: string, selectedScope = scopeId) {
    await delivery.sync(owner, { projectSlug: 'circle-packing', scopeId: selectedScope, submissionId,
      idempotencyKey: `prepare-${randomUUID()}`, approvedApiBaseUrl: apiBase,
      contract: PINNED_REVIEWED_WRITEBACK_CONTRACT, execute: false });
  }

  async function decide(submissionId: string, decision: 'ADMIT' | 'DECLINE', label: string): Promise<Admitted> {
    const preview = await admission.prepareAdmissionPreview(reviewer, submissionId);
    const rationale = `${label} public admission rationale.`;
    const saved = await admission.decideAdmission(reviewer, submissionId, { packageDigest: preview.packageDigest,
      expectedDecisionId: preview.latestDecision?.id ?? null, decision, rationale }, `review-${randomUUID()}`);
    const artifact = await pool.query('SELECT witness_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1', [submissionId]);
    return { submissionId, witnessDigest: String(artifact.rows[0].witness_digest).slice(7), rationale, reviewId: saved.id };
  }

  it('returns stable deduplicated admitted history while retaining named history across corrections and retirement', async () => {
    const contributorActor = `account:${randomUUID()}`;
    const first = await participant('Named history contributor', true, contributorActor); retainedContributorId = first.membershipId;
    const second = await participant('Renamed history contributor', true, contributorActor);
    const admitted: Admitted[] = []; const source: Array<{ submissionId: string; witness: string; witnessDigest: string }> = [];
    for (let index = 0; index < 23; index += 1) {
      const current = index < 12 ? first : second; const made = await submit(current); source.push(made);
      await prepare(made.submissionId); admitted.push(await decide(made.submissionId, 'ADMIT', `artifact-${index}`));
    }

    // A correction on the same delivery removes that submission from the retained set.
    await decide(source[2]!.submissionId, 'DECLINE', 'corrected-decline');
    // Duplicate digests collapse to the representative carrying the newest qualifying review.
    const duplicate = await submit(second, source[0]!.witness); await prepare(duplicate.submissionId);
    const duplicateAdmission = await decide(duplicate.submissionId, 'ADMIT', 'newest-duplicate');
    // A DECLINE on one duplicate does not erase a different submission's qualifying ADMIT.
    await decide(source[0]!.submissionId, 'DECLINE', 'declined-original-duplicate');

    // Replacing the connected scope retains old reviews while allowing a newer delivery chain.
    const replacementScopeId = await insertScope('2', 'REPLACEMENT_PENDING');
    const oldScopeId = scopeId; const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE motive.project_research_scopes
        SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1`, [oldScopeId, replacementScopeId]);
      await client.query(`UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1`, [replacementScopeId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    scopeId = replacementScopeId;
    // A newer delivery without a decision does not erase an older ADMIT.
    await prepare(source[3]!.submissionId);
    // A newer delivery decision across scopes does replace the older delivery's ADMIT.
    await prepare(source[1]!.submissionId); await decide(source[1]!.submissionId, 'DECLINE', 'new-delivery-decline');

    const privateSameOwner = await participant('Hidden rotation', false, contributorActor);
    const hidden = await submit(privateSameOwner); await prepare(hidden.submissionId); await decide(hidden.submissionId, 'ADMIT', 'private-row');
    const other = await participant('Other named contributor', true);
    const otherRow = await submit(other); await prepare(otherRow.submissionId); await decide(otherRow.submissionId, 'ADMIT', 'other-person');
    const privateOnly = await participant('Private-only contributor', false);
    const privateOnlyRow = await submit(privateOnly); await prepare(privateOnlyRow.submissionId);
    await decide(privateOnlyRow.submissionId, 'ADMIT', 'private-only');

    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp()
      WHERE owner_actor_id=$1 AND project_id=$2`, [contributorActor, projectId]);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE id=$1', [first.membershipId]);

    const collected: Awaited<ReturnType<ParticipationService['publicContributorReviewedArtifacts']>>['items'] = [];
    const sizes: number[] = []; let after: string | undefined;
    do {
      const page = await participation.publicContributorReviewedArtifacts(first.membershipId, after);
      expect(page).toMatchObject({ format: 'motive.contributor-reviewed-artifacts/0.1', projectSlug: 'circle-packing',
        contributorId: first.membershipId });
      sizes.push(page.items.length); collected.push(...page.items); after = page.nextCursor ?? undefined;
    } while (after);
    expect(sizes).toEqual([20, 1]); expect(collected).toHaveLength(21);
    expect(collected.map(item => item.witnessDigest)).toEqual([...collected.map(item => item.witnessDigest)].sort());
    expect(new Set(collected.map(item => item.witnessDigest)).size).toBe(21);
    expect(collected.find(item => item.witnessDigest === source[0]!.witnessDigest)).toMatchObject({
      submissionId: duplicate.submissionId, review: { id: duplicateAdmission.reviewId, decision: 'ADMIT',
        rationale: duplicateAdmission.rationale } });
    expect(collected.find(item => item.witnessDigest === source[3]!.witnessDigest)).toMatchObject({
      submissionId: source[3]!.submissionId, review: { id: admitted[3]!.reviewId, decision: 'ADMIT',
        rationale: admitted[3]!.rationale } });
    expect(collected.some(item => item.submissionId === source[1]!.submissionId)).toBe(false);
    expect(collected.some(item => item.submissionId === source[2]!.submissionId)).toBe(false);
    expect(collected.some(item => item.submissionId === hidden.submissionId || item.submissionId === otherRow.submissionId)).toBe(false);
    for (const item of collected) {
      expect(Object.keys(item).sort()).toEqual(['agentName', 'review', 'submissionId', 'submittedAt', 'witnessDigest']);
      expect(Object.keys(item.review).sort()).toEqual(['decision', 'id', 'rationale', 'reviewedAt']);
    }
    expect(JSON.stringify(collected)).not.toContain(contributorActor);
    const aggregate = (await participation.publicProjection()).contributors.find(item => item.id === first.membershipId);
    expect(aggregate?.reviewedArtifactCount).toBe(collected.length);
    expect((await participation.publicContributorReviewedArtifacts(first.membershipId, 'f'.repeat(64))).items).toEqual([]);
    expect(engineCalls).toBe(0);

    const foreignProjectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: `foreign-${randomUUID()}`, visibility: 'PUBLIC', revisionContent: { title: 'Foreign contributor' } })).id;
    const foreignMembershipId = randomUUID();
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'CONTRIBUTOR',ARRAY['external:claim','external:submit'],$4)`,
    [foreignMembershipId, foreignProjectId, other.actor, issuer]);
    for (const id of [randomUUID(), privateOnly.membershipId, foreignMembershipId]) {
      await expect(participation.publicContributorReviewedArtifacts(String(id))).rejects
        .toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<ParticipationError>);
    }
    for (const cursor of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${'a'.repeat(64)}`]) {
      await expect(participation.publicContributorReviewedArtifacts(first.membershipId, cursor)).rejects
        .toMatchObject({ code: 'VALIDATION' } satisfies Partial<ParticipationError>);
    }
    await expect(participation.publicContributorReviewedArtifacts(first.membershipId.toUpperCase())).rejects
      .toMatchObject({ code: 'VALIDATION' } satisfies Partial<ParticipationError>);
  }, 120_000);

  it('keeps the public page query count fixed', async () => {
    const countedPool = new Pool({ connectionString: testUrl, max: 1 }); let queries = 0;
    const instrumented = new WeakSet<PoolClient>(); const connect = countedPool.connect.bind(countedPool);
    Object.defineProperty(countedPool, 'connect', { value: async () => {
      const client = await connect(); const query = client.query.bind(client);
      if (!instrumented.has(client)) {
        client.query = ((...args: unknown[]) => { queries += 1;
          return (query as unknown as (...values: unknown[]) => unknown)(...args); }) as PoolClient['query'];
        instrumented.add(client);
      }
      return client;
    } });
    try {
      const counted = createParticipationService(countedPool, { tokenSecret, issuerActorId: issuer });
      expect((await counted.publicContributorReviewedArtifacts(retainedContributorId)).items).toHaveLength(20);
      expect(queries).toBe(5);
    } finally { await countedPool.end(); }
  }, 30_000);
});
