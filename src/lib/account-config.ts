export type AccountProvider = 'local-better-auth' | 'supabase';
export type AccountRuntimeConfig =
  | Readonly<{ provider: 'local-better-auth' }>
  | Readonly<{ provider: 'supabase'; supabaseUrl: string; supabasePublishableKey: string }>;

export class AccountConfigurationError extends Error {
  constructor() {
    super('The account service configuration is unavailable.');
    this.name = 'AccountConfigurationError';
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function validSupabaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('*')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && !value.includes('?') && !value.includes('#') && url.port !== '0';
  } catch { return false; }
}

function jwtHasAnonRole(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as unknown;
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      && (payload as Record<string, unknown>).role === 'anon';
  } catch { return false; }
}

function validPublishableKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 4096 || /\s/.test(value)) return false;
  return /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(value) || jwtHasAnonRole(value);
}

export function parseAccountRuntimeConfig(value: unknown): AccountRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AccountConfigurationError();
  const input = value as Record<string, unknown>;
  if (input.provider === 'local-better-auth' && exactKeys(input, ['provider'])) {
    return Object.freeze({ provider: 'local-better-auth' });
  }
  if (input.provider === 'supabase' && exactKeys(input, ['provider', 'supabaseUrl', 'supabasePublishableKey'])
      && validSupabaseUrl(input.supabaseUrl) && validPublishableKey(input.supabasePublishableKey)) {
    return Object.freeze({ provider: 'supabase', supabaseUrl: new URL(input.supabaseUrl).origin,
      supabasePublishableKey: input.supabasePublishableKey });
  }
  throw new AccountConfigurationError();
}

export async function loadAccountRuntimeConfig(fetcher: typeof fetch = fetch): Promise<AccountRuntimeConfig> {
  let response: Response;
  try {
    response = await fetcher('/api/account-config', { method: 'GET', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  } catch { throw new AccountConfigurationError(); }
  if (!response.ok) throw new AccountConfigurationError();
  const text = await response.text();
  if (text.length > 8192) throw new AccountConfigurationError();
  try { return parseAccountRuntimeConfig(JSON.parse(text)); } catch { throw new AccountConfigurationError(); }
}
