import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { profileDigest, validateAndFreezeProfile } from '../../packages/inference-gateway/src/profile.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import type { SandboxSdkFactory, SdkCommandRequest, SdkSandbox } from '../../packages/sandbox-vercel/src/types.ts';
import { OPENROUTER_GATEWAY_CREDENTIAL_REF, OpenRouterFundingService } from '../funding/service.ts';
import { prepareCircleFundedWork } from '../../scripts/prepare-circle-funded-work.ts';
import { CircleProjectRunDispatcher, type CircleProjectRunRuntime } from './dispatcher.ts';

const databaseUrl = process.env.MOTIVE_FUNDING_TEST_DATABASE_URL;
const disposableDatabase = (() => {
  if (!databaseUrl) return false;
  const parsed = new URL(databaseUrl);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '55439'
    && /^\/motive_[a-z]+_[a-f0-9]{32}$/.test(parsed.pathname);
})();
if (databaseUrl && !disposableDatabase) throw new Error('Project-run integration tests require a fresh UUID-named local database.');
const integration = describe.runIf(disposableDatabase);
const sandboxDigest = `sha256:${'d'.repeat(64)}` as const;
const collectorDigest = 'sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a' as const;
const gatewayUrl = 'https://gateway.motive.example/api/inference/v1/responses';

function reviewedProfile() {
  return validateAndFreezeProfile({
    format: 'motive.gateway-profile/0.1', profileId: 'circle-astra-reviewed-20260907', status: 'reviewed-live',
    upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: OPENROUTER_GATEWAY_CREDENTIAL_REF },
    route: { model: 'openai/gpt-6-astra', provider: { order: ['OpenAI'], allowFallbacks: false, requireParameters: true } },
    limits: { maxRequestBytes: 262144, maxResponseBytes: 1048576, maxEventBytes: 262144,
      requestTimeoutMs: 5000, maxInputItems: 32, maxTools: 4, contextWindowTokens: 100, maxOutputTokens: 10 },
    requestPolicy: { allowedLocalTools: [], allowedReasoningEfforts: ['low'], allowParallelToolCalls: false,
      allowTemperature: false, allowTopP: false, codexClientMetadata: 'reject' },
    pricing: { currency: 'USD', highestInputUsdPerMillionTokens: '5', highestOutputUsdPerMillionTokens: '25',
      fixedRequestUsd: '0', worstCaseAdditionalUsd: '0', approvedMaximumExposureUsd: '0.001' },
    evidence: { kind: 'gate-a-reviewed', reviewedAt: '2026-09-07', reviewedBy: 'motive-compatibility-review',
      pricingSource: 'https://openrouter.ai/api/v1/models', responsesCompatibilitySource: 'https://openrouter.ai/docs/api-reference/responses/overview' },
  });
}

function providerFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/keys')) return Response.json({ key: `sk-or-v1-${'a'.repeat(48)}` });
    if (url.endsWith('/key')) return Response.json({ data: { label: 'Project dispatch test', limit: 5,
      limit_remaining: 5, is_free_tier: false, is_management_key: false, expires_at: null } });
    if (url.includes('/models?')) return Response.json({ data: [{ id: 'openai/gpt-6-astra', name: 'Astra', context_length: 1050000,
      supported_parameters: ['tools'], pricing: { prompt: '0.000005', completion: '0.000025' } }] });
    throw new Error('Unexpected provider URL.');
  }) as typeof globalThis.fetch;
}

function runtime(infrastructureAuthorizationId: string, inferenceProfileDigest: `sha256:${string}`): CircleProjectRunRuntime {
  return {
    format: 'motive.circle-project-run-runtime/0.1', gatewayUrl, inferenceProfileDigest,
    infrastructureAuthorizationId, maximumCostUsd: '0.001', capabilityTtlSeconds: 120,
    sandbox: {
      format: 'motive.sandbox-profile/0.1', profileDigest: sandboxDigest,
      protectedRuntime: defineProtectedRuntime(sandboxDigest),
      trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveCircle01', sourceCommit: 'a'.repeat(40),
        materialDigest: sandboxDigest, buildRecipeDigest: sandboxDigest },
      timeoutMs: 120_000, commandTimeoutMs: 90_000, vcpus: 1, allowedExecutables: ['/usr/local/bin/codex'],
      egress: {
        gateway: [{ url: gatewayUrl, methods: ['POST'], pathMatch: 'exact' }],
        artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }],
      },
      artifacts: { maxFiles: 1, maxFileBytes: 32 * 1024, maxTotalBytes: 32 * 1024 },
    },
    nativeCollection: { collectorRuntimeDigest: collectorDigest, maximumFileBytes: 32 * 1024,
      maximumTotalBytes: 32 * 1024, approvedPaths: [{ relativePath: 'candidate.json', mediaType: 'application/json',
        availability: 'REQUIRED', maximumBytes: 32 * 1024 }] },
  };
}

function learningRuntime(infrastructureAuthorizationId: string, inferenceProfileDigest: `sha256:${string}`): CircleProjectRunRuntime {
  const result = runtime(infrastructureAuthorizationId, inferenceProfileDigest);
  result.sandbox.artifacts = { maxFiles: 2, maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 };
  result.nativeCollection = { collectorRuntimeDigest: 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415',
    maximumFileBytes: 32 * 1024, maximumTotalBytes: 48 * 1024, approvedPaths: [
      { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32 * 1024 },
      { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16 * 1024 },
    ] };
  return result;
}

function fakeSdk(events: string[], commands: SdkCommandRequest[]): SandboxSdkFactory {
  let sandbox: SdkSandbox | null = null;
  return {
    async create(input) {
      events.push('create');
      expect(input.env.MOTIVE_RUN_CAPABILITY).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
      sandbox = { name: input.name, sessionId: randomUUID(), persistent: false, status: 'running',
        sourceSnapshotId: 'snap_MotiveCircle01', tags: { ...input.tags },
        async startCommand(command) { events.push('command'); commands.push(command); return { cmdId: 'circle-command', exitCode: null }; },
        async getCommand() { return { cmdId: 'circle-command', exitCode: null }; },
        async stop() { events.push('stop'); sandbox!.status = 'stopped'; return { status: 'stopped' }; } };
      return sandbox;
    },
    async get(input) {
      if (!sandbox || sandbox.name !== input.name || input.resume !== false) throw new Error('Unexpected sandbox handle.');
      return sandbox;
    },
    async listOwned() { events.push('inventory'); return { sandboxes: sandbox ? [sandbox] : [], complete: true }; },
  };
}

integration('circle project run dispatcher', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const ledger = new LedgerKernel(pool);
  const store = new PostgresOrchestrationStore(pool);
  const profile = reviewedProfile();
  const cleanups: Array<() => Promise<void>> = [];
  let projectRevision: number;

  beforeAll(async () => {
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await pool.query("SELECT id,current_revision FROM motive.projects WHERE slug='circle-packing'");
    projectRevision = Number(project.rows[0]?.current_revision);
    await pool.query(`INSERT INTO motive.memberships (id,project_id,actor_id,role,scopes,granted_by)
      VALUES ($1,$2,'operator:seed','OWNER',ARRAY['*'],'operator:seed') ON CONFLICT (project_id,actor_id) DO NOTHING`,
    [randomUUID(), project.rows[0].id]);
    await prepareCircleFundedWork(pool, [profile], { actorId: 'operator:seed', idempotencyKey: 'circle-funded-work-test-v1',
      profileDigest: profileDigest(profile), ceilingUsd: '0.01', maxRuntimeSeconds: 120,
      agreementId: 'agreement:independent-evaluation-test-v1', evaluationProfileDigest: `sha256:${'a'.repeat(64)}`,
      inputCommit: 'b'.repeat(40), projectRevision });
  });
  afterAll(async () => {
    await ledger.setControllerSpending({ actorId: 'operator:project-dispatch-test', idempotencyKey: randomUUID(), enabled: false,
      reason: 'End isolated project dispatch test.' }).catch(() => undefined);
    await pool.end();
  });
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined); });

  async function activation() {
    const actorId = `account:dispatch-${randomUUID()}`;
    const funding = new OpenRouterFundingService({ pool, vaultKey: Buffer.alloc(32, 13),
      callbackUrl: 'http://127.0.0.1:4317/?project=circle-packing#backing', gatewayUrl,
      profiles: [profile], fetch: providerFetch(), isActorActive: async id => id === actorId });
    const flow = await funding.startConnect(actorId); await funding.completeConnect(actorId, flow.flowId, 'dispatch-code');
    const budget = await funding.createBudget(actorId, randomUUID(), { project: 'circle-packing', limitUsd: '0.01', model: 'openai/gpt-6-astra' });
    const work = await pool.query("SELECT id FROM motive.work_orders WHERE work_order_key='circle-packing-funded-astra'");
    const activated = await funding.activateBudget(actorId, budget.budget.id, randomUUID(), { mode: 'PROJECT_LEAD', workOrderId: work.rows[0].id });
    const authorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: budget.budget.sourceId,
      sourceAccountRef: `synthetic-vercel:${budget.budget.id}`, actorId, limitUsd: '0.001',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    cleanups.push(() => funding.disconnect(actorId));
    return { actorId, funding, budget: budget.budget, attemptId: activated.activation.attemptId, authorization };
  }

  it('uses the real durable coordinator and adapter for a private start, and fences cancellation before start', async () => {
    await ledger.setControllerSpending({ actorId: 'operator:project-dispatch-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Explicit isolated project dispatch test with an in-memory provider adapter.' });
    const active = await activation(); const events: string[] = []; const commands: SdkCommandRequest[] = [];
    const ownerId = `project-dispatch:${randomUUID()}`;
    const artifacts = { async assertReady(plan: { nativeCollection?: unknown }) { expect(plan.nativeCollection).toBeDefined(); },
      async seal(): Promise<never> { throw new Error('The start-only test must not seal.'); } };
    const sdk = fakeSdk(events, commands);
    const dispatcher = new CircleProjectRunDispatcher({ pool, ownerId,
      runtime: runtime(active.authorization.id, profileDigest(profile)), artifacts, sdk,
      isActorActive: async id => id === active.actorId });
    const reserved = await dispatcher.reconcileBudget(active.budget.id);
    const started = await dispatcher.reconcileAttempt(active.attemptId);
    expect([reserved.status, started.status]).toEqual(['WAITING', 'RUNNING']);
    expect(events).toEqual(['create', 'command']);
    expect(JSON.stringify([reserved, started])).not.toContain('capability');
    expect(commands[0]).toMatchObject({ cmd: '/opt/motive/bin/worker-launcher', cwd: '/', detached: true, sudo: true });
    expect(commands[0].args).toContain('openai/gpt-6-astra');
    const execution = await store.getExecution(active.attemptId);
    expect(execution?.effects.map(effect => [effect.kind, effect.state])).toEqual([
      ['CREATE', 'RESULT_RECORDED'], ['COMMAND', 'RESULT_RECORDED']]);
    expect((await pool.query('SELECT count(*)::int AS count FROM motive.run_capabilities WHERE attempt_id=$1', [active.attemptId])).rows[0].count).toBe(1);

    const removedConfiguration = new CircleProjectRunDispatcher({ pool, ownerId,
      sdk, isActorActive: async id => id === active.actorId });
    expect(await removedConfiguration.reconcileAttempt(active.attemptId)).toMatchObject({ status: 'TERMINATED', reason: 'RUNTIME_REQUIRED' });
    expect(events).toEqual(['create', 'command', 'stop']);

    const foreignActor = `foreign-runtime:${randomUUID()}`;
    const foreignProject = await ledger.createProject({ actorId: foreignActor, idempotencyKey: randomUUID(),
      slug: `foreign-runtime-${randomUUID()}`, visibility: 'PRIVATE', revisionContent: { title: 'Foreign runtime fixture' } });
    const foreignSource = await ledger.createFundingSource({ actorId: foreignActor, idempotencyKey: randomUUID(),
      authorizedAmount: '1', metadata: { test: 'foreign-runtime' } });
    const foreignGrant = await ledger.createGrant({ actorId: foreignActor, idempotencyKey: randomUUID(), sourceId: foreignSource.id,
      projectId: foreignProject.id, limitAmount: '1' });
    const foreignWork = await ledger.createWorkOrder({ actorId: foreignActor, idempotencyKey: randomUUID(), projectId: foreignProject.id,
      workOrderKey: `foreign-${randomUUID()}`, revision: 1, state: 'READY', terms: { format: 'motive.work-order/0.1',
        project_id: foreignProject.id, project_revision: 1, agreement_id: `foreign-${randomUUID()}`,
        objective: 'Remain under the foreign runtime.', input_commit: 'c'.repeat(40), allowed_effects: ['submit-artifact'],
        hosted: { enabled: true, inference: { currency: 'USD', ceiling: '0.001', profile_digest: profileDigest(profile) }, maximum_runtime_seconds: 120 },
        external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
          late_submission_policy: 'reject', review_admission: 'manual', artifact: { formats: ['foreign.data/0.1'],
            max_bytes: 1024, license_acceptance_required: true } },
        evaluation: { profile_digest: `sha256:${'f'.repeat(64)}`, human_acceptance_required: true } } });
    const foreignAttempt = await ledger.reserveAttempt({ actorId: foreignActor, idempotencyKey: randomUUID(), grantId: foreignGrant.id,
      workOrderId: foreignWork.id, ceilingAmount: '0.001', profileDigest: profileDigest(profile), inputDigest: `sha256:${'1'.repeat(64)}` });
    const foreignAuthorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: foreignSource.id,
      sourceAccountRef: `foreign:${foreignSource.id}`, actorId: foreignActor, limitUsd: '0.001',
      expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const foreignLease = await store.acquireLease(foreignAttempt.id, `foreign:${randomUUID()}`, 300);
    const foreignEnvironment = await store.reserveEnvironment(foreignLease, { kind: 'WORKER', profileDigest: sandboxDigest,
      profileSnapshot: runtime(foreignAuthorization.id, profileDigest(profile)).sandbox as unknown as Record<string, unknown>,
      launchPlanDigest: `sha256:${'2'.repeat(64)}`, infrastructureAuthorizationId: foreignAuthorization.id, maximumCostUsd: '0.001' });
    await store.claimEffect(foreignLease, foreignEnvironment.effect.effectId);
    await store.recordCreateResult(foreignLease, foreignEnvironment.effect.effectId,
      { provider: 'vercel', externalId: `foreign-${randomUUID()}`, sessionId: `foreign-session-${randomUUID()}` });
    await store.recordObservation(foreignLease, foreignEnvironment.environment.id,
      { providerStatus: 'running', providerTerminal: false, state: 'ACTIVE' });

    await expect(removedConfiguration.reconcileOrphans()).resolves.toMatchObject({ status: 'COMPLETE' });
    expect(events).toEqual(['create', 'command', 'stop']);
    expect((await store.getExecution(foreignAttempt.id))?.environments[0]?.state).toBe('ACTIVE');
    await active.funding.disconnect(active.actorId);

    const cancelled = await activation(); const cancelledEvents: string[] = [];
    const cancelledDispatcher = new CircleProjectRunDispatcher({ pool, ownerId: `project-dispatch:${randomUUID()}`,
      runtime: runtime(cancelled.authorization.id, profileDigest(profile)), artifacts, sdk: fakeSdk(cancelledEvents, []),
      isActorActive: async id => id === cancelled.actorId });
    await cancelled.funding.disconnect(cancelled.actorId);
    const stopped = await cancelledDispatcher.reconcileBudget(cancelled.budget.id);
    expect(stopped).toMatchObject({ attemptId: cancelled.attemptId, status: 'TERMINATED', reason: 'AUTHORITY_CLOSED' });
    expect(cancelledEvents).toEqual([]);
    expect((await store.getExecution(cancelled.attemptId))?.effects ?? []).toEqual([]);
  });

  it('rejects a loopback gateway before reserving any durable provider effect', async () => {
    const active = await activation(); const events: string[] = [];
    const local = runtime(active.authorization.id, profileDigest(profile));
    local.gatewayUrl = 'http://127.0.0.1:4317/api/inference/v1/responses';
    const dispatcher = new CircleProjectRunDispatcher({ pool, ownerId: `project-dispatch:${randomUUID()}`,
      runtime: local, artifacts: { async assertReady() {}, async seal() { throw new Error('unreachable'); } },
      sdk: fakeSdk(events, []), isActorActive: async id => id === active.actorId });
    expect(await dispatcher.reconcileBudget(active.budget.id)).toMatchObject({ status: 'UNCONFIGURED', reason: 'GATEWAY_UNREACHABLE' });
    expect(events).toEqual([]);
    expect((await store.getExecution(active.attemptId))?.effects ?? []).toEqual([]);
    const { nativeCollection: _removed, ...malformedRuntime } = runtime(active.authorization.id, profileDigest(profile));
    const malformed = malformedRuntime as CircleProjectRunRuntime;
    const malformedDispatcher = new CircleProjectRunDispatcher({ pool, ownerId: `project-dispatch:${randomUUID()}`,
      runtime: malformed, artifacts: { async assertReady() {}, async seal() { throw new Error('unreachable'); } },
      sdk: fakeSdk(events, []), isActorActive: async id => id === active.actorId });
    expect(await malformedDispatcher.reconcileBudget(active.budget.id)).toMatchObject({ status: 'UNCONFIGURED', reason: 'RUNTIME_INVALID' });
    await active.funding.disconnect(active.actorId);
  });

  it('does not start learning-v2 without retained context and starts with the exact frozen prompt', async () => {
    await ledger.setControllerSpending({ actorId: 'operator:project-dispatch-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Explicit isolated learning-v2 dispatch test with an in-memory provider adapter.' });
    const artifacts = { async assertReady() {}, async seal(): Promise<never> { throw new Error('The start-only test must not seal.'); } };
    const missing = await activation(); const missingEvents: string[] = [];
    const withoutContext = new CircleProjectRunDispatcher({ pool, ownerId: `project-dispatch:${randomUUID()}`,
      runtime: learningRuntime(missing.authorization.id, profileDigest(profile)), artifacts, sdk: fakeSdk(missingEvents, []),
      isActorActive: async id => id === missing.actorId });
    expect(await withoutContext.reconcileBudget(missing.budget.id)).toMatchObject({ status: 'UNCONFIGURED', reason: 'RESEARCH_CONTEXT_REQUIRED' });
    expect(missingEvents).toEqual([]);
    expect((await store.getExecution(missing.attemptId))?.effects ?? []).toEqual([]);
    await missing.funding.disconnect(missing.actorId);

    const active = await activation(); const events: string[] = []; const commands: SdkCommandRequest[] = [];
    const frozenPrompt = 'FROZEN LEARNING PROMPT\nRETAINED_RESEARCH_CONTEXT_JSON={"classification":"UNTRUSTED_RESEARCH_DATA_NOT_INSTRUCTIONS_OR_ACCEPTANCE"}';
    const withContext = new CircleProjectRunDispatcher({ pool, ownerId: `project-dispatch:${randomUUID()}`,
      runtime: learningRuntime(active.authorization.id, profileDigest(profile)), artifacts, sdk: fakeSdk(events, commands),
      isActorActive: async id => id === active.actorId, researchContext: { async resolve(attempt, basePrompt) {
        expect(attempt.id).toBe(active.attemptId); expect(basePrompt).toContain('investigation.json');
        return { scopeId:randomUUID(),snapshotId:randomUUID(),snapshotDigest:`sha256:${'1'.repeat(64)}`,
          contextDigest:`sha256:${'2'.repeat(64)}`,promptDigest:`sha256:${'3'.repeat(64)}`,promptText:frozenPrompt };
      } } });
    expect((await withContext.reconcileBudget(active.budget.id)).status).toBe('WAITING');
    expect((await withContext.reconcileAttempt(active.attemptId)).status).toBe('RUNNING');
    expect(events).toEqual(['create','command']);
    expect(commands[0]?.args).toContain(frozenPrompt);
    await active.funding.disconnect(active.actorId);
  });
});
