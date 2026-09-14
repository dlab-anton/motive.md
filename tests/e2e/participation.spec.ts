import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { startHypothesisFixture } from '../fixtures/hypothesis-http.ts';
import { createResearchMemoryService } from '../../server/research-memory/index.ts';
import { setProjectReviewer } from '../../scripts/set-project-reviewer.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';

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

test('a real agent assignment produces immutable evidence, independent review and live UI updates', async ({ browser, playwright }) => {
  test.setTimeout(120000);
  const participant = await browser.newContext({ baseURL: browserOrigin });
  const reviewer = await browser.newContext({ baseURL: browserOrigin });
  const observer = await browser.newContext({ baseURL: browserOrigin });
  const agent = await playwright.request.newContext({ baseURL: apiOrigin });
  const pool = new Pool({ connectionString: process.env.MOTIVE_DATABASE_URL, max: 1 });
  const hypothesis = await startHypothesisFixture();
  const one = { name: 'Pilot Researcher', email: `pilot-${randomUUID()}@example.test`, password: `Test-${randomUUID()}` };
  const two = { name: 'Pilot Reviewer', email: `review-${randomUUID()}@example.test`, password: `Test-${randomUUID()}` };
  try {
    const research = createResearchMemoryService({ pool, vaultKey: Buffer.from(process.env.MOTIVE_FUNDING_VAULT_KEY!, 'base64url') });
    const scope = await research.linkScope('operator:seed', 'circle-packing', hypothesis.input);
    await routeApi(participant); await routeApi(reviewer); await routeApi(observer);
    const signup = await participant.request.post(`${apiOrigin}/api/auth/sign-up/email`, { headers, data: one });
    expect(signup.status()).toBe(200);
    const participantId = (await signup.json()).user.id;
    const signupReviewer = await reviewer.request.post(`${apiOrigin}/api/auth/sign-up/email`, { headers, data: two });
    expect(signupReviewer.status()).toBe(200);
    const reviewerId = (await signupReviewer.json()).user.id;
    expect((await participant.request.get(`${apiOrigin}/api/workspace`)).status()).toBe(200);
    expect((await reviewer.request.get(`${apiOrigin}/api/workspace`)).status()).toBe(200);
    const participantActorId = `account:${participantId}`;
    const reviewerActorId = `account:${reviewerId}`;
    const identities = await pool.query<{ actor_id: string; provider: string; subject_id: string; status: string }>(
      `SELECT actor_id,provider,subject_id,status FROM motive.account_identities
        WHERE actor_id=ANY($1::text[]) ORDER BY actor_id`, [[participantActorId, reviewerActorId]],
    );
    expect(identities.rowCount).toBe(2);
    expect(new Map(identities.rows.map(identity => [identity.actor_id, identity]))).toEqual(new Map([
      [participantActorId, expect.objectContaining({ provider: 'local-better-auth', subject_id: participantId, status: 'ACTIVE' })],
      [reviewerActorId, expect.objectContaining({ provider: 'local-better-auth', subject_id: reviewerId, status: 'ACTIVE' })],
    ]));
    const automaticAuthority = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.memberships WHERE actor_id=ANY($1::text[])) AS memberships,
      (SELECT count(*)::int FROM motive.account_credit_wallets WHERE actor_id=ANY($1::text[])) AS wallets,
      (SELECT count(*)::int FROM motive.participation_agent_tokens WHERE owner_actor_id=ANY($1::text[])) AS credentials`,
    [[participantActorId, reviewerActorId]]);
    expect(automaticAuthority.rows[0]).toEqual({ memberships: 0, wallets: 0, credentials: 0 });
    const page = await participant.newPage();
    await page.goto('/?project=circle-packing');
    await expect(page.getByLabel('Agent name', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Model optional')).toHaveCount(0);
    await page.getByText('Credit my account name, Pilot Researcher, publicly when I contribute.').click();
    await page.getByText('I’ll submit work I have permission to share publicly').click();
    await page.getByRole('button', { name: 'Create project access key' }).click();
    await expect(page.locator('.receipt-title strong')).toHaveText('Project access key created');
    const agentCard = page.locator('.agent-credential').first();
    await expect(agentCard.getByText('Waiting for your agent', { exact: true })).toBeVisible();
    const token = await page.getByLabel('Project access key').inputValue();
    expect(token.length).toBeGreaterThan(32);
    await page.getByRole('button', { name: 'I’ve saved the instructions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect another agent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project access key', exact: true })).toHaveCount(0);
    const agentHeaders = { Authorization: `Bearer ${token}` };
    await expect(page.getByText(hypothesis.input.channelName, { exact: true })).toBeVisible();
    const contextResponse = await agent.get('/api/agent/research-context', { headers: agentHeaders });
    expect(contextResponse.ok(), await contextResponse.text()).toBe(true);
    const researchContext = await contextResponse.json();
    expect(researchContext.scopeId).toBe(scope.scopeId);
    expect(researchContext.hypotheses[0].statement).toBe(hypothesis.statement);
    expect(JSON.stringify(researchContext)).not.toContain(hypothesis.input.tenantId);
    expect(JSON.stringify(researchContext)).not.toContain(hypothesis.input.apiKey);
    const readAssignment = await agent.get('/api/agent/assignment', { headers: agentHeaders });
    expect(readAssignment.ok()).toBe(true);
    const ready = (await readAssignment.json()).assignment;
    expect(ready.status).toBe('AVAILABLE');
    const claim = await agent.post(`/api/agent/assignments/${ready.id}/claim`, { headers: { ...agentHeaders, 'Idempotency-Key': 'claim-first' }, data: {} });
    expect(claim.ok()).toBe(true);
    const claimData = await claim.json();
    const assignment = claimData.assignment ?? claimData;
    expect(assignment.status).toBe('ACTIVE');
    await expect(page.getByRole('link', { name: 'My agents · 1 working', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(agentCard.getByText('Propose / Test · assignment active', { exact: true })).toBeVisible();
    await expect(page.locator('.research-activity-counts > div').filter({has:page.getByText('Agents with active work',{exact:true})}).locator('dd')).toHaveText('1', { timeout: 15000 });
    const experimentProtocol: ExperimentProtocol = {
      format: 'motive.experiment-protocol.v1', procedure: 'synthetic-browser-reference-reproduction/v1',
      inputs: [{ name: 'source', value: 'published-frozen-witness' }, { name: 'solver', value: 'none-fixture-only' }],
      purpose: 'CONTROL',
    };
    const matchesBefore = await agent.post('/api/agent/experiment-protocol-matches', {
      headers: agentHeaders, data: { experimentProtocol },
    });
    expect(matchesBefore.ok()).toBe(true);
    expect((await matchesBefore.json()).matches).toHaveLength(0);
    const initialPlan = {
      experimentProtocol,
      leaseEpoch: assignment.leaseEpoch,
      proposal: 'Check whether the frozen reference reproduces exactly through a fresh contribution.',
      expectation: 'The exact check should retain the reference score without claiming an improvement.',
      conditions: ['Use the unchanged published N=101 witness and preserve its attribution.'],
      researchContext: { scopeId: scope.scopeId, snapshotId: researchContext.snapshotId, snapshotDigest: researchContext.snapshotDigest },
    };
    const intent = await agent.post(`/api/agent/assignments/${ready.id}/intent`, {
      headers: { ...agentHeaders, 'Idempotency-Key': 'intent-first' }, data: initialPlan,
    });
    expect(intent.ok(), await intent.text()).toBe(true);
    await expect(agentCard.getByText(initialPlan.proposal, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.active-research-intents').getByText(initialPlan.proposal, { exact: true })).toBeVisible();
    await expect(page.locator('.project-start-label')).toHaveText('Experiments in progress');
    await page.getByRole('tab', { name: 'Updates', exact: true }).click();
    const researchJournal = page.locator('.research-journal');
    await researchJournal.getByRole('button', { name: 'My agents', exact: true }).click();
    await expect(researchJournal.locator('.journal-active').getByText(initialPlan.proposal, { exact: true })).toBeVisible();
    const witness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    const body = { leaseEpoch: assignment.leaseEpoch, witness, investigation: {
      experimentProtocol,
      format: 'motive.investigation.v1', proposal: 'Reproduce the frozen reference through the contribution flow.',
      expectation: 'The reference should be valid and should not exceed itself.',
      conditions: ['Use the unchanged N=101 frozen reference.'],
      observations: ['The submitted bytes are the published frozen reference.'],
      assessment: 'This checks reproduction; it provides no evidence of a better search strategy.',
      nextAction: 'Try one bounded change to the search method.',
      researchReferences: [{ scopeId: scope.scopeId, snapshotId: researchContext.snapshotId, snapshotDigest: researchContext.snapshotDigest,
        hypothesisId: hypothesis.hypothesisId, observedUpdatedAt: hypothesis.timestamp, evidenceIds: [hypothesis.evidenceId] }],
    } };
    const submitted = await agent.post(`/api/agent/assignments/${ready.id}/submissions`, { headers: { ...agentHeaders, 'Idempotency-Key': 'submit-reference' }, data: body });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const submittedBody = await submitted.json();
    const submission = submittedBody.submission ?? submittedBody;
    expect(submission.reportStatus).toBe('VALID');
    expect(submission.exceedsReference).toBe(false);
    const replay = await agent.post(`/api/agent/assignments/${ready.id}/submissions`, { headers: { ...agentHeaders, 'Idempotency-Key': 'submit-reference' }, data: body });
    expect(replay.ok()).toBe(true);
    const replayBody = await replay.json();
    expect((replayBody.submission ?? replayBody).id).toBe(submission.id);
    const conflict = await agent.post(`/api/agent/assignments/${ready.id}/submissions`, { headers: { ...agentHeaders, 'Idempotency-Key': 'submit-reference' }, data: { ...body, witness: `${witness}\n` } });
    expect(conflict.status()).toBe(409);
    await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
    const participantEvidence = page.locator(`#submission-${submission.id}`);
    await expect(participantEvidence.getByText('Geometry valid', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(participantEvidence.getByText('Awaiting project review', { exact: true })).toBeVisible();
    await expect(participantEvidence.getByRole('heading', { name: body.investigation.proposal, exact: true })).toBeVisible();
    await expect(participantEvidence.locator('.submission-score')).toContainText(String(submission.exactScore));
    await expect(participantEvidence.locator('details.agent-research-notes')).toHaveCount(0);
    await expect(participantEvidence.getByText(body.investigation.assessment, { exact: true })).toHaveCount(0);
    const researchLink = participantEvidence.getByRole('link', { name: 'Read the research behind this result', exact: true });
    await expect(researchLink).toHaveAttribute('href', `/?project=circle-packing&tab=updates#research-${submission.id}`);
    await researchLink.click();
    const submittedUpdate = page.locator(`#research-${submission.id}`);
    await expect(submittedUpdate).toBeVisible({ timeout: 15000 });
    const researchNotes = submittedUpdate.locator('details.agent-research-notes');
    await expect(researchNotes).not.toHaveAttribute('open');
    await researchNotes.getByText(`${submission.agentName}’s full research notes`, { exact: true }).click();
    await expect(researchNotes.getByRole('heading', { name: 'What the agent tried', exact: true })).toBeVisible();
    await expect(researchNotes.getByText(body.investigation.proposal, { exact: true })).toBeVisible();
    await expect(researchNotes.getByText(body.investigation.assessment, { exact: true })).toBeVisible();
    await researchNotes.getByText('Compare with the initial plan', { exact: true }).click();
    await expect(researchNotes.getByText(initialPlan.proposal, { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/participation-research-notes.png', fullPage: true });
    const checkedResultLink = submittedUpdate.getByRole('link', { name: 'See the checked result', exact: true });
    await expect(checkedResultLink).toHaveAttribute('href', `/?project=circle-packing&tab=evidence#submission-${submission.id}`);
    await checkedResultLink.click();
    await expect(participantEvidence).toBeVisible({ timeout: 15000 });
    expect(await setProjectReviewer({ pool, selector: { accountEmail: one.email }, role: 'OWNER', apply: true,
      env: process.env })).toMatchObject({ actorId: participantActorId, role: 'OWNER', status: 'ACTIVE' });
    const selfReview = await participant.request.post(`${apiOrigin}/api/participation/submissions/${submission.id}/reviews`, {
      headers: { ...headers, 'Idempotency-Key': 'self-review-denied' }, data: { decision: 'ACCEPTED', rationale: 'I cannot independently approve my own evidence.' },
    });
    expect(selfReview.status()).toBe(403);
    expect(await setProjectReviewer({ pool, selector: { accountEmail: two.email }, role: 'REVIEWER', apply: true,
      env: process.env })).toMatchObject({ actorId: reviewerActorId, role: 'REVIEWER', status: 'ACTIVE' });
    const reviewPage = await reviewer.newPage();
    await reviewPage.goto('/?project=circle-packing&tab=evidence');
    const reviewEvidence = reviewPage.locator(`#submission-${submission.id}`);
    await reviewEvidence.getByText('Review this result', { exact: true }).click();
    await reviewEvidence.getByLabel('Reason for your decision').fill('Reference reproduction checked independently. Retain this non-improvement as a verified baseline rehearsal.');
    await reviewEvidence.getByRole('button', { name: 'Record decision' }).click();
    await expect(participantEvidence.getByText('Accepted by a project reviewer', { exact: true })).toBeVisible({ timeout: 15000 });
    const observerPage = await observer.newPage();
    await observerPage.goto('/?project=circle-packing');
    const contributorCard = observerPage.locator('.contributor-card').filter({ has: observerPage.getByRole('heading', { name: 'Pilot Researcher', exact: true }) });
    await expect(contributorCard).toBeVisible({ timeout: 15000 });
    await expect(contributorCard.locator('dl > div').filter({ hasText: 'Public experiments' }).locator('dd')).toHaveText('1');
    // Geometry acceptance is a separate review and grants no shared-memory credit.
    await expect(contributorCard.locator('dl > div').filter({ hasText: 'Reviewed artifacts' }).locator('dd')).toHaveText('0');
    const report = await agent.get(submission.reportHref);
    expect(report.ok()).toBe(true);
    const completion = await agent.post(`/api/agent/assignments/${ready.id}/complete`, { headers: { ...agentHeaders, 'Idempotency-Key': 'complete-first' }, data: { leaseEpoch: assignment.leaseEpoch, submissionId: submission.id } });
    expect(completion.ok(), await completion.text()).toBe(true);
    const matchingReplication = await agent.post('/api/agent/experiment-protocol-matches', {
      headers: agentHeaders, data: { experimentProtocol: { ...experimentProtocol, inputs: [...experimentProtocol.inputs].reverse(), purpose: 'REPLICATION' } },
    });
    expect(matchingReplication.ok()).toBe(true);
    const priorExperiments = await matchingReplication.json();
    expect(priorExperiments.matches).toHaveLength(1);
    expect(priorExperiments.matches[0]).toMatchObject({ status: 'COMPLETED', purpose: 'CONTROL', submission: { submissionId: submission.id } });
    await expect(page.locator('.active-research-intents')).toHaveCount(0, { timeout: 15000 });
    const retainedInvestigation = await agent.get(submission.investigationHref);
    expect((await retainedInvestigation.json()).claimIntent.proposal).toBe(initialPlan.proposal);
    const checkedReport = await report.json();
    const publicSummary = {
      question: 'Did reproducing the reference reveal an improvement?',
      finding: 'The protected checker confirmed the reference reproduction and found no improvement.',
    };
    const assessment = await agent.post(`/api/agent/submissions/${submission.id}/post-check-assessment`, {
      headers: {...agentHeaders, 'Idempotency-Key':'post-check-first'}, data: {reportDigest:checkedReport.reportDigest,
        assessment:'The checker confirms a reproduction of the reference, without an improvement.',
        nextAction:'A successor may choose a different strategy from the goal and evidence.', publicSummary},
    });
    expect(assessment.status()).toBe(201);
    expect((await assessment.json()).publicSummary).toEqual(publicSummary);
    const retainedAssessment = await agent.get(`/api/public/projects/circle-packing/submissions/${submission.id}/post-check-assessment`);
    expect(retainedAssessment.status()).toBe(200);
    expect(await retainedAssessment.json()).toMatchObject({
      assessment: 'The checker confirms a reproduction of the reference, without an improvement.',
      nextAction: 'A successor may choose a different strategy from the goal and evidence.',
      publicSummary,
    });
    const reproducibility = await agent.post(`/api/agent/submissions/${submission.id}/reproducibility`, {
      headers:{...agentHeaders,'Idempotency-Key':'source-first'}, data:{reportDigest:checkedReport.reportDigest,
        solverSource:'# Synthetic browser fixture: no solver was run.\n',trialResults:'{"kind":"reference-reproduction-fixture"}\n'},
    });
    expect(reproducibility.status()).toBe(201);
    // Shared-memory admission is distinct from the geometry acceptance above.
    // Exercise the real account API and immutable database ledger from the UI;
    // neither preparing nor deciding may invoke the engine's write operations.
    const memoryPath = `/api/participation/submissions/${submission.id}/research-admission`;
    const selfAdmission = await participant.request.post(`${apiOrigin}${memoryPath}/prepare`, { headers, data: {} });
    expect(selfAdmission.status()).toBe(403);
    const beforeAdmission = await agent.get(`/api/public/projects/circle-packing/submissions/${submission.id}/research-admission`);
    expect((await beforeAdmission.json()).status).toBe('PENDING');
    await reviewPage.getByRole('tab', { name: 'Updates', exact: true }).click();
    // A reviewer opts into a bounded queue; browser observation alone is not
    // agent contact. Leaving a package makes the ordinary review available.
    await reviewPage.getByRole('button', { name: 'To assess', exact: true }).click();
    const queuePanel = reviewPage.locator('.review-queue-access');
    await queuePanel.getByRole('button', { name: 'Create reviewer instructions', exact: true }).click();
    await expect(queuePanel.getByText('Waiting for your agent', { exact: true })).toBeVisible();
    const queueInstructions = await queuePanel.getByRole('textbox', { name: 'Review session instructions', exact: true }).inputValue();
    const queueToken = queueInstructions.match(/motive_review_queue_[a-f0-9]{32}_[A-Za-z0-9_-]{43}/)?.[0];
    expect(Boolean(queueToken)).toBe(true);
    const queueHeaders = { Authorization: `Bearer ${queueToken}`, 'Content-Type': 'application/json' };
    const createdSessions = await (await reviewer.request.get(`${apiOrigin}/api/participation/review-queue-agent-access`)).json();
    expect(createdSessions.grants[0].firstSeenAt).toBeNull();
    const queueClaimKey = `queue-claim-${randomUUID()}`;
    const queueClaim = await agent.post('/api/review-queue-agent/claim', {
      headers: { ...queueHeaders, 'Idempotency-Key': queueClaimKey }, data: {},
    });
    expect(queueClaim.ok()).toBe(true);
    const queueWork = await queueClaim.json();
    expect(queueWork.state).toBe('WORKING');
    expect(queueWork.assignment.submissionId).toBe(submission.id);
    const childHeaders = { Authorization: `Bearer ${queueWork.assignment.token}` };
    const childAssignment = await agent.get('/api/review-agent/assignment', { headers: childHeaders });
    expect(childAssignment.ok()).toBe(true);
    await expect(queuePanel.getByText('Agent opened an experiment', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(queuePanel.getByRole('link', { name: `${publicSummary.question} ↗`, exact: true })).toHaveAttribute('href', `/?project=circle-packing&tab=updates#research-${submission.id}`);
    await expect(queuePanel.getByRole('progressbar')).toHaveAttribute('value', '0');
    await reviewPage.setViewportSize({ width: 390, height: 844 });
    expect(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await queuePanel.screenshot({ path: 'artifacts/review-queue-working-mobile.png', mask: [queuePanel.getByRole('textbox', { name: 'Review session instructions', exact: true })] });
    const queueRelease = await agent.post('/api/review-queue-agent/release', {
      headers: { ...queueHeaders, 'Idempotency-Key': `queue-release-${randomUUID()}` },
      data: { reason: 'Synthetic rehearsal: return this package for the existing independent review test.' },
    });
    expect(queueRelease.ok()).toBe(true);
    expect((await agent.get('/api/review-agent/assignment', { headers: childHeaders })).status()).toBe(401);
    await queuePanel.getByRole('button', { name: 'End this session', exact: true }).click();
    await expect(queuePanel.getByText('Session ended', { exact: true })).toBeVisible();
    const endedQueueRead = await agent.get('/api/review-queue-agent/assignment', { headers: queueHeaders });
    expect([401, 403]).toContain(endedQueueRead.status());
    await reviewPage.setViewportSize({ width: 1280, height: 900 });
    await reviewPage.getByRole('button', { name: 'Everyone', exact: true }).click();
    const reviewStory = reviewPage.locator(`#research-${submission.id}`);
    await expect(reviewStory.getByRole('heading', { name: publicSummary.question, exact: true })).toBeVisible();
    await expect(reviewStory.getByText('Agent summary', { exact: true })).toBeVisible();
    await expect(reviewStory.getByText(publicSummary.finding, { exact: true })).toBeVisible();
    await reviewStory.getByText('Shared memory review', { exact: true }).click();
    await expect(reviewStory.getByText('Awaiting independent review', { exact: true })).toBeVisible();
    await reviewStory.getByRole('button', { name: 'Prepare independent review', exact: true }).click();
    await expect(reviewStory.getByRole('heading', { name: 'The research being reviewed', exact: true })).toBeVisible();
    await expect(reviewStory.locator('.admission-package p').filter({ hasText: publicSummary.question }).first()).toBeVisible();
    await expect(reviewStory.locator('.admission-package').getByText(publicSummary.finding, { exact: true })).toBeVisible();
    await expect(reviewStory.locator('.admission-package')).toContainText('The checker confirms a reproduction of the reference, without an improvement.');
    await reviewStory.getByText('Have my agent review this package', { exact: true }).click();
    await reviewStory.getByRole('button', { name: 'Create one-review access', exact: true }).click();
    await expect(reviewStory.getByText('Waiting for your reviewer agent', { exact: true })).toBeVisible();
    const instructions = await reviewStory.getByLabel('Reviewer agent instructions', { exact: true }).inputValue();
    const reviewBearer = instructions.split('\n')[1]!;
    const reviewHeaders = { Authorization: `Bearer ${reviewBearer}` };
    expect((await agent.get('/api/review-agent/assignment', { headers: agentHeaders })).status()).toBe(401);
    expect((await agent.get('/api/agent/assignment', { headers: reviewHeaders })).status()).toBe(401);
    const assignedReview = await agent.get('/api/review-agent/assignment', { headers: reviewHeaders });
    expect(assignedReview.status()).toBe(200);
    expect((await assignedReview.json()).submissionId).toBe(submission.id);
    await expect(reviewStory.getByText('Agent opened the review', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(reviewStory.getByRole('button', { name: 'Record independent decision', exact: true })).toBeDisabled();
    const reviewDecision = { decision: 'ADMIT', rationale: 'Retain this independently checked reference reproduction with its explicit non-improvement and synthetic-source limitation. It does not support a new solver-performance claim.' };
    const decisionHeaders = { ...reviewHeaders, 'Idempotency-Key': `review-${randomUUID()}` };
    expect((await agent.post('/api/review-agent/decision', { headers: decisionHeaders, data: reviewDecision })).status()).toBe(201);
    expect((await agent.post('/api/review-agent/decision', { headers: decisionHeaders, data: reviewDecision })).status()).toBe(201);
    expect((await agent.post('/api/review-agent/decision', { headers: decisionHeaders, data: { ...reviewDecision, decision: 'DECLINE' } })).status()).toBe(409);
    await expect(reviewStory.getByText('Approved for shared memory', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(reviewStory.getByText('Review decision recorded', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(reviewStory.getByLabel('Reviewer agent instructions', { exact: true })).toHaveCount(0);
    expect(Number((await pool.query('SELECT count(*) AS count FROM motive.hypothesis_submission_delivery_results')).rows[0].count)).toBe(0);
    await expect.poll(async () => {
      const state = await (await agent.get('/api/public/projects/circle-packing')).json();
      return state.contributors.find((item: { displayName: string }) => item.displayName === 'Pilot Researcher')?.reviewedArtifactCount;
    }, { timeout: 15000 }).toBe(1);
    await observerPage.reload();
    await expect(contributorCard.locator('dl > div').filter({ hasText: 'Reviewed artifacts' }).locator('dd')).toHaveText('1', { timeout: 15000 });
    await contributorCard.getByText('Explore contributions', { exact: true }).click();
    const contributionLink = contributorCard.getByRole('link', { name: publicSummary.question, exact: true });
    await expect(contributionLink).toHaveAttribute('href', `/?project=circle-packing&tab=updates#research-${submission.id}`);
    await contributionLink.click();
    await expect(observerPage.locator(`#research-${submission.id}`)).toBeVisible({ timeout: 15000 });
    expect(new URL(observerPage.url()).searchParams.get('tab')).toBe('updates');
    expect(new URL(observerPage.url()).hash).toBe(`#research-${submission.id}`);
    const publicAdmissionText = await (await agent.get(`/api/public/projects/circle-packing/submissions/${submission.id}/research-admission`)).text();
    expect(publicAdmissionText).not.toContain(`account:${reviewerId}`);
    expect(publicAdmissionText).not.toContain('packageDigest');
    await reviewPage.setViewportSize({ width: 320, height: 844 });
    expect(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await reviewStory.locator('.review-agent-access').screenshot({ path: 'artifacts/reviewer-agent-completed-mobile.png' });
    await reviewPage.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const panel = document.querySelector('.research-admission[open]');
      if (panel) window.scrollBy(0, panel.getBoundingClientRect().top - 140);
    });
    await reviewPage.screenshot({ path: 'artifacts/research-admission-review-mobile.png' });
    // A correction appends a decision and updates the public status without
    // overwriting the original review or counting a second experiment.
    await reviewStory.getByRole('button', { name: 'Refresh the review package', exact: true }).click();
    await reviewStory.getByLabel('Shared memory decision', { exact: true }).selectOption('DECLINE');
    await reviewStory.getByLabel('What supports your decision?').fill('Correction: keep this synthetic rehearsal in Motive. Its source fixture does not reproduce an actual solver run, so shared research memory would be misleading.');
    await reviewStory.getByRole('button', { name: 'Record independent decision', exact: true }).click();
    await expect(reviewStory.getByText('Not approved for shared memory', { exact: true })).toBeVisible({ timeout: 15000 });
    const reviewCount = await pool.query('SELECT count(*) AS count FROM motive.hypothesis_submission_delivery_admission_decisions');
    expect(Number(reviewCount.rows[0].count)).toBe(2);
    await expect.poll(async () => {
      const state = await (await agent.get('/api/public/projects/circle-packing')).json();
      return state.contributors.find((item: { displayName: string }) => item.displayName === 'Pilot Researcher')?.reviewedArtifactCount;
    }, { timeout: 15000 }).toBe(0);
    await observerPage.goto('/?project=circle-packing');
    await expect(contributorCard.locator('dl > div').filter({ hasText: 'Reviewed artifacts' }).locator('dd')).toHaveText('0', { timeout: 15000 });
    await observerPage.setViewportSize({ width: 320, height: 844 });
    await expect(contributorCard).toBeVisible();
    expect(await observerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await contributorCard.screenshot({ path: 'artifacts/participation-contributor-card-mobile.png' });
    await page.reload();
    await expect(agentCard.getByText('Cycle recorded', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(agentCard.getByText('1 cycle recorded', {exact:true})).toBeVisible();
    await expect(agentCard.locator('.agent-latest-finding').getByRole('heading', { name: publicSummary.question, exact: true })).toBeVisible();
    await expect(agentCard.locator('.agent-latest-finding').getByText('Agent summary', { exact: true })).toBeVisible();
    await expect(agentCard.locator('.agent-latest-finding').getByText(publicSummary.finding, { exact: true })).toBeVisible();
    await expect(page.locator('.agent-steps')).toHaveCount(0);
    await expect(page.locator('.agent-reconnect')).not.toHaveAttribute('open');
    await page.getByRole('tab', { name: 'Updates', exact: true }).click();
    await researchJournal.getByRole('button', { name: 'My agents', exact: true }).click();
    const ownUpdate = page.locator(`#research-${submission.id}`);
    await ownUpdate.getByText('Shared memory review', { exact: true }).click();
    await expect(ownUpdate.getByText('This is your contribution. A different authorized project reviewer must assess it.', { exact: true })).toBeVisible();
    await expect(ownUpdate.getByRole('button', { name: 'Prepare independent review', exact: true })).toHaveCount(0);
    await expect(ownUpdate.getByRole('heading', { name: publicSummary.question, exact: true })).toBeVisible();
    await expect(ownUpdate.getByText('Agent summary', { exact: true })).toBeVisible();
    await expect(ownUpdate.getByText(publicSummary.finding, { exact: true })).toBeVisible();
    await expect(ownUpdate.getByText('Question explored', { exact: true })).toBeVisible();
    const completedResearchNotes = ownUpdate.locator('details.agent-research-notes');
    await expect(completedResearchNotes).not.toHaveAttribute('open');
    await completedResearchNotes.getByText(`${submission.agentName}’s full research notes`, { exact: true }).click();
    await expect(completedResearchNotes.getByText(body.investigation.proposal, { exact: true })).toBeVisible();
    await expect(completedResearchNotes.getByText('The checker confirms a reproduction of the reference, without an improvement.', { exact: true })).toBeVisible();
    const followupSummary = completedResearchNotes.getByText('Possible follow-up · contributor suggestion',{exact:true});
    await expect(followupSummary).toBeVisible();
    await expect(followupSummary.locator('..')).not.toHaveAttribute('open');
    const evidenceLink = ownUpdate.getByRole('link', { name: 'See the checked result', exact: true });
    await expect(evidenceLink).toHaveAttribute('href', `/?project=circle-packing&tab=evidence#submission-${submission.id}`);
    await evidenceLink.click();
    await expect(participantEvidence).toBeVisible({ timeout: 15000 });
    await expect(participantEvidence.locator('details.agent-research-notes')).toHaveCount(0);
    await expect(participantEvidence.getByText('The checker confirms a reproduction of the reference, without an improvement.', { exact: true })).toHaveCount(0);
    await participantEvidence.getByText('Reproduce this experiment · source and trials', {exact:true}).click();
    await expect(participantEvidence.getByRole('link',{name:/Download solver source/})).toBeVisible();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('img', { name: 'The accepted Motive arrangement of 101 circles' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Pilot Researcher', { exact: true })).toBeVisible();
    await expect(page.locator('.research-activity-counts > div').filter({has:page.getByText('Agents with active work',{exact:true})}).locator('dd')).toHaveText('0', { timeout: 15000 });
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: 'artifacts/participation-rehearsal-accepted.png', fullPage: true });
    const projection = await (await agent.get('/api/public/projects/circle-packing')).json();
    expect(projection.totalSubmissions).toBe(1); expect(projection.acceptedResults).toBe(1);
    expect(JSON.stringify(projection)).not.toContain(one.email); expect(JSON.stringify(projection)).not.toContain(token);
    try {
      await pool.query('CREATE TABLE motive.qa_local_deletion_failure(actor_id TEXT PRIMARY KEY)');
      await pool.query('INSERT INTO motive.qa_local_deletion_failure(actor_id) VALUES($1)', [participantActorId]);
      await pool.query(`CREATE FUNCTION motive.qa_fail_local_membership_revocation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF EXISTS(SELECT 1 FROM motive.qa_local_deletion_failure WHERE actor_id=NEW.actor_id) THEN
            RAISE EXCEPTION 'isolated local deletion revocation failure';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER qa_fail_local_membership_revocation
        BEFORE UPDATE OF revoked_at ON motive.memberships FOR EACH ROW
        WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
        EXECUTE FUNCTION motive.qa_fail_local_membership_revocation()`);
      const interruptedDeletion = await participant.request.post(`${apiOrigin}/api/auth/delete-user`, { headers,
        data: { password: one.password } });
      expect(interruptedDeletion.status()).toBe(500);
      const pending = await pool.query(`SELECT identity.provider,identity.subject_id,identity.status,identity.deleted_at,
        membership.revoked_at AS membership_revoked_at,token.revoked_at AS token_revoked_at
        FROM motive.account_identities identity
        JOIN motive.memberships membership ON membership.actor_id=identity.actor_id
        JOIN motive.participation_agent_tokens token ON token.owner_actor_id=identity.actor_id
        WHERE identity.actor_id=$1`, [participantActorId]);
      expect(pending.rowCount).toBe(1);
      expect(pending.rows[0]).toMatchObject({
        provider: 'local-better-auth', subject_id: participantId, status: 'DELETION_PENDING',
        deleted_at: null, membership_revoked_at: null, token_revoked_at: null,
      });
      const nativeLogin = await participant.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
        headers, data: { email: one.email, password: one.password },
      });
      expect(nativeLogin.ok()).toBe(true);
      expect((await nativeLogin.json()).user.id).toBe(participantId);
      expect((await participant.request.get(`${apiOrigin}/api/participation/me`)).status()).toBe(403);
      expect((await agent.get('/api/agent/assignment', { headers: agentHeaders })).status()).toBe(401);
      expect((await agent.post(`/api/agent/assignments/${ready.id}/claim`, {
        headers: { ...agentHeaders, 'Idempotency-Key': 'pending-delete-claim-denied' }, data: {},
      })).status()).toBe(401);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS qa_fail_local_membership_revocation ON motive.memberships');
      await pool.query('DROP FUNCTION IF EXISTS motive.qa_fail_local_membership_revocation()');
      await pool.query('DROP TABLE IF EXISTS motive.qa_local_deletion_failure');
    }
    const deleted = await participant.request.post(`${apiOrigin}/api/auth/delete-user`, { headers,
      data: { password: one.password } });
    expect(deleted.ok(), await deleted.text()).toBe(true);
    expect((await agent.get('/api/agent/assignment', { headers: agentHeaders })).status()).toBe(401);
    expect((await participant.request.get(`${apiOrigin}/api/participation/me`)).status()).toBe(401);
    const retired = await pool.query(`SELECT identity.provider,identity.subject_id,identity.status,identity.deleted_at,
      membership.revoked_at AS membership_revoked_at,token.revoked_at AS token_revoked_at
      FROM motive.account_identities identity
      JOIN motive.memberships membership ON membership.actor_id=identity.actor_id
      JOIN motive.participation_agent_tokens token ON token.owner_actor_id=identity.actor_id
      WHERE identity.actor_id=$1`, [participantActorId]);
    expect(retired.rowCount).toBe(1);
    expect(retired.rows[0]).toMatchObject({ provider: 'local-better-auth', subject_id: participantId, status: 'DELETED' });
    expect(retired.rows[0].deleted_at).not.toBeNull();
    expect(retired.rows[0].membership_revoked_at).not.toBeNull();
    expect(retired.rows[0].token_revoked_at).not.toBeNull();
    const deniedFormerReviewer = await participant.request.post(`${apiOrigin}/api/participation/submissions/${submission.id}/reviews`, {
      headers: { ...headers, 'Idempotency-Key': 'deleted-account-review-denied' },
      data: { decision: 'ACCEPTED', rationale: 'A deleted account must have no retained project authority.' },
    });
    expect(deniedFormerReviewer.status()).toBe(401);
    const retainedProjection = await (await agent.get('/api/public/projects/circle-packing')).json();
    expect(retainedProjection.totalSubmissions).toBe(1);
    expect(retainedProjection.acceptedResults).toBe(1);
    expect(await (await agent.get(submission.reportHref)).json()).toMatchObject({ reportDigest: checkedReport.reportDigest });
    expect((await participant.request.post(`${apiOrigin}/api/participation/join`, { headers: { Origin: 'https://untrusted.example', 'Idempotency-Key': 'wrong-origin' }, data: {} })).status()).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'artifacts/participation-rehearsal-mobile.png', fullPage: true });
  } finally { await Promise.all([participant.close(), reviewer.close(), observer.close(), agent.dispose(), pool.end(), hypothesis.close()]); }
});

test('OpenRouter returns through the real app, stores a capped budget and disconnects', async ({ browser }) => {
  test.skip(true, 'OpenRouter UI is intentionally disabled during the connected-agent and credits pilot. Re-enable this retained flow with that capability.');
  test.setTimeout(60000);
  const context = await browser.newContext({ baseURL: browserOrigin });
  const pool = new Pool({ connectionString: process.env.MOTIVE_DATABASE_URL, max: 1 });
  try {
    await routeApi(context);
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
      name: 'Browser Sponsor', email: `sponsor-${randomUUID()}@example.test`, password: `Test-${randomUUID()}`,
    } });
    expect(signup.ok()).toBe(true);
    const actorId = `account:${(await signup.json()).user.id}`;
    const page = await context.newPage();
    await page.goto('/?project=circle-packing');
    await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
    await page.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
    await expect(page.getByText('OpenRouter connected', { exact: true })).toBeVisible({ timeout: 15000 });
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    expect(new URL(page.url()).searchParams.has('openrouter_flow')).toBe(false);
    await expect(page.getByLabel('Model to fund', { exact: true })).toHaveValue('openai/gpt-6-astra');
    await page.getByLabel('Maximum project budget · USD').fill('1.00');
    await page.getByRole('button', { name: 'Authorize $1.00 budget', exact: true }).click();
    await expect(page.getByText('Your project authorizations', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for this model’s verified run connection', { exact: true })).toBeVisible();
    const status = await (await context.request.get(`${apiOrigin}/api/funding/openrouter`)).json();
    expect(status.connection.status).toBe('CONNECTED'); expect(status.budgets).toHaveLength(1);
    expect(status.budgets[0]).toMatchObject({ model: 'openai/gpt-6-astra', limitUsd: '1', status: 'WAITING_TO_ACTIVATE', grantId: null });
    expect(JSON.stringify(status)).not.toContain('sk-or-');
    const stored = await pool.query('SELECT encrypted_credential FROM motive.provider_connections WHERE owner_actor_id=$1', [actorId]);
    expect(stored.rows[0].encrypted_credential.toString('utf8')).not.toContain('sk-or-');
    const journal = await pool.query('SELECT authorized_amount::text,consumed_amount::text FROM motive.funding_sources WHERE owner_actor_id=$1', [actorId]);
    expect(journal.rowCount).toBe(1); expect(Number(journal.rows[0].authorized_amount)).toBe(1); expect(Number(journal.rows[0].consumed_amount)).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.openrouter-funding').screenshot({ path: 'artifacts/openrouter-rehearsal-budget.png' });
    await page.getByRole('button', { name: 'Disconnect OpenRouter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect OpenRouter', exact: true })).toBeVisible({ timeout: 15000 });
    const disconnected = await (await context.request.get(`${apiOrigin}/api/funding/openrouter`)).json();
    expect(disconnected.connection.status).toBe('DISCONNECTED'); expect(disconnected.budgets[0].status).toBe('REVOKED');
  } finally { await context.close(); await pool.end(); }
});
