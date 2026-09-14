import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import { Sandbox } from '@vercel/sandbox';
import { Pool } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment } from '../../packages/accounting/src/migrations.ts';
import {
  ArtifactSealer,
  ArtifactStorageError,
  SupabaseImmutableObjectStore,
  type ArtifactApprovalPolicy,
  type ImmutableObjectStore,
  type SafeArtifactReader,
  type SafeArtifactSnapshot,
} from '../../packages/artifact-storage/src/index.ts';
import type { CoordinatorDependencies } from '../../packages/orchestration/src/coordinator.ts';
import {
  WORKSPACE_ROOT,
  createNativeVercelSdkFactory,
  createSingleAttemptFetch,
  ownerTags,
  requireWorkerExecutionBoundary,
  validateProfile,
  sandboxName,
  type NativeVercelCredentials,
  type SandboxExecutionProfile,
  type SandboxHandle,
} from '../../packages/sandbox-vercel/src/index.ts';
import type { HostedCircleResultSummary } from '../../src/lib/hosted-results.ts';
import {
  AccountService,
  PostgresAccountStore,
  createSupabaseAccountAuthority,
} from '../accounts/index.ts';
import { isLocalAccountIdentityActive } from '../accounts/local-identity.ts';
import { createCircleResultsService, type CircleResultsService } from '../circle-results/index.ts';
import { createResearchMemoryService } from '../research-memory/index.ts';
import { parseFundingVaultKey } from '../funding/vault.ts';
import { createProjectRunResearchContextResolver } from './research-context.ts';
import {
  CIRCLE_PROJECT_LEAD_ACTOR_ID,
  CircleProjectRunDispatcher,
  type ProjectRunDispatchResult,
} from './dispatcher.ts';
import { loadCircleProjectRunConfig, type CircleProjectRunReadinessReason } from './config.ts';

export const CIRCLE_PROVIDER_DATA_COLLECTOR_CONTRACT =
  'motive.circle-provider-data-collector/0.1\nprovider=vercel-sandbox\npath=/vercel/sandbox/workspace/candidate.json\nmedia_type=application/json\nmaximum_bytes=32768\nownership=exact-attempt-lease-profile-tags\nsession=exact-nonpersistent-running\nsource=exact-reviewed-snapshot-or-image\nfilesystem_claim=none\nvisibility=private-pending-evaluation\n';
export const CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST =
  `sha256:${createHash('sha256').update(CIRCLE_PROVIDER_DATA_COLLECTOR_CONTRACT).digest('hex')}` as const;
export const CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_CONTRACT =
  'motive.circle-provider-data-collector/0.2\nprovider=vercel-sandbox\npath=/vercel/sandbox/workspace/candidate.json\nmedia_type=application/json\nmaximum_bytes=32768\npath=/vercel/sandbox/workspace/investigation.json\nmedia_type=application/json\nmaximum_bytes=16384\navailability=required-on-success-optional-on-failure\nmaximum_files=2\nmaximum_total_bytes=49152\nownership=exact-attempt-lease-profile-tags\nsession=exact-nonpersistent-running\nsource=exact-reviewed-snapshot-or-image\nfilesystem_claim=none\nvisibility=private-pending-evaluation\n';
export const CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST =
  `sha256:${createHash('sha256').update(CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_CONTRACT).digest('hex')}` as const;
const CANDIDATE_PATH = 'candidate.json';
const CANDIDATE_MEDIA_TYPE = 'application/json';
const MAX_CANDIDATE_BYTES = 32 * 1024;
const INVESTIGATION_PATH = 'investigation.json';
const INVESTIGATION_MEDIA_TYPE = 'application/json';
const MAX_INVESTIGATION_BYTES = 16 * 1024;
const MAX_LEARNING_BYTES = MAX_CANDIDATE_BYTES + MAX_INVESTIGATION_BYTES;
const READ_TIMEOUT_MS = 15_000;
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

type ProviderSession = {
  sessionId: string;
  status: string;
  readFile(input: { path: string }, options: { signal: AbortSignal }): Promise<NodeJS.ReadableStream | null>;
};
type ProviderSandbox = {
  name: string;
  persistent: boolean;
  status: string;
  sourceSnapshotId?: string;
  image?: string;
  tags?: Record<string, string>;
  currentSession(): ProviderSession;
};
export type CircleCandidateSandboxLookup = (input: {
  name: string;
  credentials: NativeVercelCredentials;
  signal: AbortSignal;
}) => Promise<ProviderSandbox>;

function collectorFail(code: string, message: string): never {
  throw new ArtifactStorageError(code, message);
}
function exactSource(profile: SandboxExecutionProfile, sandbox: ProviderSandbox): boolean {
  return profile.trustedSource.kind === 'snapshot'
    ? sandbox.sourceSnapshotId === profile.trustedSource.snapshotId
    : sandbox.image === profile.trustedSource.image;
}
function exactTags(handle: SandboxHandle, sandbox: ProviderSandbox): boolean {
  const expected = ownerTags(handle.attemptId, handle.leaseEpoch, handle.profileDigest);
  return Object.entries(expected).every(([key, value]) => sandbox.tags?.[key] === value);
}
function assertCircleWorkerBoundary(profile: SandboxExecutionProfile): void {
  try {
    const boundary = requireWorkerExecutionBoundary(profile);
    if (boundary.kind === 'provider-untrusted-circle-data') validateProfile(profile);
  } catch {
    collectorFail('CIRCLE_COLLECTION_BOUNDARY_INVALID', 'Circle collection requires an explicit valid worker boundary.');
  }
}
async function boundedProviderBytes(
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  signal: AbortSignal,
  relativePath = CANDIDATE_PATH,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const destroy = () => (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void })
    .destroy?.(new Error('Circle candidate read cancelled.'));
  signal.addEventListener('abort', destroy, { once: true });
  try {
    for await (const raw of stream as NodeJS.ReadableStream & AsyncIterable<unknown>) {
      signal.throwIfAborted();
      if (!(raw instanceof Uint8Array) || raw.byteLength < 1) {
        collectorFail('CIRCLE_PROVIDER_STREAM_INVALID', 'Provider returned a non-byte or empty chunk.');
      }
      total += raw.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        destroy();
        collectorFail(relativePath === CANDIDATE_PATH ? 'CIRCLE_CANDIDATE_BYTES_EXCEEDED' : 'CIRCLE_INVESTIGATION_BYTES_EXCEEDED',
          `${relativePath} exceeded its frozen ${maximumBytes / 1024} KiB limit.`);
      }
      chunks.push(Uint8Array.from(raw));
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', destroy);
  }
  if (total < 1) collectorFail(relativePath === CANDIDATE_PATH ? 'CIRCLE_CANDIDATE_EMPTY' : 'CIRCLE_INVESTIGATION_EMPTY',
    `${relativePath} is empty.`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function providerLookup(rawFetch: typeof globalThis.fetch = globalThis.fetch): CircleCandidateSandboxLookup {
  const singleAttempt = createSingleAttemptFetch(rawFetch);
  return async ({ name, credentials, signal }) => {
    const fetch: typeof globalThis.fetch = (input, init) => singleAttempt(input, { ...init, signal });
    return Sandbox.get({ name, resume: false, ...credentials, fetch }) as unknown as ProviderSandbox;
  };
}

/** Reads one fixed untrusted-data file from the exact already-owned Vercel session. */
export class VercelCircleCandidateReader implements SafeArtifactReader {
  private readonly lookup: CircleCandidateSandboxLookup;
  constructor(private readonly options: {
    credentials: NativeVercelCredentials;
    profile: SandboxExecutionProfile;
    lookup?: CircleCandidateSandboxLookup;
    readTimeoutMs?: number;
  }) {
    this.lookup = options.lookup ?? providerLookup();
    if (options.readTimeoutMs !== undefined
        && (!Number.isSafeInteger(options.readTimeoutMs) || options.readTimeoutMs < 100 || options.readTimeoutMs > 30_000)) {
      collectorFail('CIRCLE_COLLECTOR_CONFIG_INVALID', 'Circle candidate read timeout is invalid.');
    }
  }
  async assertReady(input: { signal: AbortSignal }) {
    input.signal.throwIfAborted();
    assertCircleWorkerBoundary(this.options.profile);
    const artifacts = this.options.profile.artifacts;
    if (artifacts.maxFiles !== 1 || artifacts.maxFileBytes !== MAX_CANDIDATE_BYTES
        || artifacts.maxTotalBytes !== MAX_CANDIDATE_BYTES) {
      collectorFail('CIRCLE_COLLECTOR_CONFIG_INVALID', 'Circle data collection requires the exact one-file 32 KiB profile.');
    }
    return { capability: 'provider-session-untrusted-data-v1' as const };
  }
  async capture(input: Parameters<SafeArtifactReader['capture']>[0]): Promise<SafeArtifactSnapshot | null> {
    assertCircleWorkerBoundary(this.options.profile);
    if (input.relativePath !== CANDIDATE_PATH || input.maximumBytes !== MAX_CANDIDATE_BYTES
        || !Number.isSafeInteger(input.maximumChunkBytes) || input.maximumChunkBytes < 1
        || input.handle.provider !== 'vercel' || input.handle.profileDigest !== this.options.profile.profileDigest
        || input.handle.sandboxId !== sandboxName(input.handle.attemptId, input.handle.leaseEpoch)) {
      collectorFail('CIRCLE_COLLECTION_BINDING_INVALID', 'Circle candidate collection bindings are invalid.');
    }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.options.readTimeoutMs ?? READ_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const sandbox = await this.lookup({ name: input.handle.sandboxId, credentials: this.options.credentials, signal });
    const session = sandbox.currentSession();
    if (sandbox.name !== input.handle.sandboxId || sandbox.persistent || sandbox.status !== 'running'
        || session.sessionId !== input.handle.sessionId || session.status !== 'running'
        || !exactSource(this.options.profile, sandbox) || !exactTags(input.handle, sandbox)) {
      collectorFail('CIRCLE_PROVIDER_SESSION_CHANGED', 'Provider session, source, state, or ownership no longer matches the frozen run.');
    }
    const stream = await session.readFile({ path: `${WORKSPACE_ROOT}/${CANDIDATE_PATH}` }, { signal });
    if (stream === null) return null;
    const bytes = await boundedProviderBytes(stream, MAX_CANDIDATE_BYTES, signal);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      relativePath: CANDIDATE_PATH, kind: 'unknown', linkCount: 0, declaredBytes: bytes.byteLength,
      identityToken: `provider-session:${input.handle.sessionId}:sha256:${digest}`,
      resolution: 'exact-provider-session-fixed-path', immutableSnapshot: true,
      read: () => (async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += input.maximumChunkBytes) {
          yield bytes.slice(offset, Math.min(bytes.byteLength, offset + input.maximumChunkBytes));
        }
      })(),
    };
  }
}

/** Reads only the two frozen untrusted JSON data paths used by the learning profile. */
export class VercelCircleLearningReader implements SafeArtifactReader {
  private readonly lookup: CircleCandidateSandboxLookup;
  constructor(private readonly options: {
    credentials: NativeVercelCredentials;
    profile: SandboxExecutionProfile;
    lookup?: CircleCandidateSandboxLookup;
    readTimeoutMs?: number;
  }) {
    this.lookup = options.lookup ?? providerLookup();
    if (options.readTimeoutMs !== undefined
        && (!Number.isSafeInteger(options.readTimeoutMs) || options.readTimeoutMs < 100 || options.readTimeoutMs > 30_000)) {
      collectorFail('CIRCLE_COLLECTOR_CONFIG_INVALID', 'Circle learning-data read timeout is invalid.');
    }
  }
  async assertReady(input: { signal: AbortSignal }) {
    input.signal.throwIfAborted();
    assertCircleWorkerBoundary(this.options.profile);
    const artifacts = this.options.profile.artifacts;
    if (artifacts.maxFiles !== 2 || artifacts.maxFileBytes !== MAX_CANDIDATE_BYTES
        || artifacts.maxTotalBytes !== MAX_LEARNING_BYTES) {
      collectorFail('CIRCLE_COLLECTOR_CONFIG_INVALID', 'Circle learning collection requires the exact two-file 48 KiB profile.');
    }
    return { capability: 'provider-session-untrusted-data-v2' as const };
  }
  async capture(input: Parameters<SafeArtifactReader['capture']>[0]): Promise<SafeArtifactSnapshot | null> {
    assertCircleWorkerBoundary(this.options.profile);
    const maximumBytes = input.relativePath === CANDIDATE_PATH ? MAX_CANDIDATE_BYTES
      : input.relativePath === INVESTIGATION_PATH ? MAX_INVESTIGATION_BYTES : null;
    if (maximumBytes === null || input.maximumBytes !== maximumBytes
        || !Number.isSafeInteger(input.maximumChunkBytes) || input.maximumChunkBytes < 1
        || input.handle.provider !== 'vercel' || input.handle.profileDigest !== this.options.profile.profileDigest
        || input.handle.sandboxId !== sandboxName(input.handle.attemptId, input.handle.leaseEpoch)) {
      collectorFail('CIRCLE_COLLECTION_BINDING_INVALID', 'Circle learning-data collection bindings are invalid.');
    }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.options.readTimeoutMs ?? READ_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const sandbox = await this.lookup({ name: input.handle.sandboxId, credentials: this.options.credentials, signal });
    const session = sandbox.currentSession();
    if (sandbox.name !== input.handle.sandboxId || sandbox.persistent || sandbox.status !== 'running'
        || session.sessionId !== input.handle.sessionId || session.status !== 'running'
        || !exactSource(this.options.profile, sandbox) || !exactTags(input.handle, sandbox)) {
      collectorFail('CIRCLE_PROVIDER_SESSION_CHANGED', 'Provider session, source, state, or ownership no longer matches the frozen run.');
    }
    const stream = await session.readFile({ path: `${WORKSPACE_ROOT}/${input.relativePath}` }, { signal });
    if (stream === null) return null;
    const bytes = await boundedProviderBytes(stream, maximumBytes, signal, input.relativePath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      relativePath: input.relativePath, kind: 'unknown', linkCount: 0, declaredBytes: bytes.byteLength,
      identityToken: `provider-session:${input.handle.sessionId}:sha256:${digest}`,
      resolution: 'exact-provider-session-fixed-path', immutableSnapshot: true,
      read: () => (async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += input.maximumChunkBytes) {
          yield bytes.slice(offset, Math.min(bytes.byteLength, offset + input.maximumChunkBytes));
        }
      })(),
    };
  }
}

function exactCircleCollection(plan: Parameters<ArtifactApprovalPolicy['assertReady']>[0]): boolean {
  const collection = plan.nativeCollection;
  const path = collection?.approvedPaths[0];
  return collection?.collectorRuntimeDigest === CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST
    && collection.maximumFileBytes === MAX_CANDIDATE_BYTES && collection.maximumTotalBytes === MAX_CANDIDATE_BYTES
    && collection.approvedPaths.length === 1 && path?.relativePath === CANDIDATE_PATH
    && path.mediaType === CANDIDATE_MEDIA_TYPE && path.availability === 'REQUIRED'
    && path.maximumBytes === MAX_CANDIDATE_BYTES;
}
function circlePolicy(): ArtifactApprovalPolicy {
  return {
    async assertReady(plan, { signal }) {
      signal.throwIfAborted();
      if (!exactCircleCollection(plan)) collectorFail('CIRCLE_COLLECTION_PLAN_INVALID', 'Circle artifact plan is not the reviewed fixed data plan.');
      return { capability: 'trusted-operator-artifact-policy-v1' };
    },
    async approvedPaths({ plan, signal }) {
      signal.throwIfAborted();
      if (!exactCircleCollection(plan)) collectorFail('CIRCLE_COLLECTION_PLAN_INVALID', 'Circle artifact plan is not the reviewed fixed data plan.');
      return [{ relativePath: CANDIDATE_PATH, mediaType: CANDIDATE_MEDIA_TYPE, availability: 'REQUIRED' }];
    },
  };
}

function exactCircleLearningCollection(plan: Parameters<ArtifactApprovalPolicy['assertReady']>[0]): boolean {
  const collection = plan.nativeCollection;
  const [candidate, investigation] = collection?.approvedPaths ?? [];
  return collection?.collectorRuntimeDigest === CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST
    && collection.maximumFileBytes === MAX_CANDIDATE_BYTES && collection.maximumTotalBytes === MAX_LEARNING_BYTES
    && collection.approvedPaths.length === 2 && candidate?.relativePath === CANDIDATE_PATH
    && candidate.mediaType === CANDIDATE_MEDIA_TYPE && candidate.availability === 'REQUIRED'
    && candidate.maximumBytes === MAX_CANDIDATE_BYTES && investigation?.relativePath === INVESTIGATION_PATH
    && investigation.mediaType === INVESTIGATION_MEDIA_TYPE && investigation.availability === 'OPTIONAL_ON_FAILURE'
    && investigation.maximumBytes === MAX_INVESTIGATION_BYTES;
}
function circleLearningPolicy(): ArtifactApprovalPolicy {
  return {
    async assertReady(plan, { signal }) {
      signal.throwIfAborted();
      if (!exactCircleLearningCollection(plan)) collectorFail('CIRCLE_COLLECTION_PLAN_INVALID', 'Circle learning plan is not the reviewed fixed data plan.');
      return { capability: 'trusted-operator-artifact-policy-v1' };
    },
    async approvedPaths({ plan, signal }) {
      signal.throwIfAborted();
      if (!exactCircleLearningCollection(plan)) collectorFail('CIRCLE_COLLECTION_PLAN_INVALID', 'Circle learning plan is not the reviewed fixed data plan.');
      return [
        { relativePath: CANDIDATE_PATH, mediaType: CANDIDATE_MEDIA_TYPE, availability: 'REQUIRED' },
        { relativePath: INVESTIGATION_PATH, mediaType: INVESTIGATION_MEDIA_TYPE, availability: 'OPTIONAL_ON_FAILURE' },
      ];
    },
  };
}

export function createCircleCandidateArtifactCollector(input: {
  reader: SafeArtifactReader;
  store: ImmutableObjectStore;
}): CoordinatorDependencies['artifacts'] {
  const sealer = new ArtifactSealer({ reader: input.reader, store: input.store, policy: circlePolicy(),
    readerMode: 'provider-session-untrusted-circle-candidate-v1', maximumChunkBytes: 16 * 1024 });
  return {
    assertReady: plan => sealer.assertReady(plan),
    seal: ({ lease: _lease, ...sealInput }) => sealer.seal(sealInput),
  };
}

export function createCircleLearningArtifactCollector(input: {
  reader: SafeArtifactReader;
  store: ImmutableObjectStore;
}): CoordinatorDependencies['artifacts'] {
  const sealer = new ArtifactSealer({ reader: input.reader, store: input.store, policy: circleLearningPolicy(),
    readerMode: 'provider-session-untrusted-circle-learning-v2', maximumChunkBytes: 16 * 1024 });
  return {
    assertReady: plan => sealer.assertReady(plan),
    seal: ({ lease: _lease, ...sealInput }) => sealer.seal(sealInput),
  };
}

/** Selects only one of the two pinned circle data profiles; unknown digests stay unavailable. */
export function createCircleProviderArtifactCollector(input: {
  collectorRuntimeDigest: string;
  credentials: NativeVercelCredentials;
  profile: SandboxExecutionProfile;
  store: ImmutableObjectStore;
  lookup?: CircleCandidateSandboxLookup;
}): CoordinatorDependencies['artifacts'] | null {
  if (input.collectorRuntimeDigest === CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST) {
    const reader = new VercelCircleCandidateReader({ credentials: input.credentials, profile: input.profile,
      ...(input.lookup ? { lookup: input.lookup } : {}) });
    return createCircleCandidateArtifactCollector({ reader, store: input.store });
  }
  if (input.collectorRuntimeDigest === CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST) {
    const reader = new VercelCircleLearningReader({ credentials: input.credentials, profile: input.profile,
      ...(input.lookup ? { lookup: input.lookup } : {}) });
    return createCircleLearningArtifactCollector({ reader, store: input.store });
  }
  return null;
}

/** Reuses the storage environment contract without opening account or Postgres stores. */
export function createCircleArtifactObjectStore(env: EnvironmentSource = process.env): SupabaseImmutableObjectStore | null {
  const config = loadCircleProjectRunConfig(env);
  if (!config.objectStore) return null;
  const client = createClient(config.objectStore.url, config.objectStore.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseImmutableObjectStore(client, config.objectStore.bucket);
}

export type CircleProjectRunApplicationReadinessReason = CircleProjectRunReadinessReason
  | 'DATABASE_UNAVAILABLE' | 'DATABASE_SCHEMA_MISMATCH' | 'RUNTIME_COMPONENT_INVALID'
  | 'RESEARCH_MEMORY_KEY_REQUIRED';
export type CircleProjectRunApplicationReadiness = {
  ready: boolean;
  reasons: readonly CircleProjectRunApplicationReadinessReason[];
  components: {
    database: boolean; runtimeBundle: boolean; vercelAdapter: boolean;
    exactSessionCircleCollector: boolean; immutableObjectStore: boolean; accountActivity: boolean;
  };
};
export type CircleProjectRunApplicationResult = {
  budgetId: string;
  readiness: CircleProjectRunApplicationReadiness;
  dispatch: ProjectRunDispatchResult | null;
  evaluation: HostedCircleResultSummary | null;
  closure: Pick<AttemptProjection, 'executionStatus' | 'consumedAmount' | 'availableAmount'> | null;
};
export interface CircleProjectRunApplication {
  readiness(): CircleProjectRunApplicationReadiness;
  reconcileBudget(budgetId: string): Promise<CircleProjectRunApplicationResult>;
  reconcileAttempt(attemptId: string): Promise<{ attemptId: string; status: string }>;
  reconcileOrphans(): Promise<unknown>;
  close(): Promise<void>;
}
function add(reasons: CircleProjectRunApplicationReadinessReason[], reason: CircleProjectRunApplicationReadinessReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
function closureKey(attemptId: string): string {
  const bytes = createHash('sha256').update(`motive.circle-project-run.close\0${attemptId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function closeEvaluatedCircleAttempt(
  ledger: Pick<LedgerKernel, 'closeAttempt'>,
  attemptId: string,
): Promise<Pick<AttemptProjection, 'executionStatus' | 'consumedAmount' | 'availableAmount'>> {
  const closed = await ledger.closeAttempt({ actorId: 'operator:seed', idempotencyKey: closureKey(attemptId), attemptId });
  return { executionStatus: closed.executionStatus, consumedAmount: closed.consumedAmount,
    availableAmount: closed.availableAmount };
}

export async function persistAndCloseSealedCircleAttempt(input: {
  attemptId: string;
  evaluator: Pick<CircleResultsService, 'evaluateAttempt'>;
  ledger: Pick<LedgerKernel, 'closeAttempt'>;
}): Promise<{ attemptId: string; status: 'REVIEW_READY' }> {
  await input.evaluator.evaluateAttempt(input.attemptId);
  const closure = await closeEvaluatedCircleAttempt(input.ledger, input.attemptId);
  if (closure.executionStatus !== 'CLOSED') throw new Error('PROJECT_RUN_FINANCIAL_CLOSURE_INCOMPLETE');
  return { attemptId: input.attemptId, status: 'REVIEW_READY' };
}

export async function createCircleProjectRunApplication(env: EnvironmentSource = process.env): Promise<CircleProjectRunApplication> {
  const config = loadCircleProjectRunConfig(env);
  const reasons = [...config.readinessReasons] as CircleProjectRunApplicationReadinessReason[];
  let pool: Pool | null = null;
  let accountDatabase: Database.Database | null = null;
  let accountService: AccountService | null = null;
  let dispatcher: CircleProjectRunDispatcher | null = null;
  let databaseReady = false, collectorReady = false, objectStoreReady = false, vercelAdapterReady = false;
  if (config.databaseConfigured) {
    try {
      pool = new Pool(postgresPoolConfigFromEnvironment(env as NodeJS.ProcessEnv));
      const schema = await getPostgresSchemaStatus(pool);
      if (schema.exact) databaseReady = true; else add(reasons, 'DATABASE_SCHEMA_MISMATCH');
    } catch {
      await pool?.end().catch(() => undefined); pool = null; add(reasons, 'DATABASE_UNAVAILABLE');
    }
  }
  if (config.accountDatabasePath) {
    try {
      const { default: BetterSqliteDatabase } = await import('better-sqlite3');
      accountDatabase = new BetterSqliteDatabase(config.accountDatabasePath, { readonly: true, fileMustExist: true });
    }
    catch { add(reasons, 'ACCOUNT_STORE_REQUIRED'); }
  }
  if (config.accountProvider === 'supabase' && pool && config.accountSupabase) {
    try {
      accountService = new AccountService({
        store: new PostgresAccountStore(pool),
        remote: createSupabaseAccountAuthority(config.accountSupabase),
        pool,
      });
    } catch {
      add(reasons, 'ACCOUNT_STORE_REQUIRED');
    }
  }
  let objectStore: SupabaseImmutableObjectStore | null = null;
  if (config.objectStore) {
    try { objectStore = createCircleArtifactObjectStore(env); objectStoreReady = objectStore !== null; }
    catch { add(reasons, 'OBJECT_STORE_CONFIGURATION_REQUIRED'); }
  }
  if (pool && config.vercel) {
    try {
      const sdk = createNativeVercelSdkFactory(config.vercel);
      vercelAdapterReady = true;
      let artifacts;
      if (config.runtimeBundle && objectStore) {
        artifacts = createCircleProviderArtifactCollector({
          collectorRuntimeDigest: config.runtimeBundle.runtime.nativeCollection.collectorRuntimeDigest,
          credentials: config.vercel, profile: config.runtimeBundle.runtime.sandbox, store: objectStore,
        }) ?? undefined;
        if (artifacts) collectorReady = true; else add(reasons, 'RUNTIME_COMPONENT_INVALID');
      }
      const isActorActive = async (actorId: string) => {
        if (config.accountProvider === 'supabase') {
          return Boolean(accountService && await accountService.isActorActive(actorId));
        }
        if (!accountDatabase || !actorId.startsWith('account:')) return false;
        try {
          return Boolean(accountDatabase.prepare('SELECT id FROM user WHERE id=?').get(actorId.slice(8)))
            && await isLocalAccountIdentityActive(pool!, actorId);
        }
        catch { return false; }
      };
      let researchContext;
      if (config.runtimeBundle?.runtime.nativeCollection.collectorRuntimeDigest === CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST) {
        try {
          // Worker composition receives the existing application vault key explicitly.
          // Never generate a replacement key or pass engine credentials to the agent.
          const vaultKey = parseFundingVaultKey(env.MOTIVE_FUNDING_VAULT_KEY ?? '');
          researchContext = createProjectRunResearchContextResolver({ pool,
            researchMemory: createResearchMemoryService({ pool, vaultKey }) });
        } catch { add(reasons, 'RESEARCH_MEMORY_KEY_REQUIRED'); }
      }
      dispatcher = new CircleProjectRunDispatcher({ pool, ownerId: 'operator:circle-project-dispatch', sdk, isActorActive,
        ...(researchContext ? { researchContext } : {}),
        ...(config.runtimeBundle ? { runtime: config.runtimeBundle.runtime } : {}), ...(artifacts ? { artifacts } : {}) });
    } catch { add(reasons, 'RUNTIME_COMPONENT_INVALID'); }
  }
  const snapshot = (): CircleProjectRunApplicationReadiness => ({
    ready: reasons.length === 0, reasons: Object.freeze([...reasons]),
    components: { database: databaseReady, runtimeBundle: Boolean(config.runtimeBundle), vercelAdapter: vercelAdapterReady,
      exactSessionCircleCollector: collectorReady, immutableObjectStore: objectStoreReady,
      accountActivity: Boolean(accountDatabase || accountService) },
  });
  return {
    readiness: snapshot,
    async reconcileBudget(budgetId) {
      const readiness = snapshot();
      const dispatch = dispatcher ? await dispatcher.reconcileBudget(budgetId) : null;
      let evaluation: HostedCircleResultSummary | null = null;
      let closure: CircleProjectRunApplicationResult['closure'] = null;
      if (dispatch?.status === 'SEALED' && pool && objectStore) {
        evaluation = await createCircleResultsService({ pool, objects: objectStore }).evaluateAttempt(dispatch.attemptId);
        closure = await closeEvaluatedCircleAttempt(new LedgerKernel(pool), dispatch.attemptId);
      }
      return { budgetId, readiness, dispatch, evaluation, closure };
    },
    async reconcileAttempt(attemptId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) {
        throw new Error('PROJECT_RUN_ATTEMPT_INVALID');
      }
      if (!pool) throw new Error('PROJECT_RUN_DATABASE_UNCONFIGURED');
      const persisted = await pool.query(
        `SELECT result.id,attempt.execution_status FROM motive.hosted_circle_results result
         JOIN motive.attempts attempt ON attempt.id=result.attempt_id
         JOIN motive.provider_budget_activations activation ON activation.attempt_id=attempt.id
         WHERE result.attempt_id=$1
           AND activation.assigned_agent_id IS NULL AND activation.beneficiary_actor_id=$2`,
        [attemptId, CIRCLE_PROJECT_LEAD_ACTOR_ID],
      );
      if (persisted.rowCount === 1) {
        if (persisted.rows[0].execution_status === 'CLOSED') return { attemptId, status: 'REVIEW_READY' };
        const closure = await closeEvaluatedCircleAttempt(new LedgerKernel(pool), attemptId);
        if (closure.executionStatus !== 'CLOSED') throw new Error('PROJECT_RUN_FINANCIAL_CLOSURE_INCOMPLETE');
        return { attemptId, status: 'REVIEW_READY' };
      }
      if (!dispatcher) throw new Error('PROJECT_RUN_TASK_RUNTIME_UNCONFIGURED');
      const dispatch = await dispatcher.reconcileAttempt(attemptId);
      if (dispatch.status !== 'SEALED') return { attemptId, status: dispatch.status };
      if (!objectStore) throw new Error('PROJECT_RUN_OBJECT_STORE_UNCONFIGURED');
      return persistAndCloseSealedCircleAttempt({ attemptId,
        evaluator: createCircleResultsService({ pool, objects: objectStore }), ledger: new LedgerKernel(pool) });
    },
    async reconcileOrphans() {
      if (!dispatcher) throw new Error('PROJECT_RUN_TASK_RUNTIME_UNCONFIGURED');
      return dispatcher.reconcileOrphans();
    },
    async close() { accountDatabase?.close(); accountDatabase = null; await pool?.end(); pool = null; },
  };
}
