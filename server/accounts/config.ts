import { isIP } from 'node:net';
import type { AccountProvider, AccountPublicConfig } from './types.ts';

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type AccountConfiguration = {
  provider: AccountProvider;
  public: AccountPublicConfig;
  supabase: { url: string; publishableKey: string; secretKey: string } | null;
  agentTokenSecret: string | null;
};

function value(env: EnvironmentSource, name: string): string | null {
  return env[name]?.trim() || null;
}

function jwtRole(candidate: string, role: 'anon' | 'service_role'): boolean {
  try {
    const parts = candidate.split('.');
    if (parts.length !== 3) return false;
    const body = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return body.role === role;
  } catch {
    return false;
  }
}

function supabaseOrigin(raw: string, production: boolean): string {
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  const allowedProtocol = parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && loopback && !production);
  if (!allowedProtocol || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || raw.includes('?') || raw.includes('#')) {
    throw new Error('ACCOUNT_SUPABASE_URL_INVALID');
  }
  return parsed.origin;
}

function isPublishableKey(candidate: string): boolean {
  return /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(candidate) || jwtRole(candidate, 'anon');
}

function isSecretKey(candidate: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]{20,}$/.test(candidate) || jwtRole(candidate, 'service_role');
}

export function loadAccountConfiguration(env: EnvironmentSource = process.env): AccountConfiguration {
  const provider = value(env, 'MOTIVE_ACCOUNT_PROVIDER') ?? 'local-better-auth';
  if (provider !== 'local-better-auth' && provider !== 'supabase') {
    throw new Error('MOTIVE_ACCOUNT_PROVIDER_INVALID');
  }
  if (provider === 'local-better-auth') {
    return {
      provider,
      public: { provider },
      supabase: null,
      agentTokenSecret: value(env, 'BETTER_AUTH_SECRET'),
    };
  }

  const rawUrl = value(env, 'SUPABASE_URL');
  const publishableKey = value(env, 'SUPABASE_PUBLISHABLE_KEY');
  const secretKey = value(env, 'SUPABASE_SECRET_KEY') ?? value(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const agentTokenSecret = value(env, 'MOTIVE_AGENT_TOKEN_SECRET');
  if (!rawUrl || !publishableKey || !secretKey || !agentTokenSecret) {
    throw new Error('SUPABASE_ACCOUNT_CONFIGURATION_REQUIRED');
  }
  if (!isPublishableKey(publishableKey)
      || publishableKey.startsWith('sb_secret_')
      || jwtRole(publishableKey, 'service_role')) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY_INVALID');
  }
  if (!isSecretKey(secretKey)) throw new Error('SUPABASE_SECRET_KEY_INVALID');
  if (Buffer.byteLength(agentTokenSecret, 'utf8') < 32) {
    throw new Error('MOTIVE_AGENT_TOKEN_SECRET_INVALID');
  }

  const url = supabaseOrigin(rawUrl, value(env, 'NODE_ENV') === 'production');
  return {
    provider,
    public: { provider, supabaseUrl: url, supabasePublishableKey: publishableKey },
    supabase: { url, publishableKey, secretKey },
    agentTokenSecret,
  };
}