import { createClient, isAuthApiError, type SupabaseClient, type User } from '@supabase/supabase-js';
import { AccountError, type AccountPrincipal, type AccountRemoteAuthority } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 8_000;

type ClientFactory = (url: string, key: string, options: Parameters<typeof createClient>[2]) => SupabaseClient;

type AuthorityOptions = {
  clientFactory?: ClientFactory;
  now?: () => number;
  timeoutMs?: number;
};

function accountActor(subjectId: string): `account:${string}` {
  if (!UUID.test(subjectId)) {
    throw new AccountError('UNAUTHORIZED', 'Account identity is invalid.', 401);
  }
  return `account:${subjectId}`;
}

function displayName(user: User): string {
  const raw = user.user_metadata?.name;
  return typeof raw === 'string' && raw.trim() && raw.trim().length <= 60 ? raw.trim() : 'Member';
}

function isUsableUser(user: User, now: number): boolean {
  if (!user.email || !user.email_confirmed_at || user.deleted_at || user.is_anonymous) return false;
  if (!user.banned_until) return true;
  const bannedUntil = new Date(user.banned_until).getTime();
  return Number.isFinite(bannedUntil) && bannedUntil <= now;
}

function principal(user: User, now: number): AccountPrincipal | null {
  if (!isUsableUser(user, now)) return null;
  const createdAt = new Date(user.created_at);
  if (!Number.isFinite(createdAt.getTime())) return null;
  return {
    provider: 'supabase',
    subjectId: user.id,
    actorId: accountActor(user.id),
    name: displayName(user),
    email: user.email!,
    createdAt,
    emailVerified: true,
  };
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  return /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(header)?.[1] ?? null;
}

function accountClient(
  url: string,
  key: string,
  factory: ClientFactory,
  timeoutMs: number,
): SupabaseClient {
  return factory(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (init?.signal) signals.push(init.signal);
        return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
      },
    },
  });
}

export function createSupabaseAccountAuthority(
  config: { url: string; publishableKey: string; secretKey: string },
  options: AuthorityOptions = {},
): AccountRemoteAuthority {
  const factory = options.clientFactory ?? createClient;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const publicClient = accountClient(config.url, config.publishableKey, factory, timeoutMs);
  const adminClient = accountClient(config.url, config.secretKey, factory, timeoutMs);

  return {
    async authenticate(authorization) {
      const token = bearer(authorization);
      if (!token) return null;
      try {
        const { data, error } = await publicClient.auth.getUser(token);
        if (error || !data.user) return null;
        return principal(data.user, now());
      } catch {
        throw new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
      }
    },

    async verifyPassword(account, password) {
      if (account.provider !== 'supabase' || typeof password !== 'string'
          || password.length < 1 || password.length > 128) return false;
      const verifier = accountClient(config.url, config.publishableKey, factory, timeoutMs);
      try {
        const { data, error } = await verifier.auth.signInWithPassword({ email: account.email, password });
        return !error && data.user?.id === account.subjectId;
      } catch {
        throw new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
      } finally {
        await verifier.auth.signOut({ scope: 'local' }).catch(() => undefined);
      }
    },

    async isActive(subjectId) {
      if (!UUID.test(subjectId)) return false;
      try {
        const { data, error } = await adminClient.auth.admin.getUserById(subjectId);
        if (error) {
          if (isAuthApiError(error) && (error.status === 404 || error.code === 'user_not_found')) return false;
          throw new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
        }
        if (!data.user) throw new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
        return isUsableUser(data.user, now());
      } catch (error) {
        if (error instanceof AccountError) throw error;
        throw new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
      }
    },

    async deleteUser(subjectId) {
      if (!UUID.test(subjectId)) {
        throw new AccountError('UNAUTHORIZED', 'Account identity is invalid.', 401);
      }
      try {
        const { error } = await adminClient.auth.admin.deleteUser(subjectId);
        if (error && error.status !== 404 && error.code !== 'user_not_found') {
          throw new AccountError('UPSTREAM', 'The account provider could not complete deletion.', 502);
        }
      } catch (error) {
        if (error instanceof AccountError) throw error;
        throw new AccountError('UPSTREAM', 'The account provider could not complete deletion.', 502);
      }
    },
  };
}
