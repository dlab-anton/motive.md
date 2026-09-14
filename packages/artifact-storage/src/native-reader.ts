import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { assertDigest, canonicalJson, type Digest } from '../../domain/src/contracts.ts';
import type { SandboxHandle } from '../../sandbox-vercel/src/types.ts';
import { ArtifactStorageError, validateArtifactRelativePath } from './sealer.ts';
import type { SafeArtifactReader, SafeArtifactSnapshot } from './types.ts';

const MAXIMUM_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 192;
const READY = Buffer.from('MOTIVE_COLLECTOR_V1_READY\n');
const sha256 = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function failure(code: string): never { throw new ArtifactStorageError(code, 'Native artifact collection failed.'); }

/** This parser is not authentication. Only call it on the protected collector's
 * captured output after an observed successful exit, never on worker stdout. */
export function decodeNativeArtifactFrame(
  frame: Uint8Array, relativePath: string, maximumBytes: number, maximumChunkBytes: number,
): SafeArtifactSnapshot {
  validateArtifactRelativePath(relativePath);
  validateLimits(maximumBytes, maximumChunkBytes);
  if (frame.byteLength > maximumBytes + MAX_HEADER_BYTES) failure('NATIVE_OUTPUT_LIMIT');
  const bytes = Buffer.from(frame); // Own bytes: mutations of transport buffers must not affect later reads.
  const newline = bytes.indexOf(10, 19);
  if (newline < 0 || newline >= MAX_HEADER_BYTES) failure('NATIVE_FRAME_INVALID');
  const match = /^MOTIVE_ARTIFACT_V1\n(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,8})\n$/.exec(bytes.subarray(0, newline + 1).toString('latin1'));
  if (!match) failure('NATIVE_FRAME_INVALID');
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size) || size > maximumBytes || bytes.length - newline - 1 !== size) failure('NATIVE_FRAME_SIZE');
  const content = Buffer.from(bytes.subarray(newline + 1));
  return Object.freeze({
    relativePath, kind: 'regular' as const, linkCount: 1, declaredBytes: size,
    identityToken: `${match[1]}:${match[2]}:${sha256(content)}`,
    resolution: 'beneath-workspace-no-follow' as const, immutableSnapshot: true as const,
    async *read() {
      for (let offset = 0; offset < content.length; offset += maximumChunkBytes) {
        // Callers cannot mutate the private snapshot by modifying a yielded chunk.
        yield Buffer.from(content.subarray(offset, offset + maximumChunkBytes));
      }
    },
  });
}

function validateLimits(maximumBytes: number, maximumChunkBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAXIMUM_BYTES ||
      !Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1 || maximumChunkBytes > MAXIMUM_BYTES) {
    failure('NATIVE_LIMIT_INVALID');
  }
}

export type NativeWorkspaceBinding = {
  /** Set only by trusted bootstrap after it establishes the exact session's filesystem. */
  handle: SandboxHandle;
  workspaceRoot: string;
  /** dev:ino:statx mount ID captured by trusted bootstrap in this mount namespace. */
  workspaceIdentity: string;
  /** Worker identity in THIS host's user namespace; cannot equal the service UID. */
  workerUid: number;
};

/** Concrete local service reader for a trusted Linux collector host. This is NOT
 * a Vercel SDK transport. A remote worker's filesystem must first be securely
 * presented under a protected parent, with a distinct unprivileged worker UID.
 * No automatic fallback to SDK readFile, worker commands, or arbitrary paths. */
export class LocalNativeArtifactReader implements SafeArtifactReader {
  private readonly bindings: readonly NativeWorkspaceBinding[];
  constructor(private readonly options: {
    helperPath: string;
    helperDigest: Digest;
    bindings: readonly NativeWorkspaceBinding[];
  }) {
    assertDigest(options.helperDigest, 'native helper digest');
    this.options = structuredClone(options);
    this.bindings = structuredClone(options.bindings);
    if (!posix.isAbsolute(options.helperPath) || posix.normalize(options.helperPath) !== options.helperPath) failure('NATIVE_HELPER_INVALID');
    const seen = new Set<string>();
    for (const binding of this.bindings) {
      const key = canonicalJson(binding.handle);
      if (seen.has(key) || !/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.test(binding.workspaceIdentity) || !Number.isSafeInteger(binding.workerUid) || binding.workerUid <= 0 ||
          !posix.isAbsolute(binding.workspaceRoot) || posix.normalize(binding.workspaceRoot) !== binding.workspaceRoot ||
          binding.workspaceRoot === '/') failure('NATIVE_BINDING_INVALID');
      seen.add(key);
    }
  }

  async assertReady({ signal }: { signal: AbortSignal }): Promise<{ capability: 'native-beneath-workspace-no-follow-v1' }> {
    await this.verifyHelper(signal);
    const result = await this.execute(['--probe'], READY.length, signal);
    if (result.code !== 0 || !result.bytes.equals(READY)) failure('NATIVE_PROBE_FAILED');
    return { capability: 'native-beneath-workspace-no-follow-v1' };
  }

  async capture(input: Parameters<SafeArtifactReader['capture']>[0]): Promise<SafeArtifactSnapshot | null> {
    signalCheck(input.signal);
    validateArtifactRelativePath(input.relativePath);
    validateLimits(input.maximumBytes, input.maximumChunkBytes);
    const binding = this.bindings.find(item => canonicalJson(item.handle) === canonicalJson(input.handle));
    if (!binding) failure('NATIVE_SESSION_UNBOUND');
    await this.verifyHelper(input.signal);
    if (binding.workerUid === process.getuid!()) failure('NATIVE_WORKER_IDENTITY_INVALID');
    await protectedPath(posix.dirname(binding.workspaceRoot), true);
    const workspace = await lstat(binding.workspaceRoot);
    if (!workspace.isDirectory() || workspace.isSymbolicLink() || workspace.uid !== binding.workerUid ||
        (workspace.mode & 0o022) !== 0) failure('NATIVE_WORKSPACE_INVALID');
    const result = await this.execute([binding.workspaceRoot, input.relativePath, String(input.maximumBytes), binding.workspaceIdentity], input.maximumBytes + MAX_HEADER_BYTES, input.signal);
    if (result.code === 3 && result.bytes.length === 0) return null;
    if (result.code !== 0) failure('NATIVE_CAPTURE_REJECTED');
    return decodeNativeArtifactFrame(result.bytes, input.relativePath, input.maximumBytes, input.maximumChunkBytes);
  }

  private async verifyHelper(signal: AbortSignal): Promise<void> {
    signalCheck(signal);
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) failure('NATIVE_HOST_UNSUPPORTED');
    await protectedPath(this.options.helperPath, false);
    const stat = await lstat(this.options.helperPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o111) === 0 || (stat.mode & 0o6000) !== 0) failure('NATIVE_HELPER_INVALID');
    if (sha256(await readFile(this.options.helperPath, { signal })) !== this.options.helperDigest) failure('NATIVE_HELPER_DIGEST');
    signalCheck(signal);
  }

  private execute(args: string[], maximumOutput: number, signal: AbortSignal): Promise<{ code: number | null; bytes: Buffer }> {
    signalCheck(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.helperPath, args, {
        cwd: '/', env: {}, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let count = 0, diagnostics = 0, rejected: string | null = null;
      const stop = (code: string) => { rejected ??= code; child.kill('SIGKILL'); };
      const abort = () => stop('NATIVE_ABORTED');
      const timer = setTimeout(() => stop('NATIVE_DEADLINE'), 12_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.stdout.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > maximumOutput) stop('NATIVE_OUTPUT_LIMIT');
        else if (!rejected) chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics += chunk.length;
        if (diagnostics > 4096) stop('NATIVE_DIAGNOSTIC_LIMIT');
      });
      child.on('error', () => { cleanup(); reject(new ArtifactStorageError('NATIVE_EXEC_FAILED', 'Native collector could not execute.')); });
      child.on('close', code => {
        cleanup();
        if (rejected) reject(new ArtifactStorageError(rejected, 'Native collector did not complete.'));
        else resolve({ code, bytes: Buffer.concat(chunks) });
      });
    });
  }
}

function signalCheck(signal: AbortSignal): void { if (signal.aborted) failure('NATIVE_ABORTED'); }

async function protectedPath(path: string, directory: boolean): Promise<void> {
  // Every ancestor must be controlled by root or this trusted service. Reject
  // even sticky world-writable parents; a host /tmp binding is not accepted.
  let current = '/';
  for (const segment of ['', ...path.split('/').filter(Boolean)]) {
    if (segment) current = posix.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid!()) || (stat.mode & 0o022) !== 0 ||
        ((current !== path || directory) && !stat.isDirectory())) failure('NATIVE_PATH_UNPROTECTED');
  }
}
