import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { applyPostgresMigrations } from '../packages/accounting/src/migrations.ts';
import { enrollByoRehearsal, seedByoRehearsalDatabase } from './rehearsal-byo-fixture.ts';
import { observeChild, terminateChild, type ObservedChild } from './rehearse-participation.ts';
import {
  BYO_ORIGINS, createByoDatabaseNames, createContributorHandoff, deriveByoDatabaseUrls, safeRequestMetadata, validateByoDatabaseName,
  validateEngineProxyTarget,
} from './lib/byo-rehearsal.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ENGINE_ROOT = resolve('C:/Projects/hypothesisengine/hypothesis_engine_api');
const MAX_REHEARSAL_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENGINE_KEY = /^he_[A-Za-z0-9_-]{43}$/;
const MOTIVE_LISTEN = 'motive.md application service listening on 127.0.0.1:4336';

type StartupDiagnostic = 'address-in-use' | 'configuration-invalid' | 'database-unavailable'
  | 'import-failed' | 'application-startup-failed' | 'unclassified-exit';
type MarkedChild = { observed: ObservedChild; marker: () => boolean; diagnostic: () => StartupDiagnostic };
type EngineProvision = {
  apiBaseUrl: string;
  tenantId: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  apiKey: string;
};

function operatingSystemEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'processor_architecture',
    'number_of_processors', 'localappdata', 'appdata', 'userprofile', 'home',
  ]);
  return Object.fromEntries(Object.entries(parent).filter(([name, value]) => value !== undefined && allowed.has(name.toLowerCase())));
}

function jsonLineTrace(file: string, service: 'engine', readyFile: string, request: IncomingMessage,
  status: number, startedAt: string, started: number): void {
  const metadata = safeRequestMetadata(request.url ?? '/');
  appendFileSync(file, `${JSON.stringify({
    service,
    phase: existsSync(readyFile) ? 'rehearsal' : 'bootstrap',
    startedAt,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    method: request.method ?? 'UNKNOWN',
    ...metadata,
    status,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function requestBytes(request: IncomingMessage, maximum = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.byteLength;
    if (total > maximum) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function responseBytes(response: Response, maximum = 4 * 1024 * 1024): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function engineTraceProxy(traceFile: string, readyFile: string): Server {
  return createServer(async (request, response) => {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let status = 502;
    try {
      const target = validateEngineProxyTarget(request.url ?? '/');
      const body = ['GET', 'HEAD'].includes(request.method ?? '') ? undefined : await requestBytes(request);
      const headers = new Headers();
      for (const name of ['accept', 'content-type', 'x-api-key', 'idempotency-key']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        ...(body ? { body: body.toString('utf8') } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const bytes = await responseBytes(upstream);
      status = upstream.status;
      response.statusCode = status;
      for (const name of ['content-type', 'cache-control', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name); if (value) response.setHeader(name, value);
      }
      response.end(bytes);
    } catch (error) {
      status = error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 502;
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ detail: status === 413 ? 'Request too large' : 'Local engine unavailable' }));
    } finally {
      try { jsonLineTrace(traceFile, 'engine', readyFile, request, status, startedAt, started); }
      catch { /* diagnostics never affect the proxied response */ }
    }
  });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const failed = (error: Error) => { server.off('listening', ready); rejectListen(error); };
    const ready = () => { server.off('error', failed); resolveListen(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  const completed = await new Promise<boolean>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => resolveClose(false), 5_000);
    closed.then(() => { clearTimeout(timer); resolveClose(true); }, error => { clearTimeout(timer); rejectClose(error); });
  });
  if (!completed) {
    server.closeAllConnections();
    const forced = await new Promise<boolean>((resolveClose, rejectClose) => {
      const timer = setTimeout(() => resolveClose(false), 2_000);
      closed.then(() => { clearTimeout(timer); resolveClose(true); }, error => { clearTimeout(timer); rejectClose(error); });
    });
    if (!forced) throw new Error('A local rehearsal HTTP server did not close after forced connection shutdown.');
  }
}

function spawnMarked(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv },
  recognizes: (output: string) => boolean): MarkedChild {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const observed = observeChild(child);
  let output = '';
  let marked = false;
  const inspect = (chunk: unknown) => {
    if (marked) return;
    output = `${output}${String(chunk)}`.slice(-2_048);
    marked = recognizes(output);
    if (marked) output = '';
  };
  child.stdout?.on('data', inspect); child.stderr?.on('data', inspect);
  const diagnostic = (): StartupDiagnostic => {
    if (/EADDRINUSE|WinError 10048|address already in use/i.test(output)) return 'address-in-use';
    if (/ValidationError|configuration error|settings validation/i.test(output)) return 'configuration-invalid';
    if (/connection refused|could not connect|database .* unavailable/i.test(output)) return 'database-unavailable';
    if (/ModuleNotFoundError|ImportError|Error loading ASGI app/i.test(output)) return 'import-failed';
    if (/Application startup failed/i.test(output)) return 'application-startup-failed';
    return 'unclassified-exit';
  };
  return { observed, marker: () => marked, diagnostic };
}

async function waitForChild(child: ObservedChild, timeoutMs: number, label: string): Promise<void> {
  const result = await new Promise<Awaited<typeof child.closed> | null>(resolveResult => {
    const timer = setTimeout(() => resolveResult(null), timeoutMs);
    child.closed.then(value => { clearTimeout(timer); resolveResult(value); });
  });
  if (!result) {
    await terminateChild(child, label);
    throw new Error(`${label} exceeded its bounded runtime.`);
  }
  if (result.spawnError || result.code !== 0) throw new Error(`${label} failed.`);
}

async function captureOneShot(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const observed = observeChild(child);
  let output = '';
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-4_096); });
  await waitForChild(observed, 15_000, 'Python runtime discovery');
  return output.trim();
}

async function runOneShot(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  label: string, timeoutMs = 60_000): Promise<void> {
  const child = observeChild(spawn(command, args, { cwd, env, windowsHide: true, stdio: 'ignore' }));
  await waitForChild(child, timeoutMs, label);
}

async function waitForService(child: MarkedChild, healthUrl: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.observed.result) throw new Error(`${label} closed during startup (${child.diagnostic()}).`);
    if (child.marker()) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (response.ok && !child.observed.result) return;
      } catch { /* bounded startup polling */ }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`${label} did not become ready.`);
}

async function jsonRequest(url: string, init: RequestInit, expectedStatus: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (response.status !== expectedStatus) throw new Error(`Local bootstrap request failed with status ${response.status}.`);
  const bytes = await responseBytes(response, 256 * 1024);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('Local bootstrap response was not valid bounded JSON.');
  }
}

async function provisionEngine(): Promise<EngineProvision> {
  const generated = await jsonRequest(`${BYO_ORIGINS.engineApi}/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'motive-byo-rehearsal' }),
  }, 201);
  const apiKey = generated.key;
  const workspaceId = generated.tenant_id;
  if (typeof apiKey !== 'string' || !ENGINE_KEY.test(apiKey)
      || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new Error('The local engine returned an invalid generated workspace credential envelope.');
  }
  const channelName = 'circle-packing';
  const channel = await jsonRequest(`${BYO_ORIGINS.engineApi}/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      name: channelName,
      goal: 'Accumulate bounded circle-packing hypotheses and evidence across Motive research cycles.',
      created_by: 'motive-byo-rehearsal',
      metadata: { fixture: 'empty-byo-rehearsal-channel' },
    }),
  }, 201);
  const channelId = channel.id;
  if (typeof channelId !== 'string' || !UUID.test(channelId) || channel.name !== channelName) {
    throw new Error('The local engine returned an invalid channel envelope.');
  }
  const context = await jsonRequest(
    `${BYO_ORIGINS.engineApi}/channels/${channelName}/context?expected_channel_id=${channelId}`,
    { headers: { 'x-api-key': apiKey } }, 200,
  );
  for (const field of ['active_hypotheses', 'archived_hypotheses', 'insights']) {
    const page = context[field] as { items?: unknown } | undefined;
    if (!page || !Array.isArray(page.items) || page.items.length !== 0) {
      throw new Error('The generated local engine channel was not empty.');
    }
  }
  if (!Array.isArray(context.evidence_pages) || context.evidence_pages.length !== 0) {
    throw new Error('The generated local engine channel contained unexpected evidence.');
  }
  return { apiBaseUrl: BYO_ORIGINS.engineApi, tenantId: workspaceId, workspaceId,
    channelId, channelName, apiKey };
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function pythonFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__') files.push(...await pythonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.py')) files.push(path);
  }
  return files;
}

async function sourceDigests(): Promise<Record<string, string>> {
  const motiveFiles = [
    'public/agents/SKILL.md', 'public/agents/circle-packing.json', 'server/index.ts',
    'server/research-memory/service.ts', 'server/participation/service.ts', 'vite.config.ts',
    'server/research-memory/contracts/motive-writeback-local-017.json',
    'scripts/rehearsal-byo-fixture.ts', 'scripts/rehearsal-request-trace-preload.ts',
    'scripts/rehearsal-byo-vite.config.ts', 'scripts/lib/byo-rehearsal.ts', 'scripts/rehearse-byo-engine.ts',
  ];
  const values: Record<string, string> = {};
  for (const file of motiveFiles) values[`motive:${file}`] = await hashFile(resolve(ROOT, file));
  const engineFiles = [
    ...await pythonFiles(resolve(ENGINE_ROOT, 'app')),
    ...await pythonFiles(resolve(ENGINE_ROOT, 'alembic')),
    ...['alembic.ini', 'pyproject.toml', 'poetry.lock', '.python-version'].map(file => resolve(ENGINE_ROOT, file)),
  ].sort();
  const tree = createHash('sha256');
  const normalizedTree = createHash('sha256');
  for (const file of engineFiles) {
    const name = relative(ENGINE_ROOT, file).replaceAll('\\', '/');
    const bytes = await readFile(file);
    tree.update(name).update('\0').update(bytes).update('\0');
    normalizedTree.update(name).update('\0').update(bytes.toString('utf8').replace(/\r\n?/g, '\n')).update('\0');
  }
  values['engine:python-source-tree'] = tree.digest('hex');
  values['engine:python-source-tree-normalized-lf'] = normalizedTree.digest('hex');
  const motiveContract = resolve(ROOT, 'server/research-memory/contracts/motive-writeback-local-017.json');
  const engineContract = resolve(ENGINE_ROOT, 'contracts/motive-writeback-local-017.json');
  const expectedContract = '890d29b73511b2a3922ed1fd165c9cc4f1779d205118403406551420bf027aa4';
  values['motive:writeback-contract-bytes'] = await hashFile(motiveContract);
  values['engine:writeback-contract-bytes'] = await hashFile(engineContract);
  if (values['motive:writeback-contract-bytes'] !== expectedContract
      || values['engine:writeback-contract-bytes'] !== expectedContract) {
    throw new Error('The Motive and Hypothesis Engine pinned writeback contract bytes do not match.');
  }
  const contract = JSON.parse(await readFile(engineContract, 'utf8')) as {
    implementation_files_sha256?: Record<string, unknown>;
    implementation_hash_encoding?: unknown;
    implementation_sha256?: unknown;
  };
  if (contract.implementation_hash_encoding !== 'UTF-8 source text with normalized LF line endings'
      || typeof contract.implementation_sha256 !== 'string' || !contract.implementation_files_sha256) {
    throw new Error('The Hypothesis Engine implementation digest contract is invalid.');
  }
  for (const [name, expected] of Object.entries(contract.implementation_files_sha256)) {
    if (typeof expected !== 'string') throw new Error('The Hypothesis Engine implementation digest map is invalid.');
    const normalized = (await readFile(resolve(ENGINE_ROOT, name), 'utf8')).replace(/\r\n?/g, '\n');
    if (createHash('sha256').update(normalized, 'utf8').digest('hex') !== expected) {
      throw new Error('A Hypothesis Engine implementation file does not match the pinned normalized digest.');
    }
  }
  values['engine:pinned-implementation-normalized-lf'] = contract.implementation_sha256;
  return values;
}

async function verifyViteBytes(child: MarkedChild): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.observed.result) throw new Error('Vite closed during startup.');
    if (child.marker()) {
      try {
        for (const file of ['agents/SKILL.md', 'agents/circle-packing.json']) {
          const response = await fetch(`${BYO_ORIGINS.app}/${file}`, { signal: AbortSignal.timeout(1_000) });
          if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(await readFile(resolve(ROOT, 'public', file)))) {
            throw new Error();
          }
        }
        return;
      } catch { /* bounded exact-byte readiness */ }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error('Vite did not serve the exact local guide and manifest bytes.');
}

async function traceCounts(paths: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    let content = '';
    try { content = await readFile(path, 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as { service?: unknown; phase?: unknown };
        const key = `${String(entry.service)}:${String(entry.phase)}`;
        counts[key] = (counts[key] ?? 0) + 1;
      } catch { /* retain raw safe trace for diagnosis */ }
    }
  }
  return counts;
}

export async function main(): Promise<void> {
  const source = process.env.MOTIVE_TEST_DATABASE_URL ?? process.env.MOTIVE_DATABASE_URL;
  if (!source) throw new Error('A Motive test or application URL is required as a loopback PostgreSQL bootstrap connection.');
  const names = createByoDatabaseNames();
  const urls = deriveByoDatabaseUrls(source, names);
  const workDirectory = resolve(ROOT, '.local', names.motive);
  const privateFile = resolve(workDirectory, 'private.json');
  const contributorFile = resolve(workDirectory, 'contributor-private.json');
  const statusFile = resolve(workDirectory, 'status.json');
  const stopFile = resolve(workDirectory, 'STOP');
  const readyFile = resolve(workDirectory, 'READY');
  const motiveTrace = resolve(workDirectory, 'motive-requests.jsonl');
  const engineTrace = resolve(workDirectory, 'engine-requests.jsonl');
  const admin = new Pool({ connectionString: urls.adminUrl.href, max: 1,
    connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
  const vaultKey = randomBytes(32);
  const tokenSecret = randomBytes(48).toString('base64url');
  const masterKey = randomBytes(48).toString('base64url');
  let motivePool: Pool | null = null;
  let engine: ObservedChild | null = null;
  let motive: ObservedChild | null = null;
  let vite: ObservedChild | null = null;
  let proxy: Server | null = null;
  const created: Array<{ name: string; kind: 'motive' | 'engine' }> = [];
  const cleanupFailures: unknown[] = [];
  let runFailure: unknown;
  let safeStatus: Record<string, unknown> = { format: 'motive.byo-engine-rehearsal-status/0.1', state: 'starting' };
  let stopReason = 'startup-failure';
  let signalRequested = false;
  const requestStop = () => { signalRequested = true; stopReason = 'signal'; };
  const continueStartup = () => {
    if (signalRequested) throw new Error('BYO rehearsal startup was interrupted.');
  };
  process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);

  try {
    await mkdir(resolve(ROOT, '.local'), { recursive: true });
    await mkdir(workDirectory);
    await writeFile(statusFile, `${JSON.stringify(safeStatus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    for (const item of [{ name: names.motive, kind: 'motive' as const }, { name: names.engine, kind: 'engine' as const }]) {
      validateByoDatabaseName(item.name, item.kind);
      await admin.query(`CREATE DATABASE "${item.name}"`);
      created.push(item);
    }
    continueStartup();

    motivePool = new Pool({ connectionString: urls.motiveUrl.href, max: 4,
      connectionTimeoutMillis: 3_000, query_timeout: 15_000 });
    await applyPostgresMigrations(motivePool);
    continueStartup();

    const baseChildEnvironment = operatingSystemEnvironment(process.env);
    const python = (await captureOneShot('poetry', ['env', 'info', '--executable'], ENGINE_ROOT, baseChildEnvironment)).split(/\r?\n/).at(-1) ?? '';
    if (!isAbsolute(python) || !/^python(?:\.exe)?$/i.test(resolve(python).split(/[\\/]/).at(-1) ?? '')
        || !(await stat(python)).isFile()) throw new Error('A valid existing Hypothesis Engine Poetry Python runtime was not found.');
    const engineEnv: NodeJS.ProcessEnv = {
      ...baseChildEnvironment,
      DATABASE_URL: urls.engineAsyncUrl,
      ALEMBIC_DATABASE_URL: urls.engineAsyncUrl,
      API_MASTER_KEY: masterKey,
      PROJECT_NAME: 'HypothesisEngine API',
      API_V1_STR: '/api/v1',
      APP_VERSION: '1.8.0',
      ENVIRONMENT: 'development',
      CORS_ORIGINS: JSON.stringify([BYO_ORIGINS.app]),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
      NO_COLOR: '1',
    };
    await runOneShot(python, ['-m', 'alembic', 'upgrade', 'head'], ENGINE_ROOT, engineEnv,
      'Hypothesis Engine Alembic migration', 120_000);
    continueStartup();
    const engineChild = spawnMarked(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1',
      '--port', '4338', '--no-access-log'], { cwd: ENGINE_ROOT, env: engineEnv },
    output => output.includes('Uvicorn running on http://127.0.0.1:4338'));
    engine = engineChild.observed;
    await waitForService(engineChild, `${BYO_ORIGINS.engineRuntime}/api/v1/health`, 'Hypothesis Engine');
    continueStartup();
    proxy = engineTraceProxy(engineTrace, readyFile);
    await listen(proxy, 4337);
    const engineHealth = await jsonRequest(`${BYO_ORIGINS.engineApi}/health`, {}, 200);
    if (engineHealth.status !== 'ok' || engineHealth.database !== 'ok') {
      throw new Error('The proxied Hypothesis Engine health response was not ready.');
    }
    const engineProvision = await provisionEngine();
    continueStartup();

    const seed = await seedByoRehearsalDatabase(motivePool, {
      projectSlug: 'circle-packing', issuerActorId: 'operator:seed', tokenSecret,
    });
    continueStartup();
    const motiveEnv: NodeJS.ProcessEnv = {
      ...baseChildEnvironment,
      NODE_ENV: 'test', VERCEL: '',
      MOTIVE_DATABASE_URL: urls.motiveUrl.href,
      MOTIVE_DATA_DIR: workDirectory,
      MOTIVE_APP_ORIGIN: BYO_ORIGINS.app,
      MOTIVE_API_HOST: '127.0.0.1', MOTIVE_API_PORT: '4336',
      MOTIVE_ACCOUNT_PROVIDER: 'local-better-auth',
      MOTIVE_HYPOTHESIS_CONTEXT_TRANSPORT: 'channel-context-v1',
      MOTIVE_FUNDING_VAULT_KEY: vaultKey.toString('base64url'),
      BETTER_AUTH_SECRET: tokenSecret,
      MOTIVE_REHEARSAL_MOTIVE_TRACE_FILE: motiveTrace,
      MOTIVE_REHEARSAL_READY_FILE: readyFile,
      TRIGGER_SECRET_KEY: '', TRIGGER_PROJECT_REF: '', MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '',
      MOTIVE_GATEWAY_PROFILES_FILE: '', MOTIVE_VERCEL_TOKEN: '', MOTIVE_VERCEL_TEAM_ID: '', MOTIVE_VERCEL_PROJECT_ID: '',
      OPENROUTER_API_KEY: '',
      NO_COLOR: '1',
      SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_STORAGE_BUCKET: '', MOTIVE_AGENT_TOKEN_SECRET: '',
    };
    const motiveChild = spawnMarked(process.execPath, ['--import', 'tsx', '--import',
      './scripts/rehearsal-request-trace-preload.ts', 'server/index.ts'], { cwd: ROOT, env: motiveEnv },
    output => output.split(/\r?\n/).includes(MOTIVE_LISTEN));
    motive = motiveChild.observed;
    await waitForService(motiveChild, `${BYO_ORIGINS.motiveApi}/api/health`, 'Motive API');
    continueStartup();

    const enrollment = await enrollByoRehearsal(motivePool, {
      motiveApiOrigin: BYO_ORIGINS.motiveApi,
      appOrigin: BYO_ORIGINS.app,
      seed,
      engine: engineProvision,
      vaultKey,
    });
    continueStartup();
    const viteChild = spawnMarked(process.execPath, ['node_modules/vite/bin/vite.js', '--config',
      'scripts/rehearsal-byo-vite.config.ts', '--host', '127.0.0.1', '--port', '4335', '--strictPort'],
    { cwd: ROOT, env: { ...motiveEnv, MOTIVE_API_PORT: '4336' } },
    output => output.includes('http://127.0.0.1:4335/'));
    vite = viteChild.observed;
    await verifyViteBytes(viteChild);
    continueStartup();

    const privateValue = enrollment.private;
    const contributorBearer = privateValue.contributorBearer;
    const contributorHandoff = createContributorHandoff(contributorBearer);
    await writeFile(privateFile, `${JSON.stringify({
      format: 'motive.byo-engine-rehearsal-private/0.1', generated: true,
      engine: { apiKey: engineProvision.apiKey, masterKey },
      accounts: { owner: privateValue.owner, reviewer: privateValue.reviewer },
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const startedAt = new Date();
    const digests = await sourceDigests();
    continueStartup();
    safeStatus = {
      format: 'motive.byo-engine-rehearsal-status/0.1', state: 'ready',
      startedAt: startedAt.toISOString(), expiresAt: new Date(startedAt.getTime() + MAX_REHEARSAL_MS).toISOString(),
      origins: { app: BYO_ORIGINS.app, motiveApi: BYO_ORIGINS.motiveApi, engineApi: BYO_ORIGINS.engineApi },
      sourceIds: { engineWorkspaceId: engineProvision.workspaceId, engineChannelId: engineProvision.channelId,
        seed: { projectSlug: seed.projectSlug, projectId: seed.projectId, projectRevision: seed.projectRevision,
          workOrderId: seed.workOrderId, workOrderRevision: seed.workOrderRevision,
          workOrderTermsDigest: seed.workOrderTermsDigest },
        enrollment: enrollment.safe },
      fixtureDisclosure: { generatedLocalAccounts: true, generatedEngineWorkspace: true,
        engineChannelInitiallyEmpty: true, researchTasksSeeded: false, researchResultsSeeded: false,
        reviewerDecisionsSeeded: false, actualMotiveAndHypothesisServices: true },
      control: { stopFile: relative(ROOT, stopFile).replaceAll('\\', '/') },
      traces: { motive: relative(ROOT, motiveTrace).replaceAll('\\', '/'),
        engine: relative(ROOT, engineTrace).replaceAll('\\', '/') },
      sourceDigests: digests,
    };
    await writeFile(statusFile, `${JSON.stringify(safeStatus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(readyFile, `${startedAt.toISOString()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await writeFile(contributorFile, `${JSON.stringify(contributorHandoff, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    process.stdout.write(`BYO rehearsal ready at ${BYO_ORIGINS.app}.\n`);
    process.stdout.write(`Contributor handoff: ${relative(ROOT, contributorFile)}\n`);
    process.stdout.write(`Create ${relative(ROOT, stopFile)} to stop; automatic cleanup runs after 30 minutes.\n`);
    const deadline = Date.now() + MAX_REHEARSAL_MS;
    while (Date.now() < deadline && !signalRequested && !existsSync(stopFile)) {
      if (engine.result || motive.result || vite.result) throw new Error('A supervised local service closed during rehearsal.');
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    stopReason = signalRequested ? 'signal' : existsSync(stopFile) ? 'stop-file' : 'timeout';
  } catch (error) {
    runFailure = error;
  } finally {
    process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop);
    let processesClosed = true;
    for (const [child, label] of [[vite, 'Vite'], [motive, 'Motive API']] as const) {
      if (!child) continue;
      try { await terminateChild(child, label); } catch (error) { processesClosed = false; cleanupFailures.push(error); }
    }
    if (proxy) {
      try { await closeServer(proxy); } catch (error) { processesClosed = false; cleanupFailures.push(error); }
    }
    if (engine) {
      try { await terminateChild(engine, 'Hypothesis Engine'); }
      catch (error) { processesClosed = false; cleanupFailures.push(error); }
    }
    if (motivePool) {
      try { await motivePool.end(); } catch (error) { cleanupFailures.push(error); }
    }
    if (processesClosed) {
      for (const item of [...created].reverse()) {
        try {
          validateByoDatabaseName(item.name, item.kind);
          await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [item.name]);
          await admin.query(`DROP DATABASE "${item.name}"`);
          if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [item.name])).rowCount !== 0) {
            throw new Error(`The ${item.kind} BYO rehearsal database still exists after cleanup.`);
          }
        } catch (error) { cleanupFailures.push(error); }
      }
    } else if (created.length) {
      cleanupFailures.push(new Error('Database cleanup was withheld because a supervised process did not fully close.'));
    }
    try { await admin.end(); } catch (error) { cleanupFailures.push(error); }
    for (const file of [contributorFile, privateFile, readyFile]) {
      try { await rm(file, { force: true }); } catch (error) { cleanupFailures.push(error); }
    }
    safeStatus = { ...safeStatus, state: runFailure || cleanupFailures.length ? 'failed' : 'stopped',
      stoppedAt: new Date().toISOString(), stopReason,
      traceCounts: await traceCounts([motiveTrace, engineTrace]),
      privateCredentialsDeleted: !existsSync(privateFile) && !existsSync(contributorFile) };
    try { await writeFile(statusFile, `${JSON.stringify(safeStatus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
    catch (error) { cleanupFailures.push(error); }
  }

  if (runFailure || cleanupFailures.length) {
    const failures = [...(runFailure ? [runFailure] : []), ...cleanupFailures];
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'BYO rehearsal or cleanup failed.');
  }
}

const directlyInvoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directlyInvoked) await main();
