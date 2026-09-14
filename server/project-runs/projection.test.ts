import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations } from '../../packages/accounting/src/migrations.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { profileDigest, validateAndFreezeProfile } from '../../packages/inference-gateway/src/profile.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { prepareCircleFundedWork } from '../../scripts/prepare-circle-funded-work.ts';
import { circlePackingProfile, getProject } from '../../src/lib/projects.ts';
import { OPENROUTER_GATEWAY_CREDENTIAL_REF, OpenRouterFundingService } from '../funding/service.ts';
import { ProjectRunProjectionService, deriveProjectRunState, type ProjectRunStateFacts } from './projection.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(baseUrl));
const sha = (letter: string) => `sha256:${letter.repeat(64)}` as const;
const base: ProjectRunStateFacts = { attemptStatus: 'RESERVED', cancellationRequested: false, workerState: null,
  commandAcknowledged: false, stopPending: false, effectUnknown: false, sealStatus: null, resultId: null, reviewId: null };

describe('project run state derivation', () => {
  it.each([
    [{}, 'queued'],
    [{ workerState: 'ACTIVE', commandAcknowledged: true }, 'running'],
    [{ workerState: 'STOP_REQUESTED' }, 'stopping'],
    [{ workerState: 'PROVISIONING', cancellationRequested: true }, 'stopping'],
    [{ workerState: 'UNKNOWN' }, 'unresolved'],
    [{ sealStatus: 'SEALED' }, 'checking'],
    [{ workerState: 'TERMINATED', resultId: randomUUID() }, 'awaiting-review'],
    [{ workerState: 'TERMINATED', resultId: randomUUID(), reviewId: randomUUID() }, 'finished'],
    [{ attemptStatus: 'CANCELLED', cancellationRequested: true }, 'cancelled'],
    [{ attemptStatus: 'FAILED', sealStatus: 'FAILED' }, 'failed'],
  ] as const)('maps persisted facts %o to %s', (change, state) => {
    expect(deriveProjectRunState({ ...base, ...change })).toBe(state);
  });
  it('keeps an active observed command ahead of a subsequently persisted result stage', () => {
    expect(deriveProjectRunState({ ...base, workerState: 'ACTIVE', commandAcknowledged: true,
      resultId: randomUUID(), reviewId: randomUUID() })).toBe('running');
  });
  it('rejects an impossible persisted result while a nonterminal worker lacks a command acknowledgement', () => {
    expect(deriveProjectRunState({ ...base, workerState: 'PROVISIONING', resultId: randomUUID() })).toBe('unresolved');
  });
});

function profile() {
  return validateAndFreezeProfile({ format: 'motive.gateway-profile/0.1', profileId: 'projection-astra', status: 'reviewed-live',
    upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: OPENROUTER_GATEWAY_CREDENTIAL_REF },
    route: { model: 'openai/gpt-6-astra', provider: { order: ['OpenAI'], allowFallbacks: false, requireParameters: true } },
    limits: { maxRequestBytes: 262144, maxResponseBytes: 1048576, maxEventBytes: 262144, requestTimeoutMs: 5000,
      maxInputItems: 32, maxTools: 4, contextWindowTokens: 100, maxOutputTokens: 10 },
    requestPolicy: { allowedLocalTools: [], allowedReasoningEfforts: ['low'], allowParallelToolCalls: false,
      allowTemperature: false, allowTopP: false, codexClientMetadata: 'reject' },
    pricing: { currency: 'USD', highestInputUsdPerMillionTokens: '5', highestOutputUsdPerMillionTokens: '25',
      fixedRequestUsd: '0', worstCaseAdditionalUsd: '0', approvedMaximumExposureUsd: '0.001' },
    evidence: { kind: 'gate-a-reviewed', reviewedAt: '2026-09-07', reviewedBy: 'projection-test',
      pricingSource: 'https://openrouter.ai/api/v1/models', responsesCompatibilitySource: 'https://openrouter.ai/docs/api-reference/responses/overview' } });
}
function fetchProvider(): typeof fetch {
  return (async (input: RequestInfo | URL) => String(input).endsWith('/auth/keys')
    ? Response.json({ key: `sk-or-v1-${'a'.repeat(48)}` })
    : String(input).endsWith('/key')
      ? Response.json({ data: { label: 'Projection', limit: 1, limit_remaining: 1, is_free_tier: false, is_management_key: false, expires_at: null } })
      : Response.json({ data: [{ id: 'openai/gpt-6-astra', name: 'Astra', context_length: 100,
        supported_parameters: ['tools'], pricing: { prompt: '0.000005', completion: '0.000025' } }] })) as typeof fetch;
}

integration('project run projections from durable PostgreSQL state', () => {
  const databaseName = `motive_projection_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let ledger: LedgerKernel; let orchestration: PostgresOrchestrationStore;
  const actorId = `account:projection-${randomUUID()}`; const active = async (id: string) => id === actorId;
  const reviewed = profile(); let budgetId = '', attemptId = '';

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    source.pathname = `/${databaseName}`; pool = new Pool({ connectionString: source.toString(), max: 8 });
    await applyPostgresMigrations(pool); ledger = new LedgerKernel(pool); orchestration = new PostgresOrchestrationStore(pool);
    const publicProject = getProject('circle-packing')!;
    const content = { title: publicProject.title, purpose: publicProject.goal, next_step: publicProject.next,
      stage: 'preparation', description: publicProject.description, story: publicProject.story,
      beneficiaries: publicProject.beneficiaries, scope: publicProject.scope, acceptance: publicProject.acceptance,
      output: publicProject.output, challenge: circlePackingProfile, spending_authorized: false, execution_authorized: false };
    const projectId = randomUUID();
    await pool.query("INSERT INTO motive.projects(id,slug,visibility,current_revision,created_by) VALUES($1,'circle-packing','PUBLIC',2,'operator:seed')", [projectId]);
    await pool.query(`INSERT INTO motive.project_revisions(id,project_id,revision,format,content,content_digest,created_by)
      VALUES($1,$2,2,'motive.project/0.1',$3,$4,'operator:seed')`, [randomUUID(), projectId, content, digestCanonicalJson(content)]);
    await pool.query("INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES($1,$2,'operator:seed','OWNER',ARRAY['*'],'operator:seed')",
      [randomUUID(), projectId]);
    await prepareCircleFundedWork(pool, [reviewed], { actorId: 'operator:seed', idempotencyKey: `projection-work-${randomUUID()}`,
      profileDigest: profileDigest(reviewed), ceilingUsd: '0.01', maxRuntimeSeconds: 120,
      agreementId: 'agreement:projection-v1', evaluationProfileDigest: sha('a'), inputCommit: 'b'.repeat(40), projectRevision: 2 });
    await ledger.setControllerSpending({ actorId: 'operator:projection-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Isolated projection fixture.' });
    const funding = new OpenRouterFundingService({ pool, vaultKey: Buffer.alloc(32, 21),
      callbackUrl: 'http://127.0.0.1:4317/?project=circle-packing#backing', gatewayUrl: 'https://gateway.example/responses',
      profiles: [reviewed], fetch: fetchProvider(), isActorActive: active });
    const flow = await funding.startConnect(actorId); await funding.completeConnect(actorId, flow.flowId, 'code');
    const created = await funding.createBudget(actorId, randomUUID(), { project: 'circle-packing', limitUsd: '0.01', model: 'openai/gpt-6-astra' });
    budgetId = created.budget.id;
    const work = await pool.query("SELECT id FROM motive.work_orders WHERE work_order_key='circle-packing-funded-astra' ORDER BY created_at DESC LIMIT 1");
    const activation = await funding.activateBudget(actorId, budgetId, randomUUID(), { mode: 'PROJECT_LEAD', workOrderId: work.rows[0].id });
    attemptId = activation.activation.attemptId;
  });
  afterAll(async () => {
    await ledger.setControllerSpending({ actorId: 'operator:projection-test', idempotencyKey: randomUUID(), enabled: false,
      reason: 'End isolated projection fixture.' }).catch(() => undefined);
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  it('aggregates only durable hosted usage and distinguishes total-only reports from complete breakdowns', async () => {
    const attempt = (await pool.query(`SELECT source_id,grant_id,lease_epoch,controller_generation
      FROM motive.attempts WHERE id=$1`, [attemptId])).rows[0];
    const insertSettled = async (sequence: number, usage: Record<string, number>) => {
      await pool.query(`INSERT INTO motive.request_operations
        (provider_operation_id,attempt_id,grant_id,source_id,request_sequence,request_body_digest,profile_digest,reserved_amount,
         admission_lease_epoch,admission_controller_generation,status,raw_provider_usage,settled_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'0.001',$8,$9,'RECONCILED',$10,clock_timestamp())`,
      [randomUUID(), attemptId, attempt.grant_id, attempt.source_id, sequence, sha(String(sequence)), profileDigest(reviewed),
        attempt.lease_epoch, attempt.controller_generation, { usage }]);
    };
    await insertSettled(2, { totalTokens: 14 });
    await insertSettled(3, { inputTokens: 2, outputTokens: 1 });
    const projections = new ProjectRunProjectionService(pool, active);
    expect(await projections.publicCircleUsage()).toEqual({
      project: 'circle-packing',
      hostedGateway: {
        gatewayRequests: 2, settledRequests: 2, unresolvedRequests: 0,
        requestsWithTokenCounts: 2, requestsWithoutTokenCounts: 0,
        recordedInputTokens: '2', recordedOutputTokens: '1', recordedTotalTokens: '17',
        inputBreakdownComplete: false, outputBreakdownComplete: false, complete: true,
      },
      externalAgents: { submissions: 0, tokenUsage: 'NOT_RECORDED_BY_MOTIVE' },
      projectTokenLimit: { status: 'NOT_CONFIGURED', totalTokens: null },
    });

    await insertSettled(4, { inputTokens: 10, outputTokens: 4, totalTokens: 13 });
    expect(await projections.publicCircleUsage()).toMatchObject({ hostedGateway: {
      gatewayRequests: 3, settledRequests: 3, unresolvedRequests: 0,
      requestsWithTokenCounts: 2, requestsWithoutTokenCounts: 1,
      recordedInputTokens: '12', recordedOutputTokens: '5', recordedTotalTokens: '17',
      inputBreakdownComplete: false, outputBreakdownComplete: false, complete: false,
    } });
  });

  it('enforces donor ownership and projects queued, observed running, then sealed checking facts', async () => {
    const projections = new ProjectRunProjectionService(pool, active);
    await expect(projections.donorReceipt('account:other', budgetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await projections.donorReceipt(actorId, budgetId)).toMatchObject({ attemptId, state: 'queued', attemptClosed: false,
      inference: { consumedUsd: '0', heldUsd: '0', unresolvedExposureUsd: '0', providerActualCostUsd: null },
      compute: { actualCostUsd: null } });
    const source = await pool.query('SELECT source_id FROM motive.attempts WHERE id=$1', [attemptId]);
    const authorization = await orchestration.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: source.rows[0].source_id,
      sourceAccountRef: `projection:${budgetId}`, actorId, limitUsd: '0.001', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    const lease = await orchestration.acquireLease(attemptId, `projection:${randomUUID()}`, 60);
    const reserved = await orchestration.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: sha('d'), profileSnapshot: { kind: 'projection-test' },
      launchPlanDigest: digestCanonicalJson({ kind: 'projection-plan' }), infrastructureAuthorizationId: authorization.id, maximumCostUsd: '0.001' });
    await orchestration.claimEffect(lease, reserved.effect.effectId);
    await orchestration.recordCreateResult(lease, reserved.effect.effectId, { provider: 'vercel', externalId: `projection-${randomUUID()}`, sessionId: randomUUID() });
    await orchestration.recordObservation(lease, reserved.environment.id, { state: 'ACTIVE', providerStatus: 'running', providerTerminal: false });
    const command = await orchestration.planCommand(lease, reserved.environment.id, { commandDigest: sha('e') });
    await orchestration.claimEffect(lease, command.effect.effectId);
    await orchestration.recordCommandResult(lease, command.effect.effectId, { providerCommandId: 'projection-command' });
    expect(await projections.donorReceipt(actorId, budgetId)).toMatchObject({ state: 'running', startedAt: expect.any(String) });
    await orchestration.settleInfrastructureUsage(lease, { environmentId: reserved.environment.id,
      providerUsageId: 'projection-partial', actualCostUsd: '0.0002' });
    await orchestration.settleInfrastructureUsage(lease, { environmentId: reserved.environment.id,
      providerUsageId: 'projection-final', actualCostUsd: '0.0003', final: true });
    expect(await projections.donorReceipt(actorId, budgetId)).toMatchObject({ compute: { actualCostUsd: '0.0005' } });
    await orchestration.recordArtifactSeal(lease, reserved.environment.id, { manifestDigest: sha('f'), receiptId: `artifact-receipt:${'f'.repeat(64)}` });
    await orchestration.recordObservation(lease, reserved.environment.id, { state: 'TERMINATED', providerStatus: 'stopped', providerTerminal: true });
    const secondEnvironment = randomUUID(); const attempt = await pool.query('SELECT source_id,grant_id,lease_epoch,controller_generation FROM motive.attempts WHERE id=$1', [attemptId]);
    await pool.query(`INSERT INTO motive.orchestration_environments
      (id,attempt_id,source_id,grant_id,kind,lease_epoch,controller_generation,state,profile_digest,profile_snapshot,
       launch_plan_digest,infrastructure_authorization_id,maximum_cost_usd,held_cost_usd,consumed_cost_usd,
       provider,external_id,session_id,provider_status,terminated_at)
      VALUES ($1,$2,$3,$4,'EVALUATOR',2,$5,'TERMINATED',$6,'{}'::jsonb,$7,$8,'0.001','0','0.0001',
       'vercel',$9,$10,'stopped',clock_timestamp())`, [secondEnvironment, attemptId, attempt.rows[0].source_id,
      attempt.rows[0].grant_id, attempt.rows[0].controller_generation, sha('d'), sha('c'), authorization.id,
      `projection-${randomUUID()}`, randomUUID()]);
    await pool.query(`INSERT INTO motive.infrastructure_usage_records
      (id,infrastructure_authorization_id,environment_id,provider_usage_id,amount_usd,authoritative_final)
      VALUES ($1,$2,$3,'projection-second-final','0.0001',true)`, [randomUUID(), authorization.id, secondEnvironment]);
    const operationId = randomUUID();
    await pool.query(`INSERT INTO motive.request_operations
      (provider_operation_id,attempt_id,grant_id,source_id,request_sequence,request_body_digest,profile_digest,reserved_amount,
       admission_lease_epoch,admission_controller_generation,status,unknown_reason)
      VALUES ($1,$2,$3,$4,1,$5,$6,'0.001',$7,$8,'UNKNOWN','synthetic projection ambiguity')`,
    [operationId, attemptId, attempt.rows[0].grant_id, attempt.rows[0].source_id, sha('b'), profileDigest(reviewed),
      attempt.rows[0].lease_epoch, attempt.rows[0].controller_generation]);
    await pool.query(`INSERT INTO motive.reservations
      (id,kind,source_id,grant_id,attempt_id,operation_id,original_amount,held_amount,status)
      VALUES ($1,'ATTEMPT_REQUEST',$2,$3,$4,$5,'0.001','0.001','UNKNOWN')`,
    [randomUUID(), attempt.rows[0].source_id, attempt.rows[0].grant_id, attemptId, operationId]);
    await pool.query("UPDATE motive.attempts SET request_held_amount='0.001' WHERE id=$1", [attemptId]);
    expect(await projections.donorReceipt(actorId, budgetId)).toMatchObject({ state: 'checking', endedAt: expect.any(String),
      inference: { heldUsd: '0.001', unresolvedExposureUsd: '0.001', providerActualCostUsd: null },
      compute: { actualCostUsd: '0.0006' } });
    const feed = await projections.publicCircleRuns(1);
    expect(feed.runs[0]).toMatchObject({ attemptId, state: 'checking' });
    expect(feed.stateCounts.checking).toBeGreaterThanOrEqual(1);
    expect(feed.totalRuns).toBeGreaterThanOrEqual(feed.runs.length);
  });
});
