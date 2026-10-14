import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const baseURL = process.env.MOTIVE_E2E_BASE_URL ?? 'http://127.0.0.1:4317';
const projectPath = '/?project=exoplanet-hunting';
const planPath = '/projects/exoplanet-hunting/research-plan.json';
const examplePath = new URL('../../public/projects/exoplanet-hunting/example-evidence.json', import.meta.url);
const projectApi = '/api/public/projects/exoplanet-hunting';

// No test in this file retains a trace or screenshot: enrollment displays a bearer key.
test.use({ baseURL, trace: 'off', screenshot: 'off', video: 'off' });

function publicProjectRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/public/projects/')) requests.push(path);
  });
  return requests;
}

test('catalogue filters live Astronomy, Math, and All projects with persistent URL state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.project-count')).toHaveText('3 projects');
  await expect(page.locator('[data-project]')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Astronomy' }).click();
  await expect(page).toHaveURL(/\?category=Astronomy$/);
  await expect(page.locator('.project-count')).toHaveText('1 project');
  const astronomyCard = page.locator('[data-project="exoplanet-hunting"]');
  await expect(astronomyCard).toContainText('Hunt for exoplanets');
  await expect(astronomyCard.locator('.project-stats')).toBeVisible();
  await expect(astronomyCard).not.toContainText('In preparation');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Astronomy' })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('[data-project]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Math' }).click();
  await expect(page).toHaveURL(/\?category=Math$/);
  await expect(page.locator('[data-project]')).toHaveCount(2);
  await page.getByRole('tab', { name: 'All projects' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('[data-project]')).toHaveCount(3);
});

test('guest sees the live Astronomy queue and contribution path through Astronomy APIs only', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = publicProjectRequests(page);
  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === projectApi);
  await page.goto(projectPath);
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Hunt for exoplanets', level: 1 })).toBeVisible();
  await expect(page.locator('.project-pitch-heading')).toContainText('Open project');
  await expect(page.locator('#contribute-agent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to connect your agent' })).toBeVisible();
  await expect(page.locator('#project-tasks')).toContainText('Tasks');
  await expect(page.locator('.project-preparation')).toHaveCount(0);
  await expect(page.locator('.agent-help-links a[href="/agents/exoplanet-hunting/SKILL.md"]')).toBeVisible();
  await expect(page.locator('a[href="/projects/exoplanet-hunting/starter/README.md"]')).toBeVisible();
  expect(requests.some(path => path === projectApi)).toBe(true);
  expect(requests.every(path => path.startsWith(`${projectApi}/`) || path === projectApi)).toBe(true);
  expect(errors).toEqual([]);
});

test('pilot protocol downloads and project explanation keeps candidate claims qualified', async ({ page, request }) => {
  await page.goto(projectPath);
  await expect(page.locator(`a[href="${planPath}"]`).first()).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(`a[href="${planPath}"]`).first().click(),
  ]);
  const plan = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(plan).toMatchObject({
    format: 'motive.exoplanet-hunting.research-plan.v1',
    projectId: 'exoplanet-hunting',
    protocolVersion: 'motive.exoplanet-hunting.pilot.v1',
    status: 'active-external-agent-pilot',
    pilotScope: { checkerScope: 'STRUCTURE_ONLY', checkerScientificStatus: 'NOT_VALIDATED' },
  });
  expect(JSON.stringify(plan)).not.toContain('draft-proposed');
  await expect(page.locator('.exoplanet-case')).toContainText('does not confirm a planet');
  await expect(page.locator('.exoplanet-plan-status')).toContainText('Agents can work now');
  for (const path of ['/agents/exoplanet-hunting/SKILL.md', '/projects/exoplanet-hunting/starter/README.md',
    '/projects/exoplanet-hunting/evidence.schema.json']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
  }
});

test('browser checks a synthetic example structurally and rejects malformed or confirmed claims', async ({ page }) => {
  await page.goto(`${projectPath}&tab=check`);
  await expect(page.getByRole('heading', { name: 'Check an evidence bundle' })).toBeVisible();
  const input = page.locator('#exoplanet-evidence');
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  expect(example.dataKind).toBe('synthetic');
  expect(example.observations.classification).toBe('inconclusive');
  const upload = async (value: string) => {
    await input.setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(value) });
    await page.getByRole('button', { name: 'Check evidence structure' }).click();
  };
  await upload(JSON.stringify(example));
  await expect(page.locator('.checker-pass')).toContainText('Evidence structure checked');
  await expect(page.locator('.checker-pass')).toContainText('scientific claims remain unverified');
  await page.getByText('Structure report').click();
  await expect(page.locator('.checker-pass pre')).toContainText('NOT_VALIDATED');
  await expect(page.locator('.checker-pass pre')).toContainText('STRUCTURE_ONLY');
  await expect(page.locator('.checker-pass pre')).not.toContainText('score');
  await upload('{"format":');
  await expect(page.locator('.checker-fail')).toContainText('MALFORMED_JSON');
  await expect(page.locator('.checker-pass')).toHaveCount(0);
  example.observations.classification = 'confirmed';
  await upload(JSON.stringify(example));
  await expect(page.locator('.checker-fail')).toContainText('INVALID_FIELD');
  await expect(page.locator('.checker-pass')).toHaveCount(0);
});

test('illustration stays labelled as schematic and page fits 320px mobile viewport', async ({ page }) => {
  await page.goto(projectPath);
  const illustration = page.locator('.transit-illustration');
  await expect(illustration.getByRole('button', { name: 'See the signal' })).toHaveAttribute('aria-pressed', 'true');
  await illustration.getByRole('button', { name: 'Predict the next dip' }).click();
  await expect(illustration.getByRole('img')).toHaveAttribute('aria-label', /No future measurement is shown/);
  await expect(illustration.locator('figcaption')).toContainText('Schematic only');
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#contribute-agent')).toBeVisible();
});

test('guest follow choice persists across reloads without creating a project account', async ({ page }) => {
  const requests = publicProjectRequests(page);
  await page.goto(projectPath);
  await page.getByRole('button', { name: 'Follow project' }).click();
  await expect(page.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('motive-public-projects-v1') ?? '{}').following ?? []))
    .toContain('exoplanet-hunting');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Following' })).toBeVisible();
  await page.getByRole('button', { name: 'Following' }).click();
  await expect(page.getByRole('button', { name: 'Follow project' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('motive-public-projects-v1') ?? '{}').following ?? []))
    .not.toContain('exoplanet-hunting');
  expect(requests.every(path => path.startsWith(`${projectApi}/`) || path === projectApi)).toBe(true);
});

test.describe('isolated local enrollment', () => {
  const writable = process.env.MOTIVE_E2E_WRITE === '1' && /^http:\/\/(?:127\.0\.0\.1|localhost):4321$/.test(new URL(baseURL).origin);
  test.skip(!writable, 'Enrollment writes only to the explicit isolated local app with MOTIVE_E2E_WRITE=1.');

  test('signup creates an Astronomy-only agent key and assignment receipt', async ({ page }) => {
    const name = 'Astronomy E2E Researcher';
    const signup = await page.request.post('/api/auth/sign-up/email', {
      headers: { Origin: baseURL },
      data: { name, email: `astronomy-${randomUUID()}@example.test`, password: `Test-${randomUUID()}` },
    });
    expect(signup.status()).toBe(200);
    await page.goto(projectPath);
    await expect(page.locator('#contribute-agent')).toBeVisible();
    await page.getByRole('button', { name: 'Add agent' }).click();
    await page.getByText(`Credit my account name, ${name}, publicly when I contribute.`).click();
    await page.getByText('I’ll submit work I have permission to share publicly').click();
    await page.getByRole('button', { name: 'Create project access key' }).click();
    await expect(page.locator('.receipt-title strong')).toHaveText('Project access key created');
    const token = await page.getByLabel('Project access key · save it now').inputValue();
    await page.getByRole('button', { name: 'I’ve saved the access key' }).click();
    await expect(page.locator('.agent-access-receipt')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.textContent?.includes('motive_agent_') ?? false)).toBe(false);
    expect(token).toMatch(/^motive_agent_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
    const assignmentResponse = await page.request.get('/api/agent/assignment', { headers: { Authorization: `Bearer ${token}` } });
    expect(assignmentResponse.status()).toBe(200);
    const assignment = await assignmentResponse.json();
    expect(assignment.credential.projectSlug).toBe('exoplanet-hunting');
    expect(assignment.assignment.projectSlug).toBe('exoplanet-hunting');
    expect(assignment.assignment.status).toBe('AVAILABLE');
    const agentHeaders = { Authorization: `Bearer ${token}` };
    const assignmentPath = `/api/agent/assignments/${assignment.assignment.id}`;
    const claimResponse = await page.request.post(`${assignmentPath}/claim`, {
      headers: { ...agentHeaders, 'Idempotency-Key': randomUUID() }, data: {},
    });
    expect(claimResponse.status()).toBe(201);
    const claimBody = await claimResponse.json();
    const claim = claimBody.assignment ?? claimBody;
    const leaseEpoch: number = claim.leaseEpoch;
    expect(claim.projectSlug).toBe('exoplanet-hunting');
    const proposal = 'Check the synthetic format example as an explicitly unmeasured control.';
    const expectation = 'Structure intake will pass, while scientific status remains unvalidated.';
    const conditions = ['No TESS data, transit measurement, or scientific result is asserted.'];
    const protocol = {
      format: 'motive.experiment-protocol.v1', procedure: 'astronomy-e2e-format-intake/v1', purpose: 'CONTROL',
      inputs: [
        { name: 'data_kind', value: 'synthetic' },
        { name: 'source', value: 'synthetic-control-placeholder-v1' },
        { name: 'scope', value: 'Structure only; no telescope analysis' },
      ],
    };
    const post = (path: string, data: unknown) => page.request.post(path, {
      headers: { ...agentHeaders, 'Idempotency-Key': randomUUID() }, data,
    });
    const missingProtocol = await post(`${assignmentPath}/intent`, { leaseEpoch, proposal, expectation, conditions });
    expect(missingProtocol.status()).toBe(400);
    expect((await missingProtocol.json()).message).toContain('pre-test experiment protocol');
    const intent = await post(`${assignmentPath}/intent`, { leaseEpoch, proposal, expectation, conditions, experimentProtocol: protocol });
    expect(intent.status()).toBe(201);

    const witness = await readFile(examplePath, 'utf8');
    const missingInvestigation = await post(`${assignmentPath}/submissions`, { leaseEpoch, witness });
    expect(missingInvestigation.status()).toBe(400);
    expect((await missingInvestigation.json()).message).toContain('final investigation');
    const investigation = {
      format: 'motive.investigation.v1', proposal, expectation, conditions,
      observations: ['The example is synthetic and contains no events or measured light curve.'],
      assessment: 'This tests the intake contract only; no signal or planet claim is supported.',
      nextAction: 'Run a separately declared analysis on actual retained source data.',
      experimentProtocol: protocol,
    };
    const changedProtocol = await post(`${assignmentPath}/submissions`, {
      leaseEpoch, witness, investigation: { ...investigation, experimentProtocol: { ...protocol, purpose: 'EXPLORATORY' } },
    });
    expect(changedProtocol.status()).toBe(400);
    expect((await changedProtocol.json()).message).toContain('repeated unchanged');
    const submitted = await post(`${assignmentPath}/submissions`, { leaseEpoch, witness, investigation });
    expect(submitted.status()).toBe(201);
    const submission = await submitted.json();
    expect(submission).toMatchObject({ reportStatus: 'VALID', exactScore: null, exceedsReference: null });
    const reportResponse = await page.request.get(submission.reportHref);
    expect(reportResponse.status()).toBe(200);
    const report = await reportResponse.json();
    expect(report).toMatchObject({ exactScore: null, exceedsReference: null, report: { result: {
      ok: true, report: { scope: 'STRUCTURE_ONLY', scientificStatus: 'NOT_VALIDATED', classification: 'inconclusive' },
    } } });
    const postCheck = await post(`/api/agent/submissions/${submission.id}/post-check-assessment`, {
      reportDigest: report.reportDigest,
      assessment: 'The required fields passed structural intake. No source data or scientific claim was validated.',
      nextAction: 'Retain actual control data and run a new declared test.',
    });
    expect(postCheck.status()).toBe(201);
    const complete = await post(`${assignmentPath}/complete`, { leaseEpoch, submissionId: submission.id });
    expect(complete.status()).toBe(200);
    const astronomyMe = await page.request.get('/api/participation/projects/exoplanet-hunting/me');
    expect(astronomyMe.status()).toBe(200);
    expect((await astronomyMe.json()).credentials).toEqual([expect.objectContaining({ projectSlug: 'exoplanet-hunting' })]);
    const mathMe = await page.request.get('/api/participation/me');
    expect(mathMe.status()).toBe(200);
    expect((await mathMe.json()).credentials).toEqual([]);
    await expect(page.locator('.agent-credential-list')).toContainText('Waiting for your agent');
  });
});
