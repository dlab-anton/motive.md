import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationRouters } from '../../server/participation/router.ts';
import { ParticipationError, type ParticipationService } from '../../server/participation/service.ts';
import { createResearchMemoryService, ResearchMemoryError, type ResearchMemoryService } from '../../server/research-memory/index.ts';
import type { ResearchContextSnapshot } from '../../src/lib/research-memory.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('latest retained research context on isolated PostgreSQL', () => {
  const databaseName = `motive_retained_context_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:retained-context-${randomUUID()}`;
  const vaultKey = Buffer.alloc(32, 19);
  const apiKey = `he_${'r'.repeat(43)}`;
  const tenantId = randomUUID(); const channelId = randomUUID(); const hypothesisId = randomUUID(); const evidenceId = randomUUID();
  const firstRetrievedAt = '2026-10-03T09:00:00.000Z'; const latestRetrievedAt = '2026-10-03T10:00:00.000Z';
  let admin: Pool; let pool: Pool; let service: ResearchMemoryService; let clock = firstRetrievedAt; let fetchCalls = 0;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async input => {
    fetchCalls += 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith('/channels/circle-packing')) return json({ id: channelId, name: 'circle-packing',
      goal: 'Preserve café bytes, line breaks, and trailing spaces.\nSecond line.  ', created_at: firstRetrievedAt, updated_at: firstRetrievedAt });
    if (url.pathname.endsWith('/hypotheses')) {
      if (url.searchParams.get('is_archived') === 'true') return json({ items: [], total: 0 });
      return json({ items: [{ id: hypothesisId, statement: 'Retain the exact current-scope page.', context: null,
        falsification_criteria: null, status: 'testing', confidence: 0.25, parent_id: null, outcome: null,
        channel: 'circle-packing', is_archived: false, updated_at: firstRetrievedAt }], total: 7 });
    }
    if (url.pathname.endsWith(`/hypotheses/${hypothesisId}/evidence`)) return json({ items: [{ id: evidenceId,
      hypothesis_id: hypothesisId, content: 'Byte-stable retained evidence.', source: null, evidence_type: 'supporting',
      strength: 1, confidence_after: 0.25, created_by: 'fixture-agent', created_at: firstRetrievedAt }], total: 1 });
    if (url.pathname.endsWith('/insights')) return json({ items: [], total: 23 });
    return new Response('{}', { status: 404 });
  };

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 6 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    service = createResearchMemoryService({ pool, vaultKey, fetch: fetcher, now: () => new Date(clock) });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end(); }
  });

  async function project(slug: string) {
    return new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug,
      visibility: 'PUBLIC', revisionContent: { title: `Retained context ${slug}` } });
  }

  async function scope(projectId: string, status: 'CONNECTED'|'REPLACEMENT_PENDING' = 'CONNECTED') {
    const id = randomUUID(); const encrypted = encryptSecret(vaultKey, apiKey, `research-scope:v1:${id}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,$10,$11,$12)`, [id,projectId,tenantId,channelId,`sha256:${'a'.repeat(64)}`,encrypted,
      `sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'d'.repeat(40),status,issuer,firstRetrievedAt]);
    return id;
  }

  async function replace(oldScopeId: string, projectId: string, connectReplacement: boolean) {
    const replacementId = await scope(projectId, 'REPLACEMENT_PENDING');
    await pool.query(`UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1`,
      [oldScopeId,replacementId]);
    if (connectReplacement) await pool.query(`UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1`, [replacementId]);
    return replacementId;
  }

  async function seedSnapshot(projectId: string, scopeId: string, projectSlug: string) {
    const payload = { format: 'motive.research-context.v1', scopeId, projectSlug, channelName: 'circle-packing', channelGoal: 'old scope',
      hypotheses: [], hypothesesTotal: 0, hypothesesTruncated: false, activeHypothesesTotal: 0, archivedHypothesesTotal: 0,
      insights: [], insightsTotal: 0, insightsTruncated: false,
      page: { activeOffset: 0, archivedOffset: 0, insightOffset: 0, activeLimit: 6, archivedLimit: 6, insightLimit: 20 } } as const;
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',$6)`, [randomUUID(),scopeId,projectId,digestCanonicalJson(payload),JSON.stringify(payload),firstRetrievedAt]);
  }

  it('returns the newest current-scope page unchanged without contacting the engine', async () => {
    const slug = `retained-selection-${randomUUID()}`; const created = await project(slug); await scope(created.id);
    const beforeFirst = fetchCalls; const first = await service.getContext(slug);
    expect(fetchCalls - beforeFirst).toBe(5); // channel + three list pages + H evidence pages, where H=1
    expect(first.engineReadCompletedAt).toBe(firstRetrievedAt);
    clock = latestRetrievedAt;
    const beforeLatestFresh = fetchCalls; const expected = await service.getContext(slug, { activeOffset: 6, archivedOffset: 12, insightOffset: 18 });
    expect(fetchCalls - beforeLatestFresh).toBe(5);
    expect(expected).toMatchObject({ retrievedAt: latestRetrievedAt, engineReadCompletedAt: latestRetrievedAt,
      page: { activeOffset: 6, archivedOffset: 12, insightOffset: 18, activeLimit: 6, archivedLimit: 6, insightLimit: 20 },
      hypothesesTotal: 7, activeHypothesesTotal: 7, archivedHypothesesTotal: 0, insightsTotal: 23,
      channelGoal: 'Preserve café bytes, line breaks, and trailing spaces.\nSecond line.  ' });
    const callsBeforeRetainedReads = fetchCalls;
    const { engineReadCompletedAt: _completedAt, ...retainedExpected } = expected;
    const latest = await service.getLatestRetainedContext(slug);
    const exact = await service.getSnapshot(created.id, expected.snapshotId);
    expect(latest).toEqual(retainedExpected);
    expect(exact).toEqual(retainedExpected);
    expect(latest).not.toHaveProperty('engineReadCompletedAt');
    expect(exact).not.toHaveProperty('engineReadCompletedAt');
    expect(fetchCalls).toBe(callsBeforeRetainedReads);
    const saved = await pool.query('SELECT payload FROM motive.research_context_snapshots WHERE id=$1', [expected.snapshotId]);
    expect(saved.rows[0].payload).not.toHaveProperty('engineReadCompletedAt');
    expect(first.snapshotId).not.toBe(expected.snapshotId);
  });

  it('does not fall back to an old, rebound, disconnected, or absent snapshot', async () => {
    const noSnapshotSlug = `retained-empty-${randomUUID()}`; const noSnapshotProject = await project(noSnapshotSlug);
    await scope(noSnapshotProject.id);
    await expect(service.getLatestRetainedContext(noSnapshotSlug)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const reboundSlug = `retained-rebound-${randomUUID()}`; const reboundProject = await project(reboundSlug);
    const oldScope = await scope(reboundProject.id); await seedSnapshot(reboundProject.id, oldScope, reboundSlug);
    await replace(oldScope,reboundProject.id,true);
    await expect(service.getLatestRetainedContext(reboundSlug)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const disconnectedSlug = `retained-disconnected-${randomUUID()}`; const disconnectedProject = await project(disconnectedSlug);
    const disconnectedScope = await scope(disconnectedProject.id); await seedSnapshot(disconnectedProject.id,disconnectedScope,disconnectedSlug);
    await replace(disconnectedScope,disconnectedProject.id,false);
    await expect(service.getLatestRetainedContext(disconnectedSlug)).rejects.toBeInstanceOf(ResearchMemoryError);
  });
});

describe('latest retained research-context agent route', () => {
  const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`, ownerActorId: `account:${randomUUID()}`,
    projectId: randomUUID(), expiresAt: '2026-10-03T10:30:00.000Z' };
  const snapshot = { format: 'motive.research-context.v1', snapshotId: randomUUID(), scopeId: randomUUID(), projectSlug: 'circle-packing',
    channelName: 'circle-packing', channelGoal: 'Retained route fixture.', retrievedAt: '2026-10-03T10:00:00.000Z',
    snapshotDigest: `sha256:${'e'.repeat(64)}`, hypotheses: [], hypothesesTotal: 0, hypothesesTruncated: false,
    activeHypothesesTotal: 0, archivedHypothesesTotal: 0, insights: [], insightsTotal: 0, insightsTruncated: false,
    page: { activeOffset: 6, archivedOffset: 0, insightOffset: 20, activeLimit: 6, archivedLimit: 6, insightLimit: 20 },
    notice: 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.' } satisfies ResearchContextSnapshot;

  async function serve(options: { active?: boolean; assignmentError?: ParticipationError; bearerError?: ParticipationError } = {}) {
    const getAgentAssignment = vi.fn(async () => {
      if (options.assignmentError) throw options.assignmentError;
      return {};
    });
    const authenticateBearer = vi.fn(async () => {
      if (options.bearerError) throw options.bearerError;
      return context;
    });
    const latest = vi.fn(async () => snapshot); const exact = vi.fn(async () => snapshot);
    const participation = { authenticateBearer, getAgentAssignment } as unknown as ParticipationService;
    const research = { getLatestRetainedContext: latest, getSnapshot: exact } as unknown as ResearchMemoryService;
    const { agentRouter } = createParticipationRouters({ service: participation, researchMemory: research,
      isActorActive: async () => options.active ?? true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    return { origin: `http://127.0.0.1:${address.port}`, server, authenticateBearer, getAgentAssignment, latest, exact };
  }

  async function close(server: ReturnType<express.Express['listen']>) { server.close(); await once(server, 'close'); }

  it('requires the current bearer, owning account, and project membership before reading retained context', async () => {
    const missingBearer = await serve();
    try { expect((await fetch(`${missingBearer.origin}/api/agent/research-context/retained-latest`)).status).toBe(401);
      expect(missingBearer.getAgentAssignment).not.toHaveBeenCalled(); expect(missingBearer.latest).not.toHaveBeenCalled(); }
    finally { await close(missingBearer.server); }

    const inactive = await serve({ active: false });
    try { expect((await fetch(`${inactive.origin}/api/agent/research-context/retained-latest`, { headers: { Authorization: 'Bearer token' } })).status).toBe(401);
      expect(inactive.getAgentAssignment).not.toHaveBeenCalled(); expect(inactive.latest).not.toHaveBeenCalled(); }
    finally { await close(inactive.server); }

    const revokedMembership = await serve({ assignmentError: new ParticipationError('UNAUTHORIZED', 'Agent token is invalid or expired.') });
    try { expect((await fetch(`${revokedMembership.origin}/api/agent/research-context/retained-latest`, { headers: { Authorization: 'Bearer token' } })).status).toBe(401);
      expect(revokedMembership.getAgentAssignment).toHaveBeenCalledWith(context); expect(revokedMembership.latest).not.toHaveBeenCalled(); }
    finally { await close(revokedMembership.server); }
  });

  it('rejects query parameters and leaves exact snapshot replay working', async () => {
    const fixture = await serve(); const headers = { Authorization: 'Bearer token' };
    try {
      const retained = await fetch(`${fixture.origin}/api/agent/research-context/retained-latest`, { headers });
      expect(retained.status).toBe(200); expect(await retained.json()).toEqual(snapshot);
      expect(fixture.latest).toHaveBeenCalledWith('circle-packing');
      const unknown = await fetch(`${fixture.origin}/api/agent/research-context/retained-latest?activeOffset=0`, { headers });
      expect(unknown.status).toBe(400); expect(fixture.latest).toHaveBeenCalledTimes(1);
      const exact = await fetch(`${fixture.origin}/api/agent/research-context/snapshots/${snapshot.snapshotId}`, { headers });
      expect(exact.status).toBe(200); expect(await exact.json()).toEqual(snapshot);
      expect(fixture.exact).toHaveBeenCalledWith(context.projectId,snapshot.snapshotId);
    } finally { await close(fixture.server); }
  });
});
