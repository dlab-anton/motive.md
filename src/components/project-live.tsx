import { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Clock3, FileText } from 'lucide-react';
import type { ParticipationMeResponse, ParticipationPublicProjection, PublicPostCheckAssessment, PublicSubmissionInvestigation, PublicSubmissionReproducibility, SubmissionSummary } from '@/lib/participation';
import { circlePackingProfile } from '@/lib/projects';
import { CheckedArrangement } from './project-reference';
import { ResearchIntentCard } from './research-intent';
import { researchDigest } from '@/lib/research-digest';
import { useSubmissionOwnership } from '@/lib/submission-ownership';
import { ArrangementComparison } from './arrangement-comparison';
import { useLocation } from 'react-router-dom';

export function projectLifecycleLabel(project: ParticipationPublicProjection | null) {
  if (!project) return 'Checking activity';
  if ((project.loopProgress?.activeAgents ?? project.activeAssignments) > 0) return 'Experiments in progress';
  return project.project.lifecycle === 'RESULTS_AVAILABLE' ? `${project.totalSubmissions} ${project.totalSubmissions === 1 ? 'experiment' : 'experiments'} shared` : project.project.lifecycle === 'CONTRIBUTING' ? 'Contributions underway' : 'Open for contributions';
}

export function SubmissionReview(_props: { submission: SubmissionSummary }) {
  return null;
}

function useEvidenceRecord<T>(href: string) {
  const [record, setRecord] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (record) return;
    const controller = new AbortController();
    void fetch(href, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('The research record could not be loaded.');
      const value = await response.json() as T;
      if (!controller.signal.aborted) { setRecord(value); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The research record could not be loaded.'); });
    return () => controller.abort();
  }, [href, record]);
  return { record, error };
}

function PostCheckRecord({ href }: { href: string }) {
  const { record, error } = useEvidenceRecord<PublicPostCheckAssessment>(href);
  return <section className="investigation-record" aria-label="Assessment after the geometry check">
    <span className="eyebrow">The agent’s reflection</span>
    <h4>What the result tells us</h4>
    {record ? <div className="investigation-loop"><p>{record.assessment}</p><details><summary>Possible follow-up · contributor suggestion</summary><p>{record.nextAction}</p><p className="field-hint">The next researcher chooses its own test from the goal and evidence. This suggestion is optional.</p></details><p className="field-hint">Recorded by {record.attribution.contributorDisplayName || 'Private contributor'}’s agent, {record.attribution.agentName}, after receiving the report. This is the contributor’s interpretation. The finding assessment separately records what an independent reviewer accepts.</p></div>
      : <p role="status">{error || 'Loading the follow-up assessment…'}</p>}
    <a href={href} target="_blank" rel="noreferrer">Read the assessment record ↗</a>
  </section>;
}

function InvestigationRecord({ href, hasPostCheck }: { href: string; hasPostCheck: boolean }) {
  const { record, error } = useEvidenceRecord<PublicSubmissionInvestigation>(href);
  const notes = record?.investigation;
  return <section className="investigation-record">
    <h4>What the agent tried</h4>
    {notes ? <div className="investigation-loop">
      <p>{notes.proposal}</p>
      {record?.claimIntent ? <details className="initial-research-plan"><summary>Compare with the initial plan</summary><ResearchIntentCard intent={record.claimIntent} historical /></details> : null}
      {hasPostCheck ? <details><summary>Earlier assessment</summary><p>{notes.assessment}</p><p className="field-hint">The agent shared this assessment with the candidate, before receiving the checker report.</p></details>
        : <section><h4>The agent’s assessment</h4><p>{notes.assessment}</p></section>}
      <details><summary>Possible follow-up</summary><p>{notes.nextAction}</p><p className="field-hint">An optional suggestion from this agent. The next researcher chooses its own question.</p></details>
      <details><summary>Experiment conditions and observations</summary><p><strong>Expected:</strong> {notes.expectation}</p><p className="eyebrow">Conditions</p><ul>{notes.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul><p className="eyebrow">Reported observations</p><ul>{notes.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul></details>
    </div> : <p role="status">{error || 'Loading research notes…'}</p>}
    <a href={href} target="_blank" rel="noreferrer">Read the full research record ↗</a>
  </section>;
}

function exactGain(score: string, reference: string = circlePackingProfile.laterReference.score): string {
  const parts = [score, reference].map(value => value.split('.'));
  const precision = Math.max(...parts.map(value => (value[1] ?? '').length));
  const integers = parts.map(([whole, fraction = '']) => BigInt(whole! + fraction.padEnd(precision, '0')));
  const delta = integers[0]! - integers[1]!;
  const digits = (delta < 0n ? -delta : delta).toString().padStart(precision + 1, '0');
  const value = precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
  return `${delta > 0n ? '+' : delta < 0n ? '−' : ''}${value}`;
}

function SubmittedArrangement({ submission }: { submission: SubmissionSummary }) {
  if (!submission.exactScore) return null;
  return <section className="submission-arrangement"><h4>Circle arrangement</h4><CheckedArrangement submitted candidate={{ artifactUrl: submission.artifactHref,
    artifactSha256: submission.artifactSha256, score: submission.exactScore }} /></section>;
}

function ReproducibilityFiles({ href }: { href: string }) {
  const { record, error } = useEvidenceRecord<PublicSubmissionReproducibility>(href);
  if (!record) return <p role="status">{error || 'Loading source and trial files…'}</p>;
  return <div className="reproducibility-files"><p>The contributor’s source and trial log, retained with this result. These files were not executed or checked by Motive.</p>
    <div className="evidence-file-links">{record.files.map(file => <a key={file.role} href={file.href} download><span>{file.role === 'SOLVER_SOURCE' ? 'Download solver source' : 'Download trial log'}<small>{(file.bytes / 1024).toFixed(1)} KiB · plain text</small></span><ArrowUpRight aria-hidden="true" /></a>)}</div>
    <a className="inline-link" href={href} target="_blank" rel="noreferrer">File digests and attribution ↗</a>
  </div>;
}

export function AgentResearchNotes({ submission }: { submission: SubmissionSummary }) {
  const [open, setOpen] = useState(false);
  return <details className="agent-research-notes" onToggle={event => setOpen(event.currentTarget.open)}><summary>{submission.agentName}’s full research notes</summary>{open ? <>
    {submission.postCheckAssessmentHref ? <PostCheckRecord key={submission.postCheckAssessmentHref} href={submission.postCheckAssessmentHref} /> : null}
    {submission.investigationHref ? <InvestigationRecord key={submission.investigationHref} href={submission.investigationHref} hasPostCheck={Boolean(submission.postCheckAssessmentHref)} /> : null}
  </> : null}</details>;
}

function SubmissionEvidenceRow({ submission, update, earlier, owned, canReview, deepLinked }: {
  submission: SubmissionSummary;
  update: NonNullable<ParticipationPublicProjection['researchUpdates']>[number] | undefined;
  earlier: SubmissionSummary | undefined;
  owned: boolean | null | undefined;
  canReview: boolean;
  deepLinked: boolean;
}) {
  const [open, setOpen] = useState(deepLinked);
  useEffect(() => { if (deepLinked) setOpen(true); }, [deepLinked]);
  const digest = update ? researchDigest(update) : null;
  const earlierGain = submission.exactScore && earlier?.exactScore ? exactGain(submission.exactScore, earlier.exactScore) : null;
  const title = submission.reportStatus === 'VALID'
    ? earlierGain?.startsWith('−') ? 'An earlier candidate remains ahead'
      : earlierGain === '0' ? 'A valid candidate matching an earlier score'
        : submission.exceedsReference ? 'A valid candidate above the reference' : 'A valid candidate without an improvement'
    : submission.reportStatus === 'REJECTED' ? 'This candidate did not pass the check' : 'This test was inconclusive';
  return <details className="task-row result-row" id={`submission-${submission.id}`} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="result-row-summary">
      <span className="task-agent" title={submission.agentName}>{submission.agentName}</span>
      <strong className="task-title" title={digest?.question || title}>{digest?.question || title}</strong>
      <span className={`task-status${submission.reportStatus === 'VALID' ? ' is-complete' : ''}`} title="Geometry check; finding acceptance is separate">{submission.reportStatus === 'VALID' ? 'Valid' : submission.reportStatus === 'REJECTED' ? 'Rejected' : 'Inconclusive'}</span>
      <time dateTime={submission.createdAt}>{new Date(submission.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time>
    </summary>
    {open ? <div className="result-row-detail">
      {submission.modelName ? <p className="field-hint">{submission.modelName} · contributor-reported model</p> : null}
      {submission.exactScore ? <div className="submission-score"><span>Exact sum of radii</span><strong>{submission.exactScore}</strong><p><strong className="submission-gain">{exactGain(submission.exactScore)}</strong> compared with the frozen reference.</p>{earlier && earlierGain !== null && submission.reportStatus === 'VALID' ? <ArrangementComparison current={submission} earlier={earlier} gain={earlierGain} /> : null}</div> : <p className="submission-explanation">No valid score was established by this check. The report below explains the result.</p>}
      <div className="submission-acceptance"><Clock3 /><span>{submission.acceptance === 'ACCEPTED' ? 'Accepted by a project reviewer' : submission.acceptance === 'REJECTED' ? 'Acceptance declined' : 'Awaiting project review'}</span><time dateTime={submission.createdAt}>{new Date(submission.createdAt).toLocaleString()}</time></div>
      {submission.reportStatus === 'VALID' && submission.exactScore ? <SubmittedArrangement submission={submission} /> : null}
      {update ? <a className="inline-link evidence-research-link" href={`/?project=circle-packing&tab=updates#research-${submission.id}`}>Read the research behind this result <ArrowUpRight /></a> : submission.investigationHref ? <a className="inline-link evidence-research-link" href={submission.investigationHref}>Read the research record <ArrowUpRight /></a> : null}
      <section className="submission-files"><h4>Evidence files</h4><div className="evidence-file-links"><a href={submission.artifactHref} target="_blank" rel="noreferrer">Circle positions and sizes<ArrowUpRight /></a><a href={submission.reportHref} target="_blank" rel="noreferrer">Exact geometry check<ArrowUpRight /></a></div></section>
      {submission.reproducibilityHref ? <section className="submission-files"><h4>Reproduce this experiment</h4><ReproducibilityFiles key={submission.reproducibilityHref} href={submission.reproducibilityHref} /></section> : null}
      {canReview && owned === false && submission.acceptance === 'PENDING' ? <SubmissionReview submission={submission} /> : null}
    </div> : null}
  </details>;
}

export function SubmittedEvidence({ data, me, accountId = null }: { data: ParticipationPublicProjection | null; me: ParticipationMeResponse | null; accountId?: string | null }) {
  const location = useLocation();
  const ownership = useSubmissionOwnership(accountId, data?.submissions.map(item => item.id) ?? []);
  if (!data?.submissions.length) return <p>{data ? 'No community submissions have arrived yet. The checked starting reference is below.' : 'Loading submitted evidence…'}</p>;
  // Compare only recorded, earlier checked candidates. A bounded page is not
  // the whole research history, so this does not label a global best.
  const earlierCandidates = new Map<string, SubmissionSummary>();
  let strongest: SubmissionSummary | null = null;
  for (const submission of [...data.submissions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (strongest && strongest.createdAt < submission.createdAt) earlierCandidates.set(submission.id, strongest);
    if (submission.reportStatus === 'VALID' && submission.exactScore
        && (!strongest?.exactScore || exactGain(submission.exactScore, strongest.exactScore).startsWith('+'))) strongest = submission;
  }
  return <div className="submitted-evidence">{ownership.unavailable ? <p className="field-hint">Your contribution labels could not be checked. <button className="inline-link" onClick={ownership.reload}>Retry personal view</button></p> : null}{data.submissions.map(submission => {
    const update = data.researchUpdates?.find(item => item.submissionId === submission.id);
    const earlier = earlierCandidates.get(submission.id);
    const owned = ownership.owned(submission.id);
    return <SubmissionEvidenceRow key={submission.id} submission={submission} update={update} earlier={earlier} owned={owned}
      canReview={Boolean(me?.canReview)} deepLinked={location.hash === `#submission-${submission.id}`} />;
  })}</div>;
}
