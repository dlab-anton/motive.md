import { createHash } from 'node:crypto';
import { requireWorkerExecutionBoundary } from '../../sandbox-vercel/src/execution-boundary.ts';
import { validateProfile } from '../../sandbox-vercel/src/policy.ts';
import {
  assertDigest,
  canonicalJson,
  digestCanonicalJson,
  type Digest,
} from '../../domain/src/contracts.ts';
import type {
  ApprovedArtifactPath,
  ArtifactApprovalPolicy,
  ArtifactManifest,
  ArtifactManifestFile,
  ArtifactManifestMissingFile,
  ArtifactSealReceipt,
  ImmutableObjectStore,
  SafeArtifactReader,
  SafeArtifactSnapshot,
  SealArtifactsInput,
} from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const MAX_PATH_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 255;
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;
const CIRCLE_CANDIDATE_PATH = 'candidate.json';
const CIRCLE_CANDIDATE_MEDIA_TYPE = 'application/json';
const CIRCLE_CANDIDATE_MAX_BYTES = 32 * 1024;
const CIRCLE_INVESTIGATION_PATH = 'investigation.json';
const CIRCLE_INVESTIGATION_MEDIA_TYPE = 'application/json';
const CIRCLE_INVESTIGATION_MAX_BYTES = 16 * 1024;
const CIRCLE_LEARNING_TOTAL_BYTES = CIRCLE_CANDIDATE_MAX_BYTES + CIRCLE_INVESTIGATION_MAX_BYTES;

export type ArtifactSealerReaderMode =
  | 'native-beneath-workspace-no-follow-v1'
  | 'provider-session-untrusted-circle-candidate-v1'
  | 'provider-session-untrusted-circle-learning-v2';

export class ArtifactStorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactStorageError';
  }
}

function fail(code: string, message: string): never {
  throw new ArtifactStorageError(code, message);
}

function requireUuid(value: string, name: string): void {
  if (!UUID.test(value)) fail('ARTIFACT_IDENTITY_INVALID', `${name} must be a UUID.`);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('ARTIFACT_LIMIT_INVALID', `${name} must be a positive safe integer.`);
  }
}

export function validateArtifactRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('ARTIFACT_PATH_INVALID', 'Artifact path must be a non-empty string.');
  }
  if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    fail('ARTIFACT_PATH_INVALID', `Artifact path is not relative: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail('ARTIFACT_PATH_INVALID', 'Artifact path contains a control character.');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('ARTIFACT_PATH_INVALID', `Artifact path contains an unsafe segment: ${value}`);
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength > MAX_PATH_BYTES
      || segments.some(segment => encoder.encode(segment).byteLength > MAX_SEGMENT_BYTES)) {
    fail('ARTIFACT_PATH_INVALID', 'Artifact path exceeds the encoded length limit.');
  }
  if (value === 'manifest.json') {
    fail('ARTIFACT_PATH_RESERVED', 'manifest.json is reserved for the trusted manifest.');
  }
  return value;
}

function validateApprovedPaths(paths: readonly ApprovedArtifactPath[], maximumFiles: number): ApprovedArtifactPath[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maximumFiles) {
    fail('ARTIFACT_FILE_COUNT_INVALID', `Expected between 1 and ${maximumFiles} approved artifact paths.`);
  }
  const seen = new Set<string>();
  const validated = paths.map(item => {
    if (typeof item !== 'object' || item === null) fail('ARTIFACT_POLICY_INVALID', 'Approved artifact entry must be an object.');
    const relativePath = validateArtifactRelativePath(item.relativePath);
    if (seen.has(relativePath)) fail('ARTIFACT_PATH_DUPLICATE', `Duplicate approved artifact path: ${relativePath}`);
    seen.add(relativePath);
    if (!MEDIA_TYPE.test(item.mediaType) || item.mediaType.length > 255) {
      fail('ARTIFACT_MEDIA_TYPE_INVALID', `Invalid media type for ${relativePath}.`);
    }
    if (item.availability !== 'REQUIRED' && item.availability !== 'OPTIONAL_ON_FAILURE') {
      fail('ARTIFACT_POLICY_INVALID', `Artifact availability must be explicit for ${relativePath}.`);
    }
    return { relativePath, mediaType: item.mediaType.toLowerCase(), availability: item.availability };
  });
  return validated.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function validateSnapshot(
  snapshot: SafeArtifactSnapshot,
  expectedPath: string,
  maximumFileBytes: number,
  readerMode: ArtifactSealerReaderMode,
): void {
  if (snapshot.relativePath !== expectedPath) fail('ARTIFACT_SNAPSHOT_MISMATCH', 'Collector returned a different path.');
  if (readerMode === 'native-beneath-workspace-no-follow-v1') {
    if (snapshot.resolution !== 'beneath-workspace-no-follow' || snapshot.immutableSnapshot !== true) {
      fail('ARTIFACT_SNAPSHOT_UNSAFE', `Collector did not attest safe immutable resolution for ${expectedPath}.`);
    }
    if (snapshot.kind !== 'regular' || snapshot.linkCount !== 1) {
      fail('ARTIFACT_FILE_TYPE_REJECTED', `${expectedPath} is not an unlinked regular file.`);
    }
  } else if (snapshot.resolution !== 'exact-provider-session-fixed-path' || snapshot.immutableSnapshot !== true
      || snapshot.kind !== 'unknown' || snapshot.linkCount !== 0
      || (readerMode === 'provider-session-untrusted-circle-candidate-v1'
        ? expectedPath !== CIRCLE_CANDIDATE_PATH || maximumFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
        : (expectedPath === CIRCLE_CANDIDATE_PATH ? maximumFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
          : expectedPath === CIRCLE_INVESTIGATION_PATH ? maximumFileBytes !== CIRCLE_INVESTIGATION_MAX_BYTES : true))) {
    fail('ARTIFACT_SNAPSHOT_UNSAFE', `Collector did not attest the fixed untrusted-data capture for ${expectedPath}.`);
  }
  if (!Number.isSafeInteger(snapshot.declaredBytes) || snapshot.declaredBytes < 0
      || snapshot.declaredBytes > maximumFileBytes) {
    fail('ARTIFACT_DECLARED_SIZE_INVALID', `${expectedPath} has an invalid declared size.`);
  }
  if (typeof snapshot.identityToken !== 'string' || snapshot.identityToken.length === 0
      || snapshot.identityToken.length > 1024) {
    fail('ARTIFACT_SNAPSHOT_UNSAFE', `${expectedPath} has no bounded immutable identity.`);
  }
}

function validateCircleProviderDataPlan(plan: SealArtifactsInput['plan'], mode: ArtifactSealerReaderMode): void {
  const limits = plan.sandbox.artifacts;
  const collection = plan.nativeCollection;
  const candidate = collection?.approvedPaths[0];
  if (mode === 'provider-session-untrusted-circle-candidate-v1') {
    if (limits.maxFiles !== 1 || limits.maxFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
        || limits.maxTotalBytes !== CIRCLE_CANDIDATE_MAX_BYTES
        || !collection || collection.maximumFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
        || collection.maximumTotalBytes !== CIRCLE_CANDIDATE_MAX_BYTES
        || collection.approvedPaths.length !== 1 || candidate?.relativePath !== CIRCLE_CANDIDATE_PATH
        || candidate.mediaType !== CIRCLE_CANDIDATE_MEDIA_TYPE || candidate.availability !== 'REQUIRED'
        || candidate.maximumBytes !== CIRCLE_CANDIDATE_MAX_BYTES) {
      fail('ARTIFACT_POLICY_INVALID', 'Provider-session data mode is restricted to one required 32 KiB candidate.json file.');
    }
    return;
  }
  const investigation = collection?.approvedPaths[1];
  if (limits.maxFiles !== 2 || limits.maxFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
      || limits.maxTotalBytes !== CIRCLE_LEARNING_TOTAL_BYTES
      || !collection || collection.maximumFileBytes !== CIRCLE_CANDIDATE_MAX_BYTES
      || collection.maximumTotalBytes !== CIRCLE_LEARNING_TOTAL_BYTES
      || collection.approvedPaths.length !== 2 || candidate?.relativePath !== CIRCLE_CANDIDATE_PATH
      || candidate.mediaType !== CIRCLE_CANDIDATE_MEDIA_TYPE || candidate.availability !== 'REQUIRED'
      || candidate.maximumBytes !== CIRCLE_CANDIDATE_MAX_BYTES
      || investigation?.relativePath !== CIRCLE_INVESTIGATION_PATH
      || investigation.mediaType !== CIRCLE_INVESTIGATION_MEDIA_TYPE
      || investigation.availability !== 'OPTIONAL_ON_FAILURE'
      || investigation.maximumBytes !== CIRCLE_INVESTIGATION_MAX_BYTES) {
    fail('ARTIFACT_POLICY_INVALID', 'Learning data mode is restricted to candidate.json and the bounded investigation.json record.');
  }
}

function providerSessionPathMaximum(mode: ArtifactSealerReaderMode, path: string, fallback: number): number {
  if (mode === 'provider-session-untrusted-circle-learning-v2') {
    if (path === CIRCLE_CANDIDATE_PATH) return CIRCLE_CANDIDATE_MAX_BYTES;
    if (path === CIRCLE_INVESTIGATION_PATH) return CIRCLE_INVESTIGATION_MAX_BYTES;
  }
  return fallback;
}

async function measure(
  body: AsyncIterable<Uint8Array>,
  limits: { maximumBytes: number; maximumChunkBytes: number },
  signal: AbortSignal,
): Promise<{ bytes: number; digest: Digest }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      const rawChunk = next.value;
      if (!(rawChunk instanceof Uint8Array)) fail('ARTIFACT_STREAM_INVALID', 'Artifact stream returned a non-byte chunk.');
      if (rawChunk.byteLength === 0) fail('ARTIFACT_STREAM_INVALID', 'Artifact stream returned an empty chunk.');
      if (rawChunk.byteLength > limits.maximumChunkBytes) {
        fail('ARTIFACT_CHUNK_TOO_LARGE', 'Artifact collector exceeded the maximum chunk size.');
      }
      bytes += rawChunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > limits.maximumBytes) {
        fail('ARTIFACT_BYTES_EXCEEDED', 'Artifact bytes exceeded the enforced limit.');
      }
      hash.update(rawChunk);
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
  return { bytes, digest: `sha256:${hash.digest('hex')}` };
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) fail('ARTIFACT_OPERATION_TIMEOUT', 'Artifact sealing deadline elapsed.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new ArtifactStorageError('ARTIFACT_OPERATION_TIMEOUT', 'Artifact sealing deadline elapsed.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

function enforceExpected(
  body: AsyncIterable<Uint8Array>,
  expected: { bytes: number; digest: Digest; maximumChunkBytes: number },
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return (async function* () {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      while (true) {
        const next = await nextWithAbort(iterator, signal);
        if (next.done) break;
        const rawChunk = next.value;
        if (!(rawChunk instanceof Uint8Array) || rawChunk.byteLength === 0
            || rawChunk.byteLength > expected.maximumChunkBytes) {
          fail('ARTIFACT_SNAPSHOT_CHANGED', 'Immutable snapshot returned an invalid chunk on reread.');
        }
        bytes += rawChunk.byteLength;
        if (!Number.isSafeInteger(bytes) || bytes > expected.bytes) {
          fail('ARTIFACT_SNAPSHOT_CHANGED', 'Immutable snapshot grew between reads.');
        }
        hash.update(rawChunk);
        yield rawChunk;
      }
      const digest = `sha256:${hash.digest('hex')}` as Digest;
      if (bytes !== expected.bytes || digest !== expected.digest) {
        fail('ARTIFACT_SNAPSHOT_CHANGED', 'Immutable snapshot changed between reads.');
      }
    } finally {
      void iterator.return?.().catch(() => undefined);
    }
  })();
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail('ARTIFACT_OPERATION_TIMEOUT', 'Artifact sealing deadline elapsed.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new ArtifactStorageError('ARTIFACT_OPERATION_TIMEOUT', 'Artifact sealing deadline elapsed.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

async function verifyStoredObject(
  store: ImmutableObjectStore,
  objectKey: string,
  expected: { bytes: number; digest: Digest },
  maximumChunkBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const stored = await store.readObject({
    objectKey,
    maximumBytes: expected.bytes,
    maximumChunkBytes,
    signal,
  });
  if (stored === null) fail('ARTIFACT_READBACK_MISMATCH', `Stored object is missing: ${objectKey}.`);
  if (stored.declaredBytes !== null && stored.declaredBytes !== expected.bytes) {
    fail('ARTIFACT_READBACK_MISMATCH', `Stored size metadata does not match ${objectKey}.`);
  }
  let observed: { bytes: number; digest: Digest };
  try {
    observed = await measure(stored.body, { maximumBytes: expected.bytes, maximumChunkBytes }, signal);
  } catch (error) {
    if (error instanceof ArtifactStorageError
        && ['ARTIFACT_BYTES_EXCEEDED', 'ARTIFACT_CHUNK_TOO_LARGE', 'ARTIFACT_STREAM_INVALID'].includes(error.code)) {
      fail('ARTIFACT_READBACK_MISMATCH', `Stored object violates readback bounds: ${objectKey}.`);
    }
    throw error;
  }
  if (observed.bytes !== expected.bytes || observed.digest !== expected.digest) {
    fail('ARTIFACT_READBACK_MISMATCH', `Stored object failed digest verification: ${objectKey}.`);
  }
}

function pathToken(relativePath: string): string {
  return createHash('sha256').update(relativePath).digest('hex');
}

function objectPrefix(input: SealArtifactsInput): string {
  return `projects/${input.attempt.projectId}/attempts/${input.attempt.id}/seals/${input.environment.id}`;
}

function validateBindings(input: SealArtifactsInput): void {
  requireUuid(input.attempt.projectId, 'attempt.projectId');
  requireUuid(input.attempt.workOrderId, 'attempt.workOrderId');
  requireUuid(input.attempt.id, 'attempt.id');
  requireUuid(input.environment.id, 'environment.id');
  if (input.environment.attemptId !== input.attempt.id || input.handle.attemptId !== input.attempt.id
      || input.plan.workOrderId !== input.attempt.workOrderId || input.plan.termsDigest !== input.attempt.termsDigest
      || input.plan.inputDigest !== input.attempt.inputDigest || input.plan.inferenceProfileDigest !== input.attempt.profileDigest
      || input.environment.profileDigest !== input.plan.sandbox.profileDigest
      || input.handle.profileDigest !== input.plan.sandbox.profileDigest
      || input.environment.externalId !== input.handle.sandboxId || input.environment.sessionId !== input.handle.sessionId
      || input.environment.leaseEpoch !== input.handle.leaseEpoch) {
    fail('ARTIFACT_BINDING_MISMATCH', 'Attempt, environment, handle, and launch plan are not the same frozen execution.');
  }
  assertDigest(input.attempt.termsDigest, 'attempt.termsDigest');
  assertDigest(input.attempt.inputDigest, 'attempt.inputDigest');
  assertDigest(input.attempt.profileDigest, 'attempt.profileDigest');
  if (input.environment.launchPlanDigest !== digestCanonicalJson(input.plan)) {
    fail('ARTIFACT_BINDING_MISMATCH', 'The launch plan does not match its durable digest.');
  }
}

function validateLimits(input: SealArtifactsInput['plan']): void {
  requirePositiveInteger(input.sandbox.artifacts.maxFiles, 'plan.sandbox.artifacts.maxFiles');
  requirePositiveInteger(input.sandbox.artifacts.maxFileBytes, 'plan.sandbox.artifacts.maxFileBytes');
  requirePositiveInteger(input.sandbox.artifacts.maxTotalBytes, 'plan.sandbox.artifacts.maxTotalBytes');
  if (input.sandbox.artifacts.maxFileBytes > input.sandbox.artifacts.maxTotalBytes) {
    fail('ARTIFACT_LIMIT_INVALID', 'Per-file bytes cannot exceed total bytes.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && [...expected].sort().every((key, index) => actual[index] === key);
}

function boundedString(value: unknown, maximum = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validOutcome(value: unknown): boolean {
  if (!isRecord(value) || !boundedString(value.kind, 64)) return false;
  switch (value.kind) {
    case 'COMMAND_EXITED':
      return exactKeys(value, value.durationMs === undefined
        ? ['kind', 'commandId', 'exitCode'] : ['kind', 'commandId', 'exitCode', 'durationMs'])
        && boundedString(value.commandId)
        && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)))
        && (value.durationMs === undefined
          || (typeof value.durationMs === 'number' && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0));
    case 'COMMAND_RESULT_UNKNOWN':
      return exactKeys(value, ['kind', 'commandOperationId']) && boundedString(value.commandOperationId);
    case 'PROVIDER_TERMINATED':
      return exactKeys(value, ['kind', 'providerStatus']) && boundedString(value.providerStatus);
    case 'AUTHORITY_CLOSED':
      return exactKeys(value, ['kind', 'code']) && boundedString(value.code);
    case 'CANCELLED':
    case 'STOP_REQUESTED':
    case 'CONTROLLER_SUPERSEDED':
      return exactKeys(value, ['kind']);
    default:
      return false;
  }
}

function permitsPartialCapture(value: SealArtifactsInput['outcome'] | unknown): boolean {
  return isRecord(value) && validOutcome(value)
    && (value.kind !== 'COMMAND_EXITED' || value.exitCode !== 0);
}

async function collectBounded(
  body: AsyncIterable<Uint8Array>,
  limits: { maximumBytes: number; maximumChunkBytes: number },
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; digest: Digest }> {
  const parts: Uint8Array[] = [];
  const hash = createHash('sha256');
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        fail('ARTIFACT_STREAM_INVALID', 'Artifact stream returned an invalid chunk.');
      }
      if (chunk.byteLength > limits.maximumChunkBytes) fail('ARTIFACT_CHUNK_TOO_LARGE', 'Object read exceeded the chunk limit.');
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > limits.maximumBytes) fail('ARTIFACT_BYTES_EXCEEDED', 'Object read exceeded the byte limit.');
      // An object-store iterator may reuse its buffer on the next read. Keep
      // the exact bytes that were hashed for later manifest decoding.
      const captured = Uint8Array.from(chunk);
      parts.push(captured);
      hash.update(captured);
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, digest: `sha256:${hash.digest('hex')}` };
}

function validateStoredManifest(value: unknown, input: SealArtifactsInput, prefix: string): ArtifactManifest {
  const topKeys = [
    'format', 'project_id', 'work_order_id', 'attempt_id', 'environment_id', 'terms_digest', 'input_digest',
    'inference_profile_digest', 'sandbox_profile_digest', 'launch_plan_digest', 'command_digest',
    'controller_observed_outcome', 'capture_status',
    'files', 'missing_files', 'total_bytes', 'human_acceptance',
  ];
  if (!isRecord(value) || !exactKeys(value, topKeys)
      || value.format !== 'motive.artifact-manifest/0.1'
      || value.project_id !== input.attempt.projectId || value.work_order_id !== input.attempt.workOrderId
      || value.attempt_id !== input.attempt.id || value.environment_id !== input.environment.id
      || value.terms_digest !== input.attempt.termsDigest || value.input_digest !== input.attempt.inputDigest
      || value.inference_profile_digest !== input.attempt.profileDigest
      || value.sandbox_profile_digest !== input.plan.sandbox.profileDigest
      || value.launch_plan_digest !== digestCanonicalJson(input.plan)
      || value.command_digest !== digestCanonicalJson(input.plan.command)
      || (value.capture_status !== 'COMPLETE' && value.capture_status !== 'PARTIAL')
      || !validOutcome(value.controller_observed_outcome)
      || !Array.isArray(value.files) || !Array.isArray(value.missing_files)
      || value.files.length + value.missing_files.length === 0
      || value.files.length + value.missing_files.length > input.plan.sandbox.artifacts.maxFiles
      || !Number.isSafeInteger(value.total_bytes) || typeof value.total_bytes !== 'number' || value.total_bytes < 0) {
    fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest does not match the frozen execution.');
  }
  if (!isRecord(value.human_acceptance) || !exactKeys(value.human_acceptance, ['status', 'decision_id'])
      || value.human_acceptance.status !== 'PENDING' || value.human_acceptance.decision_id !== null) {
    fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest contains an invalid acceptance state.');
  }
  let total = 0;
  let previousPath: string | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < value.files.length; index += 1) {
    const file = value.files[index];
    if (!isRecord(file) || !exactKeys(file, ['relative_path', 'media_type', 'availability', 'bytes', 'digest', 'object_key'])
        || !boundedString(file.relative_path, MAX_PATH_BYTES) || !boundedString(file.media_type, 255)
        || !MEDIA_TYPE.test(file.media_type) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0 || file.bytes > input.plan.sandbox.artifacts.maxFileBytes
        || (file.availability !== 'REQUIRED' && file.availability !== 'OPTIONAL_ON_FAILURE')
        || !boundedString(file.digest, 71) || !boundedString(file.object_key, 4096)) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest contains an invalid file entry.');
    }
    const relativePath = validateArtifactRelativePath(file.relative_path);
    try { assertDigest(file.digest, 'manifest.files.digest'); } catch { fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest has an invalid file digest.'); }
    const expectedKey = `${prefix}/files/${pathToken(relativePath)}`;
    if (file.object_key !== expectedKey || (previousPath !== null && previousPath.localeCompare(relativePath) >= 0)) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest file ordering or object key is invalid.');
    }
    seen.add(relativePath);
    previousPath = relativePath;
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > input.plan.sandbox.artifacts.maxTotalBytes) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest exceeds the total artifact limit.');
    }
  }
  previousPath = null;
  for (const missing of value.missing_files) {
    if (!isRecord(missing) || !exactKeys(missing, ['relative_path', 'media_type', 'availability'])
        || !boundedString(missing.relative_path, MAX_PATH_BYTES) || !boundedString(missing.media_type, 255)
        || !MEDIA_TYPE.test(missing.media_type) || missing.availability !== 'OPTIONAL_ON_FAILURE') {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest contains an invalid missing-file entry.');
    }
    const relativePath = validateArtifactRelativePath(missing.relative_path);
    if (seen.has(relativePath) || (previousPath !== null && previousPath.localeCompare(relativePath) >= 0)) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest contains duplicate or unsorted missing paths.');
    }
    seen.add(relativePath);
    previousPath = relativePath;
  }
  if ((value.capture_status === 'COMPLETE' && value.missing_files.length !== 0)
      || (value.capture_status === 'PARTIAL'
        && (value.missing_files.length === 0 || !permitsPartialCapture(value.controller_observed_outcome)))) {
    fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest capture status is inconsistent.');
  }
  if (total !== value.total_bytes) fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest total is inconsistent.');
  return value as ArtifactManifest;
}

function chunks(value: Uint8Array, maximumChunkBytes: number): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let offset = 0; offset < value.byteLength; offset += maximumChunkBytes) {
      yield value.subarray(offset, Math.min(offset + maximumChunkBytes, value.byteLength));
    }
  })();
}

export class ArtifactSealer {
  private readonly maximumChunkBytes: number;
  private readonly operationTimeoutMs: number;
  private readonly readerMode: ArtifactSealerReaderMode;

  constructor(private readonly dependencies: {
    reader: SafeArtifactReader;
    store: ImmutableObjectStore;
    policy: ArtifactApprovalPolicy;
    /** Defaults to the protected native no-follow reader. */
    readerMode?: ArtifactSealerReaderMode;
    maximumChunkBytes?: number;
    operationTimeoutMs?: number;
  }) {
    this.maximumChunkBytes = dependencies.maximumChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.operationTimeoutMs = dependencies.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.readerMode = dependencies.readerMode ?? 'native-beneath-workspace-no-follow-v1';
    requirePositiveInteger(this.maximumChunkBytes, 'maximumChunkBytes');
    requirePositiveInteger(this.operationTimeoutMs, 'operationTimeoutMs');
    if (this.maximumChunkBytes > DEFAULT_MAX_CHUNK_BYTES) {
      fail('ARTIFACT_LIMIT_INVALID', `maximumChunkBytes cannot exceed ${DEFAULT_MAX_CHUNK_BYTES}.`);
    }
    if (this.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
      fail('ARTIFACT_LIMIT_INVALID', `operationTimeoutMs cannot exceed ${MAX_OPERATION_TIMEOUT_MS}.`);
    }
    if (!['native-beneath-workspace-no-follow-v1', 'provider-session-untrusted-circle-candidate-v1',
      'provider-session-untrusted-circle-learning-v2'].includes(this.readerMode)) {
      fail('ARTIFACT_LIMIT_INVALID', 'Artifact reader mode is invalid.');
    }
  }

  async assertReady(plan: SealArtifactsInput['plan']): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.operationTimeoutMs);
    timer.unref?.();
    try {
      await this.assertReadyBeforeDeadline(plan, controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private assertWorkerBoundary(plan: SealArtifactsInput['plan']): void {
    if (Object.prototype.hasOwnProperty.call(plan.sandbox, 'providerUntrustedDataRuntime')) {
      try {
        validateProfile(plan.sandbox);
        requireWorkerExecutionBoundary(plan.sandbox);
      } catch {
        fail('ARTIFACT_COLLECTOR_UNSAFE', 'Invalid provider-untrusted worker boundary.');
      }
      if (this.readerMode === 'native-beneath-workspace-no-follow-v1') {
        fail('ARTIFACT_COLLECTOR_UNSAFE', 'Provider-untrusted workers cannot use native trusted-file collection.');
      }
    }
  }

  private async assertReadyBeforeDeadline(plan: SealArtifactsInput['plan'], signal: AbortSignal): Promise<void> {
    validateLimits(plan);
    this.assertWorkerBoundary(plan);
    if (this.readerMode !== 'native-beneath-workspace-no-follow-v1') validateCircleProviderDataPlan(plan, this.readerMode);
    const [reader, policy] = await awaitWithAbort(Promise.all([
      this.dependencies.reader.assertReady({ signal }),
      this.dependencies.policy.assertReady(plan, { signal }),
    ]), signal);
    const requiredReaderCapability = this.readerMode === 'native-beneath-workspace-no-follow-v1'
      ? 'native-beneath-workspace-no-follow-v1'
      : this.readerMode === 'provider-session-untrusted-circle-candidate-v1'
        ? 'provider-session-untrusted-data-v1' : 'provider-session-untrusted-data-v2';
    if (reader.capability !== requiredReaderCapability
        || policy.capability !== 'trusted-operator-artifact-policy-v1') {
      fail('ARTIFACT_COLLECTOR_UNSAFE', 'Artifact dependencies did not present required capabilities.');
    }
  }

  async seal(input: SealArtifactsInput): Promise<ArtifactSealReceipt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.operationTimeoutMs);
    timer.unref?.();
    try {
      return await this.sealBeforeDeadline(input, controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async recoverExisting(
    input: SealArtifactsInput,
    prefix: string,
    signal: AbortSignal,
  ): Promise<ArtifactSealReceipt | null> {
    const manifestKey = `${prefix}/manifest.json`;
    const stored = await awaitWithAbort(this.dependencies.store.readObject({
      objectKey: manifestKey,
      maximumBytes: MANIFEST_MAX_BYTES,
      maximumChunkBytes: this.maximumChunkBytes,
      signal,
    }), signal);
    if (stored === null) return null;
    if (stored.declaredBytes !== null && (!Number.isSafeInteger(stored.declaredBytes)
        || stored.declaredBytes < 0 || stored.declaredBytes > MANIFEST_MAX_BYTES)) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest has invalid size metadata.');
    }
    let collected: { bytes: Uint8Array; digest: Digest };
    try {
      collected = await collectBounded(stored.body, {
        maximumBytes: MANIFEST_MAX_BYTES,
        maximumChunkBytes: this.maximumChunkBytes,
      }, signal);
    } catch (error) {
      if (error instanceof ArtifactStorageError
          && ['ARTIFACT_BYTES_EXCEEDED', 'ARTIFACT_CHUNK_TOO_LARGE'].includes(error.code)) {
        fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest exceeded its readback limits.');
      }
      throw error;
    }
    if (stored.declaredBytes !== null && stored.declaredBytes !== collected.bytes.byteLength) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest size metadata is inconsistent.');
    }
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(collected.bytes);
      parsed = JSON.parse(text);
    } catch {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest is not valid UTF-8 JSON.');
    }
    const manifest = validateStoredManifest(parsed, input, prefix);
    if (this.readerMode === 'provider-session-untrusted-circle-learning-v2'
        && manifest.files.some(file => file.bytes > providerSessionPathMaximum(this.readerMode, file.relative_path, 0))) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing learning artifact exceeds its frozen per-file limit.');
    }
    if (canonicalJson(manifest) !== text || digestCanonicalJson(manifest) !== collected.digest) {
      fail('ARTIFACT_MANIFEST_INVALID', 'Existing manifest is not canonical or failed digest verification.');
    }
    for (const file of manifest.files) {
      await verifyStoredObject(
        this.dependencies.store,
        file.object_key,
        { bytes: file.bytes, digest: file.digest },
        this.maximumChunkBytes,
        signal,
      );
    }
    return {
      manifestDigest: collected.digest,
      receiptId: `artifact-receipt:${collected.digest.slice('sha256:'.length)}`,
    };
  }

  private async sealBeforeDeadline(input: SealArtifactsInput, signal: AbortSignal): Promise<ArtifactSealReceipt> {
    validateBindings(input);
    validateLimits(input.plan);
    this.assertWorkerBoundary(input.plan);
    if (!validOutcome(input.outcome)) fail('ARTIFACT_OUTCOME_INVALID', 'Controller outcome is invalid.');
    if (this.readerMode !== 'native-beneath-workspace-no-follow-v1') {
      validateCircleProviderDataPlan(input.plan, this.readerMode);
    }
    const limits = input.plan.sandbox.artifacts;
    const prefix = objectPrefix(input);
    const recovered = await this.recoverExisting(input, prefix, signal);
    if (recovered !== null) return recovered;
    await this.assertReadyBeforeDeadline(input.plan, signal);
    const approved = validateApprovedPaths(
      await awaitWithAbort(this.dependencies.policy.approvedPaths({
        attempt: input.attempt,
        environment: input.environment,
        plan: input.plan,
        signal,
      }), signal),
      limits.maxFiles,
    );
    if (this.readerMode !== 'native-beneath-workspace-no-follow-v1') {
      const expected = this.readerMode === 'provider-session-untrusted-circle-candidate-v1'
        ? [{ relativePath: CIRCLE_CANDIDATE_PATH, mediaType: CIRCLE_CANDIDATE_MEDIA_TYPE, availability: 'REQUIRED' }]
        : [
            { relativePath: CIRCLE_CANDIDATE_PATH, mediaType: CIRCLE_CANDIDATE_MEDIA_TYPE, availability: 'REQUIRED' },
            { relativePath: CIRCLE_INVESTIGATION_PATH, mediaType: CIRCLE_INVESTIGATION_MEDIA_TYPE, availability: 'OPTIONAL_ON_FAILURE' },
          ];
      if (approved.length !== expected.length || expected.some((item, index) => {
        const actual = approved[index];
        return actual?.relativePath !== item.relativePath || actual.mediaType !== item.mediaType
          || actual.availability !== item.availability;
      })) fail('ARTIFACT_POLICY_INVALID', 'Provider-session data policy changed after readiness was established.');
    }
    const files: ArtifactManifestFile[] = [];
    const missingFiles: ArtifactManifestMissingFile[] = [];
    let totalBytes = 0;

    for (let index = 0; index < approved.length; index += 1) {
      const approval = approved[index]!;
      const maximumBytes = providerSessionPathMaximum(this.readerMode, approval.relativePath, limits.maxFileBytes);
      const snapshot = await awaitWithAbort(this.dependencies.reader.capture({
        handle: input.handle,
        relativePath: approval.relativePath,
        maximumBytes,
        maximumChunkBytes: this.maximumChunkBytes,
        signal,
      }), signal);
      if (snapshot === null) {
        if (approval.availability === 'OPTIONAL_ON_FAILURE' && permitsPartialCapture(input.outcome)) {
          missingFiles.push({
            relative_path: approval.relativePath,
            media_type: approval.mediaType,
            availability: 'OPTIONAL_ON_FAILURE',
          });
          continue;
        }
        fail('ARTIFACT_FILE_MISSING', `Approved artifact is missing: ${approval.relativePath}`);
      }
      validateSnapshot(snapshot, approval.relativePath, maximumBytes, this.readerMode);
      const observed = await measure(snapshot.read(), {
        maximumBytes,
        maximumChunkBytes: this.maximumChunkBytes,
      }, signal);
      if (observed.bytes !== snapshot.declaredBytes) {
        fail('ARTIFACT_DECLARED_SIZE_MISMATCH', `${approval.relativePath} did not match its declared size.`);
      }
      totalBytes += observed.bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        fail('ARTIFACT_TOTAL_BYTES_EXCEEDED', 'Approved artifacts exceeded the total byte limit.');
      }
      const objectKey = `${prefix}/files/${pathToken(approval.relativePath)}`;
      const put = await awaitWithAbort(this.dependencies.store.putIfAbsent({
        objectKey,
        body: enforceExpected(snapshot.read(), { ...observed, maximumChunkBytes: this.maximumChunkBytes }, signal),
        contentType: approval.mediaType,
        expectedBytes: observed.bytes,
        expectedDigest: observed.digest,
        signal,
      }), signal);
      try {
        await verifyStoredObject(this.dependencies.store, objectKey, observed, this.maximumChunkBytes, signal);
      } catch (error) {
        if (put.status === 'EXISTS' && error instanceof ArtifactStorageError
            && error.code === 'ARTIFACT_READBACK_MISMATCH') {
          fail('ARTIFACT_PARTIAL_CONFLICT', `An earlier partial collection conflicts at ${approval.relativePath}.`);
        }
        throw error;
      }
      files.push({
        relative_path: approval.relativePath,
        media_type: approval.mediaType,
        availability: approval.availability,
        bytes: observed.bytes,
        digest: observed.digest,
        object_key: objectKey,
      });
    }

    const manifest: ArtifactManifest = {
      format: 'motive.artifact-manifest/0.1',
      project_id: input.attempt.projectId,
      work_order_id: input.attempt.workOrderId,
      attempt_id: input.attempt.id,
      environment_id: input.environment.id,
      terms_digest: input.attempt.termsDigest,
      input_digest: input.attempt.inputDigest,
      inference_profile_digest: input.attempt.profileDigest,
      sandbox_profile_digest: input.plan.sandbox.profileDigest,
      launch_plan_digest: digestCanonicalJson(input.plan),
      command_digest: digestCanonicalJson(input.plan.command),
      controller_observed_outcome: structuredClone(input.outcome),
      capture_status: missingFiles.length === 0 ? 'COMPLETE' : 'PARTIAL',
      files,
      missing_files: missingFiles,
      total_bytes: totalBytes,
      human_acceptance: { status: 'PENDING', decision_id: null },
    };
    const manifestJson = canonicalJson(manifest);
    const manifestBytes = new TextEncoder().encode(manifestJson);
    if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) fail('ARTIFACT_MANIFEST_TOO_LARGE', 'Trusted manifest exceeded its byte limit.');
    const manifestDigest = digestCanonicalJson(manifest);
    const manifestKey = `${prefix}/manifest.json`;
    const manifestPut = await awaitWithAbort(this.dependencies.store.putIfAbsent({
      objectKey: manifestKey,
      body: chunks(manifestBytes, this.maximumChunkBytes),
      contentType: 'application/json',
      expectedBytes: manifestBytes.byteLength,
      expectedDigest: manifestDigest,
      signal,
    }), signal);
    if (manifestPut.status === 'EXISTS') {
      const concurrentlySealed = await this.recoverExisting(input, prefix, signal);
      if (concurrentlySealed === null) fail('ARTIFACT_MANIFEST_INVALID', 'Manifest disappeared during seal recovery.');
      return concurrentlySealed;
    }
    await verifyStoredObject(
      this.dependencies.store,
      manifestKey,
      { bytes: manifestBytes.byteLength, digest: manifestDigest },
      this.maximumChunkBytes,
      signal,
    );
    return { manifestDigest, receiptId: `artifact-receipt:${manifestDigest.slice('sha256:'.length)}` };
  }
}
