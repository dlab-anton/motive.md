import { Pool } from 'pg';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../accounting/src/migrations.ts';

const socketDirectory = process.env.MOTIVE_JOINED_PG_SOCKET;
if (socketDirectory !== '/run/motive/postgres') {
  throw new Error('The joined migration runner requires the private guest PostgreSQL socket.');
}

const pool = new Pool({
  host: socketDirectory,
  database: 'motive',
  user: 'motive_controller',
  max: 1,
  query_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
});

try {
  const applied = await applyPostgresMigrations(pool);
  const status = await getPostgresSchemaStatus(pool);
  if (!status.exact) throw new Error(`Guest PostgreSQL schema is not exact: ${status.problems.join(' ')}`);
  process.stdout.write(`MOTIVE_JOINED_MIGRATIONS ${JSON.stringify({
    format: 'motive.protected-worker-joined-migrations/0.1',
    status: 'passed',
    applied,
    expected: status.expected,
  })}\n`);
} finally {
  await pool.end();
}
