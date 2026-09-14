import { isIP } from 'node:net';

export type ApplicationConfig = Readonly<{
  appOrigin: string;
  trustedOrigins: readonly string[];
  fundingCallbackUrl: string;
  gatewayUrl: string;
  apiHost: string;
  apiPort: number;
}>;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const LOCAL_CANONICAL_ORIGIN = 'http://127.0.0.1:4317';
const LOCAL_ALIAS_ORIGIN = 'http://localhost:4317';

export class ApplicationConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid application configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ApplicationConfigError';
  }
}

function optional(env: EnvironmentSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  return isIP(host) === 6 && (host === '::1' || host === '0:0:0:0:0:0:0:1');
}

function parseAppOrigin(raw: string, configured: boolean, production: boolean, issues: string[]): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) issues.push('MOTIVE_APP_ORIGIN must use HTTP or HTTPS.');
    if (url.username || url.password) issues.push('MOTIVE_APP_ORIGIN must not contain credentials.');
    if (url.hostname.includes('*')) issues.push('MOTIVE_APP_ORIGIN must not contain a wildcard.');
    if (url.pathname !== '/' || url.search || url.hash || raw.includes('?') || raw.includes('#')) {
      issues.push('MOTIVE_APP_ORIGIN must be an origin without a path, query, or fragment.');
    }
    if (url.port === '0') issues.push('MOTIVE_APP_ORIGIN must use a valid nonzero port.');
    const loopback = isLoopbackHostname(url.hostname);
    if (configured && !loopback && url.protocol !== 'https:') {
      issues.push('A non-loopback MOTIVE_APP_ORIGIN must use HTTPS.');
    }
    if (production && (url.protocol !== 'https:' || loopback)) {
      issues.push('Production MOTIVE_APP_ORIGIN must be an explicit non-loopback HTTPS origin.');
    }
    return url.origin;
  } catch {
    issues.push('MOTIVE_APP_ORIGIN must be a valid absolute origin.');
    return LOCAL_CANONICAL_ORIGIN;
  }
}

function parseApiHost(raw: string, issues: string[]): string {
  const host = raw.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || isLoopbackHostname(host)) return host;
  issues.push('MOTIVE_API_HOST must be a loopback address, 0.0.0.0, or ::.');
  return '127.0.0.1';
}

function parseApiPort(raw: string | undefined, issues: string[]): number {
  const value = Number(raw || '4318');
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    issues.push('MOTIVE_API_PORT must be an integer from 1024 to 65535.');
    return 4318;
  }
  return value;
}

export function loadApplicationConfig(env: EnvironmentSource = process.env): ApplicationConfig {
  const issues: string[] = [];
  const production = optional(env, 'NODE_ENV') === 'production';
  const configuredOrigin = optional(env, 'MOTIVE_APP_ORIGIN');
  if (production && !configuredOrigin) issues.push('MOTIVE_APP_ORIGIN is required in production.');
  const appOrigin = parseAppOrigin(configuredOrigin ?? LOCAL_CANONICAL_ORIGIN, Boolean(configuredOrigin), production, issues);
  const apiHost = parseApiHost(optional(env, 'MOTIVE_API_HOST') ?? '127.0.0.1', issues);
  const apiPort = parseApiPort(optional(env, 'MOTIVE_API_PORT'), issues);
  if (issues.length) throw new ApplicationConfigError(issues);

  const trustedOrigins = !configuredOrigin && !production
    ? [LOCAL_CANONICAL_ORIGIN, LOCAL_ALIAS_ORIGIN]
    : [appOrigin];
  return Object.freeze({
    appOrigin,
    trustedOrigins: Object.freeze(trustedOrigins),
    fundingCallbackUrl: `${appOrigin}/?project=circle-packing#backing`,
    gatewayUrl: `${appOrigin}/api/inference/v1/responses`,
    apiHost,
    apiPort,
  });
}

export function isTrustedAppOrigin(config: Pick<ApplicationConfig, 'trustedOrigins'>, origin: string | undefined): boolean {
  return typeof origin === 'string' && config.trustedOrigins.includes(origin);
}
