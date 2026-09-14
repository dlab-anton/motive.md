import { spawnSync } from 'node:child_process';
import { chmod, chown, link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LinuxPrivateComparatorFactsCapture } from '../src/capture.ts';
import { prepareTrustedEvaluatorReportBindings } from '../src/launch.ts';
import { hash, profile } from '../src/runtime-profile.fixture.ts';
import { digestRuntimeBoundComparatorProfile } from '../src/runtime-profile.ts';

const finalizer = process.env.MOTIVE_FACTS_FINALIZER;
const rehearsal = process.env.MOTIVE_FACTS_FINALIZER_REHEARSAL === '1';
const linuxRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  && rehearsal && typeof finalizer === 'string' && finalizer.startsWith('/');
const describeLinuxRoot = linuxRoot ? describe : describe.skip;

const reporterUid = 1000;
const reporterGid = 1000;
const maximumFactsBytes = 128 * 1024;
const work = '/work';
const reports = `${work}/trusted-reports`;
const factsPath = `${reports}/report.json`;
const markerDirectory = '/run/motive/evaluator';
const markerPath = `${markerDirectory}/supervisor-complete`;
const consumedMarkerPath = `${markerDirectory}/.supervisor-complete.consumed`;
const outputRoot = '/var/lib/motive/evaluator';
const outputDirectory = `${outputRoot}/trusted-reports`;
const outputPath = `${outputDirectory}/report.json`;
const markerPrefix = Buffer.from('motive.evaluator-supervisor-complete/0.2\n');
const facts = Buffer.from(JSON.stringify({
  format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
  transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [],
}));
const profileDigest = digestRuntimeBoundComparatorProfile(profile);

function bindings() {
  return prepareTrustedEvaluatorReportBindings({
    evaluator_profile: profile,
    frozen_evaluator_profile_digest: profileDigest,
    solution_artifact_manifest_digest: hash,
  });
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

async function setModeAndOwner(path: string, mode: number, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid);
  await chmod(path, mode);
}

async function createFacts(input: { bytes?: Uint8Array; uid?: number; gid?: number; mode?: number } = {}): Promise<Uint8Array> {
  const bytes = input.bytes ?? facts;
  const uid = input.uid ?? reporterUid;
  const gid = input.gid ?? reporterGid;
  const mode = input.mode ?? 0o600;
  await mkdir(reports, { recursive: true, mode: 0o700 });
  await setModeAndOwner(work, 0o700, reporterUid, reporterGid);
  await setModeAndOwner(reports, 0o700, reporterUid, reporterGid);
  await writeFile(factsPath, bytes, { mode, flag: 'wx' });
  await setModeAndOwner(factsPath, mode, uid, gid);
  return bytes;
}

async function createCompletionMarker(snapshot: Uint8Array): Promise<void> {
  await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  await setModeAndOwner('/run/motive', 0o755, 0, 0);
  await setModeAndOwner(markerDirectory, 0o700, 0, 0);
  await writeFile(markerPath, Buffer.concat([markerPrefix, snapshot]), { mode: 0o400, flag: 'wx' });
  await setModeAndOwner(markerPath, 0o400, 0, 0);
}

async function createExistingOutput(bytes: Uint8Array): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await setModeAndOwner('/var/lib/motive', 0o755, 0, 0);
  await setModeAndOwner(outputRoot, 0o700, 0, 0);
  await setModeAndOwner(outputDirectory, 0o700, 0, 0);
  await writeFile(outputPath, bytes, { mode: 0o400, flag: 'wx' });
  await setModeAndOwner(outputPath, 0o400, 0, 0);
}

function invoke(identity?: { uid: number; gid: number }) {
  return spawnSync(finalizer!, [], { cwd: '/', encoding: 'utf8', env: {}, timeout: 8_000, ...identity });
}

function expectRejected(result: ReturnType<typeof invoke>): void {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(125);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('MOTIVE_EVALUATOR_FACTS_FINALIZER_FAILED\n');
}

describeLinuxRoot('root-only native facts finalizer rehearsal', () => {
  let ownsTestRoots = false;

  beforeEach(async () => {
    // This disposable image has none of these roots. Refuse to delete a base
    // image path if that assumption changes.
    expect(await Promise.all([work, '/run/motive', '/var/lib/motive'].map(exists))).toEqual([false, false, false]);
    ownsTestRoots = true;
  });

  afterEach(async () => {
    if (!ownsTestRoots) return;
    await rm(work, { recursive: true, force: true });
    await rm('/run/motive', { recursive: true, force: true });
    await rm('/var/lib/motive', { recursive: true, force: true });
    ownsTestRoots = false;
  });

  it('publishes a root-only immutable copy and the Linux capture reads that copy as report0.2 facts', async () => {
    const source = await createFacts({ mode: 0o600 });
    await createCompletionMarker(source);

    const result = invoke();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('MOTIVE_EVALUATOR_FACTS_FINALIZED_V1\n');
    expect(result.stderr).toBe('');

    const stat = await lstat(outputPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.uid).toBe(0);
    expect(stat.gid).toBe(0);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o7777).toBe(0o400);
    expect(await readFile(outputPath)).toEqual(source);
    expect(await exists(markerPath)).toBe(false);
    expect(await exists(consumedMarkerPath)).toBe(true);

    const capture = new LinuxPrivateComparatorFactsCapture({ trustedRoot: outputRoot, candidateUid: reporterUid });
    const captured = await capture.capture({ bindings: bindings(), signal: new AbortController().signal });
    const report = JSON.parse(Buffer.from(captured.bytes).toString('utf8'));
    expect(report.facts_capture.bytes_base64).toBe(Buffer.from(source).toString('base64'));
    expect(report.runtime_preflight).toEqual({
      af_unix_denied: false, landlock_enforced: false, namespace_identity: false,
      descendants_reaped: false, protected_report_capture: false,
    });
    expect(captured.expected_raw_report_digest)
      .toBe(`sha256:${createHash('sha256').update(captured.bytes).digest('hex')}`);

    expectRejected(invoke());
    expect(await readFile(outputPath)).toEqual(source);
  });

  it.each(['final facts symlink', 'facts-parent symlink'])('rejects a %s before publication', async kind => {
    const source = await createFacts();
    await createCompletionMarker(source);
    if (kind === 'final facts symlink') {
      await writeFile(`${work}/other-facts`, source, { mode: 0o600 });
      await setModeAndOwner(`${work}/other-facts`, 0o600, reporterUid, reporterGid);
      await rm(factsPath);
      await symlink(`${work}/other-facts`, factsPath, 'file');
    } else {
      const retained = `${work}/retained-reports`;
      await rename(reports, retained);
      await symlink(retained, reports, 'dir');
    }

    expectRejected(invoke());
    expect(await exists(outputPath)).toBe(false);
  });

  it('rejects a facts file with more than one hard link', async () => {
    const source = await createFacts();
    await createCompletionMarker(source);
    await link(factsPath, `${work}/facts-second-link`);

    expectRejected(invoke());
    expect((await lstat(factsPath)).nlink).toBe(2);
    expect(await exists(outputPath)).toBe(false);
  });

  it('rejects oversized facts before publication', async () => {
    await createFacts({ bytes: Buffer.alloc(maximumFactsBytes + 1, 0x61) });

    expectRejected(invoke());
    expect(await exists(outputPath)).toBe(false);
  });

  it('does not overwrite an existing protected output report', async () => {
    const source = await createFacts();
    await createCompletionMarker(source);
    const sentinel = Buffer.from('{"existing":"protected"}\n');
    await createExistingOutput(sentinel);

    expectRejected(invoke());
    expect(await readFile(outputPath)).toEqual(sentinel);
  });

  it('rejects facts owned by a UID other than the reporter identity', async () => {
    await createFacts({ uid: 1001, gid: 1001 });

    expectRejected(invoke());
    expect(await exists(outputPath)).toBe(false);
  });

  it('rejects a non-root finalizer invocation before it reads any path', () => {
    expectRejected(invoke({ uid: reporterUid, gid: reporterGid }));
  });

  it('rejects a missing completion marker and a marker that is not bound to the facts bytes', async () => {
    const source = await createFacts();
    expectRejected(invoke());
    await createCompletionMarker(Buffer.from('different trusted snapshot'));

    expectRejected(invoke());
    expect(await exists(outputPath)).toBe(false);
    expect(await readFile(factsPath)).toEqual(source);
  });
});
