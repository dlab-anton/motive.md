import { createHash } from 'node:crypto';
import type { ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import { validateArtifactRelativePath } from '../../artifact-storage/src/sealer.ts';
import { assertDigest, canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { requireFrozenRuntimeBoundProfile, type RuntimeBoundComparatorProfile } from './runtime-profile.ts';

export const SEALED_EVALUATOR_INPUT_FORMAT = 'motive.sealed-evaluator-input/0.1' as const;
export const MAX_SEALED_EVALUATOR_INPUT_BYTES = 48 * 1024;
export const MAX_SEALED_EVALUATOR_INPUT_PACK_BYTES = 80 * 1024;

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export class SealedEvaluatorInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SealedEvaluatorInputError';
  }
}

function fail(code: string, message: string): never {
  throw new SealedEvaluatorInputError(code, message);
}

/** Resolved from controller state, never from a candidate manifest or request. */
export type TrustedSealedArtifactContext = {
  projectId: string;
  workerEnvironmentId: string;
};

export interface TrustedSealedArtifactContextResolver {
  resolve(input: { attemptId: string; signal: AbortSignal }): Promise<TrustedSealedArtifactContext | null>;
}

export type LoadSealedEvaluatorInput = {
  attemptId: string;
  workOrderId: string;
  termsDigest: Digest;
  inputDigest: Digest;
  manifestDigest: Digest;
  evaluatorProfile: RuntimeBoundComparatorProfile;
  evaluatorProfileDigest: Digest;
  signal: AbortSignal;
};

export type SealedEvaluatorInputFile = {
  relative_path: string;
  bytes_base64: string;
  digest: Digest;
};

export type SealedEvaluatorInput = {
  format: typeof SEALED_EVALUATOR_INPUT_FORMAT;
  artifact_manifest_digest: Digest;
  files: readonly SealedEvaluatorInputFile[];
};

type ManifestFile = {
  relative_path: string;
  bytes: number;
  digest: Digest;
  object_key: string;
};

function record(value: unknown, code = 'SEALED_INPUT_MANIFEST_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(code, 'Expected a plain object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code = 'SEALED_INPUT_MANIFEST_INVALID'): void {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail(code, 'Object contains unexpected or missing fields.');
  }
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('SEALED_INPUT_IDENTITY_INVALID', `${name} must be a UUID.`);
  return value;
}

function pathToken(relativePath: string): string {
  return createHash('sha256').update(relativePath).digest('hex');
}

function byteDigest(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail('SEALED_INPUT_ABORTED', 'Sealed input loading was cancelled.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new SealedEvaluatorInputError('SEALED_INPUT_ABORTED', 'Sealed input loading was cancelled.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) fail('SEALED_INPUT_ABORTED', 'Sealed input loading was cancelled.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new SealedEvaluatorInputError('SEALED_INPUT_ABORTED', 'Sealed input loading was cancelled.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([iterator.next(), aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

async function collect(body: AsyncIterable<Uint8Array>, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0 || next.value.byteLength > MAX_CHUNK_BYTES) {
        fail('SEALED_INPUT_STREAM_INVALID', 'Object storage returned an invalid chunk.');
      }
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        fail('SEALED_INPUT_BYTES_EXCEEDED', 'Object storage exceeded the sealed input byte limit.');
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function manifestFile(value: unknown, prefix: string): ManifestFile {
  const item = record(value);
  exactKeys(item, ['relative_path', 'media_type', 'availability', 'bytes', 'digest', 'object_key']);
  if (typeof item.relative_path !== 'string') fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest file path is invalid.');
  let relativePath: string;
  try { relativePath = validateArtifactRelativePath(item.relative_path); }
  catch { return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest file path is invalid.'); }
  if (typeof item.media_type !== 'string' || item.media_type.length < 1 || item.media_type.length > 255 || !MEDIA_TYPE.test(item.media_type)
      || (item.availability !== 'REQUIRED' && item.availability !== 'OPTIONAL_ON_FAILURE')
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || typeof item.object_key !== 'string') {
    fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest file metadata is invalid.');
  }
  let digest: Digest;
  try { digest = assertDigest(item.digest, 'manifest file digest'); }
  catch { return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest file digest is invalid.'); }
  if (item.object_key !== `${prefix}/files/${pathToken(relativePath)}`) {
    fail('SEALED_INPUT_OBJECT_KEY_INVALID', 'Manifest file object key is outside its exact seal prefix.');
  }
  return { relative_path: relativePath, bytes: item.bytes, digest, object_key: item.object_key };
}

function validOutcome(value: unknown): boolean {
  const outcome = record(value);
  if (typeof outcome.kind !== 'string' || outcome.kind.length < 1 || outcome.kind.length > 64) return false;
  switch (outcome.kind) {
    case 'COMMAND_EXITED':
      if (Object.hasOwn(outcome, 'durationMs')) {
        exactKeys(outcome, ['kind', 'commandId', 'exitCode', 'durationMs']);
        if (typeof outcome.durationMs !== 'number' || !Number.isSafeInteger(outcome.durationMs) || outcome.durationMs < 0) return false;
      } else exactKeys(outcome, ['kind', 'commandId', 'exitCode']);
      return typeof outcome.commandId === 'string' && outcome.commandId.length > 0 && outcome.commandId.length <= 1024
        && (outcome.exitCode === null || (typeof outcome.exitCode === 'number' && Number.isSafeInteger(outcome.exitCode)));
    case 'COMMAND_RESULT_UNKNOWN':
      exactKeys(outcome, ['kind', 'commandOperationId']);
      return typeof outcome.commandOperationId === 'string' && outcome.commandOperationId.length > 0 && outcome.commandOperationId.length <= 1024;
    case 'PROVIDER_TERMINATED':
      exactKeys(outcome, ['kind', 'providerStatus']);
      return typeof outcome.providerStatus === 'string' && outcome.providerStatus.length > 0 && outcome.providerStatus.length <= 1024;
    case 'AUTHORITY_CLOSED':
      exactKeys(outcome, ['kind', 'code']);
      return typeof outcome.code === 'string' && outcome.code.length > 0 && outcome.code.length <= 1024;
    case 'CANCELLED':
    case 'STOP_REQUESTED':
    case 'CONTROLLER_SUPERSEDED':
      exactKeys(outcome, ['kind']);
      return true;
    default:
      return false;
  }
}

function parseManifest(bytes: Uint8Array, prefix: string, input: LoadSealedEvaluatorInput,
  context: TrustedSealedArtifactContext): Map<string, ManifestFile> {
  if (byteDigest(bytes) !== input.manifestDigest) fail('SEALED_INPUT_MANIFEST_DIGEST_MISMATCH', 'Manifest bytes do not match the sealed digest.');
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch { return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest is not valid UTF-8 JSON.'); }
  try {
    if (canonicalJson(parsed) !== text || digestCanonicalJson(parsed) !== input.manifestDigest) {
      fail('SEALED_INPUT_MANIFEST_DIGEST_MISMATCH', 'Manifest is not the canonical sealed object.');
    }
  } catch (error) {
    if (error instanceof SealedEvaluatorInputError) throw error;
    return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest is not canonical JSON.');
  }
  const manifest = record(parsed);
  exactKeys(manifest, ['format', 'project_id', 'work_order_id', 'attempt_id', 'environment_id', 'terms_digest', 'input_digest',
    'inference_profile_digest', 'sandbox_profile_digest', 'launch_plan_digest', 'command_digest', 'controller_observed_outcome',
    'capture_status', 'files', 'missing_files', 'total_bytes', 'human_acceptance']);
  if (manifest.format !== 'motive.artifact-manifest/0.1' || manifest.project_id !== context.projectId
      || manifest.environment_id !== context.workerEnvironmentId || manifest.attempt_id !== input.attemptId
      || manifest.work_order_id !== input.workOrderId || manifest.terms_digest !== input.termsDigest
      || manifest.input_digest !== input.inputDigest || !Array.isArray(manifest.files) || !Array.isArray(manifest.missing_files)
      || manifest.files.length + manifest.missing_files.length < 1
      || manifest.files.length + manifest.missing_files.length > MAX_MANIFEST_FILES
      || (manifest.capture_status !== 'COMPLETE' && manifest.capture_status !== 'PARTIAL')
      || typeof manifest.total_bytes !== 'number' || !Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0) {
    fail('SEALED_INPUT_BINDING_MISMATCH', 'Manifest does not match the trusted project, worker, attempt, or immutable terms.');
  }
  for (const key of ['inference_profile_digest', 'sandbox_profile_digest', 'launch_plan_digest', 'command_digest']) {
    try { assertDigest(manifest[key], `manifest.${key}`); }
    catch { return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest contains an invalid execution digest.'); }
  }
  if (!validOutcome(manifest.controller_observed_outcome)) fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest outcome is invalid.');
  const acceptance = record(manifest.human_acceptance);
  exactKeys(acceptance, ['status', 'decision_id']);
  if (acceptance.status !== 'PENDING' || acceptance.decision_id !== null) {
    fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest acceptance state is invalid.');
  }
  const files = new Map<string, ManifestFile>();
  const seenPaths = new Set<string>();
  let total = 0;
  let previousPath: string | null = null;
  for (const raw of manifest.files) {
    const file = manifestFile(raw, prefix);
    if (seenPaths.has(file.relative_path) || (previousPath !== null && previousPath.localeCompare(file.relative_path) >= 0)) {
      fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest file paths are duplicate or unsorted.');
    }
    files.set(file.relative_path, file);
    seenPaths.add(file.relative_path);
    previousPath = file.relative_path;
    total += file.bytes;
    if (!Number.isSafeInteger(total)) fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest total is invalid.');
  }
  if (total !== manifest.total_bytes) fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest total does not match its files.');
  previousPath = null;
  for (const raw of manifest.missing_files) {
    const missing = record(raw);
    exactKeys(missing, ['relative_path', 'media_type', 'availability']);
    if (typeof missing.relative_path !== 'string' || typeof missing.media_type !== 'string'
        || missing.media_type.length < 1 || missing.media_type.length > 255 || !MEDIA_TYPE.test(missing.media_type)
        || missing.availability !== 'OPTIONAL_ON_FAILURE') {
      fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest missing-file metadata is invalid.');
    }
    let relativePath: string;
    try { relativePath = validateArtifactRelativePath(missing.relative_path); }
    catch { return fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest missing-file path is invalid.'); }
    if (seenPaths.has(relativePath) || (previousPath !== null && previousPath.localeCompare(relativePath) >= 0)) {
      fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest missing-file paths are duplicate or unsorted.');
    }
    seenPaths.add(relativePath);
    previousPath = relativePath;
  }
  const missingCount = manifest.missing_files.length;
  if ((manifest.capture_status === 'COMPLETE' && missingCount !== 0)
      || (manifest.capture_status === 'PARTIAL' && (missingCount === 0
        || (record(manifest.controller_observed_outcome).kind === 'COMMAND_EXITED'
          && record(manifest.controller_observed_outcome).exitCode === 0)))) {
    fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest capture status is inconsistent.');
  }
  return files;
}

/**
 * Loads only profile-approved Lean sources from one immutable worker seal.
 * It never accepts a caller-supplied project/environment prefix and performs
 * no writes or provider commands.
 */
export class SealedEvaluatorInputLoader {
  constructor(private readonly dependencies: {
    store: Pick<ImmutableObjectStore, 'readObject'>;
    contextResolver: TrustedSealedArtifactContextResolver;
  }) {}

  async load(input: LoadSealedEvaluatorInput): Promise<SealedEvaluatorInput> {
    if (!input || typeof input !== 'object' || !(input.signal instanceof AbortSignal)) {
      fail('SEALED_INPUT_INVALID', 'Sealed input request is invalid.');
    }
    uuid(input.attemptId, 'attemptId');
    uuid(input.workOrderId, 'workOrderId');
    const termsDigest = assertDigest(input.termsDigest, 'termsDigest');
    const inputDigest = assertDigest(input.inputDigest, 'inputDigest');
    const manifestDigest = assertDigest(input.manifestDigest, 'manifestDigest');
    const profile = requireFrozenRuntimeBoundProfile(input.evaluatorProfile, input.evaluatorProfileDigest);
    if (input.signal.aborted) fail('SEALED_INPUT_ABORTED', 'Sealed input loading was cancelled.');
    const context = await awaitWithAbort(
      this.dependencies.contextResolver.resolve({ attemptId: input.attemptId, signal: input.signal }), input.signal);
    if (!context) fail('SEALED_INPUT_CONTEXT_UNAVAILABLE', 'Trusted sealed artifact context is unavailable.');
    const projectId = uuid(context.projectId, 'context.projectId');
    const workerEnvironmentId = uuid(context.workerEnvironmentId, 'context.workerEnvironmentId');
    const prefix = `projects/${projectId}/attempts/${input.attemptId}/seals/${workerEnvironmentId}`;
    const storedManifest = await awaitWithAbort(this.dependencies.store.readObject({ objectKey: `${prefix}/manifest.json`,
      maximumBytes: MAX_MANIFEST_BYTES, maximumChunkBytes: MAX_CHUNK_BYTES, signal: input.signal }), input.signal);
    if (!storedManifest) fail('SEALED_INPUT_MANIFEST_UNAVAILABLE', 'Sealed artifact manifest is unavailable.');
    const manifestBytes = await collect(storedManifest.body, MAX_MANIFEST_BYTES, input.signal);
    if (storedManifest.declaredBytes !== null && storedManifest.declaredBytes !== manifestBytes.byteLength) {
      fail('SEALED_INPUT_MANIFEST_INVALID', 'Manifest size metadata is inconsistent.');
    }
    const expected = { ...input, termsDigest, inputDigest, manifestDigest };
    const manifestFiles = parseManifest(manifestBytes, prefix, expected, { projectId, workerEnvironmentId });
    const selected = profile.challenge.allowed_solution_paths.map(relativePath => {
      if (!relativePath.endsWith('.lean')) fail('SEALED_INPUT_PATH_INVALID', 'Evaluator input path is not a Lean source.');
      const file = manifestFiles.get(relativePath);
      if (!file) fail('SEALED_INPUT_SOURCE_MISSING', `Approved evaluator source is absent: ${relativePath}.`);
      return file;
    });
    const declaredTotal = selected.reduce((sum, file) => sum + file.bytes, 0);
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_SEALED_EVALUATOR_INPUT_BYTES) {
      fail('SEALED_INPUT_BYTES_EXCEEDED', 'Approved evaluator sources exceed 48 KiB.');
    }
    const files: SealedEvaluatorInputFile[] = [];
    let actualTotal = 0;
    for (const file of selected) {
      const stored = await awaitWithAbort(this.dependencies.store.readObject({ objectKey: file.object_key,
        maximumBytes: Math.max(file.bytes, 1), maximumChunkBytes: MAX_CHUNK_BYTES, signal: input.signal }), input.signal);
      if (!stored) fail('SEALED_INPUT_SOURCE_MISSING', `Approved evaluator source object is absent: ${file.relative_path}.`);
      if (stored.declaredBytes !== null && stored.declaredBytes !== file.bytes) {
        fail('SEALED_INPUT_SOURCE_MISMATCH', `Source size metadata differs from the manifest: ${file.relative_path}.`);
      }
      const bytes = await collect(stored.body, file.bytes, input.signal);
      actualTotal += bytes.byteLength;
      if (bytes.byteLength !== file.bytes || byteDigest(bytes) !== file.digest
          || actualTotal > MAX_SEALED_EVALUATOR_INPUT_BYTES) {
        fail('SEALED_INPUT_SOURCE_MISMATCH', `Source bytes differ from the manifest: ${file.relative_path}.`);
      }
      files.push({ relative_path: file.relative_path, bytes_base64: Buffer.from(bytes).toString('base64'), digest: file.digest });
    }
    const result: SealedEvaluatorInput = Object.freeze({ format: SEALED_EVALUATOR_INPUT_FORMAT, artifact_manifest_digest: manifestDigest,
      files: Object.freeze(files.map(file => Object.freeze(file))) });
    if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_SEALED_EVALUATOR_INPUT_PACK_BYTES) {
      fail('SEALED_INPUT_PACK_EXCEEDED', 'Canonical evaluator input pack exceeds 80 KiB.');
    }
    return result;
  }
}
