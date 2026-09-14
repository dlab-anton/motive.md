import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createAuthClient } from 'better-auth/react';
import { loadAccountRuntimeConfig, type AccountProvider, type AccountRuntimeConfig } from './account-config';

export type AccountUser = { id: string; name: string; email: string; createdAt: Date; emailVerified: boolean };
export type AccountOAuthProvider = 'github';
export type AccountAuthError = { message: string };
export type AccountActionResult<T = unknown> = { data: T | null; error: AccountAuthError | null };
export type AccountSignUpResult<T = unknown> = AccountActionResult<T> & { requiresEmailConfirmation?: boolean };
export type AccountRuntimeSnapshot = Readonly<{
  provider: AccountProvider | null;
  oauthProviders: readonly AccountOAuthProvider[];
  data: { user: AccountUser } | null;
  isPending: boolean;
  error: Error | null;
}>;

type LooseResult = { data?: unknown; error?: { message?: string } | null };
type LocalAuthClient = {
  getSession(): Promise<LooseResult>;
  signIn: { email(input: { email: string; password: string }): Promise<LooseResult> };
  signUp: { email(input: { name: string; email: string; password: string }): Promise<LooseResult> };
  signOut(): Promise<LooseResult>;
  updateUser(input: { name: string }): Promise<LooseResult>;
  changePassword(input: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }): Promise<LooseResult>;
  revokeOtherSessions(): Promise<LooseResult>;
  deleteUser(input: { password: string }): Promise<LooseResult>;
};

type RuntimeDependencies = {
  loadConfig: () => Promise<AccountRuntimeConfig>;
  localClient: LocalAuthClient;
  createSupabase: (url: string, key: string) => SupabaseClient;
  fetch: typeof globalThis.fetch;
  browserOrigin: () => string;
};

const unavailable = (): AccountActionResult => ({ data: null, error: { message: 'The account service is unavailable. Please try again.' } });
const actionError = (error: unknown): AccountAuthError | null => {
  if (!error) return null;
  return { message: typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : 'The account request could not be completed.' };
};

function localUser(value: unknown): AccountUser | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const createdAt = input.createdAt instanceof Date ? input.createdAt : new Date(String(input.createdAt ?? ''));
  if (typeof input.id !== 'string' || typeof input.name !== 'string' || typeof input.email !== 'string' || !Number.isFinite(createdAt.getTime())) return null;
  return { id: input.id, name: input.name, email: input.email, createdAt,
    emailVerified: typeof input.emailVerified === 'boolean' ? input.emailVerified : false };
}

function userFromLocalSession(value: unknown): AccountUser | null {
  if (typeof value !== 'object' || value === null) return null;
  return localUser((value as Record<string, unknown>).user);
}

function userFromSupabase(user: User | null | undefined): AccountUser | null {
  if (!user?.email || !user.email_confirmed_at) return null;
  const createdAt = new Date(user.created_at);
  if (!Number.isFinite(createdAt.getTime())) return null;
  const metadataName = user.user_metadata?.name;
  const name = typeof metadataName === 'string' && metadataName.trim() ? metadataName.trim().slice(0, 60) : user.email.split('@')[0];
  return { id: user.id, name, email: user.email, createdAt, emailVerified: true };
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) return null;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export class BrowserAccountRuntime {
  private snapshot: AccountRuntimeSnapshot = Object.freeze({ provider: null, oauthProviders: Object.freeze([]),
    data: null, isPending: true, error: null });
  private readonly listeners = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  private refresh: Promise<void> | null = null;
  private sessionGeneration = 0;
  private config: AccountRuntimeConfig | null = null;
  private supabase: SupabaseClient | null = null;

  constructor(private readonly dependencies: RuntimeDependencies) {}

  getSnapshot = (): AccountRuntimeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(next: Omit<AccountRuntimeSnapshot, 'oauthProviders'>
    & Partial<Pick<AccountRuntimeSnapshot, 'oauthProviders'>>): void {
    this.snapshot = Object.freeze({ ...next,
      oauthProviders: Object.freeze([...(next.oauthProviders ?? this.snapshot.oauthProviders)]) });
    for (const listener of this.listeners) listener();
  }

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      try {
        this.config = await this.dependencies.loadConfig();
        if (this.config.provider === 'local-better-auth') {
          const generation = this.sessionGeneration;
          const result = await this.bounded(this.dependencies.localClient.getSession());
          if (result.error) throw result.error;
          const user = userFromLocalSession(result.data);
          if (generation === this.sessionGeneration) this.publish({ provider: this.config.provider,
            oauthProviders: [], data: user ? { user } : null, isPending: false, error: null });
          return;
        }
        this.supabase = this.dependencies.createSupabase(this.config.supabaseUrl, this.config.supabasePublishableKey);
        this.supabase.auth.onAuthStateChange((_event, session) => {
          this.sessionGeneration += 1; this.publishSupabaseSession(session);
        });
        const generation = this.sessionGeneration;
        const result = await this.bounded(this.supabase.auth.getSession());
        if (result.error) throw result.error;
        if (generation === this.sessionGeneration) this.publishSupabaseSession(result.data.session);
        void this.discoverOAuthProviders(this.config);
      } catch {
        this.publish({ provider: this.config?.provider ?? null, data: null, isPending: false,
          error: new Error('The account service is unavailable. Please try again.') });
      }
    })();
    return this.initialization;
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Account session request timed out.')), 8000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private publishSupabaseSession(session: Session | null): void {
    const user = userFromSupabase(session?.user);
    this.publish({ provider: 'supabase', data: user ? { user } : null, isPending: false, error: null });
  }

  private async discoverOAuthProviders(config: Extract<AccountRuntimeConfig, { provider: 'supabase' }>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.dependencies.fetch(new URL('/auth/v1/settings', config.supabaseUrl), {
        method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { apikey: config.supabasePublishableKey, Accept: 'application/json' },
      });
      if (!response.ok) return;
      const bytes = await readBoundedResponse(response, 16_384);
      if (!bytes) return;
      const settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (typeof settings !== 'object' || settings === null) return;
      const external = (settings as Record<string, unknown>).external;
      const providers: AccountOAuthProvider[] = typeof external === 'object' && external !== null
          && (external as Record<string, unknown>).github === true ? ['github'] : [];
      if (this.config === config && this.snapshot.provider === 'supabase') {
        this.publish({ ...this.snapshot, oauthProviders: providers });
      }
    } catch { /* Availability discovery does not affect email authentication. */ }
    finally { clearTimeout(timer); }
  }

  private async ready(): Promise<boolean> {
    await this.initialize();
    return Boolean(this.config && !this.snapshot.error);
  }

  private async refreshLocal(generation = this.sessionGeneration): Promise<void> {
    const result = await this.bounded(this.dependencies.localClient.getSession());
    if (result.error) throw result.error;
    const user = userFromLocalSession(result.data);
    if (generation === this.sessionGeneration) this.publish({ provider: 'local-better-auth',
      data: user ? { user } : null, isPending: false, error: null });
  }

  async refreshSession(): Promise<void> {
    await this.initialize();
    if (!this.config || this.snapshot.error || this.refresh) return this.refresh ?? Promise.resolve();
    const generation = this.sessionGeneration;
    this.refresh = (async () => {
      try {
        if (this.config?.provider === 'local-better-auth') await this.refreshLocal(generation);
        else {
          const result = await this.bounded(this.supabase!.auth.getSession());
          if (result.error) throw result.error;
          if (generation === this.sessionGeneration) this.publishSupabaseSession(result.data.session);
        }
      } catch {
        if (generation === this.sessionGeneration) this.publish({ provider: this.config!.provider,
          data: null, isPending: false, error: new Error('The account session could not be refreshed.') });
      } finally { this.refresh = null; }
    })();
    return this.refresh;
  }

  async signInEmail(input: { email: string; password: string }): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    if (this.config?.provider === 'local-better-auth') {
      const result = await this.dependencies.localClient.signIn.email(input); const error = actionError(result.error);
      if (!error) { const generation = ++this.sessionGeneration; await this.refreshLocal(generation); }
      return { data: result.data ?? null, error };
    }
    const result = await this.supabase!.auth.signInWithPassword(input); const error = actionError(result.error);
    if (!error) { this.sessionGeneration += 1; this.publishSupabaseSession(result.data.session); }
    return { data: result.data, error };
  }

  async signInSocial(input: { provider: AccountOAuthProvider }): Promise<AccountActionResult> {
    if (!await this.ready() || this.config?.provider !== 'supabase'
        || !this.snapshot.oauthProviders.includes(input.provider)) {
      return { data: null, error: { message: 'This sign-in provider is unavailable.' } };
    }
    const result = await this.supabase!.auth.signInWithOAuth({ provider: input.provider,
      options: { redirectTo: new URL('/', this.dependencies.browserOrigin()).toString() } });
    return { data: result.data, error: actionError(result.error) };
  }

  async signUpEmail(input: { name: string; email: string; password: string }): Promise<AccountSignUpResult> {
    if (!await this.ready()) return { ...unavailable(), requiresEmailConfirmation: false };
    if (this.config?.provider === 'local-better-auth') {
      const result = await this.dependencies.localClient.signUp.email(input); const error = actionError(result.error);
      if (!error) { const generation = ++this.sessionGeneration; await this.refreshLocal(generation); }
      return { data: result.data ?? null, error, requiresEmailConfirmation: false };
    }
    const redirect = new URL('/', this.dependencies.browserOrigin()).toString();
    const result = await this.supabase!.auth.signUp({ email: input.email, password: input.password,
      options: { data: { name: input.name }, emailRedirectTo: redirect } });
    const error = actionError(result.error);
    if (!error) { this.sessionGeneration += 1; this.publishSupabaseSession(result.data.session); }
    return { data: result.data, error, requiresEmailConfirmation: !error && result.data.session === null };
  }

  async signOut(): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    const result = this.config?.provider === 'local-better-auth'
      ? await this.dependencies.localClient.signOut() : await this.supabase!.auth.signOut({ scope: 'local' });
    const error = actionError(result.error);
    if (!error) { this.sessionGeneration += 1;
      this.publish({ provider: this.config!.provider, data: null, isPending: false, error: null }); }
    return { data: 'data' in result ? result.data ?? null : null, error };
  }

  async updateUser(input: { name: string }): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    const result = this.config?.provider === 'local-better-auth'
      ? await this.dependencies.localClient.updateUser(input) : await this.supabase!.auth.updateUser({ data: { name: input.name } });
    const error = actionError(result.error);
    if (!error && this.config?.provider === 'local-better-auth') {
      const generation = ++this.sessionGeneration; await this.refreshLocal(generation);
    }
    else if (!error && this.config?.provider === 'supabase') {
      const generation = ++this.sessionGeneration; const session = await this.bounded(this.supabase!.auth.getSession());
      if (!session.error && generation === this.sessionGeneration) this.publishSupabaseSession(session.data.session);
    }
    return { data: result.data ?? null, error };
  }

  async changePassword(input: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    if (this.config?.provider === 'local-better-auth') return this.dependencies.localClient.changePassword(input) as Promise<AccountActionResult>;
    const email = this.snapshot.data?.user.email;
    if (!email) return unavailable();
    const verified = await this.supabase!.auth.signInWithPassword({ email, password: input.currentPassword });
    if (verified.error) return { data: null, error: actionError(verified.error) };
    const changed = await this.supabase!.auth.updateUser({ password: input.newPassword });
    if (changed.error) return { data: null, error: actionError(changed.error) };
    if (input.revokeOtherSessions) {
      const revoked = await this.supabase!.auth.signOut({ scope: 'others' });
      if (revoked.error) return { data: null, error: actionError(revoked.error) };
    }
    return { data: changed.data, error: null };
  }

  async revokeOtherSessions(): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    const result = this.config?.provider === 'local-better-auth'
      ? await this.dependencies.localClient.revokeOtherSessions() : await this.supabase!.auth.signOut({ scope: 'others' });
    return { data: 'data' in result ? result.data ?? null : null, error: actionError(result.error) };
  }

  async deleteUser(input: { password: string }): Promise<AccountActionResult> {
    if (!await this.ready()) return unavailable();
    if (this.config?.provider === 'local-better-auth') {
      const result = await this.dependencies.localClient.deleteUser(input);
      const error = actionError(result.error);
      if (!error) {
        this.sessionGeneration += 1;
        this.publish({ provider: 'local-better-auth', data: null, isPending: false, error: null });
      }
      return { data: result.data ?? null, error };
    }
    let token: string;
    try { token = (await this.accountAuthorization()).accessToken ?? ''; } catch { return unavailable(); }
    const endpoint = new URL('/api/account/delete', this.dependencies.browserOrigin());
    const response = await this.dependencies.fetch(endpoint, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      return { data: null, error: { message: body?.message || body?.error || 'The account could not be deleted.' } };
    }
    const signedOut = await this.supabase!.auth.signOut({ scope: 'local' });
    const error = actionError(signedOut.error);
    if (!error) { this.sessionGeneration += 1;
      this.publish({ provider: 'supabase', data: null, isPending: false, error: null }); }
    return { data: null, error };
  }

  async accountAuthorization(): Promise<{ provider: AccountProvider; accessToken: string | null }> {
    if (!await this.ready() || !this.config) throw new Error('Account authentication is unavailable.');
    if (this.config.provider === 'local-better-auth') return { provider: this.config.provider, accessToken: null };
    const result = await this.supabase!.auth.getSession();
    if (result.error || !result.data.session?.access_token || !userFromSupabase(result.data.session.user)) {
      throw new Error('Sign in to use your account.');
    }
    return { provider: 'supabase', accessToken: result.data.session.access_token };
  }
}

const localClient = createAuthClient() as unknown as LocalAuthClient;
export const accountRuntime = new BrowserAccountRuntime({
  loadConfig: loadAccountRuntimeConfig,
  localClient,
  createSupabase: (url, key) => createClient(url, key, { auth: {
    persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
  } }),
  fetch: globalThis.fetch.bind(globalThis),
  browserOrigin: () => window.location.origin,
});
