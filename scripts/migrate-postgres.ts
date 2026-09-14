import { Pool } from 'pg';
import { applyPostgresMigrations, getPostgresSchemaStatus, postgresPoolConfigFromEnvironment } from '../packages/accounting/src/migrations.ts';

const checkOnly = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some(argument => argument !== '--check')) {
  throw new Error('Usage: tsx scripts/migrate-postgres.ts [--check]');
}
const pool = new Pool({ ...postgresPoolConfigFromEnvironment(), max: 1 });
try {
  const applied = checkOnly ? [] : await applyPostgresMigrations(pool);
  const status = await getPostgresSchemaStatus(pool);
  process.stdout.write(`${JSON.stringify({ mode: checkOnly ? 'check' : 'migrate', applied, schema: status }, null, 2)}\n`);
  if (!status.exact) process.exitCode = 1;
} finally {
  await pool.end();
}
