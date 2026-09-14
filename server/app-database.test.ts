import { EventEmitter } from 'node:events';
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

describe('bounded additive MCP schema rollout', () => {
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
