import { describe, expect, it, vi } from 'vitest';
import { AccountConfigurationError, loadAccountRuntimeConfig, parseAccountRuntimeConfig } from './account-config';

const anonJwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.signature`;

describe('account runtime configuration', () => {
  it('accepts the exact local and public Supabase contracts', () => {
    expect(parseAccountRuntimeConfig({ provider: 'local-better-auth' })).toEqual({ provider: 'local-better-auth' });
    expect(parseAccountRuntimeConfig({ provider: 'supabase', supabaseUrl: 'https://example.supabase.co/',
      supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' })).toEqual({ provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' });
    expect(parseAccountRuntimeConfig({ provider: 'supabase', supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: anonJwt })).toMatchObject({ provider: 'supabase' });
  });

  it.each([
    { provider: 'local-better-auth', extra: true },
    { provider: 'supabase', supabaseUrl: 'http://remote.example', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://user:secret@remote.example', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://remote.example/path', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://remote.example?', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://remote.example#', supabasePublishableKey: 'sb_publishable_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://remote.example', supabasePublishableKey: 'sb_secret_abcdefghijklmnop' },
    { provider: 'supabase', supabaseUrl: 'https://remote.example', supabasePublishableKey: `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature` },
  ])('rejects invalid or private runtime data without exposing its value', input => {
    expect(() => parseAccountRuntimeConfig(input)).toThrow(AccountConfigurationError);
    try { parseAccountRuntimeConfig(input); } catch (error) { expect((error as Error).message).toBe('The account service configuration is unavailable.'); }
  });

  it('loads configuration from the same-origin runtime endpoint without redirects', async () => {
    const fetcher = vi.fn(async () => Response.json({ provider: 'local-better-auth' })) as unknown as typeof fetch;
    await expect(loadAccountRuntimeConfig(fetcher)).resolves.toEqual({ provider: 'local-better-auth' });
    expect(fetcher).toHaveBeenCalledWith('/api/account-config', expect.objectContaining({ method: 'GET',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  it('fails closed on an unavailable, invalid, or oversized runtime response', async () => {
    await expect(loadAccountRuntimeConfig(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).rejects.toThrow(AccountConfigurationError);
    await expect(loadAccountRuntimeConfig(vi.fn(async () => Response.json({ provider: 'unknown' })) as unknown as typeof fetch)).rejects.toThrow(AccountConfigurationError);
    await expect(loadAccountRuntimeConfig(vi.fn(async () => new Response('x'.repeat(8193))) as unknown as typeof fetch)).rejects.toThrow(AccountConfigurationError);
  });
});
