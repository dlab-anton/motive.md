import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const PURPOSE_LABEL = 'motive.purpose=protected-worker-joined-qemu-test';
const DEPENDENCY_IMAGE = 'motive-control:native-binding-review';
const DEPENDENCY_IMAGE_ID = 'sha256:67c3229c2820a40da9d1852cd5ba346167cdb326c0156b7b8b5ed4acfb56b7f6';
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
    const payload = line.startsWith('MOTIVE_GATEWAY_EVIDENCE ') ? line.slice('MOTIVE_GATEWAY_EVIDENCE '.length)
      : line.startsWith('MOTIVE_JOINED_LIFECYCLE ') ? line.slice('MOTIVE_JOINED_LIFECYCLE '.length)
      : line.startsWith('MOTIVE_JOINED_MIGRATIONS ') ? line.slice('MOTIVE_JOINED_MIGRATIONS '.length) : line;
    try {
      const value = JSON.parse(payload) as Record<string, any>;
      if (value.format === format) return value;
    } catch { /* Kernel and init diagnostics are intentionally ignored. */ }
  }
  return null;
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
const image = `motive-protected-worker-joined-qemu:${nonce}`;
const containers = {
  metadata: `motive-protected-worker-joined-qemu-metadata-${nonce}`,
  integration: `motive-protected-worker-joined-qemu-integration-${nonce}`,
};
const context = await mkdtemp(join(tmpdir(), 'motive-protected-worker-joined-qemu-build-'));
const outputPath = resolve(process.argv[2] ?? 'fixtures/compatibility/evidence/protected-worker-gateway-qemu-0.153.4.json');
const nativeNames = ['Dockerfile.qemu-joined', 'worker-launcher.c', 'worker-runtime-check.c', 'setuid-probe.c',
  'capability-envelope.c', 'joined-codex-probe.mjs', 'test_launcher.py',
  'joined-qemu-gateway-entry.ts', 'joined-qemu-migrate.ts', 'qemu-joined-guest-init.sh', 'run-qemu-joined-guest.sh'];
const runnerDigestAtStart = sha256(await readFile(resolve('packages/runner-native/native/run-joined-qemu-integration.ts')));
const diagnostics: string[] = [];
const containersCreated = new Set<string>();
let imageCreated = false;
let imageId: string | null = null;
let dependencyImageId: string | null = null;
let dependencyCheckpointEvidence: string | null = null;
let isolation: Record<string, any> | null = null;
let buildEvidence = '';
let worker: Record<string, any> | null = null;
let gateway: Record<string, any> | null = null;
let migrations: Record<string, any> | null = null;
let lifecycle: Record<string, any> | null = null;
let containersRemoved = true;
let imageRemoved = true;
let contextRemoved = false;
let sourceDigests: Record<string, string> = { 'run-joined-qemu-integration.ts': runnerDigestAtStart };

try {
  const dependencyInspect = await docker(['image', 'inspect', '--format', '{{.Id}}', DEPENDENCY_IMAGE], 30_000);
  if (dependencyInspect.code !== 0) throw new Error(details('dependency image inspect', dependencyInspect));
  dependencyImageId = dependencyInspect.stdout.trim();
  if (dependencyImageId !== DEPENDENCY_IMAGE_ID) {
    throw new Error(`Dependency image identity mismatch: expected ${DEPENDENCY_IMAGE_ID}, got ${dependencyImageId}`);
  }

  const checkpoint = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/sh', DEPENDENCY_IMAGE, '-c',
    "find /app/migrations -maxdepth 1 -type f -printf '%f\\n' | sort; sha256sum /app/packages/accounting/src/kernel.ts /app/server/gateway/app.ts /app/scripts/lib/gateway-fixture.ts /app/packages/runner-codex/src/catalog.ts /app/packages/runner-codex/src/harness.ts /app/packages/runner-codex/src/protocol.ts /app/packages/runner-codex/src/mock-provider.ts /app/package.json"], 30_000);
  if (checkpoint.code !== 0 || checkpoint.timedOut || checkpoint.truncated) throw new Error(details('dependency checkpoint inspect', checkpoint));
  dependencyCheckpointEvidence = checkpoint.stdout.trim();
  const expectedMigrationNames = Array.from({ length: 11 }, (_, index) => `${String(index + 1).padStart(3, '0')}_`);
  if (!expectedMigrationNames.every(prefix => dependencyCheckpointEvidence!.split(/\r?\n/).some(line => line.startsWith(prefix))) ||
      dependencyCheckpointEvidence.split(/\r?\n/).some(line => line.startsWith('012_'))) {
    throw new Error('Dependency checkpoint is not the reviewed migration 001-011 boundary.');
  }

  await mkdir(join(context, 'packages/runner-codex/src'), { recursive: true });
  await cp(resolve('packages/runner-codex/src/catalog.ts'), join(context, 'packages/runner-codex/src/catalog.ts'));
  const nativeTarget = join(context, 'packages/runner-native/native');
  await mkdir(nativeTarget, { recursive: true });
  await Promise.all(nativeNames.map(name => cp(resolve('packages/runner-native/native', name),
    join(nativeTarget, name === 'Dockerfile.qemu-joined' ? 'Dockerfile.qemu-joined' : name))));

  const frozenFiles = (await collectFiles(context)).sort();
  const frozenRows = await Promise.all(frozenFiles.map(async file => {
    const name = relative(context, file).replaceAll('\\', '/');
    return [name, sha256(await readFile(file))] as const;
  }));
  sourceDigests = {
    'run-joined-qemu-integration.ts': runnerDigestAtStart,
    ...Object.fromEntries(frozenRows),
  };
  const build = await docker(['build', '--pull=false', '--label', PURPOSE_LABEL, '--file',
    join(context, 'packages/runner-native/native/Dockerfile.qemu-joined'), '--tag', image, context], 1_800_000);
  if (build.code !== 0 || build.timedOut || build.truncated) throw new Error(details('joined QEMU image build', build));
  imageCreated = true;
  imageRemoved = false;
  const imageInspection = await docker(['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
  if (imageInspection.code !== 0) throw new Error(details('joined QEMU image inspect', imageInspection));
  imageId = imageInspection.stdout.trim();

  const common = ['--label', PURPOSE_LABEL, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777', '--user', '65534:65534',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
    '--memory', '3072m', '--cpus', '2'];
  const metadataCommand = ['--entrypoint', '/bin/sh', image, '-c',
    'for f in /guest/package-evidence/* /guest/guest-image-sha256.txt; do echo ===$(basename "$f"); cat "$f"; done'];
  const metadataCreate = await docker(['create', '--name', containers.metadata, ...common, ...metadataCommand], 30_000);
  if (metadataCreate.code !== 0) throw new Error(details('metadata container create', metadataCreate));
  containersCreated.add(containers.metadata);
  const integrationCreate = await docker(['create', '--name', containers.integration, ...common, image], 30_000);
  if (integrationCreate.code !== 0) throw new Error(details('integration container create', integrationCreate));
  containersCreated.add(containers.integration);

  const inspect = await docker(['inspect', containers.integration], 30_000);
  if (inspect.code !== 0) throw new Error(details('joined QEMU container inspect', inspect));
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
    postgresTransport: 'private-unix-socket',
    postgresTcpListening: false,
    workerUid: 2000,
    trustedControllerUid: 1000,
  };

  const metadata = await docker(['start', '--attach', containers.metadata], 30_000);
  if (metadata.code !== 0 || metadata.timedOut || metadata.truncated) throw new Error(details('build evidence read', metadata));
  buildEvidence = metadata.stdout;
  if (!buildEvidence.includes(`dependencyBase=${DEPENDENCY_IMAGE}@${DEPENDENCY_IMAGE_ID}`) ||
      !buildEvidence.includes('kernelRelease=6.12.107+deb13-amd64') ||
      !buildEvidence.includes('dependencySchema=001-011') ||
      !buildEvidence.includes('qemu-system-x86=1:10.0.11+ds-0+deb13u1') ||
      !buildEvidence.includes('postgresqlServerPackage=postgresql-17=17.11-0+deb13u1') ||
      !buildEvidence.includes('codexPackage=@openai/codex@0.153.4') ||
      !/^[a-f0-9]{64}\s+\/.*\.deb$/m.test(buildEvidence) ||
      !/^[a-f0-9]{64}\s+\/output\/vmlinuz$/m.test(buildEvidence)) {
    throw new Error('Pinned joined package/version/checksum evidence is incomplete.');
  }

  const execution = await docker(['start', '--attach', containers.integration], 300_000);
  if (execution.code !== 0 || execution.timedOut || execution.truncated) diagnostics.push(details('joined QEMU execution', execution));
  worker = parseEvidence(execution.stdout, 'motive.protected-worker-joined-codex-session/0.1');
  gateway = parseEvidence(execution.stdout, 'motive.protected-worker-joined-gateway/0.1');
  migrations = parseEvidence(execution.stdout, 'motive.protected-worker-joined-migrations/0.1');
  lifecycle = parseEvidence(execution.stdout, 'motive.protected-worker-joined-lifecycle/0.1');
  if (!worker || worker.passed !== true || worker.platform?.landlockAbi < 3 || worker.codex?.successfulFileReads !== 2) {
    diagnostics.push('Protected worker did not emit a passing Codex 0.153.4 session with two file reads.');
  }
  if (!gateway || gateway.status !== 'passed' || gateway.operations?.length !== 3 ||
      !gateway.operations.every((operation: any) => operation.status === 'RECONCILED') || gateway.spendingDisabled !== true) {
    diagnostics.push('Gateway did not emit three reconciled operations and a disabled spending state.');
  }
  if (!migrations || migrations.status !== 'passed') diagnostics.push('Guest-local PostgreSQL migrations were not exact.');
  if (!lifecycle || lifecycle.gatewayStopped !== true || lifecycle.postgresStopped !== true ||
      lifecycle.postgresTcpProbeSucceeded !== true || lifecycle.postgresTcpListening !== false ||
      lifecycle.exchangeSealedToRoot !== true ||
      worker?.codex?.postgresDataRead?.denied !== true ||
      !['EACCES', 'EPERM'].includes(worker?.codex?.postgresDataRead?.errorCode) ||
      worker?.codex?.postgresSocketConnect?.denied !== true ||
      !['EACCES', 'EPERM'].includes(worker?.codex?.postgresSocketConnect?.errorCode) ||
      !execution.stdout.includes('MOTIVE_GUEST_EXIT=0')) {
    diagnostics.push('Guest service lifecycle or private PostgreSQL isolation evidence is incomplete.');
  }
} catch (error) {
  diagnostics.push(error instanceof Error ? error.message : String(error));
} finally {
  const removals = await Promise.all([...containersCreated].map(name => name.startsWith('motive-protected-worker-joined-qemu-')
    ? docker(['rm', '--force', name], 30_000) : Promise.resolve(null)));
  containersRemoved = removals.length === containersCreated.size && removals.every(result => result?.code === 0);
  if (imageCreated && image.startsWith('motive-protected-worker-joined-qemu:')) {
    imageRemoved = (await docker(['image', 'rm', '--force', image], 90_000)).code === 0;
  }
  const resolvedContext = resolve(context);
  if (resolvedContext.startsWith(`${resolve(tmpdir())}${sep}`) && basename(resolvedContext).startsWith('motive-protected-worker-joined-qemu-build-')) {
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
  && isolation.memoryBytes === 3_221_225_472 && isolation.nanoCpus === 2_000_000_000
  && isolation.guestNetworkDevices === 0 && isolation.guestDiskReadOnly === true
  && isolation.postgresTransport === 'private-unix-socket' && isolation.postgresTcpListening === false;
const cleanup = { containersRemoved, imageRemoved, contextRemoved };
const joinedPassed = worker?.passed === true && gateway?.status === 'passed' && migrations?.status === 'passed'
  && lifecycle?.gatewayStopped === true && lifecycle?.postgresStopped === true;
const passed = diagnostics.length === 0 && isolationPassed && joinedPassed && Object.values(cleanup).every(Boolean);
const frozenRows = Object.entries(sourceDigests).filter(([name]) => name !== 'run-joined-qemu-integration.ts').sort(([a], [b]) => a.localeCompare(b));
const evidence = {
  format: 'motive.protected-worker-gateway-qemu-evidence/0.1',
  capturedAt: new Date().toISOString(),
  status: passed ? 'passed' : 'failed',
  imageId,
  dependencyImage: { name: DEPENDENCY_IMAGE, expectedId: DEPENDENCY_IMAGE_ID, observedId: dependencyImageId },
  dependencyCheckpoint: { schema: '001-011', evidenceDigest: dependencyCheckpointEvidence ? sha256(dependencyCheckpointEvidence) : null,
    evidence: dependencyCheckpointEvidence },
  overlaySources: { combinedDigest: sha256(frozenRows.map(([name, digest]) => `${name}:${digest}`).join('\n')),
    fileCount: frozenRows.length, entryDigests: sourceDigests },
  isolation,
  buildEvidenceDigest: buildEvidence ? sha256(buildEvidence) : null,
  buildEvidence: buildEvidence || null,
  integration: { passed: joinedPassed, worker, gateway, migrations, lifecycle },
  diagnostics,
  cleanup,
  hostKernelChanged: false,
  hostDatabaseUsed: false,
  realProviderCalls: 0,
  realSpendUsd: '0.000000000000',
};
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: evidence.status, outputPath, cleanup }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
