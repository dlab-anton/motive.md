import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVercelApiHandler, loadVercelApplication,
  type VercelApplication, type VercelApplicationLoader } from '../../api/index.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('Vercel API function dispatch', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0).reverse()) await close(server);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('initializes once and preserves public, account, and unknown API paths', async () => {
    const app = express();
    app.get('/api/public/projects/circle-packing', (req, res) => res.json({ path: req.path, kind: 'public' }));
    app.get('/api/workspace', (req, res) => res.json({ path: req.path, kind: 'account' }));
    app.use('/api', (req, res) => res.status(404).json({ path: req.originalUrl, error: 'not_found' }));
    const load = vi.fn(async () => app);
    const server = createServer(createVercelApiHandler(load)); servers.push(server);
    const url = await listen(server);

    await expect(fetch(`${url}/api/index?__motive_api_path=public%2Fprojects%2Fcircle-packing`).then(response => response.json()))
      .resolves.toEqual({ path: '/api/public/projects/circle-packing', kind: 'public' });
    await expect(fetch(`${url}/api/index?__motive_api_path=workspace`).then(response => response.json()))
      .resolves.toEqual({ path: '/api/workspace', kind: 'account' });
    const unknown = await fetch(`${url}/api/index?__motive_api_path=missing&probe=1`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ path: '/api/missing?probe=1', error: 'not_found' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('clears Vercel parsed rewrite metadata while preserving user query parameters', async () => {
    const app = express();
    const allowed = new Set(['activeOffset', 'archivedOffset', 'insightOffset']);
    app.get('/api/agent/research-context', (req, res) => {
      const unknown = Object.keys(req.query).filter(key => !allowed.has(key));
      if (unknown.length > 0) {
        res.status(400).json({ error: 'unknown_query_parameter', parameter: unknown[0] });
        return;
      }
      res.json({ path: req.path, query: req.query });
    });
    const handler = createVercelApiHandler(async () => app);
    const server = createServer((request, response) => {
      const parsed = new URL(request.url ?? '/', 'http://internal.invalid');
      Object.defineProperty(request, 'query', {
        configurable: true,
        enumerable: true,
        value: Object.fromEntries(parsed.searchParams),
      });
      void handler(request, response);
    });
    servers.push(server);
    const url = await listen(server);

    const bare = await fetch(`${url}/api/index?__motive_api_path=agent%2Fresearch-context`);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ path: '/api/agent/research-context', query: {} });

    const paged = await fetch(
      `${url}/api/index?__motive_api_path=agent%2Fresearch-context&activeOffset=6&archivedOffset=12&insightOffset=18`,
    );
    expect(paged.status).toBe(200);
    expect(await paged.json()).toEqual({
      path: '/api/agent/research-context',
      query: { activeOffset: '6', archivedOffset: '12', insightOffset: '18' },
    });

    const malformed = await fetch(
      `${url}/api/index?__motive_api_path=agent%2Fresearch-context&activeOffset=6&surprise=true`,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'unknown_query_parameter', parameter: 'surprise' });
  });

  it('routes every API path to the function and keeps static SPA fallback separate', async () => {
    const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
      functions: Record<string, Record<string, unknown>>;
      routes: Array<Record<string, unknown>>;
    };
    expect(config.functions['api/index.ts']).toMatchObject({ maxDuration: 300, regions: ['sin1'] });
    expect(config.routes[1]).toMatchObject({
      src: '/api',
      dest: '/api/index?__motive_api_path=',
    });
    expect(config.routes[2]).toMatchObject({
      src: '/api/(.*)',
      dest: '/api/index?__motive_api_path=$1',
    });
    expect(config.routes.at(-1)).toEqual({ src: '/(.*)', dest: '/index.html' });
  });

  it('fails closed with a fixed response when initialization fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('private configuration detail'), { code: 'ERR_MODULE_NOT_FOUND' });
    const server = createServer(createVercelApiHandler(async () => { throw failure; }));
    servers.push(server);
    const response = await fetch(`${await listen(server)}/api/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The application service is unavailable.' });
    expect(errorLog).toHaveBeenCalledWith('VERCEL_APPLICATION_INITIALIZATION_FAILED', 'Error', 'ERR_MODULE_NOT_FOUND');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private configuration detail');
  });

  it('retries a rejected initialization and shares the recovered application', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectFirst!: (error: Error) => void;
    const firstInitialization = new Promise<VercelApplication>((_resolve, reject) => { rejectFirst = reject; });
    const app = express();
    app.get('/api/health', (_req, res) => res.json({ status: 'healthy' }));
    const load = vi.fn<VercelApplicationLoader>()
      .mockImplementationOnce(() => firstInitialization)
      .mockImplementation(async () => app);
    const handler = createVercelApiHandler(load);
    let dispatched = 0;
    const server = createServer((request, response) => { dispatched += 1; void handler(request, response); }); servers.push(server);
    const url = await listen(server);

    const first = fetch(`${url}/api/health`);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const concurrent = fetch(`${url}/api/health`);
    await vi.waitFor(() => expect(dispatched).toBe(2));
    rejectFirst(Object.assign(new Error('transient startup failure'), { code: 'STARTUP_FAILED' }));

    expect((await first).status).toBe(503);
    expect((await concurrent).status).toBe(503);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(fetch(`${url}/api/health`).then(response => response.json())).resolves.toEqual({ status: 'healthy' });
    await expect(fetch(`${url}/api/health`).then(response => response.json())).resolves.toEqual({ status: 'healthy' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('logs only a bounded deployment-relative missing module identity', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error("Cannot find module '/var/task/server/index.js'"), {
      code: 'ERR_MODULE_NOT_FOUND', url: 'file:///var/task/server/index.js',
    });
    const server = createServer(createVercelApiHandler(async () => { throw failure; }));
    servers.push(server);
    expect((await fetch(`${await listen(server)}/api/health`)).status).toBe(503);
    expect(errorLog).toHaveBeenCalledWith(
      'VERCEL_APPLICATION_INITIALIZATION_FAILED', 'Error', 'ERR_MODULE_NOT_FOUND', 'file:server/index.js',
    );

    errorLog.mockClear();
    const unsafe = Object.assign(new Error("Cannot find module 'secret'"), {
      code: 'ERR_MODULE_NOT_FOUND', url: 'file:///var/task/../private.env?token=secret',
    });
    const unsafeServer = createServer(createVercelApiHandler(async () => { throw unsafe; }));
    servers.push(unsafeServer);
    expect((await fetch(`${await listen(unsafeServer)}/api/health`)).status).toBe(503);
    expect(errorLog).toHaveBeenCalledWith('VERCEL_APPLICATION_INITIALIZATION_FAILED', 'Error', 'ERR_MODULE_NOT_FOUND');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private.env');
  });

  it('logs a strict missing package token without its importer path', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error("Cannot find package '@scope/runtime' imported from /var/task/server/index.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const server = createServer(createVercelApiHandler(async () => { throw failure; }));
    servers.push(server);
    expect((await fetch(`${await listen(server)}/api/health`)).status).toBe(503);
    expect(errorLog).toHaveBeenCalledWith(
      'VERCEL_APPLICATION_INITIALIZATION_FAILED', 'Error', 'ERR_MODULE_NOT_FOUND', 'package:@scope/runtime',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('/var/task/server/index.js');
  });

  it('rejects a forged routed path before application initialization', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn(async () => express());
    const server = createServer(createVercelApiHandler(load)); servers.push(server);
    const response = await fetch(`${await listen(server)}/api/index?__motive_api_path=..%2Fworkspace`);
    expect(response.status).toBe(503);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects local account persistence before importing the application on Vercel', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('MOTIVE_ACCOUNT_PROVIDER', 'local-better-auth');
    await expect(loadVercelApplication()).rejects.toThrow('VERCEL_SUPABASE_ACCOUNTS_REQUIRED');
  });

});
