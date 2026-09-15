import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ParticipationPublicProjection, PublicResearchHandoff } from '@/lib/participation';
import { HandoffReadError, readHandoff, readHandoffPage } from '@/lib/research-handoffs';
import { QueueNext, TaskAgent, TaskStatusIcon, TaskTime } from './task-row-parts';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PUBLIC_HEAD_LIMIT = 6;

const merge = (first: PublicResearchHandoff[], next: PublicResearchHandoff[]) => {
  const seen = new Set(first.map(item => item.id));
  return [...first, ...next.filter(item => !seen.has(item.id))];
};

/** Account changes remount this hook with its containing journal. */
export function useResearchHandoffs({ data, onlyMine }: { data: ParticipationPublicProjection | null; onlyMine: boolean }) {
  const slug = useProjectSlug();
  const location = useLocation();
  const requested = location.hash.startsWith('#handoff-') ? location.hash.slice(9) : '';
  const requestedId = UUID.test(requested) ? requested : '';
  const [history, setHistory] = useState<PublicResearchHandoff[] | null>(null);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [stale, setStale] = useState(false);
  const [retryBefore, setRetryBefore] = useState<string | null>(null);
  const [focused, setFocused] = useState<PublicResearchHandoff | null>(null);
  const [focusError, setFocusError] = useState('');
  const [focusAttempt, setFocusAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const changes = useRef(0);
  const scrolled = useRef('');
  const recent = onlyMine ? [] : data?.recentResearchHandoffs ?? [];
  const items = history ?? recent;
  const continuation = cursor !== undefined ? cursor : onlyMine ? null
    : recent.length === PUBLIC_HEAD_LIMIT ? recent.at(-1)?.id ?? null : null;
  const present = items.some(item => item.id === requestedId);
  const haveProject = Boolean(data);

  async function load(before: string | null): Promise<boolean> {
    if (pending.current) return false;
    const controller = new AbortController(); pending.current = controller;
    const startedAtChange = changes.current;
    const retained = before ? items : [];
    if (before) setHistory(retained);
    setBusy(true); setError(''); setRetryBefore(before);
    try {
      const page = await readHandoffPage(onlyMine, before, controller.signal, slug);
      if (controller.signal.aborted) return false;
      setHistory(merge(retained, page.items)); setCursor(page.nextCursor); setDenied(false);
      setStale(previous => (before ? previous : false) || changes.current !== startedAtChange);
      return true;
    } catch (caught) {
      if (controller.signal.aborted) return false;
      if (caught instanceof HandoffReadError && caught.reset) {
        setHistory([]); setCursor(null); setRetryBefore(null);
      }
      setDenied(caught instanceof HandoffReadError && caught.accessDenied);
      setError(caught instanceof Error ? caught.message : 'These stopped tasks could not be loaded. Please try again.');
      return false;
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const changed = () => { changes.current += 1; setStale(true); };
    window.addEventListener('motive:project-changed', changed);
    if (onlyMine) void load(null);
    return () => { pending.current?.abort(); pending.current = null; window.removeEventListener('motive:project-changed', changed); };
  }, [onlyMine]);

  useEffect(() => {
    setFocused(null); setFocusError('');
    if (onlyMine || !requestedId || !haveProject || present) return;
    const controller = new AbortController();
    void readHandoff(requestedId, controller.signal, slug).then(item => {
      if (!controller.signal.aborted) setFocused(item);
    }).catch(caught => {
      if (!controller.signal.aborted) setFocusError(caught instanceof Error ? caught.message : 'This stopped task could not be loaded.');
    });
    return () => controller.abort();
  }, [onlyMine, requestedId, haveProject, present, focusAttempt]);

  const canFocus = present || focused?.id === requestedId;
  useEffect(() => { scrolled.current = ''; }, [requestedId]);
  useEffect(() => {
    if (onlyMine || !requestedId || !canFocus || scrolled.current === requestedId) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`handoff-${requestedId}`);
      if (element) { element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true }); scrolled.current = requestedId; }
    });
    return () => cancelAnimationFrame(frame);
  }, [onlyMine, requestedId, canFocus]);

  function reset() {
    pending.current?.abort(); pending.current = null;
    setBusy(false); setHistory(null); setCursor(undefined); setError(''); setDenied(false); setStale(false); setRetryBefore(null);
    if (onlyMine) void load(null);
  }

  return {
    items, focused: focused && !present ? focused : null, requestedId, busy, error, denied, stale: stale && history !== null,
    focusError, initialLoading: onlyMine && history === null && busy, browsingHistory: history !== null,
    hasMore: continuation !== null,
    loadOlder: () => continuation ? load(continuation) : Promise.resolve(false),
    retry: () => load(retryBefore),
    retryFocus: () => setFocusAttempt(value => value + 1),
    reset,
  };
}

export function HandoffRow({ item, focused, now }: { item: PublicResearchHandoff; focused: boolean; now: number }) {
  const slug = useProjectSlug();
  return <details className="research-handoff-card task-row" id={`handoff-${item.id}`} tabIndex={-1} open={focused || undefined}>
    <summary><TaskAgent name={item.agentName} /><span className="task-main"><strong className="task-title" title={item.intent?.proposal}>{item.intent?.proposal || 'Stopped before completing the experiment'}</strong></span><TaskStatusIcon kind="stopped" /><TaskTime value={item.createdAt} now={now} /></summary>
    <div className="handoff-note task-row-detail"><p className="eyebrow">Why I stopped</p><p>{item.stopReason}</p>
      {item.intent ? <p><strong>Expected:</strong> {item.intent.expectation}</p> : null}
      <p className="field-hint">Agent-reported stop reason. This does not establish that the approach failed.</p>
      <QueueNext />
      <a href={`${projectLink(slug)}&tab=updates#handoff-${item.id}`}>Link to this handoff</a>
    </div>
  </details>;
}
