import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ParticipationPublicProjection } from '../../src/lib/participation.ts';
import { createParticipationRouters } from './router.ts';
import { createParticipationService, ParticipationError, type ParticipationService } from './service.ts';

const publicCache = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const unreachable = { connect: async () => { throw new Error('database must not be reached'); } } as unknown as Pool;
type Loader = { loadPublicProjection: () => Promise<ParticipationPublicProjection> };

function deferred() {
  let resolve!: (value: ParticipationPublicProjection) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<ParticipationPublicProjection>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function projection(build: number): ParticipationPublicProjection {
  return { project: { slug: 'circle-packing', visibility: 'PUBLIC', lifecycle: 'NOT_STARTED', projectRevision: build },
    activeAssignments: 0, totalSubmissions: 0, acceptedResults: 0, bestAccepted: null, contributors: [],
    privateContributionCount: 0, submissions: [], activity: [] } as unknown as ParticipationPublicProjection;
}
function service(options: { publicProjectionCacheMs?: number; now?: () => Date } = {}) {
  const created = createParticipationService(unreachable, { tokenSecret: 'projection-cache-test-secret-longer-than-32-bytes',
    issuerActorId: `operator:${randomUUID()}`, ...options });
  const load = vi.fn<Loader['loadPublicProjection']>();
  (created as unknown as Loader).loadPublicProjection = load;
  return { service: created, load };
}

describe('public projection memo', () => {
  it('reads the database on every call by default', async () => {
    const { service: participation, load } = service(); let build = 0;
    load.mockImplementation(async () => projection(build += 1));
    const [first, second] = await Promise.all([participation.publicProjection(), participation.publicProjection()]);
    expect(first).not.toBe(second); expect((await participation.publicProjection()).project.projectRevision).toBe(3);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight and resolved build inside the window, then rebuilds', async () => {
    let clock = Date.parse('2026-09-26T00:00:00.000Z');
    const { service: participation, load } = service({ publicProjectionCacheMs: 30_000, now: () => new Date(clock) });
    const first = deferred(); load.mockReturnValueOnce(first.promise).mockResolvedValueOnce(projection(2));
    const concurrent = [participation.publicProjection(), participation.publicProjection()];
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(projection(1)); const [left, right] = await Promise.all(concurrent);
    expect(left).toBe(right); expect(left.project.projectRevision).toBe(1);
    clock += 29_999; expect(await participation.publicProjection()).toBe(left); expect(load).toHaveBeenCalledTimes(1);
    clock += 1; expect((await participation.publicProjection()).project.projectRevision).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops a failed build so the next read retries, without discarding a newer build', async () => {
    let clock = Date.parse('2026-09-26T00:00:00.000Z');
    const { service: participation, load } = service({ publicProjectionCacheMs: 30_000, now: () => new Date(clock) });
    const failure = new ParticipationError('NOT_FOUND', 'Project not found.');
    load.mockRejectedValueOnce(failure).mockResolvedValueOnce(projection(2));
    const failed = await Promise.allSettled([participation.publicProjection(), participation.publicProjection()]);
    expect(failed).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await participation.publicProjection()).project.projectRevision).toBe(2); expect(load).toHaveBeenCalledTimes(2);

    const stale = deferred(); const fresh = deferred(); load.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    clock += 30_000; const older = participation.publicProjection();
    clock += 30_000; const newer = participation.publicProjection(); expect(load).toHaveBeenCalledTimes(4);
    stale.reject(new Error('older build failed')); await expect(older).rejects.toThrow('older build failed');
    fresh.resolve(projection(4)); expect(await participation.publicProjection()).toBe(await newer);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('rejects an invalid cache window', () => {
    for (const publicProjectionCacheMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service({ publicProjectionCacheMs })).toThrow('Participation publicProjectionCacheMs must be a non-negative integer.');
    }
    expect(() => service({ publicProjectionCacheMs: 0 })).not.toThrow();
  });
});

describe('public projection CDN caching', () => {
  it('lets the CDN share only successful project and research-brief responses', async () => {
    let failure: Error | null = null;
    const participation = { profile: { slug: 'circle-packing' },
      publicProjection: async () => { if (failure) throw failure; return projection(1); } } as unknown as ParticipationService;
    const { publicRouter } = createParticipationRouters({ service: participation, isActorActive: async () => true });
    const app = express(); app.use('/api/public/projects/circle-packing', publicRouter);
    const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind.');
      const origin = `http://127.0.0.1:${address.port}/api/public/projects/circle-packing`;
      for (const path of ['', '/research-brief']) {
        failure = null; const success = await fetch(`${origin}${path}`);
        expect(success.status).toBe(200); expect(success.headers.get('cache-control')).toBe(publicCache);
        failure = new ParticipationError('NOT_FOUND', 'Project not found.'); const missing = await fetch(`${origin}${path}`);
        expect(missing.status).toBe(404); expect(missing.headers.get('cache-control')).toBe('no-store');
        expect(await missing.json()).toEqual({ error: 'not_found', message: 'Project not found.' });
        failure = new Error('database unavailable'); const broken = await fetch(`${origin}${path}`);
        expect(broken.status).toBe(500); expect(broken.headers.get('cache-control')).toBe('no-store');
      }
    } finally { server.close(); await once(server, 'close'); }
  });
});
