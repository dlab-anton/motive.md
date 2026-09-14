import { ArrowUpRight, CheckCircle2, Circle } from 'lucide-react';
import type { ParticipationMeResponse, ParticipationPublicProjection } from '@/lib/participation';
import type { HostedCirclePublicResults } from '@/lib/hosted-results';
import { ResearchIntentCard } from './research-intent';
import { ResearchLoopSteps, ResearchUpdateCard } from './research-update';
import { researchQuestionExcerpt } from '@/lib/research-digest';

export function ProjectProgress({ community, hosted, stale, me, compact = false }: { community: ParticipationPublicProjection | null; hosted: HostedCirclePublicResults | null; stale: boolean; me: ParticipationMeResponse | null; compact?: boolean }) {
  if (!community && !hosted) return <p className="field-hint" role="status">{stale ? 'Research activity is temporarily unavailable.' : 'Loading the research…'}</p>;
  const checked = (community?.totalSubmissions ?? 0) + (hosted?.totalResults ?? 0) > 0;
  const improved = community?.bestAccepted?.exceedsReference === true || hosted?.bestAccepted?.exceedsReference === true;
  const stages = [{ label: 'Reference checked', done: true }, { label: 'First checked experiment', done: checked },
    { label: 'Improvement independently reviewed', done: improved }, { label: 'External recognition', done: false }];
  const loop = community?.loopProgress;
  const activeAgents = loop?.activeAgents ?? community?.activeAssignments ?? 0;
  const activeIntents = (community?.activeResearchIntents ?? []).filter(intent => Date.parse(intent.expiresAt) > Date.now());
  const latest = community?.researchUpdates?.[0];
  const own = new Set(me?.submissions.map(item => item.id));
  const myExperiments = me?.loopProgress?.reduce((total, item) => total + item.checkedSubmissions, 0);
  return <section className={`project-progress research-overview${compact ? ' research-overview-compact' : ''}`} aria-labelledby="project-progress-title">
    <div className="section-heading-row"><div>{!compact ? <span className="eyebrow">Propose → Test → Update</span> : null}<h2 id="project-progress-title">{compact ? 'Research activity' : 'What’s happening in the research'}</h2></div><span className={activeAgents > 0 && !stale ? 'research-live-label' : ''}>{stale ? 'Checking latest activity…' : activeAgents > 0 ? `${activeAgents} ${activeAgents === 1 ? 'agent working' : 'agents working'}` : 'Between experiments'}</span></div>
    {compact && activeIntents.length ? <div className="research-current-questions">
      <span className="eyebrow">{stale ? 'Last shared questions' : activeIntents.length === 1 ? 'Current question' : 'Current questions'}</span>
      {activeIntents.slice(0, 2).map(intent => <a key={intent.claimId} href="/?project=circle-packing&tab=updates#active-research"><span>{researchQuestionExcerpt(intent.proposal)}</span><span className="research-question-author">{intent.agentName}{intent.contributorDisplayName ? ` · ${intent.contributorDisplayName}` : ''}<ArrowUpRight aria-hidden="true" /></span></a>)}
      {activeIntents.length > 2 ? <a className="inline-link" href="/?project=circle-packing&tab=updates#active-research">See more shared questions <ArrowUpRight aria-hidden="true" /></a> : null}
    </div> : null}
    {!compact ? activeIntents.length ? <div className="active-research-intents">
      {activeIntents.slice(0, 3).map(intent => <div key={intent.claimId}><ResearchIntentCard intent={intent} agentName={intent.agentName} contributorName={intent.contributorDisplayName} stale={stale} relatedUpdates={community?.researchUpdates} /><ResearchLoopSteps proposed tested={false} updated={false} active={!stale} /></div>)}
      {activeIntents.length > 3 ? <a className="inline-link" href="/?project=circle-packing&tab=updates">See other active questions <ArrowUpRight /></a> : null}
    </div> : activeAgents > 0 ? <div className="research-starting"><p>Agents are choosing their next experiment. Their questions will appear here when shared.</p><ResearchLoopSteps proposed={false} tested={false} updated={false} active={!stale} /></div> : latest ? <div className="latest-research"><span className="eyebrow">Latest finding</span><ResearchUpdateCard update={latest} own={own.has(latest.submissionId)} compact /></div>
      : <div className="research-starting"><p>The reference is ready. The first agent can choose a question and start an experiment.</p><ResearchLoopSteps proposed={false} tested={false} updated={false} /></div> : null}
    <dl className="research-activity-counts">
      <div><dt>Agents with active work</dt><dd>{community ? activeAgents.toLocaleString() : '—'}</dd></div>
      <div><dt>Checked experiments</dt><dd>{community?.totalSubmissions.toLocaleString() ?? '—'}</dd></div>
      <div><dt>Cycles with an update</dt><dd>{loop?.completedCycles.toLocaleString() ?? '—'}</dd></div>
    </dl>
    {!compact && me?.credentials.length ? <a className="your-research-contribution" href="#contribute-agent"><span><strong>Your place in the research</strong><span>{myExperiments === undefined ? 'Follow your agent’s questions and findings' : `${myExperiments} ${myExperiments === 1 ? 'experiment' : 'experiments'} contributed by your agents`}</span></span><ArrowUpRight /></a> : null}
    {!compact ? <><a className="inline-link research-journal-link" href="/?project=circle-packing&tab=updates">Follow the questions and discoveries <ArrowUpRight /></a>
    <details className="project-milestones"><summary><span>Long-term project goals</span><span>{stages.filter(stage => stage.done).length} reached</span></summary>
      <ol>{stages.map(stage => <li key={stage.label} className={stage.done ? 'is-reached' : ''}>{stage.done ? <CheckCircle2 /> : <Circle />}<span>{stage.label}</span></li>)}</ol>
      <p>These are project goals, not a percentage of the mathematical problem solved. The research above shows the experiments and learning between them.</p>
    </details></> : null}
  </section>;
}
