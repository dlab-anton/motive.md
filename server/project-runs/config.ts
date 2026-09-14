import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CircleProjectRunRuntime } from './dispatcher.ts';
import { loadAccountConfiguration, type AccountProvider } from '../accounts/index.ts';

const MAX_RUNTIME_BUNDLE_BYTES = 512 * 1024;

export type CircleProjectRunDeploymentBundle = {
  format: 'motive.circle-project-run-deployment/0.1';
  runtime: CircleProjectRunRuntime;
};

export type CircleProjectRunReadinessReason =
  | 'DATABASE_CONFIGURATION_REQUIRED'
  | 'RUNTIME_BUNDLE_REQUIRED'
  | 'RUNTIME_BUNDLE_INVALID'
  | 'VERCEL_CREDENTIALS_REQUIRED'
  | 'OBJECT_STORE_CONFIGURATION_REQUIRED'
  | 'ACCOUNT_STORE_REQUIRED';

export type CircleProjectRunConfig = Readonly<{
  databaseConfigured: boolean;
  runtimeBundle: CircleProjectRunDeploymentBundle | null;
  runtimeFile: string | null;
  vercel: Readonly<{ token: string; teamId: string; projectId: string }> | null;
  objectStore: Readonly<{ url: string; serviceRoleKey: string; bucket: string }> | null;
  accountDatabasePath: string | null;
  accountProvider: AccountProvider;
  accountSupabase: Readonly<{ url: string; publishableKey: string; secretKey: string }> | null;
  readinessReasons: readonly CircleProjectRunReadinessReason[];
}>;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

function optional(env: EnvironmentSource, name: string): string | null {
  return env[name]?.trim() || null;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function readCircleProjectRunBundle(path: string): CircleProjectRunDeploymentBundle {
  const resolved = resolve(path);
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RUNTIME_BUNDLE_BYTES) throw new Error('PROJECT_RUN_RUNTIME_BUNDLE_INVALID');
  const parsed: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
  if (!exactObject(parsed, ['format', 'runtime'])
      || parsed.format !== 'motive.circle-project-run-deployment/0.1'
      || !parsed.runtime || typeof parsed.runtime !== 'object' || Array.isArray(parsed.runtime)) {
    throw new Error('PROJECT_RUN_RUNTIME_BUNDLE_INVALID');
  }
  return structuredClone(parsed) as CircleProjectRunDeploymentBundle;
}

/** Reads secrets into private server configuration; callers must never serialize this value. */
export function loadCircleProjectRunConfig(env: EnvironmentSource = process.env): CircleProjectRunConfig {
  const reasons: CircleProjectRunReadinessReason[] = [];
  const databaseConfigured = Boolean(optional(env, 'MOTIVE_DATABASE_URL') ?? optional(env, 'DATABASE_URL'));
  if (!databaseConfigured) reasons.push('DATABASE_CONFIGURATION_REQUIRED');

  const runtimeFile = optional(env, 'MOTIVE_CIRCLE_RUN_RUNTIME_FILE');
  let runtimeBundle: CircleProjectRunDeploymentBundle | null = null;
  if (!runtimeFile) reasons.push('RUNTIME_BUNDLE_REQUIRED');
  else {
    try { runtimeBundle = readCircleProjectRunBundle(runtimeFile); }
    catch { reasons.push('RUNTIME_BUNDLE_INVALID'); }
  }

  const token = optional(env, 'MOTIVE_VERCEL_TOKEN');
  const teamId = optional(env, 'MOTIVE_VERCEL_TEAM_ID');
  const projectId = optional(env, 'MOTIVE_VERCEL_PROJECT_ID');
  const vercel = token && teamId && projectId ? Object.freeze({ token, teamId, projectId }) : null;
  if (!vercel) reasons.push('VERCEL_CREDENTIALS_REQUIRED');

  const url = optional(env, 'SUPABASE_URL');
  const serviceRoleKey = optional(env, 'SUPABASE_SECRET_KEY') ?? optional(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const bucket = optional(env, 'SUPABASE_STORAGE_BUCKET');
  const objectStore = url && serviceRoleKey && bucket ? Object.freeze({ url, serviceRoleKey, bucket }) : null;
  if (!objectStore) reasons.push('OBJECT_STORE_CONFIGURATION_REQUIRED');

  let accountProvider: AccountProvider = 'local-better-auth';
  let accountSupabase: CircleProjectRunConfig['accountSupabase'] = null;
  try {
    const accounts = loadAccountConfiguration(env);
    accountProvider = accounts.provider;
    accountSupabase = accounts.supabase;
  } catch {
    reasons.push('ACCOUNT_STORE_REQUIRED');
  }
  const dataDirectory = resolve(optional(env, 'MOTIVE_DATA_DIR') ?? '.local');
  const localAccountPath = resolve(dataDirectory, 'motive.sqlite');
  const accountStore = accountProvider === 'local-better-auth' && existsSync(localAccountPath)
    ? localAccountPath
    : null;
  if (accountProvider === 'local-better-auth' && !accountStore) reasons.push('ACCOUNT_STORE_REQUIRED');
  if (accountProvider === 'supabase' && !accountSupabase) reasons.push('ACCOUNT_STORE_REQUIRED');

  return Object.freeze({
    databaseConfigured,
    runtimeBundle,
    runtimeFile,
    vercel,
    objectStore,
    accountDatabasePath: accountStore,
    accountProvider,
    accountSupabase,
    readinessReasons: Object.freeze([...new Set(reasons)]),
  });
}
