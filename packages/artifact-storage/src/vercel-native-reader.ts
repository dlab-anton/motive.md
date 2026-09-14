import { createHash } from 'node:crypto';
import { Sandbox, type Command } from '@vercel/sandbox';
import {
  assertDigest,
  canonicalJson,
  digestCanonicalJson,
  type Digest,
} from '../../domain/src/contracts.ts';
import {
  createSingleAttemptFetch,
  requireProtectedRuntime,
  sandboxName,
  validateProfile,
  validateTrustedSourceIdentity,
  type NativeVercelCredentials,
  type SandboxExecutionProfile,
  type SandboxHandle,
  type TrustedSource,
} from '../../sandbox-vercel/src/index.ts';
import { ArtifactStorageError, validateArtifactRelativePath } from './sealer.ts';
import type { SafeArtifactReader, SafeArtifactSnapshot } from './types.ts';

export const VERCEL_NATIVE_ARTIFACT_RUNTIME_FORMAT = 'motive.vercel-native-artifact-runtime/0.1' as const;
export const VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT = 'motive.vercel-native-workspace-binding/0.1' as const;
export const VERCEL_ARTIFACT_COLLECTOR_PATH = '/opt/motive/bin/artifact-collector' as const;
export const VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH = '/opt/motive/bin/artifact-collector-launcher' as const;
export const VERCEL_WORKER_BOOTSTRAP_PATH = '/var/lib/motive/control/worker-bootstrap.json' as const;
export const VERCEL_ARTIFACT_COLLECTOR_UID = 1000 as const;
export const VERCEL_ARTIFACT_WORKER_UID = 2000 as const;

/* Command logs are text, so retain a deliberately lower cap than the native
 * binary collector. This bounds every live copy made while canonical base64 is
 * decoded and re-checked. */
const MAXIMUM_BYTES = 8 * 1024 * 1024;
const MAXIMUM_COMMAND_TIMEOUT_MS = 30_000;
const MAXIMUM_LOG_TIMEOUT_MS = 45_000;
const MAXIMUM_DIAGNOSTIC_BYTES = 4 * 1024;
const MAXIMUM_HEADER_BYTES = 256;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const WORKSPACE_IDENTITY = /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/;

export type ReviewedVercelNativeArtifactRuntime = {
  format: typeof VERCEL_NATIVE_ARTIFACT_RUNTIME_FORMAT;
  /** Matches the frozen sandbox profile, never an arbitrary command caller. */
  profileDigest: Digest;
  /** The full reviewed source identity, including material/build/commit evidence. */
  source: TrustedSource;
  /** Existing protected worker runtime policy and its root launcher byte digest. */
  workerRuntimeDigest: Digest;
  workerLauncherDigest: Digest;
  collectorPath: typeof VERCEL_ARTIFACT_COLLECTOR_PATH;
  collectorDigest: Digest;
  collectorLauncherPath: typeof VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH;
  collectorLauncherDigest: Digest;
  bootstrapPath: typeof VERCEL_WORKER_BOOTSTRAP_PATH;
  collectorUid: typeof VERCEL_ARTIFACT_COLLECTOR_UID;
  workerUid: typeof VERCEL_ARTIFACT_WORKER_UID;
  /** Canonical digest of every field above except this one. */
  runtimeDigest: Digest;
};

export type ReviewedVercelNativeArtifactRuntimeInput = Omit<ReviewedVercelNativeArtifactRuntime, 'runtimeDigest'>;

/**
 * Defines a registry entry's canonical byte identity. Calling this does not
 * review an image; deployment must put only reviewed entries in a registry.
 */
export function defineReviewedVercelNativeArtifactRuntime(
  input: ReviewedVercelNativeArtifactRuntimeInput,
): ReviewedVercelNativeArtifactRuntime {
  const normalized = normalizeRuntime(input);
  return Object.freeze({ ...normalized, runtimeDigest: digestCanonicalJson(normalized) });
}

export interface ReviewedVercelNativeArtifactRuntimeRegistry {
  resolve(profile: SandboxExecutionProfile): ReviewedVercelNativeArtifactRuntime | null;
}

/** Immutable in-process registry. It copies every entry and returns copies so
 * later caller mutation cannot alter a selected native runtime. */
export class StaticReviewedVercelNativeArtifactRuntimeRegistry implements ReviewedVercelNativeArtifactRuntimeRegistry {
  private readonly entries: readonly ReviewedVercelNativeArtifactRuntime[];

  constructor(entries: readonly ReviewedVercelNativeArtifactRuntime[]) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 128) {
      failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
    }
    const seen = new Set<string>();
    this.entries = entries.map(entry => {
      const normalized = normalizeRuntime(entry);
      if (entry.runtimeDigest !== digestCanonicalJson(normalized)) failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
      const frozen = Object.freeze({ ...normalized, runtimeDigest: entry.runtimeDigest } satisfies ReviewedVercelNativeArtifactRuntime);
      if (seen.has(frozen.profileDigest)) failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
      seen.add(frozen.profileDigest);
      return frozen;
    });
  }

  resolve(profile: SandboxExecutionProfile): ReviewedVercelNativeArtifactRuntime | null {
    const found = this.entries.find(entry => entry.profileDigest === profile.profileDigest);
    return found ? structuredClone(found) : null;
  }
}

/** The controller persists its first accepted binding while this exact running
 * VM/session is still observable. The source record is root-owned but `0444`,
 * so UID 1000 may verify it; it is not a root-only read. Capture never
 * replaces a durable binding with a new identity. */
export type FrozenVercelNativeWorkspaceBinding = {
  format: typeof VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT;
  handle: SandboxHandle;
  workspaceIdentity: string;
  runtimeDigest: Digest;
};

export type VercelNativeCommand = {
  commandId: string;
  wait(input: { signal: AbortSignal }): Promise<{ exitCode: number | null }>;
  logs(input: { signal: AbortSignal }): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>;
};

/** Exact current session only. `resume` is deliberately a false literal. */
export type VercelNativeArtifactSession = {
  sandboxId: string;
  sessionId: string;
  persistent: boolean;
  status: string;
  sourceSnapshotId?: string;
  image?: string;
  runCommand(input: {
    cmd: typeof VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH;
    args: readonly string[];
    cwd: '/';
    env: Readonly<Record<string, never>>;
    sudo: true;
    detached: true;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<VercelNativeCommand>;
};

export type VercelNativeArtifactTransport = {
  getExactSession(input: {
    name: string;
    resume: false;
    signal: AbortSignal;
  }): Promise<VercelNativeArtifactSession>;
};

/** Uses only `Sandbox.get({resume:false})`, then the returned Session's
 * `runCommand`. It never uses `Sandbox.runCommand`, readFile, or getOrCreate. */
export function createNativeVercelArtifactTransport(
  credentials: NativeVercelCredentials,
  rawFetch: typeof globalThis.fetch = globalThis.fetch,
): VercelNativeArtifactTransport {
  const fetch = createSingleAttemptFetch(rawFetch);
  return {
    async getExactSession(input) {
      if (input.resume !== false) failure('VERCEL_NATIVE_RESUME_FORBIDDEN');
      if (input.signal.aborted) failure('VERCEL_NATIVE_SESSION_DEADLINE');
      let sandbox: Awaited<ReturnType<typeof Sandbox.get>>;
      try {
        sandbox = await Sandbox.get({
          name: input.name,
          resume: false,
          token: credentials.token,
          teamId: credentials.teamId,
          projectId: credentials.projectId,
          fetch,
          signal: input.signal,
        });
      } catch {
        failure('VERCEL_NATIVE_SESSION_OBSERVATION_FAILED');
      }
      let session;
      try { session = sandbox.currentSession(); }
      catch { failure('VERCEL_NATIVE_SESSION_OBSERVATION_FAILED'); }
      return {
        sandboxId: sandbox.name,
        sessionId: session.sessionId,
        persistent: sandbox.persistent,
        status: session.status,
        ...(sandbox.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: sandbox.sourceSnapshotId }),
        ...(sandbox.image === undefined ? {} : { image: sandbox.image }),
        async runCommand(commandInput) {
          if (commandInput.signal.aborted) failure('VERCEL_NATIVE_COMMAND_DEADLINE');
          let command: Command;
          try {
            command = await session.runCommand({
              cmd: commandInput.cmd,
              args: [...commandInput.args],
              cwd: commandInput.cwd,
              env: {},
              sudo: true,
              detached: true,
              timeoutMs: commandInput.timeoutMs,
              signal: commandInput.signal,
            });
          } catch {
            failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
          }
          if (!('cmdId' in command) || typeof command.cmdId !== 'string' || command.cmdId.length === 0) {
            failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
          }
          return {
            commandId: command.cmdId,
            async wait({ signal }) {
              if (signal.aborted) failure('VERCEL_NATIVE_COMMAND_DEADLINE');
              try {
                const finished = await command.wait({ signal });
                return { exitCode: finished.exitCode };
              } catch {
                failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
              }
            },
            async *logs({ signal }) {
              if (signal.aborted) failure('VERCEL_NATIVE_LOG_DEADLINE');
              try {
                for await (const log of command.logs({ signal })) {
                  if (log.stream !== 'stdout' && log.stream !== 'stderr' || typeof log.data !== 'string') {
                    failure('VERCEL_NATIVE_LOG_INVALID');
                  }
                  yield { stream: log.stream, data: log.data };
                }
              } catch (error) {
                if (error instanceof ArtifactStorageError) throw error;
                failure('VERCEL_NATIVE_LOG_UNAVAILABLE');
              }
            },
          };
        },
      };
    },
  };
}

export type VercelNativeArtifactReaderOptions = {
  profile: SandboxExecutionProfile;
  runtimeRegistry: ReviewedVercelNativeArtifactRuntimeRegistry;
  /** Durable controller data from its first accepted protected bootstrap read. */
  bindings: readonly FrozenVercelNativeWorkspaceBinding[];
  transport: VercelNativeArtifactTransport;
  /** Trusted controller hook for durable helper claims. The native capture
   * itself verifies the frozen identity, so this mode needs no extra marker command. */
  collectorExecutor?: VercelNativeCollectorExecutor;
  /** No production bootstrap supplies this today. Test-only permits fake/local commands. */
  activation?: 'suspended' | 'local-test';
  commandTimeoutMs?: number;
  logTimeoutMs?: number;
};

export type VercelNativeCollectorIntent = { kind: 'BOOTSTRAP' } | {
  kind: 'CAPTURE'; relativePath: string; maximumBytes: number; workspaceIdentity: string;
};
export type VercelNativeCollectorResult = { stdout: string; stderrBytes: number; exitCode: number | null };
export interface VercelNativeCollectorExecutor {
  execute(input: {
    handle: SandboxHandle; runtimeDigest: Digest; intent: VercelNativeCollectorIntent; signal: AbortSignal;
    /** Must be called at most once, after a durable dispatch claim. */
    run(onStarted: (commandId: string) => Promise<void>): Promise<VercelNativeCollectorResult>;
  }): Promise<VercelNativeCollectorResult>;
}

/**
 * Vercel command-log transport for the native collector. The implementation is
 * deliberately not wired into coordinator bootstrap and starts suspended.
 * Local tests exercise its protocol; no live Vercel extraction is asserted.
 */
export class VercelNativeArtifactReader implements SafeArtifactReader {
  private readonly profile: SandboxExecutionProfile;
  private readonly runtime: ReviewedVercelNativeArtifactRuntime;
  private readonly bindings: readonly FrozenVercelNativeWorkspaceBinding[];
  private readonly activation: 'suspended' | 'local-test';
  private readonly commandTimeoutMs: number;
  private readonly logTimeoutMs: number;

  constructor(private readonly options: VercelNativeArtifactReaderOptions) {
    try { validateProfile(options.profile); }
    catch { failure('VERCEL_NATIVE_PROFILE_INVALID'); }
    this.profile = cloneProfile(options.profile);
    const selected = options.runtimeRegistry.resolve(this.profile);
    if (!selected) failure('VERCEL_NATIVE_RUNTIME_UNREVIEWED');
    this.runtime = verifySelectedRuntime(this.profile, selected);
    this.bindings = validateBindings(options.bindings, this.runtime, this.profile);
    this.activation = options.activation ?? 'suspended';
    this.commandTimeoutMs = finiteTimeout(options.commandTimeoutMs ?? 10_000, 'VERCEL_NATIVE_COMMAND_TIMEOUT_INVALID', MAXIMUM_COMMAND_TIMEOUT_MS);
    this.logTimeoutMs = finiteTimeout(options.logTimeoutMs ?? 15_000, 'VERCEL_NATIVE_LOG_TIMEOUT_INVALID', MAXIMUM_LOG_TIMEOUT_MS);
    if (this.logTimeoutMs < this.commandTimeoutMs) failure('VERCEL_NATIVE_LOG_TIMEOUT_INVALID');
  }

  async assertReady(_input: { signal: AbortSignal }): Promise<{ capability: 'native-beneath-workspace-no-follow-v1' }> {
    this.assertActivation();
    return { capability: 'native-beneath-workspace-no-follow-v1' };
  }

  /** Run only before trusting a worker's output, persist the returned exact
   * binding externally, then inject it into a later reader instance. */
  async readBootstrap(input: { handle: SandboxHandle; signal: AbortSignal }): Promise<FrozenVercelNativeWorkspaceBinding> {
    this.assertActivation();
    const session = await this.observeExactSession(input.handle, input.signal);
    const stdout = await this.executeCollector(session, input.handle, { kind: 'BOOTSTRAP' }, input.signal, MAXIMUM_HEADER_BYTES);
    const workspaceIdentity = decodeNativeCollectorBootstrapFrame(stdout);
    return Object.freeze({
      format: VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT,
      handle: structuredClone(input.handle),
      workspaceIdentity,
      runtimeDigest: this.runtime.runtimeDigest,
    });
  }

  async capture(input: Parameters<SafeArtifactReader['capture']>[0]): Promise<SafeArtifactSnapshot | null> {
    this.assertActivation();
    validateArtifactRelativePath(input.relativePath);
    validateLimits(input.maximumBytes, input.maximumChunkBytes);
    const binding = this.bindingFor(input.handle);
    const session = await this.observeExactSession(input.handle, input.signal);
    // Re-read the protected record only to compare it with the durable first
    // binding. It is never silently adopted as a replacement.
    if (!this.options.collectorExecutor) {
      const currentIdentity = decodeNativeCollectorBootstrapFrame(
        await this.executeCollector(session, input.handle, { kind: 'BOOTSTRAP' }, input.signal, MAXIMUM_HEADER_BYTES),
      );
      if (currentIdentity !== binding.workspaceIdentity) failure('VERCEL_NATIVE_WORKSPACE_IDENTITY_CHANGED');
    }
    const limit = maximumAsciiFrameBytes(input.maximumBytes);
    let stdout: string;
    try {
      stdout = await this.executeCollector(
        session, input.handle,
        { kind: 'CAPTURE', relativePath: input.relativePath, maximumBytes: input.maximumBytes, workspaceIdentity: binding.workspaceIdentity },
        input.signal,
        limit,
      );
    } catch (error) {
      if (error instanceof ArtifactStorageError && error.code === 'VERCEL_NATIVE_COMMAND_EXIT_3') return null;
      throw error;
    }
    return decodeNativeArtifactAsciiFrame(stdout, input.relativePath, input.maximumBytes, input.maximumChunkBytes);
  }

  private async executeCollector(
    session: VercelNativeArtifactSession, handle: SandboxHandle, intent: VercelNativeCollectorIntent,
    signal: AbortSignal, maximumStdoutBytes: number,
  ): Promise<string> {
    const args = intent.kind === 'BOOTSTRAP' ? ['--bootstrap']
      : ['--capture-ascii', intent.relativePath, String(intent.maximumBytes), intent.workspaceIdentity];
    const run = (onStarted: (commandId: string) => Promise<void>) =>
      this.runCollector(session, args, signal, maximumStdoutBytes, onStarted);
    const result = this.options.collectorExecutor
      ? await this.options.collectorExecutor.execute({ handle: structuredClone(handle),
        runtimeDigest: this.runtime.runtimeDigest, intent: structuredClone(intent), signal, run })
      : await run(async () => undefined);
    if (result.exitCode === 3) failure('VERCEL_NATIVE_COMMAND_EXIT_3');
    if (result.exitCode !== 0) failure('VERCEL_NATIVE_COMMAND_FAILED');
    if (result.stderrBytes !== 0) failure('VERCEL_NATIVE_STDERR_PRESENT');
    return result.stdout;
  }

  private assertActivation(): void {
    if (this.activation !== 'local-test') failure('VERCEL_NATIVE_TRANSPORT_SUSPENDED');
  }

  private bindingFor(handle: SandboxHandle): FrozenVercelNativeWorkspaceBinding {
    assertHandle(handle, this.profile.profileDigest);
    const binding = this.bindings.find(item => sameHandle(item.handle, handle));
    if (!binding) failure('VERCEL_NATIVE_BOOTSTRAP_UNBOUND');
    return binding;
  }

  private async observeExactSession(handle: SandboxHandle, signal: AbortSignal): Promise<VercelNativeArtifactSession> {
    assertHandle(handle, this.profile.profileDigest);
    const observationDeadline = deadline(signal, this.commandTimeoutMs + 2_000);
    let session: VercelNativeArtifactSession;
    try {
      session = await raceWithAbort(
        () => this.options.transport.getExactSession({
          name: handle.sandboxId,
          resume: false,
          signal: observationDeadline.signal,
        }),
        observationDeadline.signal,
        'VERCEL_NATIVE_SESSION_DEADLINE',
      );
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      failure('VERCEL_NATIVE_SESSION_OBSERVATION_FAILED');
    } finally { observationDeadline.abort(); observationDeadline.dispose(); }
    if (session.sandboxId !== handle.sandboxId || session.sessionId !== handle.sessionId ||
        session.persistent !== false || session.status !== 'running') {
      failure('VERCEL_NATIVE_SESSION_MISMATCH');
    }
    if (this.runtime.source.kind === 'snapshot') {
      if (session.sourceSnapshotId !== this.runtime.source.snapshotId || session.image !== undefined) {
        failure('VERCEL_NATIVE_SOURCE_MISMATCH');
      }
    } else if (session.image !== this.runtime.source.image || session.sourceSnapshotId !== undefined) {
      failure('VERCEL_NATIVE_SOURCE_MISMATCH');
    }
    return session;
  }

  private async runCollector(
    session: VercelNativeArtifactSession,
    args: readonly string[],
    callerSignal: AbortSignal,
    maximumStdoutBytes: number,
    onStarted: (commandId: string) => Promise<void>,
  ): Promise<VercelNativeCollectorResult> {
    const operation = abortScope(callerSignal);
    const commandDeadline = deadline(operation.signal, this.commandTimeoutMs + 2_000);
    const logDeadline = deadline(operation.signal, this.logTimeoutMs);
    try {
      let command: VercelNativeCommand;
      try {
        command = await raceWithAbort(
          () => session.runCommand({
            cmd: VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH,
            args,
            cwd: '/',
            env: {},
            sudo: true,
            detached: true,
            timeoutMs: this.commandTimeoutMs,
            signal: commandDeadline.signal,
          }),
          commandDeadline.signal,
          'VERCEL_NATIVE_COMMAND_DEADLINE',
        );
      } catch (error) {
        if (error instanceof ArtifactStorageError) throw error;
        failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
      }
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(command.commandId)) failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
      // A failed commit prevents any wait/log access. Its caller retains the
      // claimed effect as unknown rather than issuing a replacement command.
      await raceWithAbort(() => onStarted(command.commandId), commandDeadline.signal, 'VERCEL_NATIVE_COMMAND_DEADLINE');
      const logs = collectLogs(lazyCommandLogs(command, logDeadline.signal), maximumStdoutBytes, logDeadline.signal);
      const finished = raceWithAbort(
        () => command.wait({ signal: commandDeadline.signal }),
        commandDeadline.signal,
        'VERCEL_NATIVE_COMMAND_DEADLINE',
      );
      let output: { stdout: string; stderrBytes: number };
      let result: { exitCode: number | null };
      try { [output, result] = await Promise.all([logs, finished]); }
      catch (error) {
        operation.abort(error);
        if (error instanceof ArtifactStorageError) throw error;
        failure('VERCEL_NATIVE_COMMAND_UNKNOWN');
      }
      return { ...output, exitCode: result.exitCode };
    } finally {
      operation.abort();
      commandDeadline.dispose();
      logDeadline.dispose();
      operation.dispose();
    }
  }
}

/** Strict byte-preserving decoding for the helper's direct ASCII log frame. */
export function decodeNativeArtifactAsciiFrame(
  frame: string,
  relativePath: string,
  maximumBytes: number,
  maximumChunkBytes: number,
): SafeArtifactSnapshot {
  validateArtifactRelativePath(relativePath);
  validateLimits(maximumBytes, maximumChunkBytes);
  if (typeof frame !== 'string' || !isAsciiLogText(frame) || Buffer.byteLength(frame, 'ascii') > maximumAsciiFrameBytes(maximumBytes)) {
    failure('VERCEL_NATIVE_FRAME_INVALID');
  }
  const first = frame.indexOf('\n');
  const second = first < 0 ? -1 : frame.indexOf('\n', first + 1);
  if (frame.slice(0, first) !== 'MOTIVE_ARTIFACT_ASCII_V1' || second < 0 || !frame.endsWith('\n') ||
      frame.indexOf('\n', second + 1) !== frame.length - 1) failure('VERCEL_NATIVE_FRAME_INVALID');
  const fields = frame.slice(first + 1, second).split(':');
  if (fields.length !== 4 || fields.some(field => !DECIMAL.test(field))) failure('VERCEL_NATIVE_FRAME_INVALID');
  const [device, inode, declared, encodedLength] = fields.map(field => Number(field));
  if (![device, inode, declared, encodedLength].every(Number.isSafeInteger) || declared > maximumBytes) {
    failure('VERCEL_NATIVE_FRAME_SIZE');
  }
  const encoded = frame.slice(second + 1, -1);
  const expectedLength = 4 * Math.ceil(declared / 3);
  if (encodedLength !== expectedLength || encoded.length !== expectedLength || !validBase64(encoded)) {
    failure('VERCEL_NATIVE_FRAME_INVALID');
  }
  const content = Buffer.from(encoded, 'base64');
  if (content.byteLength !== declared || content.toString('base64') !== encoded) failure('VERCEL_NATIVE_FRAME_SIZE');
  return snapshot(relativePath, device, inode, content, maximumChunkBytes);
}

/** Reads only the root-protected bootstrap record through the fixed helper. */
export function decodeNativeCollectorBootstrapFrame(frame: string): string {
  if (typeof frame !== 'string' || !isAsciiLogText(frame) || frame.length > MAXIMUM_HEADER_BYTES ||
      !frame.startsWith('MOTIVE_COLLECTOR_BOOTSTRAP_V1\n') || !frame.endsWith('\n')) {
    failure('VERCEL_NATIVE_BOOTSTRAP_INVALID');
  }
  const identity = frame.slice('MOTIVE_COLLECTOR_BOOTSTRAP_V1\n'.length, -1);
  if (!WORKSPACE_IDENTITY.test(identity) || identity.includes('\n')) failure('VERCEL_NATIVE_BOOTSTRAP_INVALID');
  return identity;
}

function normalizeRuntime(input: ReviewedVercelNativeArtifactRuntimeInput | ReviewedVercelNativeArtifactRuntime): ReviewedVercelNativeArtifactRuntimeInput {
  if (!input || typeof input !== 'object' || input.format !== VERCEL_NATIVE_ARTIFACT_RUNTIME_FORMAT ||
      input.collectorPath !== VERCEL_ARTIFACT_COLLECTOR_PATH || input.collectorLauncherPath !== VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH ||
      input.bootstrapPath !== VERCEL_WORKER_BOOTSTRAP_PATH || input.collectorUid !== VERCEL_ARTIFACT_COLLECTOR_UID ||
      input.workerUid !== VERCEL_ARTIFACT_WORKER_UID) failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
  try {
    const profileDigest = assertDigest(input.profileDigest, 'profile digest');
    const workerRuntimeDigest = assertDigest(input.workerRuntimeDigest, 'worker runtime digest');
    const workerLauncherDigest = assertDigest(input.workerLauncherDigest, 'worker launcher digest');
    const collectorDigest = assertDigest(input.collectorDigest, 'collector digest');
    const collectorLauncherDigest = assertDigest(input.collectorLauncherDigest, 'collector launcher digest');
    const source = structuredClone(input.source);
    if (!source || typeof source !== 'object' || !('kind' in source) ||
        (source.kind !== 'snapshot' && source.kind !== 'image') ||
        assertDigest(source.materialDigest, 'source material digest') !== source.materialDigest ||
        assertDigest(source.buildRecipeDigest, 'source build digest') !== source.buildRecipeDigest) {
      failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
    }
    validateTrustedSourceIdentity(source);
    if (source.kind === 'snapshot') {
      if (typeof source.snapshotId !== 'string' || source.snapshotId.length === 0 || 'image' in source) failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
    } else if (typeof source.image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(source.image) || 'snapshotId' in source) {
      failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
    }
    return {
      format: VERCEL_NATIVE_ARTIFACT_RUNTIME_FORMAT,
      profileDigest,
      source,
      workerRuntimeDigest,
      workerLauncherDigest,
      collectorPath: VERCEL_ARTIFACT_COLLECTOR_PATH,
      collectorDigest,
      collectorLauncherPath: VERCEL_ARTIFACT_COLLECTOR_LAUNCHER_PATH,
      collectorLauncherDigest,
      bootstrapPath: VERCEL_WORKER_BOOTSTRAP_PATH,
      collectorUid: VERCEL_ARTIFACT_COLLECTOR_UID,
      workerUid: VERCEL_ARTIFACT_WORKER_UID,
    };
  } catch (error) {
    if (error instanceof ArtifactStorageError) throw error;
    failure('VERCEL_NATIVE_RUNTIME_REGISTRY_INVALID');
  }
}

function verifySelectedRuntime(
  profile: SandboxExecutionProfile,
  runtime: ReviewedVercelNativeArtifactRuntime,
): ReviewedVercelNativeArtifactRuntime {
  const normalized = normalizeRuntime(runtime);
  if (runtime.runtimeDigest !== digestCanonicalJson(normalized) || normalized.profileDigest !== profile.profileDigest) {
    failure('VERCEL_NATIVE_RUNTIME_UNREVIEWED');
  }
  let protectedRuntime;
  try { protectedRuntime = requireProtectedRuntime(profile); }
  catch { failure('VERCEL_NATIVE_RUNTIME_UNREVIEWED'); }
  if (normalized.workerRuntimeDigest !== protectedRuntime.runtimeDigest ||
      normalized.workerLauncherDigest !== protectedRuntime.launcherDigest ||
      canonicalJson(normalized.source) !== canonicalJson(profile.trustedSource)) {
    failure('VERCEL_NATIVE_RUNTIME_UNREVIEWED');
  }
  return Object.freeze({ ...normalized, runtimeDigest: runtime.runtimeDigest });
}

function validateBindings(
  bindings: readonly FrozenVercelNativeWorkspaceBinding[],
  runtime: ReviewedVercelNativeArtifactRuntime,
  profile: SandboxExecutionProfile,
): readonly FrozenVercelNativeWorkspaceBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 1_000) failure('VERCEL_NATIVE_BINDING_INVALID');
  const seen = new Set<string>();
  return bindings.map(binding => {
    if (!binding || typeof binding !== 'object' || binding.format !== VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT ||
        binding.runtimeDigest !== runtime.runtimeDigest || !WORKSPACE_IDENTITY.test(binding.workspaceIdentity)) {
      failure('VERCEL_NATIVE_BINDING_INVALID');
    }
    assertHandle(binding.handle, profile.profileDigest);
    const key = canonicalJson(binding.handle);
    if (seen.has(key)) failure('VERCEL_NATIVE_BINDING_INVALID');
    seen.add(key);
    return Object.freeze({
      format: VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT,
      handle: structuredClone(binding.handle),
      workspaceIdentity: binding.workspaceIdentity,
      runtimeDigest: binding.runtimeDigest,
    });
  });
}

function assertHandle(handle: SandboxHandle, profileDigest: Digest): void {
  try {
    if (!handle || handle.provider !== 'vercel' || handle.profileDigest !== profileDigest ||
        !Number.isSafeInteger(handle.leaseEpoch) || handle.leaseEpoch < 1 ||
        handle.sandboxId !== sandboxName(handle.attemptId, handle.leaseEpoch) ||
        typeof handle.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(handle.sessionId)) {
      failure('VERCEL_NATIVE_HANDLE_INVALID');
    }
  } catch (error) {
    if (error instanceof ArtifactStorageError) throw error;
    failure('VERCEL_NATIVE_HANDLE_INVALID');
  }
}

function sameHandle(left: SandboxHandle, right: SandboxHandle): boolean {
  return left.provider === right.provider && left.attemptId === right.attemptId && left.leaseEpoch === right.leaseEpoch &&
    left.sandboxId === right.sandboxId && left.sessionId === right.sessionId && left.profileDigest === right.profileDigest;
}

function cloneProfile(profile: SandboxExecutionProfile): SandboxExecutionProfile {
  return structuredClone(profile);
}

function validateLimits(maximumBytes: number, maximumChunkBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAXIMUM_BYTES ||
      !Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1 || maximumChunkBytes > MAXIMUM_BYTES) {
    failure('VERCEL_NATIVE_LIMIT_INVALID');
  }
}

function finiteTimeout(value: number, code: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) failure(code);
  return value;
}

function maximumAsciiFrameBytes(rawBytes: number): number {
  return MAXIMUM_HEADER_BYTES + 1 + (4 * Math.ceil(rawBytes / 3));
}

/* Deliberately linear: a giant command-log frame must not exercise a repeated
 * regex group before its decoded size is bounded and checked. */
function validBase64(encoded: string): boolean {
  if (encoded.length === 0) return true;
  if (encoded.length % 4 !== 0) return false;
  let padding = 0;
  if (encoded.charCodeAt(encoded.length - 1) === 61) {
    padding = 1;
    if (encoded.charCodeAt(encoded.length - 2) === 61) padding = 2;
  }
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded.charCodeAt(index);
    const alphabet = (character >= 65 && character <= 90) || (character >= 97 && character <= 122) ||
      (character >= 48 && character <= 57) || character === 43 || character === 47;
    if (index >= encoded.length - padding) {
      if (character !== 61) return false;
    } else if (!alphabet) return false;
  }
  return true;
}

function isAsciiLogText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 10 && (code < 32 || code > 126)) return false;
  }
  return true;
}

function snapshot(relativePath: string, device: number, inode: number, content: Buffer, maximumChunkBytes: number): SafeArtifactSnapshot {
  const privateContent = Buffer.from(content);
  const digest: Digest = `sha256:${createHash('sha256').update(privateContent).digest('hex')}`;
  return Object.freeze({
    relativePath,
    kind: 'regular' as const,
    linkCount: 1,
    declaredBytes: privateContent.byteLength,
    identityToken: `${device}:${inode}:${digest}`,
    resolution: 'beneath-workspace-no-follow' as const,
    immutableSnapshot: true as const,
    async *read() {
      for (let offset = 0; offset < privateContent.byteLength; offset += maximumChunkBytes) {
        yield Buffer.from(privateContent.subarray(offset, offset + maximumChunkBytes));
      }
    },
  });
}

async function collectLogs(
  logs: AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>,
  maximumStdoutBytes: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderrBytes: number }> {
  let stdout = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let iterator: AsyncIterator<{ stream: 'stdout' | 'stderr'; data: string }> | undefined;
  try {
    const activeIterator = logs[Symbol.asyncIterator]();
    iterator = activeIterator;
    while (true) {
      const next = await raceWithAbort(() => activeIterator.next(), signal, 'VERCEL_NATIVE_LOG_DEADLINE');
      if (next.done) break;
      const entry = next.value;
      if (!entry || (entry.stream !== 'stdout' && entry.stream !== 'stderr') || typeof entry.data !== 'string') {
        failure('VERCEL_NATIVE_LOG_INVALID');
      }
      const bytes = Buffer.byteLength(entry.data, 'utf8');
      if (entry.stream === 'stdout') {
        if (!isAsciiLogText(entry.data) || bytes !== entry.data.length || stdoutBytes + bytes > maximumStdoutBytes) {
          failure('VERCEL_NATIVE_STDOUT_INVALID');
        }
        stdout += entry.data;
        stdoutBytes += bytes;
      } else {
        stderrBytes += bytes;
        if (!Number.isSafeInteger(stderrBytes) || stderrBytes > MAXIMUM_DIAGNOSTIC_BYTES) failure('VERCEL_NATIVE_STDERR_LIMIT');
      }
    }
  } catch (error) {
    if (error instanceof ArtifactStorageError) throw error;
    if (signal.aborted) failure('VERCEL_NATIVE_LOG_DEADLINE');
    failure('VERCEL_NATIVE_LOG_UNAVAILABLE');
  } finally {
    // A provider iterator may ignore cancellation forever. Trigger its cleanup
    // but never wait for that non-authoritative promise to settle.
    try { void iterator?.return?.().catch(() => undefined); }
    catch { /* Cleanup cannot replace the original bounded failure. */ }
  }
  return { stdout, stderrBytes };
}

/** Defers a provider's potentially synchronous `logs` implementation until it
 * is inside the same cancellable path as iterator reads. */
function lazyCommandLogs(command: VercelNativeCommand, signal: AbortSignal): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) failure('VERCEL_NATIVE_LOG_DEADLINE');
      const logs = command.logs({ signal });
      for await (const entry of logs) yield entry;
    },
  };
}

function abortScope(parent: AbortSignal): { signal: AbortSignal; abort(reason?: unknown): void; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    abort(reason?: unknown) { if (!controller.signal.aborted) controller.abort(reason); },
    dispose() {
      parent.removeEventListener('abort', abort);
    },
  };
}

function deadline(parent: AbortSignal, milliseconds: number): { signal: AbortSignal; abort(reason?: unknown): void; dispose(): void } {
  const scope = abortScope(parent);
  const timer = setTimeout(() => scope.abort(new Error('deadline exceeded')), milliseconds);
  return {
    signal: scope.signal,
    abort: scope.abort,
    dispose() {
      clearTimeout(timer);
      scope.dispose();
    },
  };
}

function raceWithAbort<T>(start: () => PromiseLike<T>, signal: AbortSignal, abortCode: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      callback();
    };
    const aborted = () => finish(() => reject(new ArtifactStorageError(abortCode, 'Vercel native artifact collection timed out or was cancelled.')));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    let work: PromiseLike<T>;
    try { work = start(); }
    catch (error) { finish(() => reject(error)); return; }
    Promise.resolve(work).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

function failure(code: string): never {
  throw new ArtifactStorageError(code, 'Vercel native artifact collection failed.');
}
