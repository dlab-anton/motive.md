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

describe('finding review queue route', () => {
  it('derives the reviewer from the account boundary and strictly validates its sole cursor', async () => {
    const actorId = `account:${randomUUID()}`; const cursor = randomUUID();
    const findingReviewQueue = vi.fn(async (_actorId: string, _before?: string) => ({
      format: 'motive.research-journal-page/0.1' as const, items: [], nextCursor: null,
    }));
    const service = { findingReviewQueue } as unknown as ParticipationService;
    const { accountRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express();
    app.use('/api/participation', (req, res, next) => {
      if (req.get('Authorization') === 'Bearer current-session') {
        res.locals.actorId = actorId; res.locals.accountName = 'Current reviewer';
      }
      next();
    }, accountRouter);
    const { server, origin } = await listening(app);
    const url = `${origin}/api/participation/finding-review-queue`;
    const authenticated = { headers: { Authorization: 'Bearer current-session' } };
    try {
      const anonymous = await fetch(url);
      expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');

      const first = await fetch(url, authenticated);
      expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
      const next = await fetch(`${url}?before=${cursor}`, authenticated);
      expect(next.status).toBe(200); expect(next.headers.get('cache-control')).toBe('no-store');
      expect(findingReviewQueue.mock.calls).toEqual([[actorId, undefined], [actorId, cursor]]);

      for (const query of [`other=${cursor}`, `before=${cursor}&before=${cursor}`, 'before=',
        `before=${cursor.toUpperCase()}`, 'before=not-a-uuid']) {
        const response = await fetch(`${url}?${query}`, authenticated);
        expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(findingReviewQueue).toHaveBeenCalledTimes(2);
    } finally { server.close(); await once(server, 'close'); }
  });

  it('keeps current-authority denials private from caches', async () => {
    const findingReviewQueue = vi.fn(async () => {
      throw new ParticipationError('FORBIDDEN', 'Current reviewer authority is required.');
    });
    const { accountRouter } = createParticipationRouters({
      service: { findingReviewQueue } as unknown as ParticipationService, isActorActive: async () => true,
    });
    const app = express(); app.use('/api/participation', (_req, res, next) => {
      res.locals.actorId = `account:${randomUUID()}`; res.locals.accountName = 'Inactive reviewer'; next();
    }, accountRouter);
    const { server, origin } = await listening(app);
    try {
      const response = await fetch(`${origin}/api/participation/finding-review-queue`);
      expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'forbidden', message: 'Current reviewer authority is required.' });
    } finally { server.close(); await once(server, 'close'); }
  });
});
