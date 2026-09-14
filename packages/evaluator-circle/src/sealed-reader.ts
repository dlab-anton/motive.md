import { createHash } from 'node:crypto';
import type { AttemptProjection } from '../../accounting/src/kernel.ts';
import type { ArtifactManifest, ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import { validateArtifactRelativePath } from '../../artifact-storage/src/sealer.ts';
import { assertDigest, canonicalJson, type Digest } from '../../domain/src/contracts.ts';
import type { ArtifactSealProjection } from '../../orchestration/src/store-types.ts';
import {
  CIRCLE_CANDIDATE_MEDIA_TYPE,
  CIRCLE_CANDIDATE_PATH,
  CircleEvaluatorError,
  circleByteDigest,
} from './contract.ts';
import type { CheckedCircleCandidate } from './evaluator.ts';

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_FILES = 10_000;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 32 * 1024;
const MAX_INVESTIGATION_BYTES = 16 * 1024;
export const CIRCLE_INVESTIGATION_PATH = 'investigation.json' as const;
export const CIRCLE_INVESTIGATION_MEDIA_TYPE = 'application/json' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export type TrustedCircleSealContext = {
  projectId: string;
  workerEnvironmentId: string;
};

export interface TrustedCircleSealContextResolver {
  /** Must resolve from controller/ledger state, never a candidate request. */
  resolve(input: { attemptId: string; signal: AbortSignal }): Promise<TrustedCircleSealContext | null>;
}

export type ReadSealedCircleCandidateInput = {
  attempt: Pick<AttemptProjection, 'id' | 'projectId' | 'workOrderId' | 'termsDigest' | 'inputDigest' | 'profileDigest'>;
  artifactSeal: ArtifactSealProjection;
  signal: AbortSignal;
};

export type SealedCircleInvestigation = {
  projectId: string;
  workOrderId: string;
  attemptId: string;
  workerEnvironmentId: string;
  termsDigest: Digest;
  inputDigest: Digest;
  inferenceProfileDigest: Digest;
  artifactManifestDigest: Digest;
  status: 'PRESENT' | 'NOT_PROVIDED';
  investigationDigest: Digest | null;
  investigationBytes: Uint8Array | null;
};

type RecordValue = Record<string, unknown>;
type ManifestFile = ArtifactManifest['files'][number];

function fail(code: ConstructorParameters<typeof CircleEvaluatorError>[0], message: string): never {
  throw new CircleEvaluatorError(code, message);
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('MANIFEST_INVALID', 'Artifact manifest must contain plain JSON objects.');
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail('MANIFEST_INVALID', 'Artifact manifest contains unexpected or missing fields.');
  }
}

function digest(value: unknown): Digest {
  try { return assertDigest(value, 'digest'); }
  catch { return fail('MANIFEST_INVALID', 'Artifact manifest contains an invalid digest.'); }
}

function pathToken(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) fail('ABORTED', 'Circle artifact reading was cancelled.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new CircleEvaluatorError('ABORTED', 'Circle artifact reading was cancelled.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([iterator.next(), aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail('ABORTED', 'Circle artifact reading was cancelled.');
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new CircleEvaluatorError('ABORTED', 'Circle artifact reading was cancelled.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
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
      if (!(next.value instanceof Uint8Array) || next.value.byteLength < 1 || next.value.byteLength > MAX_CHUNK_BYTES) {
        fail('CANDIDATE_INVALID', 'Immutable object storage returned an invalid byte stream.');
      }
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) fail('CANDIDATE_INVALID', 'Immutable object exceeded its read limit.');
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validOutcome(value: unknown): boolean {
  const outcome = record(value);
  if (typeof outcome.kind !== 'string') return false;
  if (outcome.kind === 'COMMAND_EXITED') {
    const keys = Object.hasOwn(outcome, 'durationMs') ? ['kind', 'commandId', 'exitCode', 'durationMs'] : ['kind', 'commandId', 'exitCode'];
    exactKeys(outcome, keys);
    return typeof outcome.commandId === 'string' && outcome.commandId.length > 0 && outcome.commandId.length <= 1024
      && (outcome.exitCode === null || (typeof outcome.exitCode === 'number' && Number.isSafeInteger(outcome.exitCode)))
      && (!Object.hasOwn(outcome, 'durationMs') || (typeof outcome.durationMs === 'number' && Number.isSafeInteger(outcome.durationMs) && outcome.durationMs >= 0));
  }
  if (outcome.kind === 'COMMAND_RESULT_UNKNOWN') {
    exactKeys(outcome, ['kind', 'commandOperationId']);
    return typeof outcome.commandOperationId === 'string' && outcome.commandOperationId.length > 0 && outcome.commandOperationId.length <= 1024;
  }
  if (outcome.kind === 'PROVIDER_TERMINATED') {
    exactKeys(outcome, ['kind', 'providerStatus']);
    return typeof outcome.providerStatus === 'string' && outcome.providerStatus.length > 0 && outcome.providerStatus.length <= 1024;
  }
  if (outcome.kind === 'AUTHORITY_CLOSED') {
    exactKeys(outcome, ['kind', 'code']);
    return typeof outcome.code === 'string' && outcome.code.length > 0 && outcome.code.length <= 1024;
  }
  if (['CANCELLED', 'STOP_REQUESTED', 'CONTROLLER_SUPERSEDED'].includes(outcome.kind)) {
    exactKeys(outcome, ['kind']); return true;
  }
  return false;
}

function permitsPartialCapture(value: unknown): boolean {
  if (!validOutcome(value)) return false;
  const outcome = record(value);
  return outcome.kind !== 'COMMAND_EXITED' || outcome.exitCode !== 0;
}

function file(value: unknown, prefix: string): ManifestFile {
  const item = record(value);
  exactKeys(item, ['relative_path', 'media_type', 'availability', 'bytes', 'digest', 'object_key']);
  if (typeof item.relative_path !== 'string') fail('MANIFEST_INVALID', 'Artifact path is invalid.');
  let relativePath: string;
  try { relativePath = validateArtifactRelativePath(item.relative_path); }
  catch { return fail('MANIFEST_INVALID', 'Artifact path is invalid.'); }
  if (typeof item.media_type !== 'string' || item.media_type.length > 255 || !MEDIA_TYPE.test(item.media_type)
      || !['REQUIRED', 'OPTIONAL_ON_FAILURE'].includes(String(item.availability))
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || typeof item.object_key !== 'string' || item.object_key !== `${prefix}/files/${pathToken(relativePath)}`) {
    fail('MANIFEST_INVALID', 'Artifact file metadata is invalid.');
  }
  return { relative_path: relativePath, media_type: item.media_type, availability: item.availability as ManifestFile['availability'],
    bytes: item.bytes, digest: digest(item.digest), object_key: item.object_key };
}

function parseManifest(bytes: Uint8Array, expected: {
  prefix: string; attempt: ReadSealedCircleCandidateInput['attempt']; workerEnvironmentId: string; manifestDigest: Digest;
}): { manifest: ArtifactManifest; candidate: ManifestFile; investigation: ManifestFile | null } {
  if (circleByteDigest(bytes) !== expected.manifestDigest) fail('MANIFEST_DIGEST_MISMATCH', 'Manifest bytes do not match the sealed receipt.');
  let text: string; let parsed: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); parsed = JSON.parse(text); }
  catch { return fail('MANIFEST_INVALID', 'Manifest is not valid UTF-8 JSON.'); }
  try { if (canonicalJson(parsed) !== text) fail('MANIFEST_DIGEST_MISMATCH', 'Manifest is not the canonical sealed object.'); }
  catch (error) { if (error instanceof CircleEvaluatorError) throw error; return fail('MANIFEST_INVALID', 'Manifest is not canonical JSON.'); }
  const manifest = record(parsed);
  exactKeys(manifest, ['format', 'project_id', 'work_order_id', 'attempt_id', 'environment_id', 'terms_digest', 'input_digest',
    'inference_profile_digest', 'sandbox_profile_digest', 'launch_plan_digest', 'command_digest', 'controller_observed_outcome',
    'capture_status', 'files', 'missing_files', 'total_bytes', 'human_acceptance']);
  if (manifest.format !== 'motive.artifact-manifest/0.1' || manifest.project_id !== expected.attempt.projectId
      || manifest.work_order_id !== expected.attempt.workOrderId || manifest.attempt_id !== expected.attempt.id
      || manifest.environment_id !== expected.workerEnvironmentId || manifest.terms_digest !== expected.attempt.termsDigest
      || manifest.input_digest !== expected.attempt.inputDigest || manifest.inference_profile_digest !== expected.attempt.profileDigest
      || !['COMPLETE', 'PARTIAL'].includes(String(manifest.capture_status))
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.missing_files)
      || manifest.files.length < 1 || manifest.files.length > MAX_MANIFEST_FILES
      || typeof manifest.total_bytes !== 'number' || !Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0) {
    fail('BINDING_MISMATCH', 'Manifest does not match the trusted attempt, seal, and complete capture.');
  }
  for (const key of ['inference_profile_digest', 'sandbox_profile_digest', 'launch_plan_digest', 'command_digest']) digest(manifest[key]);
  if (!validOutcome(manifest.controller_observed_outcome)) fail('MANIFEST_INVALID', 'Manifest outcome is invalid.');
  const acceptance = record(manifest.human_acceptance);
  exactKeys(acceptance, ['status', 'decision_id']);
  if (acceptance.status !== 'PENDING' || acceptance.decision_id !== null) fail('MANIFEST_INVALID', 'Manifest acceptance state is invalid.');
  const files: ManifestFile[] = [];
  const seen = new Set<string>(); let previous: string | null = null; let total = 0;
  for (const raw of manifest.files) {
    const item = file(raw, expected.prefix);
    if (seen.has(item.relative_path) || (previous !== null && previous.localeCompare(item.relative_path) >= 0)) {
      fail('MANIFEST_INVALID', 'Manifest paths are duplicate or unsorted.');
    }
    seen.add(item.relative_path); previous = item.relative_path; total += item.bytes; files.push(item);
    if (!Number.isSafeInteger(total)) fail('MANIFEST_INVALID', 'Manifest byte total is invalid.');
  }
  if (total !== manifest.total_bytes) fail('MANIFEST_INVALID', 'Manifest byte total does not match its files.');
  const missing: string[] = [];
  previous = null;
  for (const raw of manifest.missing_files) {
    const item = record(raw);
    exactKeys(item, ['relative_path', 'media_type', 'availability']);
    if (item.relative_path !== CIRCLE_INVESTIGATION_PATH || item.media_type !== CIRCLE_INVESTIGATION_MEDIA_TYPE
        || item.availability !== 'OPTIONAL_ON_FAILURE' || seen.has(CIRCLE_INVESTIGATION_PATH)
        || (previous !== null && previous.localeCompare(item.relative_path) >= 0)) {
      fail('MANIFEST_INVALID', 'Manifest contains an invalid missing investigation entry.');
    }
    missing.push(item.relative_path); seen.add(item.relative_path); previous = item.relative_path;
  }
  if ((manifest.capture_status === 'COMPLETE' && missing.length !== 0)
      || (manifest.capture_status === 'PARTIAL' && (missing.length !== 1 || !permitsPartialCapture(manifest.controller_observed_outcome)))) {
    fail('MANIFEST_INVALID', 'Manifest capture status is inconsistent.');
  }
  const candidates = files.filter(item => item.relative_path === CIRCLE_CANDIDATE_PATH);
  if (candidates.length !== 1) fail('CANDIDATE_UNAVAILABLE', 'Complete seal must contain one candidate.json artifact.');
  const candidate = candidates[0];
  if (candidate.media_type !== CIRCLE_CANDIDATE_MEDIA_TYPE || candidate.availability !== 'REQUIRED'
      || candidate.bytes < 1 || candidate.bytes > MAX_CANDIDATE_BYTES) {
    fail('CANDIDATE_INVALID', 'candidate.json must be required application/json within 32 KiB.');
  }
  const investigations = files.filter(item => item.relative_path === CIRCLE_INVESTIGATION_PATH);
  if (investigations.length > 1) fail('INVESTIGATION_INVALID', 'Seal contains multiple investigation artifacts.');
  const investigation = investigations[0] ?? null;
  if (investigation && (investigation.media_type !== CIRCLE_INVESTIGATION_MEDIA_TYPE
      || investigation.availability !== 'OPTIONAL_ON_FAILURE' || investigation.bytes < 1
      || investigation.bytes > MAX_INVESTIGATION_BYTES)) {
    fail('INVESTIGATION_INVALID', 'investigation.json must be optional-on-failure application/json within 16 KiB.');
  }
  return { manifest: manifest as unknown as ArtifactManifest, candidate, investigation };
}

type ValidatedSeal = Awaited<ReturnType<typeof readValidatedSeal>>;

async function readValidatedSeal(dependencies: {
  store: Pick<ImmutableObjectStore, 'readObject'>;
  contextResolver: TrustedCircleSealContextResolver;
}, input: ReadSealedCircleCandidateInput) {
  if (!input || typeof input !== 'object' || !(input.signal instanceof AbortSignal)) fail('INPUT_INVALID', 'Circle artifact request is invalid.');
  const { attempt, artifactSeal } = input;
  if (![attempt.id, attempt.projectId, attempt.workOrderId, artifactSeal.attemptId, artifactSeal.environmentId].every(value => typeof value === 'string' && UUID.test(value))) {
    fail('IDENTITY_INVALID', 'Circle artifact identities must be UUIDs.');
  }
  let manifestDigest: Digest;
  try {
    manifestDigest = assertDigest(artifactSeal.manifestDigest, 'artifactSeal.manifestDigest');
    assertDigest(attempt.termsDigest, 'attempt.termsDigest'); assertDigest(attempt.inputDigest, 'attempt.inputDigest');
    assertDigest(attempt.profileDigest, 'attempt.profileDigest');
  } catch { return fail('BINDING_MISMATCH', 'Attempt or seal digest is invalid.'); }
  if (artifactSeal.status !== 'SEALED' || artifactSeal.attemptId !== attempt.id || artifactSeal.failureCode !== null) {
    fail('ARTIFACT_UNAVAILABLE', 'A successful sealed artifact receipt is required.');
  }
  const context = await awaitWithAbort(dependencies.contextResolver.resolve({ attemptId: attempt.id, signal: input.signal }), input.signal);
  if (!context || context.projectId !== attempt.projectId || context.workerEnvironmentId !== artifactSeal.environmentId
      || !UUID.test(context.projectId) || !UUID.test(context.workerEnvironmentId)) {
    fail('BINDING_MISMATCH', 'Trusted controller context does not match the attempt and artifact seal.');
  }
  const prefix = `projects/${context.projectId}/attempts/${attempt.id}/seals/${context.workerEnvironmentId}`;
  const storedManifest = await awaitWithAbort(dependencies.store.readObject({ objectKey: `${prefix}/manifest.json`,
    maximumBytes: MAX_MANIFEST_BYTES, maximumChunkBytes: MAX_CHUNK_BYTES, signal: input.signal }), input.signal);
  if (!storedManifest) fail('ARTIFACT_UNAVAILABLE', 'Sealed artifact manifest is unavailable.');
  const manifestBytes = await collect(storedManifest.body, MAX_MANIFEST_BYTES, input.signal);
  if (storedManifest.declaredBytes !== null && storedManifest.declaredBytes !== manifestBytes.byteLength) {
    fail('MANIFEST_INVALID', 'Manifest size metadata is inconsistent.');
  }
  return { attempt, context, manifestDigest,
    ...parseManifest(manifestBytes, { prefix, attempt, workerEnvironmentId: context.workerEnvironmentId, manifestDigest }) };
}

/** Reads one exact candidate from a trusted immutable worker seal. */
export class SealedCircleCandidateReader {
  constructor(private readonly dependencies: {
    store: Pick<ImmutableObjectStore, 'readObject'>;
    contextResolver: TrustedCircleSealContextResolver;
  }) {}

  async read(input: ReadSealedCircleCandidateInput): Promise<CheckedCircleCandidate> {
    const { attempt, context, manifestDigest, manifest, candidate } = await readValidatedSeal(this.dependencies, input);
    const storedCandidate = await awaitWithAbort(this.dependencies.store.readObject({ objectKey: candidate.object_key,
      maximumBytes: candidate.bytes, maximumChunkBytes: MAX_CHUNK_BYTES, signal: input.signal }), input.signal);
    if (!storedCandidate) fail('CANDIDATE_UNAVAILABLE', 'Sealed candidate object is unavailable.');
    if (storedCandidate.declaredBytes !== null && storedCandidate.declaredBytes !== candidate.bytes) {
      fail('CANDIDATE_DIGEST_MISMATCH', 'Candidate size metadata differs from its manifest.');
    }
    const candidateBytes = await collect(storedCandidate.body, candidate.bytes, input.signal);
    if (candidateBytes.byteLength !== candidate.bytes || circleByteDigest(candidateBytes) !== candidate.digest) {
      fail('CANDIDATE_DIGEST_MISMATCH', 'Candidate bytes differ from the immutable manifest.');
    }
    return Object.freeze({ projectId: context.projectId, workOrderId: attempt.workOrderId, attemptId: attempt.id,
      workerEnvironmentId: context.workerEnvironmentId, termsDigest: attempt.termsDigest, inputDigest: attempt.inputDigest,
      inferenceProfileDigest: manifest.inference_profile_digest, artifactManifestDigest: manifestDigest,
      candidateDigest: candidate.digest, candidateBytes: Uint8Array.from(candidateBytes) });
  }
}

/** Reads optional hosted learning notes through the same trusted seal binding as candidate.json. */
export class SealedCircleInvestigationReader {
  constructor(private readonly dependencies: {
    store: Pick<ImmutableObjectStore, 'readObject'>;
    contextResolver: TrustedCircleSealContextResolver;
  }) {}

  async read(input: ReadSealedCircleCandidateInput): Promise<SealedCircleInvestigation> {
    const sealed: ValidatedSeal = await readValidatedSeal(this.dependencies, input);
    const common = { projectId: sealed.context.projectId, workOrderId: sealed.attempt.workOrderId,
      attemptId: sealed.attempt.id, workerEnvironmentId: sealed.context.workerEnvironmentId,
      termsDigest: sealed.attempt.termsDigest, inputDigest: sealed.attempt.inputDigest,
      inferenceProfileDigest: sealed.manifest.inference_profile_digest,
      artifactManifestDigest: sealed.manifestDigest };
    if (!sealed.investigation) return Object.freeze({ ...common, status: 'NOT_PROVIDED' as const,
      investigationDigest: null, investigationBytes: null });
    const stored = await awaitWithAbort(this.dependencies.store.readObject({ objectKey: sealed.investigation.object_key,
      maximumBytes: sealed.investigation.bytes, maximumChunkBytes: MAX_CHUNK_BYTES, signal: input.signal }), input.signal);
    if (!stored) fail('INVESTIGATION_UNAVAILABLE', 'Sealed investigation object is unavailable.');
    if (stored.declaredBytes !== null && stored.declaredBytes !== sealed.investigation.bytes) {
      fail('INVESTIGATION_DIGEST_MISMATCH', 'Investigation size metadata differs from its manifest.');
    }
    const bytes = await collect(stored.body, sealed.investigation.bytes, input.signal);
    if (bytes.byteLength !== sealed.investigation.bytes || circleByteDigest(bytes) !== sealed.investigation.digest) {
      fail('INVESTIGATION_DIGEST_MISMATCH', 'Investigation bytes differ from the immutable manifest.');
    }
    return Object.freeze({ ...common, status: 'PRESENT' as const, investigationDigest: sealed.investigation.digest,
      investigationBytes: Uint8Array.from(bytes) });
  }
}
