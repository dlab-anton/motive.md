import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MOTIVE_DATABASE = /^motive_byo_[a-f0-9]{32}$/;
const ENGINE_DATABASE = /^hypothesis_byo_[a-f0-9]{32}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const BYO_ORIGINS = Object.freeze({
  app: 'http://127.0.0.1:4335',
  motiveApi: 'http://127.0.0.1:4336',
  engineApi: 'http://127.0.0.1:4337/api/v1',
  engineRuntime: 'http://127.0.0.1:4338',
});

export const BYO_VITE_DENY = Object.freeze([
  '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**',
]);

export function validateByoDatabaseName(name: string, kind: 'motive' | 'engine'): string {
  const pattern = kind === 'motive' ? MOTIVE_DATABASE : ENGINE_DATABASE;
  if (!pattern.test(name)) throw new Error(`Invalid ${kind} BYO rehearsal database name.`);
  return name;
}

export function createByoDatabaseNames(id: string = randomUUID()): {
  id: string;
  motive: string;
  engine: string;
} {
  if (!UUID.test(id)) throw new Error('Invalid BYO rehearsal UUID.');
  const suffix = id.replaceAll('-', '');
  return {
    id,
    motive: validateByoDatabaseName(`motive_byo_${suffix}`, 'motive'),
    engine: validateByoDatabaseName(`hypothesis_byo_${suffix}`, 'engine'),
  };
}

export function deriveByoDatabaseUrls(source: string, names: { motive: string; engine: string }): {
  adminUrl: URL;
  motiveUrl: URL;
  engineUrl: URL;
  engineAsyncUrl: string;
} {
  let bootstrap: URL;
  try { bootstrap = new URL(source); }
  catch { throw new Error('The bootstrap value must be a valid loopback PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(bootstrap.protocol)
      || !LOOPBACK_HOSTS.has(bootstrap.hostname)) {
    throw new Error('The BYO rehearsal requires a loopback PostgreSQL bootstrap connection.');
  }
  if (bootstrap.search || bootstrap.hash || source.includes('?') || source.includes('#')) {
    throw new Error('The loopback PostgreSQL bootstrap URL must not contain query parameters or a fragment.');
  }
  validateByoDatabaseName(names.motive, 'motive');
  validateByoDatabaseName(names.engine, 'engine');
  const adminUrl = new URL(bootstrap); adminUrl.pathname = '/postgres';
  const motiveUrl = new URL(bootstrap); motiveUrl.pathname = `/${names.motive}`;
  const engineUrl = new URL(bootstrap); engineUrl.pathname = `/${names.engine}`;
  const engineAsyncUrl = `postgresql+asyncpg:${engineUrl.href.slice(engineUrl.protocol.length)}`;
  return { adminUrl, motiveUrl, engineUrl, engineAsyncUrl };
}

export function hasExactOutputLine(output: string, expected: string): boolean {
  return output.split(/\r?\n/).some(line => line === expected);
}

export function safeRequestMetadata(rawUrl: string): { path: string; queryFields: string[] } {
  try {
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    const path = parsed.pathname.split('/').map(segment => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* use encoded segment */ }
      return decoded.length > 128 || /^(?:he_[A-Za-z0-9_-]{43}|motive_agent_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)$/.test(decoded)
        ? ':redacted' : segment;
    }).join('/');
    const queryFields = [...new Set(parsed.searchParams.keys())]
      .filter(name => !/(?:key|token|secret|credential|password|authorization)/i.test(name)).sort();
    return { path, queryFields };
  } catch {
    return { path: '/', queryFields: [] };
  }
}

export function validateEngineProxyTarget(rawUrl: string): URL {
  if (!rawUrl.startsWith('/api/v1/') || rawUrl.startsWith('//') || rawUrl.includes('://')) {
    throw new Error('Engine proxy target is outside the rehearsal API boundary.');
  }
  let target: URL;
  try { target = new URL(rawUrl, BYO_ORIGINS.engineRuntime); }
  catch { throw new Error('Engine proxy target is invalid.'); }
  if (target.origin !== BYO_ORIGINS.engineRuntime || target.username || target.password
      || !target.pathname.startsWith('/api/v1/')) {
    throw new Error('Engine proxy target is outside the rehearsal API boundary.');
  }
  return target;
}

export function createContributorHandoff(bearer: string): Readonly<{
  motiveOrigin: string;
  agentApiBaseUrl: string;
  bearer: string;
}> {
  if (!/^motive_agent_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(bearer)) {
    throw new Error('Generated contributor bearer is invalid.');
  }
  return Object.freeze({ motiveOrigin: BYO_ORIGINS.app, agentApiBaseUrl: `${BYO_ORIGINS.app}/api/agent`, bearer });
}
