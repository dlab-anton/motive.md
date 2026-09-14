import assert from 'node:assert/strict';
import test from 'node:test';
import { MotiveClient, MotiveClientError, readProjectKey, type FetchLike } from '../src/client.js';

const KEY = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;
const UUID = '12345678-1234-4123-8123-123456789abc';

test('reads only a canonical key and fails closed on encrypted markers', () => {
  assert.equal(readProjectKey({ MOTIVE_PROJECT_ACCESS_KEY: KEY }), KEY);
  for (const value of [undefined, '', 'bad', `__encrypted__:${KEY}`]) {
    assert.throws(() => readProjectKey({ MOTIVE_PROJECT_ACCESS_KEY: value }), /missing or unavailable/);
  }
});

test('sends bearer only to fixed agent routes and forces redirect errors', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: FetchLike = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  };
  const client = new MotiveClient(KEY, fetcher);
  await client.request({ method: 'GET', path: '/api/public/projects/circle-packing/research-brief' });
  await client.request({ method: 'GET', path: '/api/agent/work-queue' });

  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[1].init.headers).get('Authorization'), `Bearer ${KEY}`);
  assert.equal(calls[0].url.origin, 'https://motive-md.vercel.app');
  assert.equal(calls[1].init.redirect, 'error');
});

test('rejects traversal, arbitrary hosts, malformed IDs, and read-only POST bypasses', async () => {
  const client = new MotiveClient(KEY, async () => new Response('{}'));
  const invalid = [
    '/api/agent/../public/projects/circle-packing/research-brief',
    '//example.com/api/agent/work-queue',
    '/api/agent/submissions/not-a-uuid/research-sync',
    '/api/agent/work-queue?token=bad',
  ];
  for (const path of invalid) await assert.rejects(client.request({ method: 'GET', path }), /rejected/);
  await assert.rejects(client.request({ method: 'POST', path: '/api/agent/session', body: {}, readOnlyPost: true }), /read-only POST/);
  await assert.rejects(client.request({ method: 'GET', path: '/api/agent/work-queue', readOnlyPost: true }), /read-only POST/);
});

test('allows only the exact structured read-only POST without an idempotency header', async () => {
  let captured: RequestInit | undefined;
  const client = new MotiveClient(KEY, async (_input, init) => {
    captured = init;
    return new Response('{"matches":[]}');
  });
  await client.request({ method: 'POST', path: '/api/agent/experiment-protocol-matches',
    body: { experimentProtocol: {} }, readOnlyPost: true });
  assert.equal(new Headers(captured?.headers).has('Idempotency-Key'), false);
  assert.equal(new Headers(captured?.headers).get('Authorization'), `Bearer ${KEY}`);
});

test('scrubs secret response values and property names', async () => {
  const body = JSON.stringify({ token: KEY, [KEY]: 'property', nested: { apiKey: 'remote-secret', note: `prefix ${KEY}` } });
  const client = new MotiveClient(KEY, async () => new Response(body));
  const result = await client.request({ method: 'GET', path: '/api/agent/work-queue' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes('remote-secret'), false);
  assert.match(serialized, /\[redacted\]/);
});

test('does not relay remote error bodies', async () => {
  const client = new MotiveClient(KEY, async () => new Response(
    JSON.stringify({ error: 'unauthorized', message: `leak ${KEY}`, secret: 'remote-secret' }), { status: 401 }));
  await assert.rejects(client.request({ method: 'GET', path: '/api/agent/work-queue' }), error => {
    assert(error instanceof MotiveClientError);
    assert.match(error.message, /HTTP 401 \(UNAUTHORIZED\)/);
    assert.equal(error.message.includes(KEY), false);
    assert.equal(error.message.includes('remote-secret'), false);
    return true;
  });
});

test('marks network, body-read, 5xx, and malformed-success mutation outcomes uncertain', async t => {
  const request = { method: 'POST' as const, path: `/api/agent/assignments/${UUID}/renew`,
    body: { leaseEpoch: 1 }, idempotencyKey: 'stable.retry.key' };
  const cases: Array<[string, FetchLike, number]> = [
    ['network', async () => { throw new Error(`network ${KEY}`); }, 20_000],
    ['5xx', async () => new Response(`server ${KEY}`, { status: 503 }), 20_000],
    ['malformed success', async () => new Response(`<html>${KEY}</html>`), 20_000],
    ['body timeout', async (_input, init) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error(`stream ${KEY}`))); },
    })), 5],
  ];
  for (const [name, fetcher, timeout] of cases) await t.test(name, async () => {
    const client = new MotiveClient(KEY, fetcher, timeout);
    await assert.rejects(client.request(request), error => {
      assert(error instanceof MotiveClientError);
      assert.equal(error.uncertain, true);
      assert.match(error.message, /same idempotencyKey and identical arguments/);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
  });
});

test('requires stable caller idempotency for every mutation', async () => {
  const client = new MotiveClient(KEY, async () => new Response('{}'));
  await assert.rejects(client.request({ method: 'POST', path: '/api/agent/session', body: {} }), /requires an idempotencyKey/);
  await assert.rejects(client.request({ method: 'POST', path: '/api/agent/session', body: {}, idempotencyKey: 'short' }), /requires an idempotencyKey/);
});
