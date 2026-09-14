import { useEffect, useRef, useState } from 'react';
import type { FindingReviewHistoryDecision } from '@/lib/finding-assessment';
import { FindingHistoryReadError, readFindingHistory } from '@/lib/finding-history';
import { Button } from './ui/button';

/** Public history stays anchored to the assessment the reader opened. */
export function FindingReviewHistory({ submissionId, currentDecisionId, active, onRefresh }: {
  submissionId: string; currentDecisionId: string; active: boolean; onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<FindingReviewHistoryDecision[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(currentDecisionId);
  const [newer, setNewer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const regionId = `finding-history-${submissionId}`;

  function cancel() { reading.current?.abort(); reading.current = null; }
  useEffect(() => () => cancel(), []);
  useEffect(() => { if (!active) { cancel(); setBusy(false); } }, [active]);

  async function load() {
    if (reading.current || !cursor || unavailable) return;
    const controller = new AbortController(); reading.current = controller;
    setBusy(true); setError('');
    try {
      const page = await readFindingHistory(submissionId, cursor, controller.signal);
      if (controller.signal.aborted) return;
      const tail = items?.at(-1);
      const seen = new Set([currentDecisionId, ...(items ?? []).map(item => item.id)]);
      if (page.items.some(item => seen.has(item.id))
        || tail && page.items[0]?.id !== tail.previousDecisionId
        || tail && page.items.length === 0 && tail.previousDecisionId !== null) {
        throw new Error('History did not continue from the saved assessment.');
      }
      setItems(previous => [...(previous ?? []), ...page.items]);
      setCursor(page.nextCursor);
      setNewer(page.latestDecisionId !== currentDecisionId);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (caught instanceof FindingHistoryReadError && caught.reset) {
        setItems(null); setUnavailable(true);
        setError('This assessment history is no longer available. Refresh the current assessment.');
      } else setError('Earlier assessments couldn’t be loaded. Your place is saved; please retry.');
    } finally {
      if (reading.current === controller) { reading.current = null; setBusy(false); }
    }
  }

  return <section className="finding-history" aria-label="Earlier finding assessments">
    <button type="button" className="finding-history-toggle" aria-expanded={expanded} aria-controls={regionId}
      onClick={() => {
        const next = !expanded; setExpanded(next);
        if (next && items === null) void load();
        if (!next) { cancel(); setBusy(false); }
      }}>Earlier assessments <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
    <div id={regionId} hidden={!expanded}>
      <p className="field-hint">Earlier decisions remain in the record. The current assessment determines whether this finding qualifies for contribution credit.</p>
      {newer ? <p role="status" className="field-hint">A newer assessment is available. <button type="button" className="finding-history-refresh" onClick={onRefresh}>Refresh the current assessment</button></p> : null}
      {items?.length ? <ol className="finding-history-list">{items.map(item => <li key={item.id}>
        <EarlierDecision item={item} />
      </li>)}</ol> : items && !error ? <p className="field-hint">This is the first assessment. There are no earlier decisions.</p> : null}
      {busy ? <p role="status" className="field-hint">Loading earlier assessments…</p> : null}
      {error ? <p role="status" className="field-hint">{error}</p> : null}
      {unavailable ? <Button variant="ghost" size="sm" onClick={onRefresh}>Refresh assessment</Button>
        : !busy && cursor ? <Button variant="ghost" size="sm" onClick={() => void load()}>
          {error ? 'Retry loading earlier assessments' : items ? 'Load older assessments' : 'Load earlier assessments'}
        </Button> : null}
    </div>
  </section>;
}

function EarlierDecision({ item }: { item: FindingReviewHistoryDecision }) {
  const outcome = item.outcome === 'SUPPORTED' ? 'Expectation supported'
    : item.outcome === 'CONTRADICTED' ? 'Expectation contradicted' : 'Question remained open';
  return <details className="finding-history-entry">
    <summary>
      <span className="finding-history-heading"><strong>{item.decision === 'ACCEPT' ? outcome : 'Finding not accepted'}</strong>
        <time dateTime={item.reviewedAt}>{new Date(item.reviewedAt).toLocaleString()}</time></span>
      <span className="finding-history-preview">{item.finding ?? item.rationale}</span>
    </summary>
    <div className="finding-history-body">
      {item.finding ? <p>{item.finding}</p> : null}
      {item.limitations ? <p><strong>Limits of this finding</strong><br />{item.limitations}</p> : null}
      <p><strong>Why this assessment was made</strong><br />{item.rationale}</p>
      {item.novelty === 'DUPLICATE' ? <p>Classified as repeating an <a href={`/?project=circle-packing&tab=updates#research-${item.duplicateOfSubmissionId}`}>earlier accepted finding</a>.</p> : null}
      <details className="admission-exact-package"><summary>Evidence for this earlier assessment</summary>
        {item.hypothesis ? <p>Linked hypothesis: {item.hypothesis.statement}</p> : <p>This assessment is bound to retained Motive evidence.</p>}
        <pre>{JSON.stringify({ packageDigest: item.packageDigest, hypothesis: item.hypothesis, evidence: item.evidence }, null, 2)}</pre>
      </details>
    </div>
  </details>;
}
