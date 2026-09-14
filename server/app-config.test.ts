import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ApplicationConfigError, isTrustedAppOrigin, loadApplicationConfig } from './app-config.ts';
import { OpenRouterFundingService } from './funding/service.ts';

describe('application origin and listener configuration', () => {
  it('preserves the exact local defaults and development-only localhost alias', () => {
    expect(loadApplicationConfig({})).toEqual({
      appOrigin: 'http://127.0.0.1:4317',
      trustedOrigins: ['http://127.0.0.1:4317', 'http://localhost:4317'],
      fundingCallbackUrl: 'http://127.0.0.1:4317/?project=circle-packing#backing',
      gatewayUrl: 'http://127.0.0.1:4317/api/inference/v1/responses',
      apiHost: '127.0.0.1',
      apiPort: 4318,
    });
  });

  it('derives every browser-facing trust boundary from one canonical origin', () => {
    const config = loadApplicationConfig({ MOTIVE_APP_ORIGIN: 'https://pilot.motive.test/', MOTIVE_API_HOST: '0.0.0.0', MOTIVE_API_PORT: '8443' });
    expect(config).toMatchObject({
      appOrigin: 'https://pilot.motive.test',
      trustedOrigins: ['https://pilot.motive.test'],
      fundingCallbackUrl: 'https://pilot.motive.test/?project=circle-packing#backing',
      gatewayUrl: 'https://pilot.motive.test/api/inference/v1/responses',
      apiHost: '0.0.0.0',
      apiPort: 8443,
    });
    expect(isTrustedAppOrigin(config, 'https://pilot.motive.test')).toBe(true);
    expect(isTrustedAppOrigin(config, 'https://foreign.motive.test')).toBe(false);
    expect(isTrustedAppOrigin(config, undefined)).toBe(false);
  });

  it('passes the derived origin boundary to funding callbacks and denies a foreign origin before persistence', async () => {
    const config = loadApplicationConfig({ MOTIVE_APP_ORIGIN: 'https://pilot.motive.test' });
    const inserts: unknown[][] = [];
    const pool = { query: async (_sql: string, values: unknown[]) => {
      inserts.push(values); return { rowCount: 1, rows: [] };
    } } as unknown as Pool;
    const funding = new OpenRouterFundingService({ pool, vaultKey: Buffer.alloc(32, 1),
      callbackUrl: config.fundingCallbackUrl, allowedCallbackOrigins: config.trustedOrigins,
      gatewayUrl: config.gatewayUrl, isActorActive: async () => true });
    const flow = await funding.startConnect('account:origin-test', config.appOrigin);
    const callback = new URL(new URL(flow.authorizationUrl).searchParams.get('callback_url')!);
    expect(callback.origin).toBe(config.appOrigin);
    expect(callback.pathname).toBe('/');
    await expect(funding.startConnect('account:origin-test', 'https://foreign.motive.test'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 403 });
    expect(inserts).toHaveLength(1);
  });

  it.each([
    'https://user:secret@pilot.motive.test',
    'https://pilot.motive.test/path',
    'https://pilot.motive.test/?query=yes',
    'https://pilot.motive.test/#fragment',
    'https://pilot.motive.test?',
    'https://pilot.motive.test#',
    'https://*.motive.test',
    'http://127.example.com',
    'http://pilot.motive.test',
    'https://pilot.motive.test:0',
    'https://pilot.motive.test:70000',
    'not-an-origin',
  ])('rejects an unsafe or malformed canonical origin without echoing it: %s', raw => {
    let caught: unknown;
    try { loadApplicationConfig({ MOTIVE_APP_ORIGIN: raw }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ApplicationConfigError);
    expect(String((caught as Error).message)).not.toContain(raw);
  });

  it('requires an explicit non-loopback HTTPS origin in production', () => {
    expect(() => loadApplicationConfig({ NODE_ENV: 'production' })).toThrow(ApplicationConfigError);
    expect(() => loadApplicationConfig({ NODE_ENV: 'production', MOTIVE_APP_ORIGIN: 'https://localhost:4317' })).toThrow(ApplicationConfigError);
    expect(loadApplicationConfig({ NODE_ENV: 'production', MOTIVE_APP_ORIGIN: 'https://motive.example' }).appOrigin)
      .toBe('https://motive.example');
  });

  it.each(['127.0.0.2', 'localhost', '::1', '0.0.0.0', '::'])('accepts an explicit bounded listener host: %s', host => {
    expect(loadApplicationConfig({ MOTIVE_API_HOST: host }).apiHost).toBe(host);
  });

  it.each(['motive.example', '*', '127.example.com', '192.168.1.10', '1.2.3.4'])('rejects a listener outside the explicit loopback/all-interface set: %s', host => {
    expect(() => loadApplicationConfig({ MOTIVE_API_HOST: host })).toThrow(ApplicationConfigError);
  });

  it.each(['1023', '65536', '4318.5', 'not-a-port'])('retains the bounded API port validation: %s', port => {
    expect(() => loadApplicationConfig({ MOTIVE_API_PORT: port })).toThrow(ApplicationConfigError);
  });
});
