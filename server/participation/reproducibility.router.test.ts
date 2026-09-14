import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicSubmissionReproducibility } from '../../src/lib/participation.ts';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

const submissionId = '11111111-1111-4111-8111-111111111111';
const context = { tokenId: '22222222-2222-4222-8222-222222222222', actorId: 'agent:token',
  ownerActorId: 'account:owner', projectId: '33333333-3333-4333-8333-333333333333', expiresAt: '2026-10-01T00:00:00.000Z' };
const base = `/api/public/projects/circle-packing/submissions/${submissionId}/reproducibility`;
const result: PublicSubmissionReproducibility = { format: 'motive.submission-reproducibility.public.v1', submissionId,
  reportDigest: `sha256:${'a'.repeat(64)}`, createdAt: '2026-09-08T00:00:00.000Z', attribution: {
    kind: 'AGENT_DECLARED', credentialId: context.tokenId, agentName: 'Clear Finch', modelName: null, contributorDisplayName: null },
  files: [
    { role: 'SOLVER_SOURCE', name: 'solver-source.txt', mediaType: 'text/plain', bytes: 6,
      digest: `sha256:${'b'.repeat(64)}`, href: `${base}/solver-source.txt` },
    { role: 'TRIAL_RESULTS', name: 'trial-results.txt', mediaType: 'text/plain', bytes: 5,
      digest: `sha256:${'c'.repeat(64)}`, href: `${base}/trial-results.txt` },
  ], disposition: 'AGENT_DECLARED_UNVERIFIED',
  notice: 'These contributor-supplied source and trial files are tied to the retained checker report for reproducibility. Motive did not execute or check them, and they do not indicate support or acceptance.' };

describe('submission reproducibility routes', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map(async server => { server.close(); await once(server, 'close'); })));

  async function serve() {
    const createSubmissionReproducibility = vi.fn(async () => result);
    const publicSubmissionReproducibility = vi.fn(async () => result);
    const publicSubmissionReproducibilityFile = vi.fn(async (_id: string, role: 'SOLVER_SOURCE' | 'TRIAL_RESULTS') => role === 'SOLVER_SOURCE'
      ? { bytes: Buffer.from('source'), digest: `sha256:${'b'.repeat(64)}`, name: 'solver-source.txt', mediaType: 'text/plain' as const }
      : { bytes: Buffer.from('trial'), digest: `sha256:${'c'.repeat(64)}`, name: 'trial-results.txt', mediaType: 'text/plain' as const });
    const service = { authenticateBearer: vi.fn(async () => context), createSubmissionReproducibility,
      publicSubmissionReproducibility, publicSubmissionReproducibilityFile } as unknown as ParticipationService;
    const routers = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', routers.agentRouter);
    app.use('/api/public/projects/circle-packing', routers.publicRouter);
    const server = app.listen(0); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    return { url: `http://127.0.0.1:${address.port}`, createSubmissionReproducibility };
  }

  it('accepts the exact append contract and serves the public manifest and immutable downloads', async () => {
    const fixture = await serve(); const input = { reportDigest: result.reportDigest, solverSource: 'source', trialResults: 'trial' };
    const posted = await fetch(`${fixture.url}/api/agent/submissions/${submissionId}/reproducibility`, { method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'repro-key' },
      body: JSON.stringify(input) });
    expect(posted.status).toBe(201); expect(await posted.json()).toEqual(result);
    expect(fixture.createSubmissionReproducibility).toHaveBeenCalledWith(context, submissionId, input, 'repro-key');
    expect(await (await fetch(`${fixture.url}${base}`)).json()).toEqual(result);
    for (const [name, content, digestValue] of [['solver-source.txt', 'source', `sha256:${'b'.repeat(64)}`],
      ['trial-results.txt', 'trial', `sha256:${'c'.repeat(64)}`]] as const) {
      const response = await fetch(`${fixture.url}${base}/${name}`);
      expect(response.status).toBe(200); expect(await response.text()).toBe(content);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
      expect(response.headers.get('etag')).toBe(`"${digestValue}"`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rejects extra fields and a missing idempotency key before the write', async () => {
    const fixture = await serve(); const input = { reportDigest: result.reportDigest, solverSource: 'source', trialResults: 'trial' };
    const extra = await fetch(`${fixture.url}/api/agent/submissions/${submissionId}/reproducibility`, { method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'repro-key' },
      body: JSON.stringify({ ...input, execute: true }) });
    expect(extra.status).toBe(400);
    const noKey = await fetch(`${fixture.url}/api/agent/submissions/${submissionId}/reproducibility`, { method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(noKey.status).toBe(400); expect(fixture.createSubmissionReproducibility).not.toHaveBeenCalled();
  });
});
