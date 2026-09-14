import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCommunityCoordinationPlanInput, type CommunityCoordinationPlanInput } from '../../src/lib/community-coordination.ts';
import { ParticipationError, type ParticipationAgentContext, type ParticipationService } from '../participation/service.ts';
import { CommunityCoordinationError, type CommunityCoordinationService } from './service.ts';
import { createCommunityCoordinationRouters } from './router.ts';

const actorId = 'account:coordinator-reviewer';
const projectId = '11111111-1111-4111-8111-111111111111';
const agentTokenId = '22222222-2222-4222-8222-222222222222';
const grantId = '33333333-3333-4333-8333-333333333333';
const turnId = '44444444-4444-4444-8444-444444444444';
const submissionId = '55555555-5555-4555-8555-555555555555';
const planId = '66666666-6666-4666-8666-666666666666';
const validToken = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;
const reportDigest = `sha256:${'c'.repeat(64)}`;
const artifactDigest = `sha256:${'d'.repeat(64)}`;

const grant = {
  id: grantId, projectSlug: 'circle-packing' as const, agentTokenId, status: 'ACTIVE' as const,
  maxTurns: 3, turnsUsed: 0, remainingTurns: 3, expiresAt: '2026-09-10T13:00:00.000Z',
  revokedAt: null, createdAt: '2026-09-10T12:00:00.000Z',
};
const turn = {
  id: turnId, grantId, projectSlug: 'circle-packing' as const, signalDigest: `sha256:${'e'.repeat(64)}`,
  status: 'ACTIVE' as const, expiresAt: '2026-09-10T12:05:00.000Z', hardExpiresAt: '2026-09-10T12:30:00.000Z',
  releasedAt: null, releaseReason: null, completedAt: null, createdAt: '2026-09-10T12:00:00.000Z',
};
const plan: CommunityCoordinationPlanInput = {
  format: 'motive.community-coordination-plan.v1',
  summary: 'Compare one bounded local-search change with the retained checked baseline.',
  limitations: 'One checked result does not establish general method performance.',
  priorities: [{
    kind: 'EXPERIMENT', question: 'Does the bounded change improve the exact retained witness?',
    expectation: 'The changed neighborhood may find a feasible witness with a larger exact score.',
    test: 'Run the declared solver and seed allowance, then submit the best resulting witness for exact checking.',
    positiveInterpretation: 'A larger valid exact score supports testing the change under matched conditions.',
    negativeInterpretation: 'No improvement under this allowance lowers the priority of this narrow configuration.',
    inconclusiveInterpretation: 'A timeout or invalid output does not compare the methods.',
    motiveReferences: [{ submissionId, reportDigest, artifactDigest }],
  }],
};

describe('community coordination routers', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map(async server => {
    server.close(); await once(server, 'close');
  })));

  async function serve(options: { session?: boolean } = {}) {
    const context: ParticipationAgentContext = {
      tokenId: agentTokenId, actorId: `agent:${agentTokenId}`, ownerActorId: actorId,
      projectId, expiresAt: '2026-09-11T12:00:00.000Z',
    };
    const accountState = {
      format: 'motive.community-coordination-account-state.v1' as const, projectSlug: 'circle-packing' as const,
      eligible: false, reason: 'NO_ACTIVE_AGENT_TOKEN' as const, agentTokens: [], grants: [],
    };
    const agentState = {
      format: 'motive.community-coordination-agent-state.v1' as const, state: 'WORKING' as const,
      grant, turn, retryAfterSeconds: null,
    };
    const completed = {
      id: planId, turnId, projectSlug: 'circle-packing' as const, projectRevision: 1,
      signalDigest: turn.signalDigest, planDigest: `sha256:${'f'.repeat(64)}`,
      classification: 'PUBLIC_UNREVIEWED_ADVICE' as const, plan, createdAt: '2026-09-10T12:02:00.000Z', replayed: false,
    };
    const publicProjection = {
      format: 'motive.community-coordination.public.v1' as const, projectSlug: 'circle-packing' as const,
      currentSuggestions: null, history: [], retryAfterSeconds: 30,
      notice: 'Coordinator plans are public unreviewed advice from account-delegated volunteer capacity. They do not authorize work, spending, acceptance, review, or engine writes, and a declared model is not verified.' as const,
    };
    const accountStateCall = vi.fn(async () => accountState);
    const createGrant = vi.fn(async () => ({ grant, replayed: false }));
    const revokeGrant = vi.fn(async () => ({ grant: { ...grant, status: 'REVOKED' as const }, replayed: false }));
    const state = vi.fn(async () => agentState);
    const claim = vi.fn(async () => agentState);
    const renew = vi.fn(async () => ({ turn, replayed: false }));
    const release = vi.fn(async () => ({ turn: { ...turn, status: 'RELEASED' as const,
      releasedAt: '2026-09-10T12:01:00.000Z', releaseReason: 'Another volunteer can take over.' }, replayed: false }));
    const complete = vi.fn(async () => completed);
    const publicProjectionCall = vi.fn(async () => publicProjection);
    const service = { accountState: accountStateCall, createGrant, revokeGrant, state, claim, renew, release, complete,
      publicProjection: publicProjectionCall } as unknown as CommunityCoordinationService;
    const authenticateBearer = vi.fn(async (token: string) => {
      if (token !== validToken) throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid.');
      return context;
    });
    const routers = createCommunityCoordinationRouters({ service,
      participation: { authenticateBearer } as Pick<ParticipationService, 'authenticateBearer'> });
    const falls = { account: 0, agent: 0, public: 0 };
    const app = express();
    app.use('/api/participation/coordination', (req, res, next) => {
      if (options.session !== false) { res.locals.actorId = actorId; res.locals.accountName = 'Volunteer reviewer'; }
      next();
    }, routers.accountRouter, (_req, res) => { falls.account += 1; res.status(597).end(); });
    app.use('/api/agent/coordination', routers.agentRouter,
      (_req, res) => { falls.agent += 1; res.status(598).end(); });
    app.use('/api/public/projects/circle-packing/coordination', routers.publicRouter,
      (_req, res) => { falls.public += 1; res.status(599).end(); });
    const server = app.listen(0); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind');
    return { base: `http://127.0.0.1:${address.port}`, context, accountState, agentState, completed, publicProjection,
      accountStateCall, createGrant, revokeGrant, state, claim, renew, release, complete, publicProjectionCall,
      authenticateBearer, falls };
  }

  const noStore = (response: Response) => expect(response.headers.get('cache-control')).toBe('no-store');
  const mutation = (body: unknown, key: string, token = validToken) => ({ method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
  }, body: JSON.stringify(body) });

  it('keeps the published synthetic plan example synchronized with the shared validator', async () => {
    const guide = await readFile(new URL('../../public/coordination-agents/SKILL.md', import.meta.url), 'utf8');
    const example = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(guide)?.[1];
    expect(example).toBeTruthy();
    expect(isCommunityCoordinationPlanInput(JSON.parse(example!))).toBe(true);
  });

  it('reports ordinary-account eligibility and binds grant creation and revocation to session locals', async () => {
    const fixture = await serve(); const base = `${fixture.base}/api/participation/coordination`;
    const found = await fetch(base); expect(found.status).toBe(200); noStore(found);
    expect(await found.json()).toEqual(fixture.accountState);
    expect(fixture.accountStateCall).toHaveBeenCalledWith(actorId);

    const created = await fetch(base, mutation({ agentTokenId, maxTurns: 3 }, 'coord-create-1'));
    expect(created.status).toBe(201); noStore(created);
    expect(fixture.createGrant).toHaveBeenCalledWith(actorId, { agentTokenId, maxTurns: 3 }, 'coord-create-1');

    const revoked = await fetch(`${base}/${grantId}/revoke`, mutation({}, 'coord-revoke-1'));
    expect(revoked.status).toBe(200); noStore(revoked);
    expect(fixture.revokeGrant).toHaveBeenCalledWith(actorId, grantId, 'coord-revoke-1');

    const missing = await serve({ session: false });
    const unavailable = await fetch(`${missing.base}/api/participation/coordination`);
    expect(unavailable.status).toBe(401); noStore(unavailable);
    expect(missing.accountStateCall).not.toHaveBeenCalled();
  });

  it('uses only the existing bearer context for state, claim, renew, release, and completion', async () => {
    const fixture = await serve(); const base = `${fixture.base}/api/agent/coordination`;
    const cookieOnly = await fetch(base, { headers: { Cookie: 'session=browser-cookie' } });
    expect(cookieOnly.status).toBe(401); noStore(cookieOnly); expect(fixture.authenticateBearer).not.toHaveBeenCalled();

    const found = await fetch(base, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(found.status).toBe(200); noStore(found); expect(await found.json()).toEqual(fixture.agentState);
    expect(fixture.state).toHaveBeenCalledWith(fixture.context);

    const claimed = await fetch(`${base}/claim`, mutation({ grantId }, 'coord-claim-1'));
    expect(claimed.status).toBe(201); noStore(claimed);
    expect(fixture.claim).toHaveBeenCalledWith(fixture.context, { grantId }, 'coord-claim-1');

    const renewed = await fetch(`${base}/turns/${turnId}/renew`, mutation({ grantId }, 'coord-renew-1'));
    expect(renewed.status).toBe(200); noStore(renewed);
    expect(fixture.renew).toHaveBeenCalledWith(fixture.context, { grantId, turnId }, 'coord-renew-1');

    const released = await fetch(`${base}/turns/${turnId}/release`,
      mutation({ grantId, reason: 'Another volunteer can take over.' }, 'coord-release-1'));
    expect(released.status).toBe(200); noStore(released);
    expect(fixture.release).toHaveBeenCalledWith(fixture.context,
      { grantId, turnId, reason: 'Another volunteer can take over.' }, 'coord-release-1');

    const completed = await fetch(`${base}/turns/${turnId}/complete`, mutation({ grantId, plan }, 'coord-complete-1'));
    expect(completed.status).toBe(201); noStore(completed); expect(await completed.json()).toEqual(fixture.completed);
    expect(fixture.complete).toHaveBeenCalledWith(fixture.context, { grantId, turnId, plan }, 'coord-complete-1');
  });

  it('rejects query authority, body authority, malformed bindings, and missing idempotency before service writes', async () => {
    const fixture = await serve(); const accountBase = `${fixture.base}/api/participation/coordination`;
    const agentBase = `${fixture.base}/api/agent/coordination`;
    const responses = [
      await fetch(`${accountBase}?role=OWNER`),
      await fetch(accountBase, mutation({ agentTokenId, maxTurns: 3, actorId: 'account:spoofed' }, 'coord-create-1')),
      await fetch(accountBase, mutation({ agentTokenId, maxTurns: 6 }, 'coord-create-2')),
      await fetch(accountBase, mutation({ agentTokenId, maxTurns: 3 }, '')),
      await fetch(`${agentBase}/claim?grantId=${grantId}`, mutation({ grantId }, 'coord-claim-2')),
      await fetch(`${agentBase}/claim`, mutation({ grantId, token: validToken }, 'coord-claim-3')),
      await fetch(`${agentBase}/turns/not-a-uuid/renew`, mutation({ grantId }, 'coord-renew-2')),
      await fetch(`${agentBase}/turns/${turnId}/release`, mutation({ grantId, reason: '  padded  ' }, 'coord-release-2')),
      await fetch(`${agentBase}/turns/${turnId}/complete`, mutation({ grantId, plan: { ...plan, extra: true } }, 'coord-complete-2')),
    ];
    for (const response of responses) { expect([400, 404]).toContain(response.status); noStore(response); }
    expect(fixture.createGrant).not.toHaveBeenCalled(); expect(fixture.claim).not.toHaveBeenCalled();
    expect(fixture.renew).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it('serves only the standalone public projection and terminates unknown coordination paths', async () => {
    const fixture = await serve(); const base = `${fixture.base}/api/public/projects/circle-packing/coordination`;
    const found = await fetch(base); expect(found.status).toBe(200); noStore(found);
    expect(await found.json()).toEqual(fixture.publicProjection); expect(fixture.publicProjectionCall).toHaveBeenCalledOnce();
    const queried = await fetch(`${base}?actorId=${encodeURIComponent(actorId)}`);
    expect(queried.status).toBe(400); noStore(queried);
    for (const [path, headers] of [
      [`${fixture.base}/api/participation/coordination/unknown`, {}],
      [`${fixture.base}/api/agent/coordination/unknown`, { Authorization: `Bearer ${validToken}` }],
      [`${base}/unknown`, {}],
    ] as const) {
      const response = await fetch(path, { headers }); expect(response.status).toBe(404); noStore(response);
    }
    expect(fixture.falls).toEqual({ account: 0, agent: 0, public: 0 });
  });

  it('returns fixed errors for invalid JSON and unexpected failures without exposing credentials or internals', async () => {
    const fixture = await serve(); const agentBase = `${fixture.base}/api/agent/coordination`;
    const invalidJson = await fetch(`${agentBase}/claim`, { method: 'POST', headers: {
      Authorization: `Bearer ${validToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'coord-claim-1',
    }, body: '{private' });
    expect(invalidJson.status).toBe(400); noStore(invalidJson);
    expect(await invalidJson.json()).toEqual({ error: 'invalid_json', message: 'Community coordination request body is invalid JSON.' });

    fixture.claim.mockRejectedValueOnce(new CommunityCoordinationError('CONFLICT', 'Another coordinator holds the current turn.'));
    const conflict = await fetch(`${agentBase}/claim`, mutation({ grantId }, 'coord-claim-1'));
    expect(conflict.status).toBe(409); noStore(conflict);
    expect(await conflict.json()).toEqual({ error: 'conflict', message: 'Another coordinator holds the current turn.' });

    fixture.state.mockRejectedValueOnce(new Error(`provider failure ${validToken}`));
    const failed = await fetch(agentBase, { headers: { Authorization: `Bearer ${validToken}` } });
    expect(failed.status).toBe(500); noStore(failed);
    const body = JSON.stringify(await failed.json());
    expect(body).toBe('{"error":"internal_error","message":"Community coordination request failed."}');
    expect(body).not.toContain(validToken); expect(body).not.toContain('provider failure');
  });
});
