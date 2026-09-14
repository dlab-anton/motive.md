import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_DATABASE_IDLE_ERROR,
  applicationDatabasePoolConfig,
  attachApplicationDatabasePoolErrorHandler,
} from './app-database.ts';

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
