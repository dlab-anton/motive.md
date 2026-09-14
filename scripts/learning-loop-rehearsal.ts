import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { applyPostgresMigrations } from '../packages/accounting/src/migrations.ts';

const bootstrapSource = process.env.MOTIVE_TEST_DATABASE_URL;
if (!bootstrapSource) {
  throw new Error('Set MOTIVE_TEST_DATABASE_URL to a loopback PostgreSQL connection used only to bootstrap the rehearsal.');
}

let bootstrapUrl: URL;
try {
  bootstrapUrl = new URL(bootstrapSource);
} catch {
  throw new Error('MOTIVE_TEST_DATABASE_URL must be a valid loopback PostgreSQL URL.');
}
if (!['postgres:', 'postgresql:'].includes(bootstrapUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(bootstrapUrl.hostname)) {
  throw new Error('This rehearsal requires a loopback PostgreSQL bootstrap connection.');
}
if (bootstrapUrl.search || bootstrapUrl.hash) {
  throw new Error('The loopback PostgreSQL bootstrap URL must not contain query parameters or a fragment.');
}

const databaseName = `motive_learning_loop_${randomUUID().replaceAll('-', '')}`;
if (!/^motive_learning_loop_[a-f0-9]{32}$/.test(databaseName)) {
  throw new Error('Invalid rehearsal database name.');
}

const adminUrl = new URL(bootstrapUrl);
adminUrl.pathname = '/postgres';
const rehearsalUrl = new URL(bootstrapUrl);
rehearsalUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
const output = resolve(process.env.MOTIVE_LOOP_EVIDENCE_PATH
  ?? 'fixtures/compatibility/evidence/learning-loop-local.json');
const pendingOutput = `${output}.${randomUUID().replaceAll('-', '')}.pending`;
let setupPool: Pool | null = null;
let created = false;
let evidence: Record<string, unknown> | null = null;
let runFailure: unknown;
const cleanupFailures: unknown[] = [];

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  setupPool = new Pool({ connectionString: rehearsalUrl.href, max: 2 });
  await applyPostgresMigrations(setupPool);
  await setupPool.end();
  setupPool = null;

  const childResult = await new Promise<{ status: number | null; spawnError?: Error }>(done => {
    let spawnError: Error | undefined;
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
      'tests/backend/evaluator-coordinator.postgres.test.ts', '--no-file-parallelism'], {
      env: { ...process.env, MOTIVE_TEST_DATABASE_URL: rehearsalUrl.href, MOTIVE_LOOP_EVIDENCE_PATH: pendingOutput },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', error => { spawnError = error; });
    // `close` fires after the process exits and its stdio streams have closed.
    child.once('close', status => { done({ status, spawnError }); });
  });
  if (childResult.spawnError) throw childResult.spawnError;
  if (childResult.status !== 0) {
    throw new Error(`Local rehearsal failed (${childResult.status}); its output is not passing evidence.`);
  }

  evidence = JSON.parse(await readFile(pendingOutput, 'utf8')) as Record<string, unknown>;
  evidence.sourceDigests = Object.fromEntries(await Promise.all([
    'packages/orchestration/src/evaluator-coordinator.ts', 'packages/orchestration/src/evaluator-reports.ts',
    'packages/orchestration/src/learning-coordinator.ts', 'packages/orchestration/src/store.ts',
    'migrations/014_durable_evaluator_report_claims.sql', 'profiles/research-agent.md',
    'tests/backend/evaluator-coordinator.postgres.test.ts', 'scripts/learning-loop-rehearsal.ts',
  ].map(async path => [path, `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`])));
} catch (error) {
  runFailure = error;
} finally {
  if (setupPool) {
    try { await setupPool.end(); } catch (error) { cleanupFailures.push(error); }
  }
  if (created) {
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE "${databaseName}"`);
      const remaining = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
      if (remaining.rowCount !== 0) throw new Error('The isolated rehearsal database still exists after cleanup.');
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try { await admin.end(); } catch (error) { cleanupFailures.push(error); }
  try { await rm(pendingOutput, { force: true }); } catch (error) { cleanupFailures.push(error); }
}

if (runFailure || cleanupFailures.length > 0) {
  const failures = [...(runFailure ? [runFailure] : []), ...cleanupFailures];
  throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Learning-loop rehearsal or cleanup failed.');
}
if (!evidence) throw new Error('The successful rehearsal did not produce evidence.');

evidence.status = 'passed';
await writeFile(output, JSON.stringify(evidence, null, 2));
console.log(`Local Propose/Test/Update evidence: ${output}`);
