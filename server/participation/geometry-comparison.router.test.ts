import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geometryComparisonFormat, type GeometryComparisonResponse } from '../../src/lib/geometry-comparison.ts';
import { createParticipationRouters } from './router.ts';
import { ParticipationError, type ParticipationService } from './service.ts';

const left = 'aaaaaaaa-1111-4111-8111-111111111111';
const right = 'bbbbbbbb-2222-4222-8222-222222222222';
const response: GeometryComparisonResponse = {
  format: geometryComparisonFormat,
  left: { submissionId: left, artifactSha256: `sha256:${'a'.repeat(64)}` },
  right: { submissionId: right, artifactSha256: `sha256:${'b'.repeat(64)}` },
  relation: 'SAME_GEOMETRY',
};

describe('public geometry comparison route', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map(async server => { server.close(); await once(server, 'close'); })));

  async function serve(implementation: (leftId: string, rightId: string) => Promise<GeometryComparisonResponse> = async () => response) {
    const publicGeometryComparison = vi.fn(implementation);
    const service = { publicGeometryComparison } as unknown as ParticipationService;
    const { publicRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/public/projects/circle-packing', publicRouter);
    const server = app.listen(0); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    return { origin: `http://127.0.0.1:${address.port}`, publicGeometryComparison };
  }

  it('returns only the bounded comparison and allows self-comparison', async () => {
    const fixture = await serve();
    const compared = await fetch(`${fixture.origin}/api/public/projects/circle-packing/submissions/${left}/geometry-comparison?against=${right}`);
    expect(compared.status).toBe(200); expect(compared.headers.get('cache-control')).toBe('no-store');
    expect(await compared.json()).toEqual(response);
    expect(fixture.publicGeometryComparison).toHaveBeenCalledWith(left, right);
    await fetch(`${fixture.origin}/api/public/projects/circle-packing/submissions/${left}/geometry-comparison?against=${left}`);
    expect(fixture.publicGeometryComparison).toHaveBeenLastCalledWith(left, left);
  });

  it('requires canonical route and query UUIDs with exactly one against value', async () => {
    const fixture = await serve(); const base = `${fixture.origin}/api/public/projects/circle-packing/submissions`;
    const invalid = [
      `${base}/${left}/geometry-comparison`,
      `${base}/${left}/geometry-comparison?against=${right}&against=${left}`,
      `${base}/${left}/geometry-comparison?against=${right}&extra=1`,
      `${base}/${left.toUpperCase()}/geometry-comparison?against=${right}`,
      `${base}/${left}/geometry-comparison?against=${right.toUpperCase()}`,
      `${base}/not-a-uuid/geometry-comparison?against=${right}`,
    ];
    for (const url of invalid) {
      const result = await fetch(url); expect(result.status).toBe(400); expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect(fixture.publicGeometryComparison).not.toHaveBeenCalled();
  });

  it('keeps unavailable and invalid retained evidence errors uncached', async () => {
    const unavailable = await serve(async () => { throw new ParticipationError('NOT_FOUND', 'Submission geometry is not available.'); });
    const missing = await fetch(`${unavailable.origin}/api/public/projects/circle-packing/submissions/${left}/geometry-comparison?against=${right}`);
    expect(missing.status).toBe(404); expect(missing.headers.get('cache-control')).toBe('no-store');
    const corrupt = await serve(async () => { throw new ParticipationError('CONFLICT', 'Stored geometry comparison evidence is invalid.'); });
    const conflict = await fetch(`${corrupt.origin}/api/public/projects/circle-packing/submissions/${left}/geometry-comparison?against=${right}`);
    expect(conflict.status).toBe(409); expect(conflict.headers.get('cache-control')).toBe('no-store');
  });
});
