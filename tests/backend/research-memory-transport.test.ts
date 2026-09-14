import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResearchMemoryService, ResearchMemoryError } from '../../server/research-memory/index.ts';
import { encryptSecret } from '../../server/funding/vault.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const apiKey = `he_${'a'.repeat(43)}`;
const input = { apiBaseUrl: 'http://127.0.0.1:8000/api/v1', tenantId, channelId,
  channelName: 'circle-packing', apiKey };

function unusedPool() {
  const connect = vi.fn();
  return { pool: { connect } as unknown as Pool, connect };
}

function service(fetcher: typeof fetch, pool: Pool, timeoutMs?: number) {
  return createResearchMemoryService({ pool, vaultKey: Buffer.alloc(32, 7), fetch: fetcher,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    now: () => new Date('2026-09-09T00:00:00.000Z') });
}

async function failure(action: Promise<unknown>) {
  try { await action; throw new Error('Expected the research-memory read to fail.'); }
  catch (error) { return error; }
}

describe('research-memory transport boundary', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('identifies a fetch timeout without exposing the transport error', async () => {
    vi.useFakeTimers();
    const privateDetail = 'private-host.example?key=secret';
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(privateDetail)), { once: true });
    }));
    const { pool, connect } = unusedPool();
    const pending = failure(service(fetcher, pool, 500).linkScope('account:owner', 'circle-packing', input));
    await vi.advanceTimersByTimeAsync(500);
    const error = await pending;
    expect(error).toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request timed out.' });
    expect(String(error)).not.toContain(privateDetail);
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps the default read alive past five seconds but aborts it at ten', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    let settled = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? null;
      init?.signal?.addEventListener('abort', () => reject(new Error('bounded default timeout')), { once: true });
    }));
    const { pool } = unusedPool();
    const pending = failure(service(fetcher, pool).linkScope('account:owner', 'circle-packing', input))
      .then(error => { settled = true; return error; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request timed out.' });
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('maps an aborted response-body read to the same fixed timeout', async () => {
    vi.useFakeTimers();
    const privateDetail = 'body aborted at https://private.invalid/token';
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error(privateDetail)), { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { pool, connect } = unusedPool();
    const pending = failure(service(fetcher, pool, 500).linkScope('account:owner', 'circle-packing', input));
    await vi.advanceTimersByTimeAsync(500);
    const error = await pending;
    expect(error).toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request timed out.' });
    expect(String(error)).not.toContain(privateDetail);
    expect(connect).not.toHaveBeenCalled();
  });

  it('redacts a non-timeout response stream failure', async () => {
    const privateDetail = 'stream failed with secret response bytes';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(privateDetail)); },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { pool, connect } = unusedPool();
    const error = await failure(service(fetcher, pool).linkScope('account:owner', 'circle-packing', input));
    expect(error).toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request failed.' });
    expect(String(error)).not.toContain(privateDetail);
    expect(connect).not.toHaveBeenCalled();
  });

  it('aborts sibling reads after preserving the first domain failure', async () => {
    const vaultKey = Buffer.alloc(32, 7);
    const scopeId = '44444444-4444-4444-8444-444444444444';
    const encryptedKey = encryptSecret(vaultKey, apiKey, `research-scope:v1:${scopeId}:${projectId}`);
    const pool = { query: vi.fn(async (sql: string) => {
      if (!sql.includes('FROM motive.project_research_scopes scope JOIN motive.projects project')) {
        throw new Error(`Unexpected test query: ${sql}`);
      }
      return { rowCount: 1, rows: [{ id: scopeId, project_id: projectId,
        api_base_url: 'http://127.0.0.1:8000/api/v1', tenant_id: tenantId, channel_id: channelId,
        channel_name: 'circle-packing', encrypted_api_key: encryptedKey, api_version: '1.8.0' }] };
    }) } as unknown as Pool;
    let abortedSiblings = 0;
    const fetcher = vi.fn<typeof fetch>(async (value, init) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith('/channels/circle-packing')) return new Response(JSON.stringify({ id: channelId,
        name: 'circle-packing', goal: 'A bounded goal.' }), { status: 200 });
      if (url.pathname.endsWith('/hypotheses') && url.searchParams.get('is_archived') === 'false') {
        return new Response('{}', { status: 503 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { abortedSiblings += 1; reject(new Error('private sibling detail')); }, { once: true });
      });
    });
    const research = createResearchMemoryService({ pool, vaultKey, fetch: fetcher, timeoutMs: 10_000 });

    const error = await failure(research.getContext('circle-packing'));
    expect(error).toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request failed with HTTP 503.' });
    expect(abortedSiblings).toBe(2);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP status', () => new Response('{}', { status: 503 }), 'Hypothesis request failed with HTTP 503.'],
    ['declared size', () => new Response('{}', { status: 200, headers: { 'content-length': '262145' } }),
      'Hypothesis response exceeded the byte limit.'],
    ['JSON parsing', () => new Response('{', { status: 200 }), 'Hypothesis returned invalid UTF-8 JSON.'],
  ])('preserves the existing %s domain error', async (_label, response, message) => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const { pool, connect } = unusedPool();
    const error = await failure(service(fetcher, pool).linkScope('account:owner', 'circle-packing', input));
    expect(error).toBeInstanceOf(ResearchMemoryError);
    expect(error).toMatchObject({ code: 'UPSTREAM', message });
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps a successful bounded read on the public scope-inspection path', async () => {
    const fetcher = vi.fn<typeof fetch>(async value => {
      const url = new URL(String(value));
      const body = url.pathname.endsWith('/health') ? { status: 'ok', database: 'ok', version: '1.8.0' }
        : url.pathname.endsWith('/keys') ? [{ tenant_id: tenantId, prefix: apiKey.slice(0, 10) }]
          : { id: channelId, name: 'circle-packing', goal: 'Improve the retained reference.',
            created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: null, rows: [] };
      if (sql.includes('FROM motive.projects project JOIN motive.memberships')) return { rowCount: 1, rows: [{ id: projectId }] };
      if (sql.includes("status='CONNECTED' FOR UPDATE")) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO motive.project_research_scopes')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT * FROM motive.project_research_scopes WHERE id=$1')) return { rowCount: 1, rows: [{
        id: parameters?.[0], channel_name: 'circle-packing', verified_at: new Date('2026-09-09T00:00:00.000Z'),
      }] };
      throw new Error(`Unexpected test query: ${sql}`);
    }), release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(service(fetcher, pool).linkScope('account:owner', 'circle-packing', input)).resolves.toMatchObject({
      projectSlug: 'circle-packing', channelName: 'circle-packing', status: 'CONNECTED',
      verifiedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
