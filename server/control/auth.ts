import { createClient } from '@supabase/supabase-js';

export type Principal = { id: string };
export type Authenticate = (token: string) => Promise<Principal | null>;

/** Check identity with Auth; never authorize roles from editable user metadata. */
export function createAuthenticator(url: string, publishableKey: string): Authenticate {
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
  return async token => {
    const { data, error } = await client.auth.getUser(token);
    return error || !data.user ? null : { id: data.user.id };
  };
}
