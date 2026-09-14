import { describe, expect, it, vi } from 'vitest';
import { ClaimedVercelNativeArtifactReader, DurableVercelNativeArtifactReader } from '../../packages/artifact-storage/src/durable-vercel-native-reader.ts';
import { createClaimedNativeArtifactCollector } from '../../packages/artifact-storage/src/claimed-native-collector-service.ts';
import type { WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import { defineReviewedVercelNativeArtifactRuntime, StaticReviewedVercelNativeArtifactRuntimeRegistry,
  type VercelNativeArtifactTransport, type VercelNativeArtifactSession } from '../../packages/artifact-storage/src/vercel-native-reader.ts';
import { defineProtectedRuntime, sandboxName, type SandboxExecutionProfile } from '../../packages/sandbox-vercel/src/index.ts';
import type { NativeCollectionStore, NativeCollectionEffectProjection, NativeCollectionPlanProjection,
  WorkerWorkspaceBindingInput, WorkerWorkspaceBindingStore } from '../../packages/orchestration/src/store-types.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;
function fixture() {
  const attemptId = '00000000-0000-4000-8000-000000000001';
  const profile: SandboxExecutionProfile = {
    format: 'motive.sandbox-profile/0.1', profileDigest: digest, protectedRuntime: defineProtectedRuntime(digest),
    trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40), materialDigest: digest, buildRecipeDigest: digest },
    timeoutMs: 60_000, commandTimeoutMs: 30_000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
    egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
      artifacts: [{ url: 'https://artifacts.motive.example/upload/', methods: ['PUT'], pathMatch: 'prefix' }] },
    artifacts: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 2048 },
  };
  const runtime = defineReviewedVercelNativeArtifactRuntime({
    format: 'motive.vercel-native-artifact-runtime/0.1', profileDigest: digest, source: profile.trustedSource,
    workerRuntimeDigest: profile.protectedRuntime!.runtimeDigest, workerLauncherDigest: digest,
    collectorPath: '/opt/motive/bin/artifact-collector', collectorDigest: digest,
    collectorLauncherPath: '/opt/motive/bin/artifact-collector-launcher', collectorLauncherDigest: digest,
    bootstrapPath: '/var/lib/motive/control/worker-bootstrap.json', collectorUid: 1000, workerUid: 2000,
  });
  const handle = { provider: 'vercel' as const, attemptId, leaseEpoch: 1, sandboxId: sandboxName(attemptId, 1), sessionId: 'session_1', profileDigest: digest };
  const context = { environmentId: '00000000-0000-4000-8000-000000000002', handle,
    lease: { attemptId, ownerId: 'test-controller', epoch: 1, controllerGeneration: '1', expiresAt: '2099-01-01T00:00:00Z' } };
  let persisted: WorkerWorkspaceBindingInput | null = null;
  let observedIdentity = '1:2:3';
  const events: string[] = [];
  const store: WorkerWorkspaceBindingStore = {
    getWorkerWorkspaceBinding: vi.fn(async () => { events.push('read-binding'); return structuredClone(persisted); }),
    recordWorkerWorkspaceBinding: vi.fn(async (_lease, _environment, input) => {
      events.push('commit-binding'); persisted = structuredClone(input); return structuredClone(input);
    }),
  };
  const transport: VercelNativeArtifactTransport = { getExactSession: vi.fn(async () => ({
    sandboxId: handle.sandboxId, sessionId: handle.sessionId, persistent: false, status: 'running', sourceSnapshotId: 'snap_MotiveTrusted01',
    async runCommand(input: Parameters<VercelNativeArtifactSession['runCommand']>[0]) {
      events.push(input.args[0]);
      if (input.args[0] === '--capture-ascii') expect(persisted).not.toBeNull();
      const output = input.args[0] === '--bootstrap' ? `MOTIVE_COLLECTOR_BOOTSTRAP_V1\n${observedIdentity}\n`
        : 'MOTIVE_ARTIFACT_ASCII_V1\n1:2:3:4\nAP8K\n';
      return { commandId: input.args[0] === '--bootstrap' ? 'bootstrap_1' : 'capture_1', async wait() { return { exitCode: 0 }; },
        async *logs() { yield { stream: 'stdout' as const, data: output }; } };
    },
  })) };
  const options = { profile, runtimeRegistry: new StaticReviewedVercelNativeArtifactRuntimeRegistry([runtime]),
    context, store, transport, activation: 'local-test' as const };
  return { options, events, store, transport, runtime, getPersisted: () => persisted,
    persist(value: WorkerWorkspaceBindingInput) { persisted = structuredClone(value); },
    replaceObservedIdentity(value: string) { observedIdentity = value; },
    input: { handle, relativePath: 'out.bin', maximumBytes: 1024, maximumChunkBytes: 1024, signal: new AbortController().signal } };
}

describe('durable native artifact reader', () => {
  it('commits the protected binding before capture and reuses it after collector restart', async () => {
    const f = fixture();
    const output = await new DurableVercelNativeArtifactReader(f.options).capture(f.input);
    const chunks: Uint8Array[] = [];
    for await (const chunk of output!.read()) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 10]));
    expect(f.events).toEqual(['read-binding', '--bootstrap', 'commit-binding', '--bootstrap', '--capture-ascii']);
    f.events.length = 0;
    await new DurableVercelNativeArtifactReader(f.options).capture(f.input);
    expect(f.events).toEqual(['read-binding', '--bootstrap', '--capture-ascii']);
    expect(f.store.recordWorkerWorkspaceBinding).toHaveBeenCalledTimes(1);
  });

  it('captures no candidate bytes when durable persistence fails', async () => {
    const f = fixture();
    vi.mocked(f.store.recordWorkerWorkspaceBinding).mockRejectedValue(new Error('database unavailable'));
    await expect(new DurableVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow('database unavailable');
    expect(f.events).toEqual(['read-binding', '--bootstrap']);
  });

  it('rejects a replacement marker after restart without modifying the saved identity', async () => {
    const f = fixture();
    await new DurableVercelNativeArtifactReader(f.options).capture(f.input);
    f.replaceObservedIdentity('1:4:3');
    f.events.length = 0;
    await expect(new DurableVercelNativeArtifactReader(f.options).capture(f.input))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_WORKSPACE_IDENTITY_CHANGED' });
    expect(f.events).toEqual(['read-binding', '--bootstrap']);
    expect(f.getPersisted()?.binding.workspaceIdentity).toBe('1:2:3');
  });

  it('performs no database or provider operations while suspended or already cancelled', async () => {
    const f = fixture();
    await expect(new DurableVercelNativeArtifactReader({ ...f.options, activation: undefined }).capture(f.input))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_TRANSPORT_SUSPENDED' });
    await expect(new DurableVercelNativeArtifactReader(f.options).capture({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.events).toEqual([]);
    expect(f.transport.getExactSession).not.toHaveBeenCalled();
  });

  it('rejects caller session substitution before reading or collecting', async () => {
    const f = fixture();
    await expect(new DurableVercelNativeArtifactReader(f.options).capture({ ...f.input,
      handle: { ...f.input.handle, sessionId: 'replacement_session' } })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_HANDLE_INVALID' });
    expect(f.events).toEqual([]);
  });

  it('rejects malformed capture paths and limits before bootstrapping the worker', async () => {
    for (const override of [{ relativePath: '../escape' }, { maximumBytes: 0 }, { maximumChunkBytes: Number.NaN }]) {
      const f = fixture();
      await expect(new DurableVercelNativeArtifactReader(f.options).capture({ ...f.input, ...override })).rejects.toThrow();
      expect(f.events).toEqual([]);
      expect(f.transport.getExactSession).not.toHaveBeenCalled();
    }
  });
});

function claimedFixture() {
  const f = fixture();
  const { context } = f.options;
  const effects = new Map<string, NativeCollectionEffectProjection>();
  const workerRuntimeDigest = f.runtime.workerRuntimeDigest;
  const plan: NativeCollectionPlanProjection = {
    environmentId: context.environmentId, attemptId: context.handle.attemptId, leaseEpoch: 1,
    controllerGeneration: '1', profileDigest: digest, executionBoundaryKind: 'PROTECTED_RUNTIME',
    executionBoundaryDigest: workerRuntimeDigest, workerRuntimeDigest,
    collectorRuntimeDigest: f.runtime.runtimeDigest, collectionPlanDigest: digest, maximumFileBytes: 1024,
    maximumTotalBytes: 1024, maximumFiles: 1, maximumHelperCommands: 2,
    paths: [{ relativePath: 'out.bin', mediaType: 'application/octet-stream', availability: 'REQUIRED', maximumBytes: 1024, pathDigest: digest }],
    createdAt: '2026-09-06T00:00:00Z',
  };
  function planned(kind: 'BOOTSTRAP' | 'CAPTURE') {
    f.events.push(`plan-${kind}`);
    let effect = effects.get(kind);
    if (!effect) {
      effect = { effectId: kind, environmentId: context.environmentId, attemptId: context.handle.attemptId,
        workerCommandEffectId: 'worker-command', kind, state: 'INTENT_RECORDED', effectKey: kind,
        provider: 'vercel', externalId: context.handle.sandboxId, sessionId: context.handle.sessionId,
        leaseEpoch: 1, controllerGeneration: '1', profileDigest: digest, workerRuntimeDigest,
        collectorRuntimeDigest: plan.collectorRuntimeDigest, collectionPlanDigest: digest,
        bootstrapEffectId: kind === 'CAPTURE' ? 'BOOTSTRAP' : null,
        relativePath: kind === 'CAPTURE' ? 'out.bin' : null, pathDigest: kind === 'CAPTURE' ? digest : null,
        maximumBytes: kind === 'CAPTURE' ? 1024 : null, workspaceIdentity: kind === 'CAPTURE' ? '1:2:3' : null,
        claimed: false, claimedAt: null, providerCommandId: null, exitCode: null, stdoutDigest: null,
        stdoutBytes: null, unknownReason: null, createdAt: plan.createdAt, completedAt: null };
      effects.set(kind, effect);
    }
    return { effect: structuredClone(effect) };
  }
  const store: WorkerWorkspaceBindingStore & NativeCollectionStore = { ...f.store,
    freezeNativeCollectionPlan: vi.fn(async () => plan), getNativeCollectionPlan: vi.fn(async () => structuredClone(plan)),
    planNativeBootstrap: vi.fn(async () => planned('BOOTSTRAP')), planNativeCapture: vi.fn(async () => planned('CAPTURE')),
    claimNativeCollectionEffect: vi.fn(async (_lease, id) => {
      f.events.push(`claim-${id}`); const effect = effects.get(id)!;
      if (effect.state !== 'INTENT_RECORDED') return { effectId: id, claimed: false };
      effect.state = 'CLAIMED'; effect.claimed = true; return { effectId: id, claimed: true };
    }),
    recordNativeCollectionStarted: vi.fn(async (_lease, id, input) => {
      f.events.push(`started-${id}`); const effect = effects.get(id)!;
      effect.providerCommandId = input.providerCommandId; effect.state = 'START_RECORDED'; return structuredClone(effect);
    }),
    recordNativeBootstrapBinding: vi.fn(async (_lease, id, input) => {
      f.events.push(`completed-${id}`); effects.get(id)!.state = 'COMPLETED';
      const binding = { binding: input.binding, workerRuntimeDigest: f.runtime.workerRuntimeDigest };
      f.persist(binding); return binding;
    }),
    recordNativeCollectionCompleted: vi.fn(async (_lease, id, input) => {
      f.events.push(`completed-${id}`); const effect = effects.get(id)!;
      Object.assign(effect, input, { state: 'COMPLETED' }); return structuredClone(effect);
    }),
    markNativeCollectionUnknown: vi.fn(async (_lease, id) => {
      f.events.push(`unknown-${id}`); const effect = effects.get(id)!;
      effect.state = 'UNKNOWN'; return structuredClone(effect);
    }),
    getNativeCollectionEffect: vi.fn(async (_lease, id) => structuredClone(effects.get(id)!)),
    listNativeCollectionEffects: vi.fn(async () => [...effects.values()].map(effect => structuredClone(effect))),
  };
  const getSession = f.transport.getExactSession;
  f.transport.getExactSession = vi.fn(async input => {
    const session = await getSession(input); const run = session.runCommand;
    session.runCommand = async commandInput => {
      const kind = commandInput.args[0] === '--bootstrap' ? 'BOOTSTRAP' : 'CAPTURE';
      expect(effects.get(kind)?.state).toBe('CLAIMED');
      const command = await run(commandInput);
      return { ...command,
        async wait() { expect(effects.get(kind)?.state).toBe('START_RECORDED'); f.events.push(`wait-${kind}`); return { exitCode: 0 }; },
        async *logs(input) { expect(effects.get(kind)?.state).toBe('START_RECORDED'); f.events.push(`logs-${kind}`); yield* command.logs(input); },
      };
    };
    return session;
  });
  return { ...f, store, effects, plan, options: { ...f.options, store } };
}

describe('claimed native artifact transport', () => {
  it('claims exactly one bootstrap and capture, commits command IDs before results, and never redispatches after restart', async () => {
    const f = claimedFixture();
    const snapshot = await new ClaimedVercelNativeArtifactReader(f.options).capture(f.input);
    expect(snapshot?.declaredBytes).toBe(3);
    expect(f.events.filter(event => event.startsWith('--'))).toEqual(['--bootstrap', '--capture-ascii']);
    expect(f.events.indexOf('completed-BOOTSTRAP')).toBeLessThan(f.events.indexOf('--capture-ascii'));
    expect(f.store.recordWorkerWorkspaceBinding).not.toHaveBeenCalled();
    expect(f.store.recordNativeCollectionCompleted).toHaveBeenCalledWith(f.options.context.lease, 'CAPTURE', {
      exitCode: 0, stdoutBytes: 38, stdoutDigest: 'sha256:31ca348f93e63888e7c8124f3a75fb9bffb3cc65fdacaab79036c1f7cee77527',
    });
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_ALREADY_CLAIMED' });
    expect(f.events.filter(event => event.startsWith('--'))).toHaveLength(2);
  });

  it('leaves a failed start commit unknown and performs no wait, log read, or replacement launch', async () => {
    const f = claimedFixture();
    vi.mocked(f.store.recordNativeCollectionStarted).mockRejectedValue(new Error('commit failed'));
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow('commit failed');
    expect(f.effects.get('BOOTSTRAP')?.state).toBe('UNKNOWN');
    expect(f.events.some(event => /^(wait|logs)-/.test(event))).toBe(false);
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow();
    expect(f.events.filter(event => event.startsWith('--'))).toEqual(['--bootstrap']);
  });

  it('rejects an unapproved path or byte ceiling before claiming or launching capture', async () => {
    for (const override of [{ relativePath: 'extra.bin' }, { maximumBytes: 512 }]) {
      const f = claimedFixture();
      await expect(new ClaimedVercelNativeArtifactReader(f.options).capture({ ...f.input, ...override }))
        .rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_PATH_MISMATCH' });
      expect(f.events.filter(event => event.startsWith('--'))).toEqual(['--bootstrap']);
      expect(f.effects.has('CAPTURE')).toBe(false);
    }
  });

  it('consumes a claim when the provider rejects ambiguously, even if recording unknown also fails', async () => {
    const f = claimedFixture();
    const getSession = f.transport.getExactSession;
    let launches = 0;
    f.transport.getExactSession = vi.fn(async input => ({ ...await getSession(input),
      async runCommand() { launches++; throw new Error('socket lost after dispatch'); },
    }));
    vi.mocked(f.store.markNativeCollectionUnknown).mockRejectedValue(new Error('database lost'));
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow();
    expect(f.effects.get('BOOTSTRAP')?.state).toBe('CLAIMED');
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_ALREADY_CLAIMED' });
    expect(launches).toBe(1);
    expect(f.store.recordNativeCollectionStarted).not.toHaveBeenCalled();
  });

  it('does not expose candidate bytes when their completion commit fails', async () => {
    const f = claimedFixture();
    vi.mocked(f.store.recordNativeCollectionCompleted).mockRejectedValue(new Error('completion commit failed'));
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow('completion commit failed');
    expect(f.effects.get('CAPTURE')?.state).toBe('UNKNOWN');
    expect(f.getPersisted()).not.toBeNull();
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input)).rejects.toThrow();
    expect(f.events.filter(event => event.startsWith('--'))).toEqual(['--bootstrap', '--capture-ascii']);
  });

  it('does not launch when cancellation arrives after the durable claim', async () => {
    const f = claimedFixture(); const abort = new AbortController();
    const claim = f.store.claimNativeCollectionEffect;
    f.store.claimNativeCollectionEffect = vi.fn(async (lease, effectId) => { const result = await claim(lease, effectId); abort.abort(); return result; });
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture({ ...f.input, signal: abort.signal })).rejects.toThrow();
    expect(f.effects.get('BOOTSTRAP')?.state).toBe('UNKNOWN');
    expect(f.events.filter(event => event.startsWith('--'))).toEqual([]);
  });

  it('bounds a stuck command-start commit and never begins reading provider results', async () => {
    vi.useFakeTimers();
    try {
      const f = claimedFixture();
      vi.mocked(f.store.recordNativeCollectionStarted).mockImplementation(() => new Promise(() => undefined));
      const capture = new ClaimedVercelNativeArtifactReader({ ...f.options, commandTimeoutMs: 1000, logTimeoutMs: 4000 }).capture(f.input);
      const rejection = expect(capture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_COMMAND_DEADLINE' });
      await vi.advanceTimersByTimeAsync(3001);
      await rejection;
      expect(f.effects.get('BOOTSTRAP')?.state).toBe('UNKNOWN');
      expect(f.events.some(event => /^(wait|logs)-/.test(event))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('bounds unknown-metadata persistence so a failed helper cannot indefinitely block teardown', async () => {
    vi.useFakeTimers();
    try {
      const f = claimedFixture();
      vi.mocked(f.store.recordNativeCollectionStarted).mockRejectedValue(new Error('start commit failed'));
      vi.mocked(f.store.markNativeCollectionUnknown).mockImplementation(() => new Promise(() => undefined));
      const capture = new ClaimedVercelNativeArtifactReader(f.options).capture(f.input);
      const rejection = expect(capture).rejects.toThrow('start commit failed');
      await vi.advanceTimersByTimeAsync(5001);
      await rejection;
      expect(f.effects.get('BOOTSTRAP')?.state).toBe('CLAIMED');
      expect(f.events.filter(event => event.startsWith('--'))).toEqual(['--bootstrap']);
    } finally { vi.useRealTimers(); }
  });

  it('refuses a missing frozen plan before any provider command and leaves cancellation undispatched', async () => {
    const f = claimedFixture();
    vi.mocked(f.store.getNativeCollectionPlan).mockResolvedValue(null);
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture(f.input))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_PLAN_MISMATCH' });
    expect(f.events.filter(event => event.startsWith('--'))).toEqual([]);
    expect(f.store.claimNativeCollectionEffect).not.toHaveBeenCalled();
    await expect(new ClaimedVercelNativeArtifactReader(f.options).capture({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.store.getNativeCollectionPlan).toHaveBeenCalledTimes(1);
  });
});

function serviceFixture() {
  const f = claimedFixture();
  const plan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: f.options.context.handle.attemptId,
    termsDigest: digest, inputDigest: digest, inferenceProfileDigest: digest, actorId: 'reviewed-local-operator',
    sandbox: f.options.profile, infrastructureAuthorizationId: f.options.context.environmentId,
    maximumCostUsd: '1.000000000000', command: { executable: '/usr/local/bin/codex', args: ['exec', 'fixture'] },
    capabilityTtlSeconds: 60, nativeCollection: { collectorRuntimeDigest: f.runtime.runtimeDigest,
      maximumFileBytes: 1024, maximumTotalBytes: 1024,
      approvedPaths: [{ relativePath: 'out.bin', maximumBytes: 512, mediaType: 'application/octet-stream', availability: 'REQUIRED' }] },
  };
  const objectStore = { putIfAbsent: vi.fn(async () => { throw new Error('unexpected object write'); }),
    readObject: vi.fn(async () => { throw new Error('unexpected object read'); }) };
  return { ...f, plan, serviceOptions: { ...f.options, objectStore } };
}

describe('claimed collector coordinator service', () => {
  it('stays suspended by default and performs no provider, database or storage work during valid local preflight', async () => {
    const f = serviceFixture();
    await expect(createClaimedNativeArtifactCollector({ ...f.serviceOptions, activation: undefined }).assertReady(f.plan))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_TRANSPORT_SUSPENDED' });
    await expect(createClaimedNativeArtifactCollector(f.serviceOptions).assertReady(f.plan)).resolves.toBeUndefined();
    expect(f.events).toEqual([]);
    expect(f.store.getNativeCollectionPlan).not.toHaveBeenCalled();
    expect(f.transport.getExactSession).not.toHaveBeenCalled();
    expect(f.serviceOptions.objectStore.putIfAbsent).not.toHaveBeenCalled();
    expect(f.serviceOptions.objectStore.readObject).not.toHaveBeenCalled();
  });

  it('rejects missing, mismatched or excessive budgets before a coordinator can reserve its VM', async () => {
    const f = serviceFixture();
    const missing = structuredClone(f.plan); delete missing.nativeCollection;
    const wrongRuntime = structuredClone(f.plan); wrongRuntime.nativeCollection!.collectorRuntimeDigest = digest;
    const overflow = structuredClone(f.plan); overflow.nativeCollection!.approvedPaths = [...overflow.nativeCollection!.approvedPaths, {
      ...overflow.nativeCollection!.approvedPaths[0], relativePath: 'extra.bin', maximumBytes: 1024 }];
    const duplicate = structuredClone(f.plan); duplicate.nativeCollection!.approvedPaths = [...duplicate.nativeCollection!.approvedPaths, duplicate.nativeCollection!.approvedPaths[0]];
    for (const plan of [missing, wrongRuntime, overflow, duplicate]) {
      await expect(createClaimedNativeArtifactCollector(f.serviceOptions).assertReady(plan))
        .rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_PLAN_INVALID' });
    }
    expect(f.events).toEqual([]);
    expect(f.transport.getExactSession).not.toHaveBeenCalled();
  });
});
