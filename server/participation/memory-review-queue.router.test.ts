import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createParticipationRouters } from './router.ts';
import { ParticipationError, type ParticipationService } from './service.ts';

async function listening(app: express.Express) {
  const server = app.listen(0); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe('shared-memory review queue route', () => {
  it('derives the reviewer from the account boundary and strictly validates its sole cursor', async () => {
    const actorId = `account:${randomUUID()}`; const cursor = randomUUID();
    const memoryReviewQueue = vi.fn(async (_actorId: string, _before?: string) => ({
      format: 'motive.research-journal-page/0.1' as const, items: [], nextCursor: null,
    }));
    const { accountRouter } = createParticipationRouters({
      service: { memoryReviewQueue } as unknown as ParticipationService, isActorActive: async () => true,
    });
    const app = express(); app.use('/api/participation', (req, res, next) => {
      if (req.get('Authorization') === 'Bearer current-session') {
        res.locals.actorId = actorId; res.locals.accountName = 'Current reviewer';
      }
      next();
    }, accountRouter);
    const { server, origin } = await listening(app);
    const url = `${origin}/api/participation/memory-review-queue`;
    const authenticated = { headers: { Authorization: 'Bearer current-session' } };
    try {
      const anonymous = await fetch(url);
      expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');
      expect((await fetch(url, authenticated)).status).toBe(200);
      const next = await fetch(`${url}?before=${cursor}`, authenticated);
      expect(next.status).toBe(200); expect(next.headers.get('cache-control')).toBe('no-store');
      expect(memoryReviewQueue.mock.calls).toEqual([[actorId, undefined], [actorId, cursor]]);

      for (const query of [`other=${cursor}`, `before=${cursor}&before=${cursor}`, 'before=',
        `before=${cursor.toUpperCase()}`, 'before=not-a-uuid']) {
        const response = await fetch(`${url}?${query}`, authenticated);
        expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(memoryReviewQueue).toHaveBeenCalledTimes(2);
    } finally { server.close(); await once(server, 'close'); }
  });

  it('keeps current-authority denials private from caches', async () => {
    const memoryReviewQueue = vi.fn(async () => {
      throw new ParticipationError('FORBIDDEN', 'Current project reviewer authority is required.');
    });
    const { accountRouter } = createParticipationRouters({
      service: { memoryReviewQueue } as unknown as ParticipationService, isActorActive: async () => true,
    });
    const app = express(); app.use('/api/participation', (_req, res, next) => {
      res.locals.actorId = `account:${randomUUID()}`; res.locals.accountName = 'Inactive reviewer'; next();
    }, accountRouter);
    const { server, origin } = await listening(app);
    try {
      const response = await fetch(`${origin}/api/participation/memory-review-queue`);
      expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'forbidden', message: 'Current project reviewer authority is required.' });
    } finally { server.close(); await once(server, 'close'); }
  });
});
