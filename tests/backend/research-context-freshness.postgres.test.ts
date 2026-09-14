import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createResearchMemoryService, ResearchMemoryError, type ResearchMemoryService } from '../../server/research-memory/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('fresh research-context completion time on isolated PostgreSQL', () => {
  const databaseName = `motive_context_freshness_${randomUUID().replaceAll('-', '')}`;
  const projectSlug = `context-freshness-${randomUUID()}`;
  const actorId = `operator:context-freshness-${randomUUID()}`;
  const vaultKey = Buffer.alloc(32, 23);
  const apiKey = `he_${'f'.repeat(43)}`;
  const tenantId = randomUUID(); const channelId = randomUUID();
  const completions = ['2026-09-09T10:00:00.000Z', '2026-09-09T10:05:00.000Z', '2026-09-09T10:10:00.000Z'];
  let admin: Pool; let pool: Pool; let service: ResearchMemoryService;
  let fetchCalls = 0; let clockReads = 0; let failEngine = false;

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const fetcher: typeof fetch = async input => {
    fetchCalls += 1;
    const url = new URL(String(input));
    if (failEngine) return json({ detail: 'temporarily unavailable' }, 503);
    if (url.pathname.endsWith('/channels/circle-packing')) return json({
      id: channelId, name: 'circle-packing', goal: 'Use successful current engine reads.',
    });
    if (url.pathname.endsWith('/hypotheses')) return json({ items: [], total: 0 });
    if (url.pathname.endsWith('/insights')) return json({ items: [], total: 0 });
    return json({ detail: 'not found' }, 404);
  };

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(source.hostname.toLowerCase())) {
      throw new Error('MOTIVE_TEST_DATABASE_URL must target localhost for this test.');
    }
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await new LedgerKernel(pool).createProject({ actorId, idempotencyKey: randomUUID(),
      slug: projectSlug, visibility: 'PUBLIC', revisionContent: { title: 'Fresh context test' } });
    const scopeId = randomUUID();
    const encrypted = encryptSecret(vaultKey, apiKey, `research-scope:v1:${scopeId}:${project.id}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,$11)`, [scopeId,project.id,tenantId,channelId,`sha256:${'a'.repeat(64)}`,encrypted,
      `sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'d'.repeat(40),actorId,completions[0]]);
    service = createResearchMemoryService({ pool, vaultKey, fetch: fetcher, now: () => {
      if (fetchCalls !== (clockReads + 1) * 4) throw new Error('Completion clock was read before all four engine GETs completed.');
      return new Date(completions[clockReads++]!);
    } });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('distinguishes each successful fresh engine read from its immutable retained snapshot', async () => {
    const first = await service.getContext(projectSlug);
    const second = await service.getContext(projectSlug);

    expect(fetchCalls).toBe(8);
    expect(first.engineReadCompletedAt).toBe(completions[0]);
    expect(second.engineReadCompletedAt).toBe(completions[1]);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    expect(second.retrievedAt).toBe(first.retrievedAt);
    expect(first.retrievedAt).toBe(completions[0]);

    const rows = await pool.query(`SELECT id,payload,snapshot_digest,retrieved_at FROM motive.research_context_snapshots`);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(first.snapshotId);
    expect(rows.rows[0].payload).not.toHaveProperty('engineReadCompletedAt');
    expect(digestCanonicalJson(rows.rows[0].payload)).toBe(first.snapshotDigest);

    const project = await pool.query('SELECT id FROM motive.projects WHERE slug=$1', [projectSlug]);
    const beforeRetainedReads = fetchCalls;
    const latest = await service.getLatestRetainedContext(projectSlug);
    const exact = await service.getSnapshot(project.rows[0].id as string, first.snapshotId);
    expect(fetchCalls).toBe(beforeRetainedReads);
    expect(latest).toEqual(exact);
    expect(latest).not.toHaveProperty('engineReadCompletedAt');
    expect(latest).toMatchObject({ snapshotId: first.snapshotId, snapshotDigest: first.snapshotDigest,
      retrievedAt: completions[0] });

    failEngine = true;
    const snapshotsBeforeFailure = await pool.query('SELECT count(*)::integer AS count FROM motive.research_context_snapshots');
    let failure: unknown;
    try { await service.getContext(projectSlug); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ResearchMemoryError);
    expect(failure).toMatchObject({ code: 'UPSTREAM' });
    expect(failure).not.toHaveProperty('engineReadCompletedAt');
    expect((await pool.query('SELECT count(*)::integer AS count FROM motive.research_context_snapshots')).rows[0].count)
      .toBe(snapshotsBeforeFailure.rows[0].count);
    expect(clockReads).toBe(2);
  });
});
