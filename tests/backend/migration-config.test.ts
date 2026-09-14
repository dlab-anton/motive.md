import { describe, expect, it } from 'vitest';
import { postgresPoolConfigFromEnvironment } from '../../packages/accounting/src/migrations.ts';

const production = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://migrator:local-test-value@db.test.invalid:5432/postgres',
  DATABASE_CONNECTION_MODE: 'direct', DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nfixture\\n-----END CERTIFICATE-----',
};
describe('migration TLS boundary', () => {
  it('uses the documented control CA variable without requiring a separate TLS switch', () => {
    const config = postgresPoolConfigFromEnvironment(production);
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n' });
  });
  it('rejects a missing CA or explicit downgrade in production', () => {
    expect(() => postgresPoolConfigFromEnvironment({ ...production, DATABASE_CA_CERT: '' })).toThrow('DATABASE_CA_CERT is required');
    expect(() => postgresPoolConfigFromEnvironment({ ...production, MOTIVE_DATABASE_SSL: 'disable' })).toThrow('cannot be disabled');
  });
  it.each(['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])('prevents connection-string %s from overriding certificate verification', name => {
    expect(() => postgresPoolConfigFromEnvironment({ ...production, DATABASE_URL: `${production.DATABASE_URL}?${name}=require` })).toThrow(`must omit ${name}`);
  });
  it('permits the isolated local PostgreSQL test without pretending TLS was exercised', () => {
    expect(postgresPoolConfigFromEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@127.0.0.1:55439/test' }).ssl).toBeUndefined();
  });
});
