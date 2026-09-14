import { canonicalJson, digestCanonicalJson } from '../../domain/src/contracts.ts';
import { SandboxAdapterError } from './errors.ts';
import { WORKSPACE_ROOT, type Digest, type SandboxExecutionProfile, type SdkCommandRequest, type StartCommandRequest } from './types.ts';

export const NATIVE_WORKER_POLICY = 'motive.native-worker/0.1' as const;
export const WORKER_LAUNCHER = '/opt/motive/bin/worker-launcher' as const;
export const PROTECTED_RUNTIME_FORMAT = 'motive.protected-worker-runtime/0.1' as const;

export type ProtectedWorkerRuntime = {
  format: typeof PROTECTED_RUNTIME_FORMAT;
  policy: typeof NATIVE_WORKER_POLICY;
  runtimeDigest: Digest;
  launcherPath: typeof WORKER_LAUNCHER;
  launcherDigest: Digest;
  workerUid: 2000;
  workerGid: 2000;
  workspaceRoot: typeof WORKSPACE_ROOT;
  homeRoot: '/var/lib/motive/worker';
  temporaryRoot: '/var/lib/motive/worker/tmp';
  codexHome: '/opt/motive/codex-config';
  codexSqliteHome: '/var/lib/motive/worker';
};

/** Defines byte-bound policy, not deployment approval or proof of image contents.
 * The trusted image registry must verify the actual helper and host beforehand. */
export function defineProtectedRuntime(launcherDigest: Digest): ProtectedWorkerRuntime {
  if (!/^sha256:[a-f0-9]{64}$/.test(launcherDigest)) invalid();
  const material = {
    format: PROTECTED_RUNTIME_FORMAT, policy: NATIVE_WORKER_POLICY,
    launcherPath: WORKER_LAUNCHER, launcherDigest, workerUid: 2000 as const, workerGid: 2000 as const,
    workspaceRoot: WORKSPACE_ROOT, homeRoot: '/var/lib/motive/worker' as const,
    temporaryRoot: '/var/lib/motive/worker/tmp' as const, codexHome: '/opt/motive/codex-config' as const,
    codexSqliteHome: '/var/lib/motive/worker' as const,
  } as const;
  return { ...material, runtimeDigest: digestCanonicalJson(material) };
}

function invalid(): never {
  throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', 'Worker execution requires an exact, digest-bound protected native runtime.');
}

export function validateProtectedRuntime(value: unknown): asserts value is ProtectedWorkerRuntime {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('launcherDigest' in value) || typeof value.launcherDigest !== 'string') invalid();
  const expected = defineProtectedRuntime(value.launcherDigest as Digest);
  try { if (canonicalJson(value) !== canonicalJson(expected)) invalid(); }
  catch { invalid(); }
}

/** Legacy profiles remain usable for observation/teardown, never new execution. */
export function requireProtectedRuntime(profile: SandboxExecutionProfile): ProtectedWorkerRuntime {
  if (profile.providerUntrustedDataRuntime !== undefined) invalid();
  validateProtectedRuntime(profile.protectedRuntime);
  return profile.protectedRuntime;
}

/** Invoked only after the caller has validated child executable/args/cwd and
 * durably claimed its command intent. Candidate code never starts as SDK sudo user. */
export function protectedCommand(
  profile: SandboxExecutionProfile, request: StartCommandRequest,
): SdkCommandRequest {
  const runtime = requireProtectedRuntime(profile);
  return {
    cmd: runtime.launcherPath,
    args: ['--cwd-relative', request.cwd ?? '.', '--', request.executable, ...request.args],
    // The provider must not traverse a worker-controlled cwd while privileged.
    cwd: '/', detached: true, sudo: true, timeoutMs: profile.commandTimeoutMs,
  };
}
