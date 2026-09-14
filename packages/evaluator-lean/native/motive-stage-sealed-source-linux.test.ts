import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, digestCanonicalJson } from '../../domain/src/contracts.ts';
import { profile } from '../src/runtime-profile.fixture.ts';

const rehearsal = process.env.MOTIVE_SEALED_SOURCE_STAGER_REHEARSAL === '1';
const linuxRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0 && rehearsal;
const describeLinuxRoot = linuxRoot ? describe : describe.skip;
const script = resolve('packages/evaluator-lean/native/motive-stage-sealed-source.mjs');
const control = '/run/motive/evaluator/control';
const policyPath = '/etc/motive/evaluator-source-policy.json';
const template = '/opt/evaluator/trusted-template';
const output = '/var/lib/motive/evaluator/staged-source';
const source = Buffer.from('theorem target : True := by trivial\n');
const sourceDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
const profileBytes = Buffer.from(canonicalJson(profile));
const profileDigest = `sha256:${createHash('sha256').update(profileBytes).digest('hex')}`;
const manifestDigest = digestCanonicalJson('sealed artifact');

const exists = async (path: string) => lstat(path).then(() => true, () => false);
async function rootDirectory(path: string, mode: number) {
  await mkdir(path, { recursive: true, mode }); await chown(path, 0, 0); await chmod(path, mode);
}
async function rootFile(path: string, bytes: Uint8Array) {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o444 }); await chown(path, 0, 0); await chmod(path, 0o444);
}
function binding(digest = profileDigest) {
  return Buffer.from(`motive.trusted-evaluator-create/0.1\nenvironment_id=12345678-1234-4123-8123-123456789abc\nattempt_id=22345678-1234-4123-8123-123456789abc\nevaluator_profile_digest=${digest}\nartifact_manifest_digest=${manifestDigest}\n`).toString('base64');
}
function pack(overrides: Record<string, unknown> = {}) {
  return { format: 'motive.sealed-evaluator-input/0.1', artifact_manifest_digest: manifestDigest,
    files: [{ relative_path: 'Solution.lean', bytes_base64: source.toString('base64'), digest: sourceDigest }], ...overrides };
}
function policy() {
  return { format: 'motive.evaluator-source-policy/0.1', allowed_solution_paths: ['Solution.lean'],
    expected_challenge_digest: profile.challenge.challenge_digest,
    expected_dependency_lock_digest: profile.challenge.dependency_lock_digest,
    expected_trusted_build_config_digest: profile.challenge.trusted_build_config_digest };
}
async function fixture() {
  await rootDirectory(control, 0o700);
  await rootDirectory('/etc/motive', 0o755);
  await rootDirectory(template, 0o555);
  await rootDirectory('/var/lib/motive/evaluator', 0o700);
  await rootFile(`${control}/create-binding.b64`, Buffer.from(binding()));
  await rootFile(`${control}/evaluator-profile.b64`, Buffer.from(profileBytes.toString('base64')));
  await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack())).toString('base64')));
  await rootFile(policyPath, Buffer.from(canonicalJson(policy())));
}
function invoke(args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: '/', encoding: 'utf8', timeout: 10_000,
    env: { ATTACKER_PATH: '/candidate', NODE_OPTIONS: '' } });
}
function rejected(result: ReturnType<typeof invoke>) {
  expect(result.error).toBeUndefined(); expect(result.status).toBe(125);
  expect(result.stdout).toBe(''); expect(result.stderr).toBe('MOTIVE_EVALUATOR_SOURCE_STAGING_FAILED\n');
}

describeLinuxRoot('root-owned sealed source staging rehearsal', () => {
  let ownsRoots = false;
  beforeEach(async () => {
    expect(await Promise.all(['/run/motive', '/var/lib/motive', policyPath, template].map(exists)))
      .toEqual([false, false, false, false]);
    ownsRoots = true;
    await fixture();
  });
  afterEach(async () => {
    if (!ownsRoots) return;
    await rm('/run/motive', { recursive: true, force: true });
    await rm('/var/lib/motive', { recursive: true, force: true });
    await rm(policyPath, { force: true });
    await rm(template, { recursive: true, force: true });
    ownsRoots = false;
  });

  it('stages exactly the profile-approved source into a private immutable tree and receipt', async () => {
    const result = invoke();
    expect(result.status).toBe(0); expect(result.stdout).toBe('MOTIVE_EVALUATOR_SOURCE_STAGED_V1\n'); expect(result.stderr).toBe('');
    const staged = `${output}/files/Solution.lean`;
    expect(await readFile(staged)).toEqual(source);
    for (const path of [output, `${output}/files`]) {
      const stat = await lstat(path); expect(stat.uid).toBe(0); expect(stat.gid).toBe(0); expect(stat.mode & 0o7777).toBe(0o700);
    }
    for (const path of [staged, `${output}/receipt.json`]) {
      const stat = await lstat(path); expect(stat.uid).toBe(0); expect(stat.gid).toBe(0); expect(stat.nlink).toBe(1); expect(stat.mode & 0o7777).toBe(0o400);
    }
    expect(JSON.parse(await readFile(`${output}/receipt.json`, 'utf8'))).toEqual({
      format: 'motive.evaluator-staged-source/0.1', artifact_manifest_digest: manifestDigest,
      evaluator_profile_digest: profileDigest, files: [{ relative_path: 'Solution.lean', digest: sourceDigest, bytes: source.length }],
    });
    rejected(invoke());
  });

  it('rejects profile, manifest, whitelist, digest, argument, and source-size substitutions', async () => {
    const cases: Array<() => Promise<void>> = [
      async () => { await rm(`${control}/create-binding.b64`); await rootFile(`${control}/create-binding.b64`, Buffer.from(binding(digestCanonicalJson('other')))); },
      async () => { await rm(`${control}/solution-pack.b64`); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ artifact_manifest_digest: digestCanonicalJson('other') }))).toString('base64'))); },
      async () => { await rm(`${control}/solution-pack.b64`); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files: [{ relative_path: 'Challenge.lean', bytes_base64: source.toString('base64'), digest: sourceDigest }] }))).toString('base64'))); },
      async () => { await rm(`${control}/solution-pack.b64`); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files: [{ relative_path: 'Solution.lean', bytes_base64: Buffer.from('changed').toString('base64'), digest: sourceDigest }] }))).toString('base64'))); },
      async () => { await rm(`${control}/solution-pack.b64`); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files: [{ relative_path: 'Solution.lean', bytes_base64: 'ÁQ==', digest: sourceDigest }] }))).toString('base64'))); },
      async () => { await rm(`${control}/solution-pack.b64`); const large = Buffer.alloc(48 * 1024 + 1, 65); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files: [{ relative_path: 'Solution.lean', bytes_base64: large.toString('base64'), digest: `sha256:${createHash('sha256').update(large).digest('hex')}` }] }))).toString('base64'))); },
    ];
    for (const mutate of cases) {
      await mutate(); rejected(invoke());
      await rm('/var/lib/motive/evaluator/.staged-source.incomplete', { recursive: true, force: true });
      await rm(`${control}/create-binding.b64`, { force: true }); await rm(`${control}/solution-pack.b64`, { force: true });
      await rootFile(`${control}/create-binding.b64`, Buffer.from(binding()));
      await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack())).toString('base64')));
    }
    rejected(invoke(['unexpected']));
  });

  it('rejects symlinked control input and a writable trusted-template ancestor', async () => {
    await rm(`${control}/solution-pack.b64`);
    await symlink('/etc/motive/evaluator-source-policy.json', `${control}/solution-pack.b64`);
    rejected(invoke());
    await rm(`${control}/solution-pack.b64`); await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack())).toString('base64')));
    await chmod('/opt/evaluator', 0o777);
    try { rejected(invoke()); }
    finally { await chmod('/opt/evaluator', 0o755); }
  });

  it('stages an empty approved source so the evaluator can reject it as Lean input', async () => {
    await rm(`${control}/solution-pack.b64`);
    const empty = Buffer.alloc(0);
    const emptyPack = pack({ files: [{ relative_path: 'Solution.lean', bytes_base64: '',
      digest: `sha256:${createHash('sha256').update(empty).digest('hex')}` }] });
    await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(emptyPack)).toString('base64')));
    expect(invoke().status).toBe(0);
    expect(await readFile(`${output}/files/Solution.lean`)).toEqual(empty);
  });

  it('stages multiple approved sources that share a private directory', async () => {
    const expanded = structuredClone(profile);
    expanded.challenge.allowed_solution_paths = ['Nested/A.lean', 'Nested/B.lean', 'Solution.lean'];
    const expandedBytes = Buffer.from(canonicalJson(expanded));
    const expandedDigest = `sha256:${createHash('sha256').update(expandedBytes).digest('hex')}`;
    const paths = expanded.challenge.allowed_solution_paths;
    const files = paths.map(relative_path => ({ relative_path, bytes_base64: source.toString('base64'), digest: sourceDigest }));
    const expandedPolicy = { ...policy(), allowed_solution_paths: paths };
    await Promise.all([`${control}/create-binding.b64`, `${control}/evaluator-profile.b64`, `${control}/solution-pack.b64`, policyPath]
      .map(path => rm(path)));
    await rootFile(`${control}/create-binding.b64`, Buffer.from(binding(expandedDigest)));
    await rootFile(`${control}/evaluator-profile.b64`, Buffer.from(expandedBytes.toString('base64')));
    await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files }))).toString('base64')));
    await rootFile(policyPath, Buffer.from(canonicalJson(expandedPolicy)));
    expect(invoke().status).toBe(0);
    expect(await readFile(`${output}/files/Nested/A.lean`)).toEqual(source);
    expect(await readFile(`${output}/files/Nested/B.lean`)).toEqual(source);
  });

  it('rejects a transferred profile and baked policy that allow the trusted challenge source', async () => {
    const expanded = structuredClone(profile);
    expanded.challenge.allowed_solution_paths = ['Challenge.lean', 'Solution.lean'];
    const expandedBytes = Buffer.from(canonicalJson(expanded));
    const expandedDigest = `sha256:${createHash('sha256').update(expandedBytes).digest('hex')}`;
    const paths = expanded.challenge.allowed_solution_paths;
    const files = paths.map(relative_path => ({ relative_path, bytes_base64: source.toString('base64'), digest: sourceDigest }));
    const expandedPolicy = { ...policy(), allowed_solution_paths: paths };
    await Promise.all([`${control}/create-binding.b64`, `${control}/evaluator-profile.b64`, `${control}/solution-pack.b64`, policyPath]
      .map(path => rm(path)));
    await rootFile(`${control}/create-binding.b64`, Buffer.from(binding(expandedDigest)));
    await rootFile(`${control}/evaluator-profile.b64`, Buffer.from(expandedBytes.toString('base64')));
    await rootFile(`${control}/solution-pack.b64`, Buffer.from(Buffer.from(canonicalJson(pack({ files }))).toString('base64')));
    await rootFile(policyPath, Buffer.from(canonicalJson(expandedPolicy)));
    rejected(invoke());
    expect(await exists(output)).toBe(false);
  });
});
