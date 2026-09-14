import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationRouters, createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { createResearchMemoryService, ResearchMemoryError, type ResearchMemoryService } from '../../server/research-memory/index.ts';
import { contributionFixture } from '../fixtures/motive-evidence-contribution.ts';

const configuredDatabaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const localDatabaseUrl = (() => {
  if (!configuredDatabaseUrl) return undefined;
  const parsed = new URL(configuredDatabaseUrl);
  return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ? configuredDatabaseUrl : undefined;
})();
const pgDescribe = localDatabaseUrl ? describe : describe.skip;
const fixtureBytes = readFileSync(new URL('../fixtures/hypothesis-context-v1.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as Record<string, any>;

pgDescribe('targeted Hypothesis context on isolated PostgreSQL', () => {
  const databaseName = `motive_targeted_context_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:targeted-context-${randomUUID()}`;
  const vaultKey = Buffer.alloc(32, 23); const apiKey = `he_${'t'.repeat(43)}`;
  const tenantId = randomUUID(); const projectSlug = 'circle-packing';
  const channelId = String(fixture.channel.id); const channelName = String(fixture.channel.name);
  const hypothesisId = String(fixture.hypothesis.id); const firstEvidenceId = String(fixture.evidence_page.items[0].id);
  const firstReadAt = '2026-11-01T10:00:00.000Z'; const secondReadAt = '2026-11-01T10:05:00.000Z';
  let admin: Pool; let pool: Pool; let projectId: string; let scopeId: string;
  let research: ResearchMemoryService; let participation: ParticipationService; let bearer: string;
  let clock = firstReadAt; let responseBody: unknown = fixture; let calls: Array<{ url: URL; init?: RequestInit }> = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (new Headers(init?.headers).get('X-API-Key') !== apiKey) return json({ detail: 'invalid key' }, 401);
    if (url.pathname.endsWith(`/channels/${channelName}/context/hypotheses/${hypothesisId}`)) return json(responseBody);
    return json({ detail: 'not found' }, 404);
  };

  beforeAll(async () => {
    const source = new URL(localDatabaseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    await applyPostgresMigrations(pool); expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: projectSlug, visibility: 'PUBLIC', revisionContent: { title: 'Targeted context adapter test' } });
    projectId = project.id; scopeId = randomUUID();
    const encrypted = encryptSecret(vaultKey, apiKey, `research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,
      '1.8.0',$10,'CONNECTED',$11,$12)`, [scopeId,projectId,tenantId,channelId,channelName,`sha256:${'a'.repeat(64)}`,
      encrypted,`sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'d'.repeat(40),issuer,firstReadAt]);
    research = createResearchMemoryService({ pool, vaultKey, fetch: fetcher, now: () => new Date(clock) });
    participation = createParticipationService(pool, { tokenSecret: `targeted-context-${'s'.repeat(48)}`, issuerActorId: issuer,
      validateResearchContext: research.assertContext.bind(research), validateResearchReferences: research.assertReferences.bind(research) });
    await participation.ensureCircleWorkOrder();
    const joined = await participation.join(`account:${randomUUID()}`, 'Targeted Context Tester', {
      projectSlug, publishDisplayName: false, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    bearer = joined.token;
  }, 30_000);

  beforeEach(() => { responseBody = fixture; calls = []; });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  const snapshotCount = async () => Number((await pool.query(
    'SELECT count(*)::int AS count FROM motive.research_context_snapshots')).rows[0].count);

  it('parses the actual engine serializer fixture with one GET and reuses unchanged retained identity', async () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex'))
      .toBe('821f71bb13a89fb31f4720d8e3d78a05e6bbf684f97c024163e3a5d877dcd29a');
    clock = firstReadAt;
    const first = await research.getHypothesisContext(projectSlug, hypothesisId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/channels/${channelName}/context/hypotheses/${hypothesisId}`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ expected_channel_id: channelId, evidence_offset: '0' });
    expect(new Headers(calls[0]!.init?.headers).get('X-API-Key')).toBe(apiKey);
    expect(first).toMatchObject({ format: 'motive.research-hypothesis-context.v1', scopeId, projectSlug,
      channelName, channelGoal: fixture.channel.goal, retrievedAt: firstReadAt, engineReadCompletedAt: firstReadAt,
      selection: { kind: 'hypothesis', hypothesisId, evidenceOffset: 0, evidenceLimit: 20 },
      hypotheses: [{ id: hypothesisId, status: 'inconclusive', evidenceTotal: 4, evidenceTruncated: false,
        outcome: { result: 'mixed', narrative: null, evidenceSummary: null, actualVsPredicted: null, effectSize: null } }] });
    expect(first.hypotheses[0].evidence.map(item => item.id)).toEqual(fixture.evidence_page.items.map((item: any) => item.id));
    expect(first.hypotheses[0].evidence.slice(0, 3).map(item => item.createdAt)).toEqual([
      '2026-05-02T03:07:00.123Z', '2026-05-02T03:07:00.123Z', '2026-05-02T03:07:00.123Z']);
    const firstRetained = await research.getSnapshot(projectId, first.snapshotId);
    expect(firstRetained).not.toHaveProperty('engineReadCompletedAt'); expect(calls).toHaveLength(1);

    clock = secondReadAt; calls = [];
    const unchanged = await research.getHypothesisContext(projectSlug, hypothesisId);
    expect(calls).toHaveLength(1); expect(unchanged.snapshotId).toBe(first.snapshotId);
    expect(unchanged.snapshotDigest).toBe(first.snapshotDigest); expect(unchanged.retrievedAt).toBe(firstReadAt);
    expect(unchanged.engineReadCompletedAt).toBe(secondReadAt); expect(await snapshotCount()).toBe(1);
  });

  it('retains archived empty offset pages with full counts and a selection-bound digest', async () => {
    const empty = structuredClone(fixture); empty.evidence_page.items = []; empty.evidence_page.offset = 100000;
    responseBody = empty; clock = secondReadAt;
    const targeted = await research.getHypothesisContext(projectSlug, hypothesisId, 100000);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ expected_channel_id: channelId, evidence_offset: '100000' });
    expect(targeted.selection).toEqual({ kind: 'hypothesis', hypothesisId, evidenceOffset: 100000, evidenceLimit: 20 });
    expect(targeted.hypotheses[0]).toMatchObject({ id: hypothesisId, evidence: [], evidenceTotal: 4, evidenceTruncated: true });
    expect(targeted.snapshotDigest).toBe(digestCanonicalJson({ format: targeted.format, scopeId: targeted.scopeId,
      projectSlug: targeted.projectSlug, channelName: targeted.channelName, channelGoal: targeted.channelGoal,
      selection: targeted.selection, hypotheses: targeted.hypotheses }));
  });

  it.each([
    ['envelope keys', () => ({ ...structuredClone(fixture), extra: true })],
    ['channel identity', () => { const body = structuredClone(fixture); body.channel.id = randomUUID(); return body; }],
    ['hypothesis identity', () => { const body = structuredClone(fixture); body.hypothesis.id = randomUUID(); return body; }],
    ['hypothesis channel', () => { const body = structuredClone(fixture); body.hypothesis.channel = 'foreign'; return body; }],
    ['archive boolean', () => { const body = structuredClone(fixture); body.hypothesis.is_archived = 'true'; return body; }],
    ['page keys', () => { const body = structuredClone(fixture); body.evidence_page.extra = true; return body; }],
    ['page cardinality', () => { const body = structuredClone(fixture); body.evidence_page.total = 5; return body; }],
    ['duplicate evidence', () => { const body = structuredClone(fixture); body.evidence_page.items[1].id = body.evidence_page.items[0].id; return body; }],
    ['evidence membership', () => { const body = structuredClone(fixture); body.evidence_page.items[0].hypothesis_id = randomUUID(); return body; }],
    ['submillisecond order', () => { const body = structuredClone(fixture);
      [body.evidence_page.items[0],body.evidence_page.items[1]] = [body.evidence_page.items[1],body.evidence_page.items[0]]; return body; }],
    ['UUID tie order', () => { const body = structuredClone(fixture);
      [body.evidence_page.items[1],body.evidence_page.items[2]] = [body.evidence_page.items[2],body.evidence_page.items[1]]; return body; }],
    ['full type counts', () => { const body = structuredClone(fixture); body.hypothesis.evidence_counts.neutral = 1; return body; }],
    ['returned type counts', () => { const body = structuredClone(fixture);
      body.hypothesis.evidence_counts = { supporting: 0, contradicting: 2, neutral: 2 }; return body; }],
  ])('rejects malformed %s after one GET without inserting', async (_label, makeBody) => {
    responseBody = makeBody(); const before = await snapshotCount();
    await expect(research.getHypothesisContext(projectSlug, hypothesisId)).rejects.toBeInstanceOf(ResearchMemoryError);
    expect(calls).toHaveLength(1); expect(await snapshotCount()).toBe(before);
  });

  it('accepts the largest escaped-character response that fits and rejects wrapper overflow before INSERT', async () => {
    const maximumBytes = 524_288; const control = '\u0001'; const minimumControls = 20;
    const bodyWithControls = (total: number) => {
      const body = structuredClone(fixture); let remaining = total;
      body.hypothesis.evidence_counts = { supporting: 0, contradicting: 0, neutral: 20 };
      body.evidence_page.items = Array.from({ length: 20 }, (_, index) => {
        const rowsLeft = 20 - index; const length = Math.min(5000, remaining - (rowsLeft - 1)); remaining -= length;
        return { ...structuredClone(fixture.evidence_page.items[2]),
          id: `${(0xfffffff0 - index).toString(16)}-5555-4555-8555-555555555555`,
          content: control.repeat(length), evidence_type: 'neutral', created_at: '2026-05-02T03:07:00.123456Z' };
      });
      body.evidence_page.total = 20; return body;
    };
    const payloadWithControls = (seedPayload: Record<string, any>, body: Record<string, any>) => {
      const payload = structuredClone(seedPayload);
      payload.hypotheses[0].evidence = payload.hypotheses[0].evidence.map((evidence: Record<string, any>, index: number) => {
        const { contentDigest: _oldDigest, ...core } = evidence; core.content = body.evidence_page.items[index].content;
        return { ...core, contentDigest: digestCanonicalJson(core) };
      });
      return payload;
    };
    responseBody = bodyWithControls(minimumControls); calls = []; clock = secondReadAt;
    const seed = await research.getHypothesisContext(projectSlug,hypothesisId);
    const { snapshotId: _snapshotId, retrievedAt: _retrievedAt, snapshotDigest: _snapshotDigest,
      engineReadCompletedAt: _engineReadCompletedAt, notice, ...seedPayload } = seed;
    const seedRawBytes = Buffer.byteLength(JSON.stringify(responseBody),'utf8');
    const seedPayloadBytes = Buffer.byteLength(JSON.stringify(seedPayload),'utf8');
    const prospective = { ...seedPayload, snapshotId: randomUUID(), retrievedAt: secondReadAt,
      snapshotDigest: digestCanonicalJson(seedPayload), engineReadCompletedAt: secondReadAt, notice };
    const seedResponseBytes = Buffer.byteLength(JSON.stringify(prospective),'utf8');
    const maxRawControls = minimumControls + Math.floor((maximumBytes-seedRawBytes)/6);
    const maxPayloadControls = minimumControls + Math.floor((maximumBytes-seedPayloadBytes)/6);
    const maxResponseControls = minimumControls + Math.floor((maximumBytes-seedResponseBytes)/6);
    const acceptedControls = Math.min(100_000,maxRawControls,maxPayloadControls,maxResponseControls);
    const rejectedControls = acceptedControls + 1;
    expect(rejectedControls).toBeLessThanOrEqual(Math.min(100_000,maxRawControls,maxPayloadControls));

    const acceptedBody = bodyWithControls(acceptedControls);
    const acceptedPayload = payloadWithControls(seedPayload,acceptedBody);
    responseBody = acceptedBody; calls = [];
    const accepted = await research.getHypothesisContext(projectSlug,hypothesisId);
    expect(calls).toHaveLength(1); expect(Buffer.byteLength(JSON.stringify(accepted),'utf8')).toBeLessThanOrEqual(maximumBytes);
    expect(Buffer.byteLength(JSON.stringify(accepted),'utf8')).toBeGreaterThan(maximumBytes-6);
    expect(Buffer.byteLength(JSON.stringify(acceptedPayload),'utf8')).toBeLessThanOrEqual(maximumBytes);

    const rejectedBody = bodyWithControls(rejectedControls);
    const rejectedPayload = payloadWithControls(seedPayload,rejectedBody);
    const rejectedResponse = { ...rejectedPayload, snapshotId: randomUUID(), retrievedAt: secondReadAt,
      snapshotDigest: digestCanonicalJson(rejectedPayload), engineReadCompletedAt: secondReadAt, notice };
    expect(Buffer.byteLength(JSON.stringify(rejectedBody),'utf8')).toBeLessThanOrEqual(maximumBytes);
    expect(Buffer.byteLength(JSON.stringify(rejectedPayload),'utf8')).toBeLessThanOrEqual(maximumBytes);
    expect(Buffer.byteLength(JSON.stringify(rejectedResponse),'utf8')).toBeGreaterThan(maximumBytes);
    const before = await snapshotCount(); responseBody = rejectedBody; calls = [];
    await expect(research.getHypothesisContext(projectSlug,hypothesisId)).rejects.toMatchObject({ code: 'UPSTREAM',
      message: 'Hypothesis context exceeded the response limit.' });
    expect(calls).toHaveLength(1); expect(await snapshotCount()).toBe(before);
  });

  it('allows citations only to actual targeted members and keeps latest channel context channel-only', async () => {
    responseBody = fixture; const targeted = await research.getHypothesisContext(projectSlug, hypothesisId);
    const observedUpdatedAt = targeted.hypotheses[0].updatedAt;
    await research.assertContext(projectId, { scopeId, snapshotId: targeted.snapshotId, snapshotDigest: targeted.snapshotDigest });
    await research.assertReferences(projectId, [{ scopeId, snapshotId: targeted.snapshotId, snapshotDigest: targeted.snapshotDigest,
      hypothesisId, observedUpdatedAt, evidenceIds: [firstEvidenceId] }]);
    await expect(research.assertReferences(projectId, [{ scopeId, snapshotId: targeted.snapshotId,
      snapshotDigest: targeted.snapshotDigest, hypothesisId, observedUpdatedAt, evidenceIds: [randomUUID()] }]))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(research.assertReferences(projectId, [{ scopeId, snapshotId: targeted.snapshotId,
      snapshotDigest: targeted.snapshotDigest, hypothesisId: randomUUID(), observedUpdatedAt, evidenceIds: [] }]))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(research.getLatestRetainedContext(projectSlug)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const channelPayload = { format: 'motive.research-context.v1', scopeId, projectSlug, channelName,
      channelGoal: fixture.channel.goal, hypotheses: [], hypothesesTotal: 0, hypothesesTruncated: false,
      activeHypothesesTotal: 0, archivedHypothesesTotal: 0, insights: [], insightsTotal: 0, insightsTruncated: false,
      page: { activeOffset: 0, archivedOffset: 0, insightOffset: 0, activeLimit: 6, archivedLimit: 6, insightLimit: 20 } } as const;
    const channelIdForSnapshot = randomUUID();
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',$6)`, [channelIdForSnapshot,scopeId,projectId,digestCanonicalJson(channelPayload),
      JSON.stringify(channelPayload),'2026-11-01T11:00:00.000Z']);
    expect((await research.getLatestRetainedContext(projectSlug)).snapshotId).toBe(channelIdForSnapshot);
    expect((await research.getSnapshot(projectId,targeted.snapshotId)).format).toBe('motive.research-hypothesis-context.v1');
    expect(calls).toHaveLength(1);
  });

  it('binds confirmed per-evidence provenance and omits it after remote edits', async () => {
    const body = structuredClone(fixture);
    const remote = body.evidence_page.items[1]; remote.source = 'https://motive-md.vercel.app/observation-fixture';
    responseBody = body;
    const proof = contributionFixture(remote, scopeId, channelId);
    let lookups = 0;
    const reader = createResearchMemoryService({ pool, vaultKey, fetch: fetcher,
      confirmedEvidenceContributions: async (project, scope, targets) => {
        lookups += 1; expect(project).toBe(projectId); expect(scope).toBe(scopeId);
        expect(targets).toHaveLength(4); expect(targets).toContainEqual({ hypothesisId, evidenceId: remote.id });
        return new Map([[remote.id, proof]]);
      } });
    const first = await reader.getHypothesisContext(projectSlug, hypothesisId);
    expect(lookups).toBe(1); expect(first.hypotheses[0].evidence[1]!.motiveContribution).toEqual(proof);
    expect(first.hypotheses[0]).not.toHaveProperty('motiveSubmission');
    const retainedFirst = await reader.getSnapshot(projectId, first.snapshotId);
    expect(retainedFirst.hypotheses[0]!.evidence[1]!.motiveContribution).toEqual(proof);
    for (const [field, changed] of [['content', 'Changed after delivery'], ['source', 'urn:edited'],
      ['created_by', 'another-agent'], ['evidence_type', 'supporting']]) {
      responseBody = structuredClone(body); (responseBody as any).evidence_page.items[1][field!] = changed;
      if (field === 'evidence_type') {
        (responseBody as any).hypothesis.evidence_counts.neutral -= 1;
        (responseBody as any).hypothesis.evidence_counts.supporting += 1;
      }
      const edited = await reader.getHypothesisContext(projectSlug, hypothesisId);
      expect(edited.hypotheses[0].evidence[1]).not.toHaveProperty('motiveContribution');
      expect(edited.snapshotDigest).not.toBe(first.snapshotDigest);
    }
    expect((await reader.getSnapshot(projectId, first.snapshotId)).snapshotDigest).toBe(first.snapshotDigest);
  });

  it('serves the strict route to an authenticated current contributor and denies invalid requests before engine access', async () => {
    responseBody = fixture; calls = [];
    const { agentRouter } = createParticipationRouters({ service: participation, researchMemory: research, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    const origin = `http://127.0.0.1:${address.port}`; const headers = { Authorization: `Bearer ${bearer}` };
    try {
      const anonymous = await fetch(`${origin}/api/agent/research-context/hypotheses/${hypothesisId}`);
      expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');
      for (const suffix of ['?other=1','?evidenceOffset=01','?evidenceOffset=-1','?evidenceOffset=1.0',
        '?evidenceOffset=100001','?evidenceOffset=1&evidenceOffset=2']) {
        expect((await fetch(`${origin}/api/agent/research-context/hypotheses/${hypothesisId}${suffix}`, { headers })).status, suffix).toBe(400);
      }
      expect((await fetch(`${origin}/api/agent/research-context/hypotheses/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`, { headers })).status).toBe(400);
      expect(calls).toHaveLength(0);
      const accepted = await fetch(`${origin}/api/agent/research-context/hypotheses/${hypothesisId}?evidenceOffset=0`, { headers });
      expect(accepted.status).toBe(200); expect((await accepted.json()).format).toBe('motive.research-hypothesis-context.v1');
      expect(calls).toHaveLength(1);
      const context = await participation.authenticateBearer(bearer);
      await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',
        [context.projectId,context.ownerActorId]);
      expect((await fetch(`${origin}/api/agent/research-context/hypotheses/${hypothesisId}`, { headers })).status).toBe(401);
      expect(calls).toHaveLength(1);
    } finally { server.close(); await once(server, 'close'); }
  });
});
