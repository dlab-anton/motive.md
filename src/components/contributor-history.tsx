import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Users } from 'lucide-react';
import type { ParticipationPublicProjection, ResearchJournalEntry } from '@/lib/participation';
import { researchDigest, researchSummaryLabel } from '@/lib/research-digest';
import { readContributorJournal } from '@/lib/contributor-journal';
import { mergeJournalEntries } from '@/lib/research-journal';
import { Button } from './ui/button';
import { ContributorReviewedArtifacts } from './contributor-reviewed-artifacts';
import { findingOutcomeLabel } from './research-finding-review';

type Contributor = ParticipationPublicProjection['contributors'][number];

export function ContributorCard({ person, showIdentity = true }: { person: Contributor; showIdentity?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const findingsId = useId();
  const findingButton = useRef<HTMLButtonElement>(null);
  const reviewsId = useId();
  const reviewButton = useRef<HTMLButtonElement>(null);
  return <li className="contributor-card">
    {showIdentity ? <div className="contributor-identity"><span className="contributor-avatar" aria-hidden="true">{person.displayName?.trim().slice(0, 1).toUpperCase() || <Users />}</span>
      <div><h3>{person.displayName || 'Contributor'}</h3><p>Contributing since {new Date(person.firstSubmittedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</p></div>
    </div> : null}
    <dl className="contributor-record"><div><dt>Public task XP</dt><dd>{typeof person.taskXp === 'number' ? person.taskXp.toLocaleString() : '—'}</dd></div>
      <div><dt>Public experiments</dt><dd>{person.submissionCount.toLocaleString()}</dd></div>
      <div><dt>Reviewed artifacts</dt><dd><button ref={reviewButton} type="button" className="contributor-review-count" aria-label={`Explore reviewed artifacts by ${person.displayName || 'this contributor'}: ${(person.reviewedArtifactCount ?? 0).toLocaleString()}`} aria-expanded={reviewsOpen} aria-controls={reviewsId} onClick={() => { setReviewsOpen(value => !value); setOpen(false); setFindingsOpen(false); }}>{(person.reviewedArtifactCount ?? 0).toLocaleString()}<ArrowUpRight aria-hidden="true" /></button></dd></div>
      {typeof person.acceptedFindingCount === 'number' ? <div className="contributor-accepted-count"><dt>Accepted findings</dt><dd><button ref={findingButton} type="button" className="contributor-review-count" aria-label={`Explore accepted findings by ${person.displayName || 'this contributor'}: ${person.acceptedFindingCount.toLocaleString()}`} aria-expanded={findingsOpen} aria-controls={findingsId}
        onClick={() => { setFindingsOpen(value => !value); setOpen(false); setReviewsOpen(false); }}>{person.acceptedFindingCount.toLocaleString()}<ArrowUpRight aria-hidden="true" /></button></dd></div> : null}
    </dl>
    <div id={findingsId} hidden={!findingsOpen} className="contributor-reviewed">
      {findingsOpen ? <><div className="contributor-reviewed-heading"><h4>Findings this person contributed</h4><button type="button" onClick={() => { setFindingsOpen(false); findingButton.current?.focus(); }}>Hide findings</button></div>
        <ContributorHistory key={`findings:${person.id}`} person={person} acceptedOnly /></> : null}
    </div>
    <div id={reviewsId} hidden={!reviewsOpen} className="contributor-reviewed">
      {reviewsOpen ? <><div className="contributor-reviewed-heading"><h4>Behind the review credit</h4><button type="button" onClick={() => { setReviewsOpen(false); reviewButton.current?.focus(); }}>Hide reviews</button></div><ContributorReviewedArtifacts key={person.id} contributorId={person.id} /></> : null}
    </div>
    <details className="contributor-history" open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) { setReviewsOpen(false); setFindingsOpen(false); } }}>
      <summary>Explore contributions</summary>
      {open ? <ContributorHistory key={person.id} person={person} /> : null}
    </details>
  </li>;
}

function ContributorHistory({ person, acceptedOnly = false }: { person: Contributor; acceptedOnly?: boolean }) {
  const [entries, setEntries] = useState<ResearchJournalEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    void readContributorJournal(person.id, null, controller.signal, acceptedOnly).then(page => {
      if (!controller.signal.aborted) { setEntries(page.items); setCursor(page.nextCursor); setLoaded(true); }
    }).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Contributions could not be loaded.');
    }).finally(() => {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [person.id, refresh, acceptedOnly]);

  async function loadOlder() {
    if (!cursor || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      const page = await readContributorJournal(person.id, cursor, controller.signal, acceptedOnly);
      if (!controller.signal.aborted) { setEntries(current => mergeJournalEntries(current, page.items)); setCursor(page.nextCursor); }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Older contributions could not be loaded.');
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    }
  }
  return <div className="contributor-history-content" aria-busy={busy}>
    {entries.length ? <ol>{entries.map(({ submission, update }) => {
      const digest = researchDigest(update);
      const finding = update.findingReview?.decision === 'ACCEPT' ? update.findingReview : null;
      return <li key={submission.id}><a href={`/?project=circle-packing&tab=updates#research-${submission.id}`}>{digest.question}<ArrowUpRight aria-hidden="true" /></a>
        {finding ? <><span className="contribution-finding-source">{finding.outcome ? findingOutcomeLabel[finding.outcome] : 'Reviewed finding'}</span><p>{finding.finding}</p><p className="field-hint">{finding.limitations}</p></>
          : <><span className="contribution-finding-source">{researchSummaryLabel(digest)}</span><p>{digest.finding}</p></>}
        <div className="contribution-meta"><span>{submission.agentName}</span><time dateTime={submission.createdAt}>{new Date(submission.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
        </div>
      </li>;
    })}</ol> : loaded && !busy ? <p>{acceptedOnly ? 'No accepted findings yet. Completed experiments can still be awaiting review.' : 'No public experiments are available in this history.'}</p> : null}
    {busy ? <p role="status">{loaded ? 'Loading contributions…' : 'Loading public contributions…'}</p> : null}
    {error ? <p role="status">{error} {entries.length ? 'Your current place is saved.' : ''}</p> : null}
    <div className="contributor-history-actions">
      {cursor ? <Button size="sm" variant="outline" aria-disabled={busy} onClick={() => void loadOlder()}>Load older contributions</Button> : null}
      {loaded || error || refresh > 0 ? <Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => { if (!busy && !pending.current) setRefresh(value => value + 1); }}>{loaded ? 'Refresh contributions' : 'Try again'}</Button> : null}
    </div>
    {loaded ? <p className="contribution-history-count">Showing {entries.length.toLocaleString()} {acceptedOnly ? entries.length === 1 ? 'accepted finding' : 'accepted findings' : entries.length === 1 ? 'public experiment' : 'public experiments'}. Open an experiment for its {acceptedOnly ? 'assessment and ' : ''}evidence. Refresh for newer work or review changes.</p> : null}
  </div>;
}
