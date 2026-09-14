import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations } from '../packages/accounting/src/migrations.ts';
import { digestCanonicalJson } from '../packages/domain/src/contracts.ts';
import { CIRCLE_EVALUATOR_PROFILE_DIGEST } from '../packages/evaluator-circle/src/index.ts';
import { profileDigest, validateAndFreezeProfile } from '../packages/inference-gateway/src/profile.ts';
import { prepareCircleFundedWork } from './prepare-circle-funded-work.ts';
import { circlePackingProfile, getProject } from '../src/lib/projects.ts';
import { OPENROUTER_GATEWAY_CREDENTIAL_REF } from '../server/funding/service.ts';

const baseUrl = process.env.MOTIVE_DATABASE_URL;
if (!baseUrl) throw new Error('MOTIVE_DATABASE_URL is required for the funded-attempt browser rehearsal.');
const parsedBase = new URL(baseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsedBase.hostname) || parsedBase.port !== '55439') {
  throw new Error('The funded-attempt rehearsal requires the local PostgreSQL test server on port 55439.');
}

const databaseName = `motive_ui_${randomUUID().replaceAll('-', '')}`;
if (!/^motive_ui_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Invalid rehearsal database name.');
const databaseUrl = new URL(baseUrl); databaseUrl.pathname = `/${databaseName}`;
const adminUrl = new URL(baseUrl); adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
const dataDirectory = resolve('.local', databaseName);
if (!dataDirectory.startsWith(`${resolve('.local')}\\`)) throw new Error('Invalid rehearsal data directory.');
const profilePath = resolve(dataDirectory, 'gateway-profiles.json');
const objectFixturePath = resolve(dataDirectory, 'empty-objects.json');

const profile = validateAndFreezeProfile({
  format: 'motive.gateway-profile/0.1', profileId: 'circle-astra-funded-browser-20260907', status: 'reviewed-live',
  upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: OPENROUTER_GATEWAY_CREDENTIAL_REF },
  route: { model: 'openai/gpt-6-astra', provider: { order: ['OpenAI'], allowFallbacks: false, requireParameters: true } },
  limits: { maxRequestBytes: 262144, maxResponseBytes: 1048576, maxEventBytes: 262144,
    requestTimeoutMs: 5000, maxInputItems: 32, maxTools: 4, contextWindowTokens: 100, maxOutputTokens: 10 },
  requestPolicy: { allowedLocalTools: [], allowedReasoningEfforts: ['low'], allowParallelToolCalls: false,
    allowTemperature: false, allowTopP: false, codexClientMetadata: 'reject' },
  pricing: { currency: 'USD', highestInputUsdPerMillionTokens: '5', highestOutputUsdPerMillionTokens: '25',
    fixedRequestUsd: '0', worstCaseAdditionalUsd: '0', approvedMaximumExposureUsd: '0.001' },
  evidence: { kind: 'gate-a-reviewed', reviewedAt: '2026-09-07', reviewedBy: 'motive-isolated-browser-rehearsal',
    pricingSource: 'https://openrouter.ai/api/v1/models',
    responsesCompatibilitySource: 'https://openrouter.ai/docs/api-reference/responses/overview' },
});
const reviewedProfileDigest = profileDigest(profile);
const expectedProjectDigest = 'sha256:c1fceddadef50b71b873f04bf666e2f91c6ff598dceb5dd3dc081b2e3e710246';

await mkdir(dataDirectory, { recursive: true });
await writeFile(profilePath, JSON.stringify([profile]), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
await writeFile(objectFixturePath, '{}', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
let api: ReturnType<typeof spawn> | null = null;
let pool: Pool | null = null;
let created = false;
try {
  try {
    const occupied = await fetch('http://127.0.0.1:4319/api/health');
    if (occupied) throw new Error('Port 4319 already has an HTTP service; stop the other rehearsal first.');
  } catch (error) {
    if (error instanceof Error && error.message.includes('already has an HTTP service')) throw error;
  }

  await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  console.log(JSON.stringify({ rehearsal: 'funded-attempt', database: databaseName, isolated: true }));
  pool = new Pool({ connectionString: databaseUrl.href, max: 4 });
  await applyPostgresMigrations(pool);

  const project = getProject('circle-packing');
  if (!project) throw new Error('The shared circle-packing project profile is missing.');
  const content = {
    title: project.title, purpose: project.goal, next_step: project.next, stage: 'preparation',
    description: project.description, story: project.story, beneficiaries: project.beneficiaries,
    scope: project.scope, acceptance: project.acceptance, output: project.output, challenge: circlePackingProfile,
    spending_authorized: false, execution_authorized: false,
  };
  if (digestCanonicalJson(content) !== expectedProjectDigest) throw new Error('The shared circle project no longer matches reviewed revision 2.');
  const projectId = randomUUID();
  await pool.query("INSERT INTO motive.projects(id,slug,visibility,current_revision,created_by) VALUES($1,'circle-packing','PUBLIC',2,'operator:seed')", [projectId]);
  await pool.query(`INSERT INTO motive.project_revisions(id,project_id,revision,format,content,content_digest,created_by)
    VALUES($1,$2,2,'motive.project/0.1',$3,$4,'operator:seed')`, [randomUUID(), projectId, content, expectedProjectDigest]);
  await pool.query("INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES($1,$2,'operator:seed','OWNER',ARRAY['*'],'operator:seed')",
    [randomUUID(), projectId]);
  const prepared = await prepareCircleFundedWork(pool, [profile], {
    actorId: 'operator:seed', idempotencyKey: 'funded-browser-work-v1', profileDigest: reviewedProfileDigest,
    ceilingUsd: '0.01', maxRuntimeSeconds: 120, agreementId: 'agreement:funded-browser-circle-v1',
    evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST, inputCommit: 'b'.repeat(40), projectRevision: 2,
  });
  await new LedgerKernel(pool).setControllerSpending({ actorId: 'operator:funded-browser-rehearsal',
    idempotencyKey: 'funded-browser-controller-open', enabled: true,
    reason: 'Disposable browser rehearsal; provider inference is blocked by the preload.' });

  const childEnv = {
    ...process.env,
    MOTIVE_DATABASE_URL: databaseUrl.href,
    MOTIVE_DATA_DIR: dataDirectory,
    MOTIVE_API_PORT: '4319',
    MOTIVE_FUNDING_VAULT_KEY: randomBytes(32).toString('base64url'),
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    MOTIVE_GATEWAY_PROFILES_FILE: profilePath,
    MOTIVE_REHEARSAL_API_URL: 'http://127.0.0.1:4319',
    MOTIVE_FUNDED_ATTEMPT_REHEARSAL: '1',
    MOTIVE_REHEARSAL_PROFILE_DIGEST: reviewedProfileDigest,
    MOTIVE_REHEARSAL_WORK_ORDER_ID: prepared.workOrderId,
    TRIGGER_SECRET_KEY: '',
    TRIGGER_PROJECT_REF: '',
    MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '',
    MOTIVE_VERCEL_TOKEN: '',
    SUPABASE_URL: 'http://127.0.0.1:4320',
    SUPABASE_SERVICE_ROLE_KEY: 'rehearsal-service-role-key',
    SUPABASE_STORAGE_BUCKET: 'rehearsal-artifacts',
    MOTIVE_REHEARSAL_OBJECTS_FILE: objectFixturePath,
  };
  api = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/rehearsal-openrouter-provider.ts', 'server/index.ts'], {
    env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiOutput = '';
  api.stdout?.on('data', chunk => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-4000); });
  api.stderr?.on('data', chunk => { apiOutput = `${apiOutput}${String(chunk)}`.slice(-4000); });
  let ready = false;
  for (let index = 0; index < 80; index += 1) {
    if (api.exitCode !== null) throw new Error(`Isolated API exited: ${apiOutput}`);
    try { if ((await fetch('http://127.0.0.1:4319/api/health')).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Isolated API did not become ready: ${apiOutput}`);

  const test = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/e2e/funded-attempt.spec.ts'], {
    env: childEnv, windowsHide: true, stdio: 'inherit',
  });
  const code = await new Promise<number>(resolveExit => {
    test.on('exit', value => resolveExit(value ?? 1)); test.on('error', () => resolveExit(1));
  });
  if (code !== 0) process.stderr.write(`Isolated API diagnostics:\n${apiOutput}\n`);
  process.exitCode = code;
} finally {
  if (api && api.exitCode === null) {
    api.kill();
    await new Promise<void>(resolveExit => { api!.once('exit', () => resolveExit()); setTimeout(resolveExit, 3000); });
  }
  await pool?.end();
  if (created) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
    await admin.query(`DROP DATABASE "${databaseName}"`);
    console.log(JSON.stringify({ rehearsal: 'funded-attempt', database: databaseName, dropped: true }));
  }
  await admin.end();
  await rm(dataDirectory, { recursive: true, force: true });
}
