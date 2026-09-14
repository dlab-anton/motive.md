import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const PURPOSE_LABEL = 'motive.purpose=protected-worker-runtime-test';
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function docker(args: string[], timeoutMs = 180_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - captured);
      const accepted = chunk.subarray(0, remaining);
      captured += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
      return current + accepted.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut, truncated }); });
  });
}

function details(label: string, result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return `${label}: exit=${result.code} timedOut=${result.timedOut} truncated=${result.truncated}${output ? `\n${output}` : ''}`;
}

function parseEvidence(text: string, format: string): Record<string, unknown> | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.format === format) return value;
    } catch { /* Ignore bounded non-JSON child diagnostics. */ }
  }
  return null;
}

const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
const image = `motive-protected-worker-test:${nonce}`;
const containers = {
  adversarial: `motive-protected-worker-adversarial-${nonce}`,
  codex: `motive-protected-worker-codex-${nonce}`,
};
const context = await mkdtemp(join(tmpdir(), 'motive-protected-worker-build-'));
const nativeRoot = resolve('packages/runner-native/native');
const outputPath = resolve(process.argv[2] ?? 'fixtures/compatibility/evidence/protected-worker-runtime.json');
const names = ['Dockerfile.test', 'worker-launcher.c', 'worker-runtime-check.c', 'setuid-probe.c',
  'hostile-probe.py', 'codex-probe.mjs', 'test_launcher.py'];
const diagnostics: string[] = [];
let imageCreated = false;
const containersCreated = new Set<string>();
let imageId: string | null = null;
let integration: Record<string, unknown> | null = null;
let isolation: Record<string, unknown> | null = null;
let containerRemoved = false;
let imageRemoved = false;
let contextRemoved = false;

try {
  await Promise.all(names.map(name => copyFile(join(nativeRoot, name), join(context, name === 'Dockerfile.test' ? 'Dockerfile' : name))));
  await copyFile(resolve('packages/runner-codex/src/catalog.ts'), join(context, 'catalog.ts'));
  // The only build network effect is installation of the exact reviewed Codex package.
  // The produced runtime is always executed with Docker network mode `none`.
  const build = await docker(['build', '--pull=false', '--label', PURPOSE_LABEL,
    '--tag', image, context]);
  if (build.code !== 0 || build.timedOut || build.truncated) throw new Error(details('image build', build));
  imageCreated = true;
  const imageInspection = await docker(['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
  imageId = imageInspection.code === 0 ? imageInspection.stdout.trim() : null;
  for (const [mode, container] of Object.entries(containers)) {
    const create = await docker(['create', '--name', container, '--label', PURPOSE_LABEL, '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      '--tmpfs', '/var/lib/motive/worker:rw,nosuid,nodev,noexec,size=64m,uid=2000,gid=2000,mode=0700',
      '--tmpfs', '/var/lib/motive/worker/tmp:rw,nosuid,nodev,noexec,size=32m,uid=2000,gid=2000,mode=0700',
      '--tmpfs', '/var/lib/motive/control:rw,nosuid,nodev,noexec,size=1m,uid=0,gid=0,mode=0755',
      '--tmpfs', '/vercel/sandbox/workspace:rw,nosuid,nodev,size=64m,uid=2000,gid=2000,mode=0755',
      '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SETPCAP',
      '--security-opt', 'no-new-privileges', '--pids-limit', '96', '--memory', '1024m', '--cpus', '1', image, mode], 30_000);
    if (create.code !== 0) throw new Error(details(`container create ${mode}`, create));
    containersCreated.add(container);
  }
  const inspect = await docker(['inspect', containers.adversarial], 30_000);
  if (inspect.code !== 0) throw new Error(details('container inspect', inspect));
  const inspected = JSON.parse(inspect.stdout)[0] as Record<string, any>;
  const security = Array.isArray(inspected.HostConfig?.SecurityOpt) ? inspected.HostConfig.SecurityOpt.map(String) : [];
  isolation = {
    user: inspected.Config?.User || 'root',
    networkMode: inspected.HostConfig?.NetworkMode ?? null,
    readOnlyRootfs: inspected.HostConfig?.ReadonlyRootfs ?? null,
    binds: Array.isArray(inspected.HostConfig?.Binds) ? inspected.HostConfig.Binds : [],
    mounts: Array.isArray(inspected.Mounts) ? inspected.Mounts.map((mount: any) => ({ type: mount.Type, destination: mount.Destination })) : [],
    capAdd: Array.isArray(inspected.HostConfig?.CapAdd) ? inspected.HostConfig.CapAdd.map(String).sort() : [],
    capDrop: Array.isArray(inspected.HostConfig?.CapDrop) ? inspected.HostConfig.CapDrop.map(String) : [],
    noNewPrivileges: security.some((value: string) => value === 'no-new-privileges' || value === 'no-new-privileges:true'),
    pidsLimit: inspected.HostConfig?.PidsLimit ?? null,
    memoryBytes: inspected.HostConfig?.Memory ?? null,
  };
  const adversarialExecution = await docker(['start', '--attach', containers.adversarial], 90_000);
  if (adversarialExecution.code !== 0 || adversarialExecution.timedOut || adversarialExecution.truncated) {
    diagnostics.push(details('adversarial execution', adversarialExecution));
  }
  const adversarial = parseEvidence(adversarialExecution.stdout, 'motive.protected-worker-adversarial-session/0.1');
  if (!adversarial) diagnostics.push('Protected runtime did not emit parseable adversarial evidence.');
  const codexExecution = await docker(['start', '--attach', containers.codex], 90_000);
  if (codexExecution.code !== 0 || codexExecution.timedOut || codexExecution.truncated) {
    diagnostics.push(details('Codex execution', codexExecution));
  }
  const codex = parseEvidence(codexExecution.stdout, 'motive.protected-worker-codex-session/0.1');
  if (!codex) diagnostics.push('Protected runtime did not emit parseable Codex evidence.');
  integration = adversarial && codex ? { passed: adversarial.passed === true && codex.passed === true, adversarial, codex } : null;
} catch (error) {
  diagnostics.push(error instanceof Error ? error.message : String(error));
} finally {
  const removals = await Promise.all([...containersCreated].map(container =>
    container.startsWith('motive-protected-worker-') ? docker(['rm', '--force', container], 30_000) : Promise.resolve(null)));
  containerRemoved = removals.length === 2 && removals.every(result => result?.code === 0);
  if (imageCreated && image.startsWith('motive-protected-worker-test:')) {
    imageRemoved = (await docker(['image', 'rm', '--force', image], 30_000)).code === 0;
  }
  const resolvedContext = resolve(context);
  if (resolvedContext.startsWith(`${resolve(tmpdir())}${sep}`) && basename(resolvedContext).startsWith('motive-protected-worker-build-')) {
    await rm(resolvedContext, { recursive: true, force: true });
    contextRemoved = true;
  } else diagnostics.push(`Refused to remove unexpected context ${resolvedContext}`);
}

const isolationPassed = isolation?.networkMode === 'none' && isolation.readOnlyRootfs === true
  && Array.isArray(isolation.binds) && isolation.binds.length === 0
  && JSON.stringify(isolation.capAdd) === JSON.stringify(['CAP_SETGID', 'CAP_SETPCAP', 'CAP_SETUID'])
  && Array.isArray(isolation.capDrop) && isolation.capDrop.includes('ALL') && isolation.noNewPrivileges === true;
const cleanup = { containerRemoved, imageRemoved, contextRemoved };
const passed = diagnostics.length === 0 && integration?.passed === true && isolationPassed && Object.values(cleanup).every(Boolean);
const sourceNames = [...names, 'catalog.ts'];
const sourceDigests = Object.fromEntries(await Promise.all(sourceNames.map(async name => {
  const path = name === 'catalog.ts' ? resolve('packages/runner-codex/src/catalog.ts') : join(nativeRoot, name);
  return [name, sha256(await readFile(path))];
})));
const evidence = { format: 'motive.protected-worker-runtime-evidence/0.1', capturedAt: new Date().toISOString(),
  status: passed ? 'passed' : 'failed', imageId, sourceDigests, isolation, integration, diagnostics, cleanup,
  realProviderCalls: 0, realSpendUsd: '0.000000000000' };
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: evidence.status, outputPath, cleanup }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
