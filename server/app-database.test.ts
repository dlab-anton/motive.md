import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPostgresSchemaStatus, type PostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';
import { createMcpSchemaReadiness } from './mcp/readiness.ts';
import {
  APPLICATION_DATABASE_IDLE_ERROR,
  applicationDatabasePoolConfig,
  applicationSchemaCanStart,
  attachApplicationDatabasePoolErrorHandler,
} from './app-database.ts';

vi.mock('../packages/accounting/src/migrations.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/accounting/src/migrations.ts')>(),
  getPostgresSchemaStatus: vi.fn(),
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function missingMcpSchema(): PostgresSchemaStatus {
  return {
    expected: [{ name: '001_base.sql', checksum: 'base' }, { name: '047_mcp_oauth.sql', checksum: 'mcp' }],
    applied: [{ name: '001_base.sql', checksum: 'base' }],
    exact: false, problems: ['Missing migration 047_mcp_oauth.sql.'],
  };
}

function exactMcpSchema(): PostgresSchemaStatus {
  const schema = missingMcpSchema();
  return { ...schema, applied: schema.expected, exact: true, problems: [] };
}

const astronomy = [
  { name: '050_exoplanet_evidence.sql', checksum: 'sha256:7b50e0a612753f4b86a10c2a5f8d83404c8ca5fba894831fa3e907770d907e2b' },
  { name: '051_exoplanet_finding_review.sql', checksum: 'sha256:f406a41c6ad2f3040dda27cef782c77d094b0703d70ef82d7247a851ed5ebee9' },
] as const;

function bridgeSchema(appliedExtras: readonly { name: string; checksum: string }[]): PostgresSchemaStatus {
  const prior = exactMcpSchema();
  return {
    expected: prior.expected,
    applied: [...prior.applied, ...appliedExtras],
    exact: false,
    problems: appliedExtras.map(row => `Unsupported applied migration ${row.name}.`),
  };
}

describe('frozen Astronomy forward-schema bridge', () => {
  it('pins the exact hashes of reviewed 050 and 051 SQL when those files are in this checkout', () => {
    // The deployment bridge copies only app-database.ts and this test into the
    // old source checkout, which does not yet contain the Astronomy SQL files.
    const paths = astronomy.map(row => new URL(`../migrations/${row.name}`, import.meta.url));
    if (!paths.every(path => existsSync(path))) return;
    for (const [index, path] of paths.entries()) {
      const sql = readFileSync(path, 'utf8');
      expect(`sha256:${createHash('sha256').update(sql).digest('hex')}`).toBe(astronomy[index].checksum);
    }
  });

  it('starts old source on its original exact schema, on 050 alone, and on 050 then 051', () => {
    expect(applicationSchemaCanStart(exactMcpSchema())).toBe(true);
    expect(applicationSchemaCanStart(bridgeSchema([astronomy[0]]))).toBe(true);
    expect(applicationSchemaCanStart(bridgeSchema(astronomy))).toBe(true);
    const final = bridgeSchema(astronomy);
    expect(applicationSchemaCanStart({ ...final, expected: final.applied, exact: true, problems: [] })).toBe(true);
  });

  it('rejects 051 without 050, changed SQL checksums, and any unknown later migration', () => {
    expect(applicationSchemaCanStart(bridgeSchema([astronomy[1]]))).toBe(false);
    expect(applicationSchemaCanStart(bridgeSchema([{ ...astronomy[0], checksum: `sha256:${'0'.repeat(64)}` }]))).toBe(false);
    expect(applicationSchemaCanStart(bridgeSchema([astronomy[0], { ...astronomy[1], checksum: `sha256:${'0'.repeat(64)}` }]))).toBe(false);
    expect(applicationSchemaCanStart(bridgeSchema([astronomy[0], { name: '052_future.sql', checksum: 'sha256:future' }]))).toBe(false);
  });

  it('rejects missing or altered old migrations, duplicate rows, and contradictory problems', () => {
    const valid = bridgeSchema(astronomy);
    expect(applicationSchemaCanStart({ ...valid, applied: valid.applied.filter(row => row.name !== '047_mcp_oauth.sql'),
      problems: [...valid.problems, 'Missing migration 047_mcp_oauth.sql.'] })).toBe(false);
    expect(applicationSchemaCanStart({ ...valid, expected: [{ name: '001_base.sql', checksum: 'changed' }, valid.expected[1]] })).toBe(false);
    expect(applicationSchemaCanStart({ ...valid, applied: [...valid.applied, astronomy[0]],
      problems: [...valid.problems, `Unsupported applied migration ${astronomy[0].name}.`] })).toBe(false);
    expect(applicationSchemaCanStart({ ...valid, expected: [...valid.expected, valid.expected[0]] })).toBe(false);
    expect(applicationSchemaCanStart({ ...valid, problems: [valid.problems[0]] })).toBe(false);
    expect(applicationSchemaCanStart({ ...valid, exact: true })).toBe(false);
    expect(applicationSchemaCanStart({ ...exactMcpSchema(), applied: bridgeSchema([astronomy[0]]).applied })).toBe(false);
  });

  it('does not treat expected 050 or 051 as optional pending migrations', () => {
    const old = exactMcpSchema();
    for (const pending of [astronomy[0], astronomy[1]]) {
      expect(applicationSchemaCanStart({ expected: [...old.expected, pending], applied: old.applied,
        exact: false, problems: [`Missing migration ${pending.name}.`] })).toBe(false);
    }
  });
});

describe('bounded additive MCP schema rollout', () => {
  it('keeps existing MCP available while only the recovery migration is pending', async () => {
    const exact = exactMcpSchema();
    const recovery = { name: '048_legacy_agent_memory_recovery.sql', checksum: 'recovery' };
    const schema = { ...exact, expected: [...exact.expected, recovery], exact: false,
      problems: [`Missing migration ${recovery.name}.`] };
    expect(applicationSchemaCanStart(schema)).toBe(true);
    vi.mocked(getPostgresSchemaStatus).mockResolvedValue(schema);
    await expect(createMcpSchemaReadiness({} as never)()).resolves.toBe(true);
    expect(applicationSchemaCanStart({ ...schema, applied: schema.applied.slice(1) })).toBe(false);
    expect(applicationSchemaCanStart({ ...schema, problems: [...schema.problems, 'Checksum mismatch for 001_base.sql.'] })).toBe(false);
  });

  it('accepts an exact schema and only the sole missing MCP migration', () => {
    expect(applicationSchemaCanStart(exactMcpSchema())).toBe(true);
    expect(applicationSchemaCanStart(missingMcpSchema())).toBe(true);
  });

  it.each(['040_external_service_coverage.sql', '045_other.sql', '046_other.sql', '048_future.sql'])('does not waive missing %s', name => {
    const schema = missingMcpSchema();
    expect(applicationSchemaCanStart({ ...schema, problems: [`Missing migration ${name}.`] })).toBe(false);
    expect(applicationSchemaCanStart({ ...schema, problems: [...schema.problems, `Missing migration ${name}.`] })).toBe(false);
  });

  it('rejects checksum mismatches, unexpected applied migrations, and absent metadata', () => {
    const schema = missingMcpSchema();
    for (const problem of ['Checksum mismatch for 047_mcp_oauth.sql.', 'Unsupported applied migration 045_other.sql.', 'Missing migration metadata table motive.schema_migrations.']) {
      expect(applicationSchemaCanStart({ ...schema, problems: [problem] })).toBe(false);
    }
    expect(applicationSchemaCanStart({ ...schema, applied: [{ name: '001_base.sql', checksum: 'changed' }] })).toBe(false);
    expect(applicationSchemaCanStart({ ...schema, applied: [...schema.applied, { name: '045_other.sql', checksum: 'other' }] })).toBe(false);
    expect(applicationSchemaCanStart({ ...schema, expected: schema.applied })).toBe(false);
    expect(applicationSchemaCanStart({ ...schema, applied: [] })).toBe(false);
  });

  it('keeps MCP closed before migration, then observes exact schema after at most five seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const status = vi.mocked(getPostgresSchemaStatus);
    status.mockResolvedValueOnce(missingMcpSchema()).mockResolvedValueOnce(exactMcpSchema());
    const check = createMcpSchemaReadiness({} as never);
    await expect(check()).resolves.toBe(false);
    vi.setSystemTime(14_999);
    await expect(check()).resolves.toBe(false);
    expect(status).toHaveBeenCalledTimes(1);
    vi.setSystemTime(15_000);
    await expect(check()).resolves.toBe(true);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight read and fails closed on a later database error', async () => {
    vi.useFakeTimers(); vi.setSystemTime(20_000);
    let finish!: (schema: PostgresSchemaStatus) => void;
    const status = vi.mocked(getPostgresSchemaStatus);
    status.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const check = createMcpSchemaReadiness({} as never);
    const first = check(); const second = check();
    expect(first).toBe(second);
    expect(status).toHaveBeenCalledTimes(1);
    finish(exactMcpSchema());
    await expect(first).resolves.toBe(true);
    vi.setSystemTime(25_000);
    status.mockRejectedValueOnce(new Error('synthetic database connection secret'));
    await expect(check()).resolves.toBe(false);
    await expect(check()).resolves.toBe(false);
    expect(status).toHaveBeenCalledTimes(2);
  });
});

class FakePool extends EventEmitter {
  query = vi.fn(async (_sql: string) => ({ rows: [{ healthy: true }] }));
}

describe('application database idle connection errors', () => {
  it('handles the pg error event with a fixed code and leaves later query behavior intact', async () => {
    const pool = new FakePool(); const report = vi.fn();
    attachApplicationDatabasePoolErrorHandler(pool as never, report);
    expect(() => pool.emit('error', new Error('postgres://user:secret@example.invalid/private'))).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(APPLICATION_DATABASE_IDLE_ERROR);
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
    await expect(pool.query('SELECT 1')).resolves.toEqual({ rows: [{ healthy: true }] });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('uses the shared verified production TLS configuration', () => {
    const config = applicationDatabasePoolConfig({
      NODE_ENV: 'production',
      MOTIVE_DATABASE_URL: 'postgresql://app:test@db.example.invalid/postgres',
      DATABASE_CONNECTION_MODE: 'session',
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nfixture\\n-----END CERTIFICATE-----',
    });
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
    });
    expect(config.max).toBe(8);
    expect(config.statement_timeout).toBe(15_000);
  });

  it('bounds each Vercel function to two promptly released session-pooler clients', () => {
    const config = applicationDatabasePoolConfig({
      NODE_ENV: 'production',
      VERCEL: '1',
      MOTIVE_DATABASE_URL: 'postgresql://app:test@db.example.invalid/postgres',
      DATABASE_CONNECTION_MODE: 'session',
      DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nfixture\\n-----END CERTIFICATE-----',
    });
    expect(config).toMatchObject({
      max: 2,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      statement_timeout: 15_000,
    });
    expect(config.connectionString).toBe('postgresql://app:test@db.example.invalid/postgres');
  });
});
