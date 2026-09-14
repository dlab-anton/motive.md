import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readContributorReviewedArtifacts } from '../../src/lib/reviewed-artifacts.ts';
import { createParticipationRouters } from './router.ts';
import { ParticipationError, type ParticipationService } from './service.ts';

async function listening(app: express.Express) {
  const server = app.listen(0); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe('public contributor reviewed artifact route', () => {
  it('accepts only a canonical contributor and one optional lowercase digest cursor with no-store responses', async () => {
    const contributorId = randomUUID(); const cursor = 'a'.repeat(64);
    const calls: Array<{ contributorId: string; after?: string }> = [];
    const publicContributorReviewedArtifacts = vi.fn(async (id: string, after?: string) => {
      calls.push({ contributorId: id, ...(after ? { after } : {}) });
      if (id !== contributorId) throw new ParticipationError('NOT_FOUND', 'Contributor reviewed artifacts were not found.');
      return { format: 'motive.contributor-reviewed-artifacts/0.1' as const, projectSlug: 'circle-packing' as const,
        contributorId: id, items: [], nextCursor: null };
    });
    const service = { publicContributorReviewedArtifacts } as unknown as ParticipationService;
    const { publicRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/public/projects/circle-packing', publicRouter);
    const { server, origin } = await listening(app);
    try {
      const root = `${origin}/api/public/projects/circle-packing/contributors/${contributorId}/reviewed-artifacts`;
      const first = await fetch(root);
      expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
      expect(await first.json()).toMatchObject({ format: 'motive.contributor-reviewed-artifacts/0.1', contributorId });
      const paged = await fetch(`${root}?after=${cursor}`);
      expect(paged.status).toBe(200); expect(paged.headers.get('cache-control')).toBe('no-store');
      expect(calls).toEqual([{ contributorId }, { contributorId, after: cursor }]);
      for (const query of [`after=${cursor.toUpperCase()}`, 'after=short', `after=${cursor}&extra=1`,
        `after=${cursor}&after=${'b'.repeat(64)}`, 'after=', `after=sha256:${cursor}`]) {
        const invalid = await fetch(`${root}?${query}`);
        expect(invalid.status).toBe(400); expect(invalid.headers.get('cache-control')).toBe('no-store');
      }
      expect(publicContributorReviewedArtifacts).toHaveBeenCalledTimes(2);
      const invalidContributor = await fetch(root.replace(contributorId, contributorId.toUpperCase()));
      expect(invalidContributor.status).toBe(400); expect(invalidContributor.headers.get('cache-control')).toBe('no-store');
      const missing = await fetch(root.replace(contributorId, randomUUID()));
      expect(missing.status).toBe(404); expect(missing.headers.get('cache-control')).toBe('no-store');
    } finally { server.close(); await once(server, 'close'); }
  });
});

describe('reviewed artifact response reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  const contributorId = '12345678-1234-4123-8123-123456789abc';
  const submissionId = '22345678-1234-4123-8123-123456789abc';
  const reviewId = '32345678-1234-4123-8123-123456789abc';
  const after = 'a'.repeat(64); const digest = 'b'.repeat(64);
  const page = () => ({ format: 'motive.contributor-reviewed-artifacts/0.1', projectSlug: 'circle-packing', contributorId,
    items: [{ witnessDigest: digest, submissionId, agentName: 'Bounded reviewer fixture', submittedAt: '2026-09-09T01:02:03.000Z',
      review: { id: reviewId, decision: 'ADMIT', reviewedAt: '2026-09-09T02:03:04.000Z', rationale: 'Public rationale.' } }],
    nextCursor: digest });
  function respond(value: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value),
      { status: 200, headers: { 'content-type': 'application/json' } })));
  }

  it('accepts the exact bounded page and rejects malformed or non-progressing envelopes', async () => {
    respond(page());
    await expect(readContributorReviewedArtifacts(contributorId, after, new AbortController().signal))
      .resolves.toEqual(page());
    for (const invalid of [
      { ...page(), items: {} },
      { ...page(), items: [{ ...page().items[0], witnessDigest: ['b'.repeat(64)] }] },
      { ...page(), items: [{ ...page().items[0], witnessDigest: after }], nextCursor: after },
      { ...page(), items: [{ ...page().items[0], review: { ...page().items[0].review, id: [reviewId] } }] },
      { ...page(), nextCursor: 'c'.repeat(64) },
      { ...page(), privateReviewer: 'account:hidden' },
    ]) {
      respond(invalid);
      await expect(readContributorReviewedArtifacts(contributorId, after, new AbortController().signal))
        .rejects.toThrow('could not be read');
    }
  });
});
