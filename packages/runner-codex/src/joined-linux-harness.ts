import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { HarnessEvidence } from './harness.ts';

const CODEX_BASE_IMAGE = 'node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
const GATEWAY_BASE_IMAGE = 'motive-control:orchestration-review';
const DATABASE_CONTAINER = 'motive-infra-test';
const PURPOSE_LABEL = 'motive.purpose=codex-linux-gateway-joined';
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };
type ContainerIsolation = {
  user: string | null;
  readOnlyRootfs: boolean | null;
  mounts: Array<{ type: string; name: string | null; destination: string; readOnly: boolean }>;
  networks: string[];
  publishedPorts: string[];
  capDrop: string[];
  noNewPrivileges: boolean;
  pidsLimit: number | null;
  memoryBytes: number | null;
};

export type JoinedLinuxGatewayEvidence = {
  format: 'motive.codex-linux-gateway-joined/0.1';
  status: 'passed' | 'failed';
  capturedAt: string;
  realProviderCalls: 0;
  realSpendUsd: '0.000000000000';
  images: { codexBase: string; gatewayBase: string; gatewayBaseImageId: string | null;
    codexImageId: string | null; gatewayImageId: string | null };
  sources: { combinedDigest: string; fileCount: number; entryDigests: Record<string, string> };
  isolation: { worker: ContainerIsolation | null; gateway: ContainerIsolation | null;
    workerNetworkInternal: boolean; databaseNetworkInternal: boolean; databaseAttachedTemporarily: boolean };
  codex: HarnessEvidence | null;
  gateway: Record<string, unknown> | null;
  diagnostics: string[];
  cleanup: { workerRemoved: boolean; gatewayRemoved: boolean; databaseDisconnected: boolean;
    workerNetworkRemoved: boolean; databaseNetworkRemoved: boolean; exchangeVolumeRemoved: boolean;
    exchangeInitializerRemoved: boolean; codexImageRemoved: boolean; gatewayImageRemoved: boolean; buildContextsRemoved: boolean };
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function runDocker(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
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

function diagnostic(label: string, result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return `${label}: exit=${result.code} timedOut=${result.timedOut} truncated=${result.truncated}${detail ? `\n${detail}` : ''}`;
}

function requireSuccess(label: string, result: CommandResult): void {
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(diagnostic(label, result));
}

function parseMarker<T>(text: string, marker: string): T | null {
  const line = text.split(/\r?\n/).find(candidate => candidate.startsWith(`${marker} `));
  if (!line) return null;
  try { return JSON.parse(line.slice(marker.length + 1)) as T; }
  catch { return null; }
}

async function inspectContainer(name: string): Promise<ContainerIsolation> {
  const result = await runDocker(['inspect', name], 30_000);
  requireSuccess(`inspect ${name}`, result);
  const inspected = JSON.parse(result.stdout)[0] as Record<string, any>;
  const securityOpt = Array.isArray(inspected.HostConfig?.SecurityOpt) ? inspected.HostConfig.SecurityOpt.map(String) : [];
  const ports = inspected.NetworkSettings?.Ports && typeof inspected.NetworkSettings.Ports === 'object'
    ? Object.entries(inspected.NetworkSettings.Ports).flatMap(([port, bindings]) => bindings === null ? [] : [port]) : [];
  return {
    user: inspected.Config?.User ?? null,
    readOnlyRootfs: inspected.HostConfig?.ReadonlyRootfs ?? null,
    mounts: Array.isArray(inspected.Mounts) ? inspected.Mounts.map((mount: any) => ({ type: String(mount.Type),
      name: mount.Name ? String(mount.Name) : null, destination: String(mount.Destination), readOnly: mount.RW === false })) : [],
    networks: Object.keys(inspected.NetworkSettings?.Networks ?? {}).sort(),
    publishedPorts: ports.sort(),
    capDrop: Array.isArray(inspected.HostConfig?.CapDrop) ? inspected.HostConfig.CapDrop.map(String) : [],
    noNewPrivileges: securityOpt.some((value: string) => value === 'no-new-privileges' || value === 'no-new-privileges:true'),
    pidsLimit: inspected.HostConfig?.PidsLimit ?? null,
    memoryBytes: inspected.HostConfig?.Memory ?? null,
  };
}

async function inspectNetworkInternal(name: string): Promise<boolean> {
  const result = await runDocker(['network', 'inspect', '--format', '{{.Internal}}', name], 30_000);
  requireSuccess(`inspect network ${name}`, result);
  return result.stdout.trim() === 'true';
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

export async function runJoinedLinuxGatewayHarness(databaseUrl: string): Promise<JoinedLinuxGatewayEvidence> {
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname)) {
    throw new Error('Joined preflight requires the dedicated loopback MOTIVE_TEST_DATABASE_URL.');
  }
  parsedDatabaseUrl.hostname = 'motive-infra-db';
  parsedDatabaseUrl.port = '5432';

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const workerName = `motive-codex-joined-worker-${nonce}`;
  const gatewayName = `motive-codex-joined-gateway-${nonce}`;
  const exchangeInitializerName = `motive-codex-joined-exchange-init-${nonce}`;
  const workerNetwork = `motive-codex-joined-worker-net-${nonce}`;
  const databaseNetwork = `motive-codex-joined-db-net-${nonce}`;
  const exchangeVolume = `motive-codex-joined-exchange-${nonce}`;
  const codexImage = `motive-codex-joined-worker:${nonce}`;
  const gatewayImage = `motive-codex-joined-gateway:${nonce}`;
  const codexContext = await mkdtemp(join(tmpdir(), 'motive-codex-joined-worker-build-'));
  const gatewayContext = await mkdtemp(join(tmpdir(), 'motive-codex-joined-gateway-build-'));
  const diagnostics: string[] = [];
  const created = { worker: false, gateway: false, exchangeInitializer: false, workerNetwork: false, databaseNetwork: false,
    exchangeVolume: false, codexImage: false, gatewayImage: false, databaseAttached: false };
  const cleanup = { workerRemoved: false, gatewayRemoved: false, databaseDisconnected: false,
    workerNetworkRemoved: false, databaseNetworkRemoved: false, exchangeVolumeRemoved: false,
    exchangeInitializerRemoved: false, codexImageRemoved: false, gatewayImageRemoved: false, buildContextsRemoved: false };
  let codex: HarnessEvidence | null = null;
  let gateway: Record<string, unknown> | null = null;
  let workerIsolation: ContainerIsolation | null = null;
  let gatewayIsolation: ContainerIsolation | null = null;
  let workerNetworkInternal = false;
  let databaseNetworkInternal = false;
  let codexImageId: string | null = null;
  let gatewayImageId: string | null = null;
  let gatewayBaseImageId: string | null = null;

  const runnerSource = resolve('packages/runner-codex/src');
  const codexSourceNames = ['catalog.ts', 'harness.ts', 'joined-linux-entry.ts', 'mock-provider.ts', 'protocol.ts'];
  const overlayRoots = ['migrations', 'packages/accounting', 'packages/domain', 'packages/inference-gateway',
    'packages/runner-codex', 'scripts/lib', 'server/gateway'];
  const overlayFiles = (await Promise.all(overlayRoots.map(root => collectFiles(resolve(root))))).flat().sort();
  const sourceRows = await Promise.all(overlayFiles.map(async file => `${relative(resolve('.'), file).replaceAll('\\', '/')}:${sha256(await readFile(file))}`));
  const combinedDigest = sha256(sourceRows.join('\n'));
  const entryNames = ['packages/runner-codex/src/joined-linux-harness.ts', 'packages/runner-codex/src/joined-linux-entry.ts',
    'packages/runner-codex/src/joined-gateway-entry.ts', 'packages/runner-codex/src/harness.ts',
    'packages/inference-gateway/src/profile.ts', 'server/gateway/app.ts', 'packages/accounting/src/kernel.ts'];
  const entryDigests = Object.fromEntries(await Promise.all(entryNames.map(async name => [name, sha256(await readFile(resolve(name)))])));

  try {
    const databaseInspect = await runDocker(['inspect', '--format', '{{.State.Running}}', DATABASE_CONTAINER], 30_000);
    requireSuccess('inspect dedicated database', databaseInspect);
    if (databaseInspect.stdout.trim() !== 'true') throw new Error('Dedicated motive-infra-test PostgreSQL is not running.');

    await Promise.all(codexSourceNames.map(name => cp(join(runnerSource, name), join(codexContext, name))));
    await writeFile(join(codexContext, 'Dockerfile'), [
      `FROM ${CODEX_BASE_IMAGE}`,
      'LABEL motive.purpose=codex-profile-repair',
      'RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.153.4 \\',
      ' && test "$(codex --version)" = "codex-cli 0.153.4"',
      `LABEL ${PURPOSE_LABEL}`,
      'WORKDIR /opt/motive-codex-probe',
      'COPY --chown=node:node catalog.ts harness.ts joined-linux-entry.ts mock-provider.ts protocol.ts ./',
      'USER node',
      'ENTRYPOINT ["node", "joined-linux-entry.ts"]',
      '',
    ].join('\n'), 'utf8');

    for (const root of overlayRoots) await cp(resolve(root), join(gatewayContext, root), { recursive: true });
    await writeFile(join(gatewayContext, 'Dockerfile'), [
      `FROM ${GATEWAY_BASE_IMAGE}`,
      `LABEL ${PURPOSE_LABEL}`,
      'COPY --chown=node:node migrations /app/migrations',
      'COPY --chown=node:node packages/accounting /app/packages/accounting',
      'COPY --chown=node:node packages/domain /app/packages/domain',
      'COPY --chown=node:node packages/inference-gateway /app/packages/inference-gateway',
      'COPY --chown=node:node packages/runner-codex /app/packages/runner-codex',
      'COPY --chown=node:node scripts/lib /app/scripts/lib',
      'COPY --chown=node:node server/gateway /app/server/gateway',
      'USER node',
      'ENTRYPOINT ["node", "--import", "tsx", "packages/runner-codex/src/joined-gateway-entry.ts"]',
      'CMD []',
      '',
    ].join('\n'), 'utf8');

    const baseInspect = await runDocker(['image', 'inspect', '--format', '{{.Id}}', GATEWAY_BASE_IMAGE], 30_000);
    requireSuccess('inspect gateway base image', baseInspect);
    gatewayBaseImageId = baseInspect.stdout.trim();
    // The only build-time network effect is the reviewed pinned CLI package install.
    // Runtime containers remain on internal networks and receive no registry access.
    const codexBuild = await runDocker(['build', '--pull=false', '--label', PURPOSE_LABEL,
      '--tag', codexImage, codexContext]);
    requireSuccess('build Codex image from local cache', codexBuild);
    created.codexImage = true;
    const gatewayBuild = await runDocker(['build', '--pull=false', '--network', 'none', '--label', PURPOSE_LABEL,
      '--tag', gatewayImage, gatewayContext]);
    requireSuccess('build current gateway overlay image', gatewayBuild);
    created.gatewayImage = true;
    codexImageId = (await runDocker(['image', 'inspect', '--format', '{{.Id}}', codexImage], 30_000)).stdout.trim() || null;
    gatewayImageId = (await runDocker(['image', 'inspect', '--format', '{{.Id}}', gatewayImage], 30_000)).stdout.trim() || null;

    requireSuccess('create worker network', await runDocker(['network', 'create', '--internal', '--label', PURPOSE_LABEL, workerNetwork], 30_000));
    created.workerNetwork = true;
    requireSuccess('create database network', await runDocker(['network', 'create', '--internal', '--label', PURPOSE_LABEL, databaseNetwork], 30_000));
    created.databaseNetwork = true;
    workerNetworkInternal = await inspectNetworkInternal(workerNetwork);
    databaseNetworkInternal = await inspectNetworkInternal(databaseNetwork);
    requireSuccess('create exchange volume', await runDocker(['volume', 'create', '--label', PURPOSE_LABEL, exchangeVolume], 30_000));
    created.exchangeVolume = true;
    requireSuccess('create exchange initializer', await runDocker(['create', '--name', exchangeInitializerName,
      '--label', PURPOSE_LABEL, '--network', 'none', '--read-only',
      '--mount', `type=volume,src=${exchangeVolume},dst=/exchange`, '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges', '--pids-limit', '16', '--memory', '64m', '--cpus', '0.25',
      CODEX_BASE_IMAGE, 'chown', '1000:1000', '/exchange'], 30_000));
    created.exchangeInitializer = true;
    requireSuccess('initialize exchange volume', await runDocker(['start', '--attach', exchangeInitializerName], 30_000));
    cleanup.exchangeInitializerRemoved = (await runDocker(['rm', '--force', exchangeInitializerName], 30_000)).code === 0;
    created.exchangeInitializer = false;
    requireSuccess('attach dedicated database', await runDocker(['network', 'connect', '--alias', 'motive-infra-db', databaseNetwork, DATABASE_CONTAINER], 30_000));
    created.databaseAttached = true;

    requireSuccess('create gateway container', await runDocker(['create', '--name', gatewayName, '--label', PURPOSE_LABEL,
      '--network', databaseNetwork, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--mount', `type=volume,src=${exchangeVolume},dst=/exchange`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '96', '--memory', '768m', '--cpus', '1', '-e', `MOTIVE_JOINED_DATABASE_URL=${parsedDatabaseUrl.toString()}`,
      gatewayImage], 30_000));
    created.gateway = true;
    requireSuccess('attach gateway to worker network', await runDocker(['network', 'connect', '--alias', 'gateway', workerNetwork, gatewayName], 30_000));
    requireSuccess('create worker container', await runDocker(['create', '--name', workerName, '--label', PURPOSE_LABEL,
      '--network', workerNetwork, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--mount', `type=volume,src=${exchangeVolume},dst=/exchange,readonly`, '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--cpus', '1', codexImage], 30_000));
    created.worker = true;
    gatewayIsolation = await inspectContainer(gatewayName);
    workerIsolation = await inspectContainer(workerName);

    requireSuccess('start gateway', await runDocker(['start', gatewayName], 30_000));
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const check = await runDocker(['exec', gatewayName, 'test', '-f', '/exchange/ready'], 5_000);
      if (check.code === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Joined gateway did not become ready within 15 seconds.');
    const workerRun = await runDocker(['start', '--attach', workerName], 75_000);
    if (workerRun.code !== 0 || workerRun.timedOut || workerRun.truncated) diagnostics.push(diagnostic('worker execution', workerRun));
    codex = parseMarker<HarnessEvidence>(workerRun.stdout, 'MOTIVE_CODEX_EVIDENCE');
    if (!codex) diagnostics.push('Worker did not emit parseable Codex evidence.');

    const gatewayStop = await runDocker(['stop', '--time', '20', gatewayName], 30_000);
    if (gatewayStop.code !== 0 || gatewayStop.timedOut) diagnostics.push(diagnostic('gateway stop', gatewayStop));
    const gatewayLogs = await runDocker(['logs', gatewayName], 30_000);
    if (gatewayLogs.code !== 0 || gatewayLogs.truncated) diagnostics.push(diagnostic('gateway logs', gatewayLogs));
    gateway = parseMarker<Record<string, unknown>>(gatewayLogs.stdout, 'MOTIVE_GATEWAY_EVIDENCE');
    if (!gateway) diagnostics.push('Gateway did not emit parseable joined evidence.');
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (created.exchangeInitializer && exchangeInitializerName.startsWith('motive-codex-joined-exchange-init-')) {
      cleanup.exchangeInitializerRemoved = (await runDocker(['rm', '--force', exchangeInitializerName], 30_000)).code === 0;
    }
    if (created.worker && workerName.startsWith('motive-codex-joined-worker-')) {
      cleanup.workerRemoved = (await runDocker(['rm', '--force', workerName], 30_000)).code === 0;
    }
    if (created.gateway && gatewayName.startsWith('motive-codex-joined-gateway-')) {
      if (!gateway) {
        await runDocker(['stop', '--time', '20', gatewayName], 30_000);
        const logs = await runDocker(['logs', gatewayName], 30_000);
        gateway = parseMarker<Record<string, unknown>>(logs.stdout, 'MOTIVE_GATEWAY_EVIDENCE');
      }
      cleanup.gatewayRemoved = (await runDocker(['rm', '--force', gatewayName], 30_000)).code === 0;
    }
    if (created.databaseAttached && databaseNetwork.startsWith('motive-codex-joined-db-net-')) {
      cleanup.databaseDisconnected = (await runDocker(['network', 'disconnect', '--force', databaseNetwork, DATABASE_CONTAINER], 30_000)).code === 0;
    } else cleanup.databaseDisconnected = !created.databaseAttached;
    if (created.workerNetwork && workerNetwork.startsWith('motive-codex-joined-worker-net-')) {
      cleanup.workerNetworkRemoved = (await runDocker(['network', 'rm', workerNetwork], 30_000)).code === 0;
    }
    if (created.databaseNetwork && databaseNetwork.startsWith('motive-codex-joined-db-net-')) {
      cleanup.databaseNetworkRemoved = (await runDocker(['network', 'rm', databaseNetwork], 30_000)).code === 0;
    }
    if (created.exchangeVolume && exchangeVolume.startsWith('motive-codex-joined-exchange-')) {
      cleanup.exchangeVolumeRemoved = (await runDocker(['volume', 'rm', '--force', exchangeVolume], 30_000)).code === 0;
    }
    if (created.codexImage && codexImage.startsWith('motive-codex-joined-worker:')) {
      cleanup.codexImageRemoved = (await runDocker(['image', 'rm', '--force', codexImage], 30_000)).code === 0;
    }
    if (created.gatewayImage && gatewayImage.startsWith('motive-codex-joined-gateway:')) {
      cleanup.gatewayImageRemoved = (await runDocker(['image', 'rm', '--force', gatewayImage], 30_000)).code === 0;
    }
    let contextsRemoved = true;
    for (const context of [codexContext, gatewayContext]) {
      const resolvedContext = resolve(context);
      if (!resolvedContext.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(resolvedContext).startsWith('motive-codex-joined-')) {
        diagnostics.push(`Refused to remove unexpected build context: ${resolvedContext}`);
        contextsRemoved = false;
      } else {
        try { await rm(resolvedContext, { recursive: true, force: true }); }
        catch (error) { diagnostics.push(`build context cleanup: ${error instanceof Error ? error.message : String(error)}`); contextsRemoved = false; }
      }
    }
    cleanup.buildContextsRemoved = contextsRemoved;
  }

  const cleanupComplete = Object.values(cleanup).every(Boolean);
  const workerMountIsExact = workerIsolation?.mounts.length === 1 && workerIsolation.mounts[0].type === 'volume'
    && workerIsolation.mounts[0].name === exchangeVolume && workerIsolation.mounts[0].destination === '/exchange'
    && workerIsolation.mounts[0].readOnly;
  const gatewayMountIsExact = gatewayIsolation?.mounts.length === 1 && gatewayIsolation.mounts[0].type === 'volume'
    && gatewayIsolation.mounts[0].name === exchangeVolume && gatewayIsolation.mounts[0].destination === '/exchange'
    && !gatewayIsolation.mounts[0].readOnly;
  const isolationPassed = workerIsolation?.user === 'node' && workerIsolation.readOnlyRootfs === true
    && workerIsolation.networks.length === 1 && workerIsolation.networks[0] === workerNetwork
    && workerIsolation.publishedPorts.length === 0 && workerMountIsExact
    && workerIsolation.capDrop.includes('ALL') && workerIsolation.noNewPrivileges
    && gatewayIsolation?.user === 'node' && gatewayIsolation.readOnlyRootfs === true
    && gatewayIsolation.networks.length === 2 && gatewayIsolation.networks.includes(workerNetwork)
    && gatewayIsolation.networks.includes(databaseNetwork) && gatewayIsolation.publishedPorts.length === 0 && gatewayMountIsExact
    && gatewayIsolation.capDrop.includes('ALL') && gatewayIsolation.noNewPrivileges
    && workerNetworkInternal && databaseNetworkInternal;
  const passed = diagnostics.length === 0 && cleanupComplete && isolationPassed
    && codex?.status === 'passed' && codex.codexVersion === 'codex-cli 0.153.4'
    && codex.toolExecution?.successfulFileReads === 2 && gateway?.status === 'passed';
  return {
    format: 'motive.codex-linux-gateway-joined/0.1',
    status: passed ? 'passed' : 'failed',
    capturedAt: new Date().toISOString(),
    realProviderCalls: 0,
    realSpendUsd: '0.000000000000',
    images: { codexBase: CODEX_BASE_IMAGE, gatewayBase: GATEWAY_BASE_IMAGE, gatewayBaseImageId,
      codexImageId, gatewayImageId },
    sources: { combinedDigest, fileCount: overlayFiles.length, entryDigests },
    isolation: { worker: workerIsolation, gateway: gatewayIsolation, workerNetworkInternal,
      databaseNetworkInternal, databaseAttachedTemporarily: created.databaseAttached },
    codex,
    gateway,
    diagnostics,
    cleanup,
  };
}
