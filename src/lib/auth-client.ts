import { useEffect, useSyncExternalStore } from 'react';
import { authenticatedFetch } from './account-fetch';
import { accountRuntime, type AccountOAuthProvider, type AccountUser } from './account-runtime';
export type { AccountOAuthProvider, AccountUser } from './account-runtime';

export function useAccountProvider(): { provider: 'local-better-auth' | 'supabase' | null;
  oauthProviders: readonly AccountOAuthProvider[]; isPending: boolean; error?: Error | null } {
  useAccountSessionRefresh();
  return useSyncExternalStore(accountRuntime.subscribe, accountRuntime.getSnapshot, accountRuntime.getSnapshot);
}

function useAccountSessionRefresh(): void {
  useEffect(() => {
    void accountRuntime.initialize();
    const refresh = () => { if (!document.hidden) void accountRuntime.refreshSession(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
}

export const authClient = {
  useSession() {
    useAccountSessionRefresh();
    return useSyncExternalStore(accountRuntime.subscribe, accountRuntime.getSnapshot, accountRuntime.getSnapshot);
  },
  signIn: {
    email: (input: { email: string; password: string }) => accountRuntime.signInEmail(input),
    social: (input: { provider: AccountOAuthProvider }) => accountRuntime.signInSocial(input),
  },
  signUp: { email: (input: { name: string; email: string; password: string }) => accountRuntime.signUpEmail(input) },
  signOut: () => accountRuntime.signOut(),
  updateUser: (input: { name: string }) => accountRuntime.updateUser(input),
  changePassword: (input: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }) => accountRuntime.changePassword(input),
  revokeOtherSessions: () => accountRuntime.revokeOtherSessions(),
  deleteUser: (input: { password: string }) => accountRuntime.deleteUser(input),
};

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'The account service is unavailable. Please try again.');
  return data as T;
}
