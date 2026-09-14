#!/usr/local/bin/node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CONTROL_ROOT = '/run/motive/evaluator/control';
const CREATE_BINDING_PATH = `${CONTROL_ROOT}/create-binding.b64`;
const SOLUTION_PACK_PATH = `${CONTROL_ROOT}/solution-pack.b64`;
const EVALUATOR_PROFILE_PATH = `${CONTROL_ROOT}/evaluator-profile.b64`;
const POLICY_PATH = '/etc/motive/evaluator-source-policy.json';
const TRUSTED_TEMPLATE_PATH = '/opt/evaluator/trusted-template';
const OUTPUT_PARENT = '/var/lib/motive/evaluator';
const OUTPUT_PATH = `${OUTPUT_PARENT}/staged-source`;
const TEMPORARY_PATH = `${OUTPUT_PARENT}/.staged-source.incomplete`;
const MAX_PACK_BYTES = 80 * 1024;
const MAX_PROFILE_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 48 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_BINDING_BYTES = 2 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RESERVED_BASENAMES = new Set(['lakefile.lean', 'lean-toolchain', 'lake-manifest.json', 'lake-manifest.toml', 'manifest.json']);
const RESERVED_DIRECTORIES = new Set(['.git', '.lake', 'build', 'lake-packages']);

function fail() {
  process.stderr.write('MOTIVE_EVALUATOR_SOURCE_STAGING_FAILED\n');
  process.exit(125);
}

function clearEnvironment() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.PATH = '/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin';
  process.env.HOME = '/root';
  process.env.LC_ALL = 'C';
}

function requireRootIdentity() {
  if (typeof process.getuid !== 'function' || typeof process.geteuid !== 'function'
      || typeof process.getgid !== 'function' || typeof process.getegid !== 'function'
      || process.getuid() !== 0 || process.geteuid() !== 0 || process.getgid() !== 0 || process.getegid() !== 0
      || process.getgroups().some(group => group !== 0)) fail();
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}

function canonicalJson(value) {
  const ancestors = new WeakSet();
  const visit = item => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail();
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(visit).join(',')}]`;
      if (!plain(item)) fail();
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit(item[key])}`).join(',')}}`;
    } finally { ancestors.delete(item); }
  };
  return visit(value);
}

function sha(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function protectedDirectory(path, exactMode = null) {
  const stat = await lstat(path, { bigint: true }).catch(fail);
  const mode = Number(stat.mode & 0o7777n);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n || (mode & 0o022) !== 0
      || (exactMode !== null && mode !== exactMode)) fail();
  return stat;
}

async function protectedAncestors(path, finalMode = null) {
  await protectedDirectory('/');
  let current = '';
  const parts = path.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current += `/${parts[index]}`;
    await protectedDirectory(current, index === parts.length - 1 ? finalMode : null);
  }
}

async function readStableRootFile(path, maximumBytes, exactMode = 0o444) {
  const before = await lstat(path, { bigint: true }).catch(fail);
  const mode = Number(before.mode & 0o7777n);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n
      || mode !== exactMode || before.size < 1n || before.size > BigInt(maximumBytes)
      || !Number.isInteger(constants.O_NOFOLLOW)) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(fail);
  try {
    const opened = await handle.stat({ bigint: true }).catch(fail);
    if (!sameStat(before, opened)) fail();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset).catch(fail);
      if (result.bytesRead === 0) fail();
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset).catch(fail)).bytesRead !== 0) fail();
    const after = await handle.stat({ bigint: true }).catch(fail);
    const pathAfter = await lstat(path, { bigint: true }).catch(fail);
    if (!sameStat(before, after) || !sameStat(before, pathAfter)) fail();
    return bytes;
  } finally { await handle.close().catch(fail); }
}

function decodeCanonicalBase64(encoded, maximumBytes, allowEmpty = false) {
  let text;
  try { text = typeof encoded === 'string' ? encoded : new TextDecoder('utf-8', { fatal: true }).decode(encoded); }
  catch { fail(); }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail();
  const bytes = Buffer.from(text, 'base64');
  if ((!allowEmpty && bytes.length < 1) || bytes.length > maximumBytes || bytes.toString('base64') !== text) fail();
  return bytes;
}

function decodeCanonicalJson(bytes) {
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch { fail(); }
  if (canonicalJson(value) !== text) fail();
  return value;
}

function safeSourcePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\\') || value.startsWith('/')
      || /^[a-z]:/i.test(value) || /[\u0000-\u001f\u007f]/u.test(value) || !value.endsWith('.lean')
      || Buffer.byteLength(value) > MAX_PATH_BYTES) fail();
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > MAX_SEGMENT_BYTES)
      || RESERVED_BASENAMES.has(parts.at(-1).toLowerCase())
      || parts.slice(0, -1).some(part => RESERVED_DIRECTORIES.has(part.toLowerCase()))) fail();
  return value;
}

function parseBinding(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^motive\.trusted-evaluator-create\/0\.1\nenvironment_id=([a-f0-9-]+)\nattempt_id=([a-f0-9-]+)\nevaluator_profile_digest=(sha256:[a-f0-9]{64})\nartifact_manifest_digest=(sha256:[a-f0-9]{64})\n$/.exec(text);
  if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) fail();
  return { evaluatorProfileDigest: match[3], artifactManifestDigest: match[4] };
}

function stringArray(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) fail();
  const result = value.map(safeSourcePath);
  if (new Set(result).size !== result.length) fail();
  return result;
}

function parseProfile(bytes, expectedDigest) {
  if (sha(bytes) !== expectedDigest) fail();
  const profile = exact(decodeCanonicalJson(bytes), ['format', 'profile_id', 'challenge', 'toolchain', 'permitted_axioms', 'isolation', 'runtime']);
  if (profile.format !== 'motive.lean-comparator-profile/0.2') fail();
  const challenge = exact(profile.challenge, ['challenge_digest', 'dependency_lock_digest', 'trusted_build_config_digest',
    'challenge_module', 'solution_module', 'theorem_names', 'allowed_solution_paths']);
  for (const digest of [challenge.challenge_digest, challenge.dependency_lock_digest, challenge.trusted_build_config_digest]) {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) fail();
  }
  const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
  if (typeof challenge.challenge_module !== 'string' || !moduleName.test(challenge.challenge_module)
      || typeof challenge.solution_module !== 'string' || !moduleName.test(challenge.solution_module)
      || challenge.challenge_module === challenge.solution_module) fail();
  const allowedPaths = stringArray(challenge.allowed_solution_paths);
  const challengeSourcePath = `${challenge.challenge_module.replaceAll('.', '/')}.lean`;
  const solutionSourcePath = `${challenge.solution_module.replaceAll('.', '/')}.lean`;
  if (allowedPaths.includes(challengeSourcePath) || !allowedPaths.includes(solutionSourcePath)) fail();
  return { allowedPaths, challenge };
}

function parsePolicy(bytes) {
  const policy = exact(decodeCanonicalJson(bytes), ['format', 'allowed_solution_paths', 'expected_challenge_digest',
    'expected_dependency_lock_digest', 'expected_trusted_build_config_digest']);
  if (policy.format !== 'motive.evaluator-source-policy/0.1') fail();
  for (const digest of [policy.expected_challenge_digest, policy.expected_dependency_lock_digest,
    policy.expected_trusted_build_config_digest]) if (typeof digest !== 'string' || !DIGEST.test(digest)) fail();
  return { ...policy, allowed_solution_paths: stringArray(policy.allowed_solution_paths) };
}

function parsePack(bytes, binding, allowedPaths) {
  const pack = exact(decodeCanonicalJson(bytes), ['format', 'artifact_manifest_digest', 'files']);
  if (pack.format !== 'motive.sealed-evaluator-input/0.1' || pack.artifact_manifest_digest !== binding.artifactManifestDigest
      || !Array.isArray(pack.files) || pack.files.length !== allowedPaths.length) fail();
  let total = 0;
  const files = pack.files.map((raw, index) => {
    const file = exact(raw, ['relative_path', 'bytes_base64', 'digest']);
    if (safeSourcePath(file.relative_path) !== allowedPaths[index] || typeof file.digest !== 'string' || !DIGEST.test(file.digest)
        || typeof file.bytes_base64 !== 'string') fail();
    const bytes = decodeCanonicalBase64(file.bytes_base64, MAX_SOURCE_BYTES, true);
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES || sha(bytes) !== file.digest) fail();
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) fail();
    } catch { fail(); }
    return { relativePath: file.relative_path, digest: file.digest, bytes };
  });
  return files;
}

async function requireAbsent(path) {
  try { await lstat(path); fail(); }
  catch (error) { if (error?.code !== 'ENOENT') fail(); }
}

async function createPrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(fail);
  await chown(path, 0, 0).catch(fail);
  await chmod(path, 0o700).catch(fail);
  await protectedDirectory(path, 0o700);
}

async function ensurePrivateDirectory(path) {
  let created = false;
  try { await mkdir(path, { mode: 0o700 }); created = true; }
  catch (error) { if (error?.code !== 'EEXIST') fail(); }
  if (created) {
    await chown(path, 0, 0).catch(fail);
    await chmod(path, 0o700).catch(fail);
  }
  await protectedDirectory(path, 0o700);
}

async function writeRootFile(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400).catch(fail);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset).catch(fail);
      if (result.bytesWritten === 0) fail();
      offset += result.bytesWritten;
    }
    await handle.chown(0, 0).catch(fail);
    await handle.chmod(0o400).catch(fail);
    await handle.sync().catch(fail);
  } finally { await handle.close().catch(fail); }
}

async function stage(files, binding) {
  await protectedAncestors(OUTPUT_PARENT, 0o700);
  await requireAbsent(OUTPUT_PATH);
  await requireAbsent(TEMPORARY_PATH);
  await createPrivateDirectory(TEMPORARY_PATH);
  const filesRoot = join(TEMPORARY_PATH, 'files');
  await createPrivateDirectory(filesRoot);
  for (const file of files) {
    const destination = join(filesRoot, file.relativePath);
    let current = filesRoot;
    for (const part of file.relativePath.split('/').slice(0, -1)) {
      current = join(current, part);
      await ensurePrivateDirectory(current);
    }
    if (dirname(destination) !== current) fail();
    await writeRootFile(destination, file.bytes);
  }
  const receipt = {
    format: 'motive.evaluator-staged-source/0.1',
    artifact_manifest_digest: binding.artifactManifestDigest,
    evaluator_profile_digest: binding.evaluatorProfileDigest,
    files: files.map(file => ({ relative_path: file.relativePath, digest: file.digest, bytes: file.bytes.length })),
  };
  await writeRootFile(join(TEMPORARY_PATH, 'receipt.json'), Buffer.from(canonicalJson(receipt), 'utf8'));
  await rename(TEMPORARY_PATH, OUTPUT_PATH).catch(fail);
}

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'linux') fail();
  clearEnvironment();
  process.umask(0o077);
  requireRootIdentity();
  await protectedAncestors(CONTROL_ROOT, 0o700);
  const names = (await readdir(CONTROL_ROOT).catch(fail)).sort();
  if (names.join('\n') !== ['create-binding.b64', 'evaluator-profile.b64', 'solution-pack.b64'].join('\n')) fail();
  await protectedAncestors(dirname(POLICY_PATH));
  await protectedAncestors(TRUSTED_TEMPLATE_PATH);
  const binding = parseBinding(decodeCanonicalBase64(await readStableRootFile(CREATE_BINDING_PATH, MAX_BINDING_BYTES), MAX_BINDING_BYTES));
  const profile = parseProfile(decodeCanonicalBase64(await readStableRootFile(EVALUATOR_PROFILE_PATH,
    4 * Math.ceil(MAX_PROFILE_BYTES / 3)), MAX_PROFILE_BYTES), binding.evaluatorProfileDigest);
  const policy = parsePolicy(await readStableRootFile(POLICY_PATH, MAX_POLICY_BYTES));
  if (canonicalJson(profile.allowedPaths) !== canonicalJson(policy.allowed_solution_paths)
      || profile.challenge.challenge_digest !== policy.expected_challenge_digest
      || profile.challenge.dependency_lock_digest !== policy.expected_dependency_lock_digest
      || profile.challenge.trusted_build_config_digest !== policy.expected_trusted_build_config_digest) fail();
  const files = parsePack(decodeCanonicalBase64(await readStableRootFile(SOLUTION_PACK_PATH,
    4 * Math.ceil(MAX_PACK_BYTES / 3)), MAX_PACK_BYTES), binding, profile.allowedPaths);
  await stage(files, binding);
  process.stdout.write('MOTIVE_EVALUATOR_SOURCE_STAGED_V1\n');
}

await main().catch(fail);
