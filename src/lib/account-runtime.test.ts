import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAccountRuntime } from './account-runtime';

const confirmedUser = { id: '5df1c53e-0580-4fe6-8383-a1b7b0bb61d6', email: 'member@example.test',
  email_confirmed_at: '2026-09-07T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', user_metadata: { name: 'Member Name' } };
const session = { access_token: 'session-access-token', user: confirmedUser } as unknown as Session;

function localClient() {
  const user = { id: 'local-user', name: 'Local Member', email: 'local@example.test',
    createdAt: '2026-09-01T10:00:00.000Z', emailVerified: false };
  return {
    getSession: vi.fn(async () => ({ data: { user }, error: null })),
    signIn: { email: vi.fn(async () => ({ data: { user }, error: null })) },
    signUp: { email: vi.fn(async () => ({ data: { user }, error: null })) },
    signOut: vi.fn(async () => ({ data: null, error: null })),
    updateUser: vi.fn(async () => ({ data: { user }, error: null })),
    changePassword: vi.fn(async () => ({ data: null, error: null })),
    revokeOtherSessions: vi.fn(async () => ({ data: null, error: null })),
    deleteUser: vi.fn(async (_input: { password: string }) => ({
      data: null,
      error: null as { message: string } | null,
    })),
  };
}

function supabaseClient() {
  let current: Session | null = session; let listener: ((event: string, session: Session | null) => void) | null = null;
  const auth = {
    onAuthStateChange: vi.fn(callback => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; }),
    getSession: vi.fn(async () => ({ data: { session: current }, error: null })),
    signUp: vi.fn(async () => ({ data: { user: confirmedUser, session: null }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { user: confirmedUser, session }, error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: { provider: 'github', url: 'https://project.supabase.co/auth/v1/authorize' }, error: null })),
    updateUser: vi.fn(async () => ({ data: { user: confirmedUser }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  return { client: { auth } as unknown as SupabaseClient, auth,
    emit(next: Session | null) { current = next; listener?.('SIGNED_IN', next); } };
}

describe('browser account runtime', () => {
  it('preserves local BetterAuth sessions and method behavior', async () => {
    const local = localClient();
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'local-better-auth' }),
      localClient: local, createSupabase: vi.fn(), fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'http://127.0.0.1:4317' });
    await runtime.initialize();
    expect(runtime.getSnapshot()).toMatchObject({ provider: 'local-better-auth', isPending: false,
      data: { user: { id: 'local-user', name: 'Local Member', createdAt: expect.any(Date) } } });
    expect(await runtime.accountAuthorization()).toEqual({ provider: 'local-better-auth', accessToken: null });
    await runtime.revokeOtherSessions(); expect(local.revokeOtherSessions).toHaveBeenCalledOnce();
    await runtime.deleteUser({ password: 'current-password' });
    expect(local.deleteUser).toHaveBeenCalledWith({ password: 'current-password' });
    expect(runtime.getSnapshot()).toMatchObject({ provider: 'local-better-auth', data: null, isPending: false, error: null });
  });

  it('preserves the local session when account deletion fails', async () => {
    const local = localClient();
    local.deleteUser.mockResolvedValueOnce({ data: null, error: { message: 'Password confirmation failed.' } });
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'local-better-auth' }),
      localClient: local, createSupabase: vi.fn(), fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'http://127.0.0.1:4317' });
    await runtime.initialize();
    await expect(runtime.deleteUser({ password: 'wrong-password' })).resolves.toEqual({
      data: null, error: { message: 'Password confirmation failed.' },
    });
    expect(runtime.getSnapshot()).toMatchObject({ provider: 'local-better-auth',
      data: { user: { id: 'local-user' } }, isPending: false, error: null });
  });

  it('deduplicates focus refresh and prevents its stale session from undoing a newer sign-out', async () => {
    const local = localClient(); let finishRefresh!: (value: Awaited<ReturnType<typeof local.getSession>>) => void;
    local.getSession.mockImplementationOnce(async () => ({ data: { user: { id: 'local-user', name: 'Local Member',
      email: 'local@example.test', createdAt: '2026-09-01T10:00:00.000Z', emailVerified: false } }, error: null }))
      .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'local-better-auth' }),
      localClient: local, createSupabase: vi.fn(), fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'http://127.0.0.1:4317' });
    await runtime.initialize();
    const first = runtime.refreshSession(); const second = runtime.refreshSession();
    await Promise.resolve();
    await runtime.signOut();
    finishRefresh({ data: { user: { id: 'local-user', name: 'Stale Member', email: 'local@example.test',
      createdAt: '2026-09-01T10:00:00.000Z', emailVerified: false } }, error: null });
    await Promise.all([first, second]);
    expect(local.getSession).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().data).toBeNull();
  });

  it('reports confirmation, maintains the Supabase session, and uses a fixed same-origin redirect', async () => {
    const local = localClient(); const supabase = supabaseClient();
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: local, createSupabase: () => supabase.client, fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    expect(local.getSession).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({ provider: 'supabase', data: { user: {
      id: confirmedUser.id, name: 'Member Name', emailVerified: true, createdAt: expect.any(Date) } } });
    const signup = await runtime.signUpEmail({ name: 'New Member', email: 'new@example.test', password: 'long-password' });
    expect(signup).toMatchObject({ error: null, requiresEmailConfirmation: true });
    expect(supabase.auth.signUp).toHaveBeenCalledWith(expect.objectContaining({ options: {
      data: { name: 'New Member' }, emailRedirectTo: 'https://motive.example/' } }));
    supabase.emit(session); expect((await runtime.accountAuthorization()).accessToken).toBe('session-access-token');
  });

  it('discovers GitHub independently and starts OAuth with the fixed same-origin redirect', async () => {
    const supabase = supabaseClient();
    const fetcher = vi.fn(async () => Response.json({ external: { github: true, google: false } })) as unknown as typeof fetch;
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: localClient(), createSupabase: () => supabase.client, fetch: fetcher,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    await vi.waitFor(() => expect(runtime.getSnapshot().oauthProviders).toEqual(['github']));
    expect(fetcher).toHaveBeenCalledWith(new URL('https://project.supabase.co/auth/v1/settings'),
      expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error',
        headers: { apikey: 'sb_publishable_abcdefghijklmnop', Accept: 'application/json' } }));
    await expect(runtime.signInSocial({ provider: 'github' })).resolves.toMatchObject({ error: null });
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'github',
      options: { redirectTo: 'https://motive.example/' } });
  });

  it('still discovers providers when the initial auth callback supersedes getSession', async () => {
    const supabase = supabaseClient();
    let finishSession!: (value: { data: { session: Session | null }; error: null }) => void;
    supabase.auth.getSession.mockImplementationOnce(() => new Promise(resolve => { finishSession = resolve; }));
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: localClient(), createSupabase: () => supabase.client,
      fetch: vi.fn(async () => Response.json({ external: { github: true } })) as unknown as typeof fetch,
      browserOrigin: () => 'https://motive.example' });
    const initialization = runtime.initialize();
    await vi.waitFor(() => expect(supabase.auth.onAuthStateChange).toHaveBeenCalledOnce());
    supabase.emit(session);
    finishSession({ data: { session }, error: null });
    await initialization;
    await vi.waitFor(() => expect(runtime.getSnapshot().oauthProviders).toEqual(['github']));
  });

  it('keeps email auth available when provider discovery fails and refuses disabled or local social sign-in', async () => {
    const supabase = supabaseClient();
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: localClient(), createSupabase: () => supabase.client,
      fetch: vi.fn(async () => { throw new Error('settings unavailable'); }) as unknown as typeof fetch,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    await Promise.resolve();
    expect(runtime.getSnapshot()).toMatchObject({ provider: 'supabase', oauthProviders: [], error: null });
    await expect(runtime.signInEmail({ email: confirmedUser.email, password: 'password' })).resolves.toMatchObject({ error: null });
    await expect(runtime.signInSocial({ provider: 'github' })).resolves.toEqual({ data: null,
      error: { message: 'This sign-in provider is unavailable.' } });
    expect(supabase.auth.signInWithOAuth).not.toHaveBeenCalled();

    const local = localClient();
    const localRuntime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'local-better-auth' }),
      localClient: local, createSupabase: vi.fn(), fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'http://127.0.0.1:4317' });
    await localRuntime.initialize();
    await expect(localRuntime.signInSocial({ provider: 'github' })).resolves.toMatchObject({ error: expect.any(Object) });
    expect(localRuntime.getSnapshot().oauthProviders).toEqual([]);
  });

  it('verifies the current password before changing it and revokes only other Supabase sessions', async () => {
    const supabase = supabaseClient();
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: localClient(), createSupabase: () => supabase.client, fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    await expect(runtime.changePassword({ currentPassword: 'old-password', newPassword: 'new-password-long', revokeOtherSessions: true }))
      .resolves.toMatchObject({ error: null });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({ email: confirmedUser.email, password: 'old-password' });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-long' });
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    await runtime.revokeOtherSessions();
    expect(supabase.auth.signOut).toHaveBeenLastCalledWith({ scope: 'others' });
  });

  it('sends account deletion to the fixed API with the current bearer, then clears only this browser session', async () => {
    const supabase = supabaseClient();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/v1/settings')
      ? Response.json({ external: { github: false } }) : new Response(null, { status: 204 })) as unknown as typeof fetch;
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => ({ provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' }),
      localClient: localClient(), createSupabase: () => supabase.client, fetch: fetcher,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    await expect(runtime.deleteUser({ password: 'current-password' })).resolves.toMatchObject({ error: null });
    const [, [url, init]] = Array.from((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.entries())
      .find(([, call]) => String(call[0]).endsWith('/api/account/delete'))!;
    expect(String(url)).toBe('https://motive.example/api/account/delete');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-access-token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"password":"current-password"}' });
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('fails closed when runtime configuration cannot load and never calls local auth', async () => {
    const local = localClient();
    const runtime = new BrowserAccountRuntime({ loadConfig: async () => { throw new Error('offline'); },
      localClient: local, createSupabase: vi.fn(), fetch: vi.fn() as unknown as typeof fetch,
      browserOrigin: () => 'https://motive.example' });
    await runtime.initialize();
    expect(runtime.getSnapshot()).toMatchObject({ provider: null, isPending: false, data: null, error: expect.any(Error) });
    expect((await runtime.signInEmail({ email: 'x@example.test', password: 'password' })).error).toBeTruthy();
    expect(local.signIn.email).not.toHaveBeenCalled(); expect(local.getSession).not.toHaveBeenCalled();
  });
});
