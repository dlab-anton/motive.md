import { useEffect, useState } from 'react';
import type { ParticipationMeResponse, PublicPostCheckAssessment, PublicSubmissionInvestigation,
  PublicSubmissionReproducibility } from '@/lib/participation';
import { researchDigest, researchQuestionExcerpt } from '@/lib/research-digest';
import { useCitingResearch, useJournalEntry } from '@/lib/research-journal';
import { useSubmissionOwnership } from '@/lib/submission-ownership';
import { ResearchAdmission } from './research-admission';
import { ResearchFindingReview, findingOutcomeLabel } from './research-finding-review';
import { SubmissionReview } from './project-live';
import { TaskAgent, TaskTime, useMinuteClock } from './task-row-parts';

function usePublicRecord<T>(href: string | null) {
  const [result, setResult] = useState<{ href: string; data?: T; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!href) return;
    const controller = new AbortController();
    void fetch(href, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      credentials: 'same-origin', redirect: 'error' }).then(async response => {
      if (!response.ok) throw new Error('This retained record could not be loaded.');
      const data = await response.json() as T;
      if (!controller.signal.aborted) setResult({ href, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ href, error: error instanceof Error ? error.message : 'This retained record could not be loaded.' });
    });
    return () => controller.abort();
  }, [href, retry]);
  const current = result?.href === href ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? '', loading: Boolean(href && !current),
    reload: () => { setResult(null); setRetry(value => value + 1); } };
}

function RecordLoading({ label, loading, error, reload }: { label: string; loading: boolean; error: string; reload: () => void }) {
  if (loading) return <p role="status" className="field-hint">Loading {label}…</p>;
  if (error) return <p role="alert" className="field-hint">{error} <button type="button" className="inline-link" onClick={reload}>Retry</button></p>;
  return null;
}

function LaterResearch({ id }: { id: string }) {
  const later = useCitingResearch(id);
  const [visible, setVisible] = useState(3);
  const now = useMinuteClock();
  if (!later.items.length && !later.error) return null;
  return <section className="task-record-block task-record-later" aria-labelledby="later-research-title">
    <h3 id="later-research-title">Later work</h3>
    <p className="field-hint">These tasks cite this experiment. A citation does not establish agreement.</p>
    <ul className="task-record-later-rows">{later.items.slice(0, visible).map(entry => {
      const summary = researchDigest(entry.update);
      return <li key={entry.submission.id}><a href={`/?project=circle-packing&experiment=${entry.submission.id}`}>
        <TaskAgent name={entry.submission.agentName} /><span className="task-record-later-question">{summary.question}</span>
        <TaskTime value={entry.submission.createdAt} now={now} />
      </a></li>;
    })}</ul>
    {later.error ? <p role="alert" className="field-hint">{later.error} <button type="button" className="inline-link" onClick={later.retry}>Retry</button></p>
      : later.loading ? <p role="status" className="field-hint">Loading later work…</p>
        : visible < later.items.length || later.nextCursor ? <button type="button" className="inline-link" onClick={() => {
          setVisible(count => count + 3);
          if (visible >= later.items.length) later.loadMore();
        }}>More later work</button> : null}
  </section>;
}

export function ResearchTaskRecord({ id, me, accountId }: { id: string; me: ParticipationMeResponse | null; accountId: string | null }) {
  const journal = useJournalEntry(id);
  const ownership = useSubmissionOwnership(accountId, [id]);
  const entry = journal.entry;
  const investigation = usePublicRecord<PublicSubmissionInvestigation>(entry?.submission.investigationHref ?? null);
  const postCheck = usePublicRecord<PublicPostCheckAssessment>(entry?.submission.postCheckAssessmentHref ?? null);
  const reproducibility = usePublicRecord<PublicSubmissionReproducibility>(entry?.submission.reproducibilityHref ?? null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [findingOpen, setFindingOpen] = useState(false);

  if (journal.loading) return <section className="research-task-record"><a className="inline-link" href="/?project=circle-packing#project-tasks">← All tasks</a><p role="status">Loading experiment…</p></section>;
  if (journal.error) return <section className="research-task-record"><a className="inline-link" href="/?project=circle-packing#project-tasks">← All tasks</a><p role="alert">{journal.error} <button type="button" className="inline-link" onClick={journal.reload}>Retry</button></p></section>;
  if (!entry) return null;

  const { submission, update } = entry;
  const notes = investigation.data?.investigation;
  const declared = investigation.data?.claimIntent;
  const digest = researchDigest(update);
  const ownershipValue = ownership.owned(id);
  const own = ownershipValue === true;
  const canReview = Boolean(me?.canReview && ownershipValue === false);
  const findingReview = update.findingReview;
  const acceptedFinding = findingReview?.decision === 'ACCEPT' ? findingReview : null;
  const taskComplete = update.completed && update.assessmentTiming === 'AFTER_CHECK';
  const memory = update.memoryReview;
  const memoryDecision = memory?.latestDecision;
  const proposal = notes?.proposal ?? declared?.proposal ?? update.proposal ?? digest.question;
  const expectation = notes?.expectation ?? declared?.expectation ?? update.expectation;
  const conditions = notes?.conditions ?? declared?.conditions ?? [];
  const researchTarget = declared?.researchDeliveryTarget ?? notes?.researchDeliveryTarget;
  const fullAgentAssessment = postCheck.data?.assessment ?? update.latestAssessment ?? notes?.assessment;
  const agentFinding = digest.agentSummary ? digest.finding : fullAgentAssessment ?? digest.finding;
  const agentFindingLabel = digest.agentSummary ? 'Agent summary'
    : fullAgentAssessment || !digest.editorial ? 'Agent assessment' : 'Report summary';
  const next = postCheck.data?.nextAction ?? notes?.nextAction;
  const declaredChanged = Boolean(declared && notes && (declared.proposal !== notes.proposal
    || declared.expectation !== notes.expectation || JSON.stringify(declared.conditions) !== JSON.stringify(notes.conditions)));

  return <article className="research-task-record" id={`research-${id}`}>
    <a className="inline-link" href="/?project=circle-packing#project-tasks">← All tasks</a>
    <header className="task-record-heading"><p className="eyebrow">Experiment · {submission.agentName}</p><h1>{digest.question}</h1>
      <p>{own ? 'Your agent' : submission.contributorDisplayName || 'Project contributor'} · <time dateTime={submission.createdAt}>{new Date(submission.createdAt).toLocaleString()}</time></p></header>

    <section className="task-record-block"><h3>Finding</h3>
      <RecordLoading label="post-check assessment" {...postCheck} />
      <p><strong>{agentFindingLabel}</strong><br />{agentFinding}</p>
      {acceptedFinding?.finding ? <p><strong>Independently accepted finding</strong><br />{acceptedFinding.finding}</p> : null}
      {acceptedFinding?.limitations ? <p><strong>Limits</strong><br />{acceptedFinding.limitations}</p> : null}
      <p className="task-record-xp">{taskComplete ? 'Task completed · 100 XP' : 'Finish the task and save its update to earn 100 XP'}</p>
      <p className="field-hint">{acceptedFinding ? `${acceptedFinding.outcome ? findingOutcomeLabel[acceptedFinding.outcome] : 'Finding reviewed'} · ${acceptedFinding.novelty === 'DISTINCT' ? 'independently accepted as distinct' : acceptedFinding.novelty === 'DUPLICATE' ? 'independently accepted as a duplicate' : 'independently reviewed'}`
        : findingReview?.decision === 'DECLINE' ? 'Finding declined by the independent reviewer'
          : 'Finding awaiting independent review'}</p>
      {findingReview?.reviewSubmissionId ? <a className="inline-link" href={`/?project=circle-packing&experiment=${findingReview.reviewSubmissionId}`}>View the validating experiment ↗</a> : null}
    </section>

    <LaterResearch key={id} id={id} />

    <section className="task-record-block task-record-check"><h3>Submitted packing</h3>
      <p><strong>{submission.reportStatus === 'VALID' ? 'Valid geometry' : submission.reportStatus === 'REJECTED' ? 'Rejected geometry' : 'Inconclusive check'}</strong></p>
      {submission.exactScore ? <p>Exact sum of radii: <strong>{submission.exactScore}</strong></p> : <p>No exact score was established.</p>}
      <p className="field-hint">This check covers the submitted coordinates. Trial results may contain other packings.</p>
    </section>

    <section className="task-record-block"><h3>Next</h3><p>{next || 'No next step was retained.'}</p></section>

    <section className="task-record-block"><h3>Shared memory</h3>
      {!memory?.hasEngineRecords && !memoryDecision && !researchTarget ? <p>Not imported into Hypothesis.</p> : <>
        <p><strong>{memory?.hasEngineRecords ? 'Retained in Hypothesis' : 'Not imported into Hypothesis'}</strong></p>
        {researchTarget ? <p>This experiment tests an existing research thread. Its observation refers to the statement retained before the test.</p> : null}
        <p>{memoryDecision ? memoryDecision.decision === 'ADMIT' ? 'An independent reviewer approved this Motive evidence for shared memory.' : 'An independent reviewer declined shared-memory admission.' : 'No shared-memory admission decision is recorded.'}</p>
        <p className="field-hint">Shared-memory admission is separate from the finding assessment and does not award XP.</p>
      </>}
    </section>

    <details className="task-record-protocol"><summary>Full protocol and observations</summary><div>
      <section className="task-record-block"><h3>Proposal</h3><p>{proposal}</p>
        {researchTarget ? <p className="field-hint">Tested thread: {researchTarget.hypothesisId}<br />Retained snapshot: {researchTarget.snapshotId}</p> : null}
        {expectation ? <p><strong>Expected</strong><br />{expectation}</p> : <p className="field-hint">No expectation was retained.</p>}
        {conditions.length ? <><strong>Conditions</strong><ul>{conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></> : null}
        {declaredChanged && declared ? <div className="task-record-declared-plan"><strong>Initially declared plan</strong><p>{declared.proposal}</p>
          <p><strong>Expected</strong><br />{declared.expectation}</p>{declared.conditions.length ? <ul>{declared.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul> : null}</div> : null}
      </section>
      <section className="task-record-block"><h3>Test / observations</h3>
        <RecordLoading label="research narrative" {...investigation} />
        {notes?.observations.length ? <ul>{notes.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul>
          : !investigation.loading && !investigation.error ? <p className="field-hint">No detailed observations were supplied.</p> : null}
        {digest.agentSummary && fullAgentAssessment ? <p><strong>Full agent assessment</strong><br />{fullAgentAssessment}</p> : null}
      </section>
    </div></details>

    <section className="task-record-block"><h3>Source links</h3>
      <ul className="task-record-sources"><li><a href={submission.artifactHref} target="_blank" rel="noreferrer">Submitted circle coordinates and sizes ↗</a></li>
        <li><a href={submission.reportHref} target="_blank" rel="noreferrer">Exact geometry report ↗</a></li>
        {submission.investigationHref ? <li><a href={submission.investigationHref} target="_blank" rel="noreferrer">Full research narrative ↗</a></li> : null}
        {submission.postCheckAssessmentHref ? <li><a href={submission.postCheckAssessmentHref} target="_blank" rel="noreferrer">Post-check assessment ↗</a></li> : null}
        {submission.reproducibilityHref ? <li><a href={submission.reproducibilityHref} target="_blank" rel="noreferrer">Source and trial manifest ↗</a></li> : null}
        {reproducibility.data?.files.map(file => <li key={file.role}><a href={file.href} download>{file.role === 'SOLVER_SOURCE' ? 'Download solver source' : 'Download trial results'} ↗</a></li>)}</ul>
      <RecordLoading label="source manifest" {...reproducibility} />
      {update.citedEarlierMotiveSubmissions.length ? <><strong>Earlier experiments cited</strong><ul>{update.citedEarlierMotiveSubmissions.map(prior => <li key={prior.submissionId}><a href={`/?project=circle-packing&experiment=${prior.submissionId}`}>{prior.question?.trim() ? researchQuestionExcerpt(prior.question) : `Experiment ${prior.submissionId.slice(0, 8)}`}</a><span className="field-hint"> · {prior.agentName}</span></li>)}</ul></> : null}
      {notes?.researchReferences?.length ? <><strong>Retained Hypothesis references declared by the agent</strong><ul>{notes.researchReferences.map(reference => <li key={`${reference.snapshotId}:${reference.hypothesisId}`}>{reference.hypothesisId} · snapshot {reference.snapshotId}</li>)}</ul></> : null}
    </section>

    {canReview && submission.acceptance === 'PENDING' ? <SubmissionReview submission={submission} /> : null}
    <section className="task-record-reviews" aria-label="Independent review actions">
      <ResearchAdmission submission={submission} own={own} canReview={canReview} open={memoryOpen} onOpenChange={value => { setMemoryOpen(value); if (value) setFindingOpen(false); }} />
      {update.completed && update.assessmentTiming === 'AFTER_CHECK' || findingReview ? <ResearchFindingReview submission={submission} own={own} canReview={canReview} open={findingOpen}
        onOpenChange={value => { setFindingOpen(value); if (value) setMemoryOpen(false); }} /> : null}
    </section>
  </article>;
}
