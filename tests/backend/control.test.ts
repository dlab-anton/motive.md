import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createControlApp, type ControlRepository } from '../../server/control/app.ts';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });

async function fixture(overrides: Partial<ControlRepository> = {}, draining = false) {
  const calls: string[] = [];
  const app = createControlApp({
    allowedOrigins: ['https://motive.example'], isDraining: () => draining,
    authenticate: async token => token === 'valid-token' ? { id: 'verified-actor' } : null,
    repository: {
      listPublicProjects: async () => [], getProject: async () => null,
      getSupport: async actor => { calls.push(actor); return []; }, ...overrides,
    },
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { base: `http://127.0.0.1:${address.port}`, calls };
}

describe('control API authority boundary', () => {
  it('rejects foreign origins before reading data', async () => {
    const { base } = await fixture({ listPublicProjects: async () => { throw new Error('must not run'); } });
    expect((await fetch(`${base}/v1/projects`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('derives personal support ownership from validated bearer identity', async () => {
    const { base, calls } = await fixture();
    expect((await fetch(`${base}/v1/me/support?actor_id=victim`)).status).toBe(401);
    expect((await fetch(`${base}/v1/me/support`, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(401);
    expect((await fetch(`${base}/v1/me/support?actor_id=victim`, { headers: { Authorization: 'Bearer valid-token' } })).status).toBe(200);
    expect(calls).toEqual(['verified-actor']);
  });
  it('does not expose database errors or pretend a missing project is a sample', async () => {
    const { base } = await fixture({ listPublicProjects: async () => { throw new Error('secret-database-url'); } });
    const response = await fetch(`${base}/v1/projects`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-database-url');
    expect((await fetch(`${base}/v1/projects/private`)).status).toBe(404);
  });
  it('disables every mutation including grant, submission, and inference admission', async () => {
    const { base } = await fixture();
    for (const path of ['/projects/math/grants', '/submissions', '/responses']) {
      expect((await fetch(`${base}/v1${path}`, { method: 'POST' })).status).toBe(503);
    }
    const status = await (await fetch(`${base}/v1/status`)).json();
    expect(status.executionEnabled).toBe(false);
    expect(status.gates.A).toBe('not_passed');
  });
  it('stops admitting API work while draining', async () => {
    const { base } = await fixture({}, true);
    expect((await fetch(`${base}/v1/projects`)).status).toBe(503);
  });
});
