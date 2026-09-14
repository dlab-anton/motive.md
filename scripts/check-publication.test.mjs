import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');
const checker = join(projectRoot, 'scripts', 'check-publication.mjs');
const scratchRoot = join(projectRoot, '.local');

function repository() {
  mkdirSync(scratchRoot, { recursive: true });
  const root = join(scratchRoot, `publication-check-${randomUUID()}`);
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  writeFileSync(join(root, '.gitignore'), [
    '.env*',
    '!.env.example',
    '!.env.*.example',
    '*.log',
    'artifacts/',
    '',
  ].join('\n'));
  return root;
}

function cleanup(root) {
  const resolvedRoot = resolve(root);
  const resolvedScratch = resolve(scratchRoot);
  assert.equal(resolvedRoot.startsWith(`${resolvedScratch}\\`) || resolvedRoot.startsWith(`${resolvedScratch}/`), true);
  assert.match(root, /publication-check-[0-9a-f-]{36}$/i);
  rmSync(root, { recursive: true, force: true });
}

function run(root, environment = {}) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    windowsHide: true,
  });
}

test('scans tracked and untracked publication files while honoring env-example exceptions', () => {
  const root = repository();
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'artifacts'));
    writeFileSync(join(root, 'src', 'index.js'), 'export const ready = true;\n');
    writeFileSync(join(root, '.env.control.example'), 'SUPABASE_SERVICE_ROLE_KEY=\n');
    writeFileSync(join(root, '.env.local'), `OPENAI_API_KEY=${'sk-' + 'A'.repeat(40)}\n`);
    writeFileSync(join(root, 'debug.log'), 'local diagnostics\n');
    writeFileSync(join(root, 'artifacts', 'capture.txt'), 'local capture\n');
    execFileSync('git', ['-C', root, 'add', '.gitignore', '.env.control.example'], { windowsHide: true });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Publication check passed \(3 files\)\./);
  } finally { cleanup(root); }
});

test('rejects forbidden paths even when they are force-tracked', () => {
  const root = repository();
  try {
    mkdirSync(join(root, 'artifacts'));
    writeFileSync(join(root, 'artifacts', 'debug.txt'), 'capture\n');
    execFileSync('git', ['-C', root, 'add', '-f', 'artifacts/debug.txt'], { windowsHide: true });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifacts\/debug\.txt \[generated artifact\]/);
  } finally { cleanup(root); }
});

test('reports credential rules and locations without printing matched values', () => {
  const root = repository();
  try {
    const motive = `motive_agent_${'a'.repeat(32)}_${'B'.repeat(42)}-`;
    const provider = 'sk-' + 'or-v1-' + 'c'.repeat(64);
    const openai = 'sk-' + 'P'.repeat(40);
    const github = 'github_' + 'pat_' + 'D'.repeat(40);
    const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----';
    const payload = Buffer.from(JSON.stringify({ role: 'service_role', ref: 'fixture' })).toString('base64url');
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${payload}.${'e'.repeat(32)}`;
    const passwordUrl = `postgres://worker:${'Z9'.repeat(16)}@db.example.com/app`;
    const values = [motive, provider, openai, github, privateKey, jwt, passwordUrl];
    writeFileSync(join(root, 'config.txt'), `${values.join('\n')}\n`);

    const result = run(root);
    assert.equal(result.status, 1);
    for (const rule of ['Motive bearer', 'OpenRouter key', 'OpenAI key', 'GitHub token', 'private key', 'service-role JWT', 'password in URL']) {
      assert.match(result.stderr, new RegExp(`config\\.txt:\\d+ \\[${rule}\\]`));
    }
    for (const value of values) assert.equal(result.stderr.includes(value), false);
  } finally { cleanup(root); }
});

test('fails closed when a tracked publication file is missing', () => {
  const root = repository();
  try {
    const path = join(root, 'tracked.txt');
    writeFileSync(path, 'tracked\n');
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'], { windowsHide: true });
    rmSync(path);

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tracked\.txt \[unreadable or missing file\]/);
  } finally { cleanup(root); }
});

test('scans UTF-16 environment examples instead of treating them as binary', () => {
  const root = repository();
  try {
    const motive = `motive_review_${'c'.repeat(32)}_${'d'.repeat(42)}_`;
    writeFileSync(join(root, '.env.example'), Buffer.from(`\ufeffMOTIVE_TOKEN=${motive}\n`, 'utf16le'));

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.example:1 \[Motive bearer\]/);
    assert.equal(result.stderr.includes(motive), false);
  } finally { cleanup(root); }
});

test('fails closed outside a Git worktree', () => {
  const root = join(scratchRoot, `publication-check-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    const result = run(root, { GIT_CEILING_DIRECTORIES: scratchRoot });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /readable Git worktree is required/);
  } finally { cleanup(root); }
});

test('fails closed on publication symlinks when the platform permits them', (context) => {
  const root = repository();
  try {
    writeFileSync(join(root, 'target.txt'), 'safe target\n');
    try { symlinkSync('target.txt', join(root, 'linked.txt'), 'file'); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return context.skip('symlink creation is not permitted');
      throw error;
    }
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /linked\.txt \[symbolic link\]/);
  } finally { cleanup(root); }
});
