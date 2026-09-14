import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { test, expect, type BrowserContext } from '@playwright/test';
import type { HostedCirclePublicInvestigation, HostedCirclePublicResults } from '../../src/lib/hosted-results.ts';
import { REHEARSAL_HOSTED_INVESTIGATION } from '../../scripts/rehearsal-hosted-circle-result.ts';

const apiOrigin = process.env.MOTIVE_REHEARSAL_API_URL;
const browserOrigin = 'http://127.0.0.1:4317';
const headers = { Origin: browserOrigin };
test.skip(!apiOrigin, 'Run through npm run rehearsal:participation for an isolated project database.');

async function routeApi(context: BrowserContext) {
  await context.route('**/api/**', async route => {
    const target = new URL(route.request().url());
    const response = await route.fetch({ url: `${apiOrigin}${target.pathname}${target.search}` });
    await route.fulfill({ response });
  });
}

test('a real sealed hosted result is retained, independently reviewed, and rendered from public evidence', async ({ browser }) => {
  test.setTimeout(90_000);
  const reviewer = await browser.newContext({ baseURL: browserOrigin });
  const pool = new Pool({ connectionString: process.env.MOTIVE_DATABASE_URL, max: 1 });
  const account = { name: 'Hosted Result Reviewer', email: `hosted-review-${randomUUID()}@example.test`, password: `Test-${randomUUID()}` };
  try {
    await routeApi(reviewer);
    const signup = await reviewer.request.post(`${apiOrigin}/api/auth/sign-up/email`, { headers, data: account });
    expect(signup.ok(), await signup.text()).toBe(true);
    const actorId = `account:${(await signup.json()).user.id}`;
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,granted_by)
      SELECT $1,id,$2,'STEWARD','operator:isolated-browser-test' FROM motive.projects WHERE slug='circle-packing'`,
    [randomUUID(), actorId]);

    const projectionResponse = await reviewer.request.get(`${apiOrigin}/api/public/projects/circle-packing/hosted-results`);
    expect(projectionResponse.ok(), await projectionResponse.text()).toBe(true);
    const projection = await projectionResponse.json() as HostedCirclePublicResults;
    expect(projection).toMatchObject({ projectSlug: 'circle-packing', totalResults: 1, acceptedResults: 0, bestAccepted: null });
    const result = projection.results[0];
    expect(result).toMatchObject({ model: { id: 'openai/gpt-6-astra' }, status: 'VALID', exactScore: '5.29109518547430697',
      exceedsReference: false, artifactAvailable: true, investigation: { status: 'VALID',
        href: `/api/public/projects/circle-packing/hosted-results/${result.id}/investigation` }, review: null });

    const investigationResponse = await reviewer.request.get(`${apiOrigin}${result.investigation.href}`);
    expect(investigationResponse.ok(), await investigationResponse.text()).toBe(true);
    const investigation = await investigationResponse.json() as HostedCirclePublicInvestigation;
    expect(investigation).toMatchObject({ format: 'motive.hosted-investigation.public.v1', resultId: result.id,
      status: 'VALID', validationCode: 'VALID', interpretationStatus: 'AGENT_DECLARED_UNVERIFIED',
      binding: { attemptId: result.attemptId, artifactManifestDigest: result.artifactManifestDigest,
        investigationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        model: { id: 'openai/gpt-6-astra', inferenceProfileDigest: result.model.inferenceProfileDigest } },
      investigation: REHEARSAL_HOSTED_INVESTIGATION,
      notice: 'Hosted investigation notes are agent statements retained separately from the numerical evaluator report and human acceptance.' });
    expect(investigation.investigation?.researchReferences).toBeUndefined();

    const reportResponse = await reviewer.request.get(`${apiOrigin}/api/public/projects/circle-packing/hosted-results/${result.id}/report`);
    expect(reportResponse.ok(), await reportResponse.text()).toBe(true);
    const report = await reportResponse.json();
    expect(report).toMatchObject({ resultId: result.id, reportDigest: result.reportDigest,
      report: { format: 'motive.csqv.evaluator-report/0.1', outcome: 'VALID', result: { ok: true,
        report: { official: false, objective: { exact_decimal: '5.29109518547430697', versus_frozen_reference_5_29109518547430697: 'equal' } } },
        human_acceptance: { status: 'PENDING', decision_id: null } } });
    const artifactResponse = await reviewer.request.get(`${apiOrigin}/api/public/projects/circle-packing/hosted-results/${result.id}/artifact`);
    expect(artifactResponse.ok(), await artifactResponse.text()).toBe(true);
    expect(artifactResponse.headers()['content-disposition']).toBe('attachment; filename="candidate.json"');
    const artifact = await artifactResponse.body(); const frozen = await readFile('public/projects/circle-packing/reference-witness.json');
    expect(artifact).toEqual(frozen);
    expect(`sha256:${createHash('sha256').update(artifact).digest('hex')}`).toBe(result.candidateDigest);

    const page = await reviewer.newPage(); await page.goto('/?project=circle-packing&tab=evidence');
    const card = page.locator(`#hosted-result-${result.id}`);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'OpenAI Astra' })).toBeVisible();
    await expect(card.getByText('Geometry valid', { exact: true })).toBeVisible();
    await expect(card.getByText('Awaiting project review', { exact: true })).toBeVisible();
    await expect(card.getByText('Does not exceed the frozen reference.', { exact: false })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Evaluator report' })).toHaveAttribute('href',
      `/api/public/projects/circle-packing/hosted-results/${result.id}/report`);
    await card.getByText('Research notes · Propose → Test → Update', { exact: true }).click();
    const notes = card.locator('.hosted-investigation-body');
    await expect(notes).toBeVisible();
    await expect(notes.getByRole('heading', { name: 'Propose', exact: true })).toBeVisible();
    await expect(notes.getByRole('heading', { name: 'Test', exact: true })).toBeVisible();
    await expect(notes.getByRole('heading', { name: 'Update', exact: true })).toBeVisible();
    await expect(notes.getByText(REHEARSAL_HOSTED_INVESTIGATION.proposal, { exact: true })).toBeVisible();
    await expect(notes.getByText(REHEARSAL_HOSTED_INVESTIGATION.expectation, { exact: false })).toBeVisible();
    await expect(notes.getByText(REHEARSAL_HOSTED_INVESTIGATION.assessment, { exact: true })).toBeVisible();
    await expect(notes.getByText('Recorded by the research agent.', { exact: false })).toBeVisible();
    await card.getByText('Review this result', { exact: true }).click();
    await card.getByLabel('Reason for your decision').fill('The exact sealed reference report was checked independently.');
    await card.getByRole('button', { name: 'Record decision' }).click();
    await expect(card.getByText('Accepted by a project reviewer', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(notes.getByText(REHEARSAL_HOSTED_INVESTIGATION.assessment, { exact: true })).toBeVisible();
    const investigationAfterReview = await (await reviewer.request.get(`${apiOrigin}${result.investigation.href}`)).json() as HostedCirclePublicInvestigation;
    expect(investigationAfterReview).toMatchObject({ status: 'VALID', validationCode: 'VALID',
      interpretationStatus: 'AGENT_DECLARED_UNVERIFIED', investigation: REHEARSAL_HOSTED_INVESTIGATION });
    await page.screenshot({ path: 'artifacts/hosted-investigation-desktop.png', fullPage: true });
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('img', { name: 'The accepted Motive arrangement of 101 circles' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'artifacts/hosted-evidence-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
    await card.getByText('Research notes · Propose → Test → Update', { exact: true }).click();
    await expect(card.locator('.hosted-investigation-body')).toBeVisible();
    await card.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.screenshot({ path: 'artifacts/hosted-investigation-mobile.png' });
    await page.screenshot({ path: 'artifacts/hosted-evidence-mobile.png', fullPage: true });

    const persisted = await pool.query(`SELECT result.report_digest,review.decision,review.reviewer_actor_id,
        investigation.status AS investigation_status,investigation.validation_code,investigation.investigation_digest
      FROM motive.hosted_circle_results result JOIN motive.hosted_circle_result_reviews review ON review.result_id=result.id
      JOIN motive.hosted_circle_investigations investigation ON investigation.result_id=result.id WHERE result.id=$1`, [result.id]);
    expect(persisted.rows[0]).toMatchObject({ report_digest: result.reportDigest, decision: 'ACCEPTED', reviewer_actor_id: actorId,
      investigation_status: 'VALID', validation_code: 'VALID', investigation_digest: investigation.binding.investigationDigest });
    const after = await (await reviewer.request.get(`${apiOrigin}/api/public/projects/circle-packing/hosted-results`)).json() as HostedCirclePublicResults;
    expect(after).toMatchObject({ acceptedResults: 1, bestAccepted: { id: result.id, review: { decision: 'ACCEPTED' } } });
  } finally { await reviewer.close(); await pool.end(); }
});
