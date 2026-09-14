import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  DomainValidationError,
  assertDigest,
  canonicalJson,
  digestCanonicalJson,
  validateWorkOrderTerms,
  type DecimalAmount,
  type Digest,
} from '../../domain/src/contracts.ts';
import { requireProtectedRuntime } from '../../sandbox-vercel/src/protected-runtime.ts';
import { requireWorkerExecutionBoundary } from '../../sandbox-vercel/src/execution-boundary.ts';
import { sandboxName, validateProfile } from '../../sandbox-vercel/src/policy.ts';
import type { SandboxExecutionProfile } from '../../sandbox-vercel/src/types.ts';
import { isExactProviderCircleCollection } from './circle-data-boundary.ts';
import {
  ZERO_AMOUNT,
  addAmounts,
  compareAmounts,
  exactAmount,
  minAmount,
  positiveAmount,
  subtractAmounts,
} from '../../accounting/src/money.ts';
import type {
  AcknowledgeDeliveryInput,
  ArtifactSealProjection,
  ClaimDeliveryBatchInput,
  CommandHandle,
  ControllerLease,
  CreateInfrastructureAuthorizationInput,
  DeferDeliveryInput,
  DeliveryClaim,
  EffectIntent,
  EvaluatorReportClaim,
  EnvironmentHandle,
  EnvironmentProjection,
  EnvironmentState,
  ExecutionProjection,
  FreezeNativeCollectionPlanInput,
  InfrastructureAuthorizationProjection,
  NativeCollectionCompletionInput,
  NativeCollectionEffectProjection,
  NativeCollectionFrozenPath,
  NativeCollectionPlanProjection,
  WorkerExecutionBoundaryKind,
  OrchestrationStore,
  PlanCommandInput,
  PlanNativeCaptureInput,
  ProviderObservation,
  RecordArtifactFailureInput,
  RecordArtifactSealInput,
  RecordNativeBootstrapBindingInput,
  RecordOrphanInput,
  ReconciliationCandidate,
  ReserveEnvironmentInput,
  SettleInfrastructureUsageInput,
  WorkerWorkspaceBindingInput,
} from './store-types.ts';

export type OrchestrationStoreErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LEASE_FENCED'
  | 'LEASE_HELD'
  | 'CONTROLLER_FROZEN'
  | 'SOURCE_UNAVAILABLE'
  | 'GRANT_UNAVAILABLE'
  | 'ATTEMPT_UNAVAILABLE'
  | 'INFRA_AUTHORIZATION_UNAVAILABLE'
  | 'INFRA_CAPACITY_EXHAUSTED'
  | 'PHYSICAL_CAPACITY_EXHAUSTED'
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'ENVIRONMENT_TERMINATED'
  | 'EFFECT_UNAVAILABLE'
  | 'EFFECT_CONFLICT'
  | 'EFFECT_NOT_CLAIMED'
  | 'OBSERVATION_INVALID'
  | 'ARTIFACT_ALREADY_RECORDED';

export class OrchestrationStoreError extends Error {
  constructor(
    readonly code: OrchestrationStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'OrchestrationStoreError';
  }
}

function fail(code: OrchestrationStoreErrorCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new OrchestrationStoreError(code, message, details);
}

type Chain = {
  controller: QueryResultRow;
  source: QueryResultRow;
  grant: QueryResultRow;
  attempt: QueryResultRow;
};

type TrackedEnvironmentContext = {
  chain: Chain;
  environment: QueryResultRow;
  authorization?: QueryResultRow;
};

type TrackedEffectContext = TrackedEnvironmentContext & { effect: QueryResultRow };

type NativeCollectionPlanContext = TrackedEnvironmentContext & { plan: QueryResultRow };
type NativeCollectionEffectContext = NativeCollectionPlanContext & { effect: QueryResultRow };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_ATTEMPT_STATES = new Set(['RESERVED', 'PROVISIONING', 'RUNNING', 'OUTPUT_SEALED', 'EVALUATING']);
const SECRET_KEY = /(secret|token|capability|credential|password|authorization|api.?key|private.?key)/i;
const SECRET_VALUE = /(?:\bbearer\s+|\bsk-[A-Za-z0-9]|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/i;
const NATIVE_COLLECTION_MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const NATIVE_WORKSPACE_IDENTITY = /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/;
const NATIVE_COLLECTION_MAX_PATH_BYTES = 1_024;
const NATIVE_COLLECTION_MAX_SEGMENT_BYTES = 255;
/** Vercel helper stdout uses bounded ASCII/base64 transport, not the 64 MiB binary collector mode. */
const NATIVE_COLLECTION_MAX_FILE_BYTES = 8 * 1024 * 1024;

function requireText(value: unknown, name: string, maximum = 1_024): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    fail('VALIDATION', `${name} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function workspaceBindingProjection(row: QueryResultRow): WorkerWorkspaceBindingInput {
  return {
    workerRuntimeDigest: asString(row, 'worker_runtime_digest') as Digest,
    binding: {
      format: 'motive.vercel-native-workspace-binding/0.1',
      runtimeDigest: asString(row, 'collector_runtime_digest') as Digest,
      workspaceIdentity: asString(row, 'workspace_identity'),
      handle: {
        provider: 'vercel', attemptId: asString(row, 'attempt_id'),
        sandboxId: asString(row, 'external_id'), sessionId: asString(row, 'session_id'),
        leaseEpoch: asNumber(row, 'lease_epoch'), profileDigest: asString(row, 'profile_digest') as Digest,
      },
    },
  };
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('VALIDATION', `${name} must be a UUID.`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0 || value > maximum) {
    fail('VALIDATION', `${name} must be a positive safe integer.`);
  }
  return value;
}

function requireDate(value: unknown, name: string): string {
  if (typeof value !== 'string') fail('VALIDATION', `${name} must be an ISO timestamp.`);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) fail('VALIDATION', `${name} must be an ISO timestamp.`);
  return date.toISOString();
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
  if (typeof row[field] !== 'boolean') throw new Error(`Database returned ${field} as a non-boolean.`);
  return row[field] as boolean;
}

function asAmount(row: QueryResultRow, field: string): DecimalAmount {
  return exactAmount(asString(row, field), field);
}

function nullableString(row: QueryResultRow, field: string): string | null {
  return row[field] === null || row[field] === undefined ? null : asString(row, field);
}

function nullableNumber(row: QueryResultRow, field: string): number | null {
  return row[field] === null || row[field] === undefined ? null : asNumber(row, field);
}

function nullableAmount(row: QueryResultRow, field: string): DecimalAmount | null {
  return row[field] === null || row[field] === undefined ? null : asAmount(row, field);
}

function nullableJsonObject(row: QueryResultRow, field: string): Record<string, unknown> | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Database returned ${field} as invalid JSON.`);
  return value as Record<string, unknown>;
}

function assertSafeStoredText(value: string, name: string, maximum = 512): string {
  const text = requireText(value, name, maximum);
  if (SECRET_VALUE.test(text)) fail('VALIDATION', `${name} appears to contain a bearer credential.`);
  return text;
}

function assertNativeCollectionRelativePath(value: unknown, name: string): string {
  const path = assertSafeStoredText(value as string, name, NATIVE_COLLECTION_MAX_PATH_BYTES);
  if (path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    fail('VALIDATION', `${name} must be a safe POSIX-relative artifact path.`);
  }
  const segments = path.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('VALIDATION', `${name} contains an unsafe path segment.`);
  }
  const encoder = new TextEncoder();
  if (encoder.encode(path).byteLength > NATIVE_COLLECTION_MAX_PATH_BYTES
    || segments.some(segment => encoder.encode(segment).byteLength > NATIVE_COLLECTION_MAX_SEGMENT_BYTES)) {
    fail('VALIDATION', `${name} exceeds the native collector path bounds.`);
  }
  if (path === 'manifest.json') fail('VALIDATION', `${name} is reserved for the trusted manifest.`);
  return path;
}

function assertNativeCollectionMediaType(value: unknown, name: string): string {
  const mediaType = requireText(value, name, 255).toLowerCase();
  if (!NATIVE_COLLECTION_MEDIA_TYPE.test(mediaType)) fail('VALIDATION', `${name} is not a valid media type.`);
  return mediaType;
}

type NormalizedNativeCollectionPlanInput = {
  collectorRuntimeDigest: Digest;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  paths: readonly NativeCollectionFrozenPath[];
};

function normalizeNativeCollectionPlanInput(input: FreezeNativeCollectionPlanInput): NormalizedNativeCollectionPlanInput {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'Native collection plan is required.');
  const collectorRuntimeDigest = assertDigest(input.collectorRuntimeDigest, 'collectorRuntimeDigest');
  const maximumFileBytes = requirePositiveInteger(input.maximumFileBytes, 'maximumFileBytes', NATIVE_COLLECTION_MAX_FILE_BYTES);
  const maximumTotalBytes = requirePositiveInteger(input.maximumTotalBytes, 'maximumTotalBytes', 2_147_483_647);
  if (maximumFileBytes > maximumTotalBytes) fail('VALIDATION', 'maximumFileBytes cannot exceed maximumTotalBytes.');
  if (!Array.isArray(input.approvedPaths) || input.approvedPaths.length === 0 || input.approvedPaths.length > 10_000) {
    fail('VALIDATION', 'Native collection plan must contain between one and 10,000 approved paths.');
  }
  const seen = new Set<string>();
  let total = 0;
  const paths = input.approvedPaths.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) fail('VALIDATION', `approvedPaths[${index}] must be an object.`);
    const relativePath = assertNativeCollectionRelativePath(entry.relativePath, `approvedPaths[${index}].relativePath`);
    if (seen.has(relativePath)) fail('VALIDATION', `approvedPaths contains duplicate path ${relativePath}.`);
    seen.add(relativePath);
    const mediaType = assertNativeCollectionMediaType(entry.mediaType, `approvedPaths[${index}].mediaType`);
    if (entry.availability !== 'REQUIRED' && entry.availability !== 'OPTIONAL_ON_FAILURE') {
      fail('VALIDATION', `approvedPaths[${index}].availability must be explicit.`);
    }
    const maximumBytes = requirePositiveInteger(entry.maximumBytes, `approvedPaths[${index}].maximumBytes`, maximumFileBytes);
    total += maximumBytes;
    if (!Number.isSafeInteger(total) || total > maximumTotalBytes) {
      fail('VALIDATION', 'Native collection path ceilings exceed maximumTotalBytes.');
    }
    const path = { relativePath, mediaType, availability: entry.availability, maximumBytes } as const;
    return { ...path, pathDigest: digestCanonicalJson(path) };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return { collectorRuntimeDigest, maximumFileBytes, maximumTotalBytes, paths };
}

function assertNativeCollectionCompletion(input: NativeCollectionCompletionInput): NativeCollectionCompletionInput {
  if (typeof input !== 'object' || input === null) fail('VALIDATION', 'Native collection completion is required.');
  const exitCode = input.exitCode;
  if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    fail('VALIDATION', 'Native collection exitCode must be an integer from 0 through 255.');
  }
  const stdoutBytes = input.stdoutBytes;
  if (typeof stdoutBytes !== 'number' || !Number.isSafeInteger(stdoutBytes) || stdoutBytes < 0 || stdoutBytes > 2_147_483_647) {
    fail('VALIDATION', 'Native collection stdoutBytes must be a bounded non-negative integer.');
  }
  return {
    exitCode,
    stdoutDigest: assertDigest(input.stdoutDigest, 'stdoutDigest'),
    stdoutBytes,
  };
}

function maximumNativeAsciiFrameBytes(rawBytes: number): number {
  return 257 + (4 * Math.ceil(rawBytes / 3));
}

function assertNativeWorkspaceIdentity(value: unknown, name: string): string {
  const identity = requireText(value, name, 128);
  if (!NATIVE_WORKSPACE_IDENTITY.test(identity)) fail('VALIDATION', `${name} is not a canonical workspace identity.`);
  return identity;
}

function canonicalNativeBootstrapFrame(workspaceIdentity: string): { stdoutDigest: Digest; stdoutBytes: number } {
  const frame = `MOTIVE_COLLECTOR_BOOTSTRAP_V1\n${workspaceIdentity}\n`;
  return {
    stdoutDigest: `sha256:${createHash('sha256').update(frame, 'utf8').digest('hex')}` as Digest,
    stdoutBytes: Buffer.byteLength(frame, 'utf8'),
  };
}

function assertSafeProfileSnapshot(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', 'profileSnapshot must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('VALIDATION', 'profileSnapshot must be a plain object.');
  const visit = (item: unknown, path: string): void => {
    if (typeof item === 'string') {
      if (SECRET_VALUE.test(item)) fail('VALIDATION', `${path} appears to contain a bearer credential.`);
      return;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof item !== 'object') fail('VALIDATION', `${path} is not JSON-safe.`);
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) fail('VALIDATION', `${path}.${key} is not permitted in a persisted profile snapshot.`);
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value, 'profileSnapshot');
  // Canonicalization rejects cycles, non-finite values, and unsupported JSON.
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function assertSafeEvaluatorLaunchPlan(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', 'evaluator launch plan must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('VALIDATION', 'evaluator launch plan must be a plain object.');
  const visit = (item: unknown, path: string): void => {
    if (typeof item === 'string') {
      if (SECRET_VALUE.test(item)) fail('VALIDATION', `${path} appears to contain a bearer credential.`);
      return;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof item !== 'object') fail('VALIDATION', `${path} is not JSON-safe.`);
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && !(path === 'evaluatorLaunchPlan' && key === 'infrastructureAuthorizationId')) {
        fail('VALIDATION', `${path}.${key} is not permitted in a persisted evaluator launch plan.`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value, 'evaluatorLaunchPlan');
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function assertHandle(value: EnvironmentHandle): EnvironmentHandle {
  if (typeof value !== 'object' || value === null) fail('VALIDATION', 'handle is required.');
  return {
    provider: assertSafeStoredText(value.provider, 'handle.provider', 128),
    externalId: assertSafeStoredText(value.externalId, 'handle.externalId', 512),
    sessionId: assertSafeStoredText(value.sessionId, 'handle.sessionId', 512),
  };
}

function assertObservation(value: ProviderObservation): Required<Pick<ProviderObservation, 'providerStatus' | 'observedAt' | 'state' | 'providerTerminal'>> & Pick<ProviderObservation, 'providerExpiresAt'> {
  if (typeof value !== 'object' || value === null) fail('OBSERVATION_INVALID', 'A provider observation is required.');
  const state = value.state;
  if (!['PROVISIONING', 'ACTIVE', 'STOP_REQUESTED', 'UNKNOWN', 'TERMINATED'].includes(state)) {
    fail('OBSERVATION_INVALID', 'Observation state is not a provider lifecycle state.');
  }
  if ((state === 'TERMINATED') !== (value.providerTerminal === true)) {
    fail('OBSERVATION_INVALID', 'Only a validated provider-terminal observation may mark an environment TERMINATED.');
  }
  return {
    providerStatus: assertSafeStoredText(value.providerStatus, 'observation.providerStatus', 256),
    observedAt: value.observedAt === undefined ? new Date().toISOString() : requireDate(value.observedAt, 'observation.observedAt'),
    state,
    providerTerminal: value.providerTerminal === true,
    ...(value.providerExpiresAt === undefined ? {} : { providerExpiresAt: value.providerExpiresAt === null ? null : requireDate(value.providerExpiresAt, 'observation.providerExpiresAt') }),
  };
}

function leaseProjection(row: QueryResultRow): ControllerLease {
  return {
    attemptId: asString(row, 'attempt_id'),
    ownerId: asString(row, 'owner_id'),
    epoch: asNumber(row, 'epoch'),
    controllerGeneration: asString(row, 'controller_generation'),
    expiresAt: dateOrNull(row.expires_at) ?? (() => { throw new Error('Lease expiry is missing.'); })(),
  };
}

function environmentProjection(row: QueryResultRow): EnvironmentProjection {
  return {
    id: asString(row, 'id'),
    attemptId: nullableString(row, 'attempt_id'),
    sourceId: nullableString(row, 'source_id'),
    grantId: nullableString(row, 'grant_id'),
    kind: asString(row, 'kind') as EnvironmentProjection['kind'],
    state: asString(row, 'state') as EnvironmentState,
    leaseEpoch: nullableNumber(row, 'lease_epoch'),
    controllerGeneration: nullableString(row, 'controller_generation'),
    profileDigest: nullableString(row, 'profile_digest') as Digest | null,
    profileSnapshot: nullableJsonObject(row, 'profile_snapshot'),
    launchPlanDigest: nullableString(row, 'launch_plan_digest') as Digest | null,
    infrastructureAuthorizationId: nullableString(row, 'infrastructure_authorization_id'),
    maximumCostUsd: nullableAmount(row, 'maximum_cost_usd'),
    heldCostUsd: nullableAmount(row, 'held_cost_usd'),
    consumedCostUsd: nullableAmount(row, 'consumed_cost_usd'),
    provider: nullableString(row, 'provider'),
    externalId: nullableString(row, 'external_id'),
    sessionId: nullableString(row, 'session_id'),
    providerStatus: nullableString(row, 'provider_status'),
    providerExpiresAt: dateOrNull(row.provider_expires_at),
    lastObservedAt: dateOrNull(row.last_observed_at),
    terminatedAt: dateOrNull(row.terminated_at),
    orphanReason: nullableString(row, 'orphan_reason'),
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Environment created_at is missing.'); })(),
    updatedAt: dateOrNull(row.updated_at) ?? (() => { throw new Error('Environment updated_at is missing.'); })(),
  };
}

function effectProjection(row: QueryResultRow): EffectIntent {
  return {
    effectId: asString(row, 'id'),
    environmentId: asString(row, 'environment_id'),
    attemptId: nullableString(row, 'attempt_id'),
    kind: asString(row, 'kind') as EffectIntent['kind'],
    state: asString(row, 'state') as EffectIntent['state'],
    claimed: row.claimed_by !== null && row.claimed_by !== undefined,
    commandDigest: nullableString(row, 'command_digest') as Digest | null,
    providerCommandId: nullableString(row, 'provider_command_id'),
    claimedAt: dateOrNull(row.claimed_at),
  };
}

function authorizationProjection(row: QueryResultRow): InfrastructureAuthorizationProjection {
  const limitUsd = asAmount(row, 'limit_usd');
  const heldUsd = asAmount(row, 'held_usd');
  const consumedUsd = asAmount(row, 'consumed_usd');
  const committed = addAmounts(heldUsd, consumedUsd);
  const deficit = compareAmounts(committed, limitUsd) > 0;
  return {
    id: asString(row, 'id'),
    sourceAccountId: asString(row, 'source_account_id'),
    sourceAccountRef: asString(row, 'source_account_ref'),
    actorId: asString(row, 'actor_id'),
    limitUsd,
    heldUsd,
    consumedUsd,
    availableUsd: deficit ? ZERO_AMOUNT : subtractAmounts(limitUsd, committed, 'infrastructure authorization available amount'),
    deficitUsd: deficit ? subtractAmounts(committed, limitUsd, 'infrastructure authorization deficit amount') : ZERO_AMOUNT,
    expiresAt: dateOrNull(row.expires_at) ?? (() => { throw new Error('Infrastructure authorization expiry is missing.'); })(),
    status: asString(row, 'status') as InfrastructureAuthorizationProjection['status'],
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Infrastructure authorization created_at is missing.'); })(),
  };
}

function artifactSealProjection(row: QueryResultRow): ArtifactSealProjection {
  return {
    environmentId: asString(row, 'environment_id'),
    attemptId: asString(row, 'attempt_id'),
    manifestDigest: nullableString(row, 'manifest_digest') as Digest | null,
    receiptId: asString(row, 'receipt_id'),
    status: asString(row, 'status') as ArtifactSealProjection['status'],
    failureCode: nullableString(row, 'failure_code'),
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Artifact seal created_at is missing.'); })(),
  };
}

function nativeCollectionPathProjection(row: QueryResultRow): NativeCollectionFrozenPath {
  return {
    relativePath: asString(row, 'relative_path'),
    pathDigest: asString(row, 'path_digest') as Digest,
    mediaType: asString(row, 'media_type'),
    availability: asString(row, 'availability') as NativeCollectionFrozenPath['availability'],
    maximumBytes: asNumber(row, 'maximum_bytes'),
  };
}

function nativeCollectionPlanProjection(plan: QueryResultRow, paths: readonly QueryResultRow[]): NativeCollectionPlanProjection {
  return {
    environmentId: asString(plan, 'environment_id'),
    attemptId: asString(plan, 'attempt_id'),
    leaseEpoch: asNumber(plan, 'lease_epoch'),
    controllerGeneration: asString(plan, 'controller_generation'),
    profileDigest: asString(plan, 'profile_digest') as Digest,
    executionBoundaryKind: asString(plan, 'execution_boundary_kind') as WorkerExecutionBoundaryKind,
    executionBoundaryDigest: asString(plan, 'execution_boundary_digest') as Digest,
    workerRuntimeDigest: nullableString(plan, 'worker_runtime_digest') as Digest | null,
    collectorRuntimeDigest: asString(plan, 'collector_runtime_digest') as Digest,
    collectionPlanDigest: asString(plan, 'collection_plan_digest') as Digest,
    maximumFileBytes: asNumber(plan, 'maximum_file_bytes'),
    maximumTotalBytes: asNumber(plan, 'maximum_total_bytes'),
    maximumFiles: asNumber(plan, 'maximum_files'),
    maximumHelperCommands: asNumber(plan, 'maximum_helper_commands'),
    paths: paths.map(nativeCollectionPathProjection),
    createdAt: dateOrNull(plan.created_at) ?? (() => { throw new Error('Native collection plan created_at is missing.'); })(),
  };
}

function nativeCollectionEffectProjection(row: QueryResultRow): NativeCollectionEffectProjection {
  return {
    effectId: asString(row, 'id'),
    environmentId: asString(row, 'environment_id'),
    attemptId: asString(row, 'attempt_id'),
    workerCommandEffectId: asString(row, 'worker_command_effect_id'),
    kind: asString(row, 'kind') as NativeCollectionEffectProjection['kind'],
    state: asString(row, 'state') as NativeCollectionEffectProjection['state'],
    effectKey: asString(row, 'effect_key'),
    provider: asString(row, 'provider'),
    externalId: asString(row, 'external_id'),
    sessionId: asString(row, 'session_id'),
    leaseEpoch: asNumber(row, 'lease_epoch'),
    controllerGeneration: asString(row, 'controller_generation'),
    profileDigest: asString(row, 'profile_digest') as Digest,
    workerRuntimeDigest: asString(row, 'worker_runtime_digest') as Digest,
    collectorRuntimeDigest: asString(row, 'collector_runtime_digest') as Digest,
    collectionPlanDigest: asString(row, 'collection_plan_digest') as Digest,
    bootstrapEffectId: nullableString(row, 'bootstrap_effect_id'),
    relativePath: nullableString(row, 'relative_path'),
    pathDigest: nullableString(row, 'path_digest') as Digest | null,
    maximumBytes: nullableNumber(row, 'maximum_bytes'),
    workspaceIdentity: nullableString(row, 'workspace_identity'),
    claimed: row.claimed_by !== null && row.claimed_by !== undefined,
    claimedAt: dateOrNull(row.claimed_at),
    providerCommandId: nullableString(row, 'provider_command_id'),
    exitCode: nullableNumber(row, 'exit_code'),
    stdoutDigest: nullableString(row, 'stdout_digest') as Digest | null,
    stdoutBytes: nullableNumber(row, 'stdout_bytes'),
    unknownReason: nullableString(row, 'unknown_reason'),
    createdAt: dateOrNull(row.created_at) ?? (() => { throw new Error('Native collection effect created_at is missing.'); })(),
    completedAt: dateOrNull(row.completed_at),
  };
}

function outboxMessage(row: QueryResultRow, deliveryAttempts: number): DeliveryClaim['message'] {
  return {
    id: asString(row, 'id'),
    eventId: asString(row, 'event_id'),
    aggregateType: asString(row, 'aggregate_type'),
    aggregateId: asString(row, 'aggregate_id'),
    topic: asString(row, 'topic'),
    dedupeKey: asString(row, 'dedupe_key'),
    payload: row.payload,
    deliveryAttempts,
  };
}

export class PostgresOrchestrationStore implements OrchestrationStore {
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

  /** Keep the identical controller -> source -> grant -> attempt lock order as accounting. */
  private async lockAttemptChain(client: PoolClient, attemptId: string): Promise<Chain> {
    const controller = await this.lockController(client);
    const reference = await client.query<{ source_id: string; grant_id: string }>(
      'SELECT source_id, grant_id FROM motive.attempts WHERE id = $1',
      [requireUuid(attemptId, 'attemptId')],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Attempt was not found.');
    const source = await this.lockSource(client, reference.rows[0].source_id);
    const grant = await this.lockGrant(client, reference.rows[0].grant_id);
    const attempt = await this.lockAttempt(client, attemptId);
    return { controller, source, grant, attempt };
  }

  private async lockLease(client: PoolClient, attemptId: string): Promise<QueryResultRow | null> {
    const result = await client.query('SELECT * FROM motive.orchestration_leases WHERE attempt_id = $1 FOR UPDATE', [attemptId]);
    return result.rowCount === 0 ? null : result.rows[0];
  }

  private async lockAuthorization(client: PoolClient, authorizationId: string): Promise<QueryResultRow> {
    const result = await client.query(
      'SELECT * FROM motive.infrastructure_authorizations WHERE id = $1 FOR UPDATE',
      [requireUuid(authorizationId, 'infrastructureAuthorizationId')],
    );
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Infrastructure authorization was not found.');
    return result.rows[0];
  }

  private async lockCapacity(client: PoolClient): Promise<QueryResultRow> {
    const result = await client.query('SELECT * FROM motive.orchestration_capacity WHERE singleton = TRUE FOR UPDATE');
    if (result.rowCount !== 1) throw new Error('Orchestration capacity singleton is missing.');
    return result.rows[0];
  }

  private async now(client: PoolClient): Promise<number> {
    const result = await client.query('SELECT clock_timestamp() AS database_now');
    if (result.rowCount !== 1) throw new Error('Database clock query failed.');
    const stamp = dateOrNull(result.rows[0].database_now);
    if (stamp === null) throw new Error('Database clock query returned no timestamp.');
    return Date.parse(stamp);
  }

  private ensureSourceOpen(source: QueryResultRow, now: number): void {
    if (asString(source, 'status') !== 'ACTIVE') fail('SOURCE_UNAVAILABLE', 'Funding source is not active for new orchestration work.');
    const expiresAt = dateOrNull(source.expires_at);
    if (expiresAt !== null && Date.parse(expiresAt) <= now) fail('SOURCE_UNAVAILABLE', 'Funding source has expired.');
  }

  private ensureGrantOpen(grant: QueryResultRow, now: number): void {
    if (asString(grant, 'status') !== 'ACTIVE' || grant.admission_closed_at !== null) {
      fail('GRANT_UNAVAILABLE', 'Grant is not open for new orchestration work.');
    }
    const expiresAt = dateOrNull(grant.expires_at);
    if (expiresAt !== null && Date.parse(expiresAt) <= now) fail('GRANT_UNAVAILABLE', 'Grant has expired.');
  }

  private ensureFreshEffectAuthority(chain: Chain, now: number): void {
    if (!asBoolean(chain.controller, 'spending_enabled')) {
      fail('CONTROLLER_FROZEN', 'Controller spending is disabled; no new provider effect may be claimed.');
    }
    if (asString(chain.attempt, 'controller_generation') !== asString(chain.controller, 'generation')) {
      fail('LEASE_FENCED', 'Attempt belongs to an older controller generation; new effects require explicit recovery authorization.');
    }
    this.ensureSourceOpen(chain.source, now);
    this.ensureGrantOpen(chain.grant, now);
    if (chain.attempt.admission_closed_at !== null || chain.attempt.cancellation_requested_at !== null) {
      fail('ATTEMPT_UNAVAILABLE', 'Attempt has a durable cancellation or admission-closed boundary.');
    }
    if (!LIVE_ATTEMPT_STATES.has(asString(chain.attempt, 'execution_status'))) {
      fail('ATTEMPT_UNAVAILABLE', 'Attempt cannot start a new provider effect in its current status.');
    }
  }

  /** A command may run only in the phase owned by its environment kind. */
  private ensureCommandPhase(chain: Chain, environment: QueryResultRow): void {
    const kind = asString(environment, 'kind');
    const executionStatus = asString(chain.attempt, 'execution_status');
    const requiredStatus = kind === 'WORKER' ? 'RUNNING' : kind === 'EVALUATOR' ? 'EVALUATING' : null;
    if (requiredStatus === null || executionStatus !== requiredStatus) {
      fail('ATTEMPT_UNAVAILABLE', 'A command cannot start outside its environment execution phase.');
    }
  }

  /**
   * A new paid effect is tied to the controller lease that admitted the
   * environment. A later lease may observe, settle, seal, or stop that older
   * environment, but must not turn its old intent into a new provider call.
   */
  private ensureEnvironmentLaunchAuthority(environment: QueryResultRow, lease: ControllerLease): void {
    if (nullableNumber(environment, 'lease_epoch') !== requirePositiveInteger(lease.epoch, 'lease.epoch')
      || nullableString(environment, 'controller_generation') !== requireText(lease.controllerGeneration, 'lease.controllerGeneration', 64)) {
      fail('LEASE_FENCED', 'Environment was admitted by an older lease or controller generation; only cleanup is permitted.');
    }
  }

  private async assertCurrentLease(client: PoolClient, chain: Chain, lease: ControllerLease): Promise<QueryResultRow> {
    const attemptId = requireUuid(lease.attemptId, 'lease.attemptId');
    if (attemptId !== asString(chain.attempt, 'id')) fail('LEASE_FENCED', 'Lease belongs to a different attempt.');
    const ownerId = requireText(lease.ownerId, 'lease.ownerId', 512);
    const epoch = requirePositiveInteger(lease.epoch, 'lease.epoch');
    const persisted = await this.lockLease(client, attemptId);
    if (persisted === null
      || asString(persisted, 'owner_id') !== ownerId
      || asNumber(persisted, 'epoch') !== epoch
      || asNumber(chain.attempt, 'lease_epoch') !== epoch
      || asString(persisted, 'controller_generation') !== asString(chain.attempt, 'controller_generation')
      || requireText(lease.controllerGeneration, 'lease.controllerGeneration', 64) !== asString(persisted, 'controller_generation')) {
      fail('LEASE_FENCED', 'Lease owner or epoch is stale.');
    }
    const now = await this.now(client);
    const expiresAt = dateOrNull(persisted.expires_at);
    if (expiresAt === null || Date.parse(expiresAt) <= now) fail('LEASE_FENCED', 'Lease has expired and must be reacquired.');
    return persisted;
  }

  private async lockTrackedEnvironment(
    client: PoolClient,
    environmentId: string,
    lockAuthorization = false,
  ): Promise<TrackedEnvironmentContext> {
    const id = requireUuid(environmentId, 'environmentId');
    const reference = await client.query<{ attempt_id: string | null; infrastructure_authorization_id: string | null }>(
      'SELECT attempt_id, infrastructure_authorization_id FROM motive.orchestration_environments WHERE id = $1', [id],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Environment was not found.');
    const attemptId = reference.rows[0].attempt_id;
    if (attemptId === null) fail('ENVIRONMENT_UNAVAILABLE', 'This is an orphan environment and requires the orphan reconciliation boundary.');
    const chain = await this.lockAttemptChain(client, attemptId);
    let authorization: QueryResultRow | undefined;
    if (lockAuthorization) {
      const authorizationId = reference.rows[0].infrastructure_authorization_id;
      if (authorizationId === null) throw new Error('Tracked environment has no infrastructure authorization.');
      authorization = await this.lockAuthorization(client, authorizationId);
    }
    const result = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1 FOR UPDATE', [id]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Environment was not found.');
    return { chain, environment: result.rows[0], authorization };
  }

  private async lockTrackedEffect(
    client: PoolClient,
    effectId: string,
    lockAuthorization = false,
  ): Promise<TrackedEffectContext> {
    const id = requireUuid(effectId, 'effectId');
    const reference = await client.query<{ environment_id: string; attempt_id: string | null }>(
      'SELECT environment_id, attempt_id FROM motive.orchestration_effects WHERE id = $1', [id],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Effect was not found.');
    if (reference.rows[0].attempt_id === null) fail('EFFECT_UNAVAILABLE', 'This is an orphan effect and requires orphan reconciliation.');
    const context = await this.lockTrackedEnvironment(client, reference.rows[0].environment_id, lockAuthorization);
    const effect = await client.query('SELECT * FROM motive.orchestration_effects WHERE id = $1 FOR UPDATE', [id]);
    if (effect.rowCount !== 1) fail('NOT_FOUND', 'Effect was not found.');
    if (asString(effect.rows[0], 'attempt_id') !== asString(context.chain.attempt, 'id')) {
      throw new Error('Effect does not match its environment attempt.');
    }
    return { ...context, effect: effect.rows[0] };
  }

  private async lockNativeCollectionPlan(
    client: PoolClient,
    environmentId: string,
    lockAuthorization = false,
  ): Promise<NativeCollectionPlanContext> {
    const context = await this.lockTrackedEnvironment(client, environmentId, lockAuthorization);
    const plan = await client.query('SELECT * FROM motive.native_collection_plans WHERE environment_id = $1 FOR UPDATE', [environmentId]);
    if (plan.rowCount !== 1) fail('EFFECT_UNAVAILABLE', 'The worker has no frozen native collection plan.');
    if (asString(plan.rows[0], 'attempt_id') !== asString(context.chain.attempt, 'id')
      || asString(plan.rows[0], 'environment_id') !== asString(context.environment, 'id')) {
      throw new Error('Native collection plan does not match its tracked worker.');
    }
    return { ...context, plan: plan.rows[0] };
  }

  private async lockNativeCollectionEffect(
    client: PoolClient,
    effectId: string,
    lockAuthorization = false,
  ): Promise<NativeCollectionEffectContext> {
    const id = requireUuid(effectId, 'effectId');
    const reference = await client.query<{ environment_id: string; attempt_id: string }>(
      'SELECT environment_id, attempt_id FROM motive.native_collection_effects WHERE id = $1', [id],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Native collection effect was not found.');
    const context = await this.lockNativeCollectionPlan(client, reference.rows[0].environment_id, lockAuthorization);
    this.assertNativeHelperBoundary(context);
    const effect = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1 FOR UPDATE', [id]);
    if (effect.rowCount !== 1) fail('NOT_FOUND', 'Native collection effect was not found.');
    if (asString(effect.rows[0], 'attempt_id') !== asString(context.chain.attempt, 'id')
      || asString(effect.rows[0], 'environment_id') !== asString(context.environment, 'id')) {
      throw new Error('Native collection effect does not match its tracked worker.');
    }
    return { ...context, effect: effect.rows[0] };
  }

  private async loadNativeCollectionPlanProjection(
    client: PoolClient,
    plan: QueryResultRow,
  ): Promise<NativeCollectionPlanProjection> {
    const paths = await client.query(
      'SELECT * FROM motive.native_collection_plan_paths WHERE environment_id = $1 ORDER BY ordinal',
      [asString(plan, 'environment_id')],
    );
    if (paths.rowCount !== asNumber(plan, 'path_count')) {
      throw new Error('Native collection plan path set is incomplete.');
    }
    return nativeCollectionPlanProjection(plan, paths.rows);
  }

  private nativeCollectionProfile(environment: QueryResultRow): {
    profile: SandboxExecutionProfile;
    executionBoundaryKind: WorkerExecutionBoundaryKind;
    executionBoundaryDigest: Digest;
    workerRuntimeDigest: Digest | null;
  } {
    const raw = environment.profile_snapshot;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('ENVIRONMENT_UNAVAILABLE', 'Native collection requires a frozen sandbox profile.');
    }
    const profile = raw as SandboxExecutionProfile;
    try {
      validateProfile(profile);
      const boundary = requireWorkerExecutionBoundary(profile);
      if (profile.profileDigest !== nullableString(environment, 'profile_digest')) {
        fail('ENVIRONMENT_UNAVAILABLE', 'Native collection profile does not match the environment identity.');
      }
      return {
        profile,
        executionBoundaryKind: boundary.kind === 'protected-runtime'
          ? 'PROTECTED_RUNTIME' : 'PROVIDER_UNTRUSTED_CIRCLE_DATA',
        executionBoundaryDigest: boundary.runtimeDigest,
        workerRuntimeDigest: boundary.kind === 'protected-runtime' ? boundary.runtimeDigest : null,
      };
    } catch (error) {
      if (error instanceof OrchestrationStoreError) throw error;
      fail('ENVIRONMENT_UNAVAILABLE', 'Collection requires one reviewed worker execution boundary.');
    }
  }

  private assertNativeHelperBoundary(context: NativeCollectionPlanContext): void {
    this.assertFrozenNativeCollectionPlan(context);
    if (asString(context.plan, 'execution_boundary_kind') !== 'PROTECTED_RUNTIME'
        || nullableString(context.plan, 'worker_runtime_digest') === null) {
      fail('EFFECT_UNAVAILABLE', 'Provider-session collection cannot use native helper or workspace-binding effects.');
    }
  }

  private assertFrozenNativeCollectionPlan(context: NativeCollectionPlanContext): void {
    const { environment, plan } = context;
    const profile = this.nativeCollectionProfile(environment);
    if (asString(plan, 'attempt_id') !== asString(environment, 'attempt_id')
      || asNumber(plan, 'lease_epoch') !== nullableNumber(environment, 'lease_epoch')
      || asString(plan, 'controller_generation') !== nullableString(environment, 'controller_generation')
      || asString(plan, 'profile_digest') !== nullableString(environment, 'profile_digest')
      || asString(plan, 'execution_boundary_kind') !== profile.executionBoundaryKind
      || asString(plan, 'execution_boundary_digest') !== profile.executionBoundaryDigest
      || nullableString(plan, 'worker_runtime_digest') !== profile.workerRuntimeDigest
      || asNumber(plan, 'maximum_files') !== profile.profile.artifacts.maxFiles
      || asNumber(plan, 'maximum_file_bytes') > profile.profile.artifacts.maxFileBytes
      || asNumber(plan, 'maximum_file_bytes') > NATIVE_COLLECTION_MAX_FILE_BYTES
      || asNumber(plan, 'maximum_total_bytes') > profile.profile.artifacts.maxTotalBytes) {
      throw new Error('Frozen native collection plan does not match the worker identity or profile bounds.');
    }
  }

  private async exactNativeWorkerCommand(
    client: PoolClient,
    context: NativeCollectionPlanContext,
  ): Promise<QueryResultRow> {
    const command = await client.query(
      `SELECT * FROM motive.orchestration_effects
       WHERE environment_id = $1 AND attempt_id = $2 AND kind = 'COMMAND'
         AND claimed_lease_epoch = $3 AND state IN ('CLAIMED', 'RESULT_RECORDED', 'UNKNOWN')
       FOR UPDATE`,
      [asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), asNumber(context.plan, 'lease_epoch')],
    );
    if (command.rowCount !== 1) {
      fail('EFFECT_UNAVAILABLE', 'Native collection requires the exact claimed worker command.');
    }
    return command.rows[0];
  }

  private async ensureFreshNativeCollectionDispatch(
    client: PoolClient,
    context: NativeCollectionPlanContext,
    lease: ControllerLease,
  ): Promise<QueryResultRow> {
    this.assertFrozenNativeCollectionPlan(context);
    this.ensureEnvironmentLaunchAuthority(context.environment, lease);
    const now = await this.now(client);
    this.ensureFreshEffectAuthority(context.chain, now);
    if (context.authorization === undefined) throw new Error('Native collection worker lacks an infrastructure authorization.');
    this.assertAuthorizationOpen(context.authorization, context.chain, now);
    if (asString(context.environment, 'kind') !== 'WORKER'
      || asString(context.environment, 'state') !== 'ACTIVE'
      || nullableString(context.environment, 'provider') !== 'vercel'
      || nullableString(context.environment, 'external_id') === null
      || nullableString(context.environment, 'session_id') === null
      || asString(context.chain.attempt, 'execution_status') !== 'RUNNING') {
      fail('ENVIRONMENT_UNAVAILABLE', 'Native collection requires the exact active running worker session.');
    }
    return this.exactNativeWorkerCommand(client, context);
  }

  private async frozenNativeBindingForCapture(
    client: PoolClient,
    context: NativeCollectionPlanContext,
    workerCommand: QueryResultRow,
  ): Promise<QueryResultRow> {
    const binding = await client.query(
      'SELECT * FROM motive.native_workspace_bindings WHERE environment_id = $1 FOR UPDATE',
      [asString(context.environment, 'id')],
    );
    if (binding.rowCount !== 1 || binding.rows[0].bootstrap_effect_id === null || binding.rows[0].bootstrap_effect_id === undefined) {
      fail('EFFECT_UNAVAILABLE', 'Native capture requires helper-provenance bootstrap binding, not a legacy local binding.');
    }
    const row = binding.rows[0];
    if (asString(row, 'attempt_id') !== asString(context.chain.attempt, 'id')
      || asNumber(row, 'lease_epoch') !== asNumber(context.plan, 'lease_epoch')
      || asString(row, 'controller_generation') !== asString(context.plan, 'controller_generation')
      || asString(row, 'profile_digest') !== asString(context.plan, 'profile_digest')
      || asString(row, 'worker_runtime_digest') !== asString(context.plan, 'worker_runtime_digest')
      || asString(row, 'collector_runtime_digest') !== asString(context.plan, 'collector_runtime_digest')) {
      throw new Error('Native bootstrap binding does not match the frozen collection plan.');
    }
    const bootstrap = await client.query(
      `SELECT * FROM motive.native_collection_effects WHERE id = $1 FOR UPDATE`, [asString(row, 'bootstrap_effect_id')],
    );
    if (bootstrap.rowCount !== 1
      || asString(bootstrap.rows[0], 'kind') !== 'BOOTSTRAP'
      || asString(bootstrap.rows[0], 'state') !== 'COMPLETED'
      || asString(bootstrap.rows[0], 'worker_command_effect_id') !== asString(workerCommand, 'id')) {
      throw new Error('Native bootstrap binding references an invalid helper effect.');
    }
    return row;
  }

  private assertNativeCollectionEffectMatches(
    context: NativeCollectionPlanContext,
    effect: QueryResultRow,
    workerCommand: QueryResultRow,
  ): void {
    const environment = context.environment;
    const plan = context.plan;
    if (asString(effect, 'environment_id') !== asString(environment, 'id')
      || asString(effect, 'attempt_id') !== asString(context.chain.attempt, 'id')
      || asString(effect, 'worker_command_effect_id') !== asString(workerCommand, 'id')
      || asString(effect, 'provider') !== nullableString(environment, 'provider')
      || asString(effect, 'external_id') !== nullableString(environment, 'external_id')
      || asString(effect, 'session_id') !== nullableString(environment, 'session_id')
      || asNumber(effect, 'lease_epoch') !== asNumber(plan, 'lease_epoch')
      || asString(effect, 'controller_generation') !== asString(plan, 'controller_generation')
      || asString(effect, 'profile_digest') !== asString(plan, 'profile_digest')
      || asString(effect, 'worker_runtime_digest') !== asString(plan, 'worker_runtime_digest')
      || asString(effect, 'collector_runtime_digest') !== asString(plan, 'collector_runtime_digest')
      || asString(effect, 'collection_plan_digest') !== asString(plan, 'collection_plan_digest')) {
      throw new Error('Native collection effect does not match its exact frozen worker identity.');
    }
  }

  private assertNativeCollectionCompletionBounds(
    effect: QueryResultRow,
    completion: NativeCollectionCompletionInput,
  ): void {
    const kind = asString(effect, 'kind');
    const maximum = kind === 'BOOTSTRAP'
      ? 256
      : kind === 'CAPTURE'
        ? maximumNativeAsciiFrameBytes(asNumber(effect, 'maximum_bytes'))
        : (() => { throw new Error('Unexpected native collection effect kind.'); })();
    if (completion.stdoutBytes > maximum) {
      fail('VALIDATION', 'Native collection stdout metadata exceeds its exact ASCII transport bound.');
    }
  }

  private assertAuthorizationOpen(authorization: QueryResultRow, chain: Chain, now: number): void {
    if (asString(authorization, 'source_account_id') !== asString(chain.source, 'id')) {
      fail('INFRA_AUTHORIZATION_UNAVAILABLE', 'Infrastructure authorization belongs to a different source account.');
    }
    if (asString(authorization, 'status') !== 'ACTIVE') {
      fail('INFRA_AUTHORIZATION_UNAVAILABLE', 'Infrastructure authorization is not active.');
    }
    const expiresAt = dateOrNull(authorization.expires_at);
    if (expiresAt === null || Date.parse(expiresAt) <= now) {
      fail('INFRA_AUTHORIZATION_UNAVAILABLE', 'Infrastructure authorization has expired.');
    }
  }

  /**
   * A caller that made the one remote request may still persist its outcome
   * after its lease has expired, but only for that exact attempt identity.
   * Checking just owner + epoch would let a process-wide owner reuse a lease
   * from a different attempt that happens to share epoch one.
   */
  private assertHistoricalClaim(chain: Chain, effect: QueryResultRow, lease: ControllerLease): void {
    if (requireUuid(lease.attemptId, 'lease.attemptId') !== asString(chain.attempt, 'id')
      || requireText(lease.controllerGeneration, 'lease.controllerGeneration', 64) !== asString(chain.attempt, 'controller_generation')
      || asString(effect, 'claimed_by') !== requireText(lease.ownerId, 'lease.ownerId', 512)
      || asNumber(effect, 'claimed_lease_epoch') !== requirePositiveInteger(lease.epoch, 'lease.epoch')) {
      fail('LEASE_FENCED', 'Effect was claimed by another lease epoch.');
    }
  }

  private async decrementCapacityAfterTerminal(client: PoolClient): Promise<void> {
    const capacity = await this.lockCapacity(client);
    const occupied = asNumber(capacity, 'occupied_count');
    if (occupied <= 0) throw new Error('Physical capacity counter underflow.');
    await client.query(
      'UPDATE motive.orchestration_capacity SET occupied_count = occupied_count - 1, updated_at = clock_timestamp() WHERE singleton = TRUE',
    );
  }

  private async applyObservation(
    client: PoolClient,
    environment: QueryResultRow,
    observation: ReturnType<typeof assertObservation>,
  ): Promise<EnvironmentProjection> {
    const currentState = asString(environment, 'state') as EnvironmentState;
    if (currentState === 'TERMINATED' && observation.state !== 'TERMINATED') {
      fail('OBSERVATION_INVALID', 'A terminal environment cannot be revived by a later observation.');
    }
    let nextState: EnvironmentState = observation.state;
    // A provider that is still starting or running after a submitted stop is
    // evidence that it has not stopped yet, not evidence that the durable stop
    // request disappeared. Keep it eligible for immediate reconciliation.
    if (currentState === 'STOP_REQUESTED' && ['PROVISIONING', 'ACTIVE'].includes(nextState)) {
      nextState = 'STOP_REQUESTED';
    }
    if (nextState === 'TERMINATED' && currentState !== 'TERMINATED') await this.decrementCapacityAfterTerminal(client);
    await client.query(
      `UPDATE motive.orchestration_environments
       SET state = $2, provider_status = $3, provider_expires_at = $4,
           last_observed_at = $5, terminated_at = CASE WHEN $2 = 'TERMINATED'::motive.orchestration_environment_status
             THEN COALESCE(terminated_at, $5) ELSE NULL END,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [
        asString(environment, 'id'), nextState, observation.providerStatus,
        observation.providerExpiresAt ?? null, observation.observedAt,
      ],
    );
    const updated = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1', [asString(environment, 'id')]);
    if (updated.rowCount !== 1) throw new Error('Environment vanished after observation.');
    return environmentProjection(updated.rows[0]);
  }

  async acquireLease(attemptId: string, ownerId: string, ttlSeconds: number): Promise<ControllerLease> {
    const id = requireUuid(attemptId, 'attemptId');
    const owner = requireText(ownerId, 'ownerId', 512);
    const ttl = requirePositiveInteger(ttlSeconds, 'ttlSeconds', 24 * 60 * 60);
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, id);
      const existing = await this.lockLease(client, id);
      const now = await this.now(client);
      let epoch = asNumber(chain.attempt, 'lease_epoch');
      if (existing === null) {
        await client.query(
          `INSERT INTO motive.orchestration_leases (attempt_id, owner_id, epoch, controller_generation, expires_at)
           VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * INTERVAL '1 second'))`,
          [id, owner, epoch, asString(chain.attempt, 'controller_generation'), ttl],
        );
      } else {
        const expiry = dateOrNull(existing.expires_at);
        const ownershipChanged = asString(existing, 'owner_id') !== owner;
        const expired = expiry === null || Date.parse(expiry) <= now;
        if (ownershipChanged && !expired) {
          fail('LEASE_HELD', 'Attempt is still controlled by a live lease owner; retry after expiry or use an explicit recovery procedure.');
        }
        if (expired) {
          epoch += 1;
          await client.query(
            `UPDATE motive.attempts SET lease_epoch = $2, updated_at = clock_timestamp() WHERE id = $1`,
            [id, epoch],
          );
          await client.query(
            `UPDATE motive.orchestration_leases
             SET owner_id = $2, epoch = $3, controller_generation = $4,
                 expires_at = clock_timestamp() + ($5 * INTERVAL '1 second'),
                 acquired_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE attempt_id = $1`,
            [id, owner, epoch, asString(chain.attempt, 'controller_generation'), ttl],
          );
        }
      }
      const current = await client.query('SELECT * FROM motive.orchestration_leases WHERE attempt_id = $1', [id]);
      if (current.rowCount !== 1) throw new Error('Lease was not persisted.');
      return leaseProjection(current.rows[0]);
    });
  }

  async heartbeat(lease: ControllerLease, ttlSeconds: number): Promise<ControllerLease> {
    const ttl = requirePositiveInteger(ttlSeconds, 'ttlSeconds', 24 * 60 * 60);
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, requireUuid(lease.attemptId, 'lease.attemptId'));
      await this.assertCurrentLease(client, chain, lease);
      await client.query(
        `UPDATE motive.orchestration_leases
         SET expires_at = clock_timestamp() + ($3 * INTERVAL '1 second'), updated_at = clock_timestamp()
         WHERE attempt_id = $1 AND owner_id = $2`,
        [lease.attemptId, lease.ownerId, ttl],
      );
      const current = await client.query('SELECT * FROM motive.orchestration_leases WHERE attempt_id = $1', [lease.attemptId]);
      if (current.rowCount !== 1) throw new Error('Lease vanished during heartbeat.');
      return leaseProjection(current.rows[0]);
    });
  }

  async createInfrastructureAuthorization(input: CreateInfrastructureAuthorizationInput): Promise<InfrastructureAuthorizationProjection> {
    const id = requireUuid(input.id, 'infrastructureAuthorization.id');
    const sourceAccountId = requireUuid(input.sourceAccountId, 'sourceAccountId');
    const sourceAccountRef = assertSafeStoredText(input.sourceAccountRef, 'sourceAccountRef', 512);
    const actorId = requireText(input.actorId, 'actorId', 512);
    const limitUsd = positiveAmount(input.limitUsd, 'limitUsd');
    const expiresAt = requireDate(input.expiresAt, 'expiresAt');
    return this.transaction(async client => {
      const controller = await this.lockController(client);
      if (!asBoolean(controller, 'spending_enabled')) fail('CONTROLLER_FROZEN', 'Controller spending is disabled.');
      const source = await this.lockSource(client, sourceAccountId);
      const now = await this.now(client);
      this.ensureSourceOpen(source, now);
      if (![asString(source, 'owner_actor_id'), asString(source, 'controller_actor_id')].includes(actorId)) {
        fail('SOURCE_UNAVAILABLE', 'Only the source owner or controller may authorize infrastructure spending.');
      }
      if (Date.parse(expiresAt) <= now) fail('VALIDATION', 'Infrastructure authorization expiry must be in the future.');
      const existing = await client.query('SELECT * FROM motive.infrastructure_authorizations WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (asString(row, 'source_account_id') !== sourceAccountId
          || asString(row, 'source_account_ref') !== sourceAccountRef
          || asString(row, 'actor_id') !== actorId
          || asAmount(row, 'limit_usd') !== limitUsd
          || dateOrNull(row.expires_at) !== expiresAt) {
          fail('EFFECT_CONFLICT', 'Infrastructure authorization ID was already used for different terms.');
        }
        return authorizationProjection(row);
      }
      await client.query(
        `INSERT INTO motive.infrastructure_authorizations
          (id, source_account_id, source_account_ref, actor_id, limit_usd, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, sourceAccountId, sourceAccountRef, actorId, limitUsd, expiresAt],
      );
      const inserted = await client.query('SELECT * FROM motive.infrastructure_authorizations WHERE id = $1', [id]);
      return authorizationProjection(inserted.rows[0]);
    });
  }

  async reserveEnvironment(lease: ControllerLease, input: ReserveEnvironmentInput): Promise<{
    environment: EnvironmentProjection;
    effect: EffectIntent;
  }> {
    const kind = input.kind;
    if (kind !== 'WORKER' && kind !== 'EVALUATOR') fail('VALIDATION', 'Environment kind must be WORKER or EVALUATOR.');
    const profileDigest = assertDigest(input.profileDigest, 'profileDigest');
    const profileSnapshot = assertSafeProfileSnapshot(input.profileSnapshot);
    const launchPlanDigest = assertDigest(input.launchPlanDigest, 'launchPlanDigest');
    const authorizationId = requireUuid(input.infrastructureAuthorizationId, 'infrastructureAuthorizationId');
    const maximumCostUsd = positiveAmount(input.maximumCostUsd, 'maximumCostUsd');
    return this.transaction(async client => {
      const chain = await this.lockAttemptChain(client, requireUuid(lease.attemptId, 'lease.attemptId'));
      await this.assertCurrentLease(client, chain, lease);
      const now = await this.now(client);
      this.ensureFreshEffectAuthority(chain, now);
      if (kind === 'EVALUATOR') {
        const workOrder = await client.query(
          `SELECT terms, terms_digest FROM motive.work_orders
           WHERE id = $1 AND project_id = $2 AND terms_digest = $3
           FOR KEY SHARE`,
          [asString(chain.attempt, 'work_order_id'), asString(chain.attempt, 'project_id'), asString(chain.attempt, 'terms_digest')],
        );
        if (workOrder.rowCount !== 1) {
          fail('ATTEMPT_UNAVAILABLE', 'Evaluator reservation does not resolve to the attempt\'s immutable work-order terms.');
        }
        try {
          const terms = validateWorkOrderTerms(workOrder.rows[0].terms);
          if (digestCanonicalJson(terms) !== asString(workOrder.rows[0], 'terms_digest')
            || terms.evaluation.profile_digest !== profileDigest) {
            fail('ATTEMPT_UNAVAILABLE', 'Evaluator profile does not match the immutable work-order terms.');
          }
        } catch (error) {
          if (error instanceof OrchestrationStoreError) throw error;
          if (error instanceof DomainValidationError) {
            fail('ATTEMPT_UNAVAILABLE', 'Evaluator reservation has invalid immutable work-order terms.');
          }
          throw error;
        }
      }
      const authorization = await this.lockAuthorization(client, authorizationId);
      this.assertAuthorizationOpen(authorization, chain, now);

      const prior = await client.query(
        `SELECT environment.*, effect.id AS effect_id, effect.kind AS effect_kind, effect.effect_key,
                effect.command_digest, effect.state AS effect_state, effect.claimed_by, effect.claimed_at,
                command.provider_command_id
         FROM motive.orchestration_environments AS environment
         JOIN motive.orchestration_effects AS effect ON effect.environment_id = environment.id AND effect.kind = 'CREATE'
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE environment.attempt_id = $1 AND environment.kind = $2 AND environment.lease_epoch = $3
         FOR UPDATE OF environment, effect`,
        [asString(chain.attempt, 'id'), kind, lease.epoch],
      );
      if (prior.rowCount === 1) {
        const row = prior.rows[0];
        if (asString(row, 'profile_digest') !== profileDigest
          || asString(row, 'launch_plan_digest') !== launchPlanDigest
          || asString(row, 'infrastructure_authorization_id') !== authorizationId
          || asAmount(row, 'maximum_cost_usd') !== maximumCostUsd
          || canonicalJson(nullableJsonObject(row, 'profile_snapshot')) !== canonicalJson(profileSnapshot)) {
          fail('EFFECT_CONFLICT', 'This lease already has a durable environment intent with different terms.');
        }
        return {
          environment: environmentProjection(row),
          effect: effectProjection({
            ...row,
            id: row.effect_id,
            environment_id: row.id,
            kind: row.effect_kind,
            state: row.effect_state,
          }),
        };
      }

      if (kind === 'WORKER' && !['RESERVED', 'PROVISIONING', 'RUNNING'].includes(asString(chain.attempt, 'execution_status'))) {
        fail('ATTEMPT_UNAVAILABLE', 'A worker may only be reserved during the worker phase.');
      }
      if (kind === 'EVALUATOR' && !['OUTPUT_SEALED', 'EVALUATING'].includes(asString(chain.attempt, 'execution_status'))) {
        fail('ATTEMPT_UNAVAILABLE', 'An evaluator requires a sealed worker output.');
      }

      const available = subtractAmounts(
        subtractAmounts(asAmount(authorization, 'limit_usd'), asAmount(authorization, 'held_usd'), 'infrastructure authorization availability'),
        asAmount(authorization, 'consumed_usd'),
        'infrastructure authorization availability',
      );
      if (compareAmounts(available, maximumCostUsd) < 0) {
        fail('INFRA_CAPACITY_EXHAUSTED', 'Infrastructure authorization has insufficient unreserved capacity.');
      }
      const capacity = await this.lockCapacity(client);
      if (asNumber(capacity, 'occupied_count') >= asNumber(capacity, 'maximum_environments')) {
        fail('PHYSICAL_CAPACITY_EXHAUSTED', 'The global physical environment limit is occupied by active, uncertain, or orphaned environments.');
      }

      const environmentId = randomUUID();
      const effectId = randomUUID();
      await client.query(
        `INSERT INTO motive.orchestration_environments (
          id, attempt_id, source_id, grant_id, kind, lease_epoch, controller_generation, state,
          profile_digest, profile_snapshot, launch_plan_digest, infrastructure_authorization_id,
          maximum_cost_usd, held_cost_usd, consumed_cost_usd
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', $8, $9::jsonb, $10, $11, $12, $12, $13)`,
        [
          environmentId, asString(chain.attempt, 'id'), asString(chain.source, 'id'), asString(chain.grant, 'id'),
          kind, lease.epoch, asString(chain.attempt, 'controller_generation'), profileDigest,
          JSON.stringify(profileSnapshot), launchPlanDigest, authorizationId, maximumCostUsd, ZERO_AMOUNT,
        ],
      );
      await client.query(
        `INSERT INTO motive.orchestration_effects (id, environment_id, attempt_id, kind, effect_key)
         VALUES ($1, $2, $3, 'CREATE', $4)`,
        [effectId, environmentId, asString(chain.attempt, 'id'), `create:${environmentId}`],
      );
      await client.query(
        `UPDATE motive.infrastructure_authorizations
         SET held_usd = held_usd + $2, updated_at = clock_timestamp() WHERE id = $1`,
        [authorizationId, maximumCostUsd],
      );
      await client.query(
        'UPDATE motive.orchestration_capacity SET occupied_count = occupied_count + 1, updated_at = clock_timestamp() WHERE singleton = TRUE',
      );
      if (kind === 'WORKER') {
        await client.query(
          `UPDATE motive.attempts
           SET execution_status = CASE WHEN execution_status = 'RESERVED' THEN 'PROVISIONING'::motive.attempt_execution_status ELSE execution_status END,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [asString(chain.attempt, 'id')],
        );
      } else {
        await client.query(
          `UPDATE motive.attempts
           SET execution_status = CASE WHEN execution_status = 'OUTPUT_SEALED' THEN 'EVALUATING'::motive.attempt_execution_status ELSE execution_status END,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [asString(chain.attempt, 'id')],
        );
      }
      const environment = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1', [environmentId]);
      const effect = await client.query(
        `SELECT effect.*, command.provider_command_id
         FROM motive.orchestration_effects AS effect
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE effect.id = $1`,
        [effectId],
      );
      return { environment: environmentProjection(environment.rows[0]), effect: effectProjection(effect.rows[0]) };
    });
  }

  async freezeEvaluatorLaunchPlan(
    lease: ControllerLease,
    environmentId: string,
    plan: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const frozen = assertSafeEvaluatorLaunchPlan(plan);
    const planDigest = digestCanonicalJson(frozen);
    const profileDigest = assertDigest(frozen.evaluatorProfileDigest, 'plan.evaluatorProfileDigest');
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'EVALUATOR') {
        fail('ENVIRONMENT_UNAVAILABLE', 'Only an evaluator environment may freeze an evaluator launch plan.');
      }
      if (nullableString(context.environment, 'launch_plan_digest') !== planDigest
        || nullableString(context.environment, 'profile_digest') !== profileDigest) {
        fail('EFFECT_CONFLICT', 'Evaluator launch plan does not match the immutable environment identity.');
      }
      const existing = await client.query(
        'SELECT launch_plan FROM motive.evaluator_launch_plans WHERE environment_id = $1 FOR UPDATE',
        [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) {
        const saved = nullableJsonObject(existing.rows[0], 'launch_plan');
        if (saved === null || canonicalJson(saved) !== canonicalJson(frozen)) {
          fail('EFFECT_CONFLICT', 'Evaluator launch plan is already frozen with different terms.');
        }
        return structuredClone(saved);
      }
      await client.query(
        `INSERT INTO motive.evaluator_launch_plans (
          environment_id, attempt_id, environment_lease_epoch, environment_controller_generation,
          evaluator_profile_digest, launch_plan_digest, launch_plan,
          frozen_by, frozen_lease_epoch, frozen_controller_generation
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          asString(context.environment, 'id'), asString(context.chain.attempt, 'id'),
          asNumber(context.environment, 'lease_epoch'), asString(context.environment, 'controller_generation'),
          profileDigest, planDigest, JSON.stringify(frozen), requireText(lease.ownerId, 'lease.ownerId', 512),
          requirePositiveInteger(lease.epoch, 'lease.epoch'), requireText(lease.controllerGeneration, 'lease.controllerGeneration', 64),
        ],
      );
      return structuredClone(frozen);
    });
  }

  async getEvaluatorLaunchPlan(lease: ControllerLease, environmentId: string): Promise<Record<string, unknown> | null> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'EVALUATOR') {
        fail('ENVIRONMENT_UNAVAILABLE', 'Only an evaluator environment has an evaluator launch plan.');
      }
      const saved = await client.query(
        'SELECT launch_plan FROM motive.evaluator_launch_plans WHERE environment_id = $1',
        [asString(context.environment, 'id')],
      );
      if (saved.rowCount === 0) return null;
      const plan = nullableJsonObject(saved.rows[0], 'launch_plan');
      if (plan === null) throw new Error('Frozen evaluator launch plan is missing.');
      return structuredClone(plan);
    });
  }

  async claimEffect(lease: ControllerLease, effectId: string): Promise<{ effectId: string; claimed: boolean }> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      const kind = asString(context.effect, 'kind');
      const state = asString(context.effect, 'state');
      if (state !== 'INTENT_RECORDED') return { effectId: asString(context.effect, 'id'), claimed: false };
      if (asString(context.environment, 'state') === 'ABANDONED' || asString(context.environment, 'state') === 'TERMINATED') {
        return { effectId: asString(context.effect, 'id'), claimed: false };
      }
      const now = await this.now(client);
      if (kind === 'CREATE' || kind === 'COMMAND') {
        this.ensureEnvironmentLaunchAuthority(context.environment, lease);
        this.ensureFreshEffectAuthority(context.chain, now);
        if (context.authorization === undefined) throw new Error('Effectful environment lacks a locked infrastructure authorization.');
        this.assertAuthorizationOpen(context.authorization, context.chain, now);
      }
      if (kind === 'CREATE' && asString(context.environment, 'state') !== 'RESERVED') {
        fail('EFFECT_UNAVAILABLE', 'Create intent no longer has a reservable environment state.');
      }
      if (kind === 'COMMAND' && asString(context.environment, 'state') !== 'ACTIVE') {
        fail('ENVIRONMENT_UNAVAILABLE', 'A command requires an actively observed environment.');
      }
      if (kind === 'COMMAND') this.ensureCommandPhase(context.chain, context.environment);
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'CLAIMED', claimed_by = $2, claimed_lease_epoch = $3,
             claimed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id'), lease.ownerId, lease.epoch],
      );
      if (kind === 'CREATE') {
        await client.query(
          `UPDATE motive.orchestration_environments
           SET state = 'PROVISIONING', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.environment, 'id')],
        );
      } else if (kind === 'STOP') {
        await client.query(
          `UPDATE motive.orchestration_environments
           SET state = 'STOP_REQUESTED', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.environment, 'id')],
        );
      }
      return { effectId: asString(context.effect, 'id'), claimed: true };
    });
  }

  private async recordCreate(
    client: PoolClient,
    context: TrackedEffectContext,
    lease: ControllerLease,
    handle: EnvironmentHandle,
    recovered: boolean,
  ): Promise<EnvironmentProjection> {
    if (asString(context.effect, 'kind') !== 'CREATE') fail('EFFECT_UNAVAILABLE', 'Effect is not a create intent.');
    const state = asString(context.effect, 'state');
    if (recovered) {
      await this.assertCurrentLease(client, context.chain, lease);
      if (!['CLAIMED', 'UNKNOWN'].includes(state)) fail('EFFECT_UNAVAILABLE', 'Only a claimed or ambiguous create can be recovered.');
    } else {
      if (state !== 'CLAIMED') fail('EFFECT_NOT_CLAIMED', 'Create result requires the one durable create claim.');
      this.assertHistoricalClaim(context.chain, context.effect, lease);
    }
    const existingProvider = nullableString(context.environment, 'provider');
    const existingExternalId = nullableString(context.environment, 'external_id');
    if (existingProvider !== null || existingExternalId !== null) {
      if (existingProvider === handle.provider && existingExternalId === handle.externalId
        && nullableString(context.environment, 'session_id') === handle.sessionId) {
        return environmentProjection(context.environment);
      }
      fail('EFFECT_CONFLICT', 'Create result conflicts with the immutable recorded provider handle.');
    }
    const conflicting = await client.query(
      `SELECT id FROM motive.orchestration_environments
       WHERE provider = $1 AND external_id = $2 AND session_id = $3
         AND state <> 'TERMINATED' AND id <> $4 FOR KEY SHARE`,
      [handle.provider, handle.externalId, handle.sessionId, asString(context.environment, 'id')],
    );
    if ((conflicting.rowCount ?? 0) > 0) fail('EFFECT_CONFLICT', 'Provider handle already belongs to another live environment record.');
    await client.query(
      `UPDATE motive.orchestration_environments
       SET provider = $2, external_id = $3, session_id = $4, state = 'PROVISIONING', updated_at = clock_timestamp()
       WHERE id = $1`,
      [asString(context.environment, 'id'), handle.provider, handle.externalId, handle.sessionId],
    );
    await client.query(
      `UPDATE motive.orchestration_effects
       SET state = 'RESULT_RECORDED', result_recorded_at = clock_timestamp(), unknown_reason = NULL, updated_at = clock_timestamp()
       WHERE id = $1`,
      [asString(context.effect, 'id')],
    );
    const updated = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1', [asString(context.environment, 'id')]);
    return environmentProjection(updated.rows[0]);
  }

  async recordCreateResult(lease: ControllerLease, effectId: string, handle: EnvironmentHandle): Promise<EnvironmentProjection> {
    const recorded = assertHandle(handle);
    return this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId);
      return this.recordCreate(client, context, lease, recorded, false);
    });
  }

  async recordRecoveredCreate(lease: ControllerLease, effectId: string, handle: EnvironmentHandle): Promise<EnvironmentProjection> {
    const recorded = assertHandle(handle);
    return this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId);
      return this.recordCreate(client, context, lease, recorded, true);
    });
  }

  async markEffectUnknown(lease: ControllerLease, effectId: string, reason: string): Promise<void> {
    const safeReason = assertSafeStoredText(reason, 'reason', 512);
    await this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId);
      if (!['CLAIMED', 'UNKNOWN'].includes(asString(context.effect, 'state'))) {
        fail('EFFECT_UNAVAILABLE', 'Only a claimed effect can become unknown.');
      }
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      if (asString(context.effect, 'state') === 'UNKNOWN') return;
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'UNKNOWN', unknown_reason = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.effect, 'id'), safeReason],
      );
      if (asString(context.environment, 'state') !== 'TERMINATED') {
        await client.query(
          `UPDATE motive.orchestration_environments SET state = 'UNKNOWN', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.environment, 'id')],
        );
      }
      if (['RESERVED', 'PROVISIONING', 'RUNNING'].includes(asString(context.chain.attempt, 'execution_status'))) {
        await client.query(
          `UPDATE motive.attempts SET execution_status = 'QUARANTINED', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.chain.attempt, 'id')],
        );
      }
    });
  }

  async abandonReservedEnvironment(lease: ControllerLease, environmentId: string): Promise<EnvironmentProjection> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'state') !== 'RESERVED') {
        fail('ENVIRONMENT_UNAVAILABLE', 'Only a never-started RESERVED environment can be abandoned.');
      }
      const effect = await client.query(
        `SELECT * FROM motive.orchestration_effects WHERE environment_id = $1 AND kind = 'CREATE' FOR UPDATE`,
        [asString(context.environment, 'id')],
      );
      if (effect.rowCount !== 1 || asString(effect.rows[0], 'state') !== 'INTENT_RECORDED') {
        fail('EFFECT_UNAVAILABLE', 'A claimed create may have reached the provider and must be reconciled instead of abandoned.');
      }
      if (context.authorization === undefined) throw new Error('Reserved environment has no infrastructure authorization.');
      const held = asAmount(context.environment, 'held_cost_usd');
      await client.query(
        `UPDATE motive.orchestration_effects SET state = 'ABANDONED', updated_at = clock_timestamp() WHERE id = $1`,
        [asString(effect.rows[0], 'id')],
      );
      await client.query(
        `UPDATE motive.orchestration_environments
         SET state = 'ABANDONED', held_cost_usd = 0, updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.environment, 'id')],
      );
      await client.query(
        `UPDATE motive.infrastructure_authorizations
         SET held_usd = held_usd - $2, updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.authorization, 'id'), held],
      );
      await this.decrementCapacityAfterTerminal(client);
      const updated = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1', [asString(context.environment, 'id')]);
      return environmentProjection(updated.rows[0]);
    });
  }

  async getExecution(attemptId: string): Promise<ExecutionProjection | null> {
    const id = requireUuid(attemptId, 'attemptId');
    const attempt = await this.pool.query('SELECT id FROM motive.attempts WHERE id = $1', [id]);
    if (attempt.rowCount === 0) return null;
    const [lease, environments, effects, seal] = await Promise.all([
      this.pool.query('SELECT * FROM motive.orchestration_leases WHERE attempt_id = $1', [id]),
      this.pool.query(
        `SELECT * FROM motive.orchestration_environments
         WHERE attempt_id = $1 ORDER BY created_at, id`, [id],
      ),
      this.pool.query(
        `SELECT effect.*, command.provider_command_id
         FROM motive.orchestration_effects AS effect
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE effect.attempt_id = $1 ORDER BY effect.created_at, effect.id`, [id],
      ),
      this.pool.query('SELECT * FROM motive.orchestration_artifact_seals WHERE attempt_id = $1', [id]),
    ]);
    return {
      attemptId: id,
      lease: lease.rowCount === 0 ? null : leaseProjection(lease.rows[0]),
      environments: environments.rows.map(environmentProjection),
      effects: effects.rows.map(effectProjection),
      artifactSeal: seal.rowCount === 0 ? null : artifactSealProjection(seal.rows[0]),
    };
  }

  async findEnvironment(handle: EnvironmentHandle): Promise<EnvironmentProjection | null> {
    const recorded = assertHandle(handle);
    const result = await this.pool.query(
      `SELECT * FROM motive.orchestration_environments
       WHERE provider = $1 AND external_id = $2 AND session_id = $3
       ORDER BY CASE WHEN state = 'TERMINATED' THEN 1 ELSE 0 END, created_at DESC
       LIMIT 1`,
      [recorded.provider, recorded.externalId, recorded.sessionId],
    );
    return result.rowCount === 0 ? null : environmentProjection(result.rows[0]);
  }

  async freezeNativeCollectionPlan(
    lease: ControllerLease,
    environmentId: string,
    input: FreezeNativeCollectionPlanInput,
  ): Promise<NativeCollectionPlanProjection> {
    const normalized = normalizeNativeCollectionPlanInput(input);
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      const profile = this.nativeCollectionProfile(context.environment);
      if (normalized.paths.length > profile.profile.artifacts.maxFiles
        || normalized.maximumFileBytes > profile.profile.artifacts.maxFileBytes
        || normalized.maximumTotalBytes > profile.profile.artifacts.maxTotalBytes) {
        fail('VALIDATION', 'Native collection plan exceeds the frozen sandbox artifact policy.');
      }
      const commonFrozen = {
        format: 'motive.native-collection-plan/0.1',
        environment_id: asString(context.environment, 'id'),
        attempt_id: asString(context.chain.attempt, 'id'),
        lease_epoch: nullableNumber(context.environment, 'lease_epoch'),
        controller_generation: nullableString(context.environment, 'controller_generation'),
        profile_digest: nullableString(context.environment, 'profile_digest'),
        worker_runtime_digest: profile.workerRuntimeDigest,
        collector_runtime_digest: normalized.collectorRuntimeDigest,
        maximum_file_bytes: normalized.maximumFileBytes,
        maximum_total_bytes: normalized.maximumTotalBytes,
        maximum_files: profile.profile.artifacts.maxFiles,
        maximum_helper_commands: profile.executionBoundaryKind === 'PROTECTED_RUNTIME' ? normalized.paths.length + 1 : 0,
        approved_paths: normalized.paths.map(path => ({
          relative_path: path.relativePath, path_digest: path.pathDigest, media_type: path.mediaType,
          availability: path.availability, maximum_bytes: path.maximumBytes,
        })),
      };
      // Protected plans retain the exact historical canonical bytes so an old
      // immutable plan replays after migration 023. Only the new provider
      // boundary carries its explicit discriminator in its plan digest.
      const frozen = profile.executionBoundaryKind === 'PROTECTED_RUNTIME'
        ? commonFrozen
        : {
            ...commonFrozen,
            format: 'motive.provider-session-collection-plan/0.1',
            execution_boundary_kind: profile.executionBoundaryKind,
            execution_boundary_digest: profile.executionBoundaryDigest,
          };
      const collectionPlanDigest = digestCanonicalJson(frozen);
      const existing = await client.query(
        'SELECT * FROM motive.native_collection_plans WHERE environment_id = $1 FOR UPDATE',
        [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) {
        const projection = await this.loadNativeCollectionPlanProjection(client, existing.rows[0]);
        if (projection.collectionPlanDigest !== collectionPlanDigest) {
          fail('EFFECT_CONFLICT', 'The native collection plan is immutable and conflicts with this retry.');
        }
        return projection;
      }
      if (profile.executionBoundaryKind === 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
          && !isExactProviderCircleCollection(profile.profile, input)) {
        fail('VALIDATION', 'Provider-untrusted collection is restricted to the exact circle data contracts.');
      }
      const now = await this.now(client);
      this.ensureEnvironmentLaunchAuthority(context.environment, lease);
      this.ensureFreshEffectAuthority(context.chain, now);
      if (context.authorization === undefined) throw new Error('Native collection worker lacks infrastructure authorization.');
      this.assertAuthorizationOpen(context.authorization, context.chain, now);
      if (asString(context.environment, 'kind') !== 'WORKER'
        || asString(context.environment, 'state') !== 'RESERVED'
        || nullableString(context.environment, 'provider') !== null
        || nullableString(context.environment, 'external_id') !== null
        || nullableString(context.environment, 'session_id') !== null) {
        fail('ENVIRONMENT_UNAVAILABLE', 'A native collection plan must freeze before worker VM dispatch.');
      }
      const create = await client.query(
        `SELECT * FROM motive.orchestration_effects
         WHERE environment_id = $1 AND attempt_id = $2 AND kind = 'CREATE' FOR UPDATE`,
        [asString(context.environment, 'id'), asString(context.chain.attempt, 'id')],
      );
      if (create.rowCount !== 1 || asString(create.rows[0], 'state') !== 'INTENT_RECORDED') {
        fail('EFFECT_UNAVAILABLE', 'Native collection must freeze before the worker create claim.');
      }
      await client.query(
        `INSERT INTO motive.native_collection_plans
         (environment_id, attempt_id, lease_epoch, controller_generation, profile_digest,
          execution_boundary_kind, execution_boundary_digest, worker_runtime_digest,
          collector_runtime_digest, collection_plan_digest, maximum_file_bytes, maximum_total_bytes,
          maximum_files, path_count, maximum_helper_commands)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          asString(context.environment, 'id'), asString(context.chain.attempt, 'id'),
          requirePositiveInteger(nullableNumber(context.environment, 'lease_epoch'), 'environment.leaseEpoch'),
          requireText(nullableString(context.environment, 'controller_generation'), 'environment.controllerGeneration', 64),
          assertDigest(nullableString(context.environment, 'profile_digest'), 'environment.profileDigest'),
          profile.executionBoundaryKind, profile.executionBoundaryDigest, profile.workerRuntimeDigest,
          normalized.collectorRuntimeDigest, collectionPlanDigest,
          normalized.maximumFileBytes, normalized.maximumTotalBytes, profile.profile.artifacts.maxFiles,
          normalized.paths.length, profile.executionBoundaryKind === 'PROTECTED_RUNTIME' ? normalized.paths.length + 1 : 0,
        ],
      );
      for (let ordinal = 0; ordinal < normalized.paths.length; ordinal += 1) {
        const path = normalized.paths[ordinal]!;
        await client.query(
          `INSERT INTO motive.native_collection_plan_paths
           (environment_id, ordinal, relative_path, path_digest, media_type, availability, maximum_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [asString(context.environment, 'id'), ordinal, path.relativePath, path.pathDigest,
            path.mediaType, path.availability, path.maximumBytes],
        );
      }
      const saved = await client.query('SELECT * FROM motive.native_collection_plans WHERE environment_id = $1', [asString(context.environment, 'id')]);
      if (saved.rowCount !== 1) throw new Error('Native collection plan disappeared after persistence.');
      return this.loadNativeCollectionPlanProjection(client, saved.rows[0]);
    });
  }

  async getNativeCollectionPlan(lease: ControllerLease, environmentId: string): Promise<NativeCollectionPlanProjection | null> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      const plan = await client.query('SELECT * FROM motive.native_collection_plans WHERE environment_id = $1 FOR UPDATE', [asString(context.environment, 'id')]);
      if (plan.rowCount === 0) return null;
      const planContext: NativeCollectionPlanContext = { ...context, plan: plan.rows[0] };
      this.assertFrozenNativeCollectionPlan(planContext);
      return this.loadNativeCollectionPlanProjection(client, plan.rows[0]);
    });
  }

  async planNativeBootstrap(lease: ControllerLease, environmentId: string): Promise<{ effect: NativeCollectionEffectProjection }> {
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionPlan(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      this.assertNativeHelperBoundary(context);
      await this.loadNativeCollectionPlanProjection(client, context.plan);
      const existing = await client.query(
        `SELECT * FROM motive.native_collection_effects
         WHERE environment_id = $1 AND kind = 'BOOTSTRAP' FOR UPDATE`,
        [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) return { effect: nativeCollectionEffectProjection(existing.rows[0]) };
      const workerCommand = await this.ensureFreshNativeCollectionDispatch(client, context, lease);
      const effectId = randomUUID();
      const effectKey = `native-bootstrap:${asString(context.environment, 'id')}:${asString(context.plan, 'collection_plan_digest')}:${asString(workerCommand, 'id')}`;
      await client.query(
        `INSERT INTO motive.native_collection_effects
         (id, environment_id, attempt_id, worker_command_effect_id, kind, effect_key, provider, external_id, session_id,
          lease_epoch, controller_generation, profile_digest, worker_runtime_digest, collector_runtime_digest,
          collection_plan_digest)
         VALUES ($1,$2,$3,$4,'BOOTSTRAP',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          effectId, asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), asString(workerCommand, 'id'), effectKey,
          asString(context.environment, 'provider'), asString(context.environment, 'external_id'), asString(context.environment, 'session_id'),
          asNumber(context.plan, 'lease_epoch'), asString(context.plan, 'controller_generation'), asString(context.plan, 'profile_digest'),
          asString(context.plan, 'worker_runtime_digest'), asString(context.plan, 'collector_runtime_digest'),
          asString(context.plan, 'collection_plan_digest'),
        ],
      );
      const effect = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1', [effectId]);
      if (effect.rowCount !== 1) throw new Error('Native bootstrap effect disappeared after persistence.');
      return { effect: nativeCollectionEffectProjection(effect.rows[0]) };
    });
  }

  async planNativeCapture(
    lease: ControllerLease,
    environmentId: string,
    input: PlanNativeCaptureInput,
  ): Promise<{ effect: NativeCollectionEffectProjection }> {
    const relativePath = assertNativeCollectionRelativePath(input?.relativePath, 'relativePath');
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionPlan(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      this.assertNativeHelperBoundary(context);
      await this.loadNativeCollectionPlanProjection(client, context.plan);
      const path = await client.query(
        `SELECT * FROM motive.native_collection_plan_paths
         WHERE environment_id = $1 AND relative_path = $2 FOR UPDATE`,
        [asString(context.environment, 'id'), relativePath],
      );
      if (path.rowCount !== 1) fail('EFFECT_UNAVAILABLE', 'Capture path is not part of the frozen native collection plan.');
      const existing = await client.query(
        `SELECT * FROM motive.native_collection_effects
         WHERE environment_id = $1 AND kind = 'CAPTURE' AND path_ordinal = $2 FOR UPDATE`,
        [asString(context.environment, 'id'), asNumber(path.rows[0], 'ordinal')],
      );
      if (existing.rowCount === 1) return { effect: nativeCollectionEffectProjection(existing.rows[0]) };
      const workerCommand = await this.ensureFreshNativeCollectionDispatch(client, context, lease);
      const binding = await this.frozenNativeBindingForCapture(client, context, workerCommand);
      const effectId = randomUUID();
      const effectKey = `native-capture:${asString(context.environment, 'id')}:${asString(context.plan, 'collection_plan_digest')}:${asString(binding, 'bootstrap_effect_id')}:${asString(path.rows[0], 'path_digest')}:${asNumber(path.rows[0], 'maximum_bytes')}`;
      await client.query(
        `INSERT INTO motive.native_collection_effects
         (id, environment_id, attempt_id, worker_command_effect_id, kind, effect_key, provider, external_id, session_id,
          lease_epoch, controller_generation, profile_digest, worker_runtime_digest, collector_runtime_digest,
          collection_plan_digest, bootstrap_effect_id, path_ordinal, relative_path, path_digest, maximum_bytes, workspace_identity)
         VALUES ($1,$2,$3,$4,'CAPTURE',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          effectId, asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), asString(workerCommand, 'id'), effectKey,
          asString(context.environment, 'provider'), asString(context.environment, 'external_id'), asString(context.environment, 'session_id'),
          asNumber(context.plan, 'lease_epoch'), asString(context.plan, 'controller_generation'), asString(context.plan, 'profile_digest'),
          asString(context.plan, 'worker_runtime_digest'), asString(context.plan, 'collector_runtime_digest'),
          asString(context.plan, 'collection_plan_digest'), asString(binding, 'bootstrap_effect_id'), asNumber(path.rows[0], 'ordinal'),
          asString(path.rows[0], 'relative_path'), asString(path.rows[0], 'path_digest'), asNumber(path.rows[0], 'maximum_bytes'),
          asString(binding, 'workspace_identity'),
        ],
      );
      const effect = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1', [effectId]);
      if (effect.rowCount !== 1) throw new Error('Native capture effect disappeared after persistence.');
      return { effect: nativeCollectionEffectProjection(effect.rows[0]) };
    });
  }

  async claimNativeCollectionEffect(lease: ControllerLease, effectId: string): Promise<{ effectId: string; claimed: boolean }> {
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.effect, 'state') !== 'INTENT_RECORDED') {
        return { effectId: asString(context.effect, 'id'), claimed: false };
      }
      await this.loadNativeCollectionPlanProjection(client, context.plan);
      const workerCommand = await this.ensureFreshNativeCollectionDispatch(client, context, lease);
      this.assertNativeCollectionEffectMatches(context, context.effect, workerCommand);
      await client.query(
        `UPDATE motive.native_collection_effects
         SET state = 'CLAIMED', claimed_by = $2, claimed_lease_epoch = $3,
             claimed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id'), lease.ownerId, lease.epoch],
      );
      return { effectId: asString(context.effect, 'id'), claimed: true };
    });
  }

  async recordNativeCollectionStarted(
    lease: ControllerLease,
    effectId: string,
    handle: CommandHandle,
  ): Promise<NativeCollectionEffectProjection> {
    const providerCommandId = assertSafeStoredText(handle?.providerCommandId, 'handle.providerCommandId', 512);
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId);
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      const state = asString(context.effect, 'state');
      if (state === 'START_RECORDED') {
        if (asString(context.effect, 'provider_command_id') !== providerCommandId) {
          fail('EFFECT_CONFLICT', 'Native collection command handle conflicts with the durable start record.');
        }
        return nativeCollectionEffectProjection(context.effect);
      }
      if (state !== 'CLAIMED') fail('EFFECT_NOT_CLAIMED', 'Native collection command start requires its single durable claim.');
      await client.query(
        `UPDATE motive.native_collection_effects
         SET state = 'START_RECORDED', provider_command_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id'), providerCommandId],
      );
      const saved = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1', [asString(context.effect, 'id')]);
      return nativeCollectionEffectProjection(saved.rows[0]);
    });
  }

  async recordNativeBootstrapBinding(
    lease: ControllerLease,
    effectId: string,
    input: RecordNativeBootstrapBindingInput,
  ): Promise<WorkerWorkspaceBindingInput> {
    const completion = assertNativeCollectionCompletion(input);
    if (completion.exitCode !== 0) fail('VALIDATION', 'A bootstrap binding requires a successful helper exit.');
    const binding = input?.binding;
    if (typeof binding !== 'object' || binding === null || binding.format !== 'motive.vercel-native-workspace-binding/0.1') {
      fail('VALIDATION', 'Native bootstrap binding is invalid.');
    }
    const workspaceIdentity = assertNativeWorkspaceIdentity(binding.workspaceIdentity, 'binding.workspaceIdentity');
    const collectorRuntimeDigest = assertDigest(binding.runtimeDigest, 'binding.runtimeDigest');
    const handle = binding.handle;
    if (typeof handle !== 'object' || handle === null || handle.provider !== 'vercel') {
      fail('VALIDATION', 'Native bootstrap binding requires a Vercel worker handle.');
    }
    const attemptId = requireUuid(handle.attemptId, 'binding.handle.attemptId');
    const leaseEpoch = requirePositiveInteger(handle.leaseEpoch, 'binding.handle.leaseEpoch');
    const profileDigest = assertDigest(handle.profileDigest, 'binding.handle.profileDigest');
    const sandboxId = assertSafeStoredText(handle.sandboxId, 'binding.handle.sandboxId', 512);
    const sessionId = assertSafeStoredText(handle.sessionId, 'binding.handle.sessionId', 512);
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sandboxId !== sandboxName(attemptId, leaseEpoch)) {
      fail('VALIDATION', 'Native bootstrap binding has an invalid sandbox or session identity.');
    }
    const expectedFrame = canonicalNativeBootstrapFrame(workspaceIdentity);
    if (completion.stdoutBytes !== expectedFrame.stdoutBytes || completion.stdoutDigest !== expectedFrame.stdoutDigest) {
      fail('VALIDATION', 'Native bootstrap metadata does not match the canonical trusted helper frame.');
    }
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'BOOTSTRAP') fail('EFFECT_UNAVAILABLE', 'Only a bootstrap helper effect may bind a workspace.');
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      this.assertNativeCollectionCompletionBounds(context.effect, completion);
      if (asString(context.effect, 'attempt_id') !== attemptId
        || asNumber(context.effect, 'lease_epoch') !== leaseEpoch
        || asString(context.effect, 'profile_digest') !== profileDigest
        || asString(context.effect, 'provider') !== 'vercel'
        || asString(context.effect, 'external_id') !== sandboxId
        || asString(context.effect, 'session_id') !== sessionId
        || asString(context.effect, 'collector_runtime_digest') !== collectorRuntimeDigest) {
        fail('ENVIRONMENT_UNAVAILABLE', 'Native bootstrap binding does not match its helper effect session/runtime identity.');
      }
      const state = asString(context.effect, 'state');
      if (state === 'COMPLETED') {
        if (asNumber(context.effect, 'exit_code') !== completion.exitCode
          || asString(context.effect, 'stdout_digest') !== completion.stdoutDigest
          || asNumber(context.effect, 'stdout_bytes') !== completion.stdoutBytes) {
          fail('EFFECT_CONFLICT', 'Native bootstrap completion conflicts with its immutable result.');
        }
        const saved = await client.query('SELECT * FROM motive.native_workspace_bindings WHERE bootstrap_effect_id = $1', [asString(context.effect, 'id')]);
        if (saved.rowCount !== 1) throw new Error('Completed native bootstrap effect has no durable binding.');
        const projection = workspaceBindingProjection(saved.rows[0]);
        const expected: WorkerWorkspaceBindingInput = {
          workerRuntimeDigest: asString(context.effect, 'worker_runtime_digest') as Digest,
          binding: { ...binding, workspaceIdentity, runtimeDigest: collectorRuntimeDigest,
            handle: { ...binding.handle, sandboxId, sessionId, attemptId, leaseEpoch, profileDigest } },
        };
        if (canonicalJson(projection) !== canonicalJson(expected)) {
          fail('EFFECT_CONFLICT', 'Native bootstrap binding conflicts with the immutable durable binding.');
        }
        return projection;
      }
      if (state !== 'START_RECORDED') fail('EFFECT_NOT_CLAIMED', 'Native bootstrap binding requires a recorded provider command.');
      const existing = await client.query('SELECT * FROM motive.native_workspace_bindings WHERE environment_id = $1 FOR UPDATE', [asString(context.environment, 'id')]);
      if (existing.rowCount !== 0) {
        fail('EFFECT_CONFLICT', 'An existing local-only or different native binding cannot become helper provenance.');
      }
      await client.query(
        `UPDATE motive.native_collection_effects
         SET state = 'COMPLETED', exit_code = 0, stdout_digest = $2, stdout_bytes = $3,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id'), completion.stdoutDigest, completion.stdoutBytes],
      );
      await client.query(
        `INSERT INTO motive.native_workspace_bindings
         (environment_id, attempt_id, provider, external_id, session_id, lease_epoch, controller_generation,
          profile_digest, worker_runtime_digest, collector_runtime_digest, workspace_identity, bootstrap_effect_id)
         VALUES ($1,$2,'vercel',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          asString(context.environment, 'id'), attemptId, sandboxId, sessionId, leaseEpoch,
          asString(context.effect, 'controller_generation'), profileDigest,
          asString(context.effect, 'worker_runtime_digest'), collectorRuntimeDigest, workspaceIdentity,
          asString(context.effect, 'id'),
        ],
      );
      const saved = await client.query('SELECT * FROM motive.native_workspace_bindings WHERE environment_id = $1', [asString(context.environment, 'id')]);
      if (saved.rowCount !== 1) throw new Error('Native bootstrap binding disappeared after persistence.');
      return workspaceBindingProjection(saved.rows[0]);
    });
  }

  async recordNativeCollectionCompleted(
    lease: ControllerLease,
    effectId: string,
    input: NativeCollectionCompletionInput,
  ): Promise<NativeCollectionEffectProjection> {
    const completion = assertNativeCollectionCompletion(input);
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'CAPTURE') {
        fail('EFFECT_UNAVAILABLE', 'Bootstrap completion must atomically persist its workspace binding.');
      }
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      this.assertNativeCollectionCompletionBounds(context.effect, completion);
      const state = asString(context.effect, 'state');
      if (state === 'COMPLETED') {
        if (asNumber(context.effect, 'exit_code') !== completion.exitCode
          || asString(context.effect, 'stdout_digest') !== completion.stdoutDigest
          || asNumber(context.effect, 'stdout_bytes') !== completion.stdoutBytes) {
          fail('EFFECT_CONFLICT', 'Native collection completion conflicts with its immutable result.');
        }
        return nativeCollectionEffectProjection(context.effect);
      }
      if (state !== 'START_RECORDED') fail('EFFECT_NOT_CLAIMED', 'Native collection completion requires a recorded provider command.');
      await client.query(
        `UPDATE motive.native_collection_effects
         SET state = 'COMPLETED', exit_code = $2, stdout_digest = $3, stdout_bytes = $4,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id'), completion.exitCode, completion.stdoutDigest, completion.stdoutBytes],
      );
      const saved = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1', [asString(context.effect, 'id')]);
      return nativeCollectionEffectProjection(saved.rows[0]);
    });
  }

  async markNativeCollectionUnknown(
    lease: ControllerLease,
    effectId: string,
    reason: string,
  ): Promise<NativeCollectionEffectProjection> {
    const safeReason = assertSafeStoredText(reason, 'reason', 512);
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId);
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      const state = asString(context.effect, 'state');
      if (state === 'UNKNOWN') {
        if (asString(context.effect, 'unknown_reason') !== safeReason) {
          fail('EFFECT_CONFLICT', 'Native collection unknown outcome conflicts with its immutable reason.');
        }
        return nativeCollectionEffectProjection(context.effect);
      }
      if (!['CLAIMED', 'START_RECORDED'].includes(state)) {
        fail('EFFECT_UNAVAILABLE', 'Only a claimed native collection effect may become unknown.');
      }
      await client.query(
        `UPDATE motive.native_collection_effects
         SET state = 'UNKNOWN', unknown_reason = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.effect, 'id'), safeReason],
      );
      const saved = await client.query('SELECT * FROM motive.native_collection_effects WHERE id = $1', [asString(context.effect, 'id')]);
      return nativeCollectionEffectProjection(saved.rows[0]);
    });
  }

  async getNativeCollectionEffect(lease: ControllerLease, effectId: string): Promise<NativeCollectionEffectProjection> {
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionEffect(client, effectId);
      await this.assertCurrentLease(client, context.chain, lease);
      return nativeCollectionEffectProjection(context.effect);
    });
  }

  async listNativeCollectionEffects(
    lease: ControllerLease,
    environmentId: string,
  ): Promise<readonly NativeCollectionEffectProjection[]> {
    return this.transaction(async client => {
      const context = await this.lockNativeCollectionPlan(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      this.assertNativeHelperBoundary(context);
      const effects = await client.query(
        'SELECT * FROM motive.native_collection_effects WHERE environment_id = $1 ORDER BY created_at, id',
        [asString(context.environment, 'id')],
      );
      return effects.rows.map(nativeCollectionEffectProjection);
    });
  }

  async planCommand(lease: ControllerLease, environmentId: string, input: PlanCommandInput): Promise<{ effect: EffectIntent }> {
    const commandDigest = assertDigest(input.commandDigest, 'commandDigest');
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      const now = await this.now(client);
      this.ensureEnvironmentLaunchAuthority(context.environment, lease);
      this.ensureFreshEffectAuthority(context.chain, now);
      if (context.authorization === undefined) throw new Error('Environment has no infrastructure authorization.');
      this.assertAuthorizationOpen(context.authorization, context.chain, now);
      if (asString(context.environment, 'state') !== 'ACTIVE') {
        fail('ENVIRONMENT_UNAVAILABLE', 'A command requires a currently active environment observation.');
      }
      this.ensureCommandPhase(context.chain, context.environment);
      const prior = await client.query(
        `SELECT effect.*, command.provider_command_id
         FROM motive.orchestration_effects AS effect
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE effect.environment_id = $1 AND effect.kind = 'COMMAND' FOR UPDATE OF effect`,
        [asString(context.environment, 'id')],
      );
      if (prior.rowCount === 1) {
        if (asString(prior.rows[0], 'command_digest') !== commandDigest) {
          fail('EFFECT_CONFLICT', 'An environment may not start a second command with different bytes.');
        }
        return { effect: effectProjection(prior.rows[0]) };
      }
      const effectId = randomUUID();
      await client.query(
        `INSERT INTO motive.orchestration_effects (id, environment_id, attempt_id, kind, effect_key, command_digest)
         VALUES ($1, $2, $3, 'COMMAND', $4, $5)`,
        [
          effectId, asString(context.environment, 'id'), asString(context.chain.attempt, 'id'),
          `command:${asString(context.environment, 'id')}:${commandDigest}`, commandDigest,
        ],
      );
      const effect = await client.query(
        `SELECT effect.*, command.provider_command_id
         FROM motive.orchestration_effects AS effect
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE effect.id = $1`,
        [effectId],
      );
      return { effect: effectProjection(effect.rows[0]) };
    });
  }

  async recordCommandResult(lease: ControllerLease, effectId: string, handle: CommandHandle): Promise<void> {
    const providerCommandId = assertSafeStoredText(handle?.providerCommandId, 'handle.providerCommandId', 512);
    await this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'COMMAND') fail('EFFECT_UNAVAILABLE', 'Effect is not a command intent.');
      const state = asString(context.effect, 'state');
      if (state === 'RESULT_RECORDED') {
        const command = await client.query('SELECT provider_command_id FROM motive.orchestration_commands WHERE effect_id = $1', [effectId]);
        if (command.rowCount === 1 && asString(command.rows[0], 'provider_command_id') === providerCommandId) return;
        fail('EFFECT_CONFLICT', 'Command result conflicts with the immutable provider command handle.');
      }
      if (state !== 'CLAIMED') fail('EFFECT_NOT_CLAIMED', 'Command result requires the one durable command claim.');
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      await client.query(
        `INSERT INTO motive.orchestration_commands (effect_id, environment_id, provider_command_id)
         VALUES ($1, $2, $3)`,
        [asString(context.effect, 'id'), asString(context.environment, 'id'), providerCommandId],
      );
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'RESULT_RECORDED', result_recorded_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id')],
      );
    });
  }

  async claimEvaluatorReport(
    lease: ControllerLease,
    environmentId: string,
    input: EvaluatorReportClaim,
  ): Promise<EvaluatorReportClaim> {
    const reportDigest = assertDigest(input?.reportDigest, 'reportDigest');
    const commandId = input?.commandId === null
      ? null
      : assertSafeStoredText(input?.commandId, 'commandId', 512);
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'EVALUATOR'
        || nullableString(context.environment, 'provider') === null
        || nullableString(context.environment, 'external_id') === null
        || nullableString(context.environment, 'session_id') === null) {
        fail('ENVIRONMENT_UNAVAILABLE', 'Evaluator report claim requires the exact observed evaluator environment.');
      }
      const frozen = await client.query(
        'SELECT environment_id FROM motive.evaluator_launch_plans WHERE environment_id = $1 FOR KEY SHARE',
        [asString(context.environment, 'id')],
      );
      if (frozen.rowCount !== 1) fail('EFFECT_UNAVAILABLE', 'Evaluator report claim requires a frozen evaluator launch plan.');
      const existing = await client.query(
        'SELECT report_digest, provider_command_id FROM motive.evaluator_report_claims WHERE environment_id = $1 FOR UPDATE',
        [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) {
        const saved = {
          reportDigest: asString(existing.rows[0], 'report_digest') as Digest,
          commandId: nullableString(existing.rows[0], 'provider_command_id'),
        };
        if (saved.reportDigest !== reportDigest || saved.commandId !== commandId) {
          fail('EFFECT_CONFLICT', 'Evaluator report was already claimed with different immutable input.');
        }
        return saved;
      }
      if (commandId !== null) {
        const command = await client.query(
          `SELECT command.provider_command_id FROM motive.orchestration_commands AS command
           JOIN motive.orchestration_effects AS effect ON effect.id = command.effect_id
           WHERE command.environment_id = $1 AND command.provider_command_id = $2
             AND effect.environment_id = $1 AND effect.kind = 'COMMAND' AND effect.state = 'RESULT_RECORDED'
           FOR KEY SHARE OF command, effect`,
          [asString(context.environment, 'id'), commandId],
        );
        if (command.rowCount !== 1) {
          fail('EFFECT_CONFLICT', 'Complete evaluator report does not match the persisted evaluator command.');
        }
      }
      await client.query(
        `INSERT INTO motive.evaluator_report_claims (
          environment_id, attempt_id, report_digest, provider_command_id,
          evaluator_provider, evaluator_external_id, evaluator_session_id,
          environment_lease_epoch, environment_controller_generation, evaluator_profile_digest,
          claimed_by, claimed_lease_epoch, claimed_controller_generation
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), reportDigest, commandId,
          asString(context.environment, 'provider'), asString(context.environment, 'external_id'),
          asString(context.environment, 'session_id'), asNumber(context.environment, 'lease_epoch'),
          asString(context.environment, 'controller_generation'), asString(context.environment, 'profile_digest'),
          requireText(lease.ownerId, 'lease.ownerId', 512), requirePositiveInteger(lease.epoch, 'lease.epoch'),
          requireText(lease.controllerGeneration, 'lease.controllerGeneration', 64),
        ],
      );
      return { reportDigest, commandId };
    });
  }

  async getEvaluatorReportClaim(lease: ControllerLease, environmentId: string): Promise<EvaluatorReportClaim | null> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'EVALUATOR') {
        fail('ENVIRONMENT_UNAVAILABLE', 'Only an evaluator environment has an evaluator report claim.');
      }
      const saved = await client.query(
        'SELECT report_digest, provider_command_id FROM motive.evaluator_report_claims WHERE environment_id = $1',
        [asString(context.environment, 'id')],
      );
      return saved.rowCount === 0 ? null : {
        reportDigest: asString(saved.rows[0], 'report_digest') as Digest,
        commandId: nullableString(saved.rows[0], 'provider_command_id'),
      };
    });
  }

  async recordObservation(lease: ControllerLease, environmentId: string, observation: ProviderObservation): Promise<EnvironmentProjection> {
    const observed = assertObservation(observation);
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (nullableString(context.environment, 'provider') === null || nullableString(context.environment, 'external_id') === null) {
        fail('ENVIRONMENT_UNAVAILABLE', 'A provider observation requires a recorded provider handle.');
      }
      const result = await this.applyObservation(client, context.environment, observed);
      if (result.state === 'ACTIVE' && result.kind === 'WORKER' && asString(context.chain.attempt, 'execution_status') === 'PROVISIONING') {
        await client.query(
          `UPDATE motive.attempts SET execution_status = 'RUNNING', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.chain.attempt, 'id')],
        );
      }
      if (result.state === 'TERMINATED' && result.kind === 'WORKER'
        && ['RESERVED', 'PROVISIONING', 'RUNNING'].includes(asString(context.chain.attempt, 'execution_status'))) {
        await client.query(
          `UPDATE motive.attempts SET execution_status = 'FAILED', updated_at = clock_timestamp() WHERE id = $1`,
          [asString(context.chain.attempt, 'id')],
        );
      }
      return result;
    });
  }

  private async closeAttemptAdmissionLocked(client: PoolClient, chain: Chain): Promise<void> {
    await client.query(
      `UPDATE motive.attempts
       SET admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
           execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING', 'EVALUATING')
               THEN 'CANCEL_REQUESTED'::motive.attempt_execution_status ELSE execution_status END,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [asString(chain.attempt, 'id')],
    );
  }

  private async fenceStoppedWorker(client: PoolClient, chain: Chain, environment: QueryResultRow,
    preserveEvaluation: boolean): Promise<void> {
    if (preserveEvaluation && asString(environment, 'kind') === 'WORKER'
      && chain.attempt.admission_closed_at === null && chain.attempt.cancellation_requested_at === null
      && ['OUTPUT_SEALED', 'EVALUATING', 'WAITING_ACCEPTANCE'].includes(asString(chain.attempt, 'execution_status'))) {
      const seal = await client.query(`SELECT environment_id FROM motive.orchestration_artifact_seals
        WHERE environment_id = $1 AND attempt_id = $2 AND status = 'SEALED'`,
      [asString(environment, 'id'), asString(chain.attempt, 'id')]);
      // OUTPUT_SEALED and subsequent phases already reject inference admission
      // and worker commands. Retain only the independently authorized evaluator
      // phase; never clear a cancellation or an existing admission boundary.
      if (seal.rowCount === 1) return;
    }
    await this.closeAttemptAdmissionLocked(client, chain);
  }

  async closeAttemptAdmission(lease: ControllerLease, environmentId: string,
    options: { preserveEvaluation?: boolean } = {}): Promise<void> {
    await this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      await this.fenceStoppedWorker(client, context.chain, context.environment, options.preserveEvaluation === true);
    });
  }

  async requestStop(lease: ControllerLease, environmentId: string,
    options: { preserveEvaluation?: boolean } = {}): Promise<{ effect: EffectIntent }> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      // This shares the exact attempt-chain transaction with the stop intent.
      // Default cleanup closes all admission. An explicit successful worker
      // handoff relies on its durable sealed phase to block inference while
      // leaving future evaluator admission under the independent authority checks.
      await this.fenceStoppedWorker(client, context.chain, context.environment, options.preserveEvaluation === true);
      const existing = await client.query(
        `SELECT effect.*, command.provider_command_id
         FROM motive.orchestration_effects AS effect
         LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
         WHERE effect.environment_id = $1 AND effect.kind = 'STOP' FOR UPDATE OF effect`,
        [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) return { effect: effectProjection(existing.rows[0]) };
      if (['TERMINATED', 'ABANDONED'].includes(asString(context.environment, 'state'))) {
        fail('ENVIRONMENT_TERMINATED', 'A terminal or abandoned environment does not need a stop request.');
      }
      const effectId = randomUUID();
      await client.query(
        `INSERT INTO motive.orchestration_effects (id, environment_id, attempt_id, kind, effect_key)
         VALUES ($1, $2, $3, 'STOP', $4)`,
        [effectId, asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), `stop:${asString(context.environment, 'id')}`],
      );
      await client.query(
        `UPDATE motive.orchestration_environments SET state = 'STOP_REQUESTED', updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.environment, 'id')],
      );
      const effect = await client.query('SELECT * FROM motive.orchestration_effects WHERE id = $1', [effectId]);
      return { effect: effectProjection(effect.rows[0]) };
    });
  }

  async recordStopResult(lease: ControllerLease, effectId: string, observation: ProviderObservation): Promise<EnvironmentProjection> {
    const observed = assertObservation(observation);
    return this.transaction(async client => {
      const context = await this.lockTrackedEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'STOP') fail('EFFECT_UNAVAILABLE', 'Effect is not a stop intent.');
      if (asString(context.effect, 'state') === 'RESULT_RECORDED') {
        return environmentProjection(context.environment);
      }
      if (asString(context.effect, 'state') !== 'CLAIMED') fail('EFFECT_NOT_CLAIMED', 'Stop result requires the one durable stop claim.');
      this.assertHistoricalClaim(context.chain, context.effect, lease);
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'RESULT_RECORDED', result_recorded_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.effect, 'id')],
      );
      return this.applyObservation(client, context.environment, observed);
    });
  }

  async finishEvaluation(lease: ControllerLease, environmentId: string, evaluationId: string): Promise<void> {
    const evaluation = requireUuid(evaluationId, 'evaluationId');
    await this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'EVALUATOR') {
        fail('ENVIRONMENT_UNAVAILABLE', 'Evaluation completion requires an evaluator environment.');
      }
      const evidence = await client.query(
        `SELECT id FROM motive.evaluations
         WHERE id = $1 AND attempt_id = $2 AND evaluator_environment_id = $3
         FOR KEY SHARE`,
        [evaluation, asString(context.chain.attempt, 'id'), asString(context.environment, 'id')],
      );
      if (evidence.rowCount !== 1) {
        fail('ATTEMPT_UNAVAILABLE', 'Evaluation completion requires durable evidence from the exact evaluator environment.');
      }
      const liveEnvironment = await client.query(
        `SELECT id FROM motive.orchestration_environments
         WHERE attempt_id = $1 AND kind IN ('WORKER', 'EVALUATOR')
           AND state NOT IN ('TERMINATED', 'ABANDONED')
         LIMIT 1`,
        [asString(context.chain.attempt, 'id')],
      );
      if ((liveEnvironment.rowCount ?? 0) > 0) {
        fail('ATTEMPT_UNAVAILABLE', 'Evaluation completion requires every tracked worker and evaluator to be terminal or abandoned.');
      }
      await client.query(
        `UPDATE motive.attempts
         SET admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
             execution_status = CASE
               WHEN cancellation_requested_at IS NOT NULL
                 OR execution_status IN ('CLOSED', 'FAILED', 'CANCELLED') THEN execution_status
               ELSE 'WAITING_ACCEPTANCE'::motive.attempt_execution_status
             END,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.chain.attempt, 'id')],
      );
    });
  }

  async getWorkerWorkspaceBinding(lease: ControllerLease, environmentId: string): Promise<WorkerWorkspaceBindingInput | null> {
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      const profile = context.environment.profile_snapshot as SandboxExecutionProfile;
      validateProfile(profile);
      requireProtectedRuntime(profile);
      const saved = await client.query('SELECT * FROM motive.native_workspace_bindings WHERE environment_id = $1', [environmentId]);
      return saved.rowCount === 1 ? workspaceBindingProjection(saved.rows[0]) : null;
    });
  }

  /** The caller must obtain this through the reviewed native collector. This
   * transaction freezes the first observation; it does not attest an image. */
  async recordWorkerWorkspaceBinding(lease: ControllerLease, environmentId: string, input: WorkerWorkspaceBindingInput): Promise<WorkerWorkspaceBindingInput> {
    const value = structuredClone(input);
    const binding = value?.binding;
    const handle = binding?.handle;
    if (!binding || binding.format !== 'motive.vercel-native-workspace-binding/0.1'
      || typeof binding.workspaceIdentity !== 'string'
      || !/^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/.test(binding.workspaceIdentity)
      || !handle || handle.provider !== 'vercel') fail('VALIDATION', 'Native workspace binding is invalid.');
    requireUuid(handle.attemptId, 'binding.attemptId');
    requirePositiveInteger(handle.leaseEpoch, 'binding.leaseEpoch');
    assertDigest(handle.profileDigest, 'binding.profileDigest');
    assertDigest(binding.runtimeDigest, 'binding.runtimeDigest');
    assertDigest(value.workerRuntimeDigest, 'workerRuntimeDigest');
    if (handle.sandboxId !== sandboxName(handle.attemptId, handle.leaseEpoch)
      || typeof handle.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(handle.sessionId)) {
      fail('VALIDATION', 'Native workspace session identity is invalid.');
    }
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      const environment = context.environment;
      if (asString(environment, 'kind') !== 'WORKER'
        || nullableString(environment, 'provider') !== handle.provider
        || nullableString(environment, 'external_id') !== handle.sandboxId
        || nullableString(environment, 'session_id') !== handle.sessionId
        || nullableString(environment, 'attempt_id') !== handle.attemptId
        || nullableNumber(environment, 'lease_epoch') !== handle.leaseEpoch
        || nullableString(environment, 'profile_digest') !== handle.profileDigest) {
        fail('ENVIRONMENT_UNAVAILABLE', 'Native workspace binding does not match the frozen worker session.');
      }
      const profile = environment.profile_snapshot as SandboxExecutionProfile;
      validateProfile(profile);
      if (requireProtectedRuntime(profile).runtimeDigest !== value.workerRuntimeDigest) {
        fail('ENVIRONMENT_UNAVAILABLE', 'Native workspace binding does not match the protected runtime.');
      }
      const existing = await client.query('SELECT * FROM motive.native_workspace_bindings WHERE environment_id = $1', [environmentId]);
      if (existing.rowCount === 1) {
        const saved = workspaceBindingProjection(existing.rows[0]);
        if (canonicalJson(saved) !== canonicalJson(value)) fail('EFFECT_CONFLICT', 'The original native workspace binding cannot be replaced.');
        return saved;
      }
      if (['TERMINATED', 'ABANDONED'].includes(asString(environment, 'state'))) {
        fail('ENVIRONMENT_UNAVAILABLE', 'A terminal worker cannot acquire a new workspace binding.');
      }
      const command = await client.query(`SELECT id FROM motive.orchestration_effects
        WHERE environment_id = $1 AND attempt_id = $2 AND claimed_lease_epoch = $3
          AND kind = 'COMMAND' AND state IN ('CLAIMED', 'UNKNOWN', 'RESULT_RECORDED')`,
      [environmentId, handle.attemptId, handle.leaseEpoch]);
      if (command.rowCount !== 1) fail('EFFECT_UNAVAILABLE', 'A native bootstrap binding requires a claimed worker command.');
      const saved = await client.query(`INSERT INTO motive.native_workspace_bindings
        (environment_id, attempt_id, provider, external_id, session_id, lease_epoch, controller_generation,
         profile_digest, worker_runtime_digest, collector_runtime_digest, workspace_identity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [environmentId, handle.attemptId, handle.provider, handle.sandboxId, handle.sessionId, handle.leaseEpoch,
        asString(environment, 'controller_generation'), handle.profileDigest, value.workerRuntimeDigest,
        binding.runtimeDigest, binding.workspaceIdentity]);
      return workspaceBindingProjection(saved.rows[0]);
    });
  }

  async recordArtifactSeal(lease: ControllerLease, environmentId: string, input: RecordArtifactSealInput): Promise<ArtifactSealProjection> {
    const manifestDigest = assertDigest(input.manifestDigest, 'manifestDigest');
    const receiptId = assertSafeStoredText(input.receiptId, 'receiptId', 512);
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'WORKER') fail('ENVIRONMENT_UNAVAILABLE', 'Only a worker environment may seal a candidate artifact.');
      if (['TERMINATED', 'ABANDONED'].includes(asString(context.environment, 'state'))) {
        fail('ENVIRONMENT_UNAVAILABLE', 'A terminal worker cannot newly seal an artifact.');
      }
      const existing = await client.query(
        'SELECT * FROM motive.orchestration_artifact_seals WHERE environment_id = $1 FOR UPDATE', [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (asString(row, 'status') === 'SEALED' && nullableString(row, 'manifest_digest') === manifestDigest && asString(row, 'receipt_id') === receiptId) {
          return artifactSealProjection(row);
        }
        fail('ARTIFACT_ALREADY_RECORDED', 'Worker artifact outcome is immutable.');
      }
      await client.query(
        `INSERT INTO motive.orchestration_artifact_seals (environment_id, attempt_id, manifest_digest, receipt_id, status)
         VALUES ($1, $2, $3, $4, 'SEALED')`,
        [asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), manifestDigest, receiptId],
      );
      await client.query(
        `UPDATE motive.attempts
         SET execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING')
             THEN 'OUTPUT_SEALED'::motive.attempt_execution_status ELSE execution_status END,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.chain.attempt, 'id')],
      );
      const inserted = await client.query('SELECT * FROM motive.orchestration_artifact_seals WHERE environment_id = $1', [asString(context.environment, 'id')]);
      return artifactSealProjection(inserted.rows[0]);
    });
  }

  async recordArtifactFailure(lease: ControllerLease, environmentId: string, input: RecordArtifactFailureInput): Promise<ArtifactSealProjection> {
    const receiptId = assertSafeStoredText(input.receiptId, 'receiptId', 512);
    const failureCode = assertSafeStoredText(input.failureCode, 'failureCode', 256);
    await this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId);
      await this.assertCurrentLease(client, context.chain, lease);
      if (asString(context.environment, 'kind') !== 'WORKER') fail('ENVIRONMENT_UNAVAILABLE', 'Only a worker environment may record artifact collection failure.');
      const existing = await client.query(
        'SELECT * FROM motive.orchestration_artifact_seals WHERE environment_id = $1 FOR UPDATE', [asString(context.environment, 'id')],
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (asString(row, 'status') === 'FAILED' && asString(row, 'receipt_id') === receiptId && nullableString(row, 'failure_code') === failureCode) return;
        fail('ARTIFACT_ALREADY_RECORDED', 'Worker artifact outcome is immutable.');
      }
      await client.query(
        `INSERT INTO motive.orchestration_artifact_seals (environment_id, attempt_id, receipt_id, status, failure_code)
         VALUES ($1, $2, $3, 'FAILED', $4)`,
        [asString(context.environment, 'id'), asString(context.chain.attempt, 'id'), receiptId, failureCode],
      );
      await client.query(
        `UPDATE motive.attempts
         SET execution_status = CASE WHEN execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING', 'OUTPUT_SEALED')
             THEN 'FAILED'::motive.attempt_execution_status ELSE execution_status END,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [asString(context.chain.attempt, 'id')],
      );
    });
    const result = await this.pool.query('SELECT * FROM motive.orchestration_artifact_seals WHERE environment_id = $1', [requireUuid(environmentId, 'environmentId')]);
    if (result.rowCount !== 1) throw new Error('Artifact failure was not persisted.');
    return artifactSealProjection(result.rows[0]);
  }

  async settleInfrastructureUsage(lease: ControllerLease, input: SettleInfrastructureUsageInput): Promise<InfrastructureAuthorizationProjection> {
    const environmentId = requireUuid(input.environmentId, 'environmentId');
    const actualCostUsd = exactAmount(input.actualCostUsd, 'actualCostUsd');
    const providerUsageId = assertSafeStoredText(input.providerUsageId, 'providerUsageId', 512);
    const rawProviderAmount = input.rawProviderAmount === undefined
      ? null
      : assertSafeStoredText(input.rawProviderAmount, 'rawProviderAmount', 512);
    if (input.final !== undefined && typeof input.final !== 'boolean') fail('VALIDATION', 'final must be a boolean.');
    const authoritativeFinal = input.final === true;
    if (!authoritativeFinal && compareAmounts(actualCostUsd, ZERO_AMOUNT) === 0) {
      fail('VALIDATION', 'A non-final infrastructure usage record must have a positive cost.');
    }
    return this.transaction(async client => {
      const context = await this.lockTrackedEnvironment(client, environmentId, true);
      await this.assertCurrentLease(client, context.chain, lease);
      if (context.authorization === undefined) throw new Error('Environment has no infrastructure authorization.');
      const authorizationId = asString(context.authorization, 'id');
      const existing = await client.query(
        `SELECT * FROM motive.infrastructure_usage_records
         WHERE infrastructure_authorization_id = $1 AND provider_usage_id = $2 FOR UPDATE`,
        [authorizationId, providerUsageId],
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (asString(row, 'environment_id') !== environmentId
          || asAmount(row, 'amount_usd') !== actualCostUsd
          || asBoolean(row, 'authoritative_final') !== authoritativeFinal) {
          fail('EFFECT_CONFLICT', 'Provider usage identity was already recorded with different usage.');
        }
        return authorizationProjection(context.authorization);
      }
      if (authoritativeFinal) {
        const priorFinal = await client.query(
          `SELECT id FROM motive.infrastructure_usage_records WHERE environment_id = $1 AND authoritative_final = TRUE FOR UPDATE`,
          [environmentId],
        );
        if ((priorFinal.rowCount ?? 0) > 0) fail('EFFECT_CONFLICT', 'Environment already has an authoritative final billing record.');
      }
      const environmentHeld = asAmount(context.environment, 'held_cost_usd');
      const environmentConsumed = asAmount(context.environment, 'consumed_cost_usd');
      const authorizationHeld = asAmount(context.authorization, 'held_usd');
      const authorizationConsumed = asAmount(context.authorization, 'consumed_usd');
      const coveredByHold = minAmount(environmentHeld, actualCostUsd);
      const heldAfterKnownUsage = subtractAmounts(environmentHeld, coveredByHold, 'environment held cost');
      const finalRelease = authoritativeFinal ? heldAfterKnownUsage : ZERO_AMOUNT;
      const releasedFromAuthorization = addAmounts(coveredByHold, finalRelease);
      const nextEnvironmentHeld = subtractAmounts(heldAfterKnownUsage, finalRelease, 'environment held cost');
      const nextEnvironmentConsumed = addAmounts(environmentConsumed, actualCostUsd);
      const nextAuthorizationHeld = subtractAmounts(authorizationHeld, releasedFromAuthorization, 'infrastructure authorization held cost');
      const nextAuthorizationConsumed = addAmounts(authorizationConsumed, actualCostUsd);
      const authorizationOverrun = compareAmounts(
        addAmounts(nextAuthorizationHeld, nextAuthorizationConsumed),
        asAmount(context.authorization, 'limit_usd'),
      ) > 0;
      const environmentOverrun = compareAmounts(nextEnvironmentConsumed, asAmount(context.environment, 'maximum_cost_usd')) > 0;
      const overrun = authorizationOverrun || environmentOverrun;
      const freezeReason = environmentOverrun
        ? 'ENVIRONMENT_COST_RESERVATION_OVERRUN'
        : 'INFRASTRUCTURE_AUTHORIZATION_OVERRUN';

      await client.query(
        `INSERT INTO motive.infrastructure_usage_records (
          id, infrastructure_authorization_id, environment_id, provider_usage_id, amount_usd, raw_provider_amount, authoritative_final
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), authorizationId, environmentId, providerUsageId, actualCostUsd, rawProviderAmount, authoritativeFinal],
      );
      await client.query(
        `UPDATE motive.orchestration_environments
         SET held_cost_usd = $2, consumed_cost_usd = $3, updated_at = clock_timestamp() WHERE id = $1`,
        [environmentId, nextEnvironmentHeld, nextEnvironmentConsumed],
      );
      await client.query(
        `UPDATE motive.infrastructure_authorizations
         SET held_usd = $2, consumed_usd = $3,
             status = CASE WHEN $4::boolean AND status = 'ACTIVE' THEN 'FROZEN'::motive.infrastructure_authorization_status ELSE status END,
             frozen_at = CASE WHEN $4::boolean THEN COALESCE(frozen_at, clock_timestamp()) ELSE frozen_at END,
             freeze_reason = CASE WHEN $4::boolean THEN COALESCE(freeze_reason, $5) ELSE freeze_reason END,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [authorizationId, nextAuthorizationHeld, nextAuthorizationConsumed, overrun, freezeReason],
      );
      const updated = await client.query('SELECT * FROM motive.infrastructure_authorizations WHERE id = $1', [authorizationId]);
      return authorizationProjection(updated.rows[0]);
    });
  }

  async recordOrphan(input: RecordOrphanInput): Promise<{ environment: EnvironmentProjection; effect: EffectIntent }> {
    const kind = input.kind;
    if (kind !== 'WORKER' && kind !== 'EVALUATOR') fail('VALIDATION', 'Orphan kind must be WORKER or EVALUATOR.');
    const handle = assertHandle(input.handle);
    const providerStatus = assertSafeStoredText(input.providerStatus, 'providerStatus', 256);
    const identityDigest = assertDigest(input.identityDigest, 'identityDigest');
    const observedAt = input.observedAt === undefined ? new Date().toISOString() : requireDate(input.observedAt, 'observedAt');
    return this.transaction(async client => {
      await this.lockController(client);
      const known = await client.query(
        `SELECT * FROM motive.orchestration_environments
         WHERE provider = $1 AND external_id = $2 AND session_id = $3
         ORDER BY CASE WHEN state = 'TERMINATED' THEN 1 ELSE 0 END, created_at DESC
         FOR UPDATE`,
        [handle.provider, handle.externalId, handle.sessionId],
      );
      const live = known.rows.find(row => asString(row, 'state') !== 'TERMINATED');
      if (live !== undefined) {
        if (live.attempt_id !== null) {
          fail('EFFECT_CONFLICT', 'Provider identity is already tracked by a live attempt environment.');
        }
        const effect = await client.query(
          `SELECT effect.*, command.provider_command_id
           FROM motive.orchestration_effects AS effect
           LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
           WHERE effect.environment_id = $1 AND effect.kind = 'STOP'`,
          [asString(live, 'id')],
        );
        if (effect.rowCount !== 1) throw new Error('Orphan environment is missing its durable stop intent.');
        return { environment: environmentProjection(live), effect: effectProjection(effect.rows[0]) };
      }
      const capacity = await this.lockCapacity(client);
      const hasTerminalIdentity = known.rows.length > 0;
      const related = await client.query(
        `SELECT session_id FROM motive.orchestration_environments
         WHERE provider = $1 AND external_id = $2 FOR KEY SHARE`,
        [handle.provider, handle.externalId],
      );
      const sessionReplacement = related.rows.some(row => nullableString(row, 'session_id') !== handle.sessionId);
      const environmentId = randomUUID();
      const effectId = randomUUID();
      await client.query(
        `INSERT INTO motive.orchestration_environments (
          id, kind, state, provider, external_id, session_id, provider_status, last_observed_at, orphan_reason, orphan_identity_digest
        ) VALUES ($1, $2, 'ORPHANED', $3, $4, $5, $6, $7, $8, $9)`,
        [
          environmentId, kind, handle.provider, handle.externalId, handle.sessionId,
          providerStatus, observedAt,
          hasTerminalIdentity ? 'PROVIDER_IDENTITY_REAPPEARED' : sessionReplacement ? 'PROVIDER_SESSION_REPLACED' : 'DISCOVERED_UNTRACKED',
          identityDigest,
        ],
      );
      await client.query(
        `INSERT INTO motive.orchestration_effects (id, environment_id, kind, effect_key)
         VALUES ($1, $2, 'STOP', $3)`,
        [effectId, environmentId, `orphan-stop:${environmentId}`],
      );
      await client.query(
        'UPDATE motive.orchestration_capacity SET occupied_count = occupied_count + 1, updated_at = clock_timestamp() WHERE singleton = TRUE',
      );
      // Referencing capacity makes the intent clear in the transaction and
      // prevents an accidental "unused" lock from being optimized away.
      void capacity;
      const environment = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1', [environmentId]);
      const effect = await client.query('SELECT * FROM motive.orchestration_effects WHERE id = $1', [effectId]);
      return { environment: environmentProjection(environment.rows[0]), effect: effectProjection(effect.rows[0]) };
    });
  }

  private async lockOrphanEffect(client: PoolClient, effectId: string): Promise<{ environment: QueryResultRow; effect: QueryResultRow }> {
    const id = requireUuid(effectId, 'effectId');
    await this.lockController(client);
    const reference = await client.query<{ environment_id: string }>(
      'SELECT environment_id FROM motive.orchestration_effects WHERE id = $1', [id],
    );
    if (reference.rowCount !== 1) fail('NOT_FOUND', 'Effect was not found.');
    const environment = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1 FOR UPDATE', [reference.rows[0].environment_id]);
    if (environment.rowCount !== 1) fail('NOT_FOUND', 'Environment was not found.');
    if (environment.rows[0].attempt_id !== null) fail('EFFECT_UNAVAILABLE', 'Tracked environment effects require an attempt lease.');
    const effect = await client.query('SELECT * FROM motive.orchestration_effects WHERE id = $1 FOR UPDATE', [id]);
    if (effect.rowCount !== 1) fail('NOT_FOUND', 'Effect was not found.');
    return { environment: environment.rows[0], effect: effect.rows[0] };
  }

  async claimOrphanStop(reconcilerId: string, effectId: string): Promise<{ effectId: string; claimed: boolean }> {
    const reconciler = requireText(reconcilerId, 'reconcilerId', 512);
    return this.transaction(async client => {
      const context = await this.lockOrphanEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'STOP') fail('EFFECT_UNAVAILABLE', 'Orphan cleanup only supports stop intents.');
      if (asString(context.effect, 'state') !== 'INTENT_RECORDED' || asString(context.environment, 'state') === 'TERMINATED') {
        return { effectId: asString(context.effect, 'id'), claimed: false };
      }
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'CLAIMED', claimed_by = $2, claimed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.effect, 'id'), reconciler],
      );
      await client.query(
        `UPDATE motive.orchestration_environments SET state = 'STOP_REQUESTED', updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.environment, 'id')],
      );
      return { effectId: asString(context.effect, 'id'), claimed: true };
    });
  }

  async markOrphanStopUnknown(reconcilerId: string, effectId: string, reason: string): Promise<void> {
    const reconciler = requireText(reconcilerId, 'reconcilerId', 512);
    const safeReason = assertSafeStoredText(reason, 'reason', 512);
    await this.transaction(async client => {
      const context = await this.lockOrphanEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'STOP' || asString(context.effect, 'state') !== 'CLAIMED'
        || asString(context.effect, 'claimed_by') !== reconciler) {
        fail('EFFECT_NOT_CLAIMED', 'Only the reconciler that claimed an orphan stop may mark it unknown.');
      }
      await client.query(
        `UPDATE motive.orchestration_effects SET state = 'UNKNOWN', unknown_reason = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.effect, 'id'), safeReason],
      );
      await client.query(
        `UPDATE motive.orchestration_environments SET state = 'UNKNOWN', updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.environment, 'id')],
      );
    });
  }

  async recordOrphanStopResult(reconcilerId: string, effectId: string, observation: ProviderObservation): Promise<EnvironmentProjection> {
    const reconciler = requireText(reconcilerId, 'reconcilerId', 512);
    const observed = assertObservation(observation);
    return this.transaction(async client => {
      const context = await this.lockOrphanEffect(client, effectId);
      if (asString(context.effect, 'kind') !== 'STOP') fail('EFFECT_UNAVAILABLE', 'Effect is not an orphan stop intent.');
      if (asString(context.effect, 'state') === 'RESULT_RECORDED') return environmentProjection(context.environment);
      if (asString(context.effect, 'state') !== 'CLAIMED' || asString(context.effect, 'claimed_by') !== reconciler) {
        fail('EFFECT_NOT_CLAIMED', 'Only the reconciler that claimed an orphan stop may record its result.');
      }
      await client.query(
        `UPDATE motive.orchestration_effects
         SET state = 'RESULT_RECORDED', result_recorded_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
        [asString(context.effect, 'id')],
      );
      return this.applyObservation(client, context.environment, observed);
    });
  }

  async recordOrphanObservation(environmentId: string, observation: ProviderObservation): Promise<EnvironmentProjection> {
    const id = requireUuid(environmentId, 'environmentId');
    const observed = assertObservation(observation);
    return this.transaction(async client => {
      await this.lockController(client);
      const environment = await client.query('SELECT * FROM motive.orchestration_environments WHERE id = $1 FOR UPDATE', [id]);
      if (environment.rowCount !== 1) fail('NOT_FOUND', 'Environment was not found.');
      if (environment.rows[0].attempt_id !== null) fail('ENVIRONMENT_UNAVAILABLE', 'Tracked environments require their attempt lease for observations.');
      return this.applyObservation(client, environment.rows[0], observed);
    });
  }

  async listReconciliationCandidates(limit: number): Promise<readonly ReconciliationCandidate[]> {
    const bounded = requirePositiveInteger(limit, 'limit', 500);
    const environments = await this.pool.query(
      `SELECT environment.*
       FROM motive.orchestration_environments AS environment
       WHERE environment.state NOT IN ('TERMINATED', 'ABANDONED')
         AND (
           environment.state IN ('UNKNOWN', 'ORPHANED', 'STOP_REQUESTED')
           OR environment.last_observed_at IS NULL
           OR environment.last_observed_at < clock_timestamp() - INTERVAL '5 minutes'
           OR EXISTS (
             SELECT 1 FROM motive.orchestration_effects AS effect
             WHERE effect.environment_id = environment.id AND effect.state IN ('CLAIMED', 'UNKNOWN')
           )
         )
       ORDER BY CASE environment.state WHEN 'UNKNOWN' THEN 0 WHEN 'ORPHANED' THEN 1 WHEN 'STOP_REQUESTED' THEN 2 ELSE 3 END,
                environment.last_observed_at NULLS FIRST, environment.created_at, environment.id
       LIMIT $1`,
      [bounded],
    );
    if (environments.rowCount === 0) return [];
    const ids = environments.rows.map(row => asString(row, 'id'));
    const effects = await this.pool.query(
      `SELECT effect.*, command.provider_command_id
       FROM motive.orchestration_effects AS effect
       LEFT JOIN motive.orchestration_commands AS command ON command.effect_id = effect.id
       WHERE effect.environment_id = ANY($1::uuid[]) ORDER BY effect.created_at, effect.id`,
      [ids],
    );
    const byEnvironment = new Map<string, EffectIntent[]>();
    for (const row of effects.rows) {
      const effect = effectProjection(row);
      const current = byEnvironment.get(effect.environmentId) ?? [];
      current.push(effect);
      byEnvironment.set(effect.environmentId, current);
    }
    return environments.rows.map(row => {
      const environment = environmentProjection(row);
      const effectsForEnvironment = byEnvironment.get(environment.id) ?? [];
      let reason: ReconciliationCandidate['reason'] = 'ENVIRONMENT_UNOBSERVED';
      const unknown = effectsForEnvironment.find(effect => effect.state === 'UNKNOWN');
      const claimed = effectsForEnvironment.find(effect => effect.state === 'CLAIMED');
      const effect = unknown ?? claimed;
      if (effect?.kind === 'CREATE') reason = 'CREATE_UNRESOLVED';
      else if (effect?.kind === 'COMMAND') reason = 'COMMAND_UNRESOLVED';
      else if (effect?.kind === 'STOP') reason = 'STOP_UNRESOLVED';
      else if (environment.state === 'ORPHANED') reason = 'ORPHANED';
      else if (environment.state === 'STOP_REQUESTED') reason = 'STOP_REQUESTED';
      return { environment, effects: effectsForEnvironment, reason };
    });
  }

  async claimDeliveryBatch(input: ClaimDeliveryBatchInput): Promise<readonly DeliveryClaim[]> {
    const consumerId = requireText(input.consumerId, 'consumerId', 512);
    const limit = requirePositiveInteger(input.limit, 'limit', 100);
    const leaseMs = requirePositiveInteger(input.leaseMs, 'leaseMs', 15 * 60 * 1_000);
    if (!Array.isArray(input.topics) || input.topics.length === 0 || input.topics.length > 32) {
      fail('VALIDATION', 'topics must contain one to 32 explicitly supported topics.');
    }
    const topics = [...new Set(input.topics.map((topic, index) => assertSafeStoredText(topic, `topics[${index}]`, 256)))];
    const scope = input.attemptScope;
    if (scope && scope.kind !== 'PROJECT_LEAD_ACTIVATION') fail('VALIDATION', 'attemptScope kind is unsupported.');
    const projectSlug = scope ? requireText(scope.projectSlug, 'attemptScope.projectSlug', 200) : null;
    const beneficiaryActorId = scope ? requireText(scope.beneficiaryActorId, 'attemptScope.beneficiaryActorId', 512) : null;
    return this.transaction(async client => {
      const candidates = await client.query(
        `SELECT outbox.* FROM motive.outbox AS outbox
         WHERE delivered_at IS NULL
           AND available_at <= clock_timestamp()
           AND topic = ANY($1::text[])
           AND (delivery_claim_token IS NULL OR delivery_claim_expires_at <= clock_timestamp())
           AND (
             claimed_at IS NULL
             OR delivery_claim_token IS NOT NULL
             OR claimed_at < clock_timestamp() - INTERVAL '5 minutes'
           )
           ${scope ? `AND outbox.aggregate_type='attempt'
           AND EXISTS (
             SELECT 1 FROM motive.provider_budget_activations AS activation
             JOIN motive.work_orders AS work ON work.id=activation.work_order_id
             JOIN motive.projects AS project ON project.id=work.project_id
             WHERE activation.attempt_id=outbox.aggregate_id
               AND activation.assigned_agent_id IS NULL
               AND activation.beneficiary_actor_id=$3
               AND project.slug=$4
           )` : ''}
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        scope ? [topics, limit, beneficiaryActorId, projectSlug] : [topics, limit],
      );
      const claims: DeliveryClaim[] = [];
      for (const row of candidates.rows) {
        const claimToken = randomUUID();
        const updated = await client.query(
          `UPDATE motive.outbox
           SET claimed_at = clock_timestamp(), claimed_by = $2,
               delivery_claim_token = $3, delivery_claim_expires_at = clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
               delivery_attempts = delivery_attempts + 1
           WHERE id = $1
           RETURNING delivery_claim_expires_at, delivery_attempts`,
          [asString(row, 'id'), consumerId, claimToken, leaseMs],
        );
        if (updated.rowCount !== 1) throw new Error('Fenced outbox claim disappeared while locked.');
        const updatedRow = updated.rows[0];
        claims.push({
          outboxId: asString(row, 'id'),
          claimToken,
          expiresAt: dateOrNull(updatedRow.delivery_claim_expires_at) ?? (() => { throw new Error('Delivery claim expiry is missing.'); })(),
          message: outboxMessage(row, asNumber(updatedRow, 'delivery_attempts')),
        });
      }
      return claims;
    });
  }

  async acknowledgeDelivery(input: AcknowledgeDeliveryInput): Promise<boolean> {
    const outboxId = requireUuid(input.outboxId, 'outboxId');
    const claimToken = requireUuid(input.claimToken, 'claimToken');
    const triggerRunId = assertSafeStoredText(input.triggerRunId, 'triggerRunId', 512);
    return this.transaction(async client => {
      const result = await client.query(
        `UPDATE motive.outbox
         SET trigger_run_id = $3, delivered_at = clock_timestamp(),
             delivery_claim_token = NULL, delivery_claim_expires_at = NULL
         WHERE id = $1
           AND delivered_at IS NULL
           AND delivery_claim_token = $2::uuid
           AND delivery_claim_expires_at > clock_timestamp()`,
        [outboxId, claimToken, triggerRunId],
      );
      return result.rowCount === 1;
    });
  }

  async deferDelivery(input: DeferDeliveryInput): Promise<boolean> {
    const outboxId = requireUuid(input.outboxId, 'outboxId');
    const claimToken = requireUuid(input.claimToken, 'claimToken');
    const retryAt = requireDate(input.retryAt, 'retryAt');
    const errorCode = assertSafeStoredText(input.errorCode, 'errorCode', 256);
    return this.transaction(async client => {
      const result = await client.query(
        `UPDATE motive.outbox
         SET available_at = $3, last_error = $4, delivery_last_error_code = $4,
             claimed_at = NULL, claimed_by = NULL,
             delivery_claim_token = NULL, delivery_claim_expires_at = NULL
         WHERE id = $1
           AND delivered_at IS NULL
           AND delivery_claim_token = $2::uuid
           AND delivery_claim_expires_at > clock_timestamp()
           AND $3::timestamptz > clock_timestamp()`,
        [outboxId, claimToken, retryAt, errorCode],
      );
      return result.rowCount === 1;
    });
  }
}
