import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { readContributorReviewedArtifacts, type ReviewedArtifactItem } from '@/lib/reviewed-artifacts';
import { Button } from './ui/button';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

export function ContributorReviewedArtifacts({ contributorId }: { contributorId: string }) {
  const slug = useProjectSlug();
  const [items, setItems] = useState<ReviewedArtifactItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    void readContributorReviewedArtifacts(contributorId, null, controller.signal, slug).then(page => {
      if (!controller.signal.aborted) { setItems(page.items); setCursor(page.nextCursor); setLoaded(true); }
    }).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Reviews could not be loaded.');
    }).finally(() => {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [contributorId, refresh]);

  async function loadMore() {
    if (!cursor || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      const page = await readContributorReviewedArtifacts(contributorId, cursor, controller.signal, slug);
      if (!controller.signal.aborted) {
        setItems(current => Array.from(new Map([...current, ...page.items].map(item => [item.witnessDigest, item])).values()));
        setCursor(page.nextCursor);
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'More reviews could not be loaded.');
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    }
  }

  return <div className="contributor-reviewed-content" aria-busy={busy}>
    <p>These files earned credit through independent review for shared memory. The review is about retaining evidence; it does not establish that a hypothesis is true.</p>
    {items.length ? <ol>{items.map(item => <li key={item.witnessDigest}>
      <div className="contribution-review-date">Approved for shared memory · <time dateTime={item.review.reviewedAt}>{new Date(item.review.reviewedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></div>
      <a href={`${projectLink(slug)}&tab=updates#research-${item.submissionId}`}>Explore {item.agentName}’s experiment<ArrowUpRight aria-hidden="true" /></a>
      <p className="contribution-review-rationale">{item.review.rationale}</p>
      <details className="contribution-review-record"><summary>Exact file and review</summary>
        <dl><div><dt>File SHA-256</dt><dd>{item.witnessDigest}</dd></div>
          <div><dt>Review ID</dt><dd>{item.review.id}</dd></div>
          <div><dt>Experiment submitted</dt><dd><time dateTime={item.submittedAt}>{new Date(item.submittedAt).toLocaleString()}</time></dd></div></dl>
        <a href={`${publicProjectPath(slug)}/submissions/${item.submissionId}/artifact`}>Open the submitted file<ArrowUpRight aria-hidden="true" /></a>
      </details>
    </li>)}</ol> : loaded && !busy ? <div className="contribution-review-empty"><strong>No reviewed artifacts yet</strong><p>Public experiments still appear in this person’s contributions. Credit begins when a different authorized reviewer approves evidence for shared memory.</p></div> : null}
    {busy ? <p role="status">Loading reviewed artifacts…</p> : null}
    {error ? <p role="status">{error} {items.length ? 'Your current list is saved.' : ''}</p> : null}
    <div className="contributor-history-actions">
      {cursor ? <Button size="sm" variant="outline" aria-disabled={busy} onClick={() => void loadMore()}>Show more reviewed artifacts</Button> : null}
      {loaded || error ? <Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => { if (!busy && !pending.current) setRefresh(value => value + 1); }}>{loaded ? 'Refresh reviews' : 'Try again'}</Button> : null}
    </div>
    {loaded && items.length ? <p className="contribution-history-count">Showing {items.length.toLocaleString()} distinct {items.length === 1 ? 'file' : 'files'}. Each file counts once. This is a snapshot; refresh for later decisions. Historical review credit can remain when a new memory connection is awaiting review.</p> : null}
  </div>;
}
