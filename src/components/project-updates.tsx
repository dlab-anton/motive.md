import { Bell, BellOff, CheckCircle2, Newspaper, ScanSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import type { Project } from '@/lib/projects';
import { Button } from './ui/button';
import type { SupportControls } from './backing';
import type { ParticipationMeResponse, ParticipationPublicProjection, PublicResearchHandoff, ResearchJournalEntry, ResearchJournalPage } from '@/lib/participation';
import { useProjectResource } from '@/lib/project-api';
import { journalIdPattern, mergeJournalEntries, readJournalPage, useJournalEntry } from '@/lib/research-journal';
import { useSubmissionOwnership } from '@/lib/submission-ownership';
import { ResearchReviewQueues } from './finding-review-queue';
import { HandoffRow, useResearchHandoffs } from './research-handoffs';
import { researchDigest, researchQuestionExcerpt } from '@/lib/research-digest';
import { ResearchTaskRecord } from './research-task-record';
import { QueueNext, TaskAgent, TaskStatusIcon, TaskTime, useMinuteClock } from './task-row-parts';
import { completedChronologicalPrefix, mergeChronologicalTasks } from '@/lib/task-list';

export function FollowProject({ project, controls }: { project: Project; controls: SupportControls }) {
  const following = controls.state.following.includes(project.id);
  return <Button variant="outline" disabled={controls.busy} aria-pressed={following} onClick={async () => {
    if (await controls.send({ type: 'follow', goal: project.id, following: !following })) {
      toast(following ? 'Project unfollowed' : 'Project followed', { description: 'Following saves this project to your local workspace. It does not reserve funds or start work.' });
    }
  }}>{following ? <BellOff /> : <Bell />}{following ? 'Following' : 'Follow project'}</Button>;
}

export function ProjectUpdates({ data, me, accountId = null }: { data: ParticipationPublicProjection | null; me: ParticipationMeResponse | null; accountId?: string | null }) {
  const [view, setView] = useState<'everyone' | 'mine' | 'review'>('everyone');
  const location = useLocation();
  // A copied experiment link is public; it may refer to somebody else's work.
  useEffect(() => { if (location.hash.startsWith('#research-') || location.hash.startsWith('#handoff-') || location.hash === '#active-research') setView('everyone'); }, [location.key, location.hash]);
  useEffect(() => { if (!me?.canReview && view === 'review') setView('everyone'); }, [me?.canReview, view]);
  const onlyMine = view === 'mine' && Boolean(me);
  const reviewing = view === 'review' && Boolean(me?.canReview && accountId);
  const experiment = new URLSearchParams(location.search).get('experiment');
  const legacyExperiment = location.hash.startsWith('#research-') ? location.hash.slice('#research-'.length)
    : location.hash.startsWith('#submission-') ? location.hash.slice('#submission-'.length) : '';
  const selectedExperiment = experiment && journalIdPattern.test(experiment) ? experiment
    : journalIdPattern.test(legacyExperiment) ? legacyExperiment : null;
  if (selectedExperiment) return <ResearchTaskRecord key={selectedExperiment} id={selectedExperiment} me={me} accountId={accountId} />;
  return <div className="research-journal">
    <div className="section-heading-row task-list-heading"><h2>Tasks</h2><span className="task-refresh-note">Updates automatically</span>{me ? <select className="journal-view-choice" aria-label="Filter tasks" value={view} onChange={event => setView(event.target.value as typeof view)}><option value="everyone">All agents</option><option value="mine">My agents</option>{me.canReview && accountId ? <option value="review">To assess</option> : null}</select> : null}</div>
    {reviewing ? <ResearchReviewQueues key={accountId} /> : <JournalEntries key={`${accountId}:${onlyMine ? 'mine' : 'everyone'}`} data={data} me={me} onlyMine={onlyMine} accountId={accountId} />}
  </div>;
}

function ExperimentRow({ entry, now }: { entry: ResearchJournalEntry; now: number }) {
  const digest = researchDigest(entry.update);
  return <a className="experiment-row task-row task-row-link" href={`/?project=circle-packing&experiment=${entry.submission.id}`}>
    <TaskAgent name={entry.update.agentName} /><span className="task-main"><strong className="task-title" title={digest.question}>{digest.question}</strong></span>
    <TaskStatusIcon kind={entry.update.completed && entry.update.assessmentTiming === 'AFTER_CHECK' ? 'complete' : 'needs-update'} /><TaskTime value={entry.submission.createdAt} now={now} />
  </a>;
}

type TimelineItem = { id: string; createdAt: string } & (
  { kind: 'experiment'; entry: ResearchJournalEntry }
  | { kind: 'handoff'; item: PublicResearchHandoff }
);

function JournalEntries({ data, me, onlyMine, accountId }: { data: ParticipationPublicProjection | null; me: ParticipationMeResponse | null; onlyMine: boolean; accountId: string | null }) {
  const location = useLocation();
  const now = useMinuteClock();
  const challenge = !onlyMine ? data?.challengeOutcome : null;
  const pinned = challenge && challenge.status !== 'OPEN' ? challenge.candidate : null;
  const lastScrolled = useRef('');
  const ownPage = useProjectResource<ResearchJournalPage>(onlyMine ? '/api/participation/research-updates' : null);
  const [history, setHistory] = useState<ResearchJournalEntry[] | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(10);
  // undefined means the first page still owns the continuation cursor.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const handoffs = useResearchHandoffs({ data, onlyMine });
  useEffect(() => () => { pending.current?.abort(); }, []);
  const ownClaims = new Set(me?.assignments.map(item => item.claimId));
  const summaries = new Map(data?.submissions.map(item => [item.id, item]));
  const latest: ResearchJournalEntry[] = onlyMine ? ownPage.data?.items ?? [] : (data?.researchUpdates ?? []).flatMap(update => {
    const submission = summaries.get(update.submissionId);
    return submission ? [{ update, submission }] : [];
  });
  // Keep a stable place once browsing older work. A bounded live head cannot
  // safely fill every gap if many new experiments arrive between polls.
  const entries = history ?? latest;
  const newerAvailable = Boolean(history && latest.some(item => !history.some(older => older.submission.id === item.submission.id))) || handoffs.stale;
  const requestedId = location.hash.startsWith('#research-') ? location.hash.slice('#research-'.length) : '';
  const focused = useJournalEntry(!onlyMine && journalIdPattern.test(requestedId) && data && !entries.some(item => item.submission.id === requestedId) ? requestedId : null);
  const ownership = useSubmissionOwnership(onlyMine ? null : accountId,
    [...entries.map(item => item.submission.id), ...(focused.entry ? [focused.entry.submission.id] : [])]);
  const continuation = cursor !== undefined ? cursor : onlyMine ? ownPage.data?.nextCursor ?? null
    : data && data.totalSubmissions > latest.length ? latest.at(-1)?.submission.id ?? null : null;
  const timeline = mergeChronologicalTasks<TimelineItem>(
    entries.map(entry => ({ id: entry.submission.id, createdAt: entry.submission.createdAt, kind: 'experiment' as const, entry })),
    [...handoffs.items, ...(handoffs.focused ? [handoffs.focused] : [])]
      .map(item => ({ id: item.id, createdAt: item.createdAt, kind: 'handoff' as const, item })),
  );
  const completeTimeline = completedChronologicalPrefix(timeline, [
    ...(continuation && entries.length ? [entries.at(-1)!.submission.createdAt] : []),
    ...(handoffs.hasMore && handoffs.items.length ? [handoffs.items.at(-1)!.createdAt] : []),
  ]);
  const visibleTimeline = completeTimeline.slice(0, visibleLimit);
  const linkedHandoff = handoffs.requestedId ? timeline.find(item => item.kind === 'handoff' && item.id === handoffs.requestedId) : undefined;
  const linkedExperiment = requestedId ? timeline.find(item => item.kind === 'experiment' && item.id === requestedId) : undefined;
  const linkedRows: TimelineItem[] = [...(linkedHandoff ? [linkedHandoff] : []), ...(linkedExperiment ? [linkedExperiment] : [])];
  const displayed = linkedRows.length ? mergeChronologicalTasks(visibleTimeline, linkedRows) : visibleTimeline;
  const hasHidden = visibleTimeline.length < completeTimeline.length;
  const requestedExperimentIndex = completeTimeline.findIndex(item => item.kind === 'experiment' && item.id === requestedId);
  useEffect(() => {
    if (requestedExperimentIndex >= visibleLimit) setVisibleLimit(requestedExperimentIndex + 1);
  }, [requestedExperimentIndex, visibleLimit]);
  const loading = !data || onlyMine && (!ownPage.data && !ownPage.error || handoffs.initialLoading);
  const active = (data?.activeResearchIntents ?? []).filter(item => Date.parse(item.expiresAt) > now && (!onlyMine || ownClaims.has(item.claimId)));
  const ownActiveClaims = new Set((me?.assignments ?? []).flatMap(item => item.status === 'ACTIVE'
    && item.completedAt === null && item.claimId && item.expiresAt && Date.parse(item.expiresAt) > now ? [item.claimId] : []));
  const qualifiedClaimCount = onlyMine ? ownActiveClaims.size
    : typeof data?.loopProgress?.activeAgents === 'number' ? Math.max(0, data.loopProgress.activeAgents) : null;
  const unlistedClaimCount = qualifiedClaimCount === null ? null : Math.max(0, qualifiedClaimCount - active.length);
  const claimSummary = unlistedClaimCount && unlistedClaimCount > 0
    ? `${unlistedClaimCount}${active.length ? ' additional' : ''} ${unlistedClaimCount === 1 ? 'task' : 'tasks'} claimed.`
    : !active.length ? qualifiedClaimCount === null ? 'No active questions shared.'
      : qualifiedClaimCount === 0 ? 'No tasks currently claimed.' : null : null;
  async function loadOlderJournal(): Promise<boolean> {
    if (!continuation || pending.current) return false;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    // Keep this exact first page even if newer work arrives while the request runs.
    const retained = entries;
    setHistory(retained); setCursor(continuation);
    try {
      const page = await readJournalPage(onlyMine, continuation, controller.signal);
      if (!controller.signal.aborted) { setHistory(mergeJournalEntries(retained, page.items)); setCursor(page.nextCursor); return true; }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Older experiments could not be loaded.');
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    }
    return false;
  }
  async function loadOlder() {
    if (hasHidden) { setVisibleLimit(value => value + 10); return; }
    const results = await Promise.all([
      continuation ? loadOlderJournal() : Promise.resolve(false),
      handoffs.hasMore ? handoffs.loadOlder() : Promise.resolve(false),
    ]);
    if (results.some(Boolean)) setVisibleLimit(value => value + 10);
  }
  function resetHistory() {
    pending.current?.abort(); pending.current = null; setBusy(false); setHistory(null); setVisibleLimit(10); setCursor(undefined); setError('');
    handoffs.reset();
  }
  useEffect(() => {
    if (!journalIdPattern.test(requestedId) && location.hash !== '#active-research') return;
    const navigation = `${location.key}:${location.hash}`;
    if (lastScrolled.current === navigation) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target && lastScrolled.current !== navigation) {
      target.scrollIntoView({ block: 'start' }); lastScrolled.current = navigation;
    }
  }, [location.key, location.hash, requestedId, entries, focused.entry]);
  if (!data) return <div className="empty-state"><Newspaper /><h2>Loading the research…</h2></div>;
  return <>
    {focused.loading ? <p role="status">Loading the linked experiment…</p> : null}
    {focused.error ? <div className="journal-load-error" role="alert"><p>{focused.error}</p><Button size="sm" variant="outline" onClick={focused.reload}>Retry experiment</Button></div> : null}
    {focused.entry ? <p><a className="inline-link" href={`/?project=circle-packing&experiment=${focused.entry.submission.id}`}>Open the linked earlier experiment ↗</a></p> : null}
    {handoffs.focusError ? <div className="journal-load-error" role="alert"><p>{handoffs.focusError}</p><Button variant="outline" size="sm" onClick={handoffs.retryFocus}>Retry linked task</Button></div> : null}
    {handoffs.error ? <div className="journal-load-error" role="alert"><p>{handoffs.error}</p>{!handoffs.denied ? <Button variant="outline" size="sm" disabled={handoffs.busy} onClick={() => void handoffs.retry()}>Retry tasks</Button> : null}</div> : null}
    {ownPage.error ? <div className="journal-load-error" role="alert"><p>Your agents’ research could not be refreshed.{ownPage.data ? ' The last loaded page is shown.' : ''}</p><Button size="sm" variant="outline" onClick={ownPage.reload}>Retry my research</Button></div> : null}
    {ownership.unavailable ? <p className="field-hint">Your contribution labels could not be checked. <button className="inline-link" onClick={ownership.reload}>Retry personal view</button></p> : null}
    {newerAvailable ? <aside className="journal-new-work" role="status"><span>New tasks are available.</span><Button size="sm" variant="outline" onClick={resetHistory}>Show latest tasks</Button></aside> : null}
    {loading || handoffs.busy ? <p role="status">Loading tasks…</p> : null}
    <div className="task-column-head" aria-hidden="true"><span>Agent</span><span>Task</span><span><span className="sr-only">Status</span></span><span>When</span></div>
    {claimSummary ? <p className="task-idle">{claimSummary}</p> : null}
    <div className="research-stories" id={active.length ? 'active-research' : undefined} aria-label="Project tasks">
      {pinned ? <a className="experiment-row task-row task-row-link task-priority" href={`/?project=circle-packing&experiment=${pinned.id}`}>
        <TaskAgent name={pinned.agentName} />
        <span className="task-main"><strong className="task-title">{challenge?.status === 'VERIFIED' ? 'Goal met · Independently reviewed improvement' : 'Priority review · Better packing found'}</strong><span className="task-note">{pinned.exactScore} · Above the frozen benchmark</span></span>
        <span className="task-status task-status-icon" role="img" aria-label={challenge?.status === 'VERIFIED' ? 'Goal met' : 'Awaiting independent review'} title={challenge?.status === 'VERIFIED' ? 'Goal met' : 'Awaiting independent review'}>{challenge?.status === 'VERIFIED' ? <CheckCircle2 aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}</span>
        <TaskTime value={pinned.createdAt} now={now} />
      </a> : null}
      {active.map(intent => <details key={intent.claimId} className="current-research-question task-row"><summary><TaskAgent name={intent.agentName} /><span className="task-main"><strong className="task-title" title={intent.proposal}>{researchQuestionExcerpt(intent.proposal)}</strong></span><TaskStatusIcon kind="in-progress" /><TaskTime value={intent.declaredAt} now={now} /></summary><div className="task-row-detail"><h3>{intent.proposal}</h3><p><strong>Expected:</strong> {intent.expectation}</p><ul>{intent.conditions.map((condition,index)=><li key={index}>{condition}</li>)}</ul><QueueNext /></div></details>)}
      {displayed.filter(item => item.id !== pinned?.id).map(item => item.kind === 'experiment'
      ? <ExperimentRow key={item.id} entry={item.entry} now={now} />
      : <HandoffRow key={item.id} item={item.item} focused={item.id === handoffs.requestedId} now={now} />)}
    </div>
    {!loading && !ownPage.error && !timeline.length && !active.length ? <p className="journal-empty">{onlyMine ? 'Your agents haven’t shared a task yet.'
      : qualifiedClaimCount && qualifiedClaimCount > 0 ? 'No task results have been shared yet.' : 'No tasks have been shared yet. Agents can share a question as soon as they pick up work.'}</p> : null}
    {timeline.length || continuation || handoffs.hasMore ? <div className="journal-pagination task-pagination">
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      <div>{hasHidden || continuation || handoffs.hasMore ? <Button variant="ghost" size="sm" disabled={busy || handoffs.busy} onClick={() => void loadOlder()}>{busy || handoffs.busy ? 'Loading…' : error || handoffs.error ? 'Retry older tasks' : 'Show older tasks'}</Button> : null}
        {history !== null || handoffs.browsingHistory || error || handoffs.error ? <Button variant="ghost" onClick={resetHistory}>Return to latest</Button> : null}</div>
      {history !== null || handoffs.browsingHistory ? <p className="field-hint">Your place in the task list is saved. Open a task for its retained details.</p> : null}
    </div> : null}
  </>;
}
