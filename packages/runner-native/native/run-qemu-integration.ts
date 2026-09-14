import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const PURPOSE_LABEL = 'motive.purpose=protected-worker-qemu-test';
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function docker(args: string[], timeoutMs = 900_000): Promise<CommandResult> {
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

function parseEvidence(text: string, format: string): Record<string, any> | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, any>;
      if (value.format === format) return value;
    } catch { /* Kernel and init diagnostics are deliberately ignored here. */ }
  }
  return null;
}

const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
const image = `motive-protected-worker-qemu:${nonce}`;
const containers = {
  metadata: `motive-protected-worker-qemu-metadata-${nonce}`,
  adversarial: `motive-protected-worker-qemu-adversarial-${nonce}`,
  codex: `motive-protected-worker-qemu-codex-${nonce}`,
};
const context = await mkdtemp(join(tmpdir(), 'motive-protected-worker-qemu-build-'));
const nativeRoot = resolve('packages/runner-native/native');
const outputPath = resolve(process.argv[2] ?? 'fixtures/compatibility/evidence/protected-worker-runtime-qemu.json');
const names = ['Dockerfile.qemu', 'worker-launcher.c', 'worker-runtime-check.c', 'setuid-probe.c',
  'capability-envelope.c', 'hostile-probe.py', 'codex-probe.mjs', 'test_launcher.py',
  'qemu-guest-init.sh', 'run-qemu-guest.sh'];
const runnerDigestAtStart = sha256(await readFile(resolve('packages/runner-native/native/run-qemu-integration.ts')));
const diagnostics: string[] = [];
const containersCreated = new Set<string>();
let imageCreated = false;
let imageId: string | null = null;
let isolation: Record<string, any> | null = null;
let buildEvidence = '';
let adversarial: Record<string, any> | null = null;
let codex: Record<string, any> | null = null;
let containersRemoved = false;
let imageRemoved = false;
let contextRemoved = false;
let sourceDigests: Record<string, string> = { 'run-qemu-integration.ts': runnerDigestAtStart };

try {
  await Promise.all(names.map(name => copyFile(join(nativeRoot, name), join(context, name === 'Dockerfile.qemu' ? 'Dockerfile' : name))));
  await copyFile(resolve('packages/runner-codex/src/catalog.ts'), join(context, 'catalog.ts'));
  sourceDigests = {
    'run-qemu-integration.ts': runnerDigestAtStart,
    ...Object.fromEntries(await Promise.all([...names, 'catalog.ts'].map(async name => {
      const frozenName = name === 'Dockerfile.qemu' ? 'Dockerfile' : name;
      return [name, sha256(await readFile(join(context, frozenName)))];
    }))),
  };
  const build = await docker(['build', '--pull=false', '--label', PURPOSE_LABEL, '--tag', image, context]);
  if (build.code !== 0 || build.timedOut || build.truncated) throw new Error(details('QEMU image build', build));
  imageCreated = true;
  const imageInspection = await docker(['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
  if (imageInspection.code !== 0) throw new Error(details('QEMU image inspect', imageInspection));
  imageId = imageInspection.stdout.trim();

  const common = ['--label', PURPOSE_LABEL, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777', '--user', '65534:65534',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
    '--memory', '3072m', '--cpus', '2'];
  const metadataCommand = ['--entrypoint', '/bin/sh', image, '-c',
    "for f in /guest/package-evidence/* /guest/guest-image-sha256.txt; do echo ===$(basename \"$f\"); cat \"$f\"; done"];
  const metadataCreate = await docker(['create', '--name', containers.metadata, ...common, ...metadataCommand], 30_000);
  if (metadataCreate.code !== 0) throw new Error(details('metadata container create', metadataCreate));
  containersCreated.add(containers.metadata);
  for (const mode of ['adversarial', 'codex'] as const) {
    const create = await docker(['create', '--name', containers[mode], ...common, image, mode], 30_000);
    if (create.code !== 0) throw new Error(details(`${mode} container create`, create));
    containersCreated.add(containers[mode]);
  }

  const inspect = await docker(['inspect', containers.adversarial], 30_000);
  if (inspect.code !== 0) throw new Error(details('QEMU container inspect', inspect));
  const inspected = JSON.parse(inspect.stdout)[0] as Record<string, any>;
  const security = Array.isArray(inspected.HostConfig?.SecurityOpt) ? inspected.HostConfig.SecurityOpt.map(String) : [];
  isolation = {
    user: inspected.Config?.User ?? null,
    networkMode: inspected.HostConfig?.NetworkMode ?? null,
    readOnlyRootfs: inspected.HostConfig?.ReadonlyRootfs ?? null,
    binds: Array.isArray(inspected.HostConfig?.Binds) ? inspected.HostConfig.Binds : [],
    mounts: Array.isArray(inspected.Mounts) ? inspected.Mounts.map((mount: any) => ({ type: mount.Type, destination: mount.Destination })) : [],
    tmpfs: inspected.HostConfig?.Tmpfs ?? {},
    capAdd: Array.isArray(inspected.HostConfig?.CapAdd) ? inspected.HostConfig.CapAdd : [],
    capDrop: Array.isArray(inspected.HostConfig?.CapDrop) ? inspected.HostConfig.CapDrop : [],
    noNewPrivileges: security.some((value: string) => value === 'no-new-privileges' || value === 'no-new-privileges:true'),
    pidsLimit: inspected.HostConfig?.PidsLimit ?? null,
    memoryBytes: inspected.HostConfig?.Memory ?? null,
    nanoCpus: inspected.HostConfig?.NanoCpus ?? null,
    guestMemoryMiB: 2048,
    guestVcpus: 1,
    accelerator: 'tcg',
    guestNetworkDevices: 0,
    guestDiskReadOnly: true,
  };

  const metadata = await docker(['start', '--attach', containers.metadata], 30_000);
  if (metadata.code !== 0 || metadata.timedOut || metadata.truncated) throw new Error(details('build evidence read', metadata));
  buildEvidence = metadata.stdout;
  if (!buildEvidence.includes('kernelRelease=6.12.107+deb13-amd64') ||
      !buildEvidence.includes('qemu-system-x86=1:10.0.11+ds-0+deb13u1') ||
      !buildEvidence.includes('codexPackage=@openai/codex@0.153.4') ||
      !/^[a-f0-9]{64}\s+\/.*\.deb$/m.test(buildEvidence) ||
      !/^[a-f0-9]{64}\s+\/output\/vmlinuz$/m.test(buildEvidence)) {
    throw new Error('Pinned package/version/checksum evidence is incomplete.');
  }

  const adversarialExecution = await docker(['start', '--attach', containers.adversarial], 240_000);
  if (adversarialExecution.code !== 0 || adversarialExecution.timedOut || adversarialExecution.truncated) {
    diagnostics.push(details('QEMU adversarial execution', adversarialExecution));
  }
  adversarial = parseEvidence(adversarialExecution.stdout, 'motive.protected-worker-adversarial-session/0.1');
  if (!adversarial || adversarial.passed !== true || adversarial.platform?.landlockAbi < 3 ||
      !adversarialExecution.stdout.includes('MOTIVE_GUEST_EXIT=0')) {
    diagnostics.push(`QEMU guest did not emit passing adversarial evidence under Landlock ABI 3+.\n${details('guest output', adversarialExecution)}`);
  }

  const codexExecution = await docker(['start', '--attach', containers.codex], 240_000);
  if (codexExecution.code !== 0 || codexExecution.timedOut || codexExecution.truncated) {
    diagnostics.push(details('QEMU Codex execution', codexExecution));
  }
  codex = parseEvidence(codexExecution.stdout, 'motive.protected-worker-codex-session/0.1');
  if (!codex || codex.passed !== true || codex.platform?.landlockAbi < 3 ||
      codex.codex?.successfulFileReads !== 2 || !codexExecution.stdout.includes('MOTIVE_GUEST_EXIT=0')) {
    diagnostics.push(`QEMU guest did not emit passing Codex 0.153.4 read evidence under Landlock ABI 3+.\n${details('guest output', codexExecution)}`);
  }
} catch (error) {
  diagnostics.push(error instanceof Error ? error.message : String(error));
} finally {
  const removals = await Promise.all([...containersCreated].map(name =>
    name.startsWith('motive-protected-worker-qemu-') ? docker(['rm', '--force', name], 30_000) : Promise.resolve(null)));
  containersRemoved = removals.length === 3 && removals.every(result => result?.code === 0);
  if (imageCreated && image.startsWith('motive-protected-worker-qemu:')) {
    imageRemoved = (await docker(['image', 'rm', '--force', image], 60_000)).code === 0;
  }
  const resolvedContext = resolve(context);
  if (resolvedContext.startsWith(`${resolve(tmpdir())}${sep}`) && basename(resolvedContext).startsWith('motive-protected-worker-qemu-build-')) {
    await rm(resolvedContext, { recursive: true, force: true });
    contextRemoved = true;
  } else diagnostics.push(`Refused to remove unexpected context ${resolvedContext}`);
}

const isolationPassed = isolation?.user === '65534:65534' && isolation.networkMode === 'none'
  && isolation.readOnlyRootfs === true && Array.isArray(isolation.binds) && isolation.binds.length === 0
  && Array.isArray(isolation.mounts) && isolation.mounts.length === 0
  && Array.isArray(isolation.capAdd) && isolation.capAdd.length === 0
  && Array.isArray(isolation.capDrop) && isolation.capDrop.includes('ALL')
  && isolation.noNewPrivileges === true && isolation.pidsLimit === 128
  && isolation.memoryBytes === 3_221_225_472 && isolation.nanoCpus === 2_000_000_000;
const cleanup = { containersRemoved, imageRemoved, contextRemoved };
const passed = diagnostics.length === 0 && isolationPassed && adversarial?.passed === true && codex?.passed === true
  && Object.values(cleanup).every(Boolean);
const evidence = {
  format: 'motive.protected-worker-qemu-evidence/0.1', capturedAt: new Date().toISOString(),
  status: passed ? 'passed' : 'failed', imageId, sourceDigests, isolation,
  buildEvidenceDigest: buildEvidence ? sha256(buildEvidence) : null,
  buildEvidence: buildEvidence || null,
  integration: {
    passed: adversarial?.passed === true && codex?.passed === true,
    adversarial,
    codex,
  },
  diagnostics, cleanup, hostKernelChanged: false, realProviderCalls: 0, realSpendUsd: '0.000000000000',
};
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: evidence.status, outputPath, cleanup }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
