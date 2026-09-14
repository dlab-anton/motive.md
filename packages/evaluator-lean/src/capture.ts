import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { posix } from 'node:path';
import { canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { MAX_RAW_COMPARATOR_REPORT_BYTES, type TrustedComparatorReportCapture } from './contract.ts';
import { decodeComparatorFacts, MAX_COMPARATOR_FACTS_BYTES } from './facts.ts';
import {
  RUNTIME_BOUND_REPORT_FORMAT,
  validateRuntimeBoundComparatorReport,
  type RuntimeBoundComparatorReport,
} from './runtime-report.ts';
import {
  FIXED_PROTECTED_FACTS_PATH,
  validateTrustedEvaluatorReportBindings,
  type TrustedEvaluatorReportBindings,
} from './launch.ts';

const LOCAL_FACTS_RELATIVE_PATH = 'trusted-reports/report.json' as const;

export type TrustedEvaluatorCaptureErrorCode =
  | 'CAPTURE_ABORTED'
  | 'CAPTURE_PLATFORM_UNSUPPORTED'
  | 'CAPTURE_ROOT_INVALID'
  | 'CAPTURE_PATH_UNPROTECTED'
  | 'CAPTURE_FACTS_UNAVAILABLE'
  | 'CAPTURE_FACTS_INVALID'
  | 'CAPTURE_FACTS_UNSTABLE'
  | 'CAPTURE_BINDING_INVALID'
  | 'CAPTURE_REPORT_INVALID';

export class TrustedEvaluatorCaptureError extends Error {
  constructor(readonly code: TrustedEvaluatorCaptureErrorCode, message: string) {
    super(message);
    this.name = 'TrustedEvaluatorCaptureError';
  }
}

function fail(code: TrustedEvaluatorCaptureErrorCode, message: string): never {
  throw new TrustedEvaluatorCaptureError(code, message);
}

const digest = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Wraps bytes read from the native reporter's fixed facts0.1 file in the
 * exact report0.2 envelope expected by the existing evidence store.
 *
 * The observations are deliberately taken from `bindings`, not inferred from
 * facts, a process exit code, or candidate stdout. `bindings` defaults every
 * observation to false when its trusted controller did not provide one. This
 * helper validates representation and binding only; it does not prove that a
 * runtime preflight was actually observed.
 */
export function captureRuntimeBoundComparatorReport(input: {
  bindings: unknown;
  protectedFactsBytes: Uint8Array;
}): TrustedComparatorReportCapture {
  let bindings: TrustedEvaluatorReportBindings;
  try {
    bindings = validateTrustedEvaluatorReportBindings(input?.bindings);
  } catch {
    fail('CAPTURE_BINDING_INVALID', 'The frozen evaluator/profile/manifest bindings are invalid.');
  }
  if (!(input?.protectedFactsBytes instanceof Uint8Array)) {
    fail('CAPTURE_FACTS_INVALID', 'Protected reporter facts must be bytes.');
  }
  const facts = Uint8Array.from(input.protectedFactsBytes);
  if (facts.byteLength === 0 || facts.byteLength > MAX_COMPARATOR_FACTS_BYTES) {
    fail('CAPTURE_FACTS_INVALID', 'Protected reporter facts exceed the bounded size.');
  }
  try {
    // The reporter facts grammar excludes acceptance, generic success, stdout,
    // and exit-code fields before those bytes enter the report envelope.
    decodeComparatorFacts(facts);
  } catch {
    fail('CAPTURE_FACTS_INVALID', 'Protected reporter facts do not match facts0.1.');
  }
  const profile = bindings.evaluator_profile;
  const report: RuntimeBoundComparatorReport = {
    format: RUNTIME_BOUND_REPORT_FORMAT,
    evaluator_profile_digest: bindings.frozen_evaluator_profile_digest,
    challenge_digest: profile.challenge.challenge_digest,
    dependency_lock_digest: profile.challenge.dependency_lock_digest,
    trusted_build_config_digest: profile.challenge.trusted_build_config_digest,
    solution_artifact_manifest_digest: bindings.solution_artifact_manifest_digest,
    runtime_digest: digestCanonicalJson(profile.runtime),
    runtime_preflight: { ...bindings.declared_preflight.runtime_preflight },
    input_preflight: { ...bindings.declared_preflight.input_preflight },
    facts_capture: { bytes_base64: Buffer.from(facts).toString('base64'), digest: digest(facts) },
  };
  const bytes = Buffer.from(canonicalJson(report), 'utf8');
  if (!bytes.byteLength || bytes.byteLength > MAX_RAW_COMPARATOR_REPORT_BYTES) {
    fail('CAPTURE_REPORT_INVALID', 'The bounded report envelope is invalid.');
  }
  const capture: TrustedComparatorReportCapture = {
    bytes: Uint8Array.from(bytes),
    expected_raw_report_digest: digest(bytes),
  };
  try {
    validateRuntimeBoundComparatorReport({
      evaluator_profile: profile,
      frozen_evaluator_profile_digest: bindings.frozen_evaluator_profile_digest,
      solution_artifact_manifest_digest: bindings.solution_artifact_manifest_digest,
      captured_report: capture,
    });
  } catch {
    fail('CAPTURE_REPORT_INVALID', 'The constructed report does not satisfy the runtime-bound contract.');
  }
  return capture;
}

/** A narrow file-stat surface so local rehearsal tests can exercise the same
 * protection checks without pretending that the Windows development host is a
 * supported Linux capture host. */
export type ProtectedFactsStat = {
  mode: number;
  uid: number;
  size: number;
  nlink: number;
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type ProtectedFactsFileSystem = {
  lstat(path: string, signal: AbortSignal): Promise<ProtectedFactsStat>;
  /** Open without following a final symlink and return a private byte copy. */
  readNoFollow(path: string, maximumBytes: number, signal: AbortSignal): Promise<{
    bytes: Uint8Array;
    stat: ProtectedFactsStat;
  }>;
};

export type ProtectedFactsHost = { platform: NodeJS.Platform; uid: number | null };

export interface TrustedComparatorFactsCapture {
  /** Capturing is a repeatable read only. It must never start a provider command. */
  capture(input: { bindings: unknown; signal: AbortSignal }): Promise<TrustedComparatorReportCapture>;
}

export type PrivateComparatorFactsCaptureOptions = {
  trustedRoot: string;
  /** UID used by untrusted candidate code in this filesystem namespace. */
  candidateUid: number;
  filesystem: ProtectedFactsFileSystem;
  host: ProtectedFactsHost;
};

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) fail('CAPTURE_ABORTED', 'Protected facts capture was cancelled.');
}

function statFields(stat: ProtectedFactsStat): boolean {
  return Number.isSafeInteger(stat.mode) && Number.isSafeInteger(stat.uid) && Number.isSafeInteger(stat.size)
    && Number.isSafeInteger(stat.nlink) && Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino)
    && stat.uid >= 0 && stat.size >= 0 && stat.nlink >= 1 && stat.dev >= 0 && stat.ino >= 0;
}

function sameFile(left: ProtectedFactsStat, right: ProtectedFactsStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
    && left.size === right.size && left.nlink === right.nlink;
}

function sameTree(left: ReadonlyMap<string, ProtectedFactsStat>, right: ReadonlyMap<string, ProtectedFactsStat>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, stat] of left) {
    const candidate = right.get(path);
    if (!candidate || !sameFile(stat, candidate)) return false;
  }
  return true;
}

function chain(path: string): string[] {
  const result = ['/'];
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current = `${current}/${segment}`;
    result.push(current);
  }
  return result;
}

/**
 * A local, POSIX-mode capture boundary. It validates an absolute private root,
 * every ancestor, and the fixed reporter facts path, then obtains two stable
 * no-follow reads before constructing a report0.2 capture. It is intentionally
 * unsuitable for arbitrary Windows paths or a candidate-owned workspace.
 *
 * The owner/mode checks are only meaningful when the caller supplies the real
 * candidate UID and a controlled Linux filesystem namespace. This class does
 * not make an unobserved runtime-preflight claim.
 */
export class PrivateComparatorFactsCapture implements TrustedComparatorFactsCapture {
  private readonly root: string;
  private readonly factsPath: string;
  private readonly serviceUid: number;

  constructor(private readonly options: PrivateComparatorFactsCaptureOptions) {
    if (options.host.platform !== 'linux' || options.host.uid === null || !Number.isSafeInteger(options.host.uid) || options.host.uid < 0) {
      fail('CAPTURE_PLATFORM_UNSUPPORTED', 'Protected local facts capture requires a Linux process with a known UID.');
    }
    if (!Number.isSafeInteger(options.candidateUid) || options.candidateUid <= 0 || options.candidateUid === options.host.uid) {
      fail('CAPTURE_ROOT_INVALID', 'Candidate and capture identities must be distinct non-root/trusted identities.');
    }
    if (typeof options.trustedRoot !== 'string' || options.trustedRoot.length < 2 || options.trustedRoot.length > 1024
      || !posix.isAbsolute(options.trustedRoot) || posix.normalize(options.trustedRoot) !== options.trustedRoot
      || options.trustedRoot === '/' || options.trustedRoot.includes('\0')) {
      fail('CAPTURE_ROOT_INVALID', 'Trusted facts root must be a normalized non-root absolute POSIX path.');
    }
    this.root = options.trustedRoot;
    this.factsPath = posix.join(this.root, LOCAL_FACTS_RELATIVE_PATH);
    this.serviceUid = options.host.uid;
  }

  async capture(input: { bindings: unknown; signal: AbortSignal }): Promise<TrustedComparatorReportCapture> {
    if (!input || typeof input !== 'object' || !(input.signal instanceof AbortSignal)) {
      fail('CAPTURE_BINDING_INVALID', 'Protected facts capture input is invalid.');
    }
    assertSignal(input.signal);
    let bindings: TrustedEvaluatorReportBindings;
    try {
      bindings = validateTrustedEvaluatorReportBindings(input.bindings);
    } catch {
      fail('CAPTURE_BINDING_INVALID', 'The frozen evaluator/profile/manifest bindings are invalid.');
    }
    const first = await this.readStableFacts(input.signal);
    assertSignal(input.signal);
    const second = await this.readStableFacts(input.signal);
    assertSignal(input.signal);
    if (!sameFile(first.stat, second.stat) || !Buffer.from(first.bytes).equals(Buffer.from(second.bytes))) {
      fail('CAPTURE_FACTS_UNSTABLE', 'Protected facts changed between repeat reads.');
    }
    return captureRuntimeBoundComparatorReport({ bindings, protectedFactsBytes: first.bytes });
  }

  private async readStableFacts(signal: AbortSignal): Promise<{ bytes: Uint8Array; stat: ProtectedFactsStat }> {
    const treeBefore = await this.assertPrivateTree(signal);
    const before = await this.safeLstat(this.factsPath, signal);
    this.assertFactsFile(before);
    let opened: { bytes: Uint8Array; stat: ProtectedFactsStat };
    try {
      opened = await this.options.filesystem.readNoFollow(this.factsPath, MAX_COMPARATOR_FACTS_BYTES, signal);
    } catch (error) {
      if (error instanceof TrustedEvaluatorCaptureError) throw error;
      fail('CAPTURE_FACTS_UNAVAILABLE', 'Protected facts could not be opened without following links.');
    }
    assertSignal(signal);
    this.assertFactsFile(opened.stat);
    if (!sameFile(before, opened.stat) || opened.bytes.byteLength !== before.size) {
      fail('CAPTURE_FACTS_UNSTABLE', 'Protected facts changed while they were read.');
    }
    const after = await this.safeLstat(this.factsPath, signal);
    this.assertFactsFile(after);
    if (!sameFile(before, after)) fail('CAPTURE_FACTS_UNSTABLE', 'Protected facts changed after the read.');
    const treeAfter = await this.assertPrivateTree(signal);
    if (!sameTree(treeBefore, treeAfter)) {
      fail('CAPTURE_FACTS_UNSTABLE', 'A protected facts ancestor changed during the read.');
    }
    return { bytes: Uint8Array.from(opened.bytes), stat: after };
  }

  private async assertPrivateTree(signal: AbortSignal): Promise<ReadonlyMap<string, ProtectedFactsStat>> {
    const directories = [...chain(this.root), posix.dirname(this.factsPath)];
    const result = new Map<string, ProtectedFactsStat>();
    for (const directory of new Set(directories)) {
      const stat = await this.safeLstat(directory, signal);
      if (!statFields(stat) || !stat.isDirectory() || stat.isSymbolicLink() || !this.trustedOwner(stat.uid)
        || (stat.mode & 0o022) !== 0) {
        fail('CAPTURE_PATH_UNPROTECTED', 'A protected facts ancestor is not private and no-follow safe.');
      }
      result.set(directory, stat);
    }
    return result;
  }

  private assertFactsFile(stat: ProtectedFactsStat): void {
    if (!statFields(stat) || !stat.isFile() || stat.isSymbolicLink() || !this.trustedOwner(stat.uid)
      || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_COMPARATOR_FACTS_BYTES || (stat.mode & 0o222) !== 0) {
      fail('CAPTURE_FACTS_INVALID', 'Protected facts must be a private immutable regular file.');
    }
  }

  private trustedOwner(uid: number): boolean {
    return uid !== this.options.candidateUid && (uid === 0 || uid === this.serviceUid);
  }

  private async safeLstat(path: string, signal: AbortSignal): Promise<ProtectedFactsStat> {
    assertSignal(signal);
    try {
      const stat = await this.options.filesystem.lstat(path, signal);
      assertSignal(signal);
      return stat;
    } catch (error) {
      if (error instanceof TrustedEvaluatorCaptureError) throw error;
      fail('CAPTURE_FACTS_UNAVAILABLE', 'Protected facts path is unavailable.');
    }
  }
}

class NodeProtectedFactsFileSystem implements ProtectedFactsFileSystem {
  async lstat(path: string, signal: AbortSignal): Promise<ProtectedFactsStat> {
    assertSignal(signal);
    const stat = await lstat(path);
    assertSignal(signal);
    return stat;
  }

  async readNoFollow(path: string, maximumBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; stat: ProtectedFactsStat }> {
    assertSignal(signal);
    if (!Number.isInteger(constants.O_NOFOLLOW)) {
      fail('CAPTURE_PLATFORM_UNSUPPORTED', 'The local filesystem does not expose O_NOFOLLOW.');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assertSignal(signal);
      if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) {
        fail('CAPTURE_FACTS_INVALID', 'Protected facts size is outside the bounded range.');
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        assertSignal(signal);
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) fail('CAPTURE_FACTS_UNSTABLE', 'Protected facts shortened during read.');
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        fail('CAPTURE_FACTS_UNSTABLE', 'Protected facts grew during read.');
      }
      assertSignal(signal);
      return { bytes: Uint8Array.from(bytes), stat: await handle.stat() };
    } finally {
      await handle.close();
    }
  }
}

/** Returns the concrete Node/Linux no-follow reader used by the local capture
 * adapter. Exposed for Linux-only integration tests and deployment-owned host
 * adapters; callers must still put it behind `PrivateComparatorFactsCapture`.
 */
export function createLinuxProtectedFactsFileSystem(): ProtectedFactsFileSystem {
  if (process.platform !== 'linux') {
    fail('CAPTURE_PLATFORM_UNSUPPORTED', 'The concrete protected facts reader requires Linux.');
  }
  return new NodeProtectedFactsFileSystem();
}

/** Concrete Linux filesystem adapter for a rehearsal/control host. It remains
 * fail-closed on this Windows development host and is not a cloud deployment
 * claim. */
export class LinuxPrivateComparatorFactsCapture extends PrivateComparatorFactsCapture {
  constructor(input: { trustedRoot: string; candidateUid: number }) {
    super({
      ...input,
      filesystem: createLinuxProtectedFactsFileSystem(),
      host: { platform: process.platform, uid: typeof process.getuid === 'function' ? process.getuid() : null },
    });
  }
}

/** The native reporter currently writes facts0.1, not report0.2. Keep this
 * exported constant explicit so adapters cannot silently substitute a worker
 * chosen path. */
export const LOCAL_PROTECTED_FACTS_PATH = FIXED_PROTECTED_FACTS_PATH;
