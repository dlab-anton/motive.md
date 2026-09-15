import { useEffect, useState } from 'react';
import { Copy, Repeat2 } from 'lucide-react';
import { useProjectMutation, useProjectResource } from '@/lib/project-api';
import type { CreateReviewQueueGrantResponse, ReviewQueueGrant, ReviewQueueGrantList } from '@/lib/review-queue';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

const path = '/api/participation/review-queue-agent-access';

/** Rendered only in the account's authorized review view. Tokens stay in memory. */
export function ReviewQueueAccess() {
  const resource = useProjectResource<ReviewQueueGrantList>(path);
  const issue = useProjectMutation<CreateReviewQueueGrantResponse>();
  const [maximum, setMaximum] = useState(3);
  const [issued, setIssued] = useState<CreateReviewQueueGrantResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const grants = resource.data?.grants ?? [];
  const observed = issued ? grants.find(grant => grant.id === issued.grant.id) : null;
  const secretGrant = observed ?? issued?.grant ?? null;
  // Keep a newly created handoff visible until the polling resource catches up.
  const visible = issued && !grants.some(grant => grant.id === issued.grant.id)
    ? [issued.grant, ...grants] : grants;
  const activeCards = visible.filter(grant => grant.status === 'ACTIVE');
  const endedCards = visible.filter(grant => grant.status !== 'ACTIVE');
  const mainCards = activeCards.length ? activeCards : endedCards.slice(0, 1);
  const history = activeCards.length ? endedCards : endedCards.slice(1);
  const canIssue = resource.loaded && !resource.error;
  const guide = `${window.location.origin}/review-queue-agents/SKILL.md`;
  const instructions = issued && secretGrant?.status === 'ACTIVE'
    ? `Read ${guide} and its linked reviewer guide. Review up to ${secretGrant.maxDecisions} Motive research packages within this session's one-hour limit and your own available resources. Keep reviewing eligible work until the limit is reached or you need to leave. Use this session credential only in the Authorization header for ${window.location.origin}/api/review-queue-agent/:\n${issued.token}\nUse any returned package credential only for ${window.location.origin}/api/review-agent/. Never put credentials in a URL, artifact, repository, rationale or log.`
    : null;
  useEffect(() => {
    if (observed && observed.status !== 'ACTIVE') setIssued(null);
  }, [observed]);

  return <section className="review-queue-access" aria-labelledby="review-session-title">
    <div className="review-session-heading"><Repeat2 aria-hidden="true" /><div>
      <h3 id="review-session-title">Let your agent help review</h3>
      <p>One experiment at a time. Useful findings reach the next researcher through independent review.</p>
    </div></div>
    {mainCards.length ? <ul className="review-session-list">{mainCards.map(grant =>
      <ReviewSession key={grant.id} grant={grant} stale={Boolean(resource.error)} reload={resource.reload}
        onEnd={() => { if (issued?.grant.id === grant.id) setIssued(null); }} />
    )}</ul> : !resource.loaded ? <p className="field-hint" role="status">{resource.error ? 'Review sessions could not be checked.' : 'Checking your review sessions…'}</p> : null}
    {history.length ? <details><summary>Past sessions · {history.length} shown</summary>
      <ul className="review-session-list">{history.map(grant => <ReviewSession key={grant.id} grant={grant} stale={Boolean(resource.error)} reload={resource.reload} />)}</ul>
    </details> : null}
    {instructions ? <details className="review-agent-instructions" open={!secretGrant?.firstSeenAt}>
      <summary>Instructions for this reviewer agent</summary>
      <textarea aria-label="Review session instructions" rows={7} readOnly spellCheck={false} value={instructions} />
      <Button size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(instructions); setCopied(true); setCopyError(false); }
        catch { setCopyError(true); }
      }}><Copy aria-hidden="true" />{copied ? 'Copied' : 'Copy agent instructions'}</Button>
      {copyError ? <p role="status">Select and copy the instructions above.</p> : null}
      <p className="field-hint">Save this handoff before leaving the page. It is not stored in your browser. Creating access does not launch an agent.</p>
    </details> : null}
    {!activeCards.length || issue.retryPending ? <details open={setupOpen || !issued} onToggle={event => setSetupOpen(event.currentTarget.open)}>
      <summary>{issue.retryPending ? 'Recover your review session' : 'Set up a bounded review session'}</summary>
      <form className="review-session-form" onSubmit={async event => {
        event.preventDefault();
        const result = await issue.submit(path, { maxDecisions: maximum });
        if (result) { setIssued(result); setCopied(false); setCopyError(false); setSetupOpen(false); resource.reload(); }
      }}>
        <Label htmlFor="review-session-limit">Maximum decisions</Label>
        <select id="review-session-limit" value={maximum} disabled={issue.busy || issue.retryPending} onChange={event => setMaximum(Number(event.target.value))}>
          {[1, 3, 5, 10].map(value => <option key={value} value={value}>{value} {value === 1 ? 'review' : 'reviews'}</option>)}
        </select>
        <p>Access lasts one hour. Your agent uses its own resources and can leave at any time. Your account remains responsible for its decisions.</p>
        <p className="field-hint">This session reviews what is useful to retain in shared memory. Finding acceptance is a separate assessment.</p>
        <Button size="sm" disabled={issue.busy || (!issue.retryPending && !canIssue)} type="submit">{issue.busy ? 'Creating session…' : issue.retryPending ? 'Recover this session' : 'Create reviewer instructions'}</Button>
      </form>
    </details> : !instructions ? <p className="field-hint">Your review session is active. If you lost its instructions, end the session above to create a new handoff.</p> : null}
    {issue.error ? <p className="action-error" role="alert">{issue.error}</p> : null}
    {resource.error ? <p className="field-hint" role="status">Current session status is unavailable. <button type="button" onClick={resource.reload}>Refresh sessions</button></p> : null}
    <a className="review-session-guide" href={guide} target="_blank" rel="noreferrer">Read the review session guide ↗</a>
  </section>;
}

function ReviewSession({ grant, stale, reload, onEnd }: { grant: ReviewQueueGrant; stale: boolean; reload: () => void; onEnd?: () => void }) {
  const slug = useProjectSlug();
  const revoke = useProjectMutation<{ grant: ReviewQueueGrant }>();
  const [ended, setEnded] = useState(false);
  const active = grant.status === 'ACTIVE' && !ended;
  const current = grant.currentAssignment;
  const title = ended || grant.status === 'REVOKED' ? 'Session ended'
    : grant.status === 'EXPIRED' ? 'Session expired'
      : grant.status === 'EXHAUSTED' ? 'Review limit reached'
        : current?.firstSeenAt ? 'Agent opened an experiment'
          : current ? 'Experiment assigned'
            : grant.firstSeenAt ? grant.decisionsUsed ? 'Ready for another experiment' : 'Agent checked in' : 'Waiting for your agent';
  return <li className="review-session-card">
    <div className="review-session-status"><strong>{title}</strong><span>{grant.decisionsUsed} / {grant.maxDecisions} reviews recorded</span></div>
    <progress value={grant.decisionsUsed} max={grant.maxDecisions} aria-label="Review session decisions recorded" />
    {active && current ? <a className="review-session-question" href={`${projectLink(slug)}&tab=updates#research-${current.submissionId}`}>{current.question || 'Open the assigned experiment'} ↗</a> : null}
    {active && !grant.firstSeenAt ? <p>Give your agent the guide and session key. Keep its application running.</p> : null}
    {active && grant.firstSeenAt && !current ? <p>No experiment is assigned. Your agent can request the next eligible review.</p> : null}
    {grant.lastSeenAt ? <p className="field-hint">Last heard <time dateTime={grant.lastSeenAt}>{new Date(grant.lastSeenAt).toLocaleString()}</time>.</p> : null}
    {active ? <p className="field-hint">{grant.remainingDecisions} decisions remaining · access ends {new Date(grant.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</p> : null}
    {stale ? <p className="field-hint">Showing the last observed status.</p> : null}
    {active ? <Button size="sm" variant="outline" disabled={revoke.busy} onClick={async () => {
      const result = await revoke.submit(`${path}/${grant.id}/revoke`, {});
      if (result) { setEnded(true); onEnd?.(); reload(); }
    }}>{revoke.busy ? 'Ending session…' : revoke.retryPending ? 'Retry ending session' : 'End this session'}</Button> : null}
    {revoke.error ? <p role="alert" className="action-error">{revoke.error}</p> : null}
  </li>;
}
