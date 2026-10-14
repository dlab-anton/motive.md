import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment, type PostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';

export const APPLICATION_DATABASE_IDLE_ERROR = 'APPLICATION_DATABASE_IDLE_CONNECTION_FAILED';
const OPTIONAL_MCP_MIGRATION = '047_mcp_oauth.sql';
const MEMORY_RECOVERY_MIGRATION = '048_legacy_agent_memory_recovery.sql';
// The production schema may advance before the bridge deployment. These are the
// frozen SQL checksums from the Astronomy migration review, not an open-ended
// permission to accept later migrations.
const ASTRONOMY_EVIDENCE_MIGRATION = '050_exoplanet_evidence.sql';
const ASTRONOMY_REVIEW_MIGRATION = '051_exoplanet_finding_review.sql';
const ASTRONOMY_FORWARD_CHECKSUMS = {
  [ASTRONOMY_EVIDENCE_MIGRATION]: 'sha256:7b50e0a612753f4b86a10c2a5f8d83404c8ca5fba894831fa3e907770d907e2b',
  [ASTRONOMY_REVIEW_MIGRATION]: 'sha256:f406a41c6ad2f3040dda27cef782c77d094b0703d70ef82d7247a851ed5ebee9',
} as const;

/**
 * Deploy additive feature code before its tables, without relaxing accounting
 * or migration tooling. Each feature gates access to its pending tables.
 * After migration, retain a deployment that recognizes the new schema.
 */
export function applicationSchemaCanStart(schema: PostgresSchemaStatus): boolean {
  if (schema.exact) return schema.problems.length === 0 && matchingMigrationRows(schema);
  return soleMissingMigration(schema, OPTIONAL_MCP_MIGRATION)
    || memoryRecoveryMigrationPending(schema)
    || recognizedAstronomyForwardSchema(schema);
}

/** Only the frozen 050 prefix, optionally followed by 051, may be ahead of this deployment. */
function recognizedAstronomyForwardSchema(schema: PostgresSchemaStatus): boolean {
  if (schema.expected.some(row => row.name === ASTRONOMY_EVIDENCE_MIGRATION || row.name === ASTRONOMY_REVIEW_MIGRATION)) return false;
  const extras = schema.applied.filter(row => row.name === ASTRONOMY_EVIDENCE_MIGRATION || row.name === ASTRONOMY_REVIEW_MIGRATION);
  if (!extras.some(row => row.name === ASTRONOMY_EVIDENCE_MIGRATION)) return false;
  if (schema.problems.length !== extras.length || extras.some(row =>
    row.checksum !== ASTRONOMY_FORWARD_CHECKSUMS[row.name as keyof typeof ASTRONOMY_FORWARD_CHECKSUMS]
      || !schema.problems.includes(`Unsupported applied migration ${row.name}.`))) return false;
  return matchingMigrationRows(schema, new Set(extras.map(row => row.name)));
}

function matchingMigrationRows(schema: PostgresSchemaStatus, allowedExtra = new Set<string>()): boolean {
  const expected = new Map(schema.expected.map(row => [row.name, row.checksum]));
  const applied = new Map(schema.applied.map(row => [row.name, row.checksum]));
  if (expected.size !== schema.expected.length || applied.size !== schema.applied.length
    || applied.size !== expected.size + allowedExtra.size) return false;
  return schema.expected.every(row => applied.get(row.name) === row.checksum)
    && schema.applied.every(row => expected.has(row.name) || allowedExtra.has(row.name));
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
