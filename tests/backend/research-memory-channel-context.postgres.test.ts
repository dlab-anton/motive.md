import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createResearchMemoryService, ResearchMemoryError } from '../../server/research-memory/index.ts';
import { contributionFixture } from '../fixtures/motive-evidence-contribution.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const fixtureBytes = readFileSync(new URL('../fixtures/channel-context-v1.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as Record<string, any>;

pgDescribe('Hypothesis channel-context-v1 adapter on isolated PostgreSQL', () => {
  const databaseName = `motive_context_adapter_${randomUUID().replaceAll('-', '')}`;
  const actor = `account:${randomUUID()}`;
  const tenantId = randomUUID();
  const channelId = String(fixture.channel.id);
  const channelName = String(fixture.channel.name);
  const projectSlug = `context-adapter-${randomUUID()}`;
  const apiKey = `he_${'a'.repeat(43)}`;
  const vaultKey = Buffer.alloc(32, 13);
  let admin: Pool;
  let pool: Pool;
  let batchBody: unknown = fixture;
  let batchResponse: (() => Response) | null = null;
  let calls: URL[] = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith('/health')) return json({ status: 'ok', version: '1.8.0', database: 'ok' });
    if (new Headers(init?.headers).get('X-API-Key') !== apiKey) return json({ detail: 'invalid key' }, 401);
    if (url.pathname.endsWith('/keys')) return json([{ prefix: apiKey.slice(0, 10), tenant_id: tenantId }]);
    if (url.pathname.endsWith(`/channels/${channelName}/context`)) return batchResponse?.() ?? json(batchBody);
    if (url.pathname.endsWith(`/channels/${channelName}`)) return json(fixture.channel);
    if (url.pathname.endsWith('/hypotheses')) return json(
      url.searchParams.get('is_archived') === 'true' ? fixture.archived_hypotheses : fixture.active_hypotheses);
    if (url.pathname.endsWith('/insights')) return json(fixture.insights);
    const evidenceId = url.pathname.match(/\/hypotheses\/([a-f0-9-]+)\/evidence$/)?.[1];
    if (evidenceId) return json(fixture.evidence_pages.find((page: any) => page.hypothesis_id === evidenceId));
    return json({ detail: 'not found' }, 404);
  };

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: actor, idempotencyKey: randomUUID(), slug: projectSlug,
      visibility: 'PUBLIC', revisionContent: { title: 'Channel context adapter test' } });
    const linker = createResearchMemoryService({ pool, vaultKey, fetch: fetcher });
    await linker.linkScope(actor, projectSlug, { apiBaseUrl: 'http://127.0.0.1:8000/api/v1', tenantId, channelId,
      channelName, apiKey });
    calls = [];
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  const service = (transport: 'legacy'|'channel-context-v1' = 'channel-context-v1', timeoutMs?: number) =>
    createResearchMemoryService({ pool, vaultKey, fetch: fetcher, contextTransport: transport,
      ...(timeoutMs === undefined ? {} : { timeoutMs }), now: () => new Date('2026-09-09T12:00:00.000Z') });
  const snapshotCount = async () => Number((await pool.query('SELECT count(*)::int AS count FROM motive.research_context_snapshots')).rows[0].count);
  const retained = <T extends { engineReadCompletedAt?: string }>(value: T) => {
    const { engineReadCompletedAt: _completedAt, ...result } = value; return result;
  };

  it('normalizes the byte-identical engine fixture identically with one opt-in GET and reuses retained history', async () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex'))
      .toBe('ccc6f2045ac1c33ea52684b51ce7985f57b4100a20b5a73d8b1fd3c68d04d4c4');
    batchBody = fixture; batchResponse = null; calls = [];
    const legacy = await service('legacy').getContext(projectSlug);
    expect(calls).toHaveLength(6);
    calls = [];
    const batch = await service().getContext(projectSlug);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe(`/api/v1/channels/${channelName}/context`);
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ expected_channel_id: channelId,
      active_offset: '0', archived_offset: '0', insight_offset: '0' });
    expect(retained(batch)).toEqual(retained(legacy));
    expect(batch.snapshotId).toBe(legacy.snapshotId);
    expect(batch.snapshotDigest).toBe(legacy.snapshotDigest);
    expect(batch.hypotheses[1]!.outcome).toEqual({ result: 'negative', narrative: null,
      evidenceSummary: null, actualVsPredicted: null, effectSize: null });
    const beforeRetained = calls.length;
    expect((await service().getLatestRetainedContext(projectSlug)).snapshotId).toBe(batch.snapshotId);
    expect(calls).toHaveLength(beforeRetained);
    expect(await snapshotCount()).toBe(1);
  });

  it('preserves truncation and snapshot identity between legacy and batch pages', async () => {
    const expanded = structuredClone(fixture);
    const page = expanded.evidence_pages[0]; const hypothesis = expanded.active_hypotheses.items[0];
    page.items = Array.from({ length: 20 }, (_, index) => ({ ...page.items[0],
      id: `${(index + 10).toString(16).padStart(8, '0')}-5555-4555-8555-555555555555`, content: `neutral evidence ${index}` }));
    page.total = 21; hypothesis.evidence_counts = { supporting: 0, contradicting: 0, neutral: 21 };
    batchBody = expanded; batchResponse = null;
    const originalFixture = structuredClone(fixture);
    Object.assign(fixture, expanded);
    try {
      calls = []; const legacy = await service('legacy').getContext(projectSlug);
      calls = []; const batch = await service().getContext(projectSlug);
      expect(calls).toHaveLength(1);
      expect(retained(batch)).toEqual(retained(legacy));
      expect(batch.snapshotId).toBe(legacy.snapshotId);
      expect(batch.hypotheses[0]).toMatchObject({ evidenceTotal: 21, evidenceTruncated: true });
    } finally { Object.assign(fixture, originalFixture); batchBody = fixture; }
  });

  it('binds all three requested offsets to the one batch response', async () => {
    const offsetBody = structuredClone(fixture);
    for (const name of ['active_hypotheses', 'archived_hypotheses', 'insights']) {
      offsetBody[name].items = []; offsetBody[name].offset = 1;
    }
    offsetBody.evidence_pages = []; batchBody = offsetBody; batchResponse = null; calls = [];
    const result = await service().getContext(projectSlug, { activeOffset: 1, archivedOffset: 1, insightOffset: 1 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ expected_channel_id: channelId,
      active_offset: '1', archived_offset: '1', insight_offset: '1' });
    expect(result).toMatchObject({ hypotheses: [], insights: [], page: { activeOffset: 1, archivedOffset: 1, insightOffset: 1 } });
    batchBody = fixture;
  });

  it.each([
    ['HTTP 404', () => { batchResponse = () => json({}, 404); }],
    ['HTTP 413', () => { batchResponse = () => json({}, 413); }],
    ['format', () => { batchBody = { ...structuredClone(fixture), format: 'hypothesis.channel-context.v2' }; }],
    ['channel binding', () => { const body = structuredClone(fixture); body.channel.id = randomUUID(); batchBody = body; }],
    ['page count', () => { const body = structuredClone(fixture); body.active_hypotheses.total = 2; batchBody = body; }],
    ['evidence coverage', () => { const body = structuredClone(fixture); body.evidence_pages.pop(); batchBody = body; }],
    ['evidence type counts', () => { const body = structuredClone(fixture);
      body.active_hypotheses.items[0].evidence_counts.neutral = 0; batchBody = body; }],
    ['duplicate hypothesis IDs', () => { const body = structuredClone(fixture);
      body.archived_hypotheses.items[0].id = body.active_hypotheses.items[0].id;
      body.evidence_pages[1].hypothesis_id = body.active_hypotheses.items[0].id;
      body.evidence_pages[1].items[0].hypothesis_id = body.active_hypotheses.items[0].id; batchBody = body; }],
    ['duplicate evidence IDs', () => { const body = structuredClone(fixture);
      body.evidence_pages[1].items[0].id = body.evidence_pages[0].items[0].id; batchBody = body; }],
    ['wrong evidence parent', () => { const body = structuredClone(fixture);
      body.evidence_pages[0].items[0].hypothesis_id = body.archived_hypotheses.items[0].id; batchBody = body; }],
  ])('fails %s after one GET without retaining a partial snapshot', async (_label, configure) => {
    batchBody = structuredClone(fixture); batchResponse = null; configure(); calls = [];
    const before = await snapshotCount();
    await expect(service().getContext(projectSlug)).rejects.toBeInstanceOf(ResearchMemoryError);
    expect(calls).toHaveLength(1);
    expect(await snapshotCount()).toBe(before);
    batchBody = fixture; batchResponse = null;
  });

  it('enforces declared, streamed UTF-8, timeout, and final normalized byte limits without fallback', async () => {
    const before = await snapshotCount();
    batchResponse = () => new Response('{}', { status: 200, headers: { 'content-length': '524289' } }); calls = [];
    await expect(service().getContext(projectSlug)).rejects.toMatchObject({ code: 'UPSTREAM',
      message: 'Hypothesis response exceeded the byte limit.' });
    expect(calls).toHaveLength(1);

    const unicode = JSON.stringify({ value: '🧪'.repeat(140_000) });
    expect(unicode.length).toBeLessThan(524_288); expect(Buffer.byteLength(unicode, 'utf8')).toBeGreaterThan(524_288);
    batchResponse = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.from(unicode)); controller.close();
    } }), { status: 200 }); calls = [];
    await expect(service().getContext(projectSlug)).rejects.toMatchObject({ message: 'Hypothesis response exceeded the byte limit.' });
    expect(calls).toHaveLength(1);

    batchResponse = () => { throw new Error('use asynchronous timeout response'); }; calls = [];
    const timeoutFetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
    });
    const timed = createResearchMemoryService({ pool, vaultKey, fetch: timeoutFetcher, contextTransport: 'channel-context-v1', timeoutMs: 500 });
    await expect(timed.getContext(projectSlug)).rejects.toMatchObject({ code: 'UPSTREAM', message: 'Hypothesis request timed out.' });

    const large = structuredClone(fixture); large.active_hypotheses.items = []; large.active_hypotheses.total = 6;
    large.archived_hypotheses.items = []; large.archived_hypotheses.total = 0; large.evidence_pages = [];
    for (let parent = 0; parent < 6; parent += 1) {
      const hypothesisId = randomUUID(); const hypothesis = { ...structuredClone(fixture.active_hypotheses.items[0]), id: hypothesisId,
        statement: `large normalized hypothesis ${parent}`, evidence_counts: { supporting: 0, contradicting: 0, neutral: 20 } };
      const evidence = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(fixture.evidence_pages[0].items[0]),
        id: randomUUID(), hypothesis_id: hypothesisId, content: `${parent}:${index}:` + 'x'.repeat(4000) }));
      large.active_hypotheses.items.push(hypothesis); large.evidence_pages.push({ hypothesis_id: hypothesisId,
        items: evidence, total: 20, offset: 0, limit: 20 });
    }
    const largeEvidence = large.evidence_pages.flatMap((item: any) => item.items) as Array<{ content: string }>;
    const initialBytes = Buffer.byteLength(JSON.stringify(large), 'utf8');
    const perItemPadding = Math.floor((523_000 - initialBytes) / largeEvidence.length);
    for (const item of largeEvidence) item.content += 'x'.repeat(perItemPadding);
    const serialized = JSON.stringify(large);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(522_000);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(524_288);
    batchResponse = () => new Response(serialized, { status: 200 }); calls = [];
    await expect(service().getContext(projectSlug)).rejects.toMatchObject({ code: 'UPSTREAM',
      message: 'Hypothesis context exceeded the retained snapshot limit.' });
    expect(calls).toHaveLength(1);
    expect(await snapshotCount()).toBe(before);
    batchBody = fixture; batchResponse = null;
  });

  it('batches contribution recall across a channel page without replacing the original thread', async () => {
    const body = structuredClone(fixture); const remote = body.evidence_pages[0].items[0];
    remote.source = 'https://motive-md.vercel.app/observation-fixture';
    batchBody = body; batchResponse = null;
    const scope = await service().getPublicScope(projectSlug); let lookups = 0;
    const proof = contributionFixture(remote, scope!.scopeId, channelId);
    const reader = createResearchMemoryService({ pool, vaultKey, fetch: fetcher, contextTransport: 'channel-context-v1',
      confirmedEvidenceContributions: async (_project, scopeId, targets) => {
        lookups += 1; expect(scopeId).toBe(scope!.scopeId); expect(targets).toHaveLength(2);
        return new Map([[remote.id, proof]]);
      } });
    const context = await reader.getContext(projectSlug);
    expect(lookups).toBe(1);
    const hypothesis = context.hypotheses.find(item => item.id === remote.hypothesis_id)!;
    expect(hypothesis.evidence[0]!.motiveContribution).toEqual(proof);
    expect(hypothesis).not.toHaveProperty('motiveSubmission');
    const unconfirmed = await service().getContext(projectSlug);
    expect(unconfirmed.hypotheses.flatMap(item => item.evidence).every(item => !item.motiveContribution)).toBe(true);
    expect(unconfirmed.snapshotDigest).not.toBe(context.snapshotDigest);
  });

  it('keeps legacy as the default and rejects invalid constructor transport values', () => {
    expect(() => createResearchMemoryService({ pool, vaultKey,
      contextTransport: 'unexpected' as 'legacy' })).toThrow('Research-memory context transport is invalid.');
  });
});
