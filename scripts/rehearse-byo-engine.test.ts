import { describe, expect, it } from 'vitest';
import {
  BYO_ORIGINS, BYO_VITE_DENY,
  createByoDatabaseNames,
  createContributorHandoff,
  deriveByoDatabaseUrls,
  hasExactOutputLine,
  safeRequestMetadata,
  validateEngineProxyTarget,
  validateByoDatabaseName,
} from './lib/byo-rehearsal.ts';

const id = '12345678-1234-4123-8123-123456789abc';
const names = {
  motive: 'motive_byo_12345678123441238123123456789abc',
  engine: 'hypothesis_byo_12345678123441238123123456789abc',
};

describe('BYO engine rehearsal supervisor safety', () => {
  it.each([
    'postgres://local:secret@127.0.0.1:5432/motive_test',
    'postgresql://local:secret@localhost/bootstrap',
    'postgres://local:secret@[::1]:5432/bootstrap',
  ])('derives isolated Motive, engine, and admin URLs from %s', source => {
    const urls = deriveByoDatabaseUrls(source, names);
    expect(urls.adminUrl.pathname).toBe('/postgres');
    expect(urls.motiveUrl.pathname).toBe(`/${names.motive}`);
    expect(urls.engineUrl.pathname).toBe(`/${names.engine}`);
    expect(urls.engineAsyncUrl).toMatch(/^postgresql\+asyncpg:\/\//);
    expect(urls.engineAsyncUrl).toContain(`/${names.engine}`);
  });

  it.each([
    'not-a-url',
    'https://127.0.0.1/bootstrap',
    'postgres://local:secret@db.example.test/bootstrap',
    'postgres://local:secret@127.0.0.2/bootstrap',
    'postgres://local:secret@localhost./bootstrap',
    'postgres://local:secret@localhost/bootstrap?host=remote.example',
    'postgres://local:secret@localhost/bootstrap?',
    'postgres://local:secret@localhost/bootstrap#fragment',
    'postgres://local:secret@localhost/bootstrap#',
  ])('rejects an unsafe bootstrap URL without connecting: %s', source => {
    expect(() => deriveByoDatabaseUrls(source, names)).toThrow(/PostgreSQL|loopback|query parameters/);
  });

  it('generates two exact database names from one canonical UUID', () => {
    expect(createByoDatabaseNames(id)).toEqual({ id, ...names });
  });

  it.each([
    ['motive_test', 'motive'],
    ['motive_app_local', 'motive'],
    ['motive_byo_1234', 'motive'],
    ['hypothesis_engine', 'engine'],
    ['hypothesis_byo_12345678123441238123123456789ABC', 'engine'],
  ] as const)('rejects database name %s', (name, kind) => {
    expect(() => validateByoDatabaseName(name, kind)).toThrow('database name');
  });

  it('requires the exact child readiness line', () => {
    const line = 'motive.md application service listening on 127.0.0.1:4336';
    expect(hasExactOutputLine(`setup\n${line}\n`, line)).toBe(true);
    expect(hasExactOutputLine(`prefix ${line}\n`, line)).toBe(false);
    expect(hasExactOutputLine(`${line.replace('4336', '4318')}\n`, line)).toBe(false);
  });

  it('retains only request path and query field names', () => {
    expect(safeRequestMetadata('/channels/x/context?expected_channel_id=secret&active_offset=20&active_offset=40'))
      .toEqual({ path: '/channels/x/context', queryFields: ['active_offset', 'expected_channel_id'] });
    expect(safeRequestMetadata('/x?api_key=never-record-this&access_token=also-secret'))
      .toEqual({ path: '/x', queryFields: [] });
    expect(safeRequestMetadata(`/keys/he_${'x'.repeat(43)}`)).toEqual({ path: '/keys/:redacted', queryFields: [] });
  });

  it('keeps engine credentials inside the exact loopback API proxy boundary', () => {
    expect(validateEngineProxyTarget('/api/v1/channels/x/context?expected_channel_id=123').origin)
      .toBe(BYO_ORIGINS.engineRuntime);
    for (const target of [
      '//remote.example/api/v1/keys', 'https://remote.example/api/v1/keys', '/api/v1/../keys',
      '/health', '/api/v2/keys',
    ]) expect(() => validateEngineProxyTarget(target)).toThrow('outside the rehearsal API boundary');
  });

  it('denies private and default sensitive paths from the Vite file server', () => {
    expect(BYO_VITE_DENY).toEqual([
      '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**',
    ]);
  });

  it('freezes the public loopback origins', () => {
    expect(BYO_ORIGINS).toEqual({
      app: 'http://127.0.0.1:4335', motiveApi: 'http://127.0.0.1:4336',
      engineApi: 'http://127.0.0.1:4337/api/v1', engineRuntime: 'http://127.0.0.1:4338',
    });
  });

  it('creates the contributor-only handoff without supervisor credentials', () => {
    const bearer = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;
    const handoff = createContributorHandoff(bearer);
    expect(handoff).toEqual({ motiveOrigin: BYO_ORIGINS.app,
      agentApiBaseUrl: `${BYO_ORIGINS.app}/api/agent`, bearer });
    expect(Object.keys(handoff).sort()).toEqual(['agentApiBaseUrl', 'bearer', 'motiveOrigin']);
    expect(() => createContributorHandoff('reviewer-cookie')).toThrow('bearer is invalid');
  });
});
