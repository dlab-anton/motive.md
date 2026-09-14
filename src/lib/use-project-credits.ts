import { useEffect, useRef, useState } from 'react';
import type { AccountUser } from './auth-client';
import type { AllocateCreditsResponse, CreditAllocation, CreditWallet } from './credits';
import { authenticatedFetch } from './account-fetch';

type PendingAllocation = { key: string; project: 'circle-packing'; amount: number };

export function useProjectCredits(user: AccountUser | null) {
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [loading, setLoading] = useState(Boolean(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<CreditAllocation | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef<PendingAllocation | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void authenticatedFetch('/api/credits', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Your credits couldn’t be loaded. Please try again.');
        const value = await response.json() as CreditWallet;
        if (value.unit !== 'motive_credit' || !Number.isSafeInteger(value.available) || !Array.isArray(value.allocations)) throw new Error('Your credit record is unavailable.');
        if (!controller.signal.aborted) setWallet(value);
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Your credits couldn’t be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.id, reload]);

  async function allocate(amount: number) {
    if (!user || locked.current || loading || !wallet) return;
    const attempt = pending.current ?? { key: crypto.randomUUID(), project: 'circle-packing' as const, amount };
    if (!pending.current && (!Number.isSafeInteger(amount) || amount < 1 || amount > wallet.available)) return;
    pending.current = attempt; locked.current = true; setBusy(true); setError('');
    try {
      const response = await authenticatedFetch('/api/credits/allocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: JSON.stringify({ project: attempt.project, amount: attempt.amount }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) { pending.current = null; setRetryPending(false); }
        throw new Error(typeof result.error === 'string' ? result.error : 'Your allocation couldn’t be confirmed.');
      }
      const value = result as AllocateCreditsResponse;
      if (value.wallet?.unit !== 'motive_credit' || !Array.isArray(value.wallet.allocations) || typeof value.receipt?.id !== 'string') throw new Error('Your allocation response couldn’t be confirmed.');
      setWallet(value.wallet); setReceipt(value.receipt); pending.current = null; setRetryPending(false);
    } catch (error) {
      setRetryPending(Boolean(pending.current));
      setError(error instanceof Error ? error.message : 'Your allocation couldn’t be confirmed.');
    } finally { locked.current = false; setBusy(false); }
  }

  return { wallet, loading, busy, error, receipt, retryPending, allocate, reload: () => setReload(value => value + 1) };
}
