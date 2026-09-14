import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient, PoolConfig } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export type MigrationDescriptor = {
  name: string;
  checksum: string;
  sql: string;
};

export type PostgresSchemaStatus = {
  expected: readonly Pick<MigrationDescriptor, 'name' | 'checksum'>[];
  applied: readonly { name: string; checksum: string }[];
  exact: boolean;
  problems: readonly string[];
};

export type SchemaStatusOptions = {
  /** Only migration application may create this metadata table. Readiness probes stay read-only. */
  createMigrationTable?: boolean;
};

const packageDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultMigrationDirectory = resolve(packageDirectory, '../../../migrations');

function checksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql).digest('hex')}`;
}

export async function listPostgresMigrations(migrationDirectory = defaultMigrationDirectory): Promise<MigrationDescriptor[]> {
  const names = (await readdir(migrationDirectory))
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async name => {
    const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
    return { name, checksum: checksum(sql), sql };
  }));
}

async function ensureMigrationTable(client: Queryable): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS motive');
  await client.query(`
    CREATE TABLE IF NOT EXISTS motive.schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

function isPoolClient(database: Pool | PoolClient): database is PoolClient {
  return 'release' in database;
}

async function withClient<T>(database: Pool | PoolClient, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isPoolClient(database)) {
    const client = await database.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  return work(database);
}

export async function applyPostgresMigrations(database: Pool | PoolClient, migrationDirectory = defaultMigrationDirectory): Promise<readonly string[]> {
  const migrations = await listPostgresMigrations(migrationDirectory);
  return withClient(database, async client => {
    await client.query("SELECT pg_advisory_lock(hashtextextended('motive.schema_migrations', 0))");
    try {
      await ensureMigrationTable(client);
      const applied = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM motive.schema_migrations ORDER BY name');
      const known = new Map(applied.rows.map(row => [row.name, row.checksum]));
      const expected = new Map(migrations.map(migration => [migration.name, migration.checksum]));
      for (const migration of applied.rows) {
        if (!expected.has(migration.name)) {
          throw new Error(`Unsupported applied migration ${migration.name}; refusing to apply a partial schema.`);
        }
      }
      const executed: string[] = [];
      for (const migration of migrations) {
        const existing = known.get(migration.name);
        if (existing !== undefined) {
          if (existing !== migration.checksum) {
            throw new Error(`Migration checksum mismatch for ${migration.name}; migrations are immutable.`);
          }
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO motive.schema_migrations (name, checksum) VALUES ($1, $2)',
            [migration.name, migration.checksum],
          );
          await client.query('COMMIT');
          executed.push(migration.name);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return executed;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('motive.schema_migrations', 0))");
    }
  });
}

export async function getPostgresSchemaStatus(
  database: Pool | PoolClient,
  migrationDirectory = defaultMigrationDirectory,
  options: SchemaStatusOptions = {},
): Promise<PostgresSchemaStatus> {
  const expectedMigrations = await listPostgresMigrations(migrationDirectory);
  return withClient(database, async client => {
    if (options.createMigrationTable) await ensureMigrationTable(client);
    const metadataTable = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('motive.schema_migrations')::text AS table_name",
    );
    if (metadataTable.rows[0]?.table_name === null || metadataTable.rows.length === 0) {
      const expected = expectedMigrations.map(({ name, checksum: migrationChecksum }) => ({ name, checksum: migrationChecksum }));
      return {
        expected,
        applied: [],
        exact: false,
        problems: ['Missing migration metadata table motive.schema_migrations.', ...expected.map(migration => `Missing migration ${migration.name}.`)],
      };
    }
    const result = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM motive.schema_migrations ORDER BY name');
    const applied = result.rows;
    const appliedByName = new Map(applied.map(row => [row.name, row.checksum]));
    const expected = expectedMigrations.map(({ name, checksum: migrationChecksum }) => ({ name, checksum: migrationChecksum }));
    const expectedByName = new Map(expected.map(row => [row.name, row.checksum]));
    const problems: string[] = [];
    for (const migration of expected) {
      const actual = appliedByName.get(migration.name);
      if (actual === undefined) problems.push(`Missing migration ${migration.name}.`);
      else if (actual !== migration.checksum) problems.push(`Checksum mismatch for ${migration.name}.`);
    }
    for (const migration of applied) {
      if (!expectedByName.has(migration.name)) problems.push(`Unsupported applied migration ${migration.name}.`);
    }
    return { expected, applied, exact: problems.length === 0, problems };
  });
}

/** Migration connections enforce the same verified production TLS as control. */
export function postgresPoolConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = environment.MOTIVE_DATABASE_URL ?? environment.DATABASE_URL;
  if (!connectionString) throw new Error('MOTIVE_DATABASE_URL (or DATABASE_URL) is required.');
  if (environment.NODE_ENV && !['development', 'test', 'production'].includes(environment.NODE_ENV)) throw new Error('NODE_ENV must be development, test, or production.');
  const production = environment.NODE_ENV === 'production';
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  const sslMode = environment.MOTIVE_DATABASE_SSL;
  if (sslMode && !['disable', 'verify-full'].includes(sslMode)) {
    throw new Error('MOTIVE_DATABASE_SSL must be disable or verify-full; insecure TLS modes are not supported.');
  }
  const rawCa = environment.DATABASE_CA_CERT || environment.MOTIVE_DATABASE_SSL_CA;
  const ca = rawCa?.replace(/\\n/g, '\n').trim();
  if (ca && (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----'))) throw new Error('DATABASE_CA_CERT must be a PEM certificate.');
  if (production) {
    if (!ca) throw new Error('DATABASE_CA_CERT is required for verified production database TLS.');
    if (sslMode === 'disable') throw new Error('Production database TLS cannot be disabled.');
    if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(url.hostname)) throw new Error('Production DATABASE_URL must not use a loopback host.');
    if (!url.username || !url.password) throw new Error('Production DATABASE_URL requires credentials.');
    if (!['direct', 'session'].includes(environment.DATABASE_CONNECTION_MODE ?? '')) throw new Error('Production DATABASE_CONNECTION_MODE must be direct or session.');
  }
  const verifiedTls = production || Boolean(ca) || sslMode === 'verify-full';
  if (ca && sslMode === 'disable') throw new Error('DATABASE_CA_CERT conflicts with disabled TLS.');
  if (verifiedTls) {
    for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      if (url.searchParams.has(name)) throw new Error(`DATABASE_URL must omit ${name}; it overrides verified TLS configuration.`);
    }
  }
  return {
    connectionString,
    connectionTimeoutMillis: 5000,
    ...(verifiedTls ? { ssl: { rejectUnauthorized: true, ...(ca ? { ca: `${ca}\n` } : {}) } } : {}),
  };
}
