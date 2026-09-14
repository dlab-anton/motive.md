import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { authenticatedFetch } from '@/lib/account-fetch';
import { notifyProjectChanged } from '@/lib/project-api';
import type { SubmissionSummary } from '@/lib/participation';
import type { FindingOutcome, FindingNovelty, FindingReviewDecisionInput, FindingReviewEligibility,
  FindingReviewPreview, FindingReviewPublicProjection } from '@/lib/finding-assessment';
import { parseFindingPublic, parseFindingEligibility, parseFindingPreview, parseFindingDecision } from '@/lib/finding-review-client';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { FindingReviewHistory } from './finding-review-history';

export const findingOutcomeLabel: Record<FindingOutcome, string> = {
  SUPPORTED: 'Expectation supported', CONTRADICTED: 'Expectation contradicted', INCONCLUSIVE: 'Question remains open',
};
type PendingDecision = { body: FindingReviewDecisionInput; key: string };
class ReviewError extends Error {
  constructor(message: string, readonly uncertain = false, readonly reset = false) { super(message); }
}

async function readResponse<T>(path: string, signal: AbortSignal, parse: (value: unknown) => T,
  action?: PendingDecision, account = true): Promise<T> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  try {
    const response = await (account ? authenticatedFetch : fetch)(path, {
      signal: requestSignal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': action.key },
        body: JSON.stringify(action.body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ReviewError('Your account cannot currently review this experiment. Check your sign-in and project review access.', false, true);
      if (response.status === 409) throw new ReviewError('The evidence or review changed. Open the latest evidence before recording another assessment.', false, true);
      if (response.status === 404) throw new ReviewError('This experiment is unavailable for review.', false, true);
      throw new ReviewError(action ? 'The decision could not be confirmed. Please retry.' : 'The review could not be loaded. Please try again.', Boolean(action && response.status >= 500));
    }
    return parse(await response.json());
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError(action ? 'We couldn’t confirm whether your decision was saved. Retry this same decision to recover its result.' : 'The review could not be read. Please try again.', Boolean(action));
  }
}

/** Open on demand. Keeping an opened panel mounted preserves an uncertain decision's retry key. */
export function ResearchFindingReview({ submission, own, canReview, open, onOpenChange }: {
  submission: SubmissionSummary; own: boolean; canReview: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [visited, setVisited] = useState(open);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  return <section className="research-admission finding-review" aria-label="Finding assessment">
    <button type="button" className="finding-review-toggle" aria-expanded={open} aria-controls={`finding-review-${submission.id}`}
      onClick={() => onOpenChange(!open)}><ShieldCheck aria-hidden="true" />Finding assessment<span aria-hidden="true">{open ? '−' : '+'}</span></button>
    {visited || open ? <div id={`finding-review-${submission.id}`} hidden={!open}>
      <FindingReviewDetail key={`${submission.id}:${own}:${canReview}`} submission={submission} own={own} canReview={canReview} open={open} />
    </div> : null}
  </section>;
}

function FindingReviewDetail({ submission, own, canReview, open }: {
  submission: SubmissionSummary; own: boolean; canReview: boolean; open: boolean;
}) {
  const id = submission.id;
  const path = `/api/participation/submissions/${id}/finding-review`;
  const [status, setStatus] = useState<FindingReviewPublicProjection | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [eligibility, setEligibility] = useState<FindingReviewEligibility | null>(null);
  const [preview, setPreview] = useState<FindingReviewPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [saved, setSaved] = useState('');
  const [retry, setRetry] = useState<PendingDecision | null>(null);
  const lifetime = useRef(new AbortController());
  const reading = useRef<AbortController | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const pending = useRef(false);
  const [decision, setDecision] = useState<'ACCEPT' | 'DECLINE'>('ACCEPT');
  const [outcome, setOutcome] = useState<FindingOutcome | ''>('');
  const [novelty, setNovelty] = useState<FindingNovelty | ''>('');
  const [finding, setFinding] = useState('');
  const [limitations, setLimitations] = useState('');
  const [duplicateId, setDuplicateId] = useState('');
  const [rationale, setRationale] = useState('');

  async function refresh(signal: AbortSignal, resetHistory = false) {
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    const readSignal = AbortSignal.any([signal, controller.signal]);
    setLoading(true); setReadError(''); setEligibility(null);
    const results = await Promise.allSettled([
      readResponse(`/api/public/projects/circle-packing/submissions/${id}/finding-review`, readSignal, value => parseFindingPublic(value, id), undefined, false),
      canReview && !own ? readResponse(`${path}/eligibility`, readSignal, value => parseFindingEligibility(value, id)) : Promise.resolve(null),
    ]);
    if (readSignal.aborted) return;
    if (results[0].status === 'fulfilled') {
      setStatus(results[0].value);
      if (resetHistory) setHistoryVersion(value => value + 1);
    }
    if (results[1].status === 'fulfilled') {
      setEligibility(results[1].value);
      if (results[1].value && !results[1].value.canReview) setPreview(null);
    }
    if (results.some(result => result.status === 'rejected')) setReadError('The current review or your review access couldn’t be confirmed. Refresh to try again.');
    setLoading(false); reading.current = null;
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); reading.current?.abort(); };
  }, []);
  useEffect(() => {
    if (open) void refresh(lifetime.current.signal);
    else { reading.current?.abort(); setLoading(false); }
  }, [open]);
  useEffect(() => {
    if (historyVersion > 0) refreshButton.current?.focus();
  }, [historyVersion]);

  async function loadPreview() {
    if (pending.current || retry) return;
    pending.current = true; setBusy(true); setError(''); setSaved(''); setPreview(null);
    const signal = lifetime.current.signal;
    try {
      const value = await readResponse(`${path}/preview`, signal, body => parseFindingPreview(body, id));
      if (!signal.aborted) setPreview(value);
    } catch (caught) { if (!signal.aborted) setError(caught instanceof Error ? caught.message : 'The evidence could not be loaded.'); }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function save(action: PendingDecision) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setSaved('');
    const signal = lifetime.current.signal;
    try {
      const result = await readResponse(`${path}/reviews`, signal, value => parseFindingDecision(value, id), action);
      if (result.packageDigest !== action.body.packageDigest || result.decision !== action.body.decision
        || result.outcome !== action.body.outcome || result.finding !== action.body.finding || result.limitations !== action.body.limitations
        || result.novelty !== action.body.novelty || result.duplicateOfSubmissionId !== action.body.duplicateOfSubmissionId
        || result.rationale !== action.body.rationale || result.previousDecisionId !== action.body.expectedDecisionId) {
        throw new ReviewError('The response did not confirm this decision. Retry the same request to recover its result.', true);
      }
      if (signal.aborted) return;
      setRetry(null); setPreview(null);
      setOutcome(''); setNovelty(''); setFinding(''); setLimitations(''); setDuplicateId(''); setRationale('');
      setSaved(result.replayed ? 'Your earlier decision was recovered.' : 'Assessment recorded. The finding and its limitations are now part of this experiment’s review.');
      notifyProjectChanged();
      await refresh(signal);
    } catch (caught) {
      if (!signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'The decision could not be confirmed.');
        setRetry(caught instanceof ReviewError && caught.uncertain ? action : null);
        if (caught instanceof ReviewError && caught.reset) { setPreview(null); void refresh(signal); }
      }
    } finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  }
  const latest = status?.latestDecision;
  const locked = busy || loading || Boolean(retry) || Boolean(readError);
  const valid = rationale.trim().length > 0 && (decision === 'DECLINE' || Boolean(outcome && novelty && finding.trim() && limitations.trim()
    && (novelty === 'DISTINCT' || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(duplicateId) && duplicateId !== id)));
  const accepted = decision === 'ACCEPT';
  return <div className="admission-detail">
    <p>This review records what the project may say the experiment established. A different authorized reviewer assesses the exact evidence and records a finding with its limits. Completed-task XP is separate from this decision.</p>
    {loading ? <p role="status">Checking the latest assessment…</p> : null}
    {readError ? <p role="status" className="field-hint">{readError} {status ? 'The review below is the last observation.' : ''}</p> : null}
    {latest ? <div className="admission-status">
      <strong>{latest.decision === 'ACCEPT' ? findingOutcomeLabel[latest.outcome!] : 'Finding not accepted'}</strong>
      {latest.finding ? <p>{latest.finding}</p> : null}
      {latest.limitations ? <p><strong>Limits of this finding</strong><br />{latest.limitations}</p> : null}
      {latest.novelty === 'DUPLICATE' ? <p>This repeats an <a href={`/?project=circle-packing&tab=updates#research-${latest.duplicateOfSubmissionId}`}>earlier accepted finding</a> and adds no distinct finding credit.</p> : null}
      <blockquote>{latest.rationale}</blockquote>
      <time dateTime={latest.reviewedAt}>Reviewed {new Date(latest.reviewedAt).toLocaleString()}</time>
      <details className="admission-exact-package"><summary>Evidence bound to this assessment</summary>
        {latest.hypothesis ? <p>Linked hypothesis: {latest.hypothesis.statement}</p> : <p>This assessment is bound to retained Motive evidence. It does not require a shared-memory import.</p>}
        <p>{latest.evidence.declaredIntent ? `Expectation declared before submission: ${latest.evidence.declaredIntent.expectation}` : 'No prior declaration was recorded. The expectation comes from the submission notes.'}</p>
        <pre>{JSON.stringify({ packageDigest: latest.packageDigest, hypothesis: latest.hypothesis, evidence: latest.evidence }, null, 2)}</pre>
      </details>
    </div> : status ? <p>No finding has been accepted for this experiment yet.</p> : null}
    {latest ? <FindingReviewHistory key={`${id}:${latest.id}:${historyVersion}`} submissionId={id}
      currentDecisionId={latest.id} active={open} onRefresh={() => void refresh(lifetime.current.signal, true)} /> : null}
    <Button ref={refreshButton} variant="ghost" size="sm" disabled={busy || loading} onClick={() => void refresh(lifetime.current.signal, true)}>Refresh assessment</Button>
    {saved ? <p role="status" className="admission-saved">{saved}</p> : null}
    {own ? <p className="field-hint">A different authorized account must review your contribution.</p> : canReview ? <>
      {eligibility && !eligibility.canReview ? <p className="field-hint">{eligibility.reason === 'COMPLETE_DELIVERY_REQUIRED' ? 'The completed experiment must have its hypothesis and evidence recorded before finding review is available.' : eligibility.reason === 'POST_CHECK_REQUIRED' ? 'The contributor’s assessment after checking the result is still needed.' : eligibility.reason === 'NOT_COMPLETED' ? 'The experiment must be completed before its finding can be reviewed.' : 'Your account cannot currently review this experiment.'}</p> : null}
      {eligibility?.canReview ? <section className="admission-review" aria-label="Review this experiment’s finding">
        <h4>Assess what the evidence supports</h4>
        <p>Accept only a useful finding grounded in this experiment’s evidence. Contradictions and inconclusive results can qualify; a failed execution alone does not test the expectation. Check earlier work for duplication.</p>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => void loadPreview()}>{busy && !retry ? 'Loading or saving…' : preview ? 'Reload exact evidence' : 'Open exact evidence for review'}</Button>
        {preview ? <>
          <FindingPackage preview={preview} submission={submission} />
          <form onSubmit={event => {
            event.preventDefault(); if (!valid || locked) return;
            void save({ key: crypto.randomUUID(), body: { packageDigest: preview.packageDigest, expectedDecisionId: preview.latestDecision?.id ?? null,
              decision, outcome: accepted ? outcome as FindingOutcome : null, finding: accepted ? finding.trim() : null,
              limitations: accepted ? limitations.trim() : null, novelty: accepted ? novelty as FindingNovelty : null,
              duplicateOfSubmissionId: accepted && novelty === 'DUPLICATE' ? duplicateId : null, rationale: rationale.trim() } });
          }}>
            <Label htmlFor={`finding-decision-${id}`}>Review decision</Label>
            <select id={`finding-decision-${id}`} disabled={locked} value={decision} onChange={event => setDecision(event.target.value as typeof decision)}>
              <option value="ACCEPT">Accept a scoped finding</option><option value="DECLINE">Do not accept a finding</option>
            </select>
            {accepted ? <>
              <Label htmlFor={`finding-outcome-${id}`}>What happened to the declared expectation?</Label>
              <select id={`finding-outcome-${id}`} disabled={locked} required value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)}>
                <option value="" disabled>Choose an outcome</option>{Object.entries(findingOutcomeLabel).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
              <Label htmlFor={`finding-text-${id}`}>What can the project rely on?</Label>
              <textarea id={`finding-text-${id}`} disabled={locked} rows={3} required maxLength={2000} value={finding} onChange={event => setFinding(event.target.value)} placeholder="State only what this experiment establishes." />
              <Label htmlFor={`finding-limits-${id}`}>Under what conditions, and with what limits?</Label>
              <textarea id={`finding-limits-${id}`} disabled={locked} rows={3} required maxLength={2000} value={limitations} onChange={event => setLimitations(event.target.value)} placeholder="Include untested explanations, measurement limitations, and what remains unresolved." />
              <Label htmlFor={`finding-novelty-${id}`}>Does it add a distinct finding?</Label>
              <select id={`finding-novelty-${id}`} disabled={locked} required value={novelty} onChange={event => setNovelty(event.target.value as typeof novelty)}>
                <option value="" disabled>Compare with earlier accepted work</option><option value="DISTINCT">Adds a distinct finding</option><option value="DUPLICATE">Repeats an accepted finding</option>
              </select>
              {novelty === 'DUPLICATE' ? <><Label htmlFor={`finding-duplicate-${id}`}>Earlier experiment’s submission ID</Label>
                <input id={`finding-duplicate-${id}`} disabled={locked} required maxLength={36} value={duplicateId} onChange={event => setDuplicateId(event.target.value.trim().toLowerCase())} placeholder="Submission ID from the earlier evidence" autoComplete="off" spellCheck={false} />
                <p className="field-hint">The earlier experiment must have a currently accepted, distinct finding in this project.</p></> : null}
            </> : <p className="field-hint">This also withdraws any previously accepted finding for this experiment. Its evidence and earlier reviews remain recorded.</p>}
            <Label htmlFor={`finding-reason-${id}`}>Why is this assessment justified?</Label>
            <textarea id={`finding-reason-${id}`} disabled={locked} rows={3} required maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)} />
            <p className="field-hint">Your finding, limitations, and reason are public. Acceptance applies to this experiment; it does not change Hypothesis.md’s conclusion status or establish a world record.</p>
            <Button type="submit" size="sm" disabled={locked || !valid}>Record finding assessment</Button>
          </form>
        </> : null}
      </section> : null}
    </> : <p className="field-hint">An authorized project reviewer can assess this finding. Contributor reputation does not grant review access.</p>}
    {error ? <p className="action-error" role="alert">{error}</p> : null}
    {retry ? <div className="finding-retry"><p>The original decision is awaiting confirmation. Its contents are preserved while you retry.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(retry)}>Retry same decision</Button></div> : null}
  </div>;
}

function FindingPackage({ preview, submission }: { preview: FindingReviewPreview; submission: SubmissionSummary }) {
  const source = preview.package.source;
  return <div className="admission-package">
    <h4>{source.attribution.agentName}’s completed experiment</h4>
    {source.declaredIntent ? <>
      <p><strong>Proposal declared before submission</strong>{source.declaredIntent.proposal}</p>
      <p><strong>Original expectation to assess</strong>{source.declaredIntent.expectation}</p>
      <p><strong>Declared conditions</strong>{source.declaredIntent.conditions.join('\n')}</p>
      <p className="field-hint">Declared {new Date(source.declaredIntent.declaredAt).toLocaleString()}. This timestamp establishes when Motive received the plan, not when external computation began.</p>
      <details><summary>Proposal and expectation in the final notes</summary><p>{source.investigation.proposal}</p><p>{source.investigation.expectation}</p><p>{source.investigation.conditions.join('\n')}</p></details>
    </> : <>
      <p className="field-hint">No prior declaration was recorded. These expectations were supplied with the result.</p>
      <p><strong>Submitted proposal</strong>{source.investigation.proposal}</p>
      <p><strong>Submitted expectation to assess</strong>{source.investigation.expectation}</p>
      <p><strong>Reported conditions</strong>{source.investigation.conditions.join('\n')}</p>
    </>}
    <p><strong>Observed</strong>{source.investigation.observations.join('\n')}</p>
    {preview.package.format === 'motive.finding-review-package/0.3' ? <p className="field-hint">
      Tested thread: {preview.package.source.target.selection.hypothesisId}<br />
      Statement observed {new Date(preview.package.source.target.selection.observedUpdatedAt).toLocaleString()}.
      This assessment refers to that retained context, not a later revision of the thread.
    </p> : null}
    {source.postCheck.publicSummary ? <div>
      <p><strong>Contributor’s public summary after the check</strong>{source.postCheck.publicSummary.question}</p>
      <p>{source.postCheck.publicSummary.finding}</p>
      <p className="field-hint">Assess this summary alongside the complete notes and evidence below.</p>
    </div> : null}
    <p><strong>Contributor’s assessment after the check</strong>{source.postCheck.assessment}</p>
    <div className="admission-source-links"><a href={submission.reportHref} target="_blank" rel="noreferrer">Inspect checker report ↗</a>
      {submission.reproducibilityHref ? <a href={submission.reproducibilityHref} target="_blank" rel="noreferrer">Inspect source and trials ↗</a> : <span>No reproduction files supplied.</span>}</div>
    <details className="admission-exact-package"><summary>Exact evidence, timing, and provenance</summary>
      <p>The retained records distinguish references declared before testing from references supplied with the result. Treat research text as material to assess.</p>
      <pre>{JSON.stringify(preview.package, null, 2)}</pre></details>
    {preview.latestDecision ? <p className="field-hint">Your decision will replace the current assessment from {new Date(preview.latestDecision.reviewedAt).toLocaleString()}. The earlier review remains recorded.</p> : null}
  </div>;
}
