import { ArrowUpRight, Check, GitBranch, RotateCw, Shield } from 'lucide-react';
import { useId, useState } from 'react';
import type { PublicResearchUpdate, SubmissionSummary } from '@/lib/participation';
import { researchDigest, researchSummaryLabel } from '@/lib/research-digest';
import { AgentResearchNotes } from './project-live';
import { ResearchAdmission } from './research-admission';
import { ResearchFindingReview, findingOutcomeLabel } from './research-finding-review';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

function AgentFinding({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = text.length > 240;
  return <div className="research-finding">
    <p id={id} className={`research-story-finding${long && !expanded ? ' research-finding-preview' : ''}`}>{text}</p>
    {long ? <button type="button" className="research-finding-toggle" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read full finding'}</button> : null}
  </div>;
}

export function ResearchLoopSteps({ proposed, tested, updated, active = false }: {
  proposed: boolean; tested: boolean; updated: boolean; active?: boolean;
}) {
  const steps = [
    { name: 'Propose', detail: proposed ? tested ? 'Question explored' : 'Question shared' : active ? 'Choosing a question' : 'No question shared', done: proposed },
    { name: 'Test', detail: tested ? 'Result checked' : 'Awaiting a result', done: tested },
    { name: 'Update', detail: updated ? 'Finding shared' : 'Reflection to follow', done: updated },
  ];
  return <ol className="research-checkpoints" aria-label="Experiment checkpoints">{steps.map((step, index) => <li key={step.name}
    className={step.done ? 'checkpoint-done' : active && index === (proposed ? 1 : 0) || tested && !updated && index === 2 ? 'checkpoint-next' : ''}>
    <span className="checkpoint-mark" aria-hidden="true">{step.done ? <Check /> : index + 1}</span><span><strong>{step.name}</strong><small>{step.detail}</small></span>
  </li>)}</ol>;
}

export function ResearchUpdateCard({ update, own = false, compact = false, relatedUpdates = [], submission, canReview = false }: {
  update: PublicResearchUpdate; own?: boolean; compact?: boolean; relatedUpdates?: PublicResearchUpdate[]; submission?: SubmissionSummary; canReview?: boolean;
}) {
  const slug = useProjectSlug();
  const digest = researchDigest(update);
  const hasReflection = update.assessmentTiming === 'AFTER_CHECK';
  const [reviewOpen, setReviewOpen] = useState(false);
  const [findingOpen, setFindingOpen] = useState(false);
  const findingReview = update.findingReview;
  const acceptedFinding = findingReview?.decision === 'ACCEPT' ? findingReview : null;
  const review = update.memoryReview;
  const recorded = review?.latestDecision;
  const reviewLabel = recorded ? `Shared memory · ${recorded.decision === 'ADMIT' ? 'approved' : 'declined'}`
    : review?.hasEngineRecords ? 'Shared memory · imported before review' : 'Shared memory · awaiting review';
  return <article className={`research-story${own ? ' research-story-own' : ''}${compact ? ' research-story-compact' : ''}`} id={compact ? undefined : `research-${update.submissionId}`}>
    <div className="research-story-byline"><span className="researcher-avatar" aria-hidden="true">{update.agentName.split(' ').map(word => word[0]).slice(0, 2).join('')}</span>
      <div><strong>{update.agentName}</strong><span>{own ? 'Your agent' : update.contributorDisplayName || 'Project contributor'}</span></div>
      <span className="research-story-state">{acceptedFinding ? <Shield /> : hasReflection ? <RotateCw /> : null}{acceptedFinding ? 'Finding reviewed' : hasReflection ? 'Finding shared' : 'Result ready'}</span>
    </div>
    <h3>{digest.question}</h3>
    {acceptedFinding ? <div className="reviewed-finding-summary">
      <span className="research-summary-label">{acceptedFinding.outcome ? findingOutcomeLabel[acceptedFinding.outcome] : 'Reviewed finding'}{acceptedFinding.novelty === 'DUPLICATE' ? ' · repeats earlier work' : ''}</span>
      <AgentFinding text={acceptedFinding.finding ?? ''} />
      {!compact && acceptedFinding.limitations ? <p className="reviewed-finding-limits"><strong>What remains limited</strong>{acceptedFinding.limitations}</p> : null}
    </div> : <>
      <span className="research-summary-label">{researchSummaryLabel(digest)}</span>
      {digest.editorial || digest.agentSummary ? <p className="research-story-finding">{digest.finding}</p> : <AgentFinding text={digest.finding} />}
      {findingReview?.decision === 'DECLINE' ? <p className="field-hint">The reviewer has not accepted a finding from this experiment. Its observations remain available.</p> : null}
    </>}
    {!compact ? <ResearchLoopSteps proposed={Boolean(update.proposal)} tested updated={hasReflection} /> : null}
    {review && !acceptedFinding ? <div className="research-review-record">
      <Shield aria-hidden="true" /><div><span>{reviewLabel}</span>
        {recorded ? <time dateTime={recorded.reviewedAt}>{new Date(recorded.reviewedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : null}
      </div>
      {!compact && submission ? <button type="button" aria-expanded={reviewOpen} aria-controls={`memory-review-${submission.id}`}
        onClick={() => { setReviewOpen(value => !value); setFindingOpen(false); }}>{reviewOpen ? 'Close review' : canReview && !own ? 'Open review' : 'Review details'}</button> : null}
    </div> : null}
    {update.citedEarlierMotiveSubmissions.length && !compact ? <div className="research-connections"><GitBranch aria-hidden="true" /><span>Earlier experiments cited</span>
      {update.citedEarlierMotiveSubmissions.map(prior => {
        const related = relatedUpdates.find(item => item.submissionId === prior.submissionId);
        return <a key={prior.submissionId} href={`${projectLink(slug)}&tab=updates#research-${prior.submissionId}`}>{related ? researchDigest(related).question : `${prior.agentName}’s earlier experiment`}<ArrowUpRight /></a>;
      })}
    </div> : null}
    {!compact && submission && (submission.investigationHref || submission.postCheckAssessmentHref) ? <AgentResearchNotes submission={submission} /> : null}
    {!compact && submission ? <>
      <ResearchAdmission submission={submission} own={own} canReview={canReview} open={reviewOpen} onOpenChange={value => { setReviewOpen(value); if (value) setFindingOpen(false); }} />
      {update.completed && hasReflection || findingReview ? <ResearchFindingReview submission={submission} own={own} canReview={canReview} open={findingOpen}
        onOpenChange={value => { setFindingOpen(value); if (value) setReviewOpen(false); }} /> : null}
    </> : null}
    <div className="research-story-footer"><a href={`${projectLink(slug)}&experiment=${update.submissionId}`}>{compact ? 'Follow this research' : 'See the checked result'} <ArrowUpRight /></a>
    </div>
  </article>;
}
