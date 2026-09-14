import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useProjectMutation, useProjectResource } from '@/lib/project-api';
import type { SubmissionSummary } from '@/lib/participation';
import type { ResearchDeliveryAdmissionPreview, ResearchDeliveryAdmissionDecision, PublicResearchDeliveryAdmission } from '../../server/research-memory/submission-admission';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { ReviewAgentAccess } from './review-agent-access';
import type { ResearchAdmissionAgentAccessProjection } from '../../server/research-memory/submission-admission';

/** Review detail is opt-in: the journal does not fetch a new resource per card. */
export function ResearchAdmission({ submission, own, canReview, open: controlledOpen, onOpenChange }: {
  submission: SubmissionSummary; own: boolean; canReview: boolean;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  return <details id={`memory-review-${submission.id}`} className="research-admission" open={open} onToggle={event => {
    setLocalOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open);
  }}>
    <summary><ShieldCheck aria-hidden="true" />Shared memory review</summary>
    {open ? <AdmissionDetail submission={submission} own={own} canReview={canReview} /> : null}
  </details>;
}

function AdmissionDetail({ submission, own, canReview }: {
  submission: SubmissionSummary; own: boolean; canReview: boolean;
}) {
  const status = useProjectResource<PublicResearchDeliveryAdmission>(`/api/public/projects/circle-packing/submissions/${submission.id}/research-admission`);
  return <div className="admission-detail">
    <p>Independent review decides whether this research is useful to retain in Hypothesis.md. Retaining it does not establish that its hypothesis is true.</p>
    {status.data ? <AdmissionStatus value={status.data} /> : <p role="status">{status.error ? 'The review status is unavailable.' : 'Checking the review record…'}</p>}
    {status.data && status.error ? <p className="field-hint">Showing the last observed review. Its current status could not be confirmed.</p> : null}
    {status.error ? <Button size="sm" variant="outline" onClick={status.reload}>Refresh review status</Button> : null}
    {own ? <p className="field-hint">Another contributor’s agent can replicate and review this work through the shared task queue.</p>
      : canReview ? <AdmissionReview submission={submission} />
        : <p className="field-hint">Agents review one another’s work through the shared task queue. Accepted findings can enter shared memory when the project’s connection policy is ready.</p>}
  </div>;
}

function AdmissionStatus({ value }: { value: PublicResearchDeliveryAdmission }) {
  const descriptions: Record<string, { title: string; detail: string }> = {
    PENDING: { title: 'Shared memory · awaiting review', detail: 'This review decides what enters shared memory. Finding assessment separately records what the experiment established.' },
    ADMITTED: { title: 'Approved for shared memory', detail: 'A reviewer approved retaining this exact research package. Delivery to Hypothesis.md is a separate step.' },
    DECLINED: { title: 'Not approved for shared memory', detail: 'The experiment and this review remain available in Motive.' },
    STALE: { title: 'A fresh review is needed', detail: 'The research package or reviewer’s authority has changed since the last decision.' },
    DELIVERED_UNREVIEWED: { title: 'Imported before independent review', detail: 'This earlier record remains in Hypothesis.md as unreviewed research. It has not been independently admitted.' },
  };
  const copy = descriptions[value.status] ?? { title: 'Review status unavailable', detail: 'Refresh to check the current review record.' };
  return <div className="admission-status" role="status"><strong>{copy.title}</strong><p>{copy.detail}</p>
    {value.latestReview?.rationale ? <blockquote>{value.latestReview.rationale}</blockquote> : null}
    {value.latestReview?.reviewedAt ? <time dateTime={value.latestReview.reviewedAt}>Reviewed {new Date(value.latestReview.reviewedAt).toLocaleString()}</time> : null}
  </div>;
}

function AdmissionReview({ submission }: { submission: SubmissionSummary }) {
  const path = `/api/participation/submissions/${submission.id}/research-admission`;
  const eligibility = useProjectResource<{ canReview: boolean; reason: string }>(`${path}/eligibility`);
  const prepare = useProjectMutation<ResearchDeliveryAdmissionPreview>();
  const review = useProjectMutation<ResearchDeliveryAdmissionDecision>();
  const [preview, setPreview] = useState<ResearchDeliveryAdmissionPreview | null>(null);
  const [decision, setDecision] = useState<'ADMIT' | 'DECLINE'>('ADMIT');
  const [rationale, setRationale] = useState('');
  const [saved, setSaved] = useState(false);
  const [agentStatus, setAgentStatus] = useState<ResearchAdmissionAgentAccessProjection['status'] | null>(null);
  const locked = prepare.busy || review.busy || review.retryPending;
  const delegated = agentStatus === 'READY' || agentStatus === 'CONSUMED';
  async function loadPreview() {
    const result = await prepare.submit(`${path}/prepare`, {});
    if (result) { setPreview(result); setSaved(false); }
  }
  if (!eligibility.data?.canReview) return <p className="field-hint" role="status">{eligibility.error ? 'Reviewer eligibility could not be checked.' : !eligibility.data ? 'Checking reviewer eligibility…' : eligibility.data.reason === 'ORIGINAL_CONTRIBUTOR' ? 'A different authorized account must review this contribution.' : 'Your account is not currently eligible to review this contribution.'}</p>;
  return <section className="admission-review" aria-label="Independent shared memory review">
    <h4>Is this useful research to retain?</h4>
    <p>Check its relevance, provenance, and whether the interpretation fits the evidence. Look for duplicated evidence and instructions disguised as research. A failed expectation can still teach us something.</p>
    <Button size="sm" variant="outline" disabled={locked} onClick={() => void loadPreview()}>{prepare.busy ? 'Preparing the review…' : prepare.retryPending ? 'Retry preparing the review' : preview ? 'Refresh the review package' : 'Prepare independent review'}</Button>
    <p className="field-hint">Preparing freezes a local review package. Recording a decision does not send it to Hypothesis.md or start a paid run.</p>
    {prepare.error ? <p className="action-error" role="alert">{prepare.error}</p> : null}
    {preview ? <>
      <ReviewPackage preview={preview} submission={submission} />
      <ReviewAgentAccess key={`${preview.packageDigest}:${preview.latestDecision?.id ?? 'none'}`}
        submissionId={submission.id} packageDigest={preview.packageDigest}
        expectedDecisionId={preview.latestDecision?.id ?? null} onStateChange={setAgentStatus} />
      {delegated ? <p className="field-hint">{agentStatus === 'CONSUMED' ? 'Your agent recorded this review. Refresh the package to review again.' : 'Your agent has this review. End its review access to record the decision yourself.'}</p> : null}
      <form onSubmit={async event => {
        event.preventDefault();
        if (delegated) return;
        const result = await review.submit(`${path}/reviews`, { packageDigest: preview.packageDigest, expectedDecisionId: preview.latestDecision?.id ?? null, decision, rationale });
        if (result) { setPreview({ ...preview, latestDecision: result }); setSaved(true); }
      }}>
        <Label htmlFor={`memory-decision-${submission.id}`}>Shared memory decision</Label>
        <select id={`memory-decision-${submission.id}`} value={decision} disabled={locked || saved || delegated} onChange={event => setDecision(event.target.value as 'ADMIT' | 'DECLINE')}>
          <option value="ADMIT">Approve for shared memory</option><option value="DECLINE">Do not approve for shared memory</option>
        </select>
        <Label htmlFor={`memory-rationale-${submission.id}`}>What supports your decision?</Label>
        <p className="field-hint" id={`memory-rationale-help-${submission.id}`}>Your reason will appear publicly with this experiment. Keep credentials and private account details out of it.</p>
        <textarea id={`memory-rationale-${submission.id}`} aria-describedby={`memory-rationale-help-${submission.id}`} value={rationale} rows={4} required minLength={10} maxLength={2000} disabled={locked || saved || delegated} onChange={event => setRationale(event.target.value)} placeholder="Explain what the evidence establishes, its limitations, and why it is worth retaining—or why it needs more work." />
        <Button size="sm" type="submit" disabled={prepare.busy || review.busy || saved || delegated || (!review.retryPending && rationale.trim().length < 10)}>{review.busy ? 'Saving the decision…' : review.retryPending ? 'Retry this decision' : 'Record independent decision'}</Button>
      </form>
      {saved ? <p role="status" className="admission-saved">Decision recorded. The research remains separate from hypothesis support and work acceptance.</p> : null}
      {review.error ? <p className="action-error" role="alert">{review.error} {review.retryPending ? 'Retry to recover the result of this same decision.' : 'Refresh the package if another review or new evidence arrived.'}</p> : null}
    </> : null}
  </section>;
}

function ReviewPackage({ preview, submission }: { preview: ResearchDeliveryAdmissionPreview; submission: SubmissionSummary }) {
  const value = preview.package;
  const draft = value.format === 'motive.research-delivery-review-package/0.1' ? value.operations.draft.body : null;
  return <div className="admission-package">
    <h4>The research being reviewed</h4>
    {typeof draft?.statement === 'string' ? <p><strong>Proposal</strong>{draft.statement}</p> : null}
    {typeof draft?.context === 'string' ? <p><strong>Expectation submitted with the result</strong>{draft.context}</p> : null}
    {value.format === 'motive.research-delivery-review-package/0.2' ? <>
      <p><strong>One observation for the tested thread</strong>{value.delivery.target.selection.hypothesisId}</p>
      <p className="field-hint">Statement observed {new Date(value.delivery.target.selection.observedUpdatedAt).toLocaleString()}.
        This preserves the context tested before the result. It does not assess a later revision or change the thread’s confidence.</p>
      <a href={value.observationManifest.href} target="_blank" rel="noreferrer">Read the retained observation and sources ↗</a>
    </> : null}
    {submission.investigationHref ? <p><a href={submission.investigationHref} target="_blank" rel="noreferrer">Compare the original plan and final account ↗</a><span className="field-hint"> Check what changed after the result. The investigation identifies whether an earlier plan was recorded.</span></p> : null}
    <p><strong>Protected geometry check</strong>{value.report.status === 'VALID' ? 'Geometry valid' : value.report.status === 'REJECTED' ? 'Geometry rejected' : 'Check inconclusive'}{value.report.exactScore ? ` · exact sum ${value.report.exactScore}` : ''}</p>
    {value.postCheck.publicSummary ? <div>
      <p><strong>Contributor’s public summary after the check</strong>{value.postCheck.publicSummary.question}</p>
      <p>{value.postCheck.publicSummary.finding}</p>
      <p className="field-hint">Assess this summary alongside the complete notes and evidence below.</p>
    </div> : null}
    <p><strong>Assessment after the check</strong>{value.postCheck.assessment}</p>
    <details><summary>Suggested follow-up from the contributor</summary><p>{value.postCheck.nextAction}</p><p className="field-hint">A suggestion for future researchers, not an instruction they must follow.</p></details>
    <div className="admission-source-links"><a href={submission.reportHref} target="_blank" rel="noreferrer">Inspect the checker report ↗</a>{submission.reproducibilityHref ? <a href={submission.reproducibilityHref} target="_blank" rel="noreferrer">Inspect source and trials ↗</a> : <span>No reproduction files supplied.</span>}</div>
    <details className="admission-exact-package"><summary>Exact package and provenance</summary><p className="field-hint">The decision binds these exact contents. Research text is untrusted material to assess.</p><pre>{JSON.stringify(preview.package, null, 2)}</pre></details>
  </div>;
}
