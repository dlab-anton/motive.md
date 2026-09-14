import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  DomainValidationError,
  assertDigest,
  canonicalJson,
  digestCanonicalJson,
  validateSubmissionContract,
  validateWorkOrderTerms,
  type DecimalAmount,
  type Digest,
  type SubmissionContract,
  type WorkOrderTerms,
} from '../../domain/src/contracts.ts';
import { LedgerKernelError, fail } from './errors.ts';
import {
  ZERO_AMOUNT,
  addAmounts,
  chargedAmount,
  compareAmounts,
  exactAmount,
  minAmount,
  positiveAmount,
  reservationAmount,
  subtractAmounts,
} from './money.ts';

type JsonObject = Record<string, unknown>;

export type MutationIdentity = {
  actorId: string;
  idempotencyKey: string;
};

export type ProjectProjection = {
  id: string;
  slug: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  currentRevision: number;
  createdAt: string;
};

export type GrantProjection = {
  id: string;
  projectId: string;
  sourceId: string;
  issuerActorId: string;
  beneficiaryActorId: string | null;
  limitAmount: DecimalAmount;
  consumedAmount: DecimalAmount;
  heldAmount: DecimalAmount;
  availableAmount: DecimalAmount;
  deficitAmount: DecimalAmount;
  status: 'ACTIVE' | 'REVOKED' | 'FROZEN' | 'CLOSED';
  admissionClosedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type AttemptProjection = {
  id: string;
  projectId: string;
  workOrderId: string;
  grantId: string;
  sourceId: string;
  termsDigest: Digest;
  profileDigest: Digest;
  inputDigest: Digest;
  ceilingAmount: DecimalAmount;
  consumedAmount: DecimalAmount;
  requestHeldAmount: DecimalAmount;
  availableAmount: DecimalAmount;
  deficitAmount: DecimalAmount;
  executionStatus: string;
  leaseEpoch: number;
  controllerGeneration: string;
  admissionClosedAt: string | null;
  cancellationRequestedAt: string | null;
  createdAt: string;
};

export type OperationProjection = {
  providerOperationId: string;
  attemptId: string;
  grantId: string;
  sourceId: string;
  requestSequence: number;
  requestBodyDigest: Digest;
  reservedAmount: DecimalAmount;
  actualCost: DecimalAmount | null;
  lateAdjustmentAmount: DecimalAmount;
  status: 'ISSUING' | 'IN_FLIGHT' | 'UNKNOWN' | 'RECONCILED' | 'INCIDENT';
  admittedAt: string;
  settledAt: string | null;
  dispatchClaimedAt: string | null;
  dispatcherId: string | null;
  admissionMetadata: Record<string, unknown>;
  admissionLeaseEpoch: number | null;
  admissionControllerGeneration: string | null;
};

/**
 * The plaintext bearer token is returned only from a successful first
 * issuance.  It is deliberately absent from this context, events, journals,
 * and idempotency responses.
 */
export type RunCapabilityContext = {
  capabilityId: string;
  projectId: string;
  attemptId: string;
  grantId: string;
  sourceId: string;
  profileDigest: Digest;
  leaseEpoch: number;
  controllerGeneration: string;
  issuedByActorId: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type DispatchClaim = {
  claimed: boolean;
  operation: OperationProjection;
};

export type OutboxMessage = {
  id: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  dedupeKey: string;
  payload: unknown;
  deliveryAttempts: number;
};

export type CreateProjectInput = MutationIdentity & {
  slug: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  revisionContent: unknown;
  revisionFormat?: string;
};

export type CreateFundingSourceInput = MutationIdentity & {
  authorizedAmount: DecimalAmount;
  expiresAt?: string;
  metadata?: JsonObject;
};

export type CreateGrantInput = MutationIdentity & {
  sourceId: string;
  projectId: string;
  limitAmount: DecimalAmount;
  beneficiaryActorId?: string;
  expiresAt?: string;
};

export type CreateWorkOrderInput = MutationIdentity & {
  projectId: string;
  workOrderKey: string;
  revision: number;
  terms: unknown;
  state?: 'DRAFT' | 'READY';
};

export type ReserveAttemptInput = MutationIdentity & {
  grantId: string;
  workOrderId: string;
  ceilingAmount: DecimalAmount;
  profileDigest: Digest;
  inputDigest: Digest;
};

export type AdmitRequestInput = MutationIdentity & {
  attemptId: string;
  leaseEpoch: number;
  profileDigest: Digest;
  requestBody: unknown;
  maximumExposure: DecimalAmount;
  /** Reserved for a future durable reauthorization protocol; unsupported in P1. */
  repeatAuthorizationRef?: string;
};

export type MarkOperationInFlightInput = MutationIdentity & {
  providerOperationId: string;
  providerRequestId?: string;
};

export type MarkOperationUnknownInput = MutationIdentity & {
  providerOperationId: string;
  reason: string;
};

export type SettleOperationInput = MutationIdentity & {
  providerOperationId: string;
  actualCost: DecimalAmount;
  providerUsageId: string;
  rawProviderAmount?: string;
  rawProviderUsage?: unknown;
  providerRequestId?: string;
  providerResponseId?: string;
};

export type RecordLateUsageInput = MutationIdentity & {
  providerOperationId: string;
  providerUsageId: string;
  additionalCost: DecimalAmount;
  rawProviderAmount?: string;
  rawProviderUsage?: unknown;
};

export type RequestAttemptCancellationInput = MutationIdentity & {
  attemptId: string;
  reason?: string;
};

export type RevokeGrantInput = MutationIdentity & {
  grantId: string;
  reason?: string;
};

export type CloseAttemptInput = MutationIdentity & {
  attemptId: string;
};

export type CloseGrantInput = MutationIdentity & {
  grantId: string;
};

export type FreezeForRecoveryInput = MutationIdentity & {
  reason: string;
};

export type SetControllerSpendingInput = MutationIdentity & {
  enabled: boolean;
  reason: string;
};

export type IssueRunCapabilityInput = MutationIdentity & {
  attemptId: string;
  /** Seconds; default is intentionally short for an isolated worker run. */
  ttl?: number;
  /** Accepted as an explicit spelling for trusted callers. */
  ttlSeconds?: number;
  /** Optional only for trusted test/recovery callers; never persisted as plaintext. */
  token?: string;
};

export type RevokeRunCapabilityInput = MutationIdentity & {
  /** Revoke one exact capability, or every current capability for an attempt. */
  capabilityId?: string;
  attemptId?: string;
  reason?: string;
};

export type AdmitCapabilityRequestInput = {
  token: string;
  requestBody: unknown;
  maximumExposure: DecimalAmount;
  profileDigest: Digest;
  /** Trusted gateway-derived profile facts only; never request text or a credential. */
  admissionMetadata?: CapabilityAdmissionMetadata;
  /** A client may supply this for correlation, but it never supplies an actor. */
  idempotencyKey?: string;
};

export type CapabilityAdmissionMetadata = {
  credentialRef: string;
  requestedModel: string;
  profileId: string;
  rawBodyDigest: Digest;
  normalizedBodyDigest: Digest;
  normalizations: readonly ({
    field: 'max_output_tokens';
    from: 'omitted';
    to: number;
  } | {
    field: 'client_metadata';
    from: 'pinned-codex-0.153.4';
    to: 'omitted';
    valueDigest: Digest;
  })[];
};

export type ClaimOperationForDispatchInput = MutationIdentity & {
  providerOperationId: string;
  dispatcherId: string;
  /** A fresh random invocation identifier generated by the trusted gateway. */
  invocationToken?: string;
};

export type RecordOperationProviderIdentityInput = MutationIdentity & {
  providerOperationId: string;
  providerRequestId?: string;
  providerResponseId?: string;
};

type IdempotentResponse<T> = { response: T; resourceType?: string; resourceId?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ATTEMPT_STATES = new Set(['RESERVED', 'PROVISIONING', 'RUNNING']);
const TERMINAL_ATTEMPT_STATES = new Set(['CLOSED', 'FAILED', 'CANCELLED']);
const CONTROLLER_AGGREGATE_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_RUN_CAPABILITY_TTL_SECONDS = 20 * 60;
const MAX_RUN_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;

function requireText(value: string, name: string, maximum = 1_024): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) fail('VALIDATION', `${name} must be a non-empty string.`);
  return value;
}

function requireUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('VALIDATION', `${name} must be a UUID.`);
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) fail('VALIDATION', `${name} must be a positive integer.`);
  return value;
}

function isRunCapabilityToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value);
}

function requireRunCapabilityToken(value: string, name: string): string {
  // `randomBytes(32).toString('base64url')` produces 43 characters.  Accept
  // longer base64url/UUID-like values for an explicitly trusted test or
  // recovery caller, but do not accept a short human-chosen password.
  if (!isRunCapabilityToken(value)) {
    fail('VALIDATION', `${name} must be an opaque high-entropy token.`);
  }
  return value;
}

function capabilityTokenHash(token: string): Digest {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}` as Digest;
}

function resolveCapabilityTtlSeconds(input: Pick<IssueRunCapabilityInput, 'ttl' | 'ttlSeconds'>): number {
  if (input.ttl !== undefined && input.ttlSeconds !== undefined && input.ttl !== input.ttlSeconds) {
    fail('VALIDATION', 'ttl and ttlSeconds must agree when both are supplied.');
  }
  const value = input.ttl ?? input.ttlSeconds ?? DEFAULT_RUN_CAPABILITY_TTL_SECONDS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RUN_CAPABILITY_TTL_SECONDS) {
    fail('VALIDATION', `Capability ttl must be an integer from 1 to ${MAX_RUN_CAPABILITY_TTL_SECONDS} seconds.`);
  }
  return value;
}

function validateCapabilityAdmissionMetadata(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', 'admissionMetadata must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ['credentialRef', 'requestedModel', 'profileId', 'rawBodyDigest', 'normalizedBodyDigest', 'normalizations'];
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys.slice().sort()[index])) {
    fail('VALIDATION', 'admissionMetadata contains unsupported fields.');
  }
  const credentialRef = requireText(record.credentialRef as string, 'admissionMetadata.credentialRef', 512);
  const requestedModel = requireText(record.requestedModel as string, 'admissionMetadata.requestedModel', 512);
  const profileId = requireText(record.profileId as string, 'admissionMetadata.profileId', 256);
  const rawBodyDigest = assertDigest(record.rawBodyDigest as string, 'admissionMetadata.rawBodyDigest');
  const normalizedBodyDigest = assertDigest(record.normalizedBodyDigest as string, 'admissionMetadata.normalizedBodyDigest');
  if (!Array.isArray(record.normalizations) || record.normalizations.length > 8) {
    fail('VALIDATION', 'admissionMetadata.normalizations must contain at most eight entries.');
  }
  const normalizations: JsonObject[] = [];
  const fields = new Set<string>();
  for (const normalization of record.normalizations) {
    if (typeof normalization !== 'object' || normalization === null || Array.isArray(normalization)) {
      fail('VALIDATION', 'Each admission metadata normalization must be an object.');
    }
    const normalized = normalization as Record<string, unknown>;
    const normalizationKeys = Object.keys(normalized).sort();
    if (normalized.field === 'max_output_tokens') {
      if (normalizationKeys.length !== 3 || normalizationKeys[0] !== 'field' || normalizationKeys[1] !== 'from' || normalizationKeys[2] !== 'to'
          || normalized.from !== 'omitted') fail('VALIDATION', 'The max_output_tokens normalization is invalid.');
      const to = requirePositiveInteger(typeof normalized.to === 'number' ? normalized.to : Number.NaN,
        'admissionMetadata.normalizations.to');
      normalizations.push({ field: 'max_output_tokens', from: 'omitted', to });
    } else if (normalized.field === 'client_metadata') {
      if (normalizationKeys.length !== 4 || normalizationKeys[0] !== 'field' || normalizationKeys[1] !== 'from'
          || normalizationKeys[2] !== 'to' || normalizationKeys[3] !== 'valueDigest'
          || normalized.from !== 'pinned-codex-0.153.4' || normalized.to !== 'omitted') {
        fail('VALIDATION', 'The client_metadata normalization is invalid.');
      }
      normalizations.push({ field: 'client_metadata', from: 'pinned-codex-0.153.4', to: 'omitted',
        valueDigest: assertDigest(normalized.valueDigest as string, 'admissionMetadata.normalizations.valueDigest') });
    } else {
      fail('VALIDATION', 'Admission metadata normalization field is unsupported.');
    }
    if (fields.has(normalized.field as string)) fail('VALIDATION', 'Admission metadata cannot repeat a normalization field.');
    fields.add(normalized.field as string);
  }
  const metadata: JsonObject = { credentialRef, requestedModel, profileId, rawBodyDigest, normalizedBodyDigest, normalizations };
  canonicalJson(metadata);
  return metadata;
}

function dateOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error('Database returned an invalid timestamp.');
  return date.toISOString();
}

function asString(row: QueryResultRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Database returned ${field} as a non-string.`);
  return value;
}

function asNumber(row: QueryResultRow, field: string): number {
  const value = row[field];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Database returned ${field} as an unsafe integer.`);
  return number;
}

function asBoolean(row: QueryResultRow, field: string): boolean {
  const value = row[field];
  if (typeof value !== 'boolean') throw new Error(`Database returned ${field} as a non-boolean.`);
  return value;
}

function asAmount(row: QueryResultRow, field: string): DecimalAmount {
  return exactAmount(asString(row, field), field);
}

function asJsonObject(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Database returned ${name} as invalid JSON.`);
  return value as JsonObject;
}

function optionalText(value: string | undefined, name: string, maximum = 16_384): string | null {
  if (value === undefined) return null;
  return requireText(value, name, maximum);
}

function optionalDate(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) fail('VALIDATION', `${name} must be an ISO timestamp.`);
  return date.toISOString();
}

function grantProjection(row: QueryResultRow): GrantProjection {
  const limitAmount = asAmount(row, 'limit_amount');
  const consumedAmount = asAmount(row, 'consumed_amount');
  const heldAmount = asAmount(row, 'attempt_held_amount');
  const committedAmount = addAmounts(consumedAmount, heldAmount);
  const isDeficit = compareAmounts(committedAmount, limitAmount) > 0;
  return {
    id: asString(row, 'id'),
    projectId: asString(row, 'project_id'),
    sourceId: asString(row, 'source_id'),
    issuerActorId: asString(row, 'issuer_actor_id'),
    beneficiaryActorId: row.beneficiary_actor_id === null ? null : asString(row, 'beneficiary_actor_id'),
    limitAmount,
    consumedAmount,
    heldAmount,
    availableAmount: isDeficit ? ZERO_AMOUNT : subtractAmounts(limitAmount, committedAmount, 'grant available amount'),
    deficitAmount: isDeficit ? subtractAmounts(committedAmount, limitAmount, 'grant deficit amount') : ZERO_AMOUNT,
    status: asString(row, 'status') as GrantProjection['status'],
    admissionClosedAt: dateOrNull(row.admission_closed_at),
    expiresAt: dateOrNull(row.expires_at),
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Grant created_at is missing.'); })(),
  };
}

function attemptProjection(row: QueryResultRow): AttemptProjection {
  const ceilingAmount = asAmount(row, 'ceiling_amount');
  const consumedAmount = asAmount(row, 'consumed_amount');
  const requestHeldAmount = asAmount(row, 'request_held_amount');
  const committedAmount = addAmounts(consumedAmount, requestHeldAmount);
  const isDeficit = compareAmounts(committedAmount, ceilingAmount) > 0;
  return {
    id: asString(row, 'id'),
    projectId: asString(row, 'project_id'),
    workOrderId: asString(row, 'work_order_id'),
    grantId: asString(row, 'grant_id'),
    sourceId: asString(row, 'source_id'),
    termsDigest: assertDigest(asString(row, 'terms_digest'), 'terms_digest'),
    profileDigest: assertDigest(asString(row, 'profile_digest'), 'profile_digest'),
    inputDigest: assertDigest(asString(row, 'input_digest'), 'input_digest'),
    ceilingAmount,
    consumedAmount,
    requestHeldAmount,
    availableAmount: isDeficit ? ZERO_AMOUNT : subtractAmounts(ceilingAmount, committedAmount, 'attempt available amount'),
    deficitAmount: isDeficit ? subtractAmounts(committedAmount, ceilingAmount, 'attempt deficit amount') : ZERO_AMOUNT,
    executionStatus: asString(row, 'execution_status'),
    leaseEpoch: asNumber(row, 'lease_epoch'),
    controllerGeneration: asString(row, 'controller_generation'),
    admissionClosedAt: dateOrNull(row.admission_closed_at),
    cancellationRequestedAt: dateOrNull(row.cancellation_requested_at),
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Attempt created_at is missing.'); })(),
  };
}

function operationProjection(row: QueryResultRow): OperationProjection {
  return {
    providerOperationId: asString(row, 'provider_operation_id'),
    attemptId: asString(row, 'attempt_id'),
    grantId: asString(row, 'grant_id'),
    sourceId: asString(row, 'source_id'),
    requestSequence: asNumber(row, 'request_sequence'),
    requestBodyDigest: assertDigest(asString(row, 'request_body_digest'), 'request_body_digest'),
    reservedAmount: asAmount(row, 'reserved_amount'),
    actualCost: row.actual_cost === null ? null : asAmount(row, 'actual_cost'),
    lateAdjustmentAmount: asAmount(row, 'late_adjustment_amount'),
    status: asString(row, 'status') as OperationProjection['status'],
    admittedAt: dateOrNull(row.admitted_at) ?? (() => { throw new Error('Operation admitted_at is missing.'); })(),
    settledAt: dateOrNull(row.settled_at),
    dispatchClaimedAt: dateOrNull(row.dispatch_claimed_at),
    dispatcherId: row.dispatch_claimed_by === null || row.dispatch_claimed_by === undefined
      ? null
      : asString(row, 'dispatch_claimed_by'),
    admissionMetadata: asJsonObject(row.admission_metadata ?? {}, 'admission_metadata'),
    admissionLeaseEpoch: row.admission_lease_epoch === null || row.admission_lease_epoch === undefined
      ? null
      : asNumber(row, 'admission_lease_epoch'),
    admissionControllerGeneration: row.admission_controller_generation === null || row.admission_controller_generation === undefined
      ? null
      : asString(row, 'admission_controller_generation'),
  };
}

function runCapabilityContext(row: QueryResultRow): RunCapabilityContext {
  return {
    capabilityId: asString(row, 'id'),
    projectId: asString(row, 'project_id'),
    attemptId: asString(row, 'attempt_id'),
    grantId: asString(row, 'grant_id'),
    sourceId: asString(row, 'source_id'),
    profileDigest: assertDigest(asString(row, 'profile_digest'), 'profile_digest'),
    leaseEpoch: asNumber(row, 'lease_epoch'),
    controllerGeneration: asString(row, 'controller_generation'),
    issuedByActorId: asString(row, 'issued_by_actor_id'),
    expiresAt: dateOrNull(row.expires_at) ?? (() => { throw new Error('Run capability expires_at is missing.'); })(),
    revokedAt: dateOrNull(row.revoked_at),
  };
}

export class LedgerKernel {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query('BEGIN');
      begun = true;
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (begun) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async idempotent<T>(
    client: PoolClient,
    identity: MutationIdentity,
    action: string,
    body: unknown,
    work: () => Promise<IdempotentResponse<T>>,
  ): Promise<T> {
    const actorId = requireText(identity.actorId, 'actorId', 512);
    const key = requireText(identity.idempotencyKey, 'idempotencyKey', 512);
    const bodyDigest = digestCanonicalJson(body);
    const lockKey = `${actorId}\u001f${action}\u001f${key}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [lockKey]);
    const existing = await client.query<{ body_digest: string; response: T | null }>(
      `SELECT body_digest, response FROM motive.idempotency_records
       WHERE actor_id = $1 AND action = $2 AND idempotency_key = $3 FOR UPDATE`,
      [actorId, action, key],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.body_digest !== bodyDigest) fail('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request body.');
      if (row.response === null) fail('IDEMPOTENCY_INCOMPLETE', 'This idempotency key has an incomplete durable result and requires reconciliation.');
      return row.response;
    }
    await client.query(
      `INSERT INTO motive.idempotency_records (actor_id, action, idempotency_key, body_digest, effect_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, key, bodyDigest, randomUUID()],
    );
    const result = await work();
    await client.query(
      `UPDATE motive.idempotency_records
       SET response = $4::jsonb, resource_type = $5, resource_id = $6
       WHERE actor_id = $1 AND action = $2 AND idempotency_key = $3`,
      [actorId, action, key, JSON.stringify(result.response), result.resourceType ?? null, result.resourceId ?? null],
    );
    return result.response;
  }

  private async lockController(client: PoolClient): Promise<QueryResultRow> {
    const result = await client.query('SELECT * FROM motive.controller_state WHERE singleton = TRUE FOR UPDATE');
    if (result.rowCount !== 1) throw new Error('Controller state singleton is missing.');
    return result.rows[0];
  }

  private async lockSource(client: PoolClient, sourceId: string): Promise<QueryResultRow> {
    const result = await client.query('SELECT * FROM motive.funding_sources WHERE id = $1 FOR UPDATE', [requireUuid(sourceId, 'sourceId')]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Funding source was not found.');
    return result.rows[0];
  }

  private async lockGrant(client: PoolClient, grantId: string): Promise<QueryResultRow> {
    const result = await client.query('SELECT * FROM motive.grants WHERE id = $1 FOR UPDATE', [requireUuid(grantId, 'grantId')]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Grant was not found.');
    return result.rows[0];
  }

  private async lockAttempt(client: PoolClient, attemptId: string): Promise<QueryResultRow> {
    const result = await client.query('SELECT * FROM motive.attempts WHERE id = $1 FOR UPDATE', [requireUuid(attemptId, 'attemptId')]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Attempt was not found.');
    return result.rows[0];
  }

  /** Locks the funding chain in the single global order: controller, source, grant. */
  private async lockGrantChain(client: PoolClient, grantId: string): Promise<{ controller: QueryResultRow; source: QueryResultRow; grant: QueryResultRow }> {
    const controller = await this.lockController(client);
    const reference = await client.query<{ source_id: string }>('SELECT source_id FROM motive.grants WHERE id = $1', [requireUuid(grantId, 'grantId')]);
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Grant was not found.');
    const source = await this.lockSource(client, reference.rows[0].source_id);
    const grant = await this.lockGrant(client, grantId);
    return { controller, source, grant };
  }

  /** Locks the funding chain in the single global order: controller, source, grant, attempt. */
  private async lockAttemptChain(client: PoolClient, attemptId: string): Promise<{ controller: QueryResultRow; source: QueryResultRow; grant: QueryResultRow; attempt: QueryResultRow }> {
    const controller = await this.lockController(client);
    const reference = await client.query<{ source_id: string; grant_id: string }>('SELECT source_id, grant_id FROM motive.attempts WHERE id = $1', [requireUuid(attemptId, 'attemptId')]);
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Attempt was not found.');
    const source = await this.lockSource(client, reference.rows[0].source_id);
    const grant = await this.lockGrant(client, reference.rows[0].grant_id);
    const attempt = await this.lockAttempt(client, attemptId);
    return { controller, source, grant, attempt };
  }

  private ensureSpendingOpen(controller: QueryResultRow): void {
    if (!asBoolean(controller, 'spending_enabled')) fail('CONTROLLER_FROZEN', 'Spending is disabled pending explicit controller authorization.');
  }

  private ensureSourceOpen(source: QueryResultRow, nowMilliseconds = Date.now()): void {
    if (asString(source, 'status') !== 'ACTIVE') fail('SOURCE_UNAVAILABLE', 'Funding source is not available for new authorization.');
    const expiresAt = dateOrNull(source.expires_at);
    if (expiresAt !== null && Date.parse(expiresAt) <= nowMilliseconds) fail('SOURCE_UNAVAILABLE', 'Funding source has expired.');
  }

  private ensureGrantOpen(grant: QueryResultRow, nowMilliseconds = Date.now()): void {
    if (asString(grant, 'status') !== 'ACTIVE') fail('GRANT_UNAVAILABLE', 'Grant is not available for new authorization.');
    if (grant.admission_closed_at !== null) fail('ADMISSION_CLOSED', 'Grant has a durable admission boundary.');
    const expiresAt = dateOrNull(grant.expires_at);
    if (expiresAt !== null && Date.parse(expiresAt) <= nowMilliseconds) fail('GRANT_UNAVAILABLE', 'Grant has expired.');
  }

  private ensureAttemptOpen(
    controller: QueryResultRow,
    grant: QueryResultRow,
    attempt: QueryResultRow,
    leaseEpoch: number,
    profileDigest: Digest,
    nowMilliseconds = Date.now(),
  ): void {
    this.ensureSpendingOpen(controller);
    this.ensureGrantOpen(grant, nowMilliseconds);
    if (attempt.admission_closed_at !== null) fail('ADMISSION_CLOSED', 'Attempt has a durable admission boundary.');
    if (!ACTIVE_ATTEMPT_STATES.has(asString(attempt, 'execution_status'))) fail('ATTEMPT_UNAVAILABLE', 'Attempt is not in a state that may admit a request.');
    if (asNumber(attempt, 'lease_epoch') !== requirePositiveInteger(leaseEpoch, 'leaseEpoch')) fail('LEASE_FENCED', 'The supplied lease epoch is stale.');
    if (asString(attempt, 'controller_generation') !== asString(controller, 'generation')) fail('LEASE_FENCED', 'The supplied attempt belongs to an older controller generation.');
    if (asString(attempt, 'profile_digest') !== assertDigest(profileDigest, 'profileDigest')) fail('VALIDATION', 'Request profile does not match the frozen attempt profile.');
  }

  private async databaseNowMilliseconds(client: PoolClient): Promise<number> {
    const result = await client.query('SELECT clock_timestamp() AS database_now');
    if (result.rowCount !== 1) throw new Error('Database clock query did not return exactly one row.');
    const value = dateOrNull(result.rows[0].database_now);
    if (value === null) throw new Error('Database clock query returned no timestamp.');
    return Date.parse(value);
  }

  private async lockWorkOrderStateForAttempt(client: PoolClient, attempt: QueryResultRow): Promise<QueryResultRow> {
    const result = await client.query(
      `SELECT wo.id, wo.project_id, wo.terms, ws.state, ws.admission_closed_at
       FROM motive.work_orders wo
       JOIN motive.work_order_states ws ON ws.work_order_id = wo.id
       WHERE wo.id = $1 AND wo.project_id = $2
       FOR UPDATE OF ws`,
      [asString(attempt, 'work_order_id'), asString(attempt, 'project_id')],
    );
    if (result.rowCount !== 1) fail('WORK_ORDER_UNAVAILABLE', 'Attempt no longer has an active work-order state.');
    return result.rows[0];
  }

  private ensureWorkOrderOpen(workOrder: QueryResultRow): void {
    if (asString(workOrder, 'state') !== 'READY' || workOrder.admission_closed_at !== null) {
      fail('WORK_ORDER_UNAVAILABLE', 'Work order is not open for hosted inference admission.');
    }
  }

  private async lockRunCapability(client: PoolClient, capabilityId: string): Promise<QueryResultRow> {
    const result = await client.query(
      'SELECT * FROM motive.run_capabilities WHERE id = $1 FOR UPDATE',
      [requireUuid(capabilityId, 'capabilityId')],
    );
    if (result.rowCount !== 1) fail('CAPABILITY_UNAVAILABLE', 'Run capability was not found.');
    return result.rows[0];
  }

  private async ensureCapabilityOperator(
    client: PoolClient,
    chain: { source: QueryResultRow; grant: QueryResultRow; attempt: QueryResultRow },
    actorId: string,
    capability?: QueryResultRow,
  ): Promise<void> {
    const actor = requireText(actorId, 'actorId', 512);
    if (capability !== undefined && asString(capability, 'issued_by_actor_id') === actor) return;
    if (asString(chain.source, 'controller_actor_id') === actor) return;
    const membership = await client.query(
      `SELECT role FROM motive.memberships
       WHERE project_id = $1 AND actor_id = $2 AND revoked_at IS NULL
       FOR KEY SHARE`,
      [asString(chain.attempt, 'project_id'), actor],
    );
    if (membership.rowCount === 1 && ['OWNER', 'STEWARD'].includes(asString(membership.rows[0], 'role'))) return;
    fail('CAPABILITY_FORBIDDEN', 'Only the active project operator or funding controller may manage this run capability.');
  }

  /**
   * A capability token must never be recoverable from an idempotency response.
   * Serialize the key before generating a token; completed replays fail closed
   * instead of returning a newly generated or stored bearer value.
   */
  private async rejectCompletedCapabilityIssuanceReplay(
    client: PoolClient,
    identity: MutationIdentity,
    body: unknown,
  ): Promise<void> {
    const actorId = requireText(identity.actorId, 'actorId', 512);
    const key = requireText(identity.idempotencyKey, 'idempotencyKey', 512);
    const action = 'run-capability.issue';
    const bodyDigest = digestCanonicalJson(body);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${actorId}\u001f${action}\u001f${key}`]);
    const existing = await client.query<{ body_digest: string }>(
      `SELECT body_digest FROM motive.idempotency_records
       WHERE actor_id = $1 AND action = $2 AND idempotency_key = $3 FOR UPDATE`,
      [actorId, action, key],
    );
    if (existing.rowCount === 0) return;
    if (existing.rows[0].body_digest !== bodyDigest) {
      fail('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request body.');
    }
    fail('CAPABILITY_ISSUANCE_REPLAY', 'The capability was already issued. Retain the original bearer value; it is never stored for replay.');
  }

  private ensureRunCapabilityAdmission(
    capability: QueryResultRow,
    chain: { controller: QueryResultRow; source: QueryResultRow; grant: QueryResultRow; attempt: QueryResultRow },
    workOrder: QueryResultRow,
    profileDigest: Digest,
    nowMilliseconds: number,
  ): void {
    if (capability.revoked_at !== null) fail('CAPABILITY_UNAVAILABLE', 'Run capability has been revoked.');
    const expiresAt = dateOrNull(capability.expires_at);
    if (expiresAt === null || Date.parse(expiresAt) <= nowMilliseconds) {
      fail('CAPABILITY_UNAVAILABLE', 'Run capability has expired.');
    }
    if (asString(capability, 'attempt_id') !== asString(chain.attempt, 'id')
      || asString(capability, 'project_id') !== asString(chain.attempt, 'project_id')
      || asString(capability, 'grant_id') !== asString(chain.grant, 'id')
      || asString(capability, 'source_id') !== asString(chain.source, 'id')) {
      fail('CAPABILITY_UNAVAILABLE', 'Run capability scope does not match the current attempt funding chain.');
    }
    const capabilityProfile = assertDigest(asString(capability, 'profile_digest'), 'capability profile_digest');
    if (capabilityProfile !== profileDigest || capabilityProfile !== assertDigest(asString(chain.attempt, 'profile_digest'), 'attempt profile_digest')) {
      fail('VALIDATION', 'Request profile does not match the run capability scope.');
    }
    if (asNumber(capability, 'lease_epoch') !== asNumber(chain.attempt, 'lease_epoch')) {
      fail('LEASE_FENCED', 'Run capability belongs to an older lease epoch.');
    }
    if (asString(capability, 'controller_generation') !== asString(chain.attempt, 'controller_generation')
      || asString(capability, 'controller_generation') !== asString(chain.controller, 'generation')) {
      fail('LEASE_FENCED', 'Run capability belongs to an older controller generation.');
    }
    this.ensureWorkOrderOpen(workOrder);
    this.ensureSourceOpen(chain.source, nowMilliseconds);
    this.ensureAttemptOpen(
      chain.controller,
      chain.grant,
      chain.attempt,
      asNumber(capability, 'lease_epoch'),
      capabilityProfile,
      nowMilliseconds,
    );
  }

  private async appendEventAndOutbox(
    client: PoolClient,
    event: {
      projectId?: string;
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      actorId?: string;
      payload: JsonObject;
      topic: string;
      dedupeKey: string;
    },
  ): Promise<void> {
    canonicalJson(event.payload);
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO motive.events (id, project_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [eventId, event.projectId ?? null, event.aggregateType, requireUuid(event.aggregateId, 'aggregateId'), event.eventType, JSON.stringify(event.payload), event.actorId ?? null],
    );
    await client.query(
      `INSERT INTO motive.outbox (id, event_id, aggregate_type, aggregate_id, topic, dedupe_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), eventId, event.aggregateType, event.aggregateId, event.topic, event.dedupeKey, JSON.stringify(event.payload)],
    );
  }

  private async appendJournal(
    client: PoolClient,
    journal: {
      kind: string;
      referenceType: string;
      referenceId: string;
      sourceId?: string;
      grantId?: string;
      attemptId?: string;
      operationId?: string;
      transfers: readonly { debit: string; credit: string; amount: DecimalAmount }[];
    },
  ): Promise<void> {
    const transfers = journal.transfers.filter(transfer => compareAmounts(transfer.amount, ZERO_AMOUNT) > 0);
    if (transfers.length === 0) return;
    const journalId = randomUUID();
    await client.query(
      `INSERT INTO motive.ledger_transactions (id, kind, source_id, grant_id, attempt_id, operation_id, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        journalId,
        journal.kind,
        journal.sourceId ?? null,
        journal.grantId ?? null,
        journal.attemptId ?? null,
        journal.operationId ?? null,
        journal.referenceType,
        requireUuid(journal.referenceId, 'referenceId'),
      ],
    );
    for (const transfer of transfers) {
      const amount = positiveAmount(transfer.amount, 'journal transfer amount');
      await client.query(
        `INSERT INTO motive.ledger_entries (id, journal_id, account, direction, amount)
         VALUES ($1, $2, $3, 'DEBIT', $4), ($5, $2, $6, 'CREDIT', $4)`,
        [randomUUID(), journalId, transfer.debit, amount, randomUUID(), transfer.credit],
      );
    }
  }

  private async insertIncident(
    client: PoolClient,
    incident: {
      kind: 'UNKNOWN_ISSUANCE' | 'RESERVATION_OVERRUN' | 'LATE_USAGE';
      sourceId: string;
      grantId?: string;
      attemptId?: string;
      operationId?: string;
      amount?: DecimalAmount;
      details: JsonObject;
    },
  ): Promise<string> {
    canonicalJson(incident.details);
    const id = randomUUID();
    await client.query(
      `INSERT INTO motive.accounting_incidents (id, kind, source_id, grant_id, attempt_id, operation_id, amount, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [id, incident.kind, incident.sourceId, incident.grantId ?? null, incident.attemptId ?? null, incident.operationId ?? null, incident.amount ?? null, JSON.stringify(incident.details)],
    );
    return id;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectProjection> {
    const slug = requireText(input.slug, 'slug', 128);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) fail('VALIDATION', 'slug must be lowercase URL-safe text.');
    if (input.visibility !== 'PUBLIC' && input.visibility !== 'PRIVATE') fail('VALIDATION', 'visibility must be PUBLIC or PRIVATE.');
    const format = input.revisionFormat === undefined ? 'motive.project-revision/0.1' : requireText(input.revisionFormat, 'revisionFormat', 128);
    const revisionDigest = digestCanonicalJson(input.revisionContent);
    return this.transaction(client => this.idempotent(
      client,
      input,
      'project.create',
      { slug, visibility: input.visibility, revision_format: format, revision_digest: revisionDigest },
      async () => {
        const projectId = randomUUID();
        const revisionId = randomUUID();
        await client.query(
          `INSERT INTO motive.projects (id, slug, visibility, current_revision, created_by)
           VALUES ($1, $2, $3, 1, $4)`,
          [projectId, slug, input.visibility, input.actorId],
        );
        await client.query(
          `INSERT INTO motive.project_revisions (id, project_id, revision, format, content, content_digest, created_by)
           VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6)`,
          [revisionId, projectId, format, JSON.stringify(input.revisionContent), revisionDigest, input.actorId],
        );
        await client.query(
          `INSERT INTO motive.memberships (id, project_id, actor_id, role, scopes, granted_by)
           VALUES ($1, $2, $3, 'OWNER', ARRAY['*'], $3)`,
          [randomUUID(), projectId, input.actorId],
        );
        await this.appendEventAndOutbox(client, {
          projectId,
          aggregateType: 'project',
          aggregateId: projectId,
          eventType: 'project.created',
          actorId: input.actorId,
          payload: { project_id: projectId, revision: 1, visibility: input.visibility },
          topic: 'project.created',
          dedupeKey: `project.created:${projectId}`,
        });
        const result = await client.query('SELECT * FROM motive.projects WHERE id = $1', [projectId]);
        const row = result.rows[0];
        const response: ProjectProjection = {
          id: asString(row, 'id'), slug: asString(row, 'slug'), visibility: asString(row, 'visibility') as ProjectProjection['visibility'],
          currentRevision: asNumber(row, 'current_revision'), createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Project created_at is missing.'); })(),
        };
        return { response, resourceType: 'project', resourceId: projectId };
      },
    ));
  }

  async createFundingSource(input: CreateFundingSourceInput): Promise<{ id: string; authorizedAmount: DecimalAmount; status: string }> {
    const authorizedAmount = positiveAmount(input.authorizedAmount, 'authorizedAmount');
    const expiresAt = optionalDate(input.expiresAt, 'expiresAt');
    const metadata = input.metadata ?? {};
    canonicalJson(metadata);
    return this.transaction(client => this.idempotent(
      client,
      input,
      'funding-source.create',
      { authorized_amount: authorizedAmount, expires_at: expiresAt, metadata },
      async () => {
        const sourceId = randomUUID();
        await client.query(
          `INSERT INTO motive.funding_sources (id, owner_actor_id, controller_actor_id, authorized_amount, expires_at, metadata)
           VALUES ($1, $2, $2, $3, $4, $5::jsonb)`,
          [sourceId, input.actorId, authorizedAmount, expiresAt, JSON.stringify(metadata)],
        );
        await this.appendJournal(client, {
          kind: 'SOURCE_AUTHORIZED', referenceType: 'funding_source', referenceId: sourceId, sourceId,
          transfers: [{ debit: `source:${sourceId}:available`, credit: `source:${sourceId}:authorization`, amount: authorizedAmount }],
        });
        await this.appendEventAndOutbox(client, {
          aggregateType: 'funding_source', aggregateId: sourceId, eventType: 'funding-source.created', actorId: input.actorId,
          payload: { funding_source_id: sourceId, authorized_amount: authorizedAmount },
          topic: 'funding-source.created', dedupeKey: `funding-source.created:${sourceId}`,
        });
        return { response: { id: sourceId, authorizedAmount, status: 'ACTIVE' }, resourceType: 'funding_source', resourceId: sourceId };
      },
    ));
  }

  async createGrant(input: CreateGrantInput): Promise<GrantProjection> {
    const sourceId = requireUuid(input.sourceId, 'sourceId');
    const projectId = requireUuid(input.projectId, 'projectId');
    const limitAmount = positiveAmount(input.limitAmount, 'limitAmount');
    const beneficiaryActorId = input.beneficiaryActorId === undefined ? null : requireText(input.beneficiaryActorId, 'beneficiaryActorId', 512);
    const expiresAt = optionalDate(input.expiresAt, 'expiresAt');
    return this.transaction(async client => {
      const controller = await this.lockController(client);
      return this.idempotent(
        client,
        input,
        'grant.create',
        { source_id: sourceId, project_id: projectId, limit_amount: limitAmount, beneficiary_actor_id: beneficiaryActorId, expires_at: expiresAt },
        async () => {
          this.ensureSpendingOpen(controller);
          const source = await this.lockSource(client, sourceId);
          this.ensureSourceOpen(source);
          if (asString(source, 'owner_actor_id') !== input.actorId) fail('SOURCE_UNAVAILABLE', 'Only the funding source owner may issue a grant.');
          const project = await client.query('SELECT id FROM motive.projects WHERE id = $1', [projectId]);
          if (project.rowCount !== 1) fail('NOT_FOUND', 'Project was not found.');
          const sourceAvailable = subtractAmounts(
            subtractAmounts(asAmount(source, 'authorized_amount'), asAmount(source, 'allocated_amount'), 'source available amount'),
            asAmount(source, 'consumed_amount'),
            'source available amount',
          );
          if (compareAmounts(sourceAvailable, limitAmount) < 0) fail('INSUFFICIENT_SOURCE_CAPACITY', 'Funding source does not have enough unallocated capacity.');
          const grantId = randomUUID();
          const reservationId = randomUUID();
          await client.query(
            `UPDATE motive.funding_sources SET allocated_amount = allocated_amount + $2, updated_at = clock_timestamp() WHERE id = $1`,
            [sourceId, limitAmount],
          );
          await client.query(
            `INSERT INTO motive.grants (id, source_id, project_id, issuer_actor_id, beneficiary_actor_id, limit_amount, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [grantId, sourceId, projectId, input.actorId, beneficiaryActorId, limitAmount, expiresAt],
          );
          await client.query(
            `INSERT INTO motive.reservations (id, kind, source_id, grant_id, original_amount, held_amount)
             VALUES ($1, 'SOURCE_GRANT', $2, $3, $4, $4)`,
            [reservationId, sourceId, grantId, limitAmount],
          );
          await this.appendJournal(client, {
            kind: 'GRANT_ALLOCATED', referenceType: 'grant', referenceId: grantId, sourceId, grantId,
            transfers: [{ debit: `source:${sourceId}:grant-held`, credit: `source:${sourceId}:available`, amount: limitAmount }],
          });
          await this.appendEventAndOutbox(client, {
            projectId, aggregateType: 'grant', aggregateId: grantId, eventType: 'grant.created', actorId: input.actorId,
            payload: { grant_id: grantId, source_id: sourceId, limit_amount: limitAmount },
            topic: 'grant.created', dedupeKey: `grant.created:${grantId}`,
          });
          const row = await client.query('SELECT * FROM motive.grants WHERE id = $1', [grantId]);
          return { response: grantProjection(row.rows[0]), resourceType: 'grant', resourceId: grantId };
        },
      );
    });
  }

  async createWorkOrder(input: CreateWorkOrderInput): Promise<{ id: string; termsDigest: Digest; state: string }> {
    const projectId = requireUuid(input.projectId, 'projectId');
    const key = requireText(input.workOrderKey, 'workOrderKey', 128);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(key)) fail('VALIDATION', 'workOrderKey must be lowercase URL-safe text.');
    const revision = requirePositiveInteger(input.revision, 'revision');
    const state = input.state ?? 'DRAFT';
    if (state !== 'DRAFT' && state !== 'READY') fail('VALIDATION', 'Only DRAFT or READY is valid for a newly created work order.');
    const terms = validateWorkOrderTerms(input.terms);
    if (terms.project_id !== projectId) fail('VALIDATION', 'Work order terms.project_id must equal projectId.');
    const termsDigest = digestCanonicalJson(terms);
    // Financial terms must fit NUMERIC exactly before they can be frozen.
    exactAmount(terms.hosted.inference.ceiling, 'terms.hosted.inference.ceiling');
    return this.transaction(client => this.idempotent(
      client,
      input,
      'work-order.create',
      { project_id: projectId, work_order_key: key, revision, terms_digest: termsDigest, state },
      async () => {
        const projectRevision = await client.query(
          'SELECT id FROM motive.project_revisions WHERE project_id = $1 AND revision = $2',
          [projectId, terms.project_revision],
        );
        if (projectRevision.rowCount !== 1) fail('NOT_FOUND', 'The frozen project revision was not found.');
        const membership = await client.query(
          `SELECT role FROM motive.memberships WHERE project_id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
          [projectId, input.actorId],
        );
        if (membership.rowCount !== 1 || !['OWNER', 'STEWARD'].includes(asString(membership.rows[0], 'role'))) {
          fail('WORK_ORDER_UNAVAILABLE', 'Only an active project owner or steward may create a work order.');
        }
        const workOrderId = randomUUID();
        await client.query(
          `INSERT INTO motive.work_orders (id, project_id, work_order_key, revision, project_revision, terms_format, terms, terms_digest, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [workOrderId, projectId, key, revision, terms.project_revision, terms.format, JSON.stringify(terms), termsDigest, input.actorId],
        );
        await client.query(
          `INSERT INTO motive.work_order_states (work_order_id, state, updated_by) VALUES ($1, $2, $3)`,
          [workOrderId, state, input.actorId],
        );
        await this.appendEventAndOutbox(client, {
          projectId, aggregateType: 'work_order', aggregateId: workOrderId, eventType: 'work-order.created', actorId: input.actorId,
          payload: { work_order_id: workOrderId, work_order_key: key, revision, terms_digest: termsDigest, state },
          topic: 'work-order.created', dedupeKey: `work-order.created:${workOrderId}`,
        });
        return { response: { id: workOrderId, termsDigest, state }, resourceType: 'work_order', resourceId: workOrderId };
      },
    ));
  }

  async reserveAttempt(input: ReserveAttemptInput): Promise<AttemptProjection> {
    const grantId = requireUuid(input.grantId, 'grantId');
    const workOrderId = requireUuid(input.workOrderId, 'workOrderId');
    const ceilingAmount = reservationAmount(input.ceilingAmount, 'ceilingAmount');
    const profileDigest = assertDigest(input.profileDigest, 'profileDigest');
    const inputDigest = assertDigest(input.inputDigest, 'inputDigest');
    return this.transaction(async client => {
      const chain = await this.lockGrantChain(client, grantId);
      return this.idempotent(
        client,
        input,
        'attempt.reserve',
        { grant_id: grantId, work_order_id: workOrderId, ceiling_amount: ceilingAmount, profile_digest: profileDigest, input_digest: inputDigest },
        async () => {
          this.ensureSpendingOpen(chain.controller);
          this.ensureSourceOpen(chain.source);
          this.ensureGrantOpen(chain.grant);
          const workOrder = await client.query(
            `SELECT wo.*, ws.state, ws.admission_closed_at AS state_admission_closed_at
             FROM motive.work_orders wo JOIN motive.work_order_states ws ON ws.work_order_id = wo.id
             WHERE wo.id = $1 FOR KEY SHARE`,
            [workOrderId],
          );
          if (workOrder.rowCount !== 1) fail('NOT_FOUND', 'Work order was not found.');
          const workOrderRow = workOrder.rows[0];
          if (asString(workOrderRow, 'state') !== 'READY' || workOrderRow.state_admission_closed_at !== null) {
            fail('WORK_ORDER_UNAVAILABLE', 'Work order is not open for hosted reservation.');
          }
          if (asString(chain.grant, 'project_id') !== asString(workOrderRow, 'project_id')) {
            fail('VALIDATION', 'Grant and work order belong to different projects.');
          }
          const terms = validateWorkOrderTerms(asJsonObject(workOrderRow.terms, 'work order terms'));
          if (!terms.hosted.enabled) fail('WORK_ORDER_UNAVAILABLE', 'This immutable work order does not permit hosted work.');
          if (terms.hosted.inference.profile_digest !== profileDigest) fail('VALIDATION', 'Attempt profile must match the immutable work order profile.');
          const frozenCeiling = exactAmount(terms.hosted.inference.ceiling, 'terms.hosted.inference.ceiling');
          if (compareAmounts(ceilingAmount, frozenCeiling) > 0) fail('INSUFFICIENT_ATTEMPT_CAPACITY', 'Attempt ceiling exceeds the immutable work-order ceiling.');
          const grantAvailable = subtractAmounts(
            subtractAmounts(asAmount(chain.grant, 'limit_amount'), asAmount(chain.grant, 'consumed_amount'), 'grant available amount'),
            asAmount(chain.grant, 'attempt_held_amount'),
            'grant available amount',
          );
          if (compareAmounts(grantAvailable, ceilingAmount) < 0) fail('INSUFFICIENT_GRANT_CAPACITY', 'Grant has insufficient unreserved capacity for this attempt.');
          const attemptId = randomUUID();
          const reservationId = randomUUID();
          await client.query(
            `INSERT INTO motive.attempts (
              id, project_id, work_order_id, grant_id, source_id, terms_digest, profile_digest, input_digest, ceiling_amount, controller_generation
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              attemptId, asString(workOrderRow, 'project_id'), workOrderId, grantId, asString(chain.source, 'id'),
              asString(workOrderRow, 'terms_digest'), profileDigest, inputDigest, ceilingAmount, asString(chain.controller, 'generation'),
            ],
          );
          await client.query(
            `INSERT INTO motive.reservations (id, kind, source_id, grant_id, attempt_id, original_amount, held_amount)
             VALUES ($1, 'GRANT_ATTEMPT', $2, $3, $4, $5, $5)`,
            [reservationId, asString(chain.source, 'id'), grantId, attemptId, ceilingAmount],
          );
          await client.query(
            `UPDATE motive.grants SET attempt_held_amount = attempt_held_amount + $2, updated_at = clock_timestamp() WHERE id = $1`,
            [grantId, ceilingAmount],
          );
          await this.appendJournal(client, {
            kind: 'ATTEMPT_ENVELOPE_RESERVED', referenceType: 'attempt', referenceId: attemptId,
            sourceId: asString(chain.source, 'id'), grantId, attemptId,
            transfers: [{ debit: `grant:${grantId}:attempt-held`, credit: `grant:${grantId}:available`, amount: ceilingAmount }],
          });
          await this.appendEventAndOutbox(client, {
            projectId: asString(workOrderRow, 'project_id'), aggregateType: 'attempt', aggregateId: attemptId, eventType: 'attempt.reserved', actorId: input.actorId,
            payload: { attempt_id: attemptId, grant_id: grantId, work_order_id: workOrderId, ceiling_amount: ceilingAmount, lease_epoch: 1 },
            topic: 'attempt.reserved', dedupeKey: `attempt.reserved:${attemptId}`,
          });
          const created = await client.query('SELECT * FROM motive.attempts WHERE id = $1', [attemptId]);
          return { response: attemptProjection(created.rows[0]), resourceType: 'attempt', resourceId: attemptId };
        },
      );
    });
  }

  private async lockOperationChain(client: PoolClient, providerOperationId: string): Promise<{
    controller: QueryResultRow;
    source: QueryResultRow;
    grant: QueryResultRow;
    attempt: QueryResultRow;
    operation: QueryResultRow;
  }> {
    const controller = await this.lockController(client);
    const reference = await client.query<{ source_id: string; grant_id: string; attempt_id: string }>(
      'SELECT source_id, grant_id, attempt_id FROM motive.request_operations WHERE provider_operation_id = $1',
      [requireUuid(providerOperationId, 'providerOperationId')],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Provider operation was not found.');
    const source = await this.lockSource(client, reference.rows[0].source_id);
    const grant = await this.lockGrant(client, reference.rows[0].grant_id);
    const attempt = await this.lockAttempt(client, reference.rows[0].attempt_id);
    const operation = await client.query(
      'SELECT * FROM motive.request_operations WHERE provider_operation_id = $1 FOR UPDATE',
      [providerOperationId],
    );
    if (operation.rowCount !== 1) fail('NOT_FOUND', 'Provider operation was not found.');
    return { controller, source, grant, attempt, operation: operation.rows[0] };
  }

  private async lockReservation(client: PoolClient, sql: string, values: unknown[], description: string): Promise<QueryResultRow> {
    const result = await client.query(sql, values);
    if (result.rowCount !== 1) throw new Error(`Missing ${description} reservation.`);
    return result.rows[0];
  }

  private async freezeAffectedContext(
    client: PoolClient,
    chain: { source: QueryResultRow; grant: QueryResultRow; attempt: QueryResultRow },
    reason: string,
  ): Promise<void> {
    const sourceId = asString(chain.source, 'id');
    const grantId = asString(chain.grant, 'id');
    const attemptId = asString(chain.attempt, 'id');
    await client.query(
      `UPDATE motive.funding_sources
       SET status = CASE WHEN status = 'ACTIVE' THEN 'FROZEN'::motive.funding_source_status ELSE status END,
           frozen_at = COALESCE(frozen_at, clock_timestamp()),
           freeze_reason = COALESCE(freeze_reason, $2), updated_at = clock_timestamp()
       WHERE id = $1`,
      [sourceId, reason],
    );
    await client.query(
      `UPDATE motive.grants
       SET status = CASE WHEN status = 'ACTIVE' THEN 'FROZEN'::motive.grant_status ELSE status END,
           admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()), updated_at = clock_timestamp()
       WHERE id = $1`,
      [grantId],
    );
    await client.query(
      `UPDATE motive.attempts
       SET admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
           execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING') THEN 'QUARANTINED'::motive.attempt_execution_status ELSE execution_status END,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [attemptId],
    );
  }

  private async admitLockedRequest(
    client: PoolClient,
    chain: { controller: QueryResultRow; source: QueryResultRow; grant: QueryResultRow; attempt: QueryResultRow },
    input: {
      attemptId: string;
      leaseEpoch: number;
      profileDigest: Digest;
      requestBodyDigest: Digest;
      maximumExposure: DecimalAmount;
      actorId: string;
      admissionMetadata: JsonObject;
      nowMilliseconds?: number;
    },
  ): Promise<OperationProjection> {
    this.ensureSourceOpen(chain.source, input.nowMilliseconds);
    this.ensureAttemptOpen(chain.controller, chain.grant, chain.attempt, input.leaseEpoch, input.profileDigest, input.nowMilliseconds);
    const unresolved = await client.query(
      `SELECT provider_operation_id FROM motive.request_operations
       WHERE attempt_id = $1 AND status IN ('ISSUING', 'IN_FLIGHT', 'UNKNOWN') FOR UPDATE`,
      [input.attemptId],
    );
    if (unresolved.rows.length > 0) fail('OPERATION_IN_FLIGHT', 'This attempt already has a potentially billable operation.');
    const matchingBody = await client.query(
      `SELECT provider_operation_id FROM motive.request_operations
       WHERE attempt_id = $1 AND request_body_digest = $2 LIMIT 1`,
      [input.attemptId, input.requestBodyDigest],
    );
    if (matchingBody.rows.length > 0) {
      fail('SUSPECTED_RETRANSMISSION', 'An identical request body was already admitted for this attempt and is held for reconciliation.');
    }
    const attemptAvailable = subtractAmounts(
      subtractAmounts(asAmount(chain.attempt, 'ceiling_amount'), asAmount(chain.attempt, 'consumed_amount'), 'attempt available amount'),
      asAmount(chain.attempt, 'request_held_amount'),
      'attempt available amount',
    );
    if (compareAmounts(attemptAvailable, input.maximumExposure) < 0) {
      fail('INSUFFICIENT_ATTEMPT_CAPACITY', 'Attempt envelope has insufficient capacity for this request reservation.');
    }
    const operationId = randomUUID();
    const reservationId = randomUUID();
    const sequence = asNumber(chain.attempt, 'next_request_sequence');
    await client.query(
      `INSERT INTO motive.request_operations (
        provider_operation_id, attempt_id, grant_id, source_id, request_sequence, request_body_digest, profile_digest, reserved_amount,
        admission_metadata, admission_lease_epoch, admission_controller_generation
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        operationId, input.attemptId, asString(chain.grant, 'id'), asString(chain.source, 'id'), sequence,
        input.requestBodyDigest, input.profileDigest, input.maximumExposure, JSON.stringify(input.admissionMetadata),
        asNumber(chain.attempt, 'lease_epoch'), asString(chain.controller, 'generation'),
      ],
    );
    await client.query(
      `INSERT INTO motive.reservations (id, kind, source_id, grant_id, attempt_id, operation_id, original_amount, held_amount)
       VALUES ($1, 'ATTEMPT_REQUEST', $2, $3, $4, $5, $6, $6)`,
      [reservationId, asString(chain.source, 'id'), asString(chain.grant, 'id'), input.attemptId, operationId, input.maximumExposure],
    );
    await client.query(
      `UPDATE motive.attempts
       SET request_held_amount = request_held_amount + $2, next_request_sequence = next_request_sequence + 1, updated_at = clock_timestamp()
       WHERE id = $1`,
      [input.attemptId, input.maximumExposure],
    );
    await this.appendJournal(client, {
      kind: 'REQUEST_RESERVED', referenceType: 'provider_operation', referenceId: operationId,
      sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'), attemptId: input.attemptId, operationId,
      transfers: [{ debit: `attempt:${input.attemptId}:request-held`, credit: `attempt:${input.attemptId}:available`, amount: input.maximumExposure }],
    });
    await this.appendEventAndOutbox(client, {
      projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: operationId,
      eventType: 'provider-operation.issuing', actorId: input.actorId,
      payload: {
        provider_operation_id: operationId, attempt_id: input.attemptId, request_sequence: sequence,
        request_body_digest: input.requestBodyDigest, reserved_amount: input.maximumExposure,
        admission_metadata: input.admissionMetadata,
        admission_lease_epoch: asNumber(chain.attempt, 'lease_epoch'),
        admission_controller_generation: asString(chain.controller, 'generation'),
      },
      topic: 'provider-operation.issuing', dedupeKey: `provider-operation.issuing:${operationId}`,
    });
    const created = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [operationId]);
    if (created.rowCount !== 1) throw new Error('New provider operation was not readable.');
    return operationProjection(created.rows[0]);
  }

  async admitRequest(input: AdmitRequestInput): Promise<OperationProjection> {
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    const leaseEpoch = requirePositiveInteger(input.leaseEpoch, 'leaseEpoch');
    const profileDigest = assertDigest(input.profileDigest, 'profileDigest');
    const maximumExposure = reservationAmount(input.maximumExposure, 'maximumExposure');
    const requestBodyDigest = digestCanonicalJson(input.requestBody);
    if (input.repeatAuthorizationRef !== undefined) {
      fail('VALIDATION', 'repeatAuthorizationRef is not supported until a durable reauthorization protocol exists.');
    }
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, attemptId);
      return this.idempotent(
        client,
        input,
        'request.admit',
        {
          attempt_id: attemptId,
          lease_epoch: leaseEpoch,
          profile_digest: profileDigest,
          request_body_digest: requestBodyDigest,
          maximum_exposure: maximumExposure,
        },
        async () => {
          const operation = await this.admitLockedRequest(client, chain, {
            attemptId, leaseEpoch, profileDigest, requestBodyDigest, maximumExposure, actorId: input.actorId, admissionMetadata: {},
          });
          return { response: operation, resourceType: 'provider_operation', resourceId: operation.providerOperationId };
        },
      );
    });
  }

  /**
   * Mint one opaque bearer value for an exact, already-authorized attempt.
   * Only its SHA-256 digest enters PostgreSQL.  A completed idempotency replay
   * is intentionally rejected because returning a bearer again would make the
   * idempotency store a credential-recovery mechanism.
   */
  async issueRunCapability(input: IssueRunCapabilityInput): Promise<{ capability: string; context: RunCapabilityContext }> {
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    const requestedTtlSeconds = resolveCapabilityTtlSeconds(input);
    const hasExplicitTtl = input.ttl !== undefined || input.ttlSeconds !== undefined;
    const suppliedToken = input.token === undefined ? undefined : requireRunCapabilityToken(input.token, 'token');
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, attemptId);
      const workOrder = await this.lockWorkOrderStateForAttempt(client, chain.attempt);
      const workTerms = validateWorkOrderTerms(asJsonObject(workOrder.terms, 'work order terms'));
      const maximumRuntimeSeconds = workTerms.hosted.maximum_runtime_seconds;
      if (hasExplicitTtl && requestedTtlSeconds > maximumRuntimeSeconds) {
        fail('VALIDATION', 'Capability ttl cannot exceed the frozen hosted work-order runtime.');
      }
      const ttlSeconds = hasExplicitTtl ? requestedTtlSeconds : Math.min(requestedTtlSeconds, maximumRuntimeSeconds);
      const issuanceBody = { attempt_id: attemptId, ttl_seconds: ttlSeconds };
      const nowMilliseconds = await this.databaseNowMilliseconds(client);
      await this.ensureCapabilityOperator(client, chain, input.actorId);
      this.ensureWorkOrderOpen(workOrder);
      this.ensureSourceOpen(chain.source, nowMilliseconds);
      this.ensureAttemptOpen(
        chain.controller,
        chain.grant,
        chain.attempt,
        asNumber(chain.attempt, 'lease_epoch'),
        assertDigest(asString(chain.attempt, 'profile_digest'), 'attempt profile_digest'),
        nowMilliseconds,
      );
      await this.rejectCompletedCapabilityIssuanceReplay(client, input, issuanceBody);
      const token = suppliedToken ?? randomBytes(32).toString('base64url');
      const tokenHash = capabilityTokenHash(token);
      const capability = await this.idempotent(
        client,
        input,
        'run-capability.issue',
        issuanceBody,
        async () => {
          const existingToken = await client.query(
            'SELECT id FROM motive.run_capabilities WHERE token_hash = $1 FOR KEY SHARE',
            [tokenHash],
          );
          if ((existingToken.rowCount ?? 0) > 0) fail('CAPABILITY_UNAVAILABLE', 'A run capability with this bearer value already exists.');
          const capabilityId = randomUUID();
          const created = await client.query(
            `INSERT INTO motive.run_capabilities (
              id, token_hash, project_id, attempt_id, grant_id, source_id, profile_digest,
              lease_epoch, controller_generation, issued_by_actor_id, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + ($11::integer * INTERVAL '1 second'))
            RETURNING *`,
            [
              capabilityId, tokenHash, asString(chain.attempt, 'project_id'), attemptId,
              asString(chain.grant, 'id'), asString(chain.source, 'id'), asString(chain.attempt, 'profile_digest'),
              asNumber(chain.attempt, 'lease_epoch'), asString(chain.controller, 'generation'), input.actorId, ttlSeconds,
            ],
          );
          if (created.rowCount !== 1) throw new Error('Run capability was not created.');
          const context = runCapabilityContext(created.rows[0]);
          await this.appendEventAndOutbox(client, {
            projectId: context.projectId, aggregateType: 'run_capability', aggregateId: capabilityId,
            eventType: 'run-capability.issued', actorId: input.actorId,
            payload: {
              capability_id: capabilityId, attempt_id: context.attemptId, grant_id: context.grantId,
              lease_epoch: context.leaseEpoch, controller_generation: context.controllerGeneration,
              expires_at: context.expiresAt,
            },
            topic: 'run-capability.issued', dedupeKey: `run-capability.issued:${capabilityId}`,
          });
          return { response: context, resourceType: 'run_capability', resourceId: capabilityId };
        },
      );
      return { capability: token, context: capability };
    });
  }

  /** Advisory preflight only; paid admission re-locks and revalidates all state. */
  async getRunCapabilityContext(token: string): Promise<RunCapabilityContext | null> {
    // This is a bearer lookup.  Treat malformed and unknown values alike so a
    // worker cannot use the advisory path as a token-format oracle.
    if (!isRunCapabilityToken(token)) return null;
    const tokenHash = capabilityTokenHash(token);
    const result = await this.pool.query(
      `SELECT * FROM motive.run_capabilities
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [tokenHash],
    );
    return result.rowCount === 1 ? runCapabilityContext(result.rows[0]) : null;
  }

  async revokeRunCapability(input: RevokeRunCapabilityInput): Promise<RunCapabilityContext[]> {
    const hasCapabilityId = input.capabilityId !== undefined;
    const hasAttemptId = input.attemptId !== undefined;
    if (hasCapabilityId === hasAttemptId) {
      fail('VALIDATION', 'Provide exactly one of capabilityId or attemptId when revoking a run capability.');
    }
    const capabilityId = hasCapabilityId ? requireUuid(input.capabilityId!, 'capabilityId') : null;
    let attemptId = hasAttemptId ? requireUuid(input.attemptId!, 'attemptId') : null;
    const reason = input.reason === undefined ? null : requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      if (capabilityId !== null) {
        const reference = await client.query<{ attempt_id: string }>(
          'SELECT attempt_id FROM motive.run_capabilities WHERE id = $1',
          [capabilityId],
        );
        if (reference.rowCount !== 1) fail('CAPABILITY_UNAVAILABLE', 'Run capability was not found.');
        attemptId = reference.rows[0].attempt_id;
      }
      if (attemptId === null) throw new Error('Run capability revocation has no attempt scope.');
      const chain = await this.lockAttemptChain(client, attemptId);
      const capabilities = capabilityId === null
        ? await client.query('SELECT * FROM motive.run_capabilities WHERE attempt_id = $1 FOR UPDATE', [attemptId])
        : await client.query('SELECT * FROM motive.run_capabilities WHERE id = $1 FOR UPDATE', [capabilityId]);
      if (capabilities.rowCount === 0) {
        if (capabilityId !== null) fail('CAPABILITY_UNAVAILABLE', 'Run capability was not found.');
        return [];
      }
      for (const capability of capabilities.rows) {
        if (asString(capability, 'attempt_id') !== asString(chain.attempt, 'id')) {
          throw new Error('Run capability attempt chain changed unexpectedly.');
        }
      }
      // Revoking an entire attempt must be an active project/funding operator;
      // revoking one capability also permits its original issuer to stop it.
      await this.ensureCapabilityOperator(client, chain, input.actorId, capabilityId === null ? undefined : capabilities.rows[0]);
      return this.idempotent(
        client,
        input,
        'run-capability.revoke',
        capabilityId === null ? { attempt_id: attemptId, reason } : { capability_id: capabilityId, reason },
        async () => {
          const currentContexts: RunCapabilityContext[] = [];
          for (const capability of capabilities.rows) {
            const id = asString(capability, 'id');
            if (capability.revoked_at === null) {
              await client.query(
                `UPDATE motive.run_capabilities
                 SET revoked_at = clock_timestamp(), revoked_by_actor_id = $2, revocation_reason = $3
                 WHERE id = $1`,
                [id, input.actorId, reason],
              );
              await this.appendEventAndOutbox(client, {
                projectId: asString(chain.attempt, 'project_id'), aggregateType: 'run_capability', aggregateId: id,
                eventType: 'run-capability.revoked', actorId: input.actorId,
                payload: { capability_id: id, attempt_id: attemptId, reason },
                topic: 'run-capability.revoked', dedupeKey: `run-capability.revoked:${id}`,
              });
            }
            const current = await client.query('SELECT * FROM motive.run_capabilities WHERE id = $1', [id]);
            if (current.rowCount !== 1) throw new Error('Run capability was not readable after revocation.');
            currentContexts.push(runCapabilityContext(current.rows[0]));
          }
          return {
            response: currentContexts,
            resourceType: capabilityId === null ? 'attempt' : 'run_capability',
            resourceId: capabilityId ?? attemptId!,
          };
        },
      );
    });
  }

  /**
   * Capability-authenticated admission.  The caller never supplies an actor,
   * lease, project, grant, or source; all are derived from the locked record.
   */
  async admitCapabilityRequest(input: AdmitCapabilityRequestInput): Promise<OperationProjection> {
    if (!isRunCapabilityToken(input.token)) fail('CAPABILITY_UNAVAILABLE', 'Run capability is not recognized.');
    const token = input.token;
    const tokenHash = capabilityTokenHash(token);
    const profileDigest = assertDigest(input.profileDigest, 'profileDigest');
    const maximumExposure = reservationAmount(input.maximumExposure, 'maximumExposure');
    const requestBodyDigest = digestCanonicalJson(input.requestBody);
    const admissionMetadata = validateCapabilityAdmissionMetadata(input.admissionMetadata);
    if (admissionMetadata.normalizedBodyDigest !== undefined
        && admissionMetadata.normalizedBodyDigest !== requestBodyDigest) {
      fail('VALIDATION', 'admissionMetadata.normalizedBodyDigest does not match the admitted request body.');
    }
    const callerIdempotencyKey = input.idempotencyKey === undefined
      ? randomUUID()
      : requireText(input.idempotencyKey, 'idempotencyKey', 512);
    return this.transaction(async client => {
      const reference = await client.query<{ id: string; attempt_id: string }>(
        'SELECT id, attempt_id FROM motive.run_capabilities WHERE token_hash = $1',
        [tokenHash],
      );
      if (reference.rowCount !== 1) fail('CAPABILITY_UNAVAILABLE', 'Run capability is not recognized.');
      const chain = await this.lockAttemptChain(client, reference.rows[0].attempt_id);
      const capability = await this.lockRunCapability(client, reference.rows[0].id);
      if (asString(capability, 'token_hash') !== tokenHash || asString(capability, 'attempt_id') !== asString(chain.attempt, 'id')) {
        fail('CAPABILITY_UNAVAILABLE', 'Run capability is not valid for this attempt.');
      }
      const workOrder = await this.lockWorkOrderStateForAttempt(client, chain.attempt);
      const nowMilliseconds = await this.databaseNowMilliseconds(client);
      this.ensureRunCapabilityAdmission(capability, chain, workOrder, profileDigest, nowMilliseconds);
      const capabilityContext = runCapabilityContext(capability);
      const identity: MutationIdentity = {
        actorId: capabilityContext.issuedByActorId,
        idempotencyKey: callerIdempotencyKey,
      };
      return this.idempotent(
        client,
        identity,
        'run-capability.request-admit',
        {
          capability_id: capabilityContext.capabilityId,
          attempt_id: capabilityContext.attemptId,
          profile_digest: profileDigest,
          request_body_digest: requestBodyDigest,
          maximum_exposure: maximumExposure,
          admission_metadata: admissionMetadata,
        },
        async () => {
          const operation = await this.admitLockedRequest(client, chain, {
            attemptId: capabilityContext.attemptId,
            leaseEpoch: capabilityContext.leaseEpoch,
            profileDigest,
            requestBodyDigest,
            maximumExposure,
            actorId: capabilityContext.issuedByActorId,
            admissionMetadata,
            nowMilliseconds,
          });
          return { response: operation, resourceType: 'provider_operation', resourceId: operation.providerOperationId };
        },
      );
    });
  }

  /**
   * Atomically crosses the durable send-once boundary.  A false response is a
   * hard instruction not to contact the provider, including after a lost HTTP
   * acknowledgement from this method.
   */
  async claimOperationForDispatch(input: ClaimOperationForDispatchInput): Promise<DispatchClaim> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const dispatcherId = requireText(input.dispatcherId, 'dispatcherId', 512);
    const invocationToken = input.invocationToken === undefined
      ? randomBytes(32).toString('base64url')
      : requireRunCapabilityToken(input.invocationToken, 'invocationToken');
    const invocationHash = capabilityTokenHash(invocationToken);
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      const admittedLeaseEpoch = chain.operation.admission_lease_epoch === null || chain.operation.admission_lease_epoch === undefined
        ? null
        : asNumber(chain.operation, 'admission_lease_epoch');
      const admittedControllerGeneration = chain.operation.admission_controller_generation === null || chain.operation.admission_controller_generation === undefined
        ? null
        : asString(chain.operation, 'admission_controller_generation');
      if (admittedLeaseEpoch === null || admittedControllerGeneration === null) {
        fail('LEASE_FENCED', 'Operation lacks a durable admission fence and requires reconciliation before dispatch.');
      }
      if (admittedLeaseEpoch !== asNumber(chain.attempt, 'lease_epoch')
        || admittedControllerGeneration !== asString(chain.attempt, 'controller_generation')
        || admittedControllerGeneration !== asString(chain.controller, 'generation')) {
        fail('LEASE_FENCED', 'This operation belongs to an older lease or controller generation and cannot be dispatched.');
      }
      const status = asString(chain.operation, 'status');
      if (status !== 'ISSUING' || chain.operation.dispatch_claimed_at !== null) {
        return { claimed: false, operation: operationProjection(chain.operation) };
      }
      await client.query(
        `UPDATE motive.request_operations
         SET status = 'IN_FLIGHT', dispatch_claimed_at = clock_timestamp(), dispatch_claimed_by = $2,
             dispatch_invocation_hash = $3, dispatched_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE provider_operation_id = $1`,
        [providerOperationId, dispatcherId, invocationHash],
      );
      await this.appendEventAndOutbox(client, {
        projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
        eventType: 'provider-operation.in-flight', actorId: input.actorId,
        payload: { provider_operation_id: providerOperationId, dispatcher_id: dispatcherId },
        topic: 'provider-operation.in-flight', dedupeKey: `provider-operation.in-flight:${providerOperationId}`,
      });
      const current = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
      if (current.rowCount !== 1) throw new Error('Provider operation was not readable after dispatch claim.');
      return { claimed: true, operation: operationProjection(current.rows[0]) };
    });
  }

  /** Persist provider identifiers as soon as they are observed, never replace them. */
  async recordOperationProviderIdentity(input: RecordOperationProviderIdentityInput): Promise<OperationProjection> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const providerRequestId = optionalText(input.providerRequestId, 'providerRequestId', 1_024);
    const providerResponseId = optionalText(input.providerResponseId, 'providerResponseId', 1_024);
    if (providerRequestId === null && providerResponseId === null) {
      fail('VALIDATION', 'At least one provider identity is required.');
    }
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      return this.idempotent(
        client,
        input,
        'operation.record-provider-identity',
        {
          provider_operation_id: providerOperationId,
          provider_request_id: providerRequestId,
          provider_response_id: providerResponseId,
        },
        async () => {
          const storedRequestId = chain.operation.provider_request_id === null ? null : asString(chain.operation, 'provider_request_id');
          const storedResponseId = chain.operation.provider_response_id === null ? null : asString(chain.operation, 'provider_response_id');
          if (storedRequestId !== null && providerRequestId !== null && storedRequestId !== providerRequestId) {
            fail('PROVIDER_IDENTITY_CONFLICT', 'Provider request identity conflicts with the durable operation record.');
          }
          if (storedResponseId !== null && providerResponseId !== null && storedResponseId !== providerResponseId) {
            fail('PROVIDER_IDENTITY_CONFLICT', 'Provider response identity conflicts with the durable operation record.');
          }
          const wroteRequestId = storedRequestId === null && providerRequestId !== null;
          const wroteResponseId = storedResponseId === null && providerResponseId !== null;
          if (wroteRequestId || wroteResponseId) {
            await client.query(
              `UPDATE motive.request_operations
               SET provider_request_id = COALESCE(provider_request_id, $2),
                   provider_response_id = COALESCE(provider_response_id, $3),
                   updated_at = clock_timestamp()
               WHERE provider_operation_id = $1`,
              [providerOperationId, providerRequestId, providerResponseId],
            );
          }
          if (wroteRequestId) {
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
              eventType: 'provider-operation.request-identity-recorded', actorId: input.actorId,
              payload: { provider_operation_id: providerOperationId },
              topic: 'provider-operation.request-identity-recorded', dedupeKey: `provider-operation.request-identity-recorded:${providerOperationId}`,
            });
          }
          if (wroteResponseId) {
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
              eventType: 'provider-operation.response-identity-recorded', actorId: input.actorId,
              payload: { provider_operation_id: providerOperationId },
              topic: 'provider-operation.response-identity-recorded', dedupeKey: `provider-operation.response-identity-recorded:${providerOperationId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
          if (current.rowCount !== 1) throw new Error('Provider operation was not readable after identity recording.');
          const operation = operationProjection(current.rows[0]);
          return { response: operation, resourceType: 'provider_operation', resourceId: providerOperationId };
        },
      );
    });
  }

  async markOperationInFlight(input: MarkOperationInFlightInput): Promise<OperationProjection> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const providerRequestId = optionalText(input.providerRequestId, 'providerRequestId', 1_024);
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      return this.idempotent(
        client,
        input,
        'operation.mark-in-flight',
        { provider_operation_id: providerOperationId, provider_request_id: providerRequestId },
        async () => {
          const status = asString(chain.operation, 'status');
          if (status !== 'ISSUING' && status !== 'IN_FLIGHT') fail('OPERATION_ALREADY_RESOLVED', 'Operation is no longer dispatchable.');
          const storedProviderRequestId = chain.operation.provider_request_id === null ? null : asString(chain.operation, 'provider_request_id');
          if (storedProviderRequestId !== null && providerRequestId !== null && storedProviderRequestId !== providerRequestId) {
            fail('VALIDATION', 'Provider request identity conflicts with the durable operation record.');
          }
          if (status === 'ISSUING') {
            await client.query(
              `UPDATE motive.request_operations
               SET status = 'IN_FLIGHT', provider_request_id = COALESCE(provider_request_id, $2), dispatched_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE provider_operation_id = $1`,
              [providerOperationId, providerRequestId],
            );
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
              eventType: 'provider-operation.in-flight', actorId: input.actorId,
              payload: { provider_operation_id: providerOperationId },
              topic: 'provider-operation.in-flight', dedupeKey: `provider-operation.in-flight:${providerOperationId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
          return { response: operationProjection(current.rows[0]), resourceType: 'provider_operation', resourceId: providerOperationId };
        },
      );
    });
  }

  async markOperationUnknown(input: MarkOperationUnknownInput): Promise<OperationProjection> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const reason = requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      return this.idempotent(
        client,
        input,
        'operation.mark-unknown',
        { provider_operation_id: providerOperationId, reason },
        async () => {
          const status = asString(chain.operation, 'status');
          if (!['ISSUING', 'IN_FLIGHT', 'UNKNOWN'].includes(status)) fail('OPERATION_ALREADY_RESOLVED', 'A reconciled operation cannot become unknown.');
          if (status !== 'UNKNOWN') {
            await client.query(
              `UPDATE motive.request_operations SET status = 'UNKNOWN', unknown_reason = $2, updated_at = clock_timestamp()
               WHERE provider_operation_id = $1`,
              [providerOperationId, reason],
            );
            await client.query(
              `UPDATE motive.reservations SET status = 'UNKNOWN'
               WHERE operation_id = $1 AND kind = 'ATTEMPT_REQUEST'`,
              [providerOperationId],
            );
            await this.insertIncident(client, {
              kind: 'UNKNOWN_ISSUANCE', sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'),
              attemptId: asString(chain.attempt, 'id'), operationId: providerOperationId,
              amount: asAmount(chain.operation, 'reserved_amount'), details: { reason },
            });
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
              eventType: 'provider-operation.unknown', actorId: input.actorId,
              payload: { provider_operation_id: providerOperationId, reserved_amount: asAmount(chain.operation, 'reserved_amount') },
              topic: 'provider-operation.unknown', dedupeKey: `provider-operation.unknown:${providerOperationId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
          return { response: operationProjection(current.rows[0]), resourceType: 'provider_operation', resourceId: providerOperationId };
        },
      );
    });
  }

  async settleOperation(input: SettleOperationInput): Promise<{ operation: OperationProjection; overrunAmount: DecimalAmount }> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const actualCost = chargedAmount(input.actualCost, 'actualCost');
    const providerUsageId = requireText(input.providerUsageId, 'providerUsageId', 1_024);
    const rawProviderAmount = input.rawProviderAmount === undefined ? input.actualCost : requireText(input.rawProviderAmount, 'rawProviderAmount', 1_024);
    const rawProviderUsage = input.rawProviderUsage ?? null;
    canonicalJson(rawProviderUsage);
    const providerRequestId = optionalText(input.providerRequestId, 'providerRequestId', 1_024);
    const providerResponseId = optionalText(input.providerResponseId, 'providerResponseId', 1_024);
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      return this.idempotent(
        client,
        input,
        'operation.settle',
        {
          provider_operation_id: providerOperationId, actual_cost: input.actualCost, provider_usage_id: providerUsageId,
          raw_provider_amount: rawProviderAmount, raw_provider_usage: rawProviderUsage,
          provider_request_id: providerRequestId, provider_response_id: providerResponseId,
        },
        async () => {
          const status = asString(chain.operation, 'status');
          if (!['ISSUING', 'IN_FLIGHT', 'UNKNOWN'].includes(status)) fail('OPERATION_ALREADY_RESOLVED', 'Operation already has an authoritative settlement.');
          const storedProviderRequestId = chain.operation.provider_request_id === null ? null : asString(chain.operation, 'provider_request_id');
          const storedProviderResponseId = chain.operation.provider_response_id === null ? null : asString(chain.operation, 'provider_response_id');
          const storedProviderUsageId = chain.operation.provider_usage_id === null ? null : asString(chain.operation, 'provider_usage_id');
          if (storedProviderRequestId !== null && providerRequestId !== null && storedProviderRequestId !== providerRequestId) {
            fail('VALIDATION', 'Provider request identity conflicts with the durable operation record.');
          }
          if (storedProviderResponseId !== null && providerResponseId !== null && storedProviderResponseId !== providerResponseId) {
            fail('VALIDATION', 'Provider response identity conflicts with the durable operation record.');
          }
          if (storedProviderUsageId !== null && storedProviderUsageId !== providerUsageId) {
            fail('VALIDATION', 'Provider usage identity conflicts with the durable operation record.');
          }
          const requestReservation = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE operation_id = $1 AND kind = 'ATTEMPT_REQUEST' FOR UPDATE`,
            [providerOperationId],
            'request',
          );
          const envelopeReservation = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE attempt_id = $1 AND kind = 'GRANT_ATTEMPT' FOR UPDATE`,
            [asString(chain.attempt, 'id')],
            'attempt envelope',
          );
          const sourceGrantReservation = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE grant_id = $1 AND kind = 'SOURCE_GRANT' FOR UPDATE`,
            [asString(chain.grant, 'id')],
            'source grant',
          );
          const requestHeld = asAmount(requestReservation, 'held_amount');
          const envelopeHeld = asAmount(envelopeReservation, 'held_amount');
          const sourceHeld = asAmount(sourceGrantReservation, 'held_amount');
          const reservedAmount = asAmount(chain.operation, 'reserved_amount');
          const requestCovered = minAmount(actualCost, requestHeld);
          const requestRelease = subtractAmounts(requestHeld, requestCovered, 'request release amount');
          const envelopeConsumed = minAmount(actualCost, envelopeHeld);
          const sourceConsumed = minAmount(actualCost, sourceHeld);
          const overrunAmount = compareAmounts(actualCost, reservedAmount) > 0
            ? subtractAmounts(actualCost, reservedAmount, 'reservation overrun')
            : ZERO_AMOUNT;
          await client.query(
            `UPDATE motive.reservations
             SET held_amount = 0, settled_amount = settled_amount + $2, released_amount = released_amount + $3,
                 status = 'SETTLED', resolved_at = clock_timestamp()
             WHERE id = $1`,
            [asString(requestReservation, 'id'), requestCovered, requestRelease],
          );
          await client.query(
            `UPDATE motive.reservations
             SET held_amount = held_amount - $2, settled_amount = settled_amount + $2,
                 status = CASE WHEN held_amount - $2 = 0 THEN 'SETTLED'::motive.reservation_status ELSE 'HELD'::motive.reservation_status END,
                 resolved_at = CASE WHEN held_amount - $2 = 0 THEN clock_timestamp() ELSE resolved_at END
             WHERE id = $1`,
            [asString(envelopeReservation, 'id'), envelopeConsumed],
          );
          await client.query(
            `UPDATE motive.reservations
             SET held_amount = held_amount - $2, settled_amount = settled_amount + $2,
                 status = CASE WHEN held_amount - $2 = 0 THEN 'SETTLED'::motive.reservation_status ELSE 'HELD'::motive.reservation_status END,
                 resolved_at = CASE WHEN held_amount - $2 = 0 THEN clock_timestamp() ELSE resolved_at END
             WHERE id = $1`,
            [asString(sourceGrantReservation, 'id'), sourceConsumed],
          );
          await client.query(
            `UPDATE motive.attempts
             SET consumed_amount = consumed_amount + $2, request_held_amount = request_held_amount - $3, updated_at = clock_timestamp()
             WHERE id = $1`,
            [asString(chain.attempt, 'id'), actualCost, requestHeld],
          );
          await client.query(
            `UPDATE motive.grants
             SET consumed_amount = consumed_amount + $2, attempt_held_amount = attempt_held_amount - $3, updated_at = clock_timestamp()
             WHERE id = $1`,
            [asString(chain.grant, 'id'), actualCost, envelopeConsumed],
          );
          await client.query(
            `UPDATE motive.funding_sources
             SET consumed_amount = consumed_amount + $2, allocated_amount = allocated_amount - $3, updated_at = clock_timestamp()
             WHERE id = $1`,
            [asString(chain.source, 'id'), actualCost, sourceConsumed],
          );
          await client.query(
            `UPDATE motive.request_operations
             SET actual_cost = $2, status = CASE WHEN $3::numeric > 0 THEN 'INCIDENT'::motive.operation_status ELSE 'RECONCILED'::motive.operation_status END,
                 provider_usage_id = $4, raw_provider_amount = $5, raw_provider_usage = $6::jsonb,
                 provider_request_id = COALESCE(provider_request_id, $7), provider_response_id = COALESCE(provider_response_id, $8),
                 settled_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE provider_operation_id = $1`,
            [providerOperationId, actualCost, overrunAmount, providerUsageId, rawProviderAmount, JSON.stringify(rawProviderUsage), providerRequestId, providerResponseId],
          );
          await client.query(
            `INSERT INTO motive.usage_records (id, operation_id, source_id, grant_id, attempt_id, kind, provider_usage_id, amount, raw_provider_amount, raw_usage)
             VALUES ($1, $2, $3, $4, $5, 'SETTLEMENT', $6, $7, $8, $9::jsonb)`,
            [randomUUID(), providerOperationId, asString(chain.source, 'id'), asString(chain.grant, 'id'), asString(chain.attempt, 'id'), providerUsageId, actualCost, rawProviderAmount, JSON.stringify(rawProviderUsage)],
          );
          if (status === 'UNKNOWN') {
            await client.query(
              `UPDATE motive.accounting_incidents SET resolved_at = clock_timestamp()
               WHERE operation_id = $1 AND kind = 'UNKNOWN_ISSUANCE' AND resolved_at IS NULL`,
              [providerOperationId],
            );
          }
          const sourceExcess = subtractAmounts(actualCost, sourceConsumed, 'source excess');
          const envelopeExcess = subtractAmounts(actualCost, envelopeConsumed, 'attempt excess');
          await this.appendJournal(client, {
            kind: 'REQUEST_SETTLED', referenceType: 'provider_operation', referenceId: providerOperationId,
            sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'), attemptId: asString(chain.attempt, 'id'), operationId: providerOperationId,
            transfers: [
              { debit: `source:${asString(chain.source, 'id')}:consumed`, credit: `source:${asString(chain.source, 'id')}:grant-held`, amount: sourceConsumed },
              { debit: `source:${asString(chain.source, 'id')}:consumed`, credit: `source:${asString(chain.source, 'id')}:unfunded-exposure`, amount: sourceExcess },
              { debit: `grant:${asString(chain.grant, 'id')}:consumed`, credit: `grant:${asString(chain.grant, 'id')}:attempt-held`, amount: envelopeConsumed },
              { debit: `grant:${asString(chain.grant, 'id')}:consumed`, credit: `grant:${asString(chain.grant, 'id')}:unfunded-exposure`, amount: envelopeExcess },
              { debit: `attempt:${asString(chain.attempt, 'id')}:consumed`, credit: `attempt:${asString(chain.attempt, 'id')}:request-held`, amount: requestCovered },
              { debit: `attempt:${asString(chain.attempt, 'id')}:available`, credit: `attempt:${asString(chain.attempt, 'id')}:request-held`, amount: requestRelease },
              { debit: `attempt:${asString(chain.attempt, 'id')}:consumed`, credit: `attempt:${asString(chain.attempt, 'id')}:unfunded-exposure`, amount: subtractAmounts(actualCost, requestCovered, 'request excess') },
            ],
          });
          if (compareAmounts(overrunAmount, ZERO_AMOUNT) > 0) {
            await this.freezeAffectedContext(client, chain, 'RESERVATION_OVERRUN');
            const incidentId = await this.insertIncident(client, {
              kind: 'RESERVATION_OVERRUN', sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'),
              attemptId: asString(chain.attempt, 'id'), operationId: providerOperationId, amount: overrunAmount,
              details: { reserved_amount: reservedAmount, actual_cost: actualCost, raw_provider_amount: rawProviderAmount },
            });
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'accounting_incident', aggregateId: incidentId,
              eventType: 'accounting.reservation-overrun', actorId: input.actorId,
              payload: { incident_id: incidentId, provider_operation_id: providerOperationId, overrun_amount: overrunAmount },
              topic: 'accounting.reservation-overrun', dedupeKey: `accounting.reservation-overrun:${providerOperationId}`,
            });
          }
          await this.appendEventAndOutbox(client, {
            projectId: asString(chain.attempt, 'project_id'), aggregateType: 'provider_operation', aggregateId: providerOperationId,
            eventType: 'provider-operation.settled', actorId: input.actorId,
            payload: { provider_operation_id: providerOperationId, actual_cost: actualCost, overrun_amount: overrunAmount },
            topic: 'provider-operation.settled', dedupeKey: `provider-operation.settled:${providerOperationId}`,
          });
          const settled = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
          return { response: { operation: operationProjection(settled.rows[0]), overrunAmount }, resourceType: 'provider_operation', resourceId: providerOperationId };
        },
      );
    });
  }

  async recordLateUsage(input: RecordLateUsageInput): Promise<{ operation: OperationProjection; recorded: boolean }> {
    const providerOperationId = requireUuid(input.providerOperationId, 'providerOperationId');
    const providerUsageId = requireText(input.providerUsageId, 'providerUsageId', 1_024);
    const additionalCost = positiveAmount(chargedAmount(input.additionalCost, 'additionalCost'), 'additionalCost');
    const rawProviderAmount = input.rawProviderAmount === undefined ? input.additionalCost : requireText(input.rawProviderAmount, 'rawProviderAmount', 1_024);
    const rawProviderUsage = input.rawProviderUsage ?? null;
    canonicalJson(rawProviderUsage);
    return this.transaction(async client => {
      const chain = await this.lockOperationChain(client, providerOperationId);
      return this.idempotent<{ operation: OperationProjection; recorded: boolean }>(
        client,
        input,
        'operation.record-late-usage',
        {
          provider_operation_id: providerOperationId, provider_usage_id: providerUsageId, additional_cost: input.additionalCost,
          raw_provider_amount: rawProviderAmount, raw_provider_usage: rawProviderUsage,
        },
        async () => {
          const status = asString(chain.operation, 'status');
          if (!['RECONCILED', 'INCIDENT'].includes(status)) fail('OPERATION_NOT_SETTLED', 'Late usage may only adjust an already settled operation.');
          const duplicateUsage = await client.query(
            `SELECT * FROM motive.usage_records WHERE source_id = $1 AND provider_usage_id = $2 FOR UPDATE`,
            [asString(chain.source, 'id'), providerUsageId],
          );
          if (duplicateUsage.rows.length === 1) {
            const duplicate = duplicateUsage.rows[0];
            if (asString(duplicate, 'kind') !== 'LATE_ADJUSTMENT'
              || asString(duplicate, 'operation_id') !== providerOperationId
              || compareAmounts(asAmount(duplicate, 'amount'), additionalCost) !== 0) {
              fail('OPERATION_ALREADY_RESOLVED', 'Provider usage identity conflicts with a different durable usage record.');
            }
            return { response: { operation: operationProjection(chain.operation), recorded: false }, resourceType: 'provider_operation', resourceId: providerOperationId };
          }
          const envelopeReservation = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE attempt_id = $1 AND kind = 'GRANT_ATTEMPT' FOR UPDATE`,
            [asString(chain.attempt, 'id')],
            'attempt envelope',
          );
          const sourceGrantReservation = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE grant_id = $1 AND kind = 'SOURCE_GRANT' FOR UPDATE`,
            [asString(chain.grant, 'id')],
            'source grant',
          );
          const envelopeConsumed = minAmount(additionalCost, asAmount(envelopeReservation, 'held_amount'));
          const sourceConsumed = minAmount(additionalCost, asAmount(sourceGrantReservation, 'held_amount'));
          const attemptExcess = subtractAmounts(additionalCost, envelopeConsumed, 'late attempt excess');
          const sourceExcess = subtractAmounts(additionalCost, sourceConsumed, 'late source excess');
          await client.query(
            `INSERT INTO motive.usage_records (id, operation_id, source_id, grant_id, attempt_id, kind, provider_usage_id, amount, raw_provider_amount, raw_usage)
             VALUES ($1, $2, $3, $4, $5, 'LATE_ADJUSTMENT', $6, $7, $8, $9::jsonb)`,
            [randomUUID(), providerOperationId, asString(chain.source, 'id'), asString(chain.grant, 'id'), asString(chain.attempt, 'id'), providerUsageId, additionalCost, rawProviderAmount, JSON.stringify(rawProviderUsage)],
          );
          await client.query(
            `UPDATE motive.reservations
             SET held_amount = held_amount - $2, settled_amount = settled_amount + $2,
                 status = CASE WHEN held_amount - $2 = 0 THEN 'SETTLED'::motive.reservation_status ELSE 'HELD'::motive.reservation_status END,
                 resolved_at = CASE WHEN held_amount - $2 = 0 THEN clock_timestamp() ELSE resolved_at END
             WHERE id = $1`,
            [asString(envelopeReservation, 'id'), envelopeConsumed],
          );
          await client.query(
            `UPDATE motive.reservations
             SET held_amount = held_amount - $2, settled_amount = settled_amount + $2,
                 status = CASE WHEN held_amount - $2 = 0 THEN 'SETTLED'::motive.reservation_status ELSE 'HELD'::motive.reservation_status END,
                 resolved_at = CASE WHEN held_amount - $2 = 0 THEN clock_timestamp() ELSE resolved_at END
             WHERE id = $1`,
            [asString(sourceGrantReservation, 'id'), sourceConsumed],
          );
          await client.query(
            `UPDATE motive.request_operations
             SET late_adjustment_amount = late_adjustment_amount + $2, status = 'INCIDENT', updated_at = clock_timestamp()
             WHERE provider_operation_id = $1`,
            [providerOperationId, additionalCost],
          );
          await client.query(
            `UPDATE motive.attempts SET consumed_amount = consumed_amount + $2, updated_at = clock_timestamp() WHERE id = $1`,
            [asString(chain.attempt, 'id'), additionalCost],
          );
          await client.query(
            `UPDATE motive.grants
             SET consumed_amount = consumed_amount + $2, attempt_held_amount = attempt_held_amount - $3, updated_at = clock_timestamp()
             WHERE id = $1`,
            [asString(chain.grant, 'id'), additionalCost, envelopeConsumed],
          );
          await client.query(
            `UPDATE motive.funding_sources
             SET consumed_amount = consumed_amount + $2, allocated_amount = allocated_amount - $3, updated_at = clock_timestamp()
             WHERE id = $1`,
            [asString(chain.source, 'id'), additionalCost, sourceConsumed],
          );
          await this.freezeAffectedContext(client, chain, 'LATE_USAGE');
          await this.appendJournal(client, {
            kind: 'LATE_USAGE_RECORDED', referenceType: 'provider_operation', referenceId: providerOperationId,
            sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'), attemptId: asString(chain.attempt, 'id'), operationId: providerOperationId,
            transfers: [
              { debit: `source:${asString(chain.source, 'id')}:consumed`, credit: `source:${asString(chain.source, 'id')}:grant-held`, amount: sourceConsumed },
              { debit: `source:${asString(chain.source, 'id')}:consumed`, credit: `source:${asString(chain.source, 'id')}:unfunded-exposure`, amount: sourceExcess },
              { debit: `grant:${asString(chain.grant, 'id')}:consumed`, credit: `grant:${asString(chain.grant, 'id')}:attempt-held`, amount: envelopeConsumed },
              { debit: `grant:${asString(chain.grant, 'id')}:consumed`, credit: `grant:${asString(chain.grant, 'id')}:unfunded-exposure`, amount: attemptExcess },
              { debit: `attempt:${asString(chain.attempt, 'id')}:consumed`, credit: `attempt:${asString(chain.attempt, 'id')}:available`, amount: envelopeConsumed },
              { debit: `attempt:${asString(chain.attempt, 'id')}:consumed`, credit: `attempt:${asString(chain.attempt, 'id')}:unfunded-exposure`, amount: attemptExcess },
            ],
          });
          const incidentId = await this.insertIncident(client, {
            kind: 'LATE_USAGE', sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'),
            attemptId: asString(chain.attempt, 'id'), operationId: providerOperationId, amount: additionalCost,
            details: { provider_usage_id: providerUsageId, raw_provider_amount: rawProviderAmount },
          });
          await this.appendEventAndOutbox(client, {
            projectId: asString(chain.attempt, 'project_id'), aggregateType: 'accounting_incident', aggregateId: incidentId,
            eventType: 'accounting.late-usage', actorId: input.actorId,
            payload: { incident_id: incidentId, provider_operation_id: providerOperationId, amount: additionalCost },
            topic: 'accounting.late-usage', dedupeKey: `accounting.late-usage:${asString(chain.source, 'id')}:${providerUsageId}`,
          });
          const current = await client.query('SELECT * FROM motive.request_operations WHERE provider_operation_id = $1', [providerOperationId]);
          return { response: { operation: operationProjection(current.rows[0]), recorded: true }, resourceType: 'provider_operation', resourceId: providerOperationId };
        },
      );
    });
  }

  async requestAttemptCancellation(input: RequestAttemptCancellationInput): Promise<AttemptProjection> {
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    const reason = input.reason === undefined ? null : requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      // This takes precisely the same chain locks as admission. Either a
      // request commits first and is durable in-flight, or this boundary wins
      // and the later admission observes it.
      const chain = await this.lockAttemptChain(client, attemptId);
      return this.idempotent(
        client,
        input,
        'attempt.cancel-request',
        { attempt_id: attemptId, reason },
        async () => {
          const currentStatus = asString(chain.attempt, 'execution_status');
          if (!TERMINAL_ATTEMPT_STATES.has(currentStatus) && chain.attempt.admission_closed_at === null) {
            await client.query(
              `UPDATE motive.attempts
               SET admission_closed_at = clock_timestamp(), cancellation_requested_at = clock_timestamp(), cancellation_reason = $2,
                   execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING') THEN 'CANCEL_REQUESTED'::motive.attempt_execution_status ELSE execution_status END,
                   updated_at = clock_timestamp()
               WHERE id = $1`,
              [attemptId, reason],
            );
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'attempt', aggregateId: attemptId,
              eventType: 'attempt.cancel-requested', actorId: input.actorId,
              payload: { attempt_id: attemptId, reason },
              topic: 'attempt.cancel-requested', dedupeKey: `attempt.cancel-requested:${attemptId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.attempts WHERE id = $1', [attemptId]);
          return { response: attemptProjection(current.rows[0]), resourceType: 'attempt', resourceId: attemptId };
        },
      );
    });
  }

  async revokeGrant(input: RevokeGrantInput): Promise<GrantProjection> {
    const grantId = requireUuid(input.grantId, 'grantId');
    const reason = input.reason === undefined ? null : requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      const chain = await this.lockGrantChain(client, grantId);
      return this.idempotent(
        client,
        input,
        'grant.revoke',
        { grant_id: grantId, reason },
        async () => {
          if (asString(chain.grant, 'issuer_actor_id') !== input.actorId) {
            fail('GRANT_UNAVAILABLE', 'Only the grant issuer may revoke this grant through this operation.');
          }
          if (asString(chain.grant, 'status') === 'ACTIVE' && chain.grant.admission_closed_at === null) {
            await client.query(
              `UPDATE motive.grants
               SET status = 'REVOKED', admission_closed_at = clock_timestamp(), revoked_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE id = $1`,
              [grantId],
            );
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.grant, 'project_id'), aggregateType: 'grant', aggregateId: grantId,
              eventType: 'grant.revoked', actorId: input.actorId,
              payload: { grant_id: grantId, reason },
              topic: 'grant.revoked', dedupeKey: `grant.revoked:${grantId}`,
            });
            // Keep physical teardown wakeups in the same transaction as the
            // financial admission boundary. The existing chain lock excludes
            // concurrent admission/launch claims; lock attempts in stable order.
            const activeAttempts = await client.query(
              `SELECT * FROM motive.attempts WHERE grant_id = $1
               AND execution_status NOT IN ('CLOSED', 'FAILED', 'CANCELLED')
               AND cancellation_requested_at IS NULL ORDER BY id FOR UPDATE`,
              [grantId],
            );
            for (const active of activeAttempts.rows) {
              const activeId = asString(active, 'id');
              await client.query(
                `UPDATE motive.attempts
                 SET admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
                     cancellation_requested_at = clock_timestamp(), cancellation_reason = $2,
                     execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING')
                       THEN 'CANCEL_REQUESTED'::motive.attempt_execution_status ELSE execution_status END,
                     updated_at = clock_timestamp() WHERE id = $1`,
                [activeId, reason ?? 'Funding grant revoked'],
              );
              await this.appendEventAndOutbox(client, {
                projectId: asString(active, 'project_id'), aggregateType: 'attempt', aggregateId: activeId,
                eventType: 'attempt.cancel-requested', actorId: input.actorId,
                payload: { attempt_id: activeId, grant_id: grantId, reason: reason ?? 'Funding grant revoked' },
                topic: 'attempt.cancel-requested', dedupeKey: `attempt.cancel-requested:${activeId}`,
              });
            }
          }
          const current = await client.query('SELECT * FROM motive.grants WHERE id = $1', [grantId]);
          return { response: grantProjection(current.rows[0]), resourceType: 'grant', resourceId: grantId };
        },
      );
    });
  }

  /**
   * Financial closure only. P2 must record independent sandbox/command stop
   * observation before anyone calls this evidence of physical cleanup.
   */
  async closeAttempt(input: CloseAttemptInput): Promise<AttemptProjection> {
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, attemptId);
      return this.idempotent(
        client,
        input,
        'attempt.close',
        { attempt_id: attemptId },
        async () => {
          const unresolved = await client.query(
            `SELECT provider_operation_id FROM motive.request_operations
             WHERE attempt_id = $1 AND status IN ('ISSUING', 'IN_FLIGHT', 'UNKNOWN') FOR KEY SHARE`,
            [attemptId],
          );
          if (unresolved.rows.length > 0) fail('ATTEMPT_HAS_UNRESOLVED_OPERATIONS', 'Attempt retains unknown or in-flight provider exposure.');
          const envelope = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE attempt_id = $1 AND kind = 'GRANT_ATTEMPT' FOR UPDATE`,
            [attemptId],
            'attempt envelope',
          );
          const releaseAmount = asAmount(envelope, 'held_amount');
          if (compareAmounts(releaseAmount, ZERO_AMOUNT) > 0) {
            await client.query(
              `UPDATE motive.reservations
               SET held_amount = 0, released_amount = released_amount + $2, status = 'RELEASED', resolved_at = clock_timestamp()
               WHERE id = $1`,
              [asString(envelope, 'id'), releaseAmount],
            );
            await client.query(
              `UPDATE motive.grants SET attempt_held_amount = attempt_held_amount - $2, updated_at = clock_timestamp() WHERE id = $1`,
              [asString(chain.grant, 'id'), releaseAmount],
            );
            await this.appendJournal(client, {
              kind: 'ATTEMPT_ENVELOPE_RELEASED', referenceType: 'attempt', referenceId: attemptId,
              sourceId: asString(chain.source, 'id'), grantId: asString(chain.grant, 'id'), attemptId,
              transfers: [{ debit: `grant:${asString(chain.grant, 'id')}:available`, credit: `grant:${asString(chain.grant, 'id')}:attempt-held`, amount: releaseAmount }],
            });
          }
          if (!TERMINAL_ATTEMPT_STATES.has(asString(chain.attempt, 'execution_status'))) {
            await client.query(
              `UPDATE motive.attempts
               SET execution_status = 'CLOSED', admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
                   closed_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE id = $1`,
              [attemptId],
            );
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.attempt, 'project_id'), aggregateType: 'attempt', aggregateId: attemptId,
              eventType: 'attempt.closed', actorId: input.actorId,
              payload: { attempt_id: attemptId, released_amount: releaseAmount },
              topic: 'attempt.closed', dedupeKey: `attempt.closed:${attemptId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.attempts WHERE id = $1', [attemptId]);
          return { response: attemptProjection(current.rows[0]), resourceType: 'attempt', resourceId: attemptId };
        },
      );
    });
  }

  async closeGrant(input: CloseGrantInput): Promise<GrantProjection> {
    const grantId = requireUuid(input.grantId, 'grantId');
    return this.transaction(async client => {
      const chain = await this.lockGrantChain(client, grantId);
      return this.idempotent(
        client,
        input,
        'grant.close',
        { grant_id: grantId },
        async () => {
          const unresolved = await client.query(
            `SELECT provider_operation_id FROM motive.request_operations
             WHERE grant_id = $1 AND status IN ('ISSUING', 'IN_FLIGHT', 'UNKNOWN') FOR KEY SHARE`,
            [grantId],
          );
          if (unresolved.rows.length > 0) fail('ATTEMPT_HAS_UNRESOLVED_OPERATIONS', 'Grant retains unknown or in-flight provider exposure.');
          const activeAttempts = await client.query(
            `SELECT id FROM motive.attempts WHERE grant_id = $1 AND execution_status NOT IN ('CLOSED', 'FAILED', 'CANCELLED') FOR KEY SHARE`,
            [grantId],
          );
          if (activeAttempts.rows.length > 0) fail('ATTEMPT_UNAVAILABLE', 'All attempts must be financially closed before a grant releases capacity.');
          if (compareAmounts(asAmount(chain.grant, 'attempt_held_amount'), ZERO_AMOUNT) > 0) {
            throw new Error('Grant counter has held attempt capacity after all attempts are terminal.');
          }
          const sourceGrant = await this.lockReservation(
            client,
            `SELECT * FROM motive.reservations WHERE grant_id = $1 AND kind = 'SOURCE_GRANT' FOR UPDATE`,
            [grantId],
            'source grant',
          );
          const releaseAmount = asAmount(sourceGrant, 'held_amount');
          if (compareAmounts(releaseAmount, ZERO_AMOUNT) > 0) {
            await client.query(
              `UPDATE motive.reservations
               SET held_amount = 0, released_amount = released_amount + $2, status = 'RELEASED', resolved_at = clock_timestamp()
               WHERE id = $1`,
              [asString(sourceGrant, 'id'), releaseAmount],
            );
            await client.query(
              `UPDATE motive.funding_sources SET allocated_amount = allocated_amount - $2, updated_at = clock_timestamp() WHERE id = $1`,
              [asString(chain.source, 'id'), releaseAmount],
            );
            await this.appendJournal(client, {
              kind: 'GRANT_CAPACITY_RELEASED', referenceType: 'grant', referenceId: grantId,
              sourceId: asString(chain.source, 'id'), grantId,
              transfers: [{ debit: `source:${asString(chain.source, 'id')}:available`, credit: `source:${asString(chain.source, 'id')}:grant-held`, amount: releaseAmount }],
            });
          }
          if (asString(chain.grant, 'status') !== 'CLOSED') {
            await client.query(
              `UPDATE motive.grants
               SET status = 'CLOSED', admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
                   closed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
              [grantId],
            );
            await this.appendEventAndOutbox(client, {
              projectId: asString(chain.grant, 'project_id'), aggregateType: 'grant', aggregateId: grantId,
              eventType: 'grant.closed', actorId: input.actorId,
              payload: { grant_id: grantId, released_amount: releaseAmount },
              topic: 'grant.closed', dedupeKey: `grant.closed:${grantId}`,
            });
          }
          const current = await client.query('SELECT * FROM motive.grants WHERE id = $1', [grantId]);
          return { response: grantProjection(current.rows[0]), resourceType: 'grant', resourceId: grantId };
        },
      );
    });
  }

  async freezeForRecovery(input: FreezeForRecoveryInput): Promise<{ generation: string; spendingEnabled: boolean }> {
    const reason = requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      const controller = await this.lockController(client);
      return this.idempotent(
        client,
        input,
        'controller.freeze-for-recovery',
        { reason },
        async () => {
          await client.query(
            `UPDATE motive.controller_state
             SET generation = generation + 1, spending_enabled = FALSE, freeze_reason = $1,
                 frozen_at = clock_timestamp(), changed_by = $2, changed_at = clock_timestamp()
             WHERE singleton = TRUE`,
            [reason, input.actorId],
          );
          const current = await client.query('SELECT * FROM motive.controller_state WHERE singleton = TRUE');
          const row = current.rows[0];
          await this.appendEventAndOutbox(client, {
            aggregateType: 'controller', aggregateId: CONTROLLER_AGGREGATE_ID, eventType: 'controller.recovery-frozen', actorId: input.actorId,
            payload: { previous_generation: asString(controller, 'generation'), generation: asString(row, 'generation'), reason },
            topic: 'controller.recovery-frozen', dedupeKey: `controller.recovery-frozen:${asString(row, 'generation')}`,
          });
          return { response: { generation: asString(row, 'generation'), spendingEnabled: asBoolean(row, 'spending_enabled') }, resourceType: 'controller', resourceId: CONTROLLER_AGGREGATE_ID };
        },
      );
    });
  }

  async setControllerSpending(input: SetControllerSpendingInput): Promise<{ generation: string; spendingEnabled: boolean }> {
    if (typeof input.enabled !== 'boolean') fail('VALIDATION', 'enabled must be a boolean.');
    const reason = requireText(input.reason, 'reason', 4_096);
    return this.transaction(async client => {
      const controller = await this.lockController(client);
      return this.idempotent(
        client,
        input,
        'controller.set-spending',
        { enabled: input.enabled, reason },
        async () => {
          if (asBoolean(controller, 'spending_enabled') === input.enabled) {
            return {
              response: { generation: asString(controller, 'generation'), spendingEnabled: input.enabled },
              resourceType: 'controller', resourceId: CONTROLLER_AGGREGATE_ID,
            };
          }
          await client.query(
            `UPDATE motive.controller_state
             SET generation = CASE WHEN $1::boolean THEN generation ELSE generation + 1 END,
                 spending_enabled = $1, freeze_reason = CASE WHEN $1::boolean THEN NULL ELSE $2 END,
                 frozen_at = CASE WHEN $1::boolean THEN frozen_at ELSE clock_timestamp() END,
                 changed_by = $3, changed_at = clock_timestamp()
             WHERE singleton = TRUE`,
            [input.enabled, reason, input.actorId],
          );
          const current = await client.query('SELECT * FROM motive.controller_state WHERE singleton = TRUE');
          const row = current.rows[0];
          await this.appendEventAndOutbox(client, {
            aggregateType: 'controller', aggregateId: CONTROLLER_AGGREGATE_ID,
            eventType: input.enabled ? 'controller.spending-enabled' : 'controller.spending-disabled', actorId: input.actorId,
            payload: { previous_generation: asString(controller, 'generation'), generation: asString(row, 'generation'), enabled: input.enabled, reason },
            topic: input.enabled ? 'controller.spending-enabled' : 'controller.spending-disabled',
            dedupeKey: `controller.spending:${asString(row, 'generation')}:${input.enabled ? 'enabled' : 'disabled'}`,
          });
          return { response: { generation: asString(row, 'generation'), spendingEnabled: asBoolean(row, 'spending_enabled') }, resourceType: 'controller', resourceId: CONTROLLER_AGGREGATE_ID };
        },
      );
    });
  }

  async claimOutbox(consumerId: string, limit = 20): Promise<OutboxMessage[]> {
    const consumer = requireText(consumerId, 'consumerId', 512);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) fail('VALIDATION', 'limit must be an integer from 1 to 100.');
    return this.transaction(async client => {
      const pending = await client.query(
        `SELECT * FROM motive.outbox
         WHERE delivered_at IS NULL AND available_at <= clock_timestamp()
           AND (claimed_at IS NULL OR claimed_at < clock_timestamp() - INTERVAL '5 minutes')
         ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const row of pending.rows) {
        await client.query(
          `UPDATE motive.outbox SET claimed_at = clock_timestamp(), claimed_by = $2, delivery_attempts = delivery_attempts + 1 WHERE id = $1`,
          [asString(row, 'id'), consumer],
        );
      }
      return pending.rows.map(row => ({
        id: asString(row, 'id'), eventId: asString(row, 'event_id'), aggregateType: asString(row, 'aggregate_type'),
        aggregateId: asString(row, 'aggregate_id'), topic: asString(row, 'topic'), dedupeKey: asString(row, 'dedupe_key'),
        payload: row.payload, deliveryAttempts: asNumber(row, 'delivery_attempts') + 1,
      }));
    });
  }

  async markOutboxDelivered(outboxId: string, consumerId: string): Promise<void> {
    const id = requireUuid(outboxId, 'outboxId');
    const consumer = requireText(consumerId, 'consumerId', 512);
    await this.transaction(async client => {
      const outbox = await client.query('SELECT * FROM motive.outbox WHERE id = $1 FOR UPDATE', [id]);
      if (outbox.rowCount !== 1) fail('NOT_FOUND', 'Outbox message was not found.');
      const row = outbox.rows[0];
      if (row.delivered_at !== null) return;
      if (asString(row, 'claimed_by') !== consumer) fail('VALIDATION', 'Outbox message is leased by a different consumer.');
      await client.query('UPDATE motive.outbox SET delivered_at = clock_timestamp() WHERE id = $1', [id]);
    });
  }

  async getGrantForIssuer(grantId: string, actorId: string): Promise<GrantProjection | null> {
    const result = await this.pool.query(
      `SELECT * FROM motive.grants WHERE id = $1 AND issuer_actor_id = $2`,
      [requireUuid(grantId, 'grantId'), requireText(actorId, 'actorId', 512)],
    );
    return result.rowCount === 0 ? null : grantProjection(result.rows[0]);
  }

  async listGrantsForIssuer(actorId: string): Promise<GrantProjection[]> {
    const result = await this.pool.query(
      `SELECT * FROM motive.grants WHERE issuer_actor_id = $1 ORDER BY created_at DESC`,
      [requireText(actorId, 'actorId', 512)],
    );
    return result.rows.map(grantProjection);
  }

  async getAttempt(attemptId: string): Promise<AttemptProjection | null> {
    const result = await this.pool.query('SELECT * FROM motive.attempts WHERE id = $1', [requireUuid(attemptId, 'attemptId')]);
    return result.rowCount === 0 ? null : attemptProjection(result.rows[0]);
  }

  async getControllerState(): Promise<{ generation: string; spendingEnabled: boolean; freezeReason: string | null }> {
    const result = await this.pool.query('SELECT * FROM motive.controller_state WHERE singleton = TRUE');
    if (result.rowCount !== 1) throw new Error('Controller state singleton is missing.');
    const row = result.rows[0];
    return { generation: asString(row, 'generation'), spendingEnabled: asBoolean(row, 'spending_enabled'), freezeReason: row.freeze_reason === null ? null : asString(row, 'freeze_reason') };
  }
}
