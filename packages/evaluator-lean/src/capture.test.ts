import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hash, profile } from './runtime-profile.fixture.ts';
import { digestRuntimeBoundComparatorProfile } from './runtime-profile.ts';
import { validateRuntimeBoundComparatorReport } from './runtime-report.ts';
import {
  PrivateComparatorFactsCapture,
  TrustedEvaluatorCaptureError,
  captureRuntimeBoundComparatorReport,
  type ProtectedFactsFileSystem,
  type ProtectedFactsStat,
} from './capture.ts';
import { prepareTrustedEvaluatorReportBindings } from './launch.ts';

const profileDigest = digestRuntimeBoundComparatorProfile(profile);

type Kind = 'directory' | 'file' | 'symlink';
type Entry = { kind: Kind; mode: number; uid: number; size: number; nlink: number; dev: number; ino: number; bytes?: Uint8Array };

function stat(entry: Entry): ProtectedFactsStat {
  return {
    mode: entry.mode, uid: entry.uid, size: entry.size, nlink: entry.nlink, dev: entry.dev, ino: entry.ino,
    isDirectory: () => entry.kind === 'directory',
    isFile: () => entry.kind === 'file',
    isSymbolicLink: () => entry.kind === 'symlink',
  };
}

class FakeFactsFileSystem implements ProtectedFactsFileSystem {
  readonly entries = new Map<string, Entry>();
  reads = 0;
  afterRead: (() => void) | null = null;

  async lstat(path: string): Promise<ProtectedFactsStat> {
    const entry = this.entries.get(path);
    if (!entry) throw new Error('ENOENT');
    return stat(entry);
  }

  async readNoFollow(path: string, maximumBytes: number): Promise<{ bytes: Uint8Array; stat: ProtectedFactsStat }> {
    const entry = this.entries.get(path);
    if (!entry || entry.kind !== 'file' || !entry.bytes || entry.bytes.byteLength > maximumBytes) throw new Error('EIO');
    this.reads += 1;
    const result = { bytes: Uint8Array.from(entry.bytes), stat: stat(entry) };
    this.afterRead?.();
    return result;
  }
}

const root = '/private/evaluator-run';
const factsPath = `${root}/trusted-reports/report.json`;

const verifiedFacts = Buffer.from(JSON.stringify({
  format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
  transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [],
}));

function fixture(): { fs: FakeFactsFileSystem; capture: PrivateComparatorFactsCapture } {
  const fs = new FakeFactsFileSystem();
  fs.entries.set('/', { kind: 'directory', mode: 0o40755, uid: 0, size: 0, nlink: 1, dev: 1, ino: 1 });
  fs.entries.set('/private', { kind: 'directory', mode: 0o40755, uid: 0, size: 0, nlink: 1, dev: 1, ino: 2 });
  fs.entries.set(root, { kind: 'directory', mode: 0o40700, uid: 1001, size: 0, nlink: 1, dev: 1, ino: 3 });
  fs.entries.set(`${root}/trusted-reports`, { kind: 'directory', mode: 0o40700, uid: 1001, size: 0, nlink: 1, dev: 1, ino: 4 });
  fs.entries.set(factsPath, { kind: 'file', mode: 0o100400, uid: 1001, size: verifiedFacts.byteLength, nlink: 1, dev: 1, ino: 5,
    bytes: Uint8Array.from(verifiedFacts) });
  return {
    fs,
    capture: new PrivateComparatorFactsCapture({ trustedRoot: root, candidateUid: 2000, filesystem: fs,
      host: { platform: 'linux', uid: 1001 } }),
  };
}

function bindings(overrides: Record<string, unknown> = {}) {
  return prepareTrustedEvaluatorReportBindings({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
    solution_artifact_manifest_digest: hash, ...overrides });
}

const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('protected Comparator facts capture', () => {
  it('double-reads a private immutable facts file and constructs the exact bound report0.2 capture', async () => {
    const f = fixture();
    const captured = await f.capture.capture({ bindings: bindings(), signal: new AbortController().signal });
    expect(f.fs.reads).toBe(2);
    expect(captured.expected_raw_report_digest).toBe(sha(captured.bytes));
    const report = JSON.parse(Buffer.from(captured.bytes).toString('utf8'));
    expect(report.format).toBe('motive.lean-comparator-report/0.2');
    expect(report.evaluator_profile_digest).toBe(profileDigest);
    expect(report.solution_artifact_manifest_digest).toBe(hash);
    expect(report.facts_capture).toEqual({ bytes_base64: verifiedFacts.toString('base64'), digest: sha(verifiedFacts) });
    expect(Object.values(report.runtime_preflight)).toEqual([false, false, false, false, false]);
    expect(Object.values(report.input_preflight)).toEqual([false, false, false]);
    expect(validateRuntimeBoundComparatorReport({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
      solution_artifact_manifest_digest: hash, captured_report: captured }).outcome).toBe('INCONCLUSIVE');
  });

  it('uses only explicitly declared preflight observations when deriving the envelope', () => {
    const declared = { runtime_preflight: {
      af_unix_denied: true, landlock_enforced: true, namespace_identity: true, descendants_reaped: true, protected_report_capture: true,
    }, input_preflight: { trusted_challenge: true, trusted_dependencies: true, candidate_source_only: true } };
    const captured = captureRuntimeBoundComparatorReport({ bindings: bindings({ declared_preflight: declared }), protectedFactsBytes: verifiedFacts });
    expect(validateRuntimeBoundComparatorReport({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
      solution_artifact_manifest_digest: hash, captured_report: captured }).outcome).toBe('VERIFIED');
  });

  it('rejects candidate-shaped facts instead of accepting output or acceptance assertions', () => {
    const forged = Buffer.from(JSON.stringify({
      format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
      protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
      transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [], human_acceptance: 'ACCEPTED',
    }));
    expect(() => captureRuntimeBoundComparatorReport({ bindings: bindings(), protectedFactsBytes: forged }))
      .toThrow(TrustedEvaluatorCaptureError);
  });

  it('fails closed when the facts file changes between repeat reads', async () => {
    const f = fixture();
    f.fs.afterRead = () => {
      if (f.fs.reads !== 1) return;
      const entry = f.fs.entries.get(factsPath)!;
      entry.bytes = Buffer.from(JSON.stringify({ ...JSON.parse(verifiedFacts.toString('utf8')), outcome: 'INCONCLUSIVE', current_stage: 'solution_build',
        protected_build: false, toolchain_and_export: false, exported_terms: false, statement_comparison: false,
        transitive_axioms: false, kernel_replay: false, used_transitive_axioms: null }));
      entry.size = entry.bytes.byteLength;
    };
    await expect(f.capture.capture({ bindings: bindings(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CAPTURE_FACTS_UNSTABLE' });
  });

  it('will not read a candidate-owned or writable facts file', async () => {
    const f = fixture();
    const entry = f.fs.entries.get(factsPath)!;
    entry.uid = 2000;
    await expect(f.capture.capture({ bindings: bindings(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CAPTURE_FACTS_INVALID' });
    expect(f.fs.reads).toBe(0);

    entry.uid = 1001;
    entry.mode = 0o100600;
    await expect(f.capture.capture({ bindings: bindings(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CAPTURE_FACTS_INVALID' });
    expect(f.fs.reads).toBe(0);
  });

  it('rejects an unavailable or malformed protected facts source', async () => {
    const f = fixture();
    f.fs.entries.delete(factsPath);
    await expect(f.capture.capture({ bindings: bindings(), signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(TrustedEvaluatorCaptureError);
  });
});
