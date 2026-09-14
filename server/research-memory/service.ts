import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { decryptSecret, encryptSecret } from '../funding/vault.ts';
import type {
  ResearchContextSnapshot, ResearchEvidenceSnapshot, ResearchHypothesisContextSnapshot, ResearchHypothesisSnapshot, ResearchMotiveSubmission,
  ResearchContextPage, ResearchInsightSnapshot, ResearchScopePublic, ResearchSnapshotReference,
  ResearchRetainedSnapshot, ResearchEvidenceMotiveContribution,
} from '../../src/lib/research-memory.ts';
import type { SubmissionResearchContext } from '../../src/lib/participation.ts';

const IMPLEMENTATION_REVISION = '7546920632aa48107e6ec5f1b268f2b6d6a4be14';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CANONICAL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_CONTEXT_RESPONSE_BYTES = 524_288;
const MAX_SNAPSHOT_BYTES = 524_288;
const MAX_ACTIVE_HYPOTHESES = 6;
const MAX_ARCHIVED_HYPOTHESES = 6;
const MAX_EVIDENCE = 20;
const MAX_INSIGHTS = 20;
const SNAPSHOT_NOTICE = 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.' as const;

type JsonObject = Record<string, unknown>;
type LinkInput = { apiBaseUrl: string; tenantId: string; channelId: string; channelName: string; apiKey: string; replace?: boolean };
type ContextTransport = 'legacy'|'channel-context-v1';
type Options = { pool: Pool; vaultKey: Uint8Array; fetch?: typeof fetch; timeoutMs?: number; now?: () => Date;
  contextTransport?: ContextTransport;
  confirmedEvidenceContributions?: (projectId: string, scopeId: string,
    targets: readonly { hypothesisId: string; evidenceId: string }[]) => Promise<Map<string, ResearchEvidenceMotiveContribution>>;
};
type Binding = QueryResultRow & { id: string; project_id: string; api_base_url: string; tenant_id: string; channel_id: string; channel_name: string };

export class ResearchMemoryError extends Error {
  constructor(readonly code: 'VALIDATION'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'UPSTREAM', message: string) {
    super(message); this.name = 'ResearchMemoryError';
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned malformed JSON.');
  return value as JsonObject;
}
function string(value: unknown, name: string, maximum: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > maximum) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  return value;
}
function optionalText(value: unknown, name: string, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  return value;
}
function uuid(value: unknown, name: string): string {
  const result = string(value, name, 36); if (!UUID.test(result!)) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`); return result!;
}
function iso(value: unknown, name: string): string {
  const result = string(value, name, 64)!; const date = new Date(result);
  if (!Number.isFinite(date.getTime())) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  return date.toISOString();
}
function finite(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  return value;
}
function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  return Number(value);
}
function sha(value: string | Buffer) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function aad(id: string, projectId: string) { return `research-scope:v1:${id}:${projectId}`; }
function dateText(value: unknown) { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
function exactKeys(value: JsonObject, keys: string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function orderedTimestamp(value: unknown, name: string): bigint {
  const normalized = string(value, name, 64)!;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  const milliseconds = Date.parse(`${match[1]}.000${match[3]}`);
  if (!Number.isFinite(milliseconds)) throw new ResearchMemoryError('UPSTREAM', `Hypothesis returned an invalid ${name}.`);
  const fraction = BigInt((match[2] ?? '').padEnd(9, '0'));
  return BigInt(milliseconds / 1000) * 1_000_000_000n + fraction;
}

function apiBase(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new ResearchMemoryError('VALIDATION', 'Hypothesis API base URL is invalid.'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new ResearchMemoryError('VALIDATION', 'Hypothesis API must use HTTPS, or HTTP on loopback, without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/api/v1')) throw new ResearchMemoryError('VALIDATION', 'Hypothesis API base must end with /api/v1.');
  return url.toString().replace(/\/$/, '');
}

async function boundedJson(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.ok) throw new ResearchMemoryError('UPSTREAM', `Hypothesis request failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis response exceeded the byte limit.');
  if (!response.body) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an empty response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    total += part.value.byteLength; if (total > maximumBytes) { await reader.cancel(); throw new ResearchMemoryError('UPSTREAM', 'Hypothesis response exceeded the byte limit.'); }
    chunks.push(part.value);
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned invalid UTF-8 JSON.'); }
}

export class ResearchMemoryService {
  private readonly fetcher: typeof fetch; private readonly timeoutMs: number; private readonly now: () => Date;
  private readonly contextTransport: ContextTransport;
  constructor(private readonly options: Options) {
    if (options.vaultKey.byteLength !== 32) throw new Error('Research-memory vault key must contain 32 bytes.');
    if (options.contextTransport !== undefined && options.contextTransport !== 'legacy' && options.contextTransport !== 'channel-context-v1') {
      throw new Error('Research-memory context transport is invalid.');
    }
    this.fetcher = options.fetch ?? fetch; this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 500), 10_000); this.now = options.now ?? (() => new Date());
    this.contextTransport = options.contextTransport ?? 'legacy';
  }

  private async request(base: string, path: string, apiKey?: string, signal?: AbortSignal,
    maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    try {
      const response = await this.fetcher(`${base}${path}`, { method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) } });
      return await boundedJson(response, maximumBytes);
    } catch (error) {
      if (error instanceof ResearchMemoryError) throw error;
      if (signal?.aborted) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis request timed out.');
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis request failed.');
    }
  }

  private controller() { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return { controller, done: () => { clearTimeout(timer); controller.abort(); } }; }

  async linkScope(actorId: string, projectSlug: string, input: LinkInput): Promise<ResearchScopePublic> {
    const base = apiBase(input.apiBaseUrl);
    if (!UUID.test(input.tenantId) || !UUID.test(input.channelId) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(input.channelName)
      || typeof input.apiKey !== 'string' || !/^he_[A-Za-z0-9_-]{43}$/.test(input.apiKey)) throw new ResearchMemoryError('VALIDATION', 'Hypothesis scope input is invalid.');
    const timer = this.controller(); let health: JsonObject; let keys: unknown; let channel: JsonObject;
    try {
      health = object(await this.request(base, '/health', undefined, timer.controller.signal));
      keys = await this.request(base, '/keys?include_revoked=false&limit=200', input.apiKey, timer.controller.signal);
      channel = object(await this.request(base, `/channels/${encodeURIComponent(input.channelName)}`, input.apiKey, timer.controller.signal));
    } finally { timer.done(); }
    const apiVersion = string(health.version, 'API version', 64)!;
    if (health.status !== 'ok' || health.database !== 'ok' || apiVersion !== '1.8.0') throw new ResearchMemoryError('UPSTREAM', 'Hypothesis v1.8.0 is not healthy at the configured endpoint.');
    if (!Array.isArray(keys) || !keys.length || keys.some(item => object(item).tenant_id !== input.tenantId)
      || !keys.some(item => object(item).prefix === input.apiKey.slice(0, 10))) throw new ResearchMemoryError('FORBIDDEN', 'The API key could not be verified for the declared Hypothesis workspace.');
    if (uuid(channel.id, 'channel ID') !== input.channelId || string(channel.name, 'channel name', 100) !== input.channelName) {
      throw new ResearchMemoryError('CONFLICT', 'The Hypothesis channel identity does not match the requested scope.');
    }
    const channelSnapshot = { id: input.channelId, name: input.channelName, goal: string(channel.goal, 'channel goal', 5000)!,
      createdAt: iso(channel.created_at, 'channel created_at'), updatedAt: iso(channel.updated_at, 'channel updated_at') };
    const channelDigest = digestCanonicalJson(channelSnapshot); const fingerprint = sha(input.apiKey);
    const configDigest = digestCanonicalJson({ base, tenantId: input.tenantId, channel: channelSnapshot, credentialFingerprint: fingerprint,
      apiVersion, inspectedSourceRevision: IMPLEMENTATION_REVISION });
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query(`SELECT project.id FROM motive.projects project JOIN motive.memberships membership ON membership.project_id=project.id
        WHERE project.slug=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD') FOR UPDATE OF project`, [projectSlug, actorId]);
      if (project.rowCount !== 1) throw new ResearchMemoryError('FORBIDDEN', 'An active project owner or steward is required.');
      const projectId = project.rows[0].id as string;
      const current = await client.query(`SELECT * FROM motive.project_research_scopes WHERE project_id=$1 AND status='CONNECTED' FOR UPDATE`, [projectId]);
      if (current.rowCount && current.rows[0].configuration_digest === configDigest) { await client.query('COMMIT'); return this.publicScope(projectSlug, current.rows[0]); }
      if (current.rowCount && !input.replace) throw new ResearchMemoryError('CONFLICT', 'This project already has a different research scope; explicit replacement is required.');
      const id = randomUUID(); const encrypted = encryptSecret(this.options.vaultKey, input.apiKey, aad(id, projectId)); const verifiedAt = this.now();
      const initialStatus = current.rowCount ? 'REPLACEMENT_PENDING' : 'CONNECTED';
      await client.query(`INSERT INTO motive.project_research_scopes
        (id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,channel_snapshot,channel_snapshot_digest,
         encrypted_api_key,credential_fingerprint,configuration_digest,api_version,inspected_source_revision,status,bound_by,verified_at)
        VALUES($1,$2,'hypothesis-engine',$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id,projectId,base,input.tenantId,input.channelId,input.channelName,JSON.stringify(channelSnapshot),channelDigest,encrypted,fingerprint,
        configDigest,apiVersion,IMPLEMENTATION_REVISION,initialStatus,actorId,verifiedAt]);
      if (current.rowCount) {
        await client.query(`UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1`, [current.rows[0].id,id]);
        await client.query(`UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1`, [id]);
      }
      const saved = await client.query(`SELECT * FROM motive.project_research_scopes WHERE id=$1`, [id]);
      await client.query('COMMIT'); return this.publicScope(projectSlug, saved.rows[0]);
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  private publicScope(projectSlug: string, row: QueryResultRow): ResearchScopePublic {
    return { projectSlug, scopeId: row.id as string, channelName: row.channel_name as string, status: 'CONNECTED', verifiedAt: dateText(row.verified_at) };
  }

  async getPublicScope(projectSlug: string): Promise<ResearchScopePublic | null> {
    const result = await this.options.pool.query(`SELECT scope.* FROM motive.project_research_scopes scope JOIN motive.projects project ON project.id=scope.project_id
      WHERE project.slug=$1 AND project.visibility='PUBLIC' AND scope.status='CONNECTED'`, [projectSlug]);
    return result.rowCount ? this.publicScope(projectSlug, result.rows[0]) : null;
  }

  private async binding(projectSlug: string, client: Pool|PoolClient = this.options.pool): Promise<Binding> {
    const result = await client.query(`SELECT scope.*,project.slug FROM motive.project_research_scopes scope JOIN motive.projects project ON project.id=scope.project_id
      WHERE project.slug=$1 AND scope.status='CONNECTED'`, [projectSlug]);
    if (result.rowCount !== 1) throw new ResearchMemoryError('NOT_FOUND', 'The project has no connected research scope.');
    return result.rows[0] as Binding;
  }

  async getContext(projectSlug: string, requestedPage: ResearchContextPage = {}): Promise<ResearchContextSnapshot> {
    const offset=(value:unknown,name:string)=>{
      if(value===undefined)return 0;
      if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>100000)throw new ResearchMemoryError('VALIDATION',`${name} must be an integer from 0 to 100000.`);
      return Number(value);
    };
    const page={activeOffset:offset(requestedPage.activeOffset,'activeOffset'),archivedOffset:offset(requestedPage.archivedOffset,'archivedOffset'),
      insightOffset:offset(requestedPage.insightOffset,'insightOffset'),activeLimit:6 as const,archivedLimit:6 as const,insightLimit:20 as const};
    const binding = await this.binding(projectSlug); const key = decryptSecret(this.options.vaultKey, binding.encrypted_api_key as Buffer, aad(binding.id,binding.project_id));
    const timer = this.controller();
    try {
      let channel: JsonObject; let activePageRaw: unknown; let archivedPageRaw: unknown; let insightPageRaw: unknown;
      let evidencePages: unknown[];
      if (this.contextTransport === 'channel-context-v1') {
        const query = new URLSearchParams({ expected_channel_id: binding.channel_id,
          active_offset: String(page.activeOffset), archived_offset: String(page.archivedOffset), insight_offset: String(page.insightOffset) });
        const envelope = object(await this.request(binding.api_base_url,
          `/channels/${encodeURIComponent(binding.channel_name)}/context?${query.toString()}`, key, timer.controller.signal,
          MAX_CONTEXT_RESPONSE_BYTES));
        ({ channel, activePage: activePageRaw, archivedPage: archivedPageRaw, insightPage: insightPageRaw, evidencePages }
          = this.channelContextEnvelope(envelope, binding, page));
      } else {
        channel = object(await this.request(binding.api_base_url, `/channels/${encodeURIComponent(binding.channel_name)}`, key, timer.controller.signal));
        if (uuid(channel.id,'channel ID') !== binding.channel_id || string(channel.name,'channel name',100) !== binding.channel_name) {
          throw new ResearchMemoryError('CONFLICT', 'The connected Hypothesis channel was deleted or rebound.');
        }
        [activePageRaw, archivedPageRaw, insightPageRaw] = await Promise.all([
          this.request(binding.api_base_url, `/hypotheses?channel=${encodeURIComponent(binding.channel_name)}&is_archived=false&sort_by=updated_at&sort_order=desc&limit=${MAX_ACTIVE_HYPOTHESES}&offset=${page.activeOffset}`, key, timer.controller.signal),
          this.request(binding.api_base_url, `/hypotheses?channel=${encodeURIComponent(binding.channel_name)}&is_archived=true&sort_by=updated_at&sort_order=desc&limit=${MAX_ARCHIVED_HYPOTHESES}&offset=${page.archivedOffset}`, key, timer.controller.signal),
          this.request(binding.api_base_url, `/insights?channel=${encodeURIComponent(binding.channel_name)}&limit=${MAX_INSIGHTS}&offset=${page.insightOffset}`, key, timer.controller.signal),
        ]);
        evidencePages = [];
      }
      if (uuid(channel.id,'channel ID') !== binding.channel_id || string(channel.name,'channel name',100) !== binding.channel_name) throw new ResearchMemoryError('CONFLICT', 'The connected Hypothesis channel was deleted or rebound.');
      const channelGoal = string(channel.goal,'channel goal',5000)!;
      const activePage = object(activePageRaw); const archivedPage = object(archivedPageRaw); const insightPage = object(insightPageRaw);
      const activeItems = activePage.items; const archivedItems = archivedPage.items; const insightItems = insightPage.items;
      if (!Array.isArray(activeItems) || activeItems.length > MAX_ACTIVE_HYPOTHESES || !Array.isArray(archivedItems) || archivedItems.length > MAX_ARCHIVED_HYPOTHESES
        || !Array.isArray(insightItems) || insightItems.length > MAX_INSIGHTS) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned an invalid context page.');
      const hypItems = [...activeItems,...archivedItems];
      const hypothesisIds = hypItems.map(item => uuid(object(item).id,'hypothesis ID'));
      let motiveSubmissions: Map<string, ResearchMotiveSubmission>;
      if (this.contextTransport === 'channel-context-v1') {
        motiveSubmissions = await this.motiveSubmissions(binding, hypothesisIds, projectSlug);
      } else {
        [evidencePages, motiveSubmissions] = await Promise.all([
          Promise.all(hypothesisIds.map(id => this.request(binding.api_base_url,
            `/hypotheses/${encodeURIComponent(id)}/evidence?limit=${MAX_EVIDENCE}&offset=0`, key, timer.controller.signal))),
          this.motiveSubmissions(binding, hypothesisIds, projectSlug),
        ]);
      }
      const hypotheses = hypItems.map((item,index) => this.hypothesis(object(item), evidencePages[index], binding.channel_name,
        index>=activeItems.length,motiveSubmissions.get(hypothesisIds[index]!.toLowerCase())));
      await this.enrichEvidence(binding, hypotheses);
      const insights = insightItems.map(item => this.insight(object(item), binding.channel_name));
      const activeHypothesesTotal = count(activePage.total,'active hypothesis total'); const archivedHypothesesTotal = count(archivedPage.total,'archived hypothesis total');
      const hypothesesTotal=activeHypothesesTotal+archivedHypothesesTotal; const insightsTotal = count(insightPage.total,'insight total');
      const payload = { format: 'motive.research-context.v1' as const, scopeId: binding.id, projectSlug, channelName: binding.channel_name,
        channelGoal, hypotheses, hypothesesTotal, hypothesesTruncated: page.activeOffset>0||page.archivedOffset>0
          ||page.activeOffset+activeItems.length<activeHypothesesTotal||page.archivedOffset+archivedItems.length<archivedHypothesesTotal,
        activeHypothesesTotal, archivedHypothesesTotal,
        insights, insightsTotal, insightsTruncated: page.insightOffset>0||page.insightOffset+insights.length<insightsTotal,page };
      if (Buffer.byteLength(JSON.stringify(payload),'utf8') > MAX_SNAPSHOT_BYTES) throw new ResearchMemoryError('UPSTREAM','Hypothesis context exceeded the retained snapshot limit.');
      const snapshotDigest = digestCanonicalJson(payload); const snapshotId = randomUUID(); const engineReadCompletedAt = this.now();
      await this.options.pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(scope_id,snapshot_digest) DO NOTHING`,
      [snapshotId,binding.id,binding.project_id,snapshotDigest,JSON.stringify(payload),binding.api_version,engineReadCompletedAt]);
      const saved = await this.options.pool.query(`SELECT id,retrieved_at,payload,snapshot_digest FROM motive.research_context_snapshots WHERE scope_id=$1 AND snapshot_digest=$2`, [binding.id,snapshotDigest]);
      return {...this.snapshot(saved.rows[0]) as ResearchContextSnapshot,engineReadCompletedAt:engineReadCompletedAt.toISOString()};
    } finally { timer.done(); }
  }

  async getHypothesisContext(projectSlug: string, hypothesisId: string, evidenceOffset = 0): Promise<ResearchHypothesisContextSnapshot> {
    if (!CANONICAL_UUID.test(hypothesisId)) throw new ResearchMemoryError('VALIDATION', 'hypothesisId must be a canonical lowercase UUID.');
    if (!Number.isSafeInteger(evidenceOffset) || evidenceOffset < 0 || evidenceOffset > 100000) {
      throw new ResearchMemoryError('VALIDATION', 'evidenceOffset must be an integer from 0 to 100000.');
    }
    const binding = await this.binding(projectSlug);
    const key = decryptSecret(this.options.vaultKey, binding.encrypted_api_key as Buffer, aad(binding.id, binding.project_id));
    const query = new URLSearchParams({ expected_channel_id: binding.channel_id, evidence_offset: String(evidenceOffset) });
    const timer = this.controller();
    try {
      const envelope = object(await this.request(binding.api_base_url,
        `/channels/${encodeURIComponent(binding.channel_name)}/context/hypotheses/${encodeURIComponent(hypothesisId)}?${query.toString()}`,
        key, timer.controller.signal, MAX_CONTEXT_RESPONSE_BYTES));
      const { channel, hypothesis: hypothesisRaw, evidencePage } = this.hypothesisContextEnvelope(
        envelope, binding, hypothesisId, evidenceOffset);
      const motiveSubmissions = await this.motiveSubmissions(binding, [hypothesisId], projectSlug);
      const hypothesis = this.hypothesis(hypothesisRaw, evidencePage, binding.channel_name,
        hypothesisRaw.is_archived as boolean, motiveSubmissions.get(hypothesisId));
      await this.enrichEvidence(binding, [hypothesis]);
      const payload = {
        format: 'motive.research-hypothesis-context.v1' as const,
        scopeId: binding.id,
        projectSlug,
        channelName: binding.channel_name,
        channelGoal: string(channel.goal, 'channel goal', 5000)!,
        selection: { kind: 'hypothesis' as const, hypothesisId, evidenceOffset, evidenceLimit: 20 as const },
        hypotheses: [hypothesis] as [ResearchHypothesisSnapshot],
      };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis context exceeded the retained snapshot limit.');
      }
      const snapshotDigest = digestCanonicalJson(payload); const snapshotId = randomUUID(); const engineReadCompletedAt = this.now();
      const prospectiveResponse = { ...payload, snapshotId, retrievedAt: engineReadCompletedAt.toISOString(), snapshotDigest,
        engineReadCompletedAt: engineReadCompletedAt.toISOString(), notice: SNAPSHOT_NOTICE };
      if (Buffer.byteLength(JSON.stringify(prospectiveResponse), 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis context exceeded the response limit.');
      }
      await this.options.pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(scope_id,snapshot_digest) DO NOTHING`,
      [snapshotId,binding.id,binding.project_id,snapshotDigest,JSON.stringify(payload),binding.api_version,engineReadCompletedAt]);
      const saved = await this.options.pool.query(`SELECT id,retrieved_at,payload,snapshot_digest FROM motive.research_context_snapshots
        WHERE scope_id=$1 AND snapshot_digest=$2`, [binding.id,snapshotDigest]);
      return { ...this.snapshot(saved.rows[0]) as ResearchHypothesisContextSnapshot,
        engineReadCompletedAt: engineReadCompletedAt.toISOString() };
    } finally { timer.done(); }
  }

  private async enrichEvidence(binding: Binding, hypotheses: ResearchHypothesisSnapshot[]): Promise<void> {
    const read = this.options.confirmedEvidenceContributions;
    if (!read) return;
    const targets = hypotheses.flatMap(hypothesis => hypothesis.evidence.map(evidence => ({
      hypothesisId: hypothesis.id, evidenceId: evidence.id,
    })));
    if (!targets.length) return;
    const contributions = await read(binding.project_id, binding.id, targets);
    for (const hypothesis of hypotheses) {
      hypothesis.evidence = hypothesis.evidence.map(evidence => {
        const contribution = contributions.get(evidence.id);
        const proof = contribution?.evidenceBinding;
        if (!contribution || !proof || proof.hypothesisId !== hypothesis.id || proof.evidenceId !== evidence.id
          || proof.contentDigest !== sha(evidence.content) || proof.source !== evidence.source
          || proof.createdBy !== evidence.createdBy || proof.evidenceType !== evidence.evidenceType) return evidence;
        // Bind the retained attribution to this exact remote evidence record. A
        // later edit cannot inherit attribution from an earlier confirmed write.
        const { contentDigest: _previousDigest, ...core } = evidence;
        const enriched = { ...core, motiveContribution: contribution };
        return { ...enriched, contentDigest: digestCanonicalJson(enriched) };
      });
    }
  }

  private contextPage(value: unknown, name: string, expectedOffset: number, expectedLimit: number): JsonObject {
    const page = object(value); const items = page.items; const total = count(page.total, `${name} total`);
    if (!Array.isArray(items) || page.offset !== expectedOffset || page.limit !== expectedLimit
      || items.length !== Math.min(expectedLimit, Math.max(total - expectedOffset, 0))) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an invalid channel context page.');
    }
    return page;
  }

  private channelContextEnvelope(envelope: JsonObject, binding: Binding, page: ResearchContextSnapshot['page']): {
    channel: JsonObject; activePage: JsonObject; archivedPage: JsonObject; insightPage: JsonObject; evidencePages: JsonObject[];
  } {
    if (envelope.format !== 'hypothesis.channel-context.v1') {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an unsupported channel context format.');
    }
    const channel = object(envelope.channel);
    if (uuid(channel.id, 'channel ID') !== binding.channel_id || string(channel.name, 'channel name', 100) !== binding.channel_name) {
      throw new ResearchMemoryError('CONFLICT', 'The connected Hypothesis channel was deleted or rebound.');
    }
    string(channel.goal, 'channel goal', 5000);
    const activePage = this.contextPage(envelope.active_hypotheses, 'active hypothesis', page.activeOffset, MAX_ACTIVE_HYPOTHESES);
    const archivedPage = this.contextPage(envelope.archived_hypotheses, 'archived hypothesis', page.archivedOffset, MAX_ARCHIVED_HYPOTHESES);
    const insightPage = this.contextPage(envelope.insights, 'insight', page.insightOffset, MAX_INSIGHTS);
    const activeTotal = count(activePage.total, 'active hypothesis total');
    const archivedTotal = count(archivedPage.total, 'archived hypothesis total');
    if (activeTotal > Number.MAX_SAFE_INTEGER - archivedTotal) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an invalid hypothesis total.');
    }
    const activeItems = activePage.items as unknown[]; const archivedItems = archivedPage.items as unknown[];
    const insightItems = insightPage.items as unknown[]; const hypothesisItems = [...activeItems, ...archivedItems];
    const hypothesisIds = hypothesisItems.map(value => uuid(object(value).id, 'hypothesis ID'));
    const normalizedHypothesisIds = hypothesisIds.map(id => id.toLowerCase());
    if (new Set(normalizedHypothesisIds).size !== normalizedHypothesisIds.length) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned duplicate hypothesis IDs.');
    }
    const insightIds = insightItems.map(value => uuid(object(value).id, 'insight ID').toLowerCase());
    if (new Set(insightIds).size !== insightIds.length) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned duplicate insight IDs.');
    }
    insightItems.forEach(value => this.insight(object(value), binding.channel_name));

    if (!Array.isArray(envelope.evidence_pages) || envelope.evidence_pages.length !== hypothesisIds.length) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned invalid evidence page coverage.');
    }
    const evidencePages = envelope.evidence_pages.map(value => object(value));
    const evidenceIds = new Set<string>(); const pageIds = new Set<string>();
    for (let index = 0; index < evidencePages.length; index += 1) {
      const evidencePage = evidencePages[index]!;
      const hypothesisId = uuid(evidencePage.hypothesis_id, 'evidence page hypothesis ID');
      if (hypothesisId !== hypothesisIds[index] || pageIds.has(hypothesisId.toLowerCase())) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned invalid evidence page coverage.');
      }
      pageIds.add(hypothesisId.toLowerCase());
      const validatedPage = this.contextPage(evidencePage, 'evidence', 0, MAX_EVIDENCE);
      const evidence = this.evidence(validatedPage, hypothesisId);
      const hypothesis = object(hypothesisItems[index]); const typeCounts = object(hypothesis.evidence_counts);
      const supporting = count(typeCounts.supporting, 'supporting evidence count');
      const contradicting = count(typeCounts.contradicting, 'contradicting evidence count');
      const neutral = count(typeCounts.neutral, 'neutral evidence count');
      if (supporting > evidence.total || contradicting > evidence.total - supporting
        || neutral !== evidence.total - supporting - contradicting) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned inconsistent evidence counts.');
      }
      const returned = { supporting: 0, contradicting: 0, neutral: 0 };
      evidence.items.forEach(item => {
        const normalizedId = item.id.toLowerCase();
        if (evidenceIds.has(normalizedId)) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned duplicate evidence IDs.');
        evidenceIds.add(normalizedId); returned[item.evidenceType] += 1;
      });
      if (returned.supporting > supporting || returned.contradicting > contradicting || returned.neutral > neutral) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned inconsistent evidence counts.');
      }
      this.hypothesis(hypothesis, validatedPage, binding.channel_name, index >= activeItems.length);
    }
    return { channel, activePage, archivedPage, insightPage, evidencePages };
  }

  private hypothesisContextEnvelope(envelope: JsonObject, binding: Binding, expectedHypothesisId: string, expectedOffset: number): {
    channel: JsonObject; hypothesis: JsonObject; evidencePage: JsonObject;
  } {
    if (!exactKeys(envelope, ['format', 'channel', 'hypothesis', 'evidence_page'])
      || envelope.format !== 'hypothesis.hypothesis-context.v1') {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an unsupported hypothesis context format.');
    }
    const channel = object(envelope.channel);
    if (uuid(channel.id, 'channel ID') !== binding.channel_id || string(channel.name, 'channel name', 100) !== binding.channel_name) {
      throw new ResearchMemoryError('CONFLICT', 'The connected Hypothesis channel was deleted or rebound.');
    }
    string(channel.goal, 'channel goal', 5000);
    const hypothesis = object(envelope.hypothesis);
    if (uuid(hypothesis.id, 'hypothesis ID') !== expectedHypothesisId
      || string(hypothesis.channel, 'hypothesis channel', 100, true) !== binding.channel_name
      || typeof hypothesis.is_archived !== 'boolean') {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned a mismatched hypothesis context.');
    }
    const evidencePage = object(envelope.evidence_page);
    if (!exactKeys(evidencePage, ['hypothesis_id', 'items', 'total', 'offset', 'limit'])
      || uuid(evidencePage.hypothesis_id, 'evidence page hypothesis ID') !== expectedHypothesisId) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned an invalid hypothesis evidence page.');
    }
    const validatedPage = this.contextPage(evidencePage, 'evidence', expectedOffset, MAX_EVIDENCE);
    const rawItems = validatedPage.items as unknown[]; const evidenceIds = new Set<string>();
    let previous: { createdAt: bigint; id: string } | undefined;
    for (const value of rawItems) {
      const row = object(value); const id = uuid(row.id, 'evidence ID'); const normalizedId = id.toLowerCase();
      if (evidenceIds.has(normalizedId)) throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned duplicate evidence IDs.');
      evidenceIds.add(normalizedId);
      if (uuid(row.hypothesis_id, 'evidence hypothesis ID') !== expectedHypothesisId) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned evidence from another hypothesis.');
      }
      const createdAt = orderedTimestamp(row.created_at, 'evidence created_at');
      if (previous && (createdAt > previous.createdAt
        || (createdAt === previous.createdAt && normalizedId.localeCompare(previous.id) >= 0))) {
        throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned evidence in an invalid order.');
      }
      previous = { createdAt, id: normalizedId };
    }
    const normalizedEvidence = this.evidence(validatedPage, expectedHypothesisId);
    const typeCounts = object(hypothesis.evidence_counts);
    if (!exactKeys(typeCounts, ['supporting', 'contradicting', 'neutral'])) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned invalid evidence counts.');
    }
    const supporting = count(typeCounts.supporting, 'supporting evidence count');
    const contradicting = count(typeCounts.contradicting, 'contradicting evidence count');
    const neutral = count(typeCounts.neutral, 'neutral evidence count');
    if (supporting > normalizedEvidence.total || contradicting > normalizedEvidence.total - supporting
      || neutral !== normalizedEvidence.total - supporting - contradicting) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned inconsistent evidence counts.');
    }
    const returned = { supporting: 0, contradicting: 0, neutral: 0 };
    normalizedEvidence.items.forEach(item => { returned[item.evidenceType] += 1; });
    if (returned.supporting > supporting || returned.contradicting > contradicting || returned.neutral > neutral) {
      throw new ResearchMemoryError('UPSTREAM', 'Hypothesis returned inconsistent evidence counts.');
    }
    return { channel, hypothesis, evidencePage: validatedPage };
  }

  private evidence(page: unknown, hypothesisId: string): { items: ResearchEvidenceSnapshot[]; total: number } {
    const response = object(page); const rawItems = response.items; if (!Array.isArray(rawItems) || rawItems.length > MAX_EVIDENCE) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned invalid evidence.');
    const items = rawItems.map(value => { const row=object(value);
      if(uuid(row.hypothesis_id,'evidence hypothesis ID')!==hypothesisId) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned evidence from another hypothesis.');
      const core = { id:uuid(row.id,'evidence ID'), createdAt:iso(row.created_at,'evidence created_at'),
      content:string(row.content,'evidence content',5000)!, source:optionalText(row.source,'evidence source',500), evidenceType:string(row.evidence_type,'evidence type',20)! as ResearchEvidenceSnapshot['evidenceType'],
      strength:finite(row.strength,'evidence strength'), confidenceAfter:finite(row.confidence_after,'confidence_after'), createdBy:string(row.created_by,'evidence created_by',255)! };
      if (!['supporting','contradicting','neutral'].includes(core.evidenceType)) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned an invalid evidence type.');
      return {...core,contentDigest:digestCanonicalJson(core)}; });
    return {items,total:count(response.total,'evidence total')};
  }

  private hypothesis(row: JsonObject, evidencePage: unknown, channelName: string, expectedArchived: boolean,
    motiveSubmission?: ResearchMotiveSubmission): ResearchHypothesisSnapshot {
    if(string(row.channel,'hypothesis channel',100,true)!==channelName) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned a record from another channel.');
    if(row.is_archived!==expectedArchived)throw new ResearchMemoryError('UPSTREAM','Hypothesis returned a record from the wrong archive page.');
    const core = { id:uuid(row.id,'hypothesis ID'), updatedAt:iso(row.updated_at,'hypothesis updated_at'), statement:string(row.statement,'hypothesis statement',2000)!,
      context:optionalText(row.context,'hypothesis context',5000), falsificationCriteria:optionalText(row.falsification_criteria,'falsification criteria',5000),
      status:string(row.status,'hypothesis status',30)!, confidence:finite(row.confidence,'hypothesis confidence'),
      parentId:row.parent_id===null?null:uuid(row.parent_id,'hypothesis parent ID'), outcome:this.outcome(row.outcome) };
    const evidence=this.evidence(evidencePage,core.id);
    const content = {...core,...(motiveSubmission ? {motiveSubmission} : {})};
    return {...content,contentDigest:digestCanonicalJson(content),evidence:evidence.items,evidenceTotal:evidence.total,evidenceTruncated:evidence.total>evidence.items.length};
  }

  private async motiveSubmissions(binding: Binding, hypothesisIds: string[], projectSlug: string): Promise<Map<string, ResearchMotiveSubmission>> {
    if (!hypothesisIds.length) return new Map();
    const result = await this.options.pool.query(`WITH candidates AS (
      SELECT delivery_result.resource_id AS hypothesis_id,delivery.source_submission_id AS submission_id,
        artifact.report_digest,submission.provenance ? 'investigation' AS has_investigation,
        assessment.submission_id AS assessed_submission_id,assessment.assessment,assessment.next_action,
        assessment.public_question,assessment.public_finding,assessment.created_at AS assessed_at,
        reproducibility.submission_id AS reproducibility_submission_id,
        admission.decision AS admission_decision,admission.rationale AS admission_rationale,
        admission.created_at AS admission_reviewed_at,
        finding.id AS finding_review_id,finding.decision AS finding_decision,finding.outcome AS finding_outcome,
        finding.finding,finding.limitations,finding.novelty,
        finding.duplicate_of_submission_id,finding.rationale AS finding_rationale,
        finding.created_at AS finding_reviewed_at,finding.review_package_digest AS finding_package_digest,
        finding.review_package#>>'{engine,hypothesis,id}' AS reviewed_hypothesis_id,
        finding.review_package#>>'{engine,hypothesis,responseDigest}' AS reviewed_hypothesis_response_digest,
        finding.review_package#>>'{engine,evidence,id}' AS reviewed_evidence_id,
        finding.review_package#>>'{engine,evidence,responseDigest}' AS reviewed_evidence_response_digest,
        finding.review_package#>>'{source,artifact,digest}' AS finding_artifact_digest,
        finding.review_package#>>'{source,report,digest}' AS finding_report_digest,
        token.id AS credential_id,token.agent_name,token.model_name,token.public_display_name,
        count(*) OVER (PARTITION BY delivery_result.resource_id) AS association_count
      FROM motive.hypothesis_submission_delivery_results delivery_result
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=delivery_result.delivery_id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      JOIN motive.submissions submission ON submission.id=artifact.submission_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      JOIN motive.projects project ON project.id=delivery.project_id
      LEFT JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=artifact.submission_id
      LEFT JOIN LATERAL (
        SELECT item.decision,item.rationale,item.created_at
        FROM motive.hypothesis_submission_delivery_admission_decisions item
        WHERE item.delivery_id=delivery.id AND NOT EXISTS (
          SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
          WHERE successor.previous_decision_id=item.id)
        ORDER BY item.created_at DESC,item.id DESC LIMIT 1
      ) admission ON true
      LEFT JOIN LATERAL (
        SELECT item.*
        FROM motive.finding_review_decisions item
        WHERE item.project_id=delivery.project_id AND item.source_submission_id=delivery.source_submission_id
          AND NOT EXISTS (SELECT 1 FROM motive.finding_review_decisions successor
            WHERE successor.previous_decision_id=item.id)
        ORDER BY item.created_at DESC,item.id DESC LIMIT 1
      ) finding ON true
      WHERE delivery_result.operation='DRAFT_HYPOTHESIS' AND delivery.project_id=$1 AND delivery.scope_id=$2
        AND project.slug=$3 AND project.visibility='PUBLIC' AND delivery_result.resource_id=ANY($4::uuid[])
    ) SELECT * FROM candidates WHERE association_count=1`, [binding.project_id,binding.id,projectSlug,hypothesisIds]);
    const mapped = new Map<string, ResearchMotiveSubmission>();
    for (const row of result.rows) {
      const submissionId = String(row.submission_id); const postCheck = row.assessed_submission_id ? {
        format: 'motive.post-check-assessment.public.v1' as const,
        submissionId, reportDigest: String(row.report_digest), createdAt: dateText(row.assessed_at),
        attribution: { kind: 'AGENT_DECLARED' as const, credentialId: String(row.credential_id), agentName: String(row.agent_name),
          modelName: row.model_name === null ? null : String(row.model_name),
          contributorDisplayName: row.public_display_name === null ? null : String(row.public_display_name) },
        assessment: String(row.assessment), nextAction: String(row.next_action),
        ...(row.public_question===null?{}:{publicSummary:{question:String(row.public_question),finding:String(row.public_finding)}}),
        disposition: 'AGENT_DECLARED_UNVERIFIED' as const,
        notice: 'This post-check assessment and next action are contributor statements tied to the protected checker report. They do not indicate support or acceptance.' as const,
      } : null;
      mapped.set(String(row.hypothesis_id), { submissionId, reportDigest: String(row.report_digest),
        reportHref: `/api/public/projects/${projectSlug}/submissions/${submissionId}/report`,
        investigationHref: row.has_investigation ? `/api/public/projects/${projectSlug}/submissions/${submissionId}/investigation` : null,
        postCheckAssessmentHref: postCheck ? `/api/public/projects/${projectSlug}/submissions/${submissionId}/post-check-assessment` : null,
        postCheckAssessment: postCheck,
        reproducibilityHref: row.reproducibility_submission_id
          ? `/api/public/projects/${projectSlug}/submissions/${submissionId}/reproducibility` : null,
        ...(row.admission_decision ? { latestAdmissionReview: {
          decision: String(row.admission_decision) as 'ADMIT'|'DECLINE', rationale: String(row.admission_rationale),
          reviewedAt: dateText(row.admission_reviewed_at), disposition: 'HISTORICAL_DELIVERY_REVIEW' as const,
          hypothesisSupport: 'UNASSESSED' as const, conclusionApproval: 'UNASSESSED' as const,
        } } : {}),
        ...(row.finding_review_id && row.reviewed_hypothesis_id && row.reviewed_hypothesis_response_digest
          && row.reviewed_evidence_id && row.reviewed_evidence_response_digest ? { latestFindingReview: {
          id: String(row.finding_review_id), decision: String(row.finding_decision) as 'ACCEPT'|'DECLINE',
          outcome: row.finding_outcome === null ? null : String(row.finding_outcome) as 'SUPPORTED'|'CONTRADICTED'|'INCONCLUSIVE',
          finding: row.finding === null ? null : String(row.finding),
          limitations: row.limitations === null ? null : String(row.limitations),
          novelty: row.novelty === null ? null : String(row.novelty) as 'DISTINCT'|'DUPLICATE',
          duplicateOfSubmissionId: row.duplicate_of_submission_id === null ? null : String(row.duplicate_of_submission_id),
          rationale: String(row.finding_rationale), reviewedAt: dateText(row.finding_reviewed_at),
          packageDigest: String(row.finding_package_digest), reviewedHypothesisId: String(row.reviewed_hypothesis_id),
          reviewedHypothesisResponseDigest: String(row.reviewed_hypothesis_response_digest),
          reviewedEvidenceId: String(row.reviewed_evidence_id),
          reviewedEvidenceResponseDigest: String(row.reviewed_evidence_response_digest),
          artifactDigest: String(row.finding_artifact_digest),
          reportDigest: String(row.finding_report_digest), disposition: 'HISTORICAL_FINDING_REVIEW' as const,
          hypothesisSupport: 'UNASSESSED' as const, conclusionApproval: 'UNASSESSED' as const,
        } } : {}) });
    }
    return mapped;
  }

  private outcome(value: unknown): ResearchHypothesisSnapshot['outcome'] {
    if(value===null||value===undefined)return null; const row=object(value);
    const textField=(snake:string,camel:string,maximum:number)=>optionalText(row[snake]??row[camel]??null,`outcome ${snake}`,maximum);
    const rawEffect=row.effect_size??row.effectSize??null; let effect:string|number|null;
    if(typeof rawEffect==='string')effect=optionalText(rawEffect,'outcome effect size',1000);
    else if(rawEffect===null)effect=null;
    else if(typeof rawEffect==='number'&&Number.isFinite(rawEffect))effect=rawEffect;
    else throw new ResearchMemoryError('UPSTREAM','Hypothesis returned an invalid outcome effect size.');
    return {result:textField('result','result',1000),narrative:textField('narrative','narrative',5000),evidenceSummary:textField('evidence_summary','evidenceSummary',2000),
      actualVsPredicted:textField('actual_vs_predicted','actualVsPredicted',2000),effectSize:effect};
  }

  private insight(row: JsonObject, channelName:string): ResearchInsightSnapshot {
    if(string(row.channel,'insight channel',100)!==channelName) throw new ResearchMemoryError('UPSTREAM','Hypothesis returned an insight from another channel.');
    const core={id:uuid(row.id,'insight ID'),updatedAt:iso(row.updated_at,'insight updated_at'),insightType:string(row.insight_type,'insight type',32)!,
      content:string(row.content,'insight content',10000)!,createdBy:string(row.created_by,'insight created_by',255)!};
    return {...core,contentDigest:digestCanonicalJson(core)};
  }

  private snapshot(row: QueryResultRow): ResearchRetainedSnapshot {
    const payload=row.payload as Omit<ResearchRetainedSnapshot,'snapshotId'|'retrievedAt'|'snapshotDigest'|'notice'>;
    if (payload.format !== 'motive.research-context.v1' && payload.format !== 'motive.research-hypothesis-context.v1') {
      throw new ResearchMemoryError('NOT_FOUND', 'Research snapshot not found.');
    }
    return {...payload,snapshotId:row.id as string,retrievedAt:dateText(row.retrieved_at),snapshotDigest:row.snapshot_digest as string,
      notice:SNAPSHOT_NOTICE} as ResearchRetainedSnapshot;
  }

  async getSnapshot(projectId: string, snapshotId: string, client: Pool|PoolClient = this.options.pool): Promise<ResearchRetainedSnapshot> {
    const result=await client.query(`SELECT snapshot.id,snapshot.retrieved_at,snapshot.payload,snapshot.snapshot_digest FROM motive.research_context_snapshots snapshot
      WHERE snapshot.project_id=$1 AND snapshot.id=$2`,[projectId,snapshotId]);
    if(result.rowCount!==1) throw new ResearchMemoryError('NOT_FOUND','Research snapshot not found.'); return this.snapshot(result.rows[0]);
  }

  async getLatestRetainedContext(projectSlug: string, client: Pool|PoolClient = this.options.pool): Promise<ResearchContextSnapshot> {
    const result=await client.query(`SELECT snapshot.id,snapshot.retrieved_at,snapshot.payload,snapshot.snapshot_digest
      FROM motive.projects project
      JOIN motive.project_research_scopes scope ON scope.project_id=project.id AND scope.status='CONNECTED'
      JOIN motive.research_context_snapshots snapshot ON snapshot.project_id=project.id AND snapshot.scope_id=scope.id
      WHERE project.slug=$1 AND snapshot.payload->>'format'='motive.research-context.v1'
      ORDER BY snapshot.retrieved_at DESC,snapshot.id DESC LIMIT 1`,[projectSlug]);
    if(result.rowCount!==1) throw new ResearchMemoryError('NOT_FOUND','No retained research context exists for the connected project scope.');
    return this.snapshot(result.rows[0]) as ResearchContextSnapshot;
  }

  async assertReferences(projectId: string, references: ResearchSnapshotReference[], client: Pool|PoolClient = this.options.pool): Promise<void> {
    if(!Array.isArray(references)||references.length>10) throw new ResearchMemoryError('VALIDATION','Research references exceed the limit.');
    for(const ref of references){
      if(!UUID.test(ref.scopeId)||!UUID.test(ref.snapshotId)||!UUID.test(ref.hypothesisId)||!DIGEST.test(ref.snapshotDigest)
        ||!Array.isArray(ref.evidenceIds)||ref.evidenceIds.length>20||ref.evidenceIds.some(id=>!UUID.test(id))) throw new ResearchMemoryError('VALIDATION','Research reference is malformed.');
      const result=await client.query(`SELECT snapshot.payload,snapshot.snapshot_digest FROM motive.research_context_snapshots snapshot
        WHERE snapshot.id=$1 AND snapshot.scope_id=$2 AND snapshot.project_id=$3`,[ref.snapshotId,ref.scopeId,projectId]);
      const payload=result.rows[0]?.payload as JsonObject|undefined;
      if(result.rowCount!==1||result.rows[0].snapshot_digest!==ref.snapshotDigest||!payload
        ||!['motive.research-context.v1','motive.research-hypothesis-context.v1'].includes(String(payload.format))
        ||digestCanonicalJson(payload)!==ref.snapshotDigest) throw new ResearchMemoryError('VALIDATION','Research reference does not match a retained project snapshot.');
      const hypotheses=payload.hypotheses as ResearchHypothesisSnapshot[]|undefined;
      const hypothesis=hypotheses?.find(item=>item.id===ref.hypothesisId);
      const observed=new Date(ref.observedUpdatedAt);
      if(!hypothesis||!Number.isFinite(observed.getTime())||observed.toISOString()!==ref.observedUpdatedAt||hypothesis.updatedAt!==ref.observedUpdatedAt
        ||ref.evidenceIds.some(id=>!hypothesis.evidence.some(evidence=>evidence.id===id))) throw new ResearchMemoryError('VALIDATION','Research reference does not match the retained hypothesis snapshot.');
    }
  }

  async assertContext(projectId: string, context: SubmissionResearchContext, client: Pool|PoolClient = this.options.pool): Promise<void> {
    if (!CANONICAL_UUID.test(projectId) || !context || typeof context !== 'object' || Array.isArray(context)
      || JSON.stringify(Object.keys(context).sort()) !== JSON.stringify(['scopeId', 'snapshotDigest', 'snapshotId'])
      || !CANONICAL_UUID.test(context.scopeId) || !CANONICAL_UUID.test(context.snapshotId) || !DIGEST.test(context.snapshotDigest)) {
      throw new ResearchMemoryError('VALIDATION', 'Research context is malformed.');
    }
    const result = await client.query(`SELECT snapshot.payload,snapshot.snapshot_digest
      FROM motive.research_context_snapshots snapshot
      WHERE snapshot.id=$1 AND snapshot.scope_id=$2 AND snapshot.project_id=$3`,
    [context.snapshotId, context.scopeId, projectId]);
    const payload = result.rows[0]?.payload as JsonObject | undefined;
    if (result.rowCount !== 1 || result.rows[0].snapshot_digest !== context.snapshotDigest
      || !payload || !['motive.research-context.v1', 'motive.research-hypothesis-context.v1'].includes(String(payload.format))
      || digestCanonicalJson(payload) !== context.snapshotDigest) {
      throw new ResearchMemoryError('VALIDATION', 'Research context does not match a retained project snapshot.');
    }
  }
}

export function createResearchMemoryService(options: Options){return new ResearchMemoryService(options);}
