import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import Decimal from 'decimal.js';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson, validateWorkOrderTerms, type Digest } from '../../packages/domain/src/contracts.ts';
import { profileDigest, validateAndFreezeProfile, type GatewayProfile } from '../../packages/inference-gateway/src/profile.ts';
import type {
  ActivateProjectFundingBudgetInput, ActivateProjectFundingBudgetResponse, CreateProjectFundingBudgetInput,
  CreateProjectFundingBudgetResponse, FundingModel, FundingReadinessCode, FundingStatusResponse,
  OpenRouterConnection, ProjectFundingBudget, StartOpenRouterConnectResponse,
} from '../../src/lib/funding.ts';
import { decryptSecret, encryptSecret } from './vault.ts';
import {
  createPkce, exchangeOpenRouterCode, listOpenRouterModels, openRouterAuthorizationUrl, validateOpenRouterKey,
  type OpenRouterKeyMetadata,
} from './openrouter.ts';
import { readCircleFundingReadiness } from './readiness.ts';
import { ProjectRunProjectionService } from '../project-runs/projection.ts';
import {
  CIRCLE_APPROVED_CONTENT_DIGEST,
  CIRCLE_FUNDED_ALLOWED_EFFECTS,
  CIRCLE_FUNDED_MODEL,
  CIRCLE_FUNDED_WORK_OBJECTIVE,
  CIRCLE_FUNDED_WORK_ORDER_KEY,
  CIRCLE_FUNDED_WORK_ORDER_REVISION,
  CIRCLE_PROJECT_SLUG,
  isApprovedCircleRevisionBinding,
  isApprovedCircleWorkPurpose,
} from './circle-work-authority.ts';

export const OPENROUTER_GATEWAY_CREDENTIAL_REF = 'openrouter:project-funding';

export type FundingErrorCode =
  | 'INVALID_REQUEST' | 'IDEMPOTENCY_REQUIRED' | 'IDEMPOTENCY_CONFLICT' | 'CONNECTION_REQUIRED'
  | 'CONNECT_FLOW_EXPIRED' | 'CONNECT_FLOW_USED' | 'PROVIDER_REJECTED' | 'PROJECT_NOT_FOUND'
  | 'MODEL_UNAVAILABLE' | 'BUDGET_UNAVAILABLE' | 'ASSIGNMENT_REQUIRED' | 'WORK_ORDER_REQUIRED'
  | 'PROFILE_REQUIRED' | 'CONTROLLER_CLOSED';

export class FundingError extends Error {
  constructor(readonly code: FundingErrorCode, message: string, readonly status = 400) {
    super(message); this.name = 'FundingError';
  }
}

export type OpenRouterFundingServiceOptions = {
  pool: Pool;
  vaultKey: Uint8Array;
  /** URL of the app page that handles `code` and `openrouter_flow` in memory. */
  callbackUrl: string;
  /** Exact browser origins allowed to receive an OAuth callback. */
  allowedCallbackOrigins?: readonly string[];
  gatewayUrl: string;
  profiles?: readonly GatewayProfile[];
  fetch?: typeof globalThis.fetch;
  flowTtlSeconds?: number;
  capabilityTtlSeconds?: number;
  /** Trusted project operator used for server-managed circle-packing runs. */
  projectLeadActorId?: string;
  /** Better Auth/account-store liveness check; provider resolution fails closed when the account is gone. */
  isActorActive: (actorId: string) => Promise<boolean>;
};

type ProfileEntry = { profile: Readonly<GatewayProfile>; digest: Digest };

function hash(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function iso(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null; }
function text(row: QueryResultRow, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error(`Missing ${key}.`); return value; }

function parseUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new FundingError('INVALID_REQUEST', `${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[\x21-\x7e]{1,128}$/.test(value)) throw new FundingError('IDEMPOTENCY_REQUIRED', 'Idempotency-Key must contain 1 to 128 visible ASCII characters.');
  return value;
}

function canonicalAmount(value: Decimal.Value): string {
  return new Decimal(value).toFixed(12).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function normalizeUsd(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) throw new FundingError('INVALID_REQUEST', 'limitUsd must be a positive USD decimal with at most 12 fractional digits.');
  const amount = new Decimal(value);
  if (!amount.isPositive() || amount.greaterThan(10_000)) throw new FundingError('INVALID_REQUEST', 'limitUsd must be greater than zero and no more than 10000 USD.');
  return canonicalAmount(amount);
}

function parseExpiry(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new FundingError('INVALID_REQUEST', 'expiresAt must be an ISO timestamp.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now() + 60_000) throw new FundingError('INVALID_REQUEST', 'expiresAt must be at least one minute in the future.');
  return parsed.toISOString();
}

function deterministicUuid(actorId: string, key: string): string {
  const bytes = createHash('sha256').update(`funding-budget\0${actorId}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function connectionProjection(row: QueryResultRow): OpenRouterConnection {
  const metadata = (row.provider_metadata ?? {}) as Record<string, unknown>;
  return {
    id: text(row, 'id'), provider: 'openrouter', status: text(row, 'status') as OpenRouterConnection['status'],
    label: typeof metadata.label === 'string' ? metadata.label : null,
    connectedAt: iso(row.connected_at) ?? (() => { throw new Error('Missing connected_at.'); })(),
    expiresAt: typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null,
    limitUsd: typeof metadata.limitUsd === 'string' ? metadata.limitUsd : null,
    limitRemainingUsd: typeof metadata.limitRemainingUsd === 'string' ? metadata.limitRemainingUsd : null,
    isFreeTier: typeof metadata.isFreeTier === 'boolean' ? metadata.isFreeTier : null,
  };
}

function budgetProjection(row: QueryResultRow, readiness: FundingReadinessCode): ProjectFundingBudget {
  return {
    id: text(row, 'id'), provider: 'openrouter', project: text(row, 'slug'), projectId: text(row, 'project_id'),
    sourceId: text(row, 'source_id'), grantId: row.grant_id === null ? null : text(row, 'grant_id'),
    workOrderId: row.work_order_id === null ? null : text(row, 'work_order_id'),
    assignedAgentId: row.assigned_agent_id === null ? null : text(row, 'assigned_agent_id'),
    beneficiaryActorId: row.beneficiary_actor_id === null || row.beneficiary_actor_id === undefined ? null : text(row, 'beneficiary_actor_id'),
    model: text(row, 'model_id'),
    limitUsd: canonicalAmount(text(row, 'limit_usd')), expiresAt: iso(row.expires_at), status: text(row, 'status') as ProjectFundingBudget['status'],
    readiness, createdAt: iso(row.created_at) ?? (() => { throw new Error('Missing created_at.'); })(), run: null,
  };
}

export class OpenRouterFundingService {
  private readonly ledger: LedgerKernel;
  private readonly fetchProvider: typeof globalThis.fetch;
  private readonly profiles: ProfileEntry[];
  private readonly flowTtlSeconds: number;
  private readonly capabilityTtlSeconds: number;
  private readonly allowedCallbackOrigins: ReadonlySet<string>;
  private readonly projectLeadActorId: string;
  private catalogCache: { expiresAt: number; models: FundingModel[] } | null = null;
  /**
   * A session advisory lock must keep its checked-out client until unlock.
   * Serializing these two mutations per warm process prevents concurrent lock
   * waiters from occupying every client while the lock owner performs nested
   * ledger queries through the same small application pool. PostgreSQL still
   * provides the cross-process lock.
   */
  private fundingMutationTail: Promise<void> = Promise.resolve();

  private serializeFundingMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fundingMutationTail.then(operation);
    this.fundingMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  constructor(private readonly options: OpenRouterFundingServiceOptions) {
    if (options.vaultKey.byteLength !== 32) throw new Error('Funding vault key must contain 32 bytes.');
    const callback = new URL(options.callbackUrl);
    if (!['https:', 'http:'].includes(callback.protocol)) throw new Error('Funding callback URL must use HTTP or HTTPS.');
    this.ledger = new LedgerKernel(options.pool);
    const upstreamFetch = options.fetch ?? globalThis.fetch;
    this.fetchProvider = async (input, init) => {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15_000); timer.unref();
      try { return await upstreamFetch(input, { ...init, signal: abort.signal }); } finally { clearTimeout(timer); }
    };
    this.flowTtlSeconds = options.flowTtlSeconds ?? 600;
    this.capabilityTtlSeconds = options.capabilityTtlSeconds ?? 300;
    this.projectLeadActorId = options.projectLeadActorId ?? 'operator:seed';
    if (!/^operator:[A-Za-z0-9._~-]{1,480}$/.test(this.projectLeadActorId)) throw new Error('Project lead actor must be a trusted operator identity.');
    this.allowedCallbackOrigins = new Set(options.allowedCallbackOrigins ?? [callback.origin]);
    for (const origin of this.allowedCallbackOrigins) {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('Each funding callback origin must be an exact HTTP(S) origin.');
    }
    this.profiles = (options.profiles ?? []).map(input => {
      const profile = validateAndFreezeProfile(input);
      if (profile.status !== 'reviewed-live' || profile.evidence.kind !== 'gate-a-reviewed') throw new Error('Funding activation requires a reviewed live Gateway profile.');
      if (profile.upstream.credentialRef !== OPENROUTER_GATEWAY_CREDENTIAL_REF) throw new Error('Funding profiles must use the shared source-bound OpenRouter credential reference.');
      return { profile, digest: profileDigest(profile) };
    });
  }

  async startConnect(actorId: string, requestOrigin?: string): Promise<StartOpenRouterConnectResponse> {
    const flowId = randomBytes(32).toString('base64url');
    const tokenDigest = hash(flowId);
    const { verifier, challenge } = createPkce();
    const expiresAt = new Date(Date.now() + this.flowTtlSeconds * 1000).toISOString();
    const callback = new URL(this.options.callbackUrl);
    if (requestOrigin) {
      if (!this.allowedCallbackOrigins.has(requestOrigin)) throw new FundingError('INVALID_REQUEST', 'The callback origin is not allowed.', 403);
      const selected = new URL(requestOrigin); callback.protocol = selected.protocol; callback.host = selected.host;
    }
    callback.searchParams.set('openrouter_flow', flowId);
    const encrypted = encryptSecret(this.options.vaultKey, verifier, `openrouter-flow:${tokenDigest}:${actorId}`);
    await this.options.pool.query(
      `INSERT INTO motive.provider_connect_flows
       (token_digest, owner_actor_id, provider, encrypted_code_verifier, callback_url, expires_at)
       VALUES ($1, $2, 'openrouter', $3, $4, $5)`,
      [tokenDigest, actorId, encrypted, callback.toString(), expiresAt],
    );
    return { flowId, authorizationUrl: openRouterAuthorizationUrl(callback.toString(), challenge), expiresAt };
  }

  async completeConnect(actorId: string, flowId: string, code: string): Promise<OpenRouterConnection> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(flowId) || !code || code.length > 4096 || !/^[\x21-\x7e]+$/.test(code)) {
      throw new FundingError('INVALID_REQUEST', 'The OpenRouter callback is invalid.');
    }
    const tokenDigest = hash(flowId);
    const claimed = await this.options.pool.query(
      `UPDATE motive.provider_connect_flows SET consumed_at = clock_timestamp()
       WHERE token_digest = $1 AND owner_actor_id = $2 AND consumed_at IS NULL AND expires_at > clock_timestamp()
       RETURNING encrypted_code_verifier`, [tokenDigest, actorId],
    );
    if (claimed.rowCount !== 1) {
      const found = await this.options.pool.query('SELECT consumed_at, expires_at FROM motive.provider_connect_flows WHERE token_digest = $1 AND owner_actor_id = $2', [tokenDigest, actorId]);
      if (found.rowCount !== 1) throw new FundingError('CONNECT_FLOW_EXPIRED', 'This connect flow is missing, expired, or belongs to another account.', 409);
      if (found.rows[0].consumed_at !== null) throw new FundingError('CONNECT_FLOW_USED', 'This connect flow was already used. Start a new connection.', 409);
      throw new FundingError('CONNECT_FLOW_EXPIRED', 'This connect flow expired. Start a new connection.', 409);
    }
    let key: string; let metadata: OpenRouterKeyMetadata;
    try {
      const verifier = decryptSecret(this.options.vaultKey, claimed.rows[0].encrypted_code_verifier, `openrouter-flow:${tokenDigest}:${actorId}`);
      key = await exchangeOpenRouterCode(this.fetchProvider, code, verifier);
      metadata = await validateOpenRouterKey(this.fetchProvider, key);
    } catch {
      throw new FundingError('PROVIDER_REJECTED', 'OpenRouter could not complete this connection. Start a new connection.', 502);
    }
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`openrouter-connection:${actorId}`]);
      const current = await client.query('SELECT id FROM motive.provider_connections WHERE owner_actor_id = $1 AND provider = $2 FOR UPDATE', [actorId, 'openrouter']);
      const id = current.rowCount === 1 ? text(current.rows[0], 'id') : randomUUID();
      const credentialRef = `openrouter:${id}`;
      const encrypted = encryptSecret(this.options.vaultKey, key, `openrouter-key:${id}:${actorId}`);
      const values = [id, actorId, credentialRef, encrypted, hash(key), JSON.stringify(metadata)];
      const saved = await client.query(
        `INSERT INTO motive.provider_connections
         (id, owner_actor_id, provider, credential_ref, status, encrypted_credential, credential_fingerprint, provider_metadata)
         VALUES ($1, $2, 'openrouter', $3, 'CONNECTED', $4, $5, $6::jsonb)
         ON CONFLICT (owner_actor_id, provider) DO UPDATE SET status = 'CONNECTED', encrypted_credential = EXCLUDED.encrypted_credential,
           credential_fingerprint = EXCLUDED.credential_fingerprint, provider_metadata = EXCLUDED.provider_metadata,
           connected_at = clock_timestamp(), disconnected_at = NULL, updated_at = clock_timestamp()
         RETURNING *`, values,
      );
      await client.query('COMMIT');
      return connectionProjection(saved.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async models(): Promise<FundingModel[]> {
    if (this.catalogCache && this.catalogCache.expiresAt > Date.now()) return this.catalogCache.models.map(model => ({ ...model }));
    const models = await listOpenRouterModels(this.fetchProvider);
    const ready = new Set(this.profiles.map(item => item.profile.route.model));
    const result = models.map(model => ({ ...model, activationProfileReady: ready.has(model.id) }));
    this.catalogCache = { expiresAt: Date.now() + 60_000, models: result };
    return result.map(model => ({ ...model }));
  }

  private profileFor(model: string): ProfileEntry | null { return this.profiles.find(item => item.profile.route.model === model) ?? null; }

  async readiness(actorId: string) {
    return readCircleFundingReadiness(this.options.pool, actorId, this.profiles.map(item => item.profile));
  }

  async status(actorId: string): Promise<FundingStatusResponse> {
    const [connection, controller, budgetRows, availableModels, actorActive] = await Promise.all([
      this.options.pool.query("SELECT * FROM motive.provider_connections WHERE owner_actor_id = $1 AND provider = 'openrouter'", [actorId]),
      this.options.pool.query('SELECT spending_enabled FROM motive.controller_state WHERE singleton = TRUE'),
      this.options.pool.query(
        `SELECT budget.*, project.slug, activation.status AS activation_status,
           CASE WHEN budget.assigned_agent_id IS NULL THEN budget.beneficiary_actor_id IS NOT NULL ELSE EXISTS (
             SELECT 1 FROM motive.participation_agent_tokens agent WHERE agent.id=budget.assigned_agent_id
               AND agent.owner_actor_id=budget.owner_actor_id AND agent.project_id=budget.project_id
               AND agent.revoked_at IS NULL AND agent.expires_at > clock_timestamp()) END AS agent_active
         FROM motive.provider_project_budgets budget
         JOIN motive.projects project ON project.id = budget.project_id
         LEFT JOIN motive.provider_budget_activations activation ON activation.budget_id=budget.id
         WHERE budget.owner_actor_id = $1 ORDER BY budget.created_at DESC`, [actorId]),
      this.models().catch(() => []),
      this.options.isActorActive(actorId),
    ]);
    const connected = connection.rowCount === 1 && connection.rows[0].status === 'CONNECTED';
    const spendingOpen = controller.rows[0]?.spending_enabled === true;
    const budgets = budgetRows.rows.map(row => budgetProjection(row,
      row.status === 'REVOKED' ? 'GRANT_REVOKED' : !connected ? 'CONNECTION_REQUIRED'
        : row.activation_status === 'AWAITING_DISPATCH' ? 'AWAITING_DISPATCH'
        : !this.profileFor(text(row, 'model_id')) ? 'PROFILE_REQUIRED' : !spendingOpen ? 'CONTROLLER_CLOSED'
          : !actorActive || row.agent_active !== true ? 'ASSIGNMENT_REQUIRED' : row.work_order_id === null ? 'WORK_ORDER_REQUIRED' : 'READY'));
    if (actorActive && budgets.length) {
      const receipts = await new ProjectRunProjectionService(this.options.pool, this.options.isActorActive)
        .donorReceipts(actorId, budgets.map(budget => budget.id));
      for (const budget of budgets) budget.run = receipts.get(budget.id) ?? null;
    }
    return {
      provider: 'openrouter', currency: 'USD', connection: connection.rowCount === 1 ? connectionProjection(connection.rows[0]) : null,
      budgets, availableModels, executionEnabled: budgets.some(budget => budget.readiness === 'READY' && budget.status === 'ACTIVE'),
      message: 'A connection and project budget do not spend by themselves. A reviewed hosted work order, assigned agent, and open controller are required.',
    };
  }

  createBudget(actorId: string, idempotencyHeader: string | undefined, input: CreateProjectFundingBudgetInput): Promise<CreateProjectFundingBudgetResponse> {
    return this.serializeFundingMutation(() => this.createBudgetExclusive(actorId, idempotencyHeader, input));
  }

  private async createBudgetExclusive(actorId: string, idempotencyHeader: string | undefined, input: CreateProjectFundingBudgetInput): Promise<CreateProjectFundingBudgetResponse> {
    const idempotencyKey = parseIdempotencyKey(idempotencyHeader);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FundingError('INVALID_REQUEST', 'Budget input is required.');
    if (typeof input.project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.project)) throw new FundingError('INVALID_REQUEST', 'project must be a valid project slug.');
    if (typeof input.model !== 'string' || input.model.length > 256 || !input.model.includes('/')) throw new FundingError('INVALID_REQUEST', 'model must be an exact provider model ID.');
    const limitUsd = normalizeUsd(input.limitUsd); const expiresAt = parseExpiry(input.expiresAt);
    const body = { project: input.project, limitUsd, model: input.model, expiresAt: expiresAt ?? null };
    const requestDigest = digestCanonicalJson(body);
    const lock = await this.options.pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`provider-budget:${actorId}:${idempotencyKey}`]);
      const existing = await lock.query(
        `SELECT budget.*, project.slug FROM motive.provider_project_budgets budget JOIN motive.projects project ON project.id = budget.project_id
         WHERE budget.owner_actor_id = $1 AND budget.idempotency_key = $2`, [actorId, idempotencyKey]);
      if (existing.rowCount === 1) {
        if (existing.rows[0].request_digest !== requestDigest) throw new FundingError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different budget.', 409);
        return { budget: budgetProjection(existing.rows[0], this.profileFor(input.model) ? 'CONTROLLER_CLOSED' : 'PROFILE_REQUIRED'), replayed: true };
      }
      const connection = await lock.query("SELECT * FROM motive.provider_connections WHERE owner_actor_id = $1 AND provider = 'openrouter' AND status = 'CONNECTED'", [actorId]);
      if (connection.rowCount !== 1) throw new FundingError('CONNECTION_REQUIRED', 'Connect OpenRouter before authorizing a project budget.', 409);
      const project = await lock.query("SELECT id, slug FROM motive.projects WHERE slug = $1 AND visibility = 'PUBLIC'", [input.project]);
      if (project.rowCount !== 1) throw new FundingError('PROJECT_NOT_FOUND', 'The public project was not found.', 404);
      const catalog = await this.models();
      if (!catalog.some(item => item.id === input.model)) throw new FundingError('MODEL_UNAVAILABLE', 'The exact model is not currently listed by OpenRouter.', 409);
      const budgetId = deterministicUuid(actorId, idempotencyKey);
      const source = await this.ledger.createFundingSource({
        actorId, idempotencyKey: `provider-budget-source:${idempotencyKey}`, authorizedAmount: limitUsd as `${number}`,
        ...(expiresAt ? { expiresAt } : {}), metadata: { provider: 'openrouter', connectionId: text(connection.rows[0], 'id'),
          credentialRef: OPENROUTER_GATEWAY_CREDENTIAL_REF, budgetId, model: input.model, project: input.project },
      });
      const inserted = await lock.query(
        `INSERT INTO motive.provider_project_budgets
         (id, connection_id, owner_actor_id, project_id, source_id, provider, model_id, limit_usd, expires_at, status, idempotency_key, request_digest)
         VALUES ($1, $2, $3, $4, $5, 'openrouter', $6, $7, $8, 'WAITING_TO_ACTIVATE', $9, $10)
         RETURNING *, $11::text AS slug`,
        [budgetId, text(connection.rows[0], 'id'), actorId, text(project.rows[0], 'id'), source.id, input.model, limitUsd, expiresAt ?? null, idempotencyKey, requestDigest, input.project],
      );
      return { budget: budgetProjection(inserted.rows[0], this.profileFor(input.model) ? 'CONTROLLER_CLOSED' : 'PROFILE_REQUIRED'), replayed: false };
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`provider-budget:${actorId}:${idempotencyKey}`]).catch(() => undefined);
      lock.release();
    }
  }

  activateBudget(actorId: string, budgetIdInput: string, idempotencyHeader: string | undefined, input: ActivateProjectFundingBudgetInput): Promise<ActivateProjectFundingBudgetResponse> {
    return this.serializeFundingMutation(() => this.activateBudgetExclusive(actorId, budgetIdInput, idempotencyHeader, input));
  }

  private async activateBudgetExclusive(actorId: string, budgetIdInput: string, idempotencyHeader: string | undefined, input: ActivateProjectFundingBudgetInput): Promise<ActivateProjectFundingBudgetResponse> {
    const budgetId = parseUuid(budgetIdInput, 'budgetId');
    const lock = await this.options.pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`provider-budget-activation:${budgetId}`]);
      const response = await this.activateBudgetLocked(actorId, budgetId, idempotencyHeader, input);
      response.budget.run = await new ProjectRunProjectionService(this.options.pool, this.options.isActorActive)
        .donorReceipt(actorId, budgetId);
      return response;
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`provider-budget-activation:${budgetId}`]).catch(() => undefined);
      lock.release();
    }
  }

  private async activateBudgetLocked(actorId: string, budgetId: string, idempotencyHeader: string | undefined, input: ActivateProjectFundingBudgetInput): Promise<ActivateProjectFundingBudgetResponse> {
    const idempotencyKey = parseIdempotencyKey(idempotencyHeader);
    if (!input || typeof input !== 'object' || !('workOrderId' in input)
        || ('mode' in input && input.mode !== undefined && input.mode !== 'DONOR_AGENT' && input.mode !== 'PROJECT_LEAD')) {
      throw new FundingError('INVALID_REQUEST', 'Choose a donor agent or the server-managed project lead.');
    }
    const projectLeadMode = input.mode === 'PROJECT_LEAD';
    const agentId = projectLeadMode ? null : parseUuid('agentId' in input ? input.agentId : undefined, 'agentId');
    const workOrderId = parseUuid(input.workOrderId, 'workOrderId');
    // Keep the original digest for existing donor-agent idempotency records.
    const requestDigest = projectLeadMode ? digestCanonicalJson({ mode: 'PROJECT_LEAD', workOrderId }) : digestCanonicalJson({ agentId, workOrderId });
    const budgetResult = await this.options.pool.query(
      `SELECT budget.*, project.slug, connection.status AS connection_status FROM motive.provider_project_budgets budget
       JOIN motive.projects project ON project.id = budget.project_id JOIN motive.provider_connections connection ON connection.id = budget.connection_id
       WHERE budget.id = $1 AND budget.owner_actor_id = $2`, [budgetId, actorId]);
    if (budgetResult.rowCount !== 1 || budgetResult.rows[0].status === 'REVOKED') throw new FundingError('BUDGET_UNAVAILABLE', 'The project budget is unavailable.', 404);
    const budget = budgetResult.rows[0];
    if (budget.connection_status !== 'CONNECTED') throw new FundingError('CONNECTION_REQUIRED', 'Reconnect OpenRouter before activation.', 409);
    const controller = await this.options.pool.query('SELECT spending_enabled FROM motive.controller_state WHERE singleton = TRUE');
    if (controller.rows[0]?.spending_enabled !== true) throw new FundingError('CONTROLLER_CLOSED', 'Hosted spending remains closed by the controller.', 409);
    if (!await this.options.isActorActive(actorId)) throw new FundingError('ASSIGNMENT_REQUIRED', 'The funding account is no longer active.', 409);
    if (!projectLeadMode) {
      const agent = await this.options.pool.query(
        `SELECT id FROM motive.participation_agent_tokens WHERE id = $1 AND owner_actor_id = $2 AND project_id = $3
         AND revoked_at IS NULL AND expires_at > clock_timestamp()`, [agentId, actorId, budget.project_id]);
      if (agent.rowCount !== 1) throw new FundingError('ASSIGNMENT_REQUIRED', 'Select one of your active agents for this project.', 409);
    }
    const work = await this.options.pool.query(
      `SELECT work.id, work.terms, work.terms_digest, work.created_by, work.work_order_key, work.revision,
         work.project_revision, project.current_revision, revision.content_digest
       FROM motive.work_orders work JOIN motive.work_order_states state ON state.work_order_id = work.id
       JOIN motive.projects project ON project.id=work.project_id
       JOIN motive.project_revisions revision ON revision.project_id=work.project_id AND revision.revision=work.project_revision
       WHERE work.id = $1 AND work.project_id = $2 AND state.state = 'READY' AND state.admission_closed_at IS NULL`, [workOrderId, budget.project_id]);
    if (work.rowCount !== 1) throw new FundingError('WORK_ORDER_REQUIRED', 'A ready hosted work order is required.', 409);
    const terms = work.rows[0].terms as { hosted?: { enabled?: boolean; inference?: { profile_digest?: string; ceiling?: string } } };
    if (terms.hosted?.enabled !== true || typeof terms.hosted.inference?.profile_digest !== 'string' || typeof terms.hosted.inference.ceiling !== 'string') {
      throw new FundingError('WORK_ORDER_REQUIRED', 'The selected work order does not enable hosted inference.', 409);
    }
    const profile = this.profileFor(text(budget, 'model_id'));
    if (!profile || profile.digest !== terms.hosted.inference.profile_digest) throw new FundingError('PROFILE_REQUIRED', 'The work order does not pin the reviewed profile for this exact model.', 409);
    let beneficiaryActorId: string;
    if (projectLeadMode) {
      const workRow = work.rows[0];
      let frozenTerms;
      try { frozenTerms = validateWorkOrderTerms(workRow.terms); }
      catch { throw new FundingError('WORK_ORDER_REQUIRED', 'Project-lead funding requires a valid frozen work order.', 409); }
      if (text(budget, 'slug') !== CIRCLE_PROJECT_SLUG || text(budget, 'model_id') !== CIRCLE_FUNDED_MODEL
          || workRow.created_by !== this.projectLeadActorId || workRow.work_order_key !== CIRCLE_FUNDED_WORK_ORDER_KEY
          || Number(workRow.revision) !== CIRCLE_FUNDED_WORK_ORDER_REVISION
          || frozenTerms.project_id !== text(budget, 'project_id')
          || !isApprovedCircleWorkPurpose({ objective: frozenTerms.objective, allowedEffects: frozenTerms.allowed_effects })
          || workRow.terms_digest !== digestCanonicalJson(frozenTerms)
          || !isApprovedCircleRevisionBinding({
            currentProjectRevision: workRow.current_revision,
            workProjectRevision: workRow.project_revision,
            termsProjectRevision: frozenTerms.project_revision,
            contentDigest: workRow.content_digest,
          })) {
        throw new FundingError('WORK_ORDER_REQUIRED', 'Project-lead funding requires the exact operator-prepared circle-packing work order.', 409);
      }
      const authority = await this.options.pool.query(
        `SELECT 1 FROM motive.memberships WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL AND role IN ('OWNER','STEWARD')`,
        [budget.project_id, this.projectLeadActorId]);
      if (authority.rowCount !== 1) throw new FundingError('ASSIGNMENT_REQUIRED', 'The trusted project lead no longer has project authority.', 409);
      beneficiaryActorId = this.projectLeadActorId;
      if (beneficiaryActorId.startsWith('account:') && !await this.options.isActorActive(beneficiaryActorId)) {
        throw new FundingError('ASSIGNMENT_REQUIRED', 'The project lead account is no longer active.', 409);
      }
    } else beneficiaryActorId = `agent:${agentId}`;
    const ceiling = canonicalAmount(Decimal.min(new Decimal(text(budget, 'limit_usd')), new Decimal(terms.hosted.inference.ceiling)));
    try {
      await this.options.pool.query(
        `INSERT INTO motive.provider_budget_activations
         (budget_id, assigned_agent_id, beneficiary_actor_id, work_order_id, profile_digest, idempotency_key, request_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (budget_id) DO NOTHING`,
        [budgetId, agentId, beneficiaryActorId, workOrderId, profile.digest, idempotencyKey, requestDigest]);
      let activation = await this.options.pool.query('SELECT * FROM motive.provider_budget_activations WHERE budget_id = $1', [budgetId]);
      const activationRow = activation.rows[0];
      if (!activationRow || activationRow.request_digest !== requestDigest || activationRow.idempotency_key !== idempotencyKey
          || activationRow.status === 'REVOKED') {
        throw new FundingError('IDEMPOTENCY_CONFLICT', 'This budget already has a different or revoked activation intent.', 409);
      }
      const grant = await this.ledger.createGrant({ actorId, idempotencyKey: `provider-budget-grant:${idempotencyKey}`, sourceId: text(budget, 'source_id'),
        projectId: text(budget, 'project_id'), limitAmount: text(budget, 'limit_usd') as `${number}`, beneficiaryActorId,
        ...(iso(budget.expires_at) ? { expiresAt: iso(budget.expires_at)! } : {}) });
      await this.options.pool.query(
        'UPDATE motive.provider_budget_activations SET grant_id = $2, updated_at = clock_timestamp() WHERE budget_id = $1 AND status <> \'REVOKED\'',
        [budgetId, grant.id]);
      const attempt = await this.ledger.reserveAttempt({ actorId, idempotencyKey: `provider-budget-attempt:${idempotencyKey}`,
        grantId: grant.id, workOrderId, ceilingAmount: ceiling as `${number}`, profileDigest: profile.digest,
        inputDigest: projectLeadMode
          ? digestCanonicalJson({ budgetId, beneficiaryActorId, workOrderId })
          : digestCanonicalJson({ budgetId, agentId, workOrderId }) });
      await this.options.pool.query(
        'UPDATE motive.provider_budget_activations SET attempt_id = $2, updated_at = clock_timestamp() WHERE budget_id = $1 AND status <> \'REVOKED\'',
        [budgetId, attempt.id]);
      if (projectLeadMode) {
        const client = await this.options.pool.connect();
        try {
          await client.query('BEGIN');
          const activationUpdated = await client.query(
            `UPDATE motive.provider_budget_activations SET grant_id=$2, attempt_id=$3, status='AWAITING_DISPATCH', updated_at=clock_timestamp()
             WHERE budget_id=$1 AND status IN ('PENDING','AWAITING_DISPATCH')`, [budgetId, grant.id, attempt.id]);
          const updated = await client.query(
            `UPDATE motive.provider_project_budgets SET grant_id=$2, assigned_agent_id=NULL, beneficiary_actor_id=$3, work_order_id=$4,
             status='ACTIVE', updated_at=clock_timestamp() WHERE id=$1 AND status IN ('WAITING_TO_ACTIVATE','ACTIVE')
             AND EXISTS (SELECT 1 FROM motive.provider_connections connection WHERE connection.id=connection_id AND connection.status='CONNECTED')
             RETURNING *, $5::text AS slug`, [budgetId, grant.id, beneficiaryActorId, workOrderId, text(budget, 'slug')]);
          if (activationUpdated.rowCount !== 1 || updated.rowCount !== 1) throw new FundingError('BUDGET_UNAVAILABLE', 'The budget was revoked while activation was being finalized.', 409);
          await client.query('COMMIT');
          return { budget: budgetProjection(updated.rows[0], 'AWAITING_DISPATCH'), activation: {
            kind: 'PROJECT_LEAD', beneficiaryActorId, attemptId: attempt.id, status: 'AWAITING_DISPATCH' } };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      activation = await this.options.pool.query('SELECT * FROM motive.provider_budget_activations WHERE budget_id = $1', [budgetId]);
      const previousEpoch = Number(activation.rows[0].delivery_epoch);
      let previousCapabilityId = activation.rows[0].capability_id as string | null;
      if (!previousCapabilityId) {
        const possiblyIssued = await this.options.pool.query(
          `SELECT resource_id FROM motive.idempotency_records WHERE actor_id = $1 AND action = 'run-capability.issue'
           AND idempotency_key = $2`, [actorId, `provider-budget-capability:${idempotencyKey}:${previousEpoch + 1}`]);
        previousCapabilityId = possiblyIssued.rows[0]?.resource_id ?? null;
      }
      if (previousCapabilityId) {
        await this.ledger.revokeRunCapability({ actorId, idempotencyKey: `provider-budget-capability-revoke:${idempotencyKey}:${previousEpoch + 1}`,
          capabilityId: previousCapabilityId, reason: 'Replaced after an authenticated activation retry.' });
      }
      const nextEpoch = previousEpoch + (previousCapabilityId ? 2 : 1);
      const issued = await this.ledger.issueRunCapability({ actorId, idempotencyKey: `provider-budget-capability:${idempotencyKey}:${nextEpoch}`,
        attemptId: attempt.id, ttlSeconds: this.capabilityTtlSeconds });
      const client = await this.options.pool.connect();
      try {
        await client.query('BEGIN');
        const activationUpdated = await client.query(
          `UPDATE motive.provider_budget_activations SET grant_id=$2, attempt_id=$3, capability_id=$4,
           capability_expires_at=$5, delivery_epoch=$6, status='ACTIVE', updated_at=clock_timestamp()
           WHERE budget_id=$1 AND status <> 'REVOKED'`,
          [budgetId, grant.id, attempt.id, issued.context.capabilityId, issued.context.expiresAt, nextEpoch]);
        const updated = await client.query(
          `UPDATE motive.provider_project_budgets SET grant_id = $2, assigned_agent_id = $3, beneficiary_actor_id=$6, work_order_id = $4,
           status = 'ACTIVE', updated_at = clock_timestamp() WHERE id = $1 AND status IN ('WAITING_TO_ACTIVATE','ACTIVE')
           AND EXISTS (SELECT 1 FROM motive.provider_connections connection WHERE connection.id=connection_id AND connection.status='CONNECTED')
           RETURNING *, $5::text AS slug`,
          [budgetId, grant.id, agentId, workOrderId, text(budget, 'slug'), beneficiaryActorId]);
        if (activationUpdated.rowCount !== 1 || updated.rowCount !== 1) throw new FundingError('BUDGET_UNAVAILABLE', 'The budget was revoked while activation was being finalized.', 409);
        await client.query('COMMIT');
        return { budget: budgetProjection(updated.rows[0], 'READY'), activation: {
          kind: 'DONOR_AGENT', beneficiaryActorId, attemptId: attempt.id }, capability: { capability: issued.capability,
          gatewayUrl: this.options.gatewayUrl, expiresAt: issued.context.expiresAt, attemptId: attempt.id, model: text(budget, 'model_id') } };
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof FundingError) {
          await this.ledger.revokeRunCapability({ actorId, idempotencyKey: `provider-budget-finalize-revoke:${issued.context.capabilityId}`,
            capabilityId: issued.context.capabilityId, reason: 'Budget activation could not be finalized.' }).catch(() => undefined);
        }
        throw error;
      } finally { client.release(); }
    } catch (error) {
      if (error instanceof FundingError) throw error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code === 'CONTROLLER_FROZEN') throw new FundingError('CONTROLLER_CLOSED', 'Hosted spending remains closed by the controller.', 409);
      throw error;
    }
  }

  async disconnect(actorId: string): Promise<void> {
    const client = await this.options.pool.connect();
    let grantRows: QueryResultRow[] = [];
    try {
      await client.query('BEGIN');
      const budgets = await client.query(
        `SELECT budget.id FROM motive.provider_project_budgets budget JOIN motive.provider_connections connection ON connection.id=budget.connection_id
         WHERE connection.owner_actor_id=$1 ORDER BY budget.id`, [actorId]);
      for (const budget of budgets.rows) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`provider-budget-activation:${text(budget, 'id')}`]);
      }
      const grants = await client.query(
        `SELECT COALESCE(budget.grant_id,activation.grant_id) AS grant_id, activation.attempt_id,
           activation.status AS activation_status, activation.assigned_agent_id, activation.capability_id
         FROM motive.provider_project_budgets budget JOIN motive.provider_connections connection ON connection.id = budget.connection_id
         LEFT JOIN motive.provider_budget_activations activation ON activation.budget_id=budget.id
         WHERE connection.owner_actor_id = $1 AND COALESCE(budget.grant_id,activation.grant_id) IS NOT NULL`, [actorId]);
      grantRows = grants.rows;
      await client.query(
        `UPDATE motive.provider_connections SET status = 'DISCONNECTED', encrypted_credential = NULL,
         disconnected_at = clock_timestamp(), updated_at = clock_timestamp() WHERE owner_actor_id = $1 AND provider = 'openrouter'`, [actorId]);
      await client.query(
        `UPDATE motive.provider_project_budgets SET status = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE owner_actor_id = $1 AND status <> 'REVOKED'`, [actorId]);
      await client.query(
        `UPDATE motive.provider_budget_activations activation SET status='REVOKED', updated_at=clock_timestamp()
         FROM motive.provider_project_budgets budget WHERE activation.budget_id=budget.id AND budget.owner_actor_id=$1
           AND activation.status <> 'REVOKED'`, [actorId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    for (const row of grantRows) {
      await this.ledger.revokeGrant({ actorId, idempotencyKey: `provider-disconnect:${text(row, 'grant_id')}`, grantId: text(row, 'grant_id'), reason: 'OpenRouter connection disconnected by its owner.' });
      // A project-lead activation has not issued any bearer or started a
      // coordinator effect, so its financial attempt can be closed safely.
      if ((row.activation_status === 'AWAITING_DISPATCH'
          || (row.activation_status === 'PENDING' && row.assigned_agent_id === null && row.capability_id === null))
          && row.attempt_id !== null) {
        await this.ledger.closeAttempt({ actorId, idempotencyKey: `provider-disconnect-close:${text(row, 'attempt_id')}`,
          attemptId: text(row, 'attempt_id') });
      }
    }
  }

  async resolveCredential(sourceId: string, credentialRef: string): Promise<string | null> {
    if (credentialRef !== OPENROUTER_GATEWAY_CREDENTIAL_REF) return null;
    const result = await this.options.pool.query(
      `SELECT connection.id, connection.owner_actor_id, connection.encrypted_credential, budget.beneficiary_actor_id
       FROM motive.provider_project_budgets budget JOIN motive.provider_connections connection ON connection.id = budget.connection_id
       LEFT JOIN motive.participation_agent_tokens agent ON agent.id = budget.assigned_agent_id
       JOIN motive.projects project ON project.id = budget.project_id
       JOIN motive.work_orders work ON work.id=budget.work_order_id
       JOIN motive.project_revisions revision ON revision.project_id=project.id AND revision.revision=project.current_revision
       WHERE budget.source_id = $1 AND budget.status = 'ACTIVE' AND connection.status = 'CONNECTED'
         AND project.visibility = 'PUBLIC' AND work.project_id=budget.project_id AND work.project_revision=project.current_revision
         AND ((budget.assigned_agent_id IS NOT NULL AND agent.owner_actor_id = budget.owner_actor_id AND agent.project_id = budget.project_id
           AND agent.revoked_at IS NULL AND agent.expires_at > clock_timestamp()
           AND budget.beneficiary_actor_id='agent:' || agent.id::text)
         OR (budget.assigned_agent_id IS NULL AND budget.beneficiary_actor_id=$2 AND work.created_by=$2
           AND work.work_order_key=$3 AND work.revision=$4
           AND project.slug=$5 AND project.current_revision > 0
           AND revision.content_digest=$6 AND budget.model_id=$7
           AND work.terms->>'objective'=$8
           AND work.terms->'allowed_effects'=$9::jsonb
           AND work.terms->>'project_id'=project.id::text
           AND work.terms->>'project_revision'=project.current_revision::text
           AND EXISTS (SELECT 1 FROM motive.memberships membership WHERE membership.project_id=budget.project_id
             AND membership.actor_id=$2 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD'))))`,
      [sourceId, this.projectLeadActorId, CIRCLE_FUNDED_WORK_ORDER_KEY, CIRCLE_FUNDED_WORK_ORDER_REVISION,
        CIRCLE_PROJECT_SLUG, CIRCLE_APPROVED_CONTENT_DIGEST, CIRCLE_FUNDED_MODEL,
        CIRCLE_FUNDED_WORK_OBJECTIVE, JSON.stringify(CIRCLE_FUNDED_ALLOWED_EFFECTS)]);
    if (result.rowCount !== 1 || !result.rows[0].encrypted_credential) return null;
    if (!await this.options.isActorActive(text(result.rows[0], 'owner_actor_id'))) return null;
    const beneficiaryActorId = text(result.rows[0], 'beneficiary_actor_id');
    if (beneficiaryActorId.startsWith('account:') && !await this.options.isActorActive(beneficiaryActorId)) return null;
    try { return decryptSecret(this.options.vaultKey, result.rows[0].encrypted_credential,
      `openrouter-key:${text(result.rows[0], 'id')}:${text(result.rows[0], 'owner_actor_id')}`); }
    catch { return null; }
  }
}

export { parseIdempotencyKey };
