import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createInferenceGateway, type GatewayAudit, type InferenceGatewayOptions } from '../../server/gateway/app.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../scripts/lib/gateway-fixture.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const requestBody = (input = 'first local turn') => ({ model: 'motive-local-mock-v1', stream: true, store: false,
  input: [{ type: 'message', role: 'user', content: input }], parallel_tool_calls: true, max_output_tokens: 256 });
function frame(type: string, response: Record<string, unknown>) { return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`; }
function created(id: string) { return frame('response.created', { id, model: 'motive-local-mock-v1', status: 'in_progress' }); }
function completed(id: string, cost = '0.010000000000') {
  return frame('response.completed', { id, model: 'motive-local-mock-v1', status: 'completed', output: [],
    usage: { cost, input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

postgresDescribe('actual HTTP gateway with PostgreSQL admission', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 2000, query_timeout: 5000 });
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool);
  });
  beforeEach(async () => {
    await ledger.setControllerSpending({ actorId: 'gateway-tests', idempotencyKey: randomUUID(), enabled: true, reason: 'Synthetic local HTTP tests' });
  });
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  afterAll(async () => {
    try { await ledger?.setControllerSpending({ actorId: 'gateway-tests', idempotencyKey: randomUUID(), enabled: false, reason: 'Gateway tests complete' }); }
    finally { await pool?.end(); }
  });

  async function setup(handler: (request: IncomingMessage, response: ServerResponse, sequence: number) => Promise<void> | void,
    customize?: (seed: Awaited<ReturnType<typeof seedGatewayAttempt>>) => Partial<InferenceGatewayOptions>) {
    let calls = 0;
    const provider = createServer((req, res) => {
      calls++;
      void Promise.resolve(handler(req, res, calls)).catch(() => res.destroy());
    });
    const providerUrl = await listen(provider); cleanups.push(() => close(provider));
    const profile = localGatewayProfile(`${providerUrl}/v1/responses`);
    const seed = await seedGatewayAttempt(ledger, profile);
    const gateway = createInferenceGateway({ ledger, profiles: [profile], resolveCredential: async (sourceId, ref) =>
      sourceId === seed.source.id && ref === profile.upstream.credentialRef ? 'synthetic-provider-only' : null,
      ...customize?.(seed) });
    const server = createServer(gateway.app);
    const url = await listen(server);
    cleanups.push(async () => { await gateway.drain(); await close(server); });
    const post = (body: unknown = requestBody(), headers: Record<string, string> = {}) => fetch(`${url}/v1/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seed.capability}`, ...headers }, body: JSON.stringify(body),
    });
    const operations = async () => (await pool.query(`SELECT provider_operation_id, status, reserved_amount::text, actual_cost::text,
      provider_response_id, provider_request_id, raw_provider_amount, raw_provider_usage FROM motive.request_operations WHERE attempt_id=$1 ORDER BY request_sequence`, [seed.attempt.id])).rows;
    return { url, profile, seed, gateway, post, operations, calls: () => calls };
  }

  it('audits a stable validation code without logging rejected content', async () => {
    const audit: GatewayAudit[] = [];
    const test = await setup(() => { throw new Error('Rejected request must never reach provider'); },
      () => ({ audit: event => audit.push(event) }));
    const response = await test.post({ ...requestBody(), unexpected: 'private fixture text' });
    expect(response.status).toBe(400);
    expect(test.calls()).toBe(0);
    expect(audit).toMatchObject([{ event: 'gateway_request_failed', failureCode: 'UNSUPPORTED_FIELD' }]);
    expect(JSON.stringify(audit)).not.toContain('private fixture text');
    expect(JSON.stringify(audit)).not.toContain(test.seed.capability);
  });

  it('commits admission before issuance, settles before terminal delivery, and rejects body replay', async () => {
    const observed: Array<{ status: string; held: string; auth: string | undefined; correlation: string | undefined }> = [];
    let attemptId = '';
    const setupResult = await setup(async (req, res, seq) => {
      const state = await pool.query(`SELECT o.status, a.request_held_amount::text FROM motive.request_operations o
        JOIN motive.attempts a ON a.id=o.attempt_id WHERE a.id=$1 ORDER BY request_sequence DESC LIMIT 1`, [attemptId]);
      observed.push({ status: state.rows[0].status, held: state.rows[0].request_held_amount,
        auth: req.headers.authorization, correlation: req.headers['x-client-request-id'] as string | undefined });
      for await (const _ of req) { /* Consume the finite request without logging its content. */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': `provider-request-${seq}` });
      res.end(created(`response-${seq}`) + completed(`response-${seq}`));
    });
    attemptId = setupResult.seed.attempt.id;
    for (const text of ['first local turn', 'second distinct turn']) {
      const response = await setupResult.post(requestBody(text), { 'x-client-request-id': 'same-conversation' });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('response.completed');
      expect((await setupResult.operations()).at(-1)?.status).toBe('RECONCILED');
    }
    expect(observed).toEqual([1, 2].map(() => ({ status: 'IN_FLIGHT', held: '0.034608000000', auth: 'Bearer synthetic-provider-only', correlation: undefined })));
    expect((await setupResult.post()).status).toBe(409);
    expect(setupResult.calls()).toBe(2);
    expect((await setupResult.operations()).map(operation => operation.actual_cost)).toEqual(['0.010000000000', '0.010000000000']);
  });

  it('rejects invalid capabilities, remote tools and worker-selected routes before any provider call', async () => {
    const test = await setup((_req, res) => { res.end(); });
    expect((await test.post(requestBody(), { Authorization: 'Bearer wrong-token' })).status).toBe(401);
    for (const invalid of [{ ...requestBody(), store: true }, { ...requestBody(), tools: [{ type: 'web_search' }] },
      { ...requestBody(), provider: { order: ['unapproved'] } }, { ...requestBody(), previous_response_id: 'old' }]) {
      expect((await test.post(invalid)).status).toBe(400);
    }
    expect((await test.post(requestBody(), { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect(test.calls()).toBe(0); expect(await test.operations()).toEqual([]);
  });

  it('rechecks revocation after advisory authentication and before reservation', async () => {
    const test = await setup((_req, res) => { res.end(); }, seed => ({
      resolveCredential: async () => {
        await ledger.revokeRunCapability({ actorId: seed.actorId, idempotencyKey: randomUUID(), attemptId: seed.attempt.id, reason: 'Revoked during prevalidation' });
        return 'synthetic-provider-only';
      },
    }));
    const response = await test.post(); expect([401, 403]).toContain(response.status);
    expect(test.calls()).toBe(0); expect(await test.operations()).toEqual([]);
  });

  it.each(['http-500', 'truncated', 'missing-cost', 'redirect'] as const)('holds uncertain consumption after %s without reissuing', async mode => {
    const test = await setup((_req, res) => {
      if (mode === 'http-500') { res.writeHead(500); res.end('Do not expose provider diagnostics'); return; }
      if (mode === 'redirect') { res.writeHead(307, { location: '/credential-trap' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'early-request' });
      res.end(created('early-response') + (mode === 'truncated' ? 'data: {"type":' : frame('response.completed', {
        id: 'early-response', status: 'completed', model: 'motive-local-mock-v1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })));
    });
    await test.post().then(response => response.text()).catch(() => undefined);
    await test.gateway.drain();
    const operations = await test.operations();
    expect(test.calls()).toBe(1); expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: 'UNKNOWN', actual_cost: null, reserved_amount: '0.034608000000' });
    const held = await pool.query('SELECT request_held_amount::text FROM motive.attempts WHERE id=$1', [test.seed.attempt.id]);
    expect(held.rows[0].request_held_amount).toBe('0.034608000000');
    if (mode === 'truncated' || mode === 'missing-cost') expect(operations[0].provider_request_id).toBe('early-request');
  });

  it('continues consuming usage after the worker disconnects', async () => {
    const finish = deferred();
    const test = await setup(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(created('disconnect-response'));
      await finish.promise; res.end(completed('disconnect-response'));
    });
    const response = await test.post();
    const reader = response.body!.getReader(); await reader.read();
    expect((await test.post(requestBody('competing distinct request'))).status).toBe(409);
    await reader.cancel();
    finish.resolve(); await test.gateway.drain();
    expect(test.calls()).toBe(1);
    expect(await test.operations()).toMatchObject([{ status: 'RECONCILED', actual_cost: '0.010000000000' }]);
  });

  it('records the actual overrun and freezes further admission', async () => {
    const test = await setup((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(created('overrun-response') + completed('overrun-response', '0.500000000000'));
    });
    const response = await test.post(); expect(response.status).toBe(200); await response.text();
    expect(await test.operations()).toMatchObject([{ status: 'INCIDENT', actual_cost: '0.500000000000' }]);
    expect((await test.post(requestBody('new turn'))).status).toBe(403);
    expect(test.calls()).toBe(1);
  });
});
