import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

async function listening(app: express.Express) {
  const server = app.listen(0); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe('owner reviewer management routes', () => {
  it('derives the owner from the session and strictly bounds requests and cache behavior', async () => {
    const ownerActorId = `account:${randomUUID()}`; const target = randomUUID();
    const projectReviewers = vi.fn(async () => ({ format: 'motive.project-reviewers/0.1' as const,
      projectSlug: 'circle-packing' as const, reviewers: [{ accountId: target }] }));
    const grantProjectReviewer = vi.fn(async () => ({ format: 'motive.project-reviewer-change/0.1' as const,
      projectSlug: 'circle-packing' as const, accountId: target, action: 'GRANT' as const, changed: true, replayed: false }));
    const removeProjectReviewer = vi.fn(async () => ({ format: 'motive.project-reviewer-change/0.1' as const,
      projectSlug: 'circle-packing' as const, accountId: target, action: 'REMOVE' as const, changed: true, replayed: false }));
    const service = { projectReviewers, grantProjectReviewer, removeProjectReviewer } as unknown as ParticipationService;
    const { accountRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => {
      if (req.get('X-Test-Session') === 'owner') {
        res.locals.actorId = ownerActorId; res.locals.accountName = 'Owner';
      }
      next();
    });
    app.use('/api/participation', accountRouter);
    const { server, origin } = await listening(app);
    try {
      const root = `${origin}/api/participation/reviewers`;
      const anonymous = await fetch(root);
      expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');
      const queried = await fetch(`${root}?limit=1`, { headers: { 'X-Test-Session': 'owner' } });
      expect(queried.status).toBe(400); expect(queried.headers.get('cache-control')).toBe('no-store');
      const missingKey = await fetch(root, { method: 'POST', headers: {
        'X-Test-Session': 'owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: target }) });
      expect(missingKey.status).toBe(400);
      const extra = await fetch(root, { method: 'POST', headers: {
        'X-Test-Session': 'owner', 'Content-Type': 'application/json', 'Idempotency-Key': 'grant-key-123' },
      body: JSON.stringify({ accountId: target, ownerActorId }) });
      expect(extra.status).toBe(400);
      const uppercase = await fetch(root, { method: 'POST', headers: {
        'X-Test-Session': 'owner', 'Content-Type': 'application/json', 'Idempotency-Key': 'grant-key-123' },
      body: JSON.stringify({ accountId: target.toUpperCase() }) });
      expect(uppercase.status).toBe(400);
      const listed = await fetch(root, { headers: { 'X-Test-Session': 'owner' } });
      expect(listed.status).toBe(200); expect(await listed.json()).toEqual({
        format: 'motive.project-reviewers/0.1', projectSlug: 'circle-packing', reviewers: [{ accountId: target }] });
      const granted = await fetch(root, { method: 'POST', headers: {
        'X-Test-Session': 'owner', 'Content-Type': 'application/json', 'Idempotency-Key': 'grant-key-123' },
      body: JSON.stringify({ accountId: target }) });
      expect(granted.status).toBe(200); expect(granted.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(await granted.json())).not.toContain(ownerActorId);
      const removed = await fetch(`${root}/remove`, { method: 'POST', headers: {
        'X-Test-Session': 'owner', 'Content-Type': 'application/json', 'Idempotency-Key': 'remove-key-123' },
      body: JSON.stringify({ accountId: target }) });
      expect(removed.status).toBe(200);
      expect(projectReviewers).toHaveBeenCalledWith(ownerActorId);
      expect(grantProjectReviewer).toHaveBeenCalledWith(ownerActorId, target, 'grant-key-123');
      expect(removeProjectReviewer).toHaveBeenCalledWith(ownerActorId, target, 'remove-key-123');
    } finally { server.close(); await once(server, 'close'); }
  });
});
