import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { profileDigest, validateAndFreezeProfile } from '../packages/inference-gateway/src/profile.ts';
import { readCircleFundingReadiness } from '../server/funding/readiness.ts';
import { OPENROUTER_GATEWAY_CREDENTIAL_REF, OpenRouterFundingService } from '../server/funding/service.ts';
import { parsePrepareCircleFundedWorkArguments, prepareCircleFundedWork } from './prepare-circle-funded-work.ts';

const databaseUrl = process.env.MOTIVE_FUNDING_TEST_DATABASE_URL;
const disposableDatabase = (() => {
  if (!databaseUrl) return false;
  const parsed = new URL(databaseUrl);
  return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '55439'
    && /^\/motive_[a-z]+_[a-f0-9]{32}$/.test(parsed.pathname);
})();
if (databaseUrl && !disposableDatabase) throw new Error('Funded-work integration tests require a fresh UUID-named local database.');
const integration = describe.runIf(disposableDatabase);

const baseArguments = [
  '--actor', 'operator:seed',
  '--idempotency-key', 'prepare-cli-test',
  '--profile-digest', `sha256:${'a'.repeat(64)}`,
  '--ceiling-usd', '0.01',
  '--max-runtime-seconds', '120',
  '--agreement-id', 'agreement:reviewed-test',
  '--evaluation-profile-digest', `sha256:${'b'.repeat(64)}`,
  '--input-commit', 'c'.repeat(40),
] as const;

describe('circle funded-work preparation arguments', () => {
  it.each(['1', '2'])('requires and retains explicit positive project revision %s', revision => {
    expect(parsePrepareCircleFundedWorkArguments([...baseArguments, '--project-revision', revision]).projectRevision)
      .toBe(Number(revision));
  });

  it.each(['0', '-1', '1.5', '01', '9007199254740992'])(
    'rejects invalid project revision %s',
    revision => expect(() => parsePrepareCircleFundedWorkArguments([
      ...baseArguments, '--project-revision', revision,
    ])).toThrow('--project-revision must be an explicit positive integer.'),
  );

  it('rejects an omitted project revision', () => {
    expect(() => parsePrepareCircleFundedWorkArguments(baseArguments)).toThrow('--project-revision is required.');
  });
});

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
    if (url.endsWith('/key')) return Response.json({ data: { label: 'Project lead funding test', limit: 5,
      limit_remaining: 5, is_free_tier: false, is_management_key: false, expires_at: null } });
    if (url.includes('/models?')) return Response.json({ data: [{ id: 'openai/gpt-6-astra', name: 'Astra', context_length: 1050000,
      supported_parameters: ['tools'], pricing: { prompt: '0.000005', completion: '0.000025' } }] });
    throw new Error('Unexpected provider URL.');
  }) as typeof globalThis.fetch;
}

integration('circle funded work preparation', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let projectRevision: number;
  beforeAll(async () => {
    const project = await pool.query("SELECT id,current_revision FROM motive.projects WHERE slug='circle-packing'");
    projectRevision = Number(project.rows[0]?.current_revision);
    await pool.query(
      `INSERT INTO motive.memberships (id,project_id,actor_id,role,scopes,granted_by)
       VALUES ($1,$2,'operator:seed','OWNER',ARRAY['*'],'operator:seed') ON CONFLICT (project_id,actor_id) DO NOTHING`,
      [randomUUID(), project.rows[0].id]);
  });
  afterAll(() => pool.end());
  it('freezes one exact READY work order without creating funding or enabling spending', async () => {
    const profile = reviewedProfile(); const digest = profileDigest(profile);
    const before = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.funding_sources) AS sources,
      (SELECT count(*)::int FROM motive.grants) AS grants,
      (SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE) AS spending`);
    const input = { actorId: 'operator:seed', idempotencyKey: 'circle-funded-work-test-v1', profileDigest: digest,
      ceilingUsd: '0.01', maxRuntimeSeconds: 120, agreementId: 'agreement:independent-evaluation-test-v1',
      evaluationProfileDigest: `sha256:${'a'.repeat(64)}`, inputCommit: 'b'.repeat(40), projectRevision };
    const prepared = await prepareCircleFundedWork(pool, [profile], input);
    expect(prepared).toMatchObject({ model: 'openai/gpt-6-astra', projectRevision,
      reference: '5.29109518547430697', controllerSpendingEnabled: false });
    const repeated = await prepareCircleFundedWork(pool, [profile], input);
    expect(repeated).toMatchObject({ created: false, workOrderId: prepared.workOrderId, termsDigest: prepared.termsDigest });
    const after = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.funding_sources) AS sources,
      (SELECT count(*)::int FROM motive.grants) AS grants,
      (SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE) AS spending`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const terms = await pool.query('SELECT terms FROM motive.work_orders WHERE id=$1', [prepared.workOrderId]);
    expect(terms.rows[0].terms.allowed_effects).toEqual(['read-approved-inputs', 'write-isolated-workspace', 'submit-data-only-witness']);
    expect(terms.rows[0].terms.hosted).toMatchObject({ enabled: true, inference: { ceiling: '0.01', profile_digest: digest }, maximum_runtime_seconds: 120 });
    const readiness = await readCircleFundingReadiness(pool, 'account:no-connection', [profile]);
    expect(readiness.workOrders).toEqual([expect.objectContaining({ id: prepared.workOrderId, model: 'openai/gpt-6-astra', profileDigest: digest })]);
    expect(readiness.blockers).toEqual(expect.arrayContaining(['CONNECTION_REQUIRED', 'BUDGET_REQUIRED', 'CONTROLLER_CLOSED']));
  });
  it('refuses to prepare a work order without the exact reviewed profile digest', async () => {
    await expect(prepareCircleFundedWork(pool, [], { actorId: 'operator:seed', idempotencyKey: 'missing-profile',
      profileDigest: `sha256:${'c'.repeat(64)}`, ceilingUsd: '1', maxRuntimeSeconds: 120,
      agreementId: 'agreement:independent-evaluation-test-v1', evaluationProfileDigest: `sha256:${'a'.repeat(64)}`,
      inputCommit: 'b'.repeat(40), projectRevision })).rejects.toThrow('absent from MOTIVE_GATEWAY_PROFILES_FILE');
  });
  it('rejects an operator-supplied revision that is not current', async () => {
    const profile = reviewedProfile();
    await expect(prepareCircleFundedWork(pool, [profile], {
      actorId: 'operator:seed', idempotencyKey: 'stale-project-revision', profileDigest: profileDigest(profile),
      ceilingUsd: '0.01', maxRuntimeSeconds: 120, agreementId: 'agreement:independent-evaluation-test-v1',
      evaluationProfileDigest: `sha256:${'a'.repeat(64)}`, inputCommit: 'b'.repeat(40),
      projectRevision: projectRevision + 1,
    })).rejects.toThrow('does not match the reviewed N=101 reference');
  });
  it('lets a donor reserve the trusted project lead attempt without receiving its capability', async () => {
    const profile = reviewedProfile(); const actorId = `account:project-donor-${randomUUID()}`;
    const service = new OpenRouterFundingService({ pool, vaultKey: Buffer.alloc(32, 11),
      callbackUrl: 'http://127.0.0.1:4317/?project=circle-packing#backing', gatewayUrl: 'http://127.0.0.1:4317/api/inference/v1/responses',
      profiles: [profile], fetch: providerFetch(), isActorActive: async id => id === actorId });
    const flow = await service.startConnect(actorId);
    await service.completeConnect(actorId, flow.flowId, 'project-lead-code');
    const budget = await service.createBudget(actorId, 'project-lead-budget', {
      project: 'circle-packing', limitUsd: '0.01', model: 'openai/gpt-6-astra' });
    const work = await pool.query("SELECT id FROM motive.work_orders WHERE work_order_key='circle-packing-funded-astra'");
    const ledger = new LedgerKernel(pool);
    await ledger.setControllerSpending({ actorId: 'operator:project-lead-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'Explicit isolated project-lead activation test.' });
    try {
      const activated = await service.activateBudget(actorId, budget.budget.id, 'project-lead-activation', {
        mode: 'PROJECT_LEAD', workOrderId: work.rows[0].id });
      expect('capability' in activated).toBe(false);
      expect(activated.budget.readiness).toBe('AWAITING_DISPATCH');
      expect(activated.activation).toMatchObject({ kind: 'PROJECT_LEAD', beneficiaryActorId: 'operator:seed', status: 'AWAITING_DISPATCH' });
      const attempt = await pool.query(
        `SELECT funding_grant.beneficiary_actor_id,
           (SELECT count(*)::int FROM motive.run_capabilities capability WHERE capability.attempt_id=attempt.id) capabilities
         FROM motive.attempts attempt JOIN motive.grants funding_grant ON funding_grant.id=attempt.grant_id WHERE attempt.id=$1`,
        [activated.activation.attemptId]);
      expect(attempt.rows[0]).toEqual({ beneficiary_actor_id: 'operator:seed', capabilities: 0 });
      expect((await service.status(actorId)).budgets[0]).toMatchObject({ status: 'ACTIVE', readiness: 'AWAITING_DISPATCH' });
      expect(await service.resolveCredential(budget.budget.sourceId, OPENROUTER_GATEWAY_CREDENTIAL_REF)).toMatch(/^sk-or-v1-/);
    } finally {
      await service.disconnect(actorId);
      await ledger.setControllerSpending({ actorId: 'operator:project-lead-test', idempotencyKey: randomUUID(), enabled: false,
        reason: 'End isolated project-lead activation test.' });
    }
  });
});
