import { describe, expect, it, vi } from 'vitest';
import {
  VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH,
  VercelNativeArtifactReader,
  createNativeVercelArtifactTransport,
  decodeNativeArtifactAsciiFrame,
  decodeNativeCollectorBootstrapFrame,
  defineReviewedVercelNativeArtifactRuntime,
  StaticReviewedVercelNativeArtifactRuntimeRegistry,
  type FrozenVercelNativeWorkspaceBinding,
  type VercelNativeCommand,
  type VercelNativeArtifactSession,
  type VercelNativeArtifactTransport,
} from '../../packages/artifact-storage/src/index.ts';
import { defineProtectedRuntime, sandboxName, type SandboxExecutionProfile, type SandboxHandle } from '../../packages/sandbox-vercel/src/index.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const attemptId = '00000000-0000-4000-8000-000000000001';

function profile(): SandboxExecutionProfile {
  return {
    format: 'motive.sandbox-profile/0.1',
    profileDigest: digest('1'),
    protectedRuntime: defineProtectedRuntime(digest('2')),
    trustedSource: {
      kind: 'snapshot',
      snapshotId: 'snap_MotiveTrusted01',
      materialDigest: digest('3'),
      buildRecipeDigest: digest('4'),
      sourceCommit: 'a'.repeat(40),
    },
    timeoutMs: 60_000,
    commandTimeoutMs: 30_000,
    vcpus: 2,
    allowedExecutables: ['/usr/local/bin/codex'],
    egress: {
      gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
      artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }],
    },
    artifacts: { maxFiles: 2, maxFileBytes: 1_024, maxTotalBytes: 2_048 },
  };
}

function handle(value = profile()): SandboxHandle {
  return {
    provider: 'vercel',
    attemptId,
    leaseEpoch: 1,
    sandboxId: sandboxName(attemptId, 1),
    sessionId: 'session_1',
    profileDigest: value.profileDigest,
  };
}

function runtime(value: SandboxExecutionProfile) {
  const protectedRuntime = value.protectedRuntime!;
  return defineReviewedVercelNativeArtifactRuntime({
    format: 'motive.vercel-native-artifact-runtime/0.1',
    profileDigest: value.profileDigest,
    source: value.trustedSource,
    workerRuntimeDigest: protectedRuntime.runtimeDigest,
    workerLauncherDigest: protectedRuntime.launcherDigest,
    collectorPath: '/opt/motive/bin/artifact-collector',
    collectorDigest: digest('5'),
    collectorLauncherPath: '/opt/motive/bin/artifact-collector-launcher',
    collectorLauncherDigest: digest('6'),
    bootstrapPath: '/var/lib/motive/control/worker-bootstrap.json',
    collectorUid: 1000,
    workerUid: 2000,
  });
}

it('binds a manifest snapshot digest in the reviewed native runtime registry', () => {
  const value = profile();
  value.trustedSource = {
    kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', materialDigest: digest('3'),
    buildRecipeDigest: digest('4'), sourceSnapshotDigest: digest('7'),
  };
  expect(runtime(value).source).toEqual(value.trustedSource);

  const invalid = profile();
  invalid.trustedSource = { ...invalid.trustedSource, sourceSnapshotDigest: digest('7') } as never;
  expect(() => runtime(invalid)).toThrow();
});

function asciiFrame(body: Buffer, device = 11, inode = 12): string {
  const encoded = body.toString('base64');
  return `MOTIVE_ARTIFACT_ASCII_V1\n${device}:${inode}:${body.length}:${encoded.length}\n${encoded}\n`;
}

function bootstrap(identity = '1:2:3'): string {
  return `MOTIVE_COLLECTOR_BOOTSTRAP_V1\n${identity}\n`;
}

function fakeCommand(stdout: string, options: { exitCode?: number; stderr?: string } = {}) {
  const wait = vi.fn(async () => ({ exitCode: options.exitCode ?? 0 }));
  const logs = vi.fn(async function* () {
    if (stdout.length > 0) yield { stream: 'stdout' as const, data: stdout };
    if ((options.stderr ?? '').length > 0) yield { stream: 'stderr' as const, data: options.stderr! };
  });
  return { commandId: 'capture_1', wait, logs };
}

function fixture(options: {
  activation?: 'suspended' | 'local-test';
  bindings?: readonly FrozenVercelNativeWorkspaceBinding[];
  commands?: readonly VercelNativeCommand[];
  commandTimeoutMs?: number;
  logTimeoutMs?: number;
} = {}) {
  const frozenProfile = profile();
  const frozenRuntime = runtime(frozenProfile);
  const frozenHandle = handle(frozenProfile);
  const bindings = options.bindings ?? [{
    format: 'motive.vercel-native-workspace-binding/0.1' as const,
    handle: frozenHandle,
    workspaceIdentity: '1:2:3',
    runtimeDigest: frozenRuntime.runtimeDigest,
  }];
  const commands = [...(options.commands ?? [fakeCommand(bootstrap()), fakeCommand(asciiFrame(Buffer.from([0, 255, 10])) )])];
  const runCommand = vi.fn(async () => {
    const next = commands.shift();
    if (!next) throw new Error('unexpected collector command');
    return next;
  });
  const session: VercelNativeArtifactSession = {
    sandboxId: frozenHandle.sandboxId,
    sessionId: frozenHandle.sessionId,
    persistent: false,
    status: 'running',
    sourceSnapshotId: frozenProfile.trustedSource.kind === 'snapshot' ? frozenProfile.trustedSource.snapshotId : undefined,
    runCommand,
  };
  const transport: VercelNativeArtifactTransport = { getExactSession: vi.fn(async () => session) };
  const reader = new VercelNativeArtifactReader({
    profile: frozenProfile,
    runtimeRegistry: new StaticReviewedVercelNativeArtifactRuntimeRegistry([frozenRuntime]),
    bindings,
    transport,
    activation: options.activation ?? 'local-test',
    commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
    logTimeoutMs: options.logTimeoutMs ?? 2_000,
  });
  return { reader, frozenHandle, transport, session, commands, bindings };
}

async function bytes(snapshot: Awaited<ReturnType<VercelNativeArtifactReader['capture']>>) {
  const output: Uint8Array[] = [];
  if (!snapshot) return null;
  for await (const chunk of snapshot.read()) output.push(chunk);
  return Buffer.concat(output);
}

describe('Vercel native artifact reader', () => {
  it('uses only an exact non-resumed session and decodes direct protected ASCII stdout', async () => {
    const f = fixture();
    const result = await f.reader.capture({
      handle: f.frozenHandle,
      relativePath: 'out.bin',
      maximumBytes: 16,
      maximumChunkBytes: 2,
      signal: new AbortController().signal,
    });
    expect(await bytes(result)).toEqual(Buffer.from([0, 255, 10]));
    expect(f.transport.getExactSession).toHaveBeenCalledWith(expect.objectContaining({
      name: f.frozenHandle.sandboxId,
      resume: false,
    }));
    expect(f.session.runCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cmd: VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH,
      args: ['--bootstrap'], cwd: '/', env: {}, sudo: true, detached: true,
    }));
    expect(f.session.runCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cmd: VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH,
      args: ['--capture-ascii', 'out.bin', '16', '1:2:3'], cwd: '/', env: {}, sudo: true, detached: true,
    }));
  });

  it('remains suspended by default and performs no provider command', async () => {
    const f = fixture({ activation: 'suspended' });
    await expect(f.reader.assertReady({ signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_TRANSPORT_SUSPENDED' });
    await expect(f.reader.capture({
      handle: f.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_TRANSPORT_SUSPENDED' });
    expect(f.transport.getExactSession).not.toHaveBeenCalled();
  });

  it('does not construct provider work after cancellation, including the command boundary', async () => {
    const preAborted = fixture();
    const rejectingObservation = vi.fn(() => Promise.reject(new Error('must not run')));
    preAborted.transport.getExactSession = rejectingObservation;
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(preAborted.reader.capture({
      handle: preAborted.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: alreadyCancelled.signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_DEADLINE' });
    expect(rejectingObservation).not.toHaveBeenCalled();

    const betweenObservationAndCommand = fixture();
    const cancellation = new AbortController();
    betweenObservationAndCommand.transport.getExactSession = vi.fn(() => {
      queueMicrotask(() => cancellation.abort());
      return Promise.resolve(betweenObservationAndCommand.session);
    });
    await expect(betweenObservationAndCommand.reader.capture({
      handle: betweenObservationAndCommand.frozenHandle,
      relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: cancellation.signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_DEADLINE' });
    expect(betweenObservationAndCommand.session.runCommand).not.toHaveBeenCalled();
  });

  it('observes a rejecting provider promise even when it aborts during construction', async () => {
    const f = fixture();
    const cancellation = new AbortController();
    const rejectingObservation = vi.fn(() => {
      cancellation.abort();
      return Promise.reject(new Error('synthetic provider rejection'));
    });
    f.transport.getExactSession = rejectingObservation;
    const capture = f.reader.capture({
      handle: f.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: cancellation.signal,
    });
    const expectedRejection = expect(capture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_DEADLINE' });
    await expectedRejection;
    expect(rejectingObservation).toHaveBeenCalledTimes(1);
  });

  it('requires a durable bootstrap binding and never adopts a changed reread identity', async () => {
    const unbound = fixture({ bindings: [] });
    await expect(unbound.reader.capture({
      handle: unbound.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_BOOTSTRAP_UNBOUND' });
    expect(unbound.transport.getExactSession).not.toHaveBeenCalled();

    const changed = fixture({ commands: [fakeCommand(bootstrap('9:8:7'))] });
    await expect(changed.reader.capture({
      handle: changed.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_WORKSPACE_IDENTITY_CHANGED' });
    expect(changed.session.runCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects another session, terminal state, changed source, stderr, and nonzero collector outcome', async () => {
    const checks: Array<[string, (f: ReturnType<typeof fixture>) => void, string]> = [
      ['session', f => { f.session.sessionId = 'replacement'; }, 'VERCEL_NATIVE_SESSION_MISMATCH'],
      ['terminal', f => { f.session.status = 'stopped'; }, 'VERCEL_NATIVE_SESSION_MISMATCH'],
      ['source', f => { f.session.sourceSnapshotId = 'snap_Replacement'; }, 'VERCEL_NATIVE_SOURCE_MISMATCH'],
      ['stderr', f => { f.commands.splice(1, 1, fakeCommand(asciiFrame(Buffer.from('x')), { stderr: 'diagnostic' })); }, 'VERCEL_NATIVE_STDERR_PRESENT'],
      ['failure', f => { f.commands.splice(1, 1, fakeCommand('', { exitCode: 1 })); }, 'VERCEL_NATIVE_COMMAND_FAILED'],
    ];
    for (const [name, mutate, code] of checks) {
      const f = fixture();
      mutate(f);
      await expect(f.reader.capture({
        handle: f.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
      }), name).rejects.toMatchObject({ code });
    }
  });

  it('strictly rejects malformed, duplicate, trailing, non-ASCII, and overlong ASCII frames', () => {
    const valid = asciiFrame(Buffer.from('abc'));
    expect(() => decodeNativeArtifactAsciiFrame(valid, 'out', 3, 3)).not.toThrow();
    for (const frame of [
      valid.replace('4\nYWJj\n', '3\nYWJj\n'),
      `${valid}${valid}`,
      `${valid}trailing`,
      valid.replace('MOTIVE', 'XOTIVE'),
      valid.replace('YWJj', 'YWJ!'),
      valid.replace('YWJj', 'YWJj='),
      valid.replace('MOTIVE', 'MOTIVÉ'),
    ]) {
      expect(() => decodeNativeArtifactAsciiFrame(frame, 'out', 3, 3)).toThrow();
    }
  });

  it('accepts only the exact root-only bootstrap frame', () => {
    expect(decodeNativeCollectorBootstrapFrame(bootstrap())).toBe('1:2:3');
    for (const frame of [bootstrap('01:2:3'), `${bootstrap()}extra`, 'MOTIVE_COLLECTOR_BOOTSTRAP_V1\n1:2:3\n1:2:3\n']) {
      expect(() => decodeNativeCollectorBootstrapFrame(frame)).toThrow();
    }
  });

  it('races an ignored provider abort for observation, command creation, wait, and log iteration', async () => {
    const observation = fixture();
    observation.transport.getExactSession = vi.fn(
      () => new Promise<VercelNativeArtifactSession>(() => undefined),
    );
    const observationAbort = new AbortController();
    const observationCapture = observation.reader.capture({
      handle: observation.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: observationAbort.signal,
    });
    observationAbort.abort();
    await expect(observationCapture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_DEADLINE' });

    const commandCreation = fixture();
    const commandStarted = vi.fn(() => new Promise<VercelNativeCommand>(() => undefined));
    commandCreation.session.runCommand = commandStarted;
    const commandAbort = new AbortController();
    const commandCapture = commandCreation.reader.capture({
      handle: commandCreation.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: commandAbort.signal,
    });
    await vi.waitFor(() => expect(commandStarted).toHaveBeenCalledTimes(1));
    commandAbort.abort();
    await expect(commandCapture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_COMMAND_DEADLINE' });

    const wait = fixture();
    const stuckWait: VercelNativeCommand = {
      commandId: 'capture_1',
      wait: () => new Promise<{ exitCode: number | null }>(() => undefined),
      async *logs() { yield { stream: 'stdout', data: asciiFrame(Buffer.from('x')) }; },
    };
    wait.commands.splice(1, 1, stuckWait);
    const waitAbort = new AbortController();
    const waitCapture = wait.reader.capture({
      handle: wait.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: waitAbort.signal,
    });
    await vi.waitFor(() => expect(wait.session.runCommand).toHaveBeenCalledTimes(2));
    waitAbort.abort();
    await expect(waitCapture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_COMMAND_DEADLINE' });

    const logs = fixture();
    const stuckLogs: VercelNativeCommand = {
      commandId: 'capture_1',
      async wait() { return { exitCode: 0 }; },
      logs() {
        return {
          [Symbol.asyncIterator](): AsyncIterator<{ stream: 'stdout' | 'stderr'; data: string }> {
            return { next: () => new Promise<IteratorResult<{ stream: 'stdout' | 'stderr'; data: string }>>(() => undefined) };
          },
        };
      },
    };
    logs.commands.splice(1, 1, stuckLogs);
    const logAbort = new AbortController();
    const logCapture = logs.reader.capture({
      handle: logs.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: logAbort.signal,
    });
    await vi.waitFor(() => expect(logs.session.runCommand).toHaveBeenCalledTimes(2));
    logAbort.abort();
    await expect(logCapture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_LOG_DEADLINE' });
  });

  it('uses its own deadline when an exact-session observation ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ commandTimeoutMs: 1_000, logTimeoutMs: 1_000 });
      f.transport.getExactSession = vi.fn(() => new Promise<VercelNativeArtifactSession>(() => undefined));
      const capture = f.reader.capture({
        handle: f.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
      });
      const expectedRejection = expect(capture).rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_DEADLINE' });
      await vi.advanceTimersByTimeAsync(3_001);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a stuck command wait when the stdout parser rejects first', async () => {
    const f = fixture();
    let waitSignal: AbortSignal | undefined;
    const second: VercelNativeCommand = {
      commandId: 'capture_1',
      wait: ({ signal }) => {
        waitSignal = signal;
        return new Promise<{ exitCode: number | null }>(() => undefined);
      },
      async *logs() { yield { stream: 'stdout', data: 'not-ascii-\u00e9' }; },
    };
    f.commands.splice(1, 1, second);
    await expect(f.reader.capture({
      handle: f.frozenHandle, relativePath: 'out', maximumBytes: 8, maximumChunkBytes: 8, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_STDOUT_INVALID' });
    expect(waitSignal?.aborted).toBe(true);
  });

  it('round-trips a bounded 6 MiB ASCII frame without regex backtracking', async () => {
    const raw = Buffer.alloc(6 * 1024 * 1024, 0xa5);
    const decoded = decodeNativeArtifactAsciiFrame(asciiFrame(raw), 'large.bin', 8 * 1024 * 1024, 1024 * 1024);
    expect(decoded.declaredBytes).toBe(raw.byteLength);
    let offset = 0;
    for await (const chunk of decoded.read()) {
      expect(Buffer.compare(chunk, raw.subarray(offset, offset + chunk.byteLength))).toBe(0);
      offset += chunk.byteLength;
    }
    expect(offset).toBe(raw.byteLength);
  });

  it('the pinned SDK transport sends a single resume:false observation request on an upstream failure', async () => {
    let calls = 0;
    let resume: unknown;
    const rawFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const request = input instanceof Request ? input : new Request(input, init);
      resume = new URL(request.url).searchParams.get('resume');
      return new Response(JSON.stringify({ error: { message: 'synthetic failure' } }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = createNativeVercelArtifactTransport({ token: 'token', teamId: 'team', projectId: 'project' }, rawFetch);
    await expect(transport.getExactSession({ name: 'motive-w-synthetic', resume: false, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'VERCEL_NATIVE_SESSION_OBSERVATION_FAILED' });
    expect(calls).toBe(1);
    expect(resume).toBe('false');
  });
});
