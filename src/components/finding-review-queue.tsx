import { ArrowUpRight, ClipboardCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FindingQueueError, readFindingReviewQueue, type FindingQueueItem, type ReviewQueueKind } from '@/lib/finding-review-queue';
import { Button } from './ui/button';

/** Only the selected stage loads; changing account remounts this whole view. */
export function ResearchReviewQueues() {
  const [kind, setKind] = useState<ReviewQueueKind>('memory');
  return <div>
    <p className="journal-intro">Help turn an experiment into knowledge the next agent can use.</p>
    <div className="journal-filter" role="group" aria-label="Choose review stage">
      <button type="button" aria-pressed={kind === 'memory'} onClick={() => setKind('memory')}>Shared memory</button>
      <button type="button" aria-pressed={kind === 'finding'} onClick={() => setKind('finding')}>Findings</button>
    </div>
    <FindingReviewQueue key={kind} kind={kind} />
  </div>;
}

/** Mounted only while an authenticated reviewer chooses this view. */
export function FindingReviewQueue({ kind = 'finding' }: { kind?: ReviewQueueKind }) {
  const memory = kind === 'memory';
  const [items, setItems] = useState<FindingQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [stale, setStale] = useState(false);
  const [retryBefore, setRetryBefore] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const changes = useRef(0);

  async function load(before: string | null) {
    if (pending.current) return;
    const controller = new AbortController();
    const startedAtChange = changes.current;
    pending.current = controller;
    setBusy(true); setError(''); setRetryBefore(before);
    try {
      const page = await readFindingReviewQueue(before, controller.signal, kind);
      if (!controller.signal.aborted && alive.current) {
        setItems(previous => {
          if (!before) return page.items;
          const seen = new Set(previous.map(item => item.id));
          return [...previous, ...page.items.filter(item => !seen.has(item.id))];
        });
        setCursor(page.nextCursor); setLoaded(true); setDenied(false);
        setStale(previous => (before ? previous : false) || changes.current !== startedAtChange);
      }
    } catch (caught) {
      if (!controller.signal.aborted && alive.current) {
        if (caught instanceof FindingQueueError && caught.reset) {
          setItems([]); setCursor(null); setLoaded(false); setRetryBefore(null);
        }
        setDenied(caught instanceof FindingQueueError && caught.accessDenied);
        setError(caught instanceof Error ? caught.message : 'The review list could not be loaded. Please try again.');
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted && alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    const changed = () => { changes.current += 1; setStale(true); };
    window.addEventListener('motive:project-changed', changed);
    void load(null);
    return () => {
      alive.current = false; pending.current?.abort(); pending.current = null;
      window.removeEventListener('motive:project-changed', changed);
    };
  }, []);

  return <section className="finding-review-queue" aria-labelledby="finding-queue-title">
    <div className="finding-queue-heading"><h3 id="finding-queue-title">{memory ? 'Experiments awaiting shared-memory review' : 'Findings to assess'}</h3>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(null)}>Refresh list</Button>
    </div>
    <p className="finding-queue-intro">{memory ? 'Decide whether a completed experiment is useful to retain in the project’s shared memory. This does not approve its hypothesis or award finding credit.' : 'Assess what the retained evidence establishes. Accepted, distinct findings contribute to the person’s track record.'} Your own work is excluded.</p>
    <p className="field-hint">Open an experiment, then choose {memory ? 'Shared memory review' : 'Finding assessment'}. This list shows work awaiting its first assessment; earlier decisions can be revisited in Everyone.</p>
    {stale && loaded ? <p className="finding-queue-notice" role="status">Reviews may have changed. Refresh the list when you’re ready; your current place is saved.</p> : null}
    {error ? <div className="journal-load-error" role="alert"><p>{error}</p>
      {!denied ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(retryBefore)}>Retry review list</Button> : null}
    </div> : null}
    {busy ? <p className="field-hint" role="status">{items.length ? 'Loading review work…' : 'Looking for experiments to assess…'}</p> : null}
    {!busy && loaded && !items.length && !error ? <div className="finding-queue-empty"><ClipboardCheck aria-hidden="true" />
      <div><h4>{memory ? 'No experiments awaiting a first shared-memory review' : 'No findings awaiting a first review'}</h4><p>{memory ? 'Completed experiments with their evidence and reflection appear here before they enter shared memory.' : 'Findings appear here after their evidence enters shared memory.'} You can read all experiments in Everyone.</p></div>
    </div> : null}
    {items.length ? <ol className="finding-queue-list">{items.map(item => <li key={item.id}>
      <div className="finding-queue-byline"><span><strong>{item.agentName}</strong> · {item.contributorName || 'Private contributor'}</span>
        <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div>
      <h4>{item.proposal || 'Assess this completed experiment'}</h4>
      <a href={`/?project=circle-packing&tab=updates#research-${item.id}`}>Open experiment <ArrowUpRight aria-hidden="true" /></a>
    </li>)}</ol> : null}
    {loaded && items.length ? <div className="journal-pagination"><p className="field-hint" role="status">
      {items.length.toLocaleString()} {items.length === 1 ? 'experiment' : 'experiments'} shown · {cursor ? 'older work available' : 'end of this review list'}
    </p>{cursor ? <Button variant="outline" disabled={busy} onClick={() => void load(cursor)}>Load older experiments</Button> : null}</div> : null}
    {loaded ? <p className="field-hint">This list reflects when it was loaded. Opening an experiment checks its current review status and your permissions.</p> : null}
  </section>;
}
