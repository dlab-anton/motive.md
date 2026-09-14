import { useEffect, useRef, useState } from 'react';
import { api, type AccountUser } from './auth-client';
import { applySupportAction, emptyState, loadState, STORAGE_KEY, type SupportAction, type SupportState } from './support';

export function useWorkspace(user: AccountUser | null) {
  const [state, setState] = useState<SupportState>(() => user ? emptyState : loadState());
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(Boolean(user));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ support: SupportState; bio: string }>('workspace').then(data => { if (!cancelled) { setState(data.support); setBio(data.bio); } }).catch(error => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id]);
  useEffect(() => { if (!user) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { setError('Your browser could not save this preview.'); } } }, [state, user?.id]);
  async function send(action: SupportAction) {
    if (lock.current || loading || error) throw new Error('Please wait for your account to finish loading, then try again.');
    lock.current = true; setBusy(true);
    try {
      if (user) setState(await api<SupportState>('support', action));
      else setState(current => applySupportAction(current, action));
    } finally { lock.current = false; setBusy(false); }
  }
  return { state, bio, setBio, loading, error, busy, send };
}
