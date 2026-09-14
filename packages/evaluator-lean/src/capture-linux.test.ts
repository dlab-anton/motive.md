import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hash, profile } from './runtime-profile.fixture.ts';
import { digestRuntimeBoundComparatorProfile } from './runtime-profile.ts';
import {
  LinuxPrivateComparatorFactsCapture,
  PrivateComparatorFactsCapture,
  createLinuxProtectedFactsFileSystem,
  type ProtectedFactsFileSystem,
} from './capture.ts';
import { prepareTrustedEvaluatorReportBindings } from './launch.ts';

const linux = process.platform === 'linux' && typeof process.getuid === 'function';
const describeLinux = linux ? describe : describe.skip;
const profileDigest = digestRuntimeBoundComparatorProfile(profile);
const facts = Buffer.from(JSON.stringify({
  format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
  transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [],
}));

let root = '';
let reports = '';
let factsPath = '';

function bindings() {
  return prepareTrustedEvaluatorReportBindings({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
    solution_artifact_manifest_digest: hash });
}

function candidateUid(): number {
  const uid = process.getuid!();
  return uid === 1 ? 2 : 1;
}

async function ancestorPathIsPrivate(path: string): Promise<boolean> {
  const uid = process.getuid!();
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== uid)) return false;
  }
  return true;
}

describeLinux('Linux protected facts capture rehearsal', () => {
  beforeEach(async () => {
    // Place the fixture below the service account home so its ancestors are
    // intentionally private; a /tmp parent is correctly rejected by the
    // capture boundary.
    root = await mkdtemp(join(homedir(), '.motive-private-facts-'));
    reports = join(root, 'trusted-reports');
    factsPath = join(reports, 'report.json');
    await chmod(root, 0o700);
    await mkdir(reports, { mode: 0o700 });
    await chmod(reports, 0o700);
    await writeFile(factsPath, facts, { mode: 0o400 });
    await chmod(factsPath, 0o400);
    if (!(await ancestorPathIsPrivate(root))) throw new Error('LINUX_REHEARSAL_PARENT_UNPROTECTED');
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = reports = factsPath = '';
  });

  it('reads the real POSIX file through O_NOFOLLOW and returns a bound report0.2 capture', async () => {
    const reader = new LinuxPrivateComparatorFactsCapture({ trustedRoot: root, candidateUid: candidateUid() });
    const captured = await reader.capture({ bindings: bindings(), signal: new AbortController().signal });
    const report = JSON.parse(Buffer.from(captured.bytes).toString('utf8'));
    expect(report.facts_capture.bytes_base64).toBe(facts.toString('base64'));
    expect(captured.expected_raw_report_digest)
      .toBe(`sha256:${createHash('sha256').update(captured.bytes).digest('hex')}`);
  });

  it('detects a parent-directory swap to a symlink after a no-follow file open', async () => {
    const node = createLinuxProtectedFactsFileSystem();
    let swapped = false;
    const interceptor: ProtectedFactsFileSystem = {
      lstat: (path, signal) => node.lstat(path, signal),
      async readNoFollow(path, maximumBytes, signal) {
        const result = await node.readNoFollow(path, maximumBytes, signal);
        if (!swapped) {
          swapped = true;
          const retained = join(root, 'retained-reports');
          await rename(reports, retained);
          await symlink(retained, reports, 'dir');
        }
        return result;
      },
    };
    const reader = new PrivateComparatorFactsCapture({ trustedRoot: root, candidateUid: candidateUid(), filesystem: interceptor,
      host: { platform: 'linux', uid: process.getuid!() } });
    await expect(reader.capture({ bindings: bindings(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CAPTURE_PATH_UNPROTECTED' });
  });
});
