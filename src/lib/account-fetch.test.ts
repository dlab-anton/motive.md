import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedFetch, isAccountApiPath } from './account-fetch';

describe('authenticated account fetch', () => {
  it('recognizes only browser account routes', () => {
    expect(['/api/workspace', '/api/support', '/api/profile', '/api/credits', '/api/credits/allocations',
      '/api/account/delete', '/api/funding/openrouter', '/api/participation/me', '/api/hosted-results/id/reviews']
      .every(isAccountApiPath)).toBe(true);
    expect(['/api/public/projects/circle-packing', '/api/agent/assignments', '/api/inference/v1/responses',
      '/api/auth/get-session', '/projects/circle-packing/reference-witness.json'].some(isAccountApiPath)).toBe(false);
  });

  it('adds the Supabase bearer only to an exact same-origin account request', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const accountFetch = createAuthenticatedFetch({ fetch: fetcher, origin: () => 'https://motive.example',
      authorization: async () => ({ provider: 'supabase', accessToken: 'session-token' }) });
    await accountFetch('/api/credits', { headers: { Authorization: 'caller-value' } });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://motive.example/api/credits');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
  });

  it('uses the local cookie mode without an authorization header', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const accountFetch = createAuthenticatedFetch({ fetch: fetcher, origin: () => 'http://127.0.0.1:4317',
      authorization: async () => ({ provider: 'local-better-auth', accessToken: null }) });
    await accountFetch('/api/workspace', { headers: { Authorization: 'must-be-removed' } });
    const init = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it.each(['https://foreign.example/api/credits', '/api/public/projects/circle-packing', '/api/agent/assignments',
    '/api/inference/v1/responses'])('rejects a non-account target before resolving credentials: %s', async target => {
    const fetcher = vi.fn(); const authorization = vi.fn();
    const accountFetch = createAuthenticatedFetch({ fetch: fetcher as unknown as typeof fetch,
      origin: () => 'https://motive.example', authorization });
    await expect(accountFetch(target)).rejects.toThrow('same-origin account API routes');
    expect(authorization).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
