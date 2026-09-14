import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { AccountError } from '../accounts/types.ts';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

it('forwards unavailable owner checks without running work, distinguishes inactive owners, and recovers on a fresh check', async () => {
  const upstream = new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
  const isActorActive = vi.fn()
    .mockRejectedValueOnce(upstream)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`,
    ownerActorId: `account:${randomUUID()}`, projectId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const agentWorkQueue = vi.fn(async () => ({ nextTask: { kind: 'DISCOVERY' } }));
  const service = { authenticateBearer: async () => context, agentWorkQueue } as unknown as ParticipationService;
  const { agentRouter } = createParticipationRouters({ service, isActorActive });
  const app = express(); app.use('/api/agent', agentRouter);
  const forwarded: unknown[] = [];
  // Observe the error passed to the application handler; server/index.ts maps AccountError this way.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    forwarded.push(error);
    if (error instanceof AccountError) res.status(error.status).json({ error: error.code.toLowerCase(), message: error.message });
    else res.status(500).end();
  });
  const server = app.listen(0); await once(server, 'listening');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    const request = () => fetch(`http://127.0.0.1:${address.port}/api/agent/work-queue`, { headers: { Authorization: 'Bearer test-token' } });
    const unavailable = await request(); expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: 'upstream', message: 'The account provider is unavailable.' });
    expect(forwarded).toEqual([upstream]); expect(agentWorkQueue).not.toHaveBeenCalled();
    const inactive = await request(); expect(inactive.status).toBe(401);
    expect(await inactive.json()).toEqual({ error: 'unauthorized', message: 'The owning account is no longer active.' });
    expect(agentWorkQueue).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
    expect(agentWorkQueue).toHaveBeenCalledExactlyOnceWith(context);
    expect(isActorActive).toHaveBeenCalledTimes(3);
  } finally { server.close(); await once(server, 'close'); }
});
