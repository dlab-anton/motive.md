import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { applyPostgresMigrations } from '../packages/accounting/src/migrations.ts';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { circlePackingProfile, getProject } from '../src/lib/projects.ts';
import { seedRehearsalHostedCircleResult } from './rehearsal-hosted-circle-result.ts';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REHEARSAL_DATABASE = /^motive_ui_[a-f0-9]{32}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const API_ORIGIN = 'http://127.0.0.1:4319';
const APP_ORIGIN = 'http://127.0.0.1:4317';
const API_LISTEN_LINE = 'motive.md application service listening on 127.0.0.1:4319';

export function validateParticipationRehearsalDatabaseName(databaseName: string): string {
  if (!REHEARSAL_DATABASE.test(databaseName)) {
    throw new Error('Invalid participation rehearsal database name.');
  }
  return databaseName;
}

export function createParticipationRehearsalDatabaseName(id: string = randomUUID()): string {
  if (!CANONICAL_UUID.test(id)) throw new Error('Invalid rehearsal database UUID.');
  return validateParticipationRehearsalDatabaseName(`motive_ui_${id.replaceAll('-', '')}`);
}

export function participationRehearsalUrls(source: string, databaseName: string): {
  adminUrl: URL;
  rehearsalUrl: URL;
} {
  let bootstrapUrl: URL;
  try {
    bootstrapUrl = new URL(source);
  } catch {
    throw new Error('MOTIVE_DATABASE_URL must be a valid loopback PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(bootstrapUrl.protocol)
    || !LOOPBACK_HOSTS.has(bootstrapUrl.hostname)) {
    throw new Error('The participation rehearsal requires a loopback PostgreSQL bootstrap connection.');
  }
  if (bootstrapUrl.search || bootstrapUrl.hash || source.includes('?') || source.includes('#')) {
    throw new Error('The loopback PostgreSQL bootstrap URL must not contain query parameters or a fragment.');
  }

  validateParticipationRehearsalDatabaseName(databaseName);
  const adminUrl = new URL(bootstrapUrl);
  adminUrl.pathname = '/postgres';
  const rehearsalUrl = new URL(bootstrapUrl);
  rehearsalUrl.pathname = `/${databaseName}`;
  return { adminUrl, rehearsalUrl };
}

export function hasParticipationRehearsalListenLine(output: string): boolean {
  return output.split(/\r?\n/).some(line => line === API_LISTEN_LINE);
}

export function participationRehearsalChildEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  rehearsalUrl: string;
  dataDirectory: string;
  objectFixturePath: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.parent,
    NODE_ENV: 'test',
    VERCEL: '',
    MOTIVE_DATABASE_URL: input.rehearsalUrl,
    MOTIVE_DATA_DIR: input.dataDirectory,
    MOTIVE_APP_ORIGIN: APP_ORIGIN,
    MOTIVE_API_HOST: '127.0.0.1',
    MOTIVE_API_PORT: '4319',
    MOTIVE_ACCOUNT_PROVIDER: 'local-better-auth',
    MOTIVE_HYPOTHESIS_CONTEXT_TRANSPORT: 'legacy',
    MOTIVE_FUNDING_VAULT_KEY: randomBytes(32).toString('base64url'),
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    MOTIVE_REHEARSAL_API_URL: API_ORIGIN,
    TRIGGER_SECRET_KEY: '',
    TRIGGER_PROJECT_REF: '',
    MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '',
    MOTIVE_VERCEL_TOKEN: '',
    SUPABASE_URL: 'http://127.0.0.1:4320',
    SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SECRET_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: 'rehearsal-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'rehearsal-artifacts',
    MOTIVE_AGENT_TOKEN_SECRET: '',
    MOTIVE_REHEARSAL_OBJECTS_FILE: input.objectFixturePath,
  };
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

export interface ObservedChild {
  child: ChildProcess;
  closed: Promise<ChildResult>;
  result: ChildResult | null;
}

export function observeChild(child: ChildProcess): ObservedChild {
  const observed = { child, result: null } as ObservedChild;
  let spawnError: Error | undefined;
  observed.closed = new Promise(resolveClosed => {
    child.once('error', error => { spawnError = error; });
    // `close` follows process termination and closure of the child's stdio streams.
    child.once('close', (code, signal) => {
      const result = { code, signal, spawnError };
      observed.result = result;
      resolveClosed(result);
    });
  });
  return observed;
}

async function closesWithin(observed: ObservedChild, timeoutMs: number): Promise<boolean> {
  if (observed.result) return true;
  return await new Promise(resolveClosed => {
    const timer = setTimeout(() => resolveClosed(false), timeoutMs);
    observed.closed.then(() => {
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
}

async function terminateWindowsChildTree(observed: ObservedChild, label: string): Promise<void> {
  const pid = observed.child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) {
    throw new Error(`${label} has no valid process identifier; database cleanup was withheld.`);
  }
  const helper = observeChild(spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  }));
  if (!await closesWithin(helper, 5_000)) {
    helper.child.kill('SIGKILL');
    await closesWithin(helper, 1_000);
    throw new Error(`${label} process-tree termination helper timed out; database cleanup was withheld.`);
  }
  if (helper.result?.spawnError || helper.result?.code !== 0) {
    throw new Error(`${label} process-tree termination failed; database cleanup was withheld.`);
  }
  if (!await closesWithin(observed, 5_000)) {
    throw new Error(`${label} did not close after process-tree termination; database cleanup was withheld.`);
  }
}

export async function terminateChild(observed: ObservedChild, label: string): Promise<void> {
  if (observed.result) return;
  if (await closesWithin(observed, 100)) return;
  if (process.platform === 'win32') {
    await terminateWindowsChildTree(observed, label);
    return;
  }
  try {
    observed.child.kill('SIGTERM');
  } catch (error) {
    if (!await closesWithin(observed, 100)) throw error;
    return;
  }
  if (await closesWithin(observed, 5_000)) return;
  try {
    observed.child.kill('SIGKILL');
  } catch (error) {
    if (!await closesWithin(observed, 100)) throw error;
    return;
  }
  if (!await closesWithin(observed, 5_000)) {
    throw new Error(`${label} did not close after forced termination; database cleanup was withheld.`);
  }
}

async function waitForChild(observed: ObservedChild, timeoutMs: number, label: string): Promise<ChildResult> {
  if (!await closesWithin(observed, timeoutMs)) {
    await terminateChild(observed, label);
    throw new Error(`${label} exceeded its bounded runtime.`);
  }
  return observed.result!;
}

export async function main(): Promise<void> {
  const sourceUrl = process.env.MOTIVE_DATABASE_URL;
  if (!sourceUrl) {
    throw new Error('MOTIVE_DATABASE_URL is required as a loopback PostgreSQL bootstrap connection.');
  }
  const databaseName = createParticipationRehearsalDatabaseName();
  const { adminUrl, rehearsalUrl } = participationRehearsalUrls(sourceUrl, databaseName);
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  const dataDirectory = resolve('.local', databaseName);
  const objectFixturePath = resolve(dataDirectory, 'hosted-circle-objects.json');

  const childEnv = participationRehearsalChildEnvironment({
    parent: process.env, rehearsalUrl: rehearsalUrl.href, dataDirectory, objectFixturePath,
  });

  let created = false;
  let setupPool: Pool | null = null;
  let api: ObservedChild | null = null;
  let browserTests: ObservedChild | null = null;
  let runFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    await mkdir(dataDirectory, { recursive: true });
    validateParticipationRehearsalDatabaseName(databaseName);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    setupPool = new Pool({ connectionString: rehearsalUrl.href, max: 2 });
    await applyPostgresMigrations(setupPool);
    const project = getProject('circle-packing')!;
    await new LedgerKernel(setupPool).createProject({
      actorId: 'operator:seed',
      idempotencyKey: 'browser-rehearsal-project',
      slug: 'circle-packing',
      visibility: 'PUBLIC',
      revisionContent: {
        title: project.title,
        purpose: project.goal,
        next_step: project.next,
        stage: 'preparation',
        description: project.description,
        story: project.story,
        beneficiaries: project.beneficiaries,
        scope: project.scope,
        acceptance: project.acceptance,
        output: project.output,
        challenge: circlePackingProfile,
        spending_authorized: false,
        execution_authorized: false,
      },
    });
    const hostedObjects = new Map<string, Uint8Array>();
    await seedRehearsalHostedCircleResult(setupPool, hostedObjects);
    await writeFile(objectFixturePath, JSON.stringify(Object.fromEntries(
      [...hostedObjects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]))), {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await setupPool.end();
    setupPool = null;

    // This is a synthetic browser/API rehearsal with local provider and object fixtures. It is
    // neither evidence of a fresh autonomous agent nor an exercise of the real Hypothesis engine.
    api = observeChild(spawn(process.execPath, [
      '--import', 'tsx', '--import', './scripts/rehearsal-openrouter-provider.ts', 'server/index.ts',
    ], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let readinessOutput = '';
    let ownApiListening = false;
    const inspectApiOutput = (chunk: unknown) => {
      if (ownApiListening) return;
      readinessOutput = `${readinessOutput}${String(chunk)}`.slice(-1_024);
      ownApiListening = hasParticipationRehearsalListenLine(readinessOutput);
      if (ownApiListening) readinessOutput = '';
    };
    api.child.stdout?.on('data', inspectApiOutput);
    api.child.stderr?.on('data', inspectApiOutput);

    let ready = false;
    for (let index = 0; index < 80; index++) {
      if (api.result) {
        throw api.result.spawnError ?? new Error(
          `Isolated API closed during startup (code=${String(api.result.code)}, signal=${String(api.result.signal)}).`,
        );
      }
      if (!ownApiListening) {
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
        continue;
      }
      try {
        if ((await fetch(`${API_ORIGIN}/api/health`, { signal: AbortSignal.timeout(500) })).ok && !api.result) {
          ready = true;
          break;
        }
      } catch { /* bounded startup polling */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    if (!ready) throw new Error('The spawned isolated API did not become ready.');

    browserTests = observeChild(spawn(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test',
      'tests/e2e/participation.spec.ts', 'tests/e2e/hosted-results.spec.ts',
    ], { env: childEnv, windowsHide: true, stdio: 'inherit' }));
    const result = await waitForChild(browserTests, 5 * 60_000, 'Isolated Playwright rehearsal');
    if (result.spawnError) throw result.spawnError;
    if (result.code !== 0) {
      throw new Error(`Isolated Playwright rehearsal failed (${String(result.code)}).`);
    }
  } catch (error) {
    runFailure = error;
  } finally {
    let childrenClosed = true;
    for (const [child, label] of [[browserTests, 'Isolated Playwright rehearsal'], [api, 'Isolated API']] as const) {
      if (!child) continue;
      try {
        await terminateChild(child, label);
      } catch (error) {
        childrenClosed = false;
        cleanupFailures.push(error);
      }
    }
    if (setupPool) {
      try { await setupPool.end(); } catch (error) { cleanupFailures.push(error); }
    }
    if (created && childrenClosed) {
      try {
        validateParticipationRehearsalDatabaseName(databaseName);
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
          [databaseName],
        );
        await admin.query(`DROP DATABASE "${databaseName}"`);
        const remaining = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
        if (remaining.rowCount !== 0) {
          throw new Error('The isolated participation rehearsal database still exists after cleanup.');
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else if (created) {
      cleanupFailures.push(new Error(
        'The isolated participation rehearsal database was not dropped because a child did not fully close.',
      ));
    }
    try { await admin.end(); } catch (error) { cleanupFailures.push(error); }
  }

  if (runFailure || cleanupFailures.length > 0) {
    const failures = [...(runFailure ? [runFailure] : []), ...cleanupFailures];
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Participation rehearsal or cleanup failed.');
  }
}

const isEntrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (isEntrypoint) await main();
