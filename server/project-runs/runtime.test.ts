import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { ArtifactSealer, type ImmutableObjectStore, type SafeArtifactReader } from '../../packages/artifact-storage/src/index.ts';
import { digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import { SealedCircleCandidateReader, SealedCircleInvestigationReader } from '../../packages/evaluator-circle/src/index.ts';
import type { WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import type { ArtifactSealProjection, EnvironmentProjection } from '../../packages/orchestration/src/store-types.ts';
import { defineProtectedRuntime, defineProviderUntrustedDataRuntime, ownerTags, sandboxName, type SandboxExecutionProfile, type SandboxHandle } from '../../packages/sandbox-vercel/src/index.ts';
import {
  CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST,
  CIRCLE_PROVIDER_DATA_COLLECTOR_CONTRACT,
  CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_CONTRACT,
  CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST,
  VercelCircleCandidateReader,
  VercelCircleLearningReader,
  closeEvaluatedCircleAttempt,
  createCircleCandidateArtifactCollector,
  createCircleLearningArtifactCollector,
  createCircleProviderArtifactCollector,
  persistAndCloseSealedCircleAttempt,
  type CircleCandidateSandboxLookup,
} from './runtime.ts';
import { loadCircleProjectRunConfig, readCircleProjectRunBundle } from './config.ts';
import { fixedCircleProjectRunCommand, fixedCircleProjectRunPrompt } from './dispatcher.ts';
import { parseCircleReconcileArguments } from '../../scripts/reconcile-circle-project.ts';

const attemptId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const workOrderId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const digestA = `sha256:${'a'.repeat(64)}` as Digest;
const digestB = `sha256:${'b'.repeat(64)}` as Digest;
const digestC = `sha256:${'c'.repeat(64)}` as Digest;
const digestD = `sha256:${'d'.repeat(64)}` as Digest;
const sessionId = 'circle-session-1';

function profile(learning = false): SandboxExecutionProfile {
  return {
    format: 'motive.sandbox-profile/0.1', profileDigest: digestD, protectedRuntime: defineProtectedRuntime(digestD),
    trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveCircle01', materialDigest: digestA,
      buildRecipeDigest: digestB, sourceCommit: 'a'.repeat(40) }, timeoutMs: 120_000, commandTimeoutMs: 90_000,
    vcpus: 1, allowedExecutables: ['/usr/local/bin/codex'], egress: { gateway: [], artifacts: [] },
    artifacts: learning
      ? { maxFiles: 2, maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 }
      : { maxFiles: 1, maxFileBytes: 32 * 1024, maxTotalBytes: 32 * 1024 },
  };
}
function handle(): SandboxHandle {
  return { provider: 'vercel', attemptId, leaseEpoch: 1, sandboxId: sandboxName(attemptId, 1),
    sessionId, profileDigest: digestD };
}
function lookup(bytes: Uint8Array, changed: 'none' | 'session' | 'source' | 'owner' = 'none'): CircleCandidateSandboxLookup {
  return vi.fn(async ({ name }) => ({
    name, persistent: false, status: 'running',
    sourceSnapshotId: changed === 'source' ? 'snap_Foreign' : 'snap_MotiveCircle01',
    tags: changed === 'owner' ? { ...ownerTags(attemptId, 1, digestD), 'motive-epoch': '2' } : ownerTags(attemptId, 1, digestD),
    currentSession: () => ({ sessionId: changed === 'session' ? 'foreign-session' : sessionId, status: 'running',
      readFile: vi.fn(async () => Readable.from([bytes])) }),
  }));
}
function captureInput(signal = new AbortController().signal) {
  return { handle: handle(), relativePath: 'candidate.json', maximumBytes: 32 * 1024,
    maximumChunkBytes: 16 * 1024, signal };
}
function learningCaptureInput(relativePath: 'candidate.json' | 'investigation.json', signal = new AbortController().signal) {
  return { handle: handle(), relativePath, maximumBytes: relativePath === 'candidate.json' ? 32 * 1024 : 16 * 1024,
    maximumChunkBytes: 16 * 1024, signal };
}
function learningLookup(files: Partial<Record<'candidate.json' | 'investigation.json', Uint8Array>>,
  changed: 'none' | 'session' | 'source' | 'owner' = 'none'): CircleCandidateSandboxLookup {
  return vi.fn(async ({ name }) => ({
    name, persistent: false, status: 'running',
    sourceSnapshotId: changed === 'source' ? 'snap_Foreign' : 'snap_MotiveCircle01',
    tags: changed === 'owner' ? { ...ownerTags(attemptId, 1, digestD), 'motive-epoch': '2' } : ownerTags(attemptId, 1, digestD),
    currentSession: () => ({ sessionId: changed === 'session' ? 'foreign-session' : sessionId, status: 'running',
      readFile: vi.fn(async ({ path }: { path: string }) => {
        const relativePath = path.endsWith('/candidate.json') ? 'candidate.json'
          : path.endsWith('/investigation.json') ? 'investigation.json' : null;
        const bytes = relativePath ? files[relativePath] : undefined;
        return bytes ? Readable.from([bytes]) : null;
      }) }),
  }));
}

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async putIfAbsent(input: Parameters<ImmutableObjectStore['putIfAbsent']>[0]) {
    if (this.objects.has(input.objectKey)) return { status: 'EXISTS' as const, objectId: input.objectKey };
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of input.body) { chunks.push(Uint8Array.from(chunk)); total += chunk.byteLength; }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.objects.set(input.objectKey, bytes);
    return { status: 'CREATED' as const, objectId: input.objectKey };
  }
  async readObject(input: Parameters<ImmutableObjectStore['readObject']>[0]) {
    const bytes = this.objects.get(input.objectKey); if (!bytes) return null;
    return { declaredBytes: bytes.byteLength, body: (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += input.maximumChunkBytes) {
        yield bytes.slice(offset, Math.min(bytes.byteLength, offset + input.maximumChunkBytes));
      }
    })() };
  }
}

describe('exact-session circle candidate reader', () => {
  it('captures provider-untrusted bytes, rejects ambiguous boundaries before lookup, and describes mutable inputs honestly', async () => {
    const sandbox = profile();
    delete sandbox.protectedRuntime;
    sandbox.providerUntrustedDataRuntime = defineProviderUntrustedDataRuntime();
    sandbox.egress.gateway = [{ url: 'https://motive.example/api/inference/v1/responses', methods: ['POST'], pathMatch: 'exact' }];
    sandbox.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://motive.example/api/sandbox-egress' };
    const get = lookup(new TextEncoder().encode('{}'));
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: sandbox, lookup: get });
    expect(await reader.capture(captureInput())).toMatchObject({ kind: 'unknown', linkCount: 0 });
    const collection = { collectorRuntimeDigest: CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST,
      maximumFileBytes: 32768, maximumTotalBytes: 32768,
      approvedPaths: [{ relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED' as const, maximumBytes: 32768 }] };
    const prompt = fixedCircleProjectRunPrompt(collection, 'provider-untrusted-circle-data');
    expect(prompt).toContain('Files inside this worker are mutable');
    expect(prompt).not.toContain('read-only input');
    sandbox.protectedRuntime = defineProtectedRuntime(digestD);
    vi.mocked(get).mockClear();
    await expect(reader.capture(captureInput())).rejects.toMatchObject({ code: 'CIRCLE_COLLECTION_BOUNDARY_INVALID' });
    expect(get).not.toHaveBeenCalled();
  });
  it('derives the frozen collector digest from its reviewable contract', () => {
    expect(CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST).toBe(
      `sha256:${createHash('sha256').update(CIRCLE_PROVIDER_DATA_COLLECTOR_CONTRACT).digest('hex')}`,
    );
  });
  it('reads only candidate.json from the exact owned session and retains an immutable private copy', async () => {
    const bytes = new TextEncoder().encode('{"format":"motive.csqv.witness.v1"}');
    const get = lookup(bytes);
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(), lookup: get });
    const snapshot = await reader.capture(captureInput());
    expect(snapshot).toMatchObject({ relativePath: 'candidate.json', kind: 'unknown', linkCount: 0,
      resolution: 'exact-provider-session-fixed-path', declaredBytes: bytes.byteLength });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: handle().sandboxId, signal: expect.any(AbortSignal) }));
    const collected: number[] = []; for await (const chunk of snapshot!.read()) collected.push(...chunk);
    expect(Uint8Array.from(collected)).toEqual(bytes);
  });

  it.each(['session', 'source', 'owner'] as const)('rejects a foreign %s before reading bytes', async changed => {
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(), lookup: lookup(Uint8Array.of(1), changed) });
    await expect(reader.capture(captureInput())).rejects.toMatchObject({ code: 'CIRCLE_PROVIDER_SESSION_CHANGED' });
  });

  it('destroys an over-limit stream and rejects before hashing or sealing it', async () => {
    const bytes = new Uint8Array(32 * 1024 + 1); const get = lookup(bytes);
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(), lookup: get });
    await expect(reader.capture(captureInput())).rejects.toMatchObject({ code: 'CIRCLE_CANDIDATE_BYTES_EXCEEDED' });
  });

  it('honors cancellation before any provider lookup', async () => {
    const controller = new AbortController(); controller.abort(); const get = lookup(Uint8Array.of(1));
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(), lookup: get });
    await expect(reader.capture(captureInput(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('exact-session circle learning reader v2', () => {
  it('pins a distinct reviewable contract without changing the v1 digest', () => {
    expect(CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST).toBe('sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a');
    expect(CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST).toBe(
      `sha256:${createHash('sha256').update(CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_CONTRACT).digest('hex')}`,
    );
    expect(CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST).not.toBe(CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST);
  });

  it('reads only the two allowlisted paths with their independent byte bounds', async () => {
    const candidate = new TextEncoder().encode('{"format":"motive.csqv.witness.v1"}');
    const investigation = new TextEncoder().encode('{"format":"motive.investigation.v1"}');
    const get = learningLookup({ 'candidate.json': candidate, 'investigation.json': investigation });
    const reader = new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: get });
    await expect(reader.assertReady({ signal: new AbortController().signal }))
      .resolves.toEqual({ capability: 'provider-session-untrusted-data-v2' });
    await expect(reader.capture(learningCaptureInput('candidate.json')))
      .resolves.toMatchObject({ relativePath: 'candidate.json', declaredBytes: candidate.byteLength });
    await expect(reader.capture(learningCaptureInput('investigation.json')))
      .resolves.toMatchObject({ relativePath: 'investigation.json', declaredBytes: investigation.byteLength });
    await expect(reader.capture({ ...learningCaptureInput('candidate.json'), relativePath: 'notes.json' }))
      .rejects.toMatchObject({ code: 'CIRCLE_COLLECTION_BINDING_INVALID' });
  });

  it.each(['session', 'source', 'owner'] as const)('rejects a changed %s before reading learning bytes', async changed => {
    const reader = new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: learningLookup({ 'candidate.json': Uint8Array.of(1) }, changed) });
    await expect(reader.capture(learningCaptureInput('candidate.json')))
      .rejects.toMatchObject({ code: 'CIRCLE_PROVIDER_SESSION_CHANGED' });
  });

  it('rejects an oversized investigation and cancellation before provider lookup', async () => {
    const oversized = learningLookup({ 'investigation.json': new Uint8Array(16 * 1024 + 1) });
    const reader = new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: oversized });
    await expect(reader.capture(learningCaptureInput('investigation.json')))
      .rejects.toMatchObject({ code: 'CIRCLE_INVESTIGATION_BYTES_EXCEEDED' });
    const controller = new AbortController(); controller.abort();
    const untouched = learningLookup({ 'candidate.json': Uint8Array.of(1) });
    const cancelled = new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: untouched });
    await expect(cancelled.capture(learningCaptureInput('candidate.json', controller.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('operator configuration boundary', () => {
  it('loads only the exact reviewed deployment envelope and parses one UUID budget', () => {
    const directory = join(tmpdir(), `motive-circle-runtime-${process.pid}-${Date.now()}`);
    const file = join(directory, 'runtime.json'); mkdirSync(directory);
    writeFileSync(file, JSON.stringify({ format: 'motive.circle-project-run-deployment/0.1', runtime: {
      format: 'motive.circle-project-run-runtime/0.1', sentinel: 'validated by dispatcher before effects',
    } }));
    try {
      expect(readCircleProjectRunBundle(file).format).toBe('motive.circle-project-run-deployment/0.1');
      expect(parseCircleReconcileArguments(['--budget', attemptId])).toEqual({ budgetId: attemptId });
      expect(() => parseCircleReconcileArguments(['--budget', 'not-a-uuid'])).toThrow(/Usage:/);
      writeFileSync(file, JSON.stringify({ format: 'motive.circle-project-run-deployment/0.1', runtime: {}, extra: true }));
      expect(() => readCircleProjectRunBundle(file)).toThrow('PROJECT_RUN_RUNTIME_BUNDLE_INVALID');
    } finally { unlinkSync(file); rmdirSync(directory); }
  });

  it('reports missing effect-bearing resources without attempting reconciliation', () => {
    const config = loadCircleProjectRunConfig({ MOTIVE_DATA_DIR: join(tmpdir(), `motive-missing-${Date.now()}`) });
    expect(config.readinessReasons).toEqual(expect.arrayContaining([
      'DATABASE_CONFIGURATION_REQUIRED', 'RUNTIME_BUNDLE_REQUIRED', 'VERCEL_CREDENTIALS_REQUIRED',
      'OBJECT_STORE_CONFIGURATION_REQUIRED', 'ACCOUNT_STORE_REQUIRED',
    ]));
  });

  it('closes a persisted evaluated attempt with one stable idempotency identity', async () => {
    const closeAttempt = vi.fn(async (input: { actorId: string; idempotencyKey: string; attemptId: string }) => ({
      ...sealInput().attempt, executionStatus: 'CLOSED' as const, consumedAmount: '0.001', availableAmount: '0', input,
    }));
    const first = await closeEvaluatedCircleAttempt({ closeAttempt }, attemptId);
    await closeEvaluatedCircleAttempt({ closeAttempt }, attemptId);
    expect(first).toEqual({ executionStatus: 'CLOSED', consumedAmount: '0.001', availableAmount: '0' });
    expect(closeAttempt.mock.calls[0]![0]).toMatchObject({ actorId: 'operator:seed', attemptId,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(closeAttempt.mock.calls[1]![0].idempotencyKey).toBe(closeAttempt.mock.calls[0]![0].idempotencyKey);
  });

  it('reports review readiness only after numeric persistence and safe ledger closure', async () => {
    const order: string[] = [];
    const evaluator = { async evaluateAttempt(id: string) { expect(id).toBe(attemptId); order.push('numeric-result'); return {} as never; } };
    const ledger = { async closeAttempt() { order.push('ledger-close'); return { ...sealInput().attempt,
      executionStatus: 'CLOSED' as const }; } };
    await expect(persistAndCloseSealedCircleAttempt({ attemptId, evaluator, ledger }))
      .resolves.toEqual({ attemptId, status: 'REVIEW_READY' });
    expect(order).toEqual(['numeric-result', 'ledger-close']);

    const unresolved = { async closeAttempt() { return { ...sealInput().attempt, executionStatus: 'OUTPUT_SEALED' as const }; } };
    await expect(persistAndCloseSealedCircleAttempt({ attemptId, evaluator, ledger: unresolved }))
      .rejects.toThrow('PROJECT_RUN_FINANCIAL_CLOSURE_INCOMPLETE');

    const forbiddenClose = vi.fn(async () => { throw new Error('must not close'); });
    await expect(persistAndCloseSealedCircleAttempt({ attemptId,
      evaluator: { async evaluateAttempt() { throw new Error('numeric persistence unavailable'); } },
      ledger: { closeAttempt: forbiddenClose } }))
      .rejects.toThrow('numeric persistence unavailable');
    expect(forbiddenClose).not.toHaveBeenCalled();
  });
});

describe('versioned hosted command', () => {
  it('keeps the candidate-only v1 prompt and adds the bounded investigation contract only for v2', () => {
    const v1 = fixedCircleProjectRunCommand(plan().nativeCollection!).args.at(-1)!;
    const v2 = fixedCircleProjectRunCommand(learningPlan().nativeCollection!).args.at(-1)!;
    expect(v1).toContain('Write candidate.json in motive.csqv.witness.v1 format, no more than 32768 bytes.');
    expect(v1).not.toContain('investigation.json');
    expect(v2).toContain('investigation.json as one motive.investigation.v1 JSON object, no more than 16384 bytes');
    expect(v2).toContain('proposal, expectation, conditions[], observations[], assessment, nextAction, and optional researchReferences');
    expect(v2).toContain('The assessment is an interpretation, not an observation.');
    expect(v2).toContain('Retain negative, inconclusive, and non-improving results.');
  });
});

describe('circle-only sealer specialization', () => {
  it.each(['protected-runtime', 'provider-untrusted-circle-data'] as const)(
    'seals evaluator-readable bytes only in explicit data mode with %s', async boundary => {
    const bytes = new Uint8Array(readFileSync('public/projects/circle-packing/reference-witness.json'));
    const input = sealInput();
    if (boundary === 'provider-untrusted-circle-data') {
      delete input.plan.sandbox.protectedRuntime;
      input.plan.sandbox.providerUntrustedDataRuntime = defineProviderUntrustedDataRuntime();
      input.plan.sandbox.egress.gateway = [{ url: 'https://motive.example/api/inference/v1/responses', methods: ['POST'], pathMatch: 'exact' }];
      input.plan.sandbox.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://motive.example/api/sandbox-egress' };
      input.environment.profileSnapshot = input.plan.sandbox;
      input.environment.launchPlanDigest = digestCanonicalJson(input.plan);
    }
    const reader = new VercelCircleCandidateReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: input.plan.sandbox, lookup: lookup(bytes) });
    const policy = { async assertReady() { return { capability: 'trusted-operator-artifact-policy-v1' as const }; },
      async approvedPaths() { return [{ relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED' as const }]; } };
    await expect(new ArtifactSealer({ reader, store: new MemoryStore(), policy }).assertReady(input.plan))
      .rejects.toMatchObject({ code: 'ARTIFACT_COLLECTOR_UNSAFE' });

    const store = new MemoryStore(); const artifacts = createCircleCandidateArtifactCollector({ reader, store });
    const receipt = await artifacts.seal({ lease: {} as never, ...input });
    const artifactSeal: ArtifactSealProjection = { attemptId, environmentId, status: 'SEALED',
      manifestDigest: receipt.manifestDigest, receiptId: receipt.receiptId, failureCode: null,
      createdAt: new Date(0).toISOString() };
    const checked = await new SealedCircleCandidateReader({ store, contextResolver: { async resolve() {
      return { projectId, workerEnvironmentId: environmentId };
    } } }).read({ attempt: input.attempt, artifactSeal, signal: new AbortController().signal });
    expect(checked.candidateBytes).toEqual(bytes);
    expect(checked.artifactManifestDigest).toBe(receipt.manifestDigest);
    await expect(artifacts.seal({ lease: {} as never, ...input })).resolves.toEqual(receipt);
    if (boundary === 'provider-untrusted-circle-data') {
      await expect(new ArtifactSealer({ reader, store, policy }).seal(input))
        .rejects.toMatchObject({ code: 'ARTIFACT_COLLECTOR_UNSAFE' });
    }
  });

  it('seals both v2 files on success and makes their exact immutable bytes readable', async () => {
    const candidate = new Uint8Array(readFileSync('public/projects/circle-packing/reference-witness.json'));
    const investigation = new TextEncoder().encode(JSON.stringify({ format: 'motive.investigation.v1',
      proposal: 'Test one bounded change.', expectation: 'A valid candidate remains possible.', conditions: ['N=101'],
      observations: ['The exact checker receives the candidate.'], assessment: 'No improvement is established.',
      nextAction: 'Retain this negative result.' }));
    const reader = new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: learningLookup({ 'candidate.json': candidate, 'investigation.json': investigation }) });
    const store = new MemoryStore(); const artifacts = createCircleLearningArtifactCollector({ reader, store });
    const input = learningSealInput(); const receipt = await artifacts.seal({ lease: {} as never, ...input });
    const artifactSeal: ArtifactSealProjection = { attemptId, environmentId, status: 'SEALED',
      manifestDigest: receipt.manifestDigest, receiptId: receipt.receiptId, failureCode: null, createdAt: new Date(0).toISOString() };
    const resolver = { async resolve() { return { projectId, workerEnvironmentId: environmentId }; } };
    const checked = await new SealedCircleCandidateReader({ store, contextResolver: resolver })
      .read({ attempt: input.attempt, artifactSeal, signal: new AbortController().signal });
    const notes = await new SealedCircleInvestigationReader({ store, contextResolver: resolver })
      .read({ attempt: input.attempt, artifactSeal, signal: new AbortController().signal });
    expect(checked.candidateBytes).toEqual(candidate);
    expect(notes).toMatchObject({ status: 'PRESENT', investigationBytes: investigation });
  });

  it('selects v2 composition only by its pinned digest and exact two-path plan', async () => {
    const store = new MemoryStore(); const credentials = { token: 'secret', teamId: 'team', projectId: 'project' };
    const selected = createCircleProviderArtifactCollector({ collectorRuntimeDigest: CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST,
      credentials, profile: profile(true), store,
      lookup: learningLookup({ 'candidate.json': Uint8Array.of(1), 'investigation.json': Uint8Array.of(2) }) });
    expect(selected).not.toBeNull();
    await expect(selected!.assertReady(learningPlan())).resolves.toBeUndefined();
    expect(createCircleProviderArtifactCollector({ collectorRuntimeDigest: digestA, credentials,
      profile: profile(true), store })).toBeNull();
    const altered = learningPlan(); altered.nativeCollection!.approvedPaths[1]!.maximumBytes += 1;
    await expect(selected!.assertReady(altered)).rejects.toMatchObject({ code: 'ARTIFACT_POLICY_INVALID' });
  });

  it('requires investigation.json on success but records its omission for an observed failure', async () => {
    const candidate = new TextEncoder().encode('{"format":"motive.csqv.witness.v1"}');
    const reader = () => new VercelCircleLearningReader({ credentials: { token: 'secret', teamId: 'team', projectId: 'project' },
      profile: profile(true), lookup: learningLookup({ 'candidate.json': candidate }) });
    await expect(createCircleLearningArtifactCollector({ reader: reader(), store: new MemoryStore() })
      .seal({ lease: {} as never, ...learningSealInput() })).rejects.toMatchObject({ code: 'ARTIFACT_FILE_MISSING' });
    const store = new MemoryStore();
    const receipt = await createCircleLearningArtifactCollector({ reader: reader(), store })
      .seal({ lease: {} as never, ...learningSealInput(7) });
    const manifestEntry = [...store.objects.entries()].find(([key]) => key.endsWith('/manifest.json'));
    expect(manifestEntry).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(manifestEntry![1]))).toMatchObject({ capture_status: 'PARTIAL',
      missing_files: [{ relative_path: 'investigation.json', media_type: 'application/json', availability: 'OPTIONAL_ON_FAILURE' }] });
    expect(receipt.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

function plan(): WorkerLaunchPlan {
  return { format: 'motive.worker-launch/0.1', workOrderId, termsDigest: digestA, inputDigest: digestC,
    inferenceProfileDigest: digestB, actorId: 'operator:seed', infrastructureAuthorizationId: environmentId,
    maximumCostUsd: '0.01', command: { executable: '/usr/local/bin/codex', args: ['exec'] }, capabilityTtlSeconds: 120,
    sandbox: profile(), nativeCollection: { collectorRuntimeDigest: CIRCLE_PROVIDER_DATA_COLLECTOR_DIGEST,
      maximumFileBytes: 32 * 1024, maximumTotalBytes: 32 * 1024,
      approvedPaths: [{ relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32 * 1024 }] } };
}
function learningPlan(): WorkerLaunchPlan {
  const sandbox = profile(true);
  return { ...plan(), sandbox, nativeCollection: { collectorRuntimeDigest: CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST,
    maximumFileBytes: 32 * 1024, maximumTotalBytes: 48 * 1024, approvedPaths: [
      { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32 * 1024 },
      { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16 * 1024 },
    ] } };
}
function sealInput() {
  const launch = plan();
  const attempt: AttemptProjection = { id: attemptId, projectId, workOrderId, grantId: 'grant', sourceId: 'source',
    termsDigest: digestA, profileDigest: digestB, inputDigest: digestC, ceilingAmount: '1', consumedAmount: '0',
    requestHeldAmount: '0', availableAmount: '1', deficitAmount: '0', executionStatus: 'OUTPUT_SEALED', leaseEpoch: 1,
    controllerGeneration: 'generation', admissionClosedAt: null, cancellationRequestedAt: null, createdAt: new Date(0).toISOString() };
  const environment = { id: environmentId, attemptId, sourceId: 'source', grantId: 'grant', kind: 'WORKER', state: 'ACTIVE',
    leaseEpoch: 1, controllerGeneration: 'generation', profileDigest: digestD, profileSnapshot: profile(),
    launchPlanDigest: digestCanonicalJson(launch), infrastructureAuthorizationId: environmentId, maximumCostUsd: '0.01',
    heldCostUsd: '0.01', consumedCostUsd: '0', provider: 'vercel', externalId: handle().sandboxId, sessionId,
    providerStatus: 'running', providerExpiresAt: null, lastObservedAt: null, terminatedAt: null, orphanReason: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as EnvironmentProjection;
  return { attempt, environment, handle: handle(), plan: launch,
    outcome: { kind: 'COMMAND_EXITED' as const, commandId: 'circle-command', exitCode: 0 } };
}
function learningSealInput(exitCode = 0) {
  const launch = learningPlan(); const base = sealInput();
  return { ...base, plan: launch,
    environment: { ...base.environment, profileSnapshot: launch.sandbox, launchPlanDigest: digestCanonicalJson(launch) },
    outcome: { kind: 'COMMAND_EXITED' as const, commandId: 'circle-command', exitCode } };
}
