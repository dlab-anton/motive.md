import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment } from '../packages/accounting/src/migrations.ts';
import type { Digest } from '../packages/domain/src/contracts.ts';
import { profileDigest, type GatewayProfile } from '../packages/inference-gateway/src/profile.ts';
import { loadApplicationGatewayProfiles } from '../server/app-profiles.ts';
import { loadAccountConfiguration } from '../server/accounts/config.ts';
import { readCircleFundingReadiness } from '../server/funding/readiness.ts';
import { loadCircleProjectRunConfig, type CircleProjectRunConfig } from '../server/project-runs/config.ts';
import type { FundedRunReadinessResponse } from '../src/lib/funding.ts';
import { resolveOperatorAccount } from './lib/operator-account.ts';
import { resolveTriggerRuntimeAsset } from './lib/trigger-runtime-assets.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT = 'circle-packing';

type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type Queryable = Pick<Pool, 'query'>;

export type CircleDiscoveryReadinessReport = Readonly<{
  format: 'motive.circle-discovery-readiness/0.1';
  checkedAt: string;
  project: typeof PROJECT;
  account: 'SELECTION_REQUIRED' | 'ACTIVE' | 'INACTIVE';
  schema: 'EXACT' | 'MISMATCH';
  researchScope: 'CONNECTED' | 'REQUIRED';
  funding: FundedRunReadinessResponse | null;
  processConfiguration: Readonly<{
    projectRun: readonly string[];
    trigger: 'CONFIGURED' | 'REQUIRED';
    acceptedRuntimeAsset: 'VALID' | 'REQUIRED' | 'INVALID';
    runtimeProfile: 'MATCHED' | 'REQUIRED' | 'MISMATCH';
    infrastructureRecord: 'ACTIVE' | 'REQUIRED';
  }>;
  knownBlockers: readonly string[];
  externalVerification: readonly string[];
  configurationChecksPassed: boolean;
}>;

type Dependencies = Readonly<{
  schemaStatus(pool: Queryable): Promise<{ exact: boolean }>;
  loadProfiles(): readonly GatewayProfile[];
  loadRunConfig(env: EnvironmentSource): CircleProjectRunConfig;
  funding(pool: Queryable, actorId: string, profiles: readonly GatewayProfile[]): Promise<FundedRunReadinessResponse>;
  account(pool: Queryable, accountId: string, env: EnvironmentSource): Promise<boolean>;
  researchScope(pool: Queryable): Promise<boolean>;
  runtimeAsset(env: EnvironmentSource, root: string): void;
  infrastructure(pool: Queryable, id: string, maximumCostUsd: string): Promise<boolean>;
}>;

const defaults: Dependencies = {
  schemaStatus: pool => getPostgresSchemaStatus(pool as Pool),
  loadProfiles: () => loadApplicationGatewayProfiles(),
  loadRunConfig: env => loadCircleProjectRunConfig(env),
  funding: (pool, actorId, profiles) => readCircleFundingReadiness(pool as Pool, actorId, profiles),
  async account(pool, accountId, env) {
    try {
      await resolveOperatorAccount({ selector: { accountId }, pool: pool as Pool,
        env, configuration: loadAccountConfiguration(env) });
      return true;
    } catch { return false; }
  },
  async researchScope(pool) {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM motive.project_research_scopes scope
         JOIN motive.projects project ON project.id=scope.project_id
         WHERE project.slug=$1 AND project.visibility='PUBLIC' AND scope.status='CONNECTED'
       ) AS connected`, [PROJECT]);
    return result.rows[0]?.connected === true;
  },
  runtimeAsset(env, root) { resolveTriggerRuntimeAsset(env, root); },
  async infrastructure(pool, id, maximumCostUsd) {
    const result = await pool.query(
      `SELECT status='ACTIVE' AND expires_at>clock_timestamp()
          AND limit_usd >= $2::numeric AS active
       FROM motive.infrastructure_authorizations WHERE id=$1`, [id, maximumCostUsd]);
    return result.rowCount === 1 && result.rows[0]?.active === true;
  },
};

export function parseCircleDiscoveryReadinessArguments(args: readonly string[]): { accountId?: string } {
  if (args.length === 0) return {};
  const accountId = args[1];
  if (args.length !== 2 || args[0] !== '--account-id' || accountId === undefined || !UUID.test(accountId)) {
    throw new Error('Usage: npm run project:discovery-readiness -- [--account-id <Supabase user UUID>]');
  }
  return { accountId };
}

function triggerConfigured(env: EnvironmentSource): boolean {
  return Boolean(env.TRIGGER_SECRET_KEY?.trim() && env.TRIGGER_PROJECT_REF?.trim().startsWith('proj_'));
}

function runtimeFields(config: CircleProjectRunConfig): { profileDigest: Digest; authorizationId: string; maximumCostUsd: string } | null {
  const runtime = config.runtimeBundle?.runtime as unknown as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime.inferenceProfileDigest !== 'string'
      || typeof runtime.infrastructureAuthorizationId !== 'string'
      || typeof runtime.maximumCostUsd !== 'string') return null;
  return { profileDigest: runtime.inferenceProfileDigest as Digest,
    authorizationId: runtime.infrastructureAuthorizationId, maximumCostUsd: runtime.maximumCostUsd };
}

export async function inspectCircleDiscoveryReadiness(input: {
  pool: Queryable;
  accountId?: string;
  env?: EnvironmentSource;
  projectRoot?: string;
  now?: () => Date;
  dependencies?: Partial<Dependencies>;
}): Promise<CircleDiscoveryReadinessReport> {
  const env = input.env ?? process.env;
  const dependencies = { ...defaults, ...input.dependencies };
  const knownBlockers = new Set<string>();

  const schema = await dependencies.schemaStatus(input.pool);
  if (!schema.exact) knownBlockers.add('DATABASE_SCHEMA_MISMATCH');

  let profiles: readonly GatewayProfile[] = [];
  try { profiles = dependencies.loadProfiles(); }
  catch { knownBlockers.add('GATEWAY_PROFILE_FILE_INVALID'); }

  const runConfig = dependencies.loadRunConfig(env);
  for (const reason of runConfig.readinessReasons) knownBlockers.add(reason);

  const account = input.accountId === undefined
    ? 'SELECTION_REQUIRED'
    : await dependencies.account(input.pool, input.accountId, env) ? 'ACTIVE' : 'INACTIVE';
  if (account === 'SELECTION_REQUIRED') knownBlockers.add('ACCOUNT_SELECTION_REQUIRED');
  if (account === 'INACTIVE') knownBlockers.add('ACCOUNT_NOT_ACTIVE');
  const actorId = input.accountId ? `account:${input.accountId}` : 'account:unselected';

  let funding: FundedRunReadinessResponse | null = null;
  if (schema.exact) {
    try {
      funding = await dependencies.funding(input.pool, actorId, profiles);
      for (const blocker of funding.blockers) knownBlockers.add(blocker);
    } catch { knownBlockers.add('FUNDING_READINESS_UNAVAILABLE'); }
  }

  let researchConnected = false;
  if (schema.exact) {
    try { researchConnected = await dependencies.researchScope(input.pool); }
    catch { knownBlockers.add('RESEARCH_SCOPE_UNAVAILABLE'); }
  }
  if (!researchConnected) knownBlockers.add('RESEARCH_SCOPE_REQUIRED');

  const trigger = triggerConfigured(env) ? 'CONFIGURED' : 'REQUIRED';
  if (trigger === 'REQUIRED') knownBlockers.add('TRIGGER_PROCESS_CONFIGURATION_REQUIRED');
  let acceptedRuntimeAsset: 'VALID' | 'REQUIRED' | 'INVALID' = 'REQUIRED';
  if (env.MOTIVE_CIRCLE_RUN_RUNTIME_FILE?.trim() || env.MOTIVE_CIRCLE_RUN_RUNTIME_SHA256?.trim()) {
    try { dependencies.runtimeAsset(env, input.projectRoot ?? process.cwd()); acceptedRuntimeAsset = 'VALID'; }
    catch { acceptedRuntimeAsset = 'INVALID'; }
  }
  if (acceptedRuntimeAsset !== 'VALID') knownBlockers.add(`ACCEPTED_RUNTIME_ASSET_${acceptedRuntimeAsset}`);

  const fields = runtimeFields(runConfig);
  const mountedProfileDigests = new Set(profiles.map(profile => profileDigest(profile)));
  const runtimeProfile = !fields ? 'REQUIRED' : mountedProfileDigests.has(fields.profileDigest) ? 'MATCHED' : 'MISMATCH';
  if (runtimeProfile !== 'MATCHED') knownBlockers.add(`RUNTIME_PROFILE_${runtimeProfile}`);

  let infrastructureAuthorization: 'ACTIVE' | 'REQUIRED' = 'REQUIRED';
  if (schema.exact && fields) {
    try {
      if (await dependencies.infrastructure(input.pool, fields.authorizationId, fields.maximumCostUsd)) {
        infrastructureAuthorization = 'ACTIVE';
      }
    } catch { /* fixed REQUIRED projection */ }
  }
  if (infrastructureAuthorization !== 'ACTIVE') knownBlockers.add('INFRASTRUCTURE_AUTHORIZATION_REQUIRED');

  return Object.freeze({
    format: 'motive.circle-discovery-readiness/0.1',
    checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    project: PROJECT,
    account,
    schema: schema.exact ? 'EXACT' : 'MISMATCH',
    researchScope: researchConnected ? 'CONNECTED' : 'REQUIRED',
    funding,
    processConfiguration: Object.freeze({
      projectRun: Object.freeze([...runConfig.readinessReasons]), trigger, acceptedRuntimeAsset,
      runtimeProfile, infrastructureRecord: infrastructureAuthorization,
    }),
    knownBlockers: Object.freeze([...knownBlockers].sort()),
    // Configuration presence is not an acceptance or dispatch decision. The
    // existing dispatcher rechecks the actual attempt and funding source.
    externalVerification: Object.freeze(['TRIGGER_DEPLOYMENT_AND_SCHEDULE', 'HYPOTHESIS_HEALTH',
      'SNAPSHOT_AVAILABLE_AND_UNEXPIRED', 'LIVE_INFERENCE_COMPATIBILITY', 'ATTEMPT_FINANCIAL_BINDINGS']),
    configurationChecksPassed: knownBlockers.size === 0,
  });
}

async function main() {
  const args = parseCircleDiscoveryReadinessArguments(process.argv.slice(2));
  const pool = new Pool(postgresPoolConfigFromEnvironment());
  try {
    process.stdout.write(`${JSON.stringify(await inspectCircleDiscoveryReadiness({ pool, ...args }), null, 2)}\n`);
  } finally { await pool.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
