import { useEffect, useState } from 'react';
import { authenticatedFetch } from './account-fetch';
import type { SubmissionOwnershipProjection } from './participation';

type Observation = { accountId: string; values: Map<string, boolean> };

/** Historical attribution only. Review and spending authority remain server checks. */
export function useSubmissionOwnership(accountId: string | null, submissionIds: readonly string[]) {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [failure, setFailure] = useState<{ accountId: string; batch: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const values = observation?.accountId === accountId ? observation.values : null;
  const batch = accountId ? [...new Set(submissionIds)].filter(id => !values?.has(id)).sort().slice(0, 64).join(',') : '';
  useEffect(() => {
    if (!accountId || !batch) return;
    const controller = new AbortController();
    const requested = batch.split(',');
    void authenticatedFetch(`/api/participation/submission-ownership?ids=${encodeURIComponent(batch)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    }).then(async response => {
      if (!response.ok) throw new Error('Ownership observation unavailable.');
      const result = await response.json() as SubmissionOwnershipProjection;
      if (result.format !== 'motive.submission-ownership/0.1' || !Array.isArray(result.ownedSubmissionIds)
        || result.ownedSubmissionIds.some(id => !requested.includes(id))
        || new Set(result.ownedSubmissionIds).size !== result.ownedSubmissionIds.length) throw new Error('Invalid ownership observation.');
      if (controller.signal.aborted) return;
      const owned = new Set(result.ownedSubmissionIds);
      setObservation(previous => {
        const next = new Map(previous?.accountId === accountId ? previous.values : []);
        for (const id of requested) next.set(id, owned.has(id));
        return { accountId, values: next };
      });
      setFailure(null);
    }).catch(() => { if (!controller.signal.aborted) setFailure({ accountId, batch }); });
    return () => controller.abort();
  }, [accountId, batch, revision]);
  return {
    // Unknown must not become "somebody else's work" for review controls.
    owned: (id: string): boolean | undefined => values?.get(id),
    unavailable: Boolean(accountId && failure?.accountId === accountId && failure.batch === batch),
    reload: () => { setFailure(null); setRevision(value => value + 1); },
  };
}
