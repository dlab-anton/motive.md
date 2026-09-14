export type ControlEnvironment = 'development' | 'test' | 'production';
export type DatabaseConnectionMode = 'direct' | 'session';

export type ControlConfig = Readonly<{
  environment: ControlEnvironment;
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  buildId: string;
  shutdownGraceMs: number;
  healthProbeIntervalMs: number;
  healthProbeTimeoutMs: number;
  database: Readonly<{
    url: string;
    connectionMode: DatabaseConnectionMode;
    maxConnections: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
    ssl: Readonly<{ rejectUnauthorized: true; ca: string }> | undefined;
  }>;
  supabase: Readonly<{
    url: string;
    publishableKey: string;
    serviceRoleKey: string | undefined;
    storageBucket: string | undefined;
  }>;
  trigger: Readonly<{
    secretKey: string;
    projectRef: string;
  }> | undefined;
}>;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const unsafeValuePattern = /(?:change[-_ ]?me|replace[-_ ]?me|placeholder|example(?:\.com)?|<[^>]+>)/i;
const databaseSslParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'] as const;

export class ControlConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid control-plane configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ControlConfigError';
    this.issues = issues;
  }
}

function optional(env: EnvironmentSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: EnvironmentSource, name: string, issues: string[]): string {
  const value = optional(env, name);
  if (!value) issues.push(`${name} is required.`);
  return value ?? '';
}

function integer(
  env: EnvironmentSource,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const raw = optional(env, name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}.`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}.`);
    return fallback;
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '127.0.0.1' || host.startsWith('127.');
}

function parseHttpUrl(
  raw: string,
  name: string,
  production: boolean,
  issues: string[],
): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(`${name} must use http: or https:.`);
    }
    if (url.username || url.password) issues.push(`${name} must not contain credentials.`);
    if (production && url.protocol !== 'https:') issues.push(`${name} must use https: in production.`);
    if (production && isLoopback(url.hostname)) issues.push(`${name} must not use a loopback host in production.`);
    return url;
  } catch {
    issues.push(`${name} must be an absolute URL.`);
    return undefined;
  }
}

function parseOrigins(raw: string, production: boolean, issues: string[]): readonly string[] {
  const origins = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (origins.length === 0) issues.push('CONTROL_ALLOWED_ORIGINS must contain at least one origin.');
  const normalized = new Set<string>();

  for (const origin of origins) {
    if (origin === '*') {
      issues.push('CONTROL_ALLOWED_ORIGINS must not contain a wildcard.');
      continue;
    }
    const url = parseHttpUrl(origin, 'CONTROL_ALLOWED_ORIGINS', production, issues);
    if (!url) continue;
    if (production && unsafeValuePattern.test(origin)) {
      issues.push('CONTROL_ALLOWED_ORIGINS contains a placeholder value.');
      continue;
    }
    if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
      issues.push('CONTROL_ALLOWED_ORIGINS entries must be origins without paths, queries, or fragments.');
      continue;
    }
    normalized.add(url.origin);
  }

  return [...normalized];
}

function rejectUnsafeProductionValue(name: string, value: string | undefined, production: boolean, issues: string[]): void {
  if (production && value && unsafeValuePattern.test(value)) issues.push(`${name} contains a placeholder value.`);
}

function normalizeCertificate(raw: string | undefined, production: boolean, issues: string[]): string | undefined {
  if (!raw) {
    if (production) issues.push('DATABASE_CA_CERT is required for verified production database TLS.');
    return undefined;
  }
  const certificate = raw.replace(/\\n/g, '\n').trim();
  if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----')) {
    issues.push('DATABASE_CA_CERT must contain a PEM certificate.');
    return undefined;
  }
  return `${certificate}\n`;
}

export function loadControlConfig(env: EnvironmentSource = process.env): ControlConfig {
  const issues: string[] = [];
  const environmentValue = optional(env, 'NODE_ENV') ?? 'development';
  if (!['development', 'test', 'production'].includes(environmentValue)) {
    issues.push('NODE_ENV must be development, test, or production.');
  }
  const environment = (['development', 'test', 'production'].includes(environmentValue)
    ? environmentValue
    : 'development') as ControlEnvironment;
  const production = environment === 'production';

  const host = optional(env, 'HOST') ?? (production ? '0.0.0.0' : '127.0.0.1');
  if (production && isLoopback(host)) issues.push('HOST must not bind to a loopback address in production.');
  if (production && host !== '0.0.0.0' && host !== '::') {
    issues.push('HOST must bind to 0.0.0.0 or :: in production.');
  }
  const port = integer(env, 'PORT', production ? 8080 : 4320, 1, 65_535, issues);

  const originsRaw = production
    ? required(env, 'CONTROL_ALLOWED_ORIGINS', issues)
    : optional(env, 'CONTROL_ALLOWED_ORIGINS') ?? 'http://127.0.0.1:4317,http://localhost:4317';
  const allowedOrigins = parseOrigins(originsRaw, production, issues);

  const databaseUrl = required(env, 'DATABASE_URL', issues);
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        issues.push('DATABASE_URL must use postgres: or postgresql:.');
      }
      if (production && isLoopback(parsed.hostname)) issues.push('DATABASE_URL must not use a loopback host in production.');
      if (production && (!parsed.username || !parsed.password)) issues.push('DATABASE_URL must contain database credentials in production.');
      for (const parameter of databaseSslParameters) {
        if (production && parsed.searchParams.has(parameter)) {
          issues.push(`DATABASE_URL must omit ${parameter}; node-postgres would replace the verified TLS configuration.`);
        }
      }
    } catch {
      issues.push('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
  }
  rejectUnsafeProductionValue('DATABASE_URL', databaseUrl, production, issues);

  const connectionModeValue = optional(env, 'DATABASE_CONNECTION_MODE') ?? (production ? '' : 'direct');
  if (connectionModeValue !== 'direct' && connectionModeValue !== 'session') {
    issues.push('DATABASE_CONNECTION_MODE must be direct or session; transaction pooling is not supported by this service.');
  }
  const connectionMode = (connectionModeValue === 'session' ? 'session' : 'direct') as DatabaseConnectionMode;
  const certificate = normalizeCertificate(optional(env, 'DATABASE_CA_CERT'), production, issues);

  const supabaseUrl = required(env, 'SUPABASE_URL', issues);
  if (supabaseUrl) {
    const parsed = parseHttpUrl(supabaseUrl, 'SUPABASE_URL', production, issues);
    if (parsed && ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash)) {
      issues.push('SUPABASE_URL must be the project origin without a path, query, or fragment.');
    }
  }
  rejectUnsafeProductionValue('SUPABASE_URL', supabaseUrl, production, issues);
  const publishableKey = required(env, 'SUPABASE_PUBLISHABLE_KEY', issues);
  rejectUnsafeProductionValue('SUPABASE_PUBLISHABLE_KEY', publishableKey, production, issues);

  const serviceRoleKey = optional(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const storageBucket = optional(env, 'SUPABASE_STORAGE_BUCKET');
  rejectUnsafeProductionValue('SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey, production, issues);
  rejectUnsafeProductionValue('SUPABASE_STORAGE_BUCKET', storageBucket, production, issues);
  if ((serviceRoleKey && !storageBucket) || (!serviceRoleKey && storageBucket)) {
    issues.push('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET must be configured together.');
  }

  const triggerSecretKey = optional(env, 'TRIGGER_SECRET_KEY');
  const triggerProjectRef = optional(env, 'TRIGGER_PROJECT_REF');
  rejectUnsafeProductionValue('TRIGGER_SECRET_KEY', triggerSecretKey, production, issues);
  rejectUnsafeProductionValue('TRIGGER_PROJECT_REF', triggerProjectRef, production, issues);
  if ((triggerSecretKey && !triggerProjectRef) || (!triggerSecretKey && triggerProjectRef)) {
    issues.push('TRIGGER_SECRET_KEY and TRIGGER_PROJECT_REF must be configured together.');
  }
  if (production && triggerSecretKey && !triggerSecretKey.startsWith('tr_prod_')) {
    issues.push('TRIGGER_SECRET_KEY must be a production environment key in production.');
  }
  if (triggerProjectRef && !triggerProjectRef.startsWith('proj_')) {
    issues.push('TRIGGER_PROJECT_REF must be a Trigger.dev project reference beginning with proj_.');
  }

  const buildId = production ? required(env, 'CONTROL_BUILD_ID', issues) : optional(env, 'CONTROL_BUILD_ID') ?? 'development';
  rejectUnsafeProductionValue('CONTROL_BUILD_ID', buildId, production, issues);
  if (production && ['development', 'unknown', 'latest'].includes(buildId.toLowerCase())) {
    issues.push('CONTROL_BUILD_ID must identify an immutable production build.');
  }

  const shutdownGraceMs = integer(env, 'CONTROL_SHUTDOWN_GRACE_MS', 20_000, 1_000, 25_000, issues);
  const healthProbeIntervalMs = integer(env, 'CONTROL_HEALTH_PROBE_INTERVAL_MS', 5_000, 1_000, 60_000, issues);
  const healthProbeTimeoutMs = integer(env, 'CONTROL_HEALTH_PROBE_TIMEOUT_MS', 2_000, 100, 10_000, issues);
  if (healthProbeTimeoutMs >= healthProbeIntervalMs) {
    issues.push('CONTROL_HEALTH_PROBE_TIMEOUT_MS must be shorter than CONTROL_HEALTH_PROBE_INTERVAL_MS.');
  }
  const maxConnections = integer(env, 'DATABASE_POOL_MAX', 5, 1, 20, issues);
  const connectionTimeoutMs = integer(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 5_000, 100, 30_000, issues);
  const idleTimeoutMs = integer(env, 'DATABASE_IDLE_TIMEOUT_MS', 30_000, 1_000, 300_000, issues);

  if (issues.length > 0) throw new ControlConfigError(issues);

  return Object.freeze({
    environment,
    host,
    port,
    allowedOrigins: Object.freeze(allowedOrigins),
    buildId,
    shutdownGraceMs,
    healthProbeIntervalMs,
    healthProbeTimeoutMs,
    database: Object.freeze({
      url: databaseUrl,
      connectionMode,
      maxConnections,
      connectionTimeoutMs,
      idleTimeoutMs,
      ssl: certificate ? Object.freeze({ rejectUnauthorized: true as const, ca: certificate }) : undefined,
    }),
    supabase: Object.freeze({ url: supabaseUrl, publishableKey, serviceRoleKey, storageBucket }),
    trigger: triggerSecretKey && triggerProjectRef
      ? Object.freeze({ secretKey: triggerSecretKey, projectRef: triggerProjectRef })
      : undefined,
  });
}
