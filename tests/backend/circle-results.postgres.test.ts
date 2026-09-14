import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import type { ImmutableObjectStore } from '../../packages/artifact-storage/src/types.ts';
import { canonicalJson, digestCanonicalJson, type Digest, type WorkOrderTerms } from '../../packages/domain/src/contracts.ts';
import { CIRCLE_EVALUATOR_PROFILE_DIGEST, circleByteDigest } from '../../packages/evaluator-circle/src/index.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { createCircleResultsService, CircleResultsError, type CircleResultsService } from '../../server/circle-results/index.ts';
import { createCircleResultsRouters } from '../../server/circle-results/router.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const referenceBytes = Buffer.from(await import('node:fs/promises').then(fs =>
  fs.readFile(new URL('../../public/projects/circle-packing/reference-witness.json', import.meta.url))));
const token = (path: string) => createHash('sha256').update(path).digest('hex');
const stream = (bytes: Uint8Array): AsyncIterable<Uint8Array> => (async function* () { yield Uint8Array.from(bytes); })();

pgDescribe('hosted circle results on isolated PostgreSQL', () => {
  const databaseName = `motive_circle_results_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let ledger: LedgerKernel; let store: PostgresOrchestrationStore; let service: CircleResultsService;
  const objects = new Map<string, Uint8Array>();
  const objectStore: Pick<ImmutableObjectStore, 'readObject'> = { async readObject(input) {
    const bytes = objects.get(input.objectKey); return bytes ? { body: stream(bytes), declaredBytes: bytes.byteLength } : null;
  } };

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`; pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool); expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool); store = new PostgresOrchestrationStore(pool);
    await ledger.setControllerSpending({ actorId: 'circle-result-test', idempotencyKey: randomUUID(), enabled: true, reason: 'isolated test database' });
    service = createCircleResultsService({ pool, objects: objectStore });
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end(); }
  });

  async function setup(candidateBytes: Buffer, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC', investigationBytes?: Buffer) {
    const researcher = `account:${randomUUID()}`; const reviewer = `account:${randomUUID()}`;
    const slug = `circle-result-${randomUUID()}`;
    const project = await ledger.createProject({ actorId: researcher, idempotencyKey: randomUUID(), slug, visibility,
      revisionContent: { title: 'Isolated hosted circle result' } });
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER','{}',$4)`, [randomUUID(), project.id, reviewer, researcher]);
    const source = await ledger.createFundingSource({ actorId: researcher, idempotencyKey: randomUUID(), authorizedAmount: '10', metadata: { test: true } });
    const grant = await ledger.createGrant({ actorId: researcher, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id,
      beneficiaryActorId: researcher, limitAmount: '5' });
    const inferenceProfileDigest = digestCanonicalJson(`inference:${project.id}`);
    const terms: WorkOrderTerms = { format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1,
      agreement_id: `agreement:${randomUUID()}`, objective: 'Check and retain one exact N=101 data witness.', input_commit: 'a'.repeat(40),
      allowed_effects: ['read-approved-inputs', 'write-isolated-workspace', 'submit-data-only-witness'],
      hosted: { enabled: true, inference: { currency: 'USD', ceiling: '2', profile_digest: inferenceProfileDigest }, maximum_runtime_seconds: 120 },
      external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
        late_submission_policy: 'reject', review_admission: 'manual',
        artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
      evaluation: { profile_digest: CIRCLE_EVALUATOR_PROFILE_DIGEST, human_acceptance_required: true } };
    const work = await ledger.createWorkOrder({ actorId: researcher, idempotencyKey: randomUUID(), projectId: project.id,
      workOrderKey: 'circle-hosted', revision: 1, terms, state: 'READY' });
    const attempt = await ledger.reserveAttempt({ actorId: researcher, idempotencyKey: randomUUID(), grantId: grant.id,
      workOrderId: work.id, ceilingAmount: '2', profileDigest: inferenceProfileDigest, inputDigest: digestCanonicalJson(`input:${project.id}`) });

    const connectionId = randomUUID(); const budgetId = randomUUID();
    await pool.query(`INSERT INTO motive.provider_connections
      (id,owner_actor_id,provider,credential_ref,status,encrypted_credential,credential_fingerprint,provider_metadata)
      VALUES($1,$2,'openrouter',$3,'CONNECTED',$4,$5,'{}')`, [connectionId, researcher, `openrouter:${randomUUID()}`,
      Buffer.from('encrypted-test-only'), digestCanonicalJson('credential')]);
    await pool.query(`INSERT INTO motive.provider_project_budgets
      (id,connection_id,owner_actor_id,project_id,source_id,grant_id,work_order_id,provider,model_id,limit_usd,status,
       idempotency_key,request_digest,beneficiary_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'openrouter','openai/gpt-6-astra',2,'ACTIVE',$8,$9,$3)`,
    [budgetId, connectionId, researcher, project.id, source.id, grant.id, work.id, randomUUID(), digestCanonicalJson('budget')]);
    await pool.query(`INSERT INTO motive.provider_budget_activations
      (budget_id,work_order_id,grant_id,attempt_id,profile_digest,idempotency_key,request_digest,status,beneficiary_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'AWAITING_DISPATCH',$8)`,
    [budgetId, work.id, grant.id, attempt.id, inferenceProfileDigest, randomUUID(), digestCanonicalJson('activation'), researcher]);

    const authorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: source.id,
      sourceAccountRef: `test:${source.id}`, actorId: researcher, limitUsd: '2', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const lease = await store.acquireLease(attempt.id, `circle-results:${randomUUID()}`, 300);
    const plan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: work.id, termsDigest: attempt.termsDigest,
      inputDigest: attempt.inputDigest, inferenceProfileDigest, actorId: researcher, infrastructureAuthorizationId: authorization.id,
      maximumCostUsd: '1', capabilityTtlSeconds: 120, command: { executable: '/usr/local/bin/codex', args: ['exec', 'fixture'] },
      sandbox: { format: 'motive.sandbox-profile/0.1', profileDigest: digestCanonicalJson('sandbox'),
        protectedRuntime: defineProtectedRuntime(digestCanonicalJson('runtime')),
        trustedSource: { kind: 'snapshot', snapshotId: 'snap_CircleResults1', sourceCommit: 'd'.repeat(40),
          materialDigest: digestCanonicalJson('source'), buildRecipeDigest: digestCanonicalJson('recipe') },
        timeoutMs: 120000, commandTimeoutMs: 60000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
        egress: { gateway: [{ url: 'https://gateway.example/v1', methods: ['POST'], pathMatch: 'exact' }], artifacts: [] },
        artifacts: { maxFiles: 2, maxFileBytes: 32768, maxTotalBytes: 65536 } } };
    const reserved = await store.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: plan.sandbox.profileDigest,
      profileSnapshot: plan.sandbox as unknown as Record<string, unknown>, launchPlanDigest: digestCanonicalJson(plan),
      infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1' });
    await store.claimEffect(lease, reserved.effect.effectId);
    await store.recordCreateResult(lease, reserved.effect.effectId, { provider: 'synthetic', externalId: `worker:${randomUUID()}`, sessionId: randomUUID() });
    await store.recordObservation(lease, reserved.environment.id, { providerStatus: 'running', providerTerminal: false, state: 'ACTIVE' });
    const prefix = `projects/${project.id}/attempts/${attempt.id}/seals/${reserved.environment.id}`;
    const candidateKey = `${prefix}/files/${token('candidate.json')}`;
    const investigationKey = `${prefix}/files/${token('investigation.json')}`;
    const files = [{ relative_path: 'candidate.json', media_type: 'application/json', availability: 'REQUIRED', bytes: candidateBytes.length,
      digest: circleByteDigest(candidateBytes), object_key: candidateKey },
    ...(investigationBytes ? [{ relative_path: 'investigation.json', media_type: 'application/json', availability: 'OPTIONAL_ON_FAILURE',
      bytes: investigationBytes.length, digest: circleByteDigest(investigationBytes), object_key: investigationKey }] : [])];
    const manifest = { format: 'motive.artifact-manifest/0.1', project_id: project.id, work_order_id: work.id,
      attempt_id: attempt.id, environment_id: reserved.environment.id, terms_digest: attempt.termsDigest, input_digest: attempt.inputDigest,
      inference_profile_digest: inferenceProfileDigest, sandbox_profile_digest: plan.sandbox.profileDigest,
      launch_plan_digest: digestCanonicalJson(plan), command_digest: digestCanonicalJson(plan.command),
      controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'worker-command', exitCode: 0 }, capture_status: 'COMPLETE',
      files, missing_files: [], total_bytes: candidateBytes.length + (investigationBytes?.length ?? 0),
      human_acceptance: { status: 'PENDING', decision_id: null } };
    const manifestBytes = Buffer.from(canonicalJson(manifest)); objects.set(`${prefix}/manifest.json`, manifestBytes); objects.set(candidateKey, candidateBytes);
    if (investigationBytes) objects.set(investigationKey, investigationBytes);
    const seal = await store.recordArtifactSeal(lease, reserved.environment.id, { manifestDigest: circleByteDigest(manifestBytes), receiptId: `receipt:${randomUUID()}` });
    const stop = await store.requestStop(lease, reserved.environment.id, { preserveEvaluation: true }); await store.claimEffect(lease, stop.effect.effectId);
    await store.recordStopResult(lease, stop.effect.effectId, { providerStatus: 'stopped', providerTerminal: true, state: 'TERMINATED' });
    return { researcher, reviewer, slug, project, work, attempt, seal, candidateKey, investigationKey };
  }

  const validInvestigation = () => Buffer.from(JSON.stringify({ format: 'motive.investigation.v1',
    proposal: 'Reproduce the frozen reference through the hosted run.', expectation: 'The exact score will match the reference.',
    conditions: ['Use the frozen N=101 work order and exact checker.'], observations: ['The numerical report matched the reference exactly.'],
    assessment: 'This run reproduced the baseline and did not improve it.', nextAction: 'Test one bounded geometric perturbation.' }));

  it('rejects NULL path and media metadata for a purported valid investigation', async () => {
    const client = await pool.connect();
    try {
      await client.query('CREATE TEMP TABLE hosted_investigation_constraint_probe (LIKE motive.hosted_circle_investigations INCLUDING CONSTRAINTS INCLUDING DEFAULTS)');
      await expect(client.query(`INSERT INTO hosted_investigation_constraint_probe
        (result_id,project_id,attempt_id,artifact_environment_id,artifact_manifest_digest,investigation_object_key,
         investigation_digest,investigation_bytes,investigation_body,status,validation_code,model_id,inference_profile_digest)
        VALUES($1,$2,$3,$4,$5,'private/object',$6,$7,$8::jsonb,'VALID','VALID','openai/gpt-6-astra',$9)`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), digestCanonicalJson('manifest'), circleByteDigest(validInvestigation()),
        validInvestigation(), validInvestigation().toString('utf8'), digestCanonicalJson('profile')])).rejects.toMatchObject({ code: '23514' });
    } finally { client.release(); }
  });

  it('concurrently retains one exact baseline result and accepts valid non-improvement independently', async () => {
    const f = await setup(referenceBytes);
    const [left, right] = await Promise.all([service.evaluateAttempt(f.attempt.id), service.evaluateAttempt(f.attempt.id)]);
    expect(left.id).toBe(right.id);
    expect(left).toMatchObject({ status: 'VALID', exactScore: '5.29109518547430697', exceedsReference: false,
      artifactAvailable: true, model: { id: 'openai/gpt-6-astra' } });
    expect((await pool.query('SELECT count(*)::int AS count FROM motive.hosted_circle_results WHERE attempt_id=$1', [f.attempt.id])).rows[0].count).toBe(1);
    const publicBefore = await service.publicResults(f.slug); expect(publicBefore).toMatchObject({ totalResults: 1, acceptedResults: 0, bestAccepted: null });
    const report = await service.publicReport(left.id); expect(report.report).toMatchObject({ outcome: 'VALID', result: { ok: true,
      report: { official: false, objective: { exact_decimal: '5.29109518547430697' } } } });
    expect(Buffer.from((await service.publicArtifact(left.id)).bytes)).toEqual(referenceBytes);
    const expected = { attemptId: left.attemptId, artifactManifestDigest: left.artifactManifestDigest,
      evaluationProfileDigest: left.evaluationProfileDigest, reportDigest: left.reportDigest };
    await expect(service.review(f.researcher, left.id, { decision: 'ACCEPTED', rationale: 'self review', expected }, randomUUID()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const key = randomUUID(); const accepted = await service.review(f.reviewer, left.id,
      { decision: 'ACCEPTED', rationale: 'Exact report and frozen baseline checked.', expected }, key);
    expect((await service.review(f.reviewer, left.id,
      { decision: 'ACCEPTED', rationale: 'Exact report and frozen baseline checked.', expected }, key)).id).toBe(accepted.id);
    const publicAfter = await service.publicResults(f.slug);
    expect(publicAfter).toMatchObject({ acceptedResults: 1, bestAccepted: { id: left.id, review: { decision: 'ACCEPTED' } } });
  });

  it('retains exact rejection while withholding malformed worker-controlled bytes from public download', async () => {
    const secret = 'OPENROUTER_API_KEY_should-never-be-public';
    const malformed = Buffer.from(`{"format":"motive.csqv.witness.v1","n":101,"circles":[],"${secret}":1,"${secret}":2}`);
    const f = await setup(malformed); const result = await service.evaluateAttempt(f.attempt.id);
    expect(result).toMatchObject({ status: 'REJECTED', exactScore: null, exceedsReference: null, artifactAvailable: false });
    const report = await service.publicReport(result.id);
    expect(JSON.stringify(report)).not.toContain(secret); expect(report.report.result).toMatchObject({ ok: false, error: { code: 'DUPLICATE_KEY' } });
    await expect(service.publicArtifact(result.id)).rejects.toMatchObject({ code: 'ARTIFACT_UNAVAILABLE' });
    const expected = { attemptId: result.attemptId, artifactManifestDigest: result.artifactManifestDigest,
      evaluationProfileDigest: result.evaluationProfileDigest, reportDigest: result.reportDigest };
    await expect(service.review(f.reviewer, result.id, { decision: 'ACCEPTED', rationale: 'must fail', expected }, randomUUID()))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('retains validated hosted notes concurrently while keeping their interpretation separate from acceptance', async () => {
    const f = await setup(referenceBytes, 'PUBLIC', validInvestigation());
    const [left, right] = await Promise.all([service.evaluateAttempt(f.attempt.id), service.evaluateAttempt(f.attempt.id)]);
    expect(left.id).toBe(right.id); expect(left.investigation).toMatchObject({ status: 'VALID' });
    const notes = await service.publicInvestigation(left.id);
    expect(notes).toMatchObject({ status: 'VALID', validationCode: 'VALID', interpretationStatus: 'AGENT_DECLARED_UNVERIFIED',
      binding: { attemptId: f.attempt.id, artifactManifestDigest: left.artifactManifestDigest,
        investigationDigest: circleByteDigest(validInvestigation()), model: { id: 'openai/gpt-6-astra' } },
      investigation: { format: 'motive.investigation.v1', proposal: 'Reproduce the frozen reference through the hosted run.' } });
    expect(notes).not.toHaveProperty('review');
    expect((await pool.query('SELECT count(*)::int AS count FROM motive.hosted_circle_investigations WHERE result_id=$1', [left.id])).rows[0].count).toBe(1);
  });

  it('retains malformed notes privately and distinguishes invalid retained research references', async () => {
    const secret = 'OPENROUTER_API_KEY_notes-private';
    const malformed = Buffer.from(`{"format":"motive.investigation.v1","proposal":"${secret}","proposal":"duplicate"}`);
    const malformedFixture = await setup(referenceBytes, 'PUBLIC', malformed);
    const malformedResult = await service.evaluateAttempt(malformedFixture.attempt.id);
    expect(malformedResult.investigation.status).toBe('INVALID');
    const publicMalformed = await service.publicInvestigation(malformedResult.id);
    expect(publicMalformed).toMatchObject({ status: 'INVALID', validationCode: 'INVALID_STRUCTURE', investigation: null });
    expect(JSON.stringify(publicMalformed)).not.toContain(secret);
    const retained = await pool.query('SELECT investigation_bytes FROM motive.hosted_circle_investigations WHERE result_id=$1', [malformedResult.id]);
    expect(Buffer.from(retained.rows[0].investigation_bytes)).toEqual(malformed);

    const referenceNotes = JSON.parse(validInvestigation().toString('utf8')) as Record<string, unknown>;
    referenceNotes.researchReferences = [{ scopeId: randomUUID(), snapshotId: randomUUID(), snapshotDigest: digestCanonicalJson('snapshot'),
      hypothesisId: randomUUID(), observedUpdatedAt: new Date().toISOString(), evidenceIds: [] }];
    const referenceFixture = await setup(referenceBytes, 'PUBLIC', Buffer.from(JSON.stringify(referenceNotes)));
    const referenceResult = await service.evaluateAttempt(referenceFixture.attempt.id);
    await expect(service.publicInvestigation(referenceResult.id)).resolves.toMatchObject({ status: 'INVALID',
      validationCode: 'INVALID_REFERENCE', interpretationStatus: 'INVALID_REFERENCE', investigation: null });
  });

  it('keeps retained PostgreSQL projections available without object storage', async () => {
    const privateFixture = await setup(referenceBytes, 'PRIVATE'); const privateResult = await service.evaluateAttempt(privateFixture.attempt.id);
    await expect(service.publicResults(privateFixture.slug)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.publicReport(privateResult.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const f = await setup(referenceBytes); const result = await service.evaluateAttempt(f.attempt.id);
    const withoutStorage = createCircleResultsService({ pool, objects: null });
    expect((await withoutStorage.publicResults(f.slug)).results[0].id).toBe(result.id);
    expect((await withoutStorage.publicReport(result.id)).reportDigest).toBe(result.reportDigest);
    await expect(withoutStorage.evaluateAttempt(f.attempt.id)).rejects.toBeInstanceOf(CircleResultsError);
    await expect(withoutStorage.publicArtifact(result.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('keeps public bytes safe and review authority in the live account session', async () => {
    const validFixture = await setup(referenceBytes); const valid = await service.evaluateAttempt(validFixture.attempt.id);
    const secret = 'OPENROUTER_API_KEY_route-private';
    const malformedFixture = await setup(Buffer.from(`{"format":"motive.csqv.witness.v1","n":101,"circles":[],"${secret}":1,"${secret}":2}`));
    const malformed = await service.evaluateAttempt(malformedFixture.attempt.id);
    const active = new Set([validFixture.researcher, validFixture.reviewer]);
    const { publicRouter, accountRouter } = createCircleResultsRouters(service, actor => active.has(actor));
    const app = express(); app.use(express.json());
    app.use('/public', publicRouter);
    app.use('/account', (req, res, next) => { const actor = req.get('X-Test-Actor'); if (actor) res.locals.actorId = actor; next(); }, accountRouter);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof CircleResultsError) res.status(error.status).json({ error: error.code });
      else res.status(500).json({ error: 'INTERNAL' });
    });
    const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
      const origin = `http://127.0.0.1:${address.port}`;
      const report = await fetch(`${origin}/public/${valid.id}/report`);
      expect(report.status).toBe(200); expect(report.headers.get('x-content-type-options')).toBe('nosniff');
      const investigation = await fetch(`${origin}/public/${valid.id}/investigation`);
      expect(investigation.status).toBe(200); expect(investigation.headers.get('x-content-type-options')).toBe('nosniff');
      await expect(investigation.json()).resolves.toMatchObject({ status: 'NOT_PROVIDED', investigation: null });
      const artifact = await fetch(`${origin}/public/${valid.id}/artifact`);
      expect(artifact.status).toBe(200); expect(artifact.headers.get('content-type')).toContain('application/json');
      expect(artifact.headers.get('content-disposition')).toBe('attachment; filename="candidate.json"');
      expect(artifact.headers.get('x-content-type-options')).toBe('nosniff'); expect(Buffer.from(await artifact.arrayBuffer())).toEqual(referenceBytes);
      const malformedReport = await fetch(`${origin}/public/${malformed.id}/report`); expect(await malformedReport.text()).not.toContain(secret);
      expect((await fetch(`${origin}/public/${malformed.id}/artifact`)).status).toBe(404);

      const expected = { attemptId: valid.attemptId, artifactManifestDigest: valid.artifactManifestDigest,
        evaluationProfileDigest: valid.evaluationProfileDigest, reportDigest: valid.reportDigest };
      const body = { decision: 'ACCEPTED', rationale: 'Independent exact review.', expected };
      const post = (actor: string | null, key: string, value: unknown) => fetch(`${origin}/account/${valid.id}/reviews`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key,
          ...(actor ? { 'X-Test-Actor': actor } : {}) }, body: JSON.stringify(value),
      });
      expect((await post(null, randomUUID(), { ...body, actorId: validFixture.reviewer, role: 'OWNER' })).status).toBe(401);
      expect((await post(`account:${randomUUID()}`, randomUUID(), body)).status).toBe(401);
      expect((await post(validFixture.researcher, randomUUID(), body)).status).toBe(403);
      const key = randomUUID(); const accepted = await post(validFixture.reviewer, key, body); expect(accepted.status).toBe(200);
      const replay = await post(validFixture.reviewer, key, body); expect(replay.status).toBe(200);
      expect((await replay.json()).id).toBe((await accepted.json()).id);
      expect((await post(validFixture.reviewer, key, { ...body, rationale: 'changed' })).status).toBe(409);
    } finally { server.close(); await once(server, 'close'); }
  });
});
