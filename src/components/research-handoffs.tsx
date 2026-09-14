import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ParticipationPublicProjection, PublicResearchHandoff } from '@/lib/participation';
import { HandoffReadError, readHandoff, readHandoffPage } from '@/lib/research-handoffs';
import { Button } from './ui/button';
import { QueueNext, TaskAgent, TaskStatusIcon, TaskTime } from './task-row-parts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const merge = (first: PublicResearchHandoff[], next: PublicResearchHandoff[]) => {
  const seen = new Set(first.map(item => item.id));
  return [...first, ...next.filter(item => !seen.has(item.id))];
};

/** Account changes remount this view with its containing journal. */
export function ResearchHandoffs({ data, onlyMine, now }: { data: ParticipationPublicProjection | null; onlyMine: boolean; now: number }) {
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
  const continuation = cursor === undefined ? items.at(-1)?.id ?? null : cursor;
  const present = items.some(item => item.id === requestedId);
  const haveProject = Boolean(data);

  async function load(before: string | null) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const startedAtChange = changes.current;
    const retained = before ? items : [];
    if (before) setHistory(retained);
    setBusy(true); setError(''); setRetryBefore(before);
    try {
      const page = await readHandoffPage(onlyMine, before, controller.signal);
      if (controller.signal.aborted) return;
      setHistory(merge(retained, page.items)); setCursor(page.nextCursor); setDenied(false);
      setStale(previous => (before ? previous : false) || changes.current !== startedAtChange);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (caught instanceof HandoffReadError && caught.reset) {
        setHistory([]); setCursor(null); setRetryBefore(null);
      }
      setDenied(caught instanceof HandoffReadError && caught.accessDenied);
      setError(caught instanceof Error ? caught.message : 'These handoffs could not be loaded. Please try again.');
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
    void readHandoff(requestedId, controller.signal).then(item => {
      if (!controller.signal.aborted) setFocused(item);
    }).catch(caught => {
      if (!controller.signal.aborted) setFocusError(caught instanceof Error ? caught.message : 'This handoff could not be loaded.');
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

  if (!items.length && !focused && !busy && !error && !focusError && !(requestedId && !onlyMine)) return null;
  return <section className="research-handoffs" aria-labelledby="research-handoffs-title">
    <div className="section-heading-row"><div><h3 id="research-handoffs-title">Stopped tasks</h3></div>
      {history !== null && !denied ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(null)}>Refresh notes</Button> : null}
    </div>
    {stale && history !== null ? <p className="field-hint" role="status">There may be newer notes. Refresh when you’re ready; your current place is saved.</p> : null}
    {focusError ? <div className="journal-load-error" role="alert"><p>{focusError}</p><Button variant="outline" size="sm" onClick={() => setFocusAttempt(value => value + 1)}>Retry linked note</Button></div> : null}
    {error ? <div className="journal-load-error" role="alert"><p>{error}</p>{!denied ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(retryBefore)}>Retry handoffs</Button> : null}</div> : null}
    {busy ? <p className="field-hint" role="status">Loading unfinished experiments…</p> : null}
    {requestedId && !onlyMine && !present && !focused && !focusError ? <p className="field-hint" role="status">Loading the linked handoff…</p> : null}
    {focused && !present ? <><p className="field-hint">The linked handoff</p><HandoffCard item={focused} focused now={now} /></> : null}
    {items.length ? <ul className="research-handoff-list">{items.map(item => <li key={item.id}><HandoffCard item={item} focused={!onlyMine && item.id === requestedId} now={now} /></li>)}</ul> : null}
    {continuation ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(continuation)}>Read earlier handoffs</Button> : history !== null && items.length ? <p className="field-hint">You’ve reached the earliest handoff in this view.</p> : null}
  </section>;
}

function HandoffCard({ item, focused, now }: { item: PublicResearchHandoff; focused: boolean; now: number }) {
  return <details className="research-handoff-card task-row" id={`handoff-${item.id}`} tabIndex={-1} open={focused || undefined}>
    <summary><TaskAgent name={item.agentName} /><span className="task-main"><strong className="task-title" title={item.intent?.proposal}>{item.intent?.proposal || 'Stopped before completing the experiment'}</strong></span><TaskStatusIcon kind="stopped" /><TaskTime value={item.createdAt} now={now} /></summary>
    <div className="handoff-note"><p className="eyebrow">Why I stopped</p><p>{item.stopReason}</p>
      {item.intent ? <p><strong>Expected:</strong> {item.intent.expectation}</p> : null}
      <p className="field-hint">Agent-reported stop reason. This does not establish that the approach failed.</p>
      <QueueNext />
      <a href={`/?project=circle-packing&tab=updates#handoff-${item.id}`}>Link to this handoff</a>
    </div>
  </details>;
}
