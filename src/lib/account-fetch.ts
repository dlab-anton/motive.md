import { accountRuntime } from './account-runtime';

const exactAccountPaths = new Set(['/api/workspace', '/api/support', '/api/profile', '/api/credits',
  '/api/credits/allocations', '/api/account/delete']);
const accountPrefixes = ['/api/funding/', '/api/participation/', '/api/hosted-results/'];

export function isAccountApiPath(pathname: string): boolean {
  return exactAccountPaths.has(pathname) || accountPrefixes.some(prefix => pathname.startsWith(prefix));
}

type AuthorizationProvider = () => Promise<{ provider: 'local-better-auth' | 'supabase'; accessToken: string | null }>;

export function createAuthenticatedFetch(options: {
  fetch: typeof globalThis.fetch;
  origin: () => string;
  authorization: AuthorizationProvider;
}): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(requestUrl, options.origin());
    if (url.origin !== options.origin() || !isAccountApiPath(url.pathname) || url.username || url.password) {
      throw new Error('Authenticated account requests are limited to same-origin account API routes.');
    }
    const authorization = await options.authorization();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.delete('Authorization');
    if (authorization.provider === 'supabase') {
      if (!authorization.accessToken) throw new Error('Sign in to use your account.');
      headers.set('Authorization', `Bearer ${authorization.accessToken}`);
    }
    return options.fetch(url, { ...(input instanceof Request ? {
      method: input.method, body: input.body, signal: input.signal,
    } : {}), ...init, headers, credentials: 'same-origin', redirect: 'error' });
  };
}

export const authenticatedFetch = createAuthenticatedFetch({
  fetch: globalThis.fetch.bind(globalThis),
  origin: () => window.location.origin,
  authorization: () => accountRuntime.accountAuthorization(),
});
