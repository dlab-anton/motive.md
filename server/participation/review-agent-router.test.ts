import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SubmissionAdmissionError,
  type HypothesisSubmissionAdmissionService,
} from '../research-memory/submission-admission.ts';
import { createResearchAdmissionAgentRouters } from './review-agent-router.ts';

const actorId = 'account:reviewer-account';
const submissionId = '11111111-1111-4111-8111-111111111111';
const accessId = '22222222-2222-4222-8222-222222222222';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const projectId = '44444444-4444-4444-8444-444444444444';
const scopeId = '55555555-5555-4555-8555-555555555555';
const snapshotId = '66666666-6666-4666-8666-666666666666';
const packageDigest = `sha256:${'a'.repeat(64)}`;
const snapshotDigest = `sha256:${'d'.repeat(64)}`;
const validToken = `motive_review_${'c'.repeat(32)}_${'t'.repeat(43)}`;
const rationale = 'Retain this exact negative result as useful shared research context.';

describe('research admission review-agent routers', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map(async server => { server.close(); await once(server, 'close'); })));

  async function serve(options: { session?: boolean } = {}) {
    const access = { id: accessId, submissionId, packageDigest, expectedDecisionId: null, status: 'READY' as const,
      expiresAt: '2026-09-10T00:00:00.000Z', firstSeenAt: null, lastSeenAt: null, consumedAt: null,
      revokedAt: null, createdAt: '2026-09-09T00:00:00.000Z' };
    const context = { accessId, tokenDigest: `sha256:${'b'.repeat(64)}`, reviewerActorId: actorId,
      projectId, submissionId, deliveryId, packageDigest, expectedDecisionId: null };
    const assignment = { format: 'motive.research-admission-agent-assignment/0.1' as const, accessId, submissionId,
      package: { format: 'motive.research-delivery-review-package/0.1' }, packageDigest, expectedDecisionId: null,
      expiresAt: access.expiresAt, reportHref: `/report/${submissionId}`, investigationHref: null, reproducibilityHref: null,
      researchSnapshots: [{ scopeId, snapshotId, snapshotDigest, declaredIn: ['PRE_TEST_INTENT' as const],
        href: `/api/review-agent/research-context/snapshots/${snapshotId}` }] };
    const snapshot = { format: 'motive.research-context.v1' as const, snapshotId, scopeId,
      projectSlug: 'circle-packing', channelName: 'circle-packing', channelGoal: 'Test bounded candidates.',
      retrievedAt: '2026-09-08T00:00:00.000Z', snapshotDigest, hypotheses: [], hypothesesTotal: 0,
      hypothesesTruncated: false, activeHypothesesTotal: 0, archivedHypothesesTotal: 0, insights: [],
      insightsTotal: 0, insightsTruncated: false,
      page: { activeOffset: 0, archivedOffset: 0, insightOffset: 0, activeLimit: 6 as const,
        archivedLimit: 6 as const, insightLimit: 20 as const },
      notice: 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.' as const };
    const decision = { format: 'motive.research-admission-agent-decision/0.1' as const, submissionId, packageDigest,
      decision: 'ADMIT' as const, rationale, reviewedAt: '2026-09-09T00:01:00.000Z' };
    const getAgentAccess = vi.fn(async () => ({ access }));
    const issueAgentAccess = vi.fn(async () => ({ access, token: validToken }));
    const revokeAgentAccess = vi.fn(async () => ({ access: { ...access, status: 'REVOKED' as const,
      revokedAt: '2026-09-09T00:02:00.000Z' } }));
    const authenticateReviewAgent = vi.fn(async (token: string) => {
      if (token !== validToken) throw new SubmissionAdmissionError('UNAUTHORIZED', 'Review agent access is unavailable.', 401);
      return context;
    });
    const reviewAgentAssignment = vi.fn(async () => assignment);
    const reviewAgentSnapshot = vi.fn(async () => snapshot);
    const decideAdmissionFromAgent = vi.fn(async () => decision);
    const service = { getAgentAccess, issueAgentAccess, revokeAgentAccess, authenticateReviewAgent,
      reviewAgentAssignment, reviewAgentSnapshot, decideAdmissionFromAgent } as unknown as HypothesisSubmissionAdmissionService;
    const routers = createResearchAdmissionAgentRouters(service);
    let accountFallthrough = 0; let agentFallthrough = 0;
    const app = express();
    app.use('/api/participation', (req, res, next) => {
      if (options.session !== false) { res.locals.actorId = actorId; res.locals.accountName = 'Independent reviewer'; }
      next();
    }, routers.accountRouter, (_req, res) => { accountFallthrough += 1; res.status(599).json({ leaked: true }); });
    app.use('/api/review-agent', routers.agentRouter,
      (_req, res) => { agentFallthrough += 1; res.status(599).json({ leaked: true }); });
    const server = app.listen(0); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind');
    return { base: `http://127.0.0.1:${address.port}`, access, context, assignment, snapshot, decision,
      getAgentAccess, issueAgentAccess, revokeAgentAccess, authenticateReviewAgent,
      reviewAgentAssignment, reviewAgentSnapshot, decideAdmissionFromAgent,
      fallthrough: () => ({ account: accountFallthrough, agent: agentFallthrough }) };
  }

  function expectNoStore(response: Response) { expect(response.headers.get('cache-control')).toBe('no-store'); }

  it('uses session identity for account access issue and revocation with exact idempotency inputs', async () => {
    const fixture = await serve();
    const base = `${fixture.base}/api/participation/submissions/${submissionId}/research-admission/agent-access`;
    const found = await fetch(base); expect(found.status).toBe(200); expectNoStore(found);
    expect(await found.json()).toEqual({ access: fixture.access });
    expect(fixture.getAgentAccess).toHaveBeenCalledWith(actorId, submissionId);

    const issueInput = { packageDigest, expectedDecisionId: null };
    const issued = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'Idempotency-Key': 'issue-access-1' }, body: JSON.stringify(issueInput) });
    expect(issued.status).toBe(201); expectNoStore(issued); expect(await issued.json()).toEqual({ access: fixture.access, token: validToken });
    expect(fixture.issueAgentAccess).toHaveBeenCalledWith(actorId, submissionId, issueInput, 'issue-access-1');

    const revoked = await fetch(`${base}/${accessId}/revoke`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': 'revoke-access-1' }, body: '{}' });
    expect(revoked.status).toBe(200); expectNoStore(revoked);
    expect(fixture.revokeAgentAccess).toHaveBeenCalledWith(actorId, submissionId, accessId, 'revoke-access-1');
  });

  it('keeps the review-agent namespace bearer-only and never accepts cookies or body authority', async () => {
    const fixture = await serve(); const base = `${fixture.base}/api/review-agent`;
    const cookieOnly = await fetch(`${base}/assignment`, { headers: { Cookie: 'session=browser-cookie' } });
    expect(cookieOnly.status).toBe(401); expectNoStore(cookieOnly); expect(fixture.authenticateReviewAgent).not.toHaveBeenCalled();

    const assignment = await fetch(`${base}/assignment`, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(assignment.status).toBe(200); expectNoStore(assignment); expect(await assignment.json()).toEqual(fixture.assignment);
    expect(fixture.authenticateReviewAgent).toHaveBeenCalledWith(validToken);
    expect(fixture.reviewAgentAssignment).toHaveBeenCalledWith(fixture.context);

    const retained = await fetch(`${base}/research-context/snapshots/${snapshotId}`, {
      headers: { Authorization: `Bearer ${validToken}` } });
    expect(retained.status).toBe(200); expectNoStore(retained); expect(await retained.json()).toEqual(fixture.snapshot);
    expect(fixture.reviewAgentSnapshot).toHaveBeenCalledWith(fixture.context, snapshotId);

    const body = { decision: 'ADMIT', rationale };
    const decided = await fetch(`${base}/decision`, { method: 'POST', headers: { Authorization: `Bearer ${validToken}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'agent-decision-1' }, body: JSON.stringify(body) });
    expect(decided.status).toBe(201); expectNoStore(decided); expect(await decided.json()).toEqual(fixture.decision);
    expect(fixture.decideAdmissionFromAgent).toHaveBeenCalledWith(fixture.context, body, 'agent-decision-1');

    const spoofed = await fetch(`${base}/decision`, { method: 'POST', headers: { Authorization: `Bearer ${validToken}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'agent-decision-2' },
      body: JSON.stringify({ ...body, actorId: 'account:spoofed', role: 'OWNER', accessId }) });
    expect(spoofed.status).toBe(400); expectNoStore(spoofed);
    expect(fixture.decideAdmissionFromAgent).toHaveBeenCalledTimes(1);
  });

  it('rejects missing session, unknown fields, queries, malformed bindings, and missing keys before writes', async () => {
    const missing = await serve({ session: false });
    const missingResponse = await fetch(`${missing.base}/api/participation/submissions/${submissionId}/research-admission/agent-access`);
    expect(missingResponse.status).toBe(401); expectNoStore(missingResponse); expect(missing.getAgentAccess).not.toHaveBeenCalled();

    const fixture = await serve(); const base = `${fixture.base}/api/participation/submissions/${submissionId}/research-admission/agent-access`;
    const request = (path: string, body: unknown, key = 'issue-access-1') => fetch(path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    for (const response of [
      await request(base, { packageDigest, expectedDecisionId: null, actorId: 'account:spoofed' }),
      await request(base, { packageDigest: 'bad', expectedDecisionId: null }),
      await request(base, { packageDigest, expectedDecisionId: accessId.replace(/^2/, 'A') }),
      await request(base, { packageDigest, expectedDecisionId: null }, ''),
      await request(`${base}?role=OWNER`, { packageDigest, expectedDecisionId: null }),
      await request(`${base}/${accessId}/revoke`, { actorId }, 'revoke-access-1'),
    ]) { expect(response.status).toBe(400); expectNoStore(response); }
    expect(fixture.issueAgentAccess).not.toHaveBeenCalled(); expect(fixture.revokeAgentAccess).not.toHaveBeenCalled();

    const agentBase = `${fixture.base}/api/review-agent`;
    const queried = await fetch(`${agentBase}/assignment?submissionId=${submissionId}`, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(queried.status).toBe(400); expectNoStore(queried); expect(fixture.reviewAgentAssignment).not.toHaveBeenCalled();
    const snapshotQueried = await fetch(`${agentBase}/research-context/snapshots/${snapshotId}?scopeId=${scopeId}`, {
      headers: { Authorization: `Bearer ${validToken}` } });
    expect(snapshotQueried.status).toBe(400); expectNoStore(snapshotQueried); expect(fixture.reviewAgentSnapshot).not.toHaveBeenCalled();
    const malformedSnapshot = await fetch(`${agentBase}/research-context/snapshots/not-a-uuid`, {
      headers: { Authorization: `Bearer ${validToken}` } });
    expect(malformedSnapshot.status).toBe(404); expectNoStore(malformedSnapshot); expect(fixture.reviewAgentSnapshot).not.toHaveBeenCalled();
    const malformed = await fetch(`${agentBase}/decision`, { method: 'POST', headers: { Authorization: `Bearer ${validToken}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'agent-decision-1' }, body: JSON.stringify({ decision: 'ACCEPTED', rationale }) });
    expect(malformed.status).toBe(400); expectNoStore(malformed); expect(fixture.decideAdmissionFromAgent).not.toHaveBeenCalled();
  });

  it('terminates unknown routes and sanitizes admission, JSON, and unexpected failures', async () => {
    const fixture = await serve();
    const accountUnknown = await fetch(`${fixture.base}/api/participation/research-admission/not-a-route`);
    expect(accountUnknown.status).toBe(404); expectNoStore(accountUnknown);
    const agentUnknown = await fetch(`${fixture.base}/api/review-agent/not-a-route`, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(agentUnknown.status).toBe(404); expectNoStore(agentUnknown); expect(fixture.fallthrough()).toEqual({ account: 0, agent: 0 });

    fixture.getAgentAccess.mockRejectedValueOnce(new SubmissionAdmissionError('FORBIDDEN', 'Current reviewer authority is required.', 403));
    const accountBase = `${fixture.base}/api/participation/submissions/${submissionId}/research-admission/agent-access`;
    const denied = await fetch(accountBase); expect(denied.status).toBe(403); expectNoStore(denied);
    expect(await denied.json()).toEqual({ error: 'forbidden', message: 'Current reviewer authority is required.' });

    fixture.issueAgentAccess.mockRejectedValueOnce(new SubmissionAdmissionError('CONFLICT',
      'Idempotency-Key is already bound to another review access request.', 409));
    const conflict = await fetch(accountBase, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'Idempotency-Key': 'issue-access-1' }, body: JSON.stringify({ packageDigest, expectedDecisionId: null }) });
    expect(conflict.status).toBe(409); expectNoStore(conflict);
    expect(await conflict.json()).toEqual({ error: 'conflict',
      message: 'Idempotency-Key is already bound to another review access request.' });

    const invalidJson = await fetch(`${fixture.base}/api/review-agent/decision`, { method: 'POST', headers: {
      Authorization: `Bearer ${validToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'agent-decision-1' }, body: '{private' });
    expect(invalidJson.status).toBe(400); expectNoStore(invalidJson);
    expect(JSON.stringify(await invalidJson.json())).not.toContain('private');

    fixture.reviewAgentAssignment.mockRejectedValueOnce(new Error('provider failure containing raw-token'));
    const failed = await fetch(`${fixture.base}/api/review-agent/assignment`, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(failed.status).toBe(500); expectNoStore(failed);
    const failedBody = JSON.stringify(await failed.json()); expect(failedBody).toBe('{"error":"internal_error","message":"Research review agent request failed."}');
    expect(failedBody).not.toContain(validToken); expect(failedBody).not.toContain('provider failure');
  });
});
