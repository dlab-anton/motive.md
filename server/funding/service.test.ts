import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { profileDigest, validateAndFreezeProfile, type GatewayProfile } from '../../packages/inference-gateway/src/profile.ts';
import { FundingError, OPENROUTER_GATEWAY_CREDENTIAL_REF, OpenRouterFundingService } from './service.ts';
import { decryptSecret, encryptSecret } from './vault.ts';

const databaseUrl = process.env.MOTIVE_FUNDING_TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

function reviewedProfile(): Readonly<GatewayProfile> {
  return validateAndFreezeProfile({
    format: 'motive.gateway-profile/0.1', profileId: 'openrouter-astra-reviewed-20260907', status: 'reviewed-live',
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
    if (url.endsWith('/key')) return Response.json({ data: { label: 'Motive test', limit: 5, limit_remaining: 5,
      is_free_tier: false, is_management_key: false, expires_at: null } });
    if (url.includes('/models?')) return Response.json({ data: [{ id: 'openai/gpt-6-astra', name: 'Astra', context_length: 1050000,
      supported_parameters: ['tools'], pricing: { prompt: '0.000005', completion: '0.000025' } }] });
    throw new Error('Unexpected provider URL.');
  }) as typeof globalThis.fetch;
}

describe('funding vault', () => {
  it('binds ciphertext to its server-side context', () => {
    const key = Buffer.alloc(32, 7); const encrypted = encryptSecret(key, 'provider-secret', 'account:a');
    expect(encrypted.toString('utf8')).not.toContain('provider-secret');
    expect(decryptSecret(key, encrypted, 'account:a')).toBe('provider-secret');
    expect(() => decryptSecret(key, encrypted, 'account:b')).toThrow();
  });
});

integration('OpenRouter project funding with the real LedgerKernel', () => {
  // This matches the production Vercel pool ceiling. Concurrent advisory-lock
  // waiters must not consume both clients and starve the lock owner's ledger work.
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const ledger = new LedgerKernel(pool);
  const actorId = `account:funding-${randomUUID()}`;
  const profile = reviewedProfile();
  const service = new OpenRouterFundingService({ pool, vaultKey: Buffer.alloc(32, 9),
    callbackUrl: 'http://127.0.0.1:4317/?project=circle-packing#backing',
    allowedCallbackOrigins: ['http://127.0.0.1:4317', 'http://localhost:4317'], gatewayUrl: 'http://127.0.0.1:4319/inference/v1/responses',
    profiles: [profile], fetch: providerFetch(), capabilityTtlSeconds: 60, isActorActive: async id => id === actorId });
  let projectId: string; let budgetId: string; let sourceId: string; let agentId: string; let workOrderId: string;

  beforeAll(async () => {
    const project = await ledger.createProject({ actorId, idempotencyKey: randomUUID(), slug: `funding-${randomUUID()}`,
      visibility: 'PUBLIC', revisionContent: { title: 'Funding integration test' } });
    projectId = project.id;
    await ledger.setControllerSpending({ actorId: 'operator:funding-test', idempotencyKey: randomUUID(), enabled: false,
      reason: 'Start isolated funding test closed.' });
  });
  afterAll(async () => {
    await ledger.setControllerSpending({ actorId: 'operator:funding-test', idempotencyKey: randomUUID(), enabled: false,
      reason: 'End isolated funding test closed.' }).catch(() => undefined);
    await pool.end();
  });

  it('uses an account-bound, expiring, one-use PKCE flow', async () => {
    const flow = await service.startConnect(actorId, 'http://localhost:4317');
    expect(new URL(flow.authorizationUrl).searchParams.get('callback_url')).toContain('http://localhost:4317/');
    await expect(service.completeConnect('account:someone-else', flow.flowId, 'provider-code')).rejects.toMatchObject({ code: 'CONNECT_FLOW_EXPIRED' });
    const connection = await service.completeConnect(actorId, flow.flowId, 'provider-code');
    expect(connection).toMatchObject({ status: 'CONNECTED', label: 'Motive test', limitRemainingUsd: '5' });
    await expect(service.completeConnect(actorId, flow.flowId, 'provider-code')).rejects.toMatchObject({ code: 'CONNECT_FLOW_USED' });
  });

  it('creates one finite ledger source under concurrent idempotent retries and rejects a changed body', async () => {
    const project = await pool.query('SELECT slug FROM motive.projects WHERE id = $1', [projectId]);
    const body = { project: project.rows[0].slug as string, limitUsd: '2.50', model: 'openai/gpt-6-astra' };
    const [first, second] = await Promise.all([service.createBudget(actorId, 'same-budget', body), service.createBudget(actorId, 'same-budget', body)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.budget.id).toBe(second.budget.id); expect(first.budget.limitUsd).toBe('2.5');
    budgetId = first.budget.id; sourceId = first.budget.sourceId;
    const sources = await pool.query('SELECT count(*)::int AS count FROM motive.funding_sources WHERE owner_actor_id = $1', [actorId]);
    expect(sources.rows[0].count).toBe(1);
    await expect(service.createBudget(actorId, 'same-budget', { ...body, limitUsd: '3' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const recovered = await service.createBudget(actorId, 'same-budget', body);
    expect(recovered).toMatchObject({ replayed: true, budget: { id: budgetId } });
  });

  it('keeps activation closed, then issues one exact bounded capability through the real ledger when gates open', async () => {
    agentId = randomUUID();
    await pool.query(
      `INSERT INTO motive.participation_agent_tokens
       (id, project_id, owner_actor_id, agent_name, model_name, token_digest, token_hint, license_acceptance_ref, expires_at)
       VALUES ($1,$2,$3,'Funding agent','openai/gpt-6-astra',$4,$5,'license:test',$6)`,
      [agentId, projectId, actorId, `sha256:${createHash('sha256').update(agentId).digest('hex')}`, agentId.replaceAll('-', '').slice(0, 12), new Date(Date.now() + 3_600_000).toISOString()]);
    const digest = profileDigest(profile);
    const work = await ledger.createWorkOrder({ actorId, idempotencyKey: randomUUID(), projectId, workOrderKey: 'funding-test', revision: 1, state: 'READY',
      terms: { format: 'motive.work-order/0.1', project_id: projectId, project_revision: 1, agreement_id: `funding-${randomUUID()}`,
        objective: 'Run one bounded provider request.', input_commit: 'e'.repeat(40), allowed_effects: ['read-approved-inputs'],
        hosted: { enabled: true, inference: { currency: 'USD', ceiling: '1', profile_digest: digest }, maximum_runtime_seconds: 120 },
        external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120, late_submission_policy: 'reject',
          review_admission: 'manual', artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true } },
        evaluation: { profile_digest: `sha256:${'f'.repeat(64)}`, human_acceptance_required: true } } });
    workOrderId = work.id;
    const closed = await Promise.allSettled([
      service.activateBudget(actorId, budgetId, 'activate-once', { agentId, workOrderId }),
      service.activateBudget(actorId, budgetId, 'activate-once', { agentId, workOrderId }),
    ]);
    expect(closed).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'CONTROLLER_CLOSED' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'CONTROLLER_CLOSED' }) }),
    ]);
    await ledger.setControllerSpending({ actorId: 'operator:funding-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Explicit isolated integration-test authorization.' });
    const [activated, recovered] = await Promise.all([
      service.activateBudget(actorId, budgetId, 'activate-once', { agentId, workOrderId }),
      service.activateBudget(actorId, budgetId, 'activate-once', { agentId, workOrderId }),
    ]);
    if (!('capability' in activated)) throw new Error('Expected donor-agent capability response.');
    expect(activated.budget).toMatchObject({ status: 'ACTIVE', grantId: expect.any(String), assignedAgentId: agentId, workOrderId });
    expect(activated.capability.capability).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
    expect(await service.resolveCredential(sourceId, OPENROUTER_GATEWAY_CREDENTIAL_REF)).toMatch(/^sk-or-v1-/);
    if (!('capability' in recovered)) throw new Error('Expected donor-agent capability retry response.');
    expect(recovered.capability.capability).not.toBe(activated.capability.capability);
    expect(await ledger.getRunCapabilityContext(activated.capability.capability)).toBeNull();
    await pool.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1', [agentId]);
    expect(await service.resolveCredential(sourceId, OPENROUTER_GATEWAY_CREDENTIAL_REF)).toBeNull();
    expect((await service.status(actorId)).budgets[0].readiness).toBe('ASSIGNMENT_REQUIRED');
  });

  it('destroys local key access and revokes its active grant on disconnect', async () => {
    await service.disconnect(actorId);
    expect(await service.resolveCredential(sourceId, OPENROUTER_GATEWAY_CREDENTIAL_REF)).toBeNull();
    const rows = await pool.query('SELECT status FROM motive.grants WHERE id = (SELECT grant_id FROM motive.provider_project_budgets WHERE id = $1)', [budgetId]);
    expect(rows.rows[0].status).toBe('REVOKED');
  });
});
