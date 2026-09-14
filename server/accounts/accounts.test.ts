import { AuthApiError, AuthRetryableFetchError, type SupabaseClient, type User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { loadAccountConfiguration } from './config.ts';
import { createSupabaseAccountAuthority } from './supabase.ts';

const subjectId = '11111111-1111-4111-8111-111111111111';
const publicKey = `sb_publishable_${'p'.repeat(24)}`;
const secretKey = `sb_secret_${'s'.repeat(24)}`;
const agentSecret = 'agent-token-secret-with-32-bytes-minimum';

function user(overrides: Partial<User> = {}): User {
  return {
    id: subjectId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'member@example.test',
    email_confirmed_at: '2026-09-07T01:00:00.000Z',
    phone: '',
    confirmed_at: '2026-09-07T01:00:00.000Z',
    last_sign_in_at: '2026-09-07T01:00:00.000Z',
    app_metadata: { provider: 'email', roles: ['OWNER'] },
    user_metadata: { name: '  Ada  ', role: 'OWNER' },
    identities: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-07T01:00:00.000Z',
    is_anonymous: false,
    ...overrides,
  } as User;
}

function fakeClient(input: {
  getUser?: () => Promise<unknown>;
  getUserById?: () => Promise<unknown>;
  signIn?: () => Promise<unknown>;
  signOut?: () => Promise<unknown>;
  deleteUser?: () => Promise<unknown>;
}): SupabaseClient {
  return {
    auth: {
      getUser: vi.fn(input.getUser ?? (async () => ({ data: { user: null }, error: null }))),
      signInWithPassword: vi.fn(input.signIn ?? (async () => ({ data: { user: null }, error: null }))),
      signOut: vi.fn(input.signOut ?? (async () => ({ error: null }))),
      admin: {
        getUserById: vi.fn(input.getUserById ?? (async () => ({ data: { user: null }, error: null }))),
        deleteUser: vi.fn(input.deleteUser ?? (async () => ({ data: {}, error: null }))),
      },
    },
  } as unknown as SupabaseClient;
}

describe('account provider configuration', () => {
  it('defaults to the exact local public response', () => {
    expect(loadAccountConfiguration({})).toEqual({
      provider: 'local-better-auth',
      public: { provider: 'local-better-auth' },
      supabase: null,
      agentTokenSecret: null,
    });
  });

  it('publishes only the Supabase origin and publishable key', () => {
    const config = loadAccountConfiguration({
      MOTIVE_ACCOUNT_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: publicKey,
      SUPABASE_SECRET_KEY: secretKey,
      MOTIVE_AGENT_TOKEN_SECRET: agentSecret,
      NODE_ENV: 'production',
    });
    expect(config.public).toEqual({
      provider: 'supabase',
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: publicKey,
    });
    expect(JSON.stringify(config.public)).not.toContain(secretKey);
    expect(JSON.stringify(config.public)).not.toContain(agentSecret);
  });

  it.each([
    ['http://project.supabase.co', publicKey],
    ['https://project.supabase.co/?', publicKey],
    ['https://user@project.supabase.co', publicKey],
    ['https://project.supabase.co/path', publicKey],
    ['https://project.supabase.co', secretKey],
  ])('rejects unsafe public configuration %s', (url, key) => {
    expect(() => loadAccountConfiguration({
      MOTIVE_ACCOUNT_PROVIDER: 'supabase',
      SUPABASE_URL: url,
      SUPABASE_PUBLISHABLE_KEY: key,
      SUPABASE_SECRET_KEY: secretKey,
      MOTIVE_AGENT_TOKEN_SECRET: agentSecret,
      NODE_ENV: 'production',
    })).toThrow();
  });

  it('permits an explicit loopback HTTP emulator only outside production', () => {
    const config = loadAccountConfiguration({
      MOTIVE_ACCOUNT_PROVIDER: 'supabase',
      SUPABASE_URL: 'http://127.0.0.2:54321',
      SUPABASE_PUBLISHABLE_KEY: publicKey,
      SUPABASE_SECRET_KEY: secretKey,
      MOTIVE_AGENT_TOKEN_SECRET: agentSecret,
      NODE_ENV: 'test',
    });
    expect(config.public).toMatchObject({ provider: 'supabase', supabaseUrl: 'http://127.0.0.2:54321' });
  });
});

describe('Supabase account authority', () => {
  it('accepts only a confirmed, active email identity and ignores role metadata', async () => {
    const publicClient = fakeClient({ getUser: async () => ({ data: { user: user() }, error: null }) });
    const adminClient = fakeClient({});
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(publicClient)
        .mockReturnValueOnce(adminClient), now: () => Date.parse('2026-09-07T02:00:00.000Z') },
    );
    await expect(authority.authenticate(`Bearer ${'a'.repeat(32)}`)).resolves.toMatchObject({
      provider: 'supabase', subjectId, actorId: `account:${subjectId}`, name: 'Ada', emailVerified: true,
    });
    await expect(authority.authenticate('Bearer short')).resolves.toBeNull();
  });

  it.each([
    { email_confirmed_at: undefined, confirmed_at: '2026-09-07T01:00:00.000Z' },
    { is_anonymous: true },
    { deleted_at: '2026-09-07T01:30:00.000Z' },
    { banned_until: '2026-09-08T00:00:00.000Z' },
    { banned_until: 'not-a-date' },
  ])('rejects unusable identities %#', async overrides => {
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({ getUser: async () => ({ data: { user: user(overrides) }, error: null }) }))
        .mockReturnValueOnce(fakeClient({})), now: () => Date.parse('2026-09-07T02:00:00.000Z') },
    );
    await expect(authority.authenticate(`Bearer ${'b'.repeat(32)}`)).resolves.toBeNull();
  });

  it('uses and signs out a separate non-persisting password client', async () => {
    const caller = fakeClient({});
    const admin = fakeClient({});
    const verifierSignOut = vi.fn(async () => ({ error: null }));
    const verifier = fakeClient({
      signIn: async () => ({ data: { user: user() }, error: null }),
      signOut: verifierSignOut,
    });
    const factory = vi.fn()
      .mockReturnValueOnce(caller)
      .mockReturnValueOnce(admin)
      .mockReturnValueOnce(verifier);
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: factory },
    );
    await expect(authority.verifyPassword({
      provider: 'supabase', subjectId, actorId: `account:${subjectId}`, name: 'Ada',
      email: 'member@example.test', createdAt: new Date('2026-09-01'), emailVerified: true,
    }, 'correct horse battery staple')).resolves.toBe(true);
    expect(verifierSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(caller.auth.signOut).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('reports fetched active and unusable users without trusting metadata roles', async () => {
    const getUserById = vi.fn()
      .mockResolvedValueOnce({ data: { user: user() }, error: null })
      .mockResolvedValueOnce({ data: { user: user({ banned_until: '2026-09-08T00:00:00.000Z' }) }, error: null });
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({}))
        .mockReturnValueOnce(fakeClient({ getUserById })), now: () => Date.parse('2026-09-07T02:00:00.000Z') },
    );
    await expect(authority.isActive(subjectId)).resolves.toBe(true);
    await expect(authority.isActive(subjectId)).resolves.toBe(false);
    await expect(authority.isActive('not-a-uuid')).resolves.toBe(false);
    expect(getUserById).toHaveBeenCalledTimes(2);
  });

  it.each([
    new AuthApiError('User not found', 404, 'unexpected_code'),
    new AuthApiError('User not found', 400, 'user_not_found'),
  ])('treats a definitive missing remote user as inactive %#', async error => {
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({}))
        .mockReturnValueOnce(fakeClient({ getUserById: async () => ({ data: { user: null }, error }) })) },
    );
    await expect(authority.isActive(subjectId)).resolves.toBe(false);
  });

  it('treats an already-missing remote user as deleted', async () => {
    const publicClient = fakeClient({});
    const adminClient = fakeClient({
      deleteUser: async () => ({ data: {}, error: { status: 404, code: 'user_not_found' } }),
    });
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn().mockReturnValueOnce(publicClient).mockReturnValueOnce(adminClient) },
    );
    await expect(authority.deleteUser(subjectId)).resolves.toBeUndefined();
  });

  it.each([
    { data: { user: null }, error: null },
    { data: { user: null }, error: new AuthRetryableFetchError('proxy returned malformed content', 404) },
    { data: { user: null }, error: new AuthApiError('Rate limited', 429, 'rate_limit') },
    { data: { user: null }, error: new AuthApiError('Server failed', 500, 'unexpected_failure') },
    { data: { user: null }, error: new AuthApiError('Not an admin', 403, 'not_admin') },
  ])('maps an indeterminate activity response to a fixed upstream error %#', async response => {
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({}))
        .mockReturnValueOnce(fakeClient({ getUserById: async () => response })) },
    );
    await expect(authority.isActive(subjectId)).rejects.toMatchObject({
      code: 'UPSTREAM', message: 'The account provider is unavailable.', status: 502,
    });
  });

  it('sanitizes thrown activity lookup details as an upstream error', async () => {
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({}))
        .mockReturnValueOnce(fakeClient({ getUserById: async () => {
          throw new AuthRetryableFetchError('secret proxy detail', 404);
        } })) },
    );
    await expect(authority.isActive(subjectId)).rejects.toMatchObject({
      code: 'UPSTREAM', message: 'The account provider is unavailable.', status: 502,
    });
  });

  it('maps upstream transport failures to a fixed error without exposing details', async () => {
    const authority = createSupabaseAccountAuthority(
      { url: 'https://project.supabase.co', publishableKey: publicKey, secretKey },
      { clientFactory: vi.fn()
        .mockReturnValueOnce(fakeClient({ getUser: async () => { throw new Error('secret transport detail'); } }))
        .mockReturnValueOnce(fakeClient({})) },
    );
    await expect(authority.authenticate(`Bearer ${'c'.repeat(32)}`)).rejects.toMatchObject({
      code: 'UPSTREAM', message: 'The account provider is unavailable.', status: 502,
    });
  });
});
