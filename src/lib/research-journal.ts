import { useEffect, useState } from 'react';
import type { ResearchJournalEntry, ResearchJournalPage } from './participation';
import { authenticatedFetch } from './account-fetch';

export const journalPath = '/api/public/projects/circle-packing/research-updates';
export const journalIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function readJournalPage(mine: boolean, before: string, signal: AbortSignal): Promise<ResearchJournalPage> {
  const path = `${mine ? '/api/participation/research-updates' : journalPath}?before=${encodeURIComponent(before)}`;
  const response = await (mine ? authenticatedFetch : fetch)(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 404
    ? 'The place saved in this journal is no longer available. Return to the latest experiments to continue.'
    : 'Older experiments could not be loaded. Your current place is saved; try again.');
  return response.json() as Promise<ResearchJournalPage>;
}

/** One focused read per navigation/retry. Older links never walk the whole journal. */
export function useJournalEntry(id: string | null) {
  const [value, setValue] = useState<{ id: string; entry?: ResearchJournalEntry; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!id || !journalIdPattern.test(id)) return;
    const controller = new AbortController();
    void fetch(`${journalPath}/${id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), credentials: 'same-origin', redirect: 'error' })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? 'This experiment is not available in the public project.' : 'This experiment could not be loaded. Please try again.');
        const entry = await response.json() as ResearchJournalEntry;
        if (!controller.signal.aborted) setValue({ id, entry });
      }).catch(error => {
        if (!controller.signal.aborted) setValue({ id, error: error instanceof Error ? error.message : 'This experiment could not be loaded.' });
      });
    return () => controller.abort();
  }, [id, retry]);
  const current = value?.id === id ? value : null;
  return { entry: current?.entry ?? null, error: current?.error ?? '', loading: Boolean(id && !current),
    reload: () => { setValue(null); setRetry(value => value + 1); } };
}

/** Preserve the first observation of each entry and the server's page order. */
export function mergeJournalEntries(...groups: ResearchJournalEntry[][]): ResearchJournalEntry[] {
  const seen = new Set<string>();
  return groups.flatMap(group => group.filter(item => {
    if (seen.has(item.submission.id)) return false;
    seen.add(item.submission.id);
    return true;
  }));
}

/** Read only exact later citations of this task; preserve loaded rows on retry. */
export function useCitingResearch(id: string) {
  const [cursor, setCursor] = useState({ id: '', before: '' });
  const [retry, setRetry] = useState(0);
  const [value, setValue] = useState<{
    id: string; items: ResearchJournalEntry[]; nextCursor: string | null; loading: boolean; error: string;
  } | null>(null);
  const before = cursor.id === id ? cursor.before : '';
  useEffect(() => {
    if (!journalIdPattern.test(id)) return;
    const controller = new AbortController();
    setValue(previous => previous?.id === id ? { ...previous, loading: true, error: '' }
      : { id, items: [], nextCursor: null, loading: true, error: '' });
    const path = `${journalPath}/${id}/citing${before ? `?before=${encodeURIComponent(before)}` : ''}`;
    void fetch(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      credentials: 'same-origin', redirect: 'error' }).then(async response => {
      if (!response.ok) throw new Error('Later work could not be loaded.');
      const page = await response.json() as ResearchJournalPage;
      if (page.format !== 'motive.research-journal-page/0.1' || !Array.isArray(page.items)
        || page.nextCursor !== null && (!journalIdPattern.test(page.nextCursor) || page.nextCursor === before)) {
        throw new Error('Later work could not be loaded.');
      }
      if (!controller.signal.aborted) setValue(previous => ({ id,
        items: before && previous?.id === id ? mergeJournalEntries(previous.items, page.items) : page.items,
        nextCursor: page.nextCursor, loading: false, error: '' }));
    }).catch(() => {
      if (!controller.signal.aborted) setValue(previous => ({ id,
        items: previous?.id === id ? previous.items : [], nextCursor: previous?.id === id ? previous.nextCursor : null,
        loading: false, error: 'Later work could not be loaded.' }));
    });
    return () => controller.abort();
  }, [id, before, retry]);
  const current = value?.id === id ? value : null;
  return { items: current?.items ?? [], nextCursor: current?.nextCursor ?? null,
    loading: current?.loading ?? true, error: current?.error ?? '',
    retry: () => setRetry(count => count + 1),
    loadMore: () => { if (current?.nextCursor && !current.loading) setCursor({ id, before: current.nextCursor }); } };
}
