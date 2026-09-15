import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment, type PostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';

export const APPLICATION_DATABASE_IDLE_ERROR = 'APPLICATION_DATABASE_IDLE_CONNECTION_FAILED';
const OPTIONAL_MCP_MIGRATION = '047_mcp_oauth.sql';
const MEMORY_RECOVERY_MIGRATION = '048_legacy_agent_memory_recovery.sql';

/**
 * Deploy additive feature code before its tables, without relaxing accounting
 * or migration tooling. Each feature gates access to its pending tables.
 * After migration, retain a deployment that recognizes the new schema.
 */
export function applicationSchemaCanStart(schema: PostgresSchemaStatus): boolean {
  if (schema.exact) return true;
  return soleMissingMigration(schema, OPTIONAL_MCP_MIGRATION) || memoryRecoveryMigrationPending(schema);
}

/** Recovery routes remain closed until their tables exist; existing MCP stays available. */
export function memoryRecoveryMigrationPending(schema: PostgresSchemaStatus): boolean {
  return soleMissingMigration(schema, MEMORY_RECOVERY_MIGRATION);
}

function soleMissingMigration(schema: PostgresSchemaStatus, migration: string): boolean {
  if (schema.problems.length !== 1 || schema.problems[0] !== `Missing migration ${migration}.`) return false;
  const optional = schema.expected.filter(row => row.name === migration);
  if (optional.length !== 1 || schema.applied.some(row => row.name === migration)) return false;
  const required = schema.expected.filter(row => row.name !== migration);
  const applied = new Map(schema.applied.map(row => [row.name, row.checksum]));
  return applied.size === schema.applied.length && applied.size === required.length
    && required.every(row => applied.get(row.name) === row.checksum);
}

type PoolErrorSource = Pick<Pool, 'on'>;
type EnvironmentSource = NodeJS.ProcessEnv;

export function applicationDatabasePoolConfig(env: EnvironmentSource = process.env) {
  // A Vercel deployment can have several warm function instances. Supabase
  // session-pooler clients are reserved per process, so a large pool in every
  // instance exhausts the tenant limit even at modest request concurrency.
  // Keep two sessions per instance. Funding serializes its lock-holding
  // mutations, leaving the second client available for nested ledger queries
  // while preserving session-scoped advisory locks.
  const serverless = env.VERCEL === '1';
  return {
    ...postgresPoolConfigFromEnvironment(env),
    max: serverless ? 2 : 8,
    ...(serverless ? { idleTimeoutMillis: 1_000, allowExitOnIdle: true } : {}),
    statement_timeout: 15_000,
  };
}

/**
 * pg already evicts an idle client before emitting this event. A listener keeps
 * that transport failure from becoming an uncaught process error; subsequent
 * pool queries still acquire a new connection and retain their normal errors.
 */
export function attachApplicationDatabasePoolErrorHandler(
  pool: PoolErrorSource,
  report: (code: typeof APPLICATION_DATABASE_IDLE_ERROR) => void = code => console.error(code),
): void {
  pool.on('error', () => report(APPLICATION_DATABASE_IDLE_ERROR));
}

/** Account cookies stay in the account service; project authority stays in PostgreSQL. */
export async function openApplicationDatabase(): Promise<Pool | null> {
  const connectionString = process.env.MOTIVE_DATABASE_URL;
  if (!connectionString) return null;
  const pool = new Pool(applicationDatabasePoolConfig(process.env));
  if (process.env.VERCEL === '1') attachDatabasePool(pool);
  attachApplicationDatabasePoolErrorHandler(pool);
  try {
    const schema = await getPostgresSchemaStatus(pool);
    if (!applicationSchemaCanStart(schema)) throw new Error('Project database migrations must be applied before startup.');
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
