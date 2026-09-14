import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test, type BrowserContext } from '@playwright/test';
import type { FundingStatusResponse, FundedRunReadinessResponse } from '../../src/lib/funding.ts';
import type { PublicProjectRuns } from '../../src/lib/project-runs.ts';

const apiOrigin = process.env.MOTIVE_REHEARSAL_API_URL;
const browserOrigin = 'http://127.0.0.1:4317';
const profileDigest = process.env.MOTIVE_REHEARSAL_PROFILE_DIGEST;
const workOrderId = process.env.MOTIVE_REHEARSAL_WORK_ORDER_ID;
const headers = { Origin: browserOrigin };
test.skip(process.env.MOTIVE_FUNDED_ATTEMPT_REHEARSAL !== '1' || !apiOrigin,
  'Run through scripts/rehearsal-funded-attempt.ts against a disposable database.');

async function routeApi(context: BrowserContext, activation: { keys: string[]; bodies: string[]; loseFirst: boolean }) {
  await context.route('**/api/**', async route => {
    const request = route.request(); const target = new URL(request.url());
    const response = await route.fetch({ url: `${apiOrigin}${target.pathname}${target.search}` });
    if (request.method() === 'POST' && /\/api\/funding\/openrouter\/budgets\/[a-f0-9-]+\/activate$/.test(target.pathname)) {
      activation.keys.push(request.headers()['idempotency-key'] ?? '');
      const body = await response.body(); activation.bodies.push(body.toString('utf8'));
      if (activation.loseFirst) { activation.loseFirst = false; await route.abort('failed'); return; }
      await route.fulfill({ response, body }); return;
    }
    await route.fulfill({ response });
  });
}

test('a sponsor queues exactly one Astra project-lead attempt, recovers its receipt, and cancels by disconnecting', async ({ browser }) => {
  test.skip(true, 'OpenRouter UI is intentionally disabled during the connected-agent and credits pilot. Funded backend tests remain separate.');
  test.setTimeout(90_000);
  expect(apiOrigin).toBe('http://127.0.0.1:4319');
  expect(profileDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(workOrderId).toMatch(/^[a-f0-9-]{36}$/);
  const databaseUrl = new URL(process.env.MOTIVE_DATABASE_URL!);
  expect(databaseUrl.pathname).toMatch(/^\/motive_ui_[a-f0-9]{32}$/);
  const pool = new Pool({ connectionString: databaseUrl.href, max: 1 });
  const context = await browser.newContext({ baseURL: browserOrigin });
  const activation = { keys: [] as string[], bodies: [] as string[], loseFirst: true };
  try {
    await routeApi(context, activation);
    await context.route('https://openrouter.ai/auth?**', async route => {
      const authUrl = new URL(route.request().url());
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const callback = new URL(authUrl.searchParams.get('callback_url')!);
      expect(callback.origin).toBe(browserOrigin);
      expect(callback.searchParams.get('openrouter_flow')).toHaveLength(43);
      callback.searchParams.set('code', 'synthetic-browser-authorization');
      await route.fulfill({ status: 302, headers: { Location: callback.href }, body: '' });
    });

    const signup = await context.request.post(`${apiOrigin}/api/auth/sign-up/email`, { headers, data: {
      name: 'Funded Attempt Sponsor', email: `funded-${randomUUID()}@example.test`, password: `Test-${randomUUID()}`,
    } });
    expect(signup.ok(), await signup.text()).toBe(true);
    const actorId = `account:${(await signup.json()).user.id}`;
    const page = await context.newPage();
    await page.goto('/?project=circle-packing#backing');
    await page.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
    await expect(page.getByText('OpenRouter connected', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    expect(new URL(page.url()).searchParams.has('openrouter_flow')).toBe(false);
    await expect(page.getByLabel('Model to fund', { exact: true })).toHaveValue('openai/gpt-6-astra');
    await page.getByLabel('Maximum project budget · USD').fill('0.01');
    await page.getByRole('button', { name: 'Authorize $0.01 budget', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Queue Astra attempt', exact: true })).toBeEnabled({ timeout: 15_000 });

    const readinessResponse = await context.request.get(`${apiOrigin}/api/funding/openrouter/readiness`);
    expect(readinessResponse.ok(), await readinessResponse.text()).toBe(true);
    const readiness = await readinessResponse.json() as FundedRunReadinessResponse;
    expect(readiness).toMatchObject({ project: 'circle-packing', projectRevision: 2, controllerSpendingEnabled: true, blockers: [] });
    expect(readiness.workOrders).toEqual([expect.objectContaining({ id: workOrderId, model: 'openai/gpt-6-astra',
      profileDigest, ceilingUsd: '0.01', maxRuntimeSeconds: 120, projectLeadEligible: true })]);

    await page.getByRole('button', { name: 'Queue Astra attempt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check this reservation again', exact: true })).toBeVisible({ timeout: 15_000 });
    expect(activation.keys).toHaveLength(1);
    const afterLostResponse = await pool.query(
      `SELECT budget.id AS budget_id, activation.attempt_id, activation.status, activation.beneficiary_actor_id,
         attempt.profile_digest, attempt.ceiling_amount::text
       FROM motive.provider_project_budgets budget
       JOIN motive.provider_budget_activations activation ON activation.budget_id=budget.id
       JOIN motive.attempts attempt ON attempt.id=activation.attempt_id
       WHERE budget.owner_actor_id=$1`, [actorId]);
    expect(afterLostResponse.rows).toEqual([expect.objectContaining({ status: 'AWAITING_DISPATCH', beneficiary_actor_id: 'operator:seed',
      profile_digest: profileDigest, ceiling_amount: '0.010000000000' })]);

    await page.getByRole('button', { name: 'Check this reservation again', exact: true }).click();
    const fundingReceipt = page.locator('.openrouter-funding');
    await expect(fundingReceipt.getByText('Queued', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(fundingReceipt.getByText('Provider model cost', { exact: true })).toBeVisible();
    await expect(fundingReceipt.getByText('Not reported', { exact: true })).toHaveCount(2);
    expect(activation.keys).toHaveLength(2);
    expect(activation.keys[0]).toBeTruthy(); expect(activation.keys[1]).toBe(activation.keys[0]);
    expect(activation.bodies.every(body => !body.includes('capability'))).toBe(true);

    const statusResponse = await context.request.get(`${apiOrigin}/api/funding/openrouter`);
    expect(statusResponse.ok(), await statusResponse.text()).toBe(true);
    const status = await statusResponse.json() as FundingStatusResponse;
    expect(status.connection?.status).toBe('CONNECTED'); expect(status.budgets).toHaveLength(1);
    expect(status.budgets[0]).toMatchObject({ id: afterLostResponse.rows[0].budget_id, model: 'openai/gpt-6-astra',
      limitUsd: '0.01', status: 'ACTIVE', readiness: 'AWAITING_DISPATCH', run: {
        attemptId: afterLostResponse.rows[0].attempt_id, state: 'queued', attemptClosed: false,
        inference: { consumedUsd: '0', heldUsd: '0', unresolvedExposureUsd: '0', providerActualCostUsd: null },
        compute: { actualCostUsd: null },
      } });
    expect(JSON.stringify(status)).not.toContain('sk-or-'); expect(JSON.stringify(status)).not.toContain('capability');
    const publicRuns = await (await context.request.get(`${apiOrigin}/api/public/projects/circle-packing/runs`)).json() as PublicProjectRuns;
    expect(publicRuns).toMatchObject({ totalRuns: 1, stateCounts: { queued: 1 } });
    expect(publicRuns.runs).toEqual([expect.objectContaining({ attemptId: afterLostResponse.rows[0].attempt_id,
      model: 'openai/gpt-6-astra', state: 'queued', startedAt: null, endedAt: null, result: null })]);
    const durable = await pool.query(
      `SELECT (SELECT count(*)::int FROM motive.provider_budget_activations WHERE budget_id=$1) AS activations,
         (SELECT count(*)::int FROM motive.attempts WHERE id=$2) AS attempts,
         (SELECT count(*)::int FROM motive.run_capabilities WHERE attempt_id=$2) AS capabilities,
         (SELECT count(*)::int FROM motive.request_operations WHERE attempt_id=$2) AS provider_operations`,
      [afterLostResponse.rows[0].budget_id, afterLostResponse.rows[0].attempt_id]);
    expect(durable.rows[0]).toEqual({ activations: 1, attempts: 1, capabilities: 0, provider_operations: 0 });
    await page.screenshot({ path: 'artifacts/funded-attempt-queued-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.provider-budget-receipt').screenshot({ path: 'artifacts/funded-attempt-queued-mobile.png' });

    await page.getByRole('button', { name: 'Disconnect OpenRouter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect OpenRouter', exact: true })).toBeVisible({ timeout: 15_000 });
    const disconnected = await (await context.request.get(`${apiOrigin}/api/funding/openrouter`)).json() as FundingStatusResponse;
    expect(disconnected.connection?.status).toBe('DISCONNECTED');
    expect(disconnected.budgets[0]).toMatchObject({ status: 'REVOKED', run: { state: 'cancelled', attemptClosed: true,
      inference: { consumedUsd: '0', heldUsd: '0', unresolvedExposureUsd: '0', providerActualCostUsd: null } } });
    const closed = await pool.query('SELECT execution_status,cancellation_reason,closed_at FROM motive.attempts WHERE id=$1',
      [afterLostResponse.rows[0].attempt_id]);
    expect(closed.rows[0]).toMatchObject({ execution_status: 'CLOSED', cancellation_reason: 'OpenRouter connection disconnected by its owner.',
      closed_at: expect.any(Date) });
    await page.locator('.openrouter-funding').screenshot({ path: 'artifacts/funded-attempt-cancelled-mobile.png' });
  } finally { await context.close(); await pool.end(); }
});
