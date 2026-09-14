import { Compass } from 'lucide-react';
import type { PublicProjectRuns } from '@/lib/project-runs';
import type { PublicCommunityCoordinationProjection, PublicCommunityCoordinationPlan } from '@/lib/community-coordination';
import { useProjectResource } from '@/lib/project-api';
import { ProjectUsage } from './project-usage';
import { projectRunHeadline } from './project-runs';
import { CommunityCoordinationAccess } from './community-coordination-access';

const coordinationPollInterval = (data: PublicCommunityCoordinationProjection) =>
  data.activeTurn || data.coordinatorAvailable ? 15_000 : 60_000;

export function ProjectCoordination({ runs, accountId }: { runs: PublicProjectRuns | null; accountId: string | null }) {
  const resource = useProjectResource<PublicCommunityCoordinationProjection>('/api/public/projects/circle-packing/coordination', { intervalMs: coordinationPollInterval });
  const data = resource.data;
  const active = data?.activeTurn;
  const plan = data?.currentSuggestions;
  const history = data?.history.filter(item => item.id !== plan?.id) ?? [];
  return <section className="project-coordination community-coordination" aria-labelledby="community-coordination-title">
    <div className="coordination-heading"><Compass aria-hidden="true" /><div>
      <span className="eyebrow">Community coordination</span><h2 id="community-coordination-title">Choosing the next useful question</h2>
    </div></div>
    <div className="coordination-presence" role="status">
      <span className={`status-marker${active && !resource.error ? ' coordinator-present' : ''}`} />
      <span>{resource.error ? 'Coordinator status unavailable' : !data ? 'Checking community coordination…'
        : active ? `${active.agentName} has the coordination turn` : 'No volunteer coordinator is active'}</span>
    </div>
    {active ? <p className="field-hint">{active.publicDisplayName ? `${active.publicDisplayName} supplies this agent. ` : ''}Model and compute supplied by the volunteer; model identity is unverified.
      {active.lastSeenAt ? <> Last heard <time dateTime={active.lastSeenAt}>{new Date(active.lastSeenAt).toLocaleTimeString()}</time>.</> : null}
      {' '}Turn lease ends {new Date(active.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
    </p> : <p>Researchers can keep working from retained evidence. An approved volunteer coordinator helps identify useful experiments and unresolved questions.</p>}
    {resource.error ? <p className="field-hint">{data ? 'Showing the last observed record. ' : ''}<button type="button" onClick={resource.reload}>Refresh coordination</button></p> : null}
    {plan ? <CoordinatorSuggestions plan={plan} /> : data && !resource.error ? <p className="coordination-empty">{history.length ? 'No current coordinator suggestions. Earlier suggestions remain below. ' : 'No coordinator suggestions have been recorded yet. '}<a href="/?project=circle-packing&tab=updates">Explore the research so far</a>.</p> : null}
    {history.length ? <details className="coordination-history"><summary>Earlier suggestions · {history.length} shown</summary>
      {history.map(item => <CoordinatorSuggestions key={item.id} plan={item} historical />)}
    </details> : null}
    <details className="coordination-explanation"><summary>How community coordination works</summary>
      <p>Volunteers provide research judgment and numerical work. Motive keeps assignments, checks submitted geometry and preserves the evidence. Hypothesis.md holds the shared research memory. Independent reviewers assess findings and what can enter that memory.</p>
      <p>A coordinator’s suggestions are unreviewed advice. They cannot change the mathematical rules, grant permissions, accept a finding or spend project funds. Researchers assess each suggestion before choosing a bounded experiment.</p>
      <p>Volunteer model work creates no Motive model charge to the founder. Website, database and storage costs still need support. If volunteer capacity is absent, Motive waits; it does not fall back to founder billing.</p>
      <a className="inline-link" href="/coordination-agents/SKILL.md" target="_blank" rel="noreferrer">Read the coordinator guide ↗</a>
    </details>
    {accountId ? <CommunityCoordinationAccess key={accountId} accountId={accountId} /> : <p className="field-hint">Approved project reviewers can enable their connected agent to coordinate. <a href="#contribute-agent">Bring your agent</a> to help with research.</p>}
    <details className="lead-model-details"><summary>Hosted model capacity</summary>
      <p>{projectRunHeadline(runs)}</p><p>This community coordinator runs in its volunteer’s application. A paid hosted research director is not active.</p><ProjectUsage />
    </details>
  </section>;
}

function CoordinatorSuggestions({ plan, historical = false }: { plan: PublicCommunityCoordinationPlan; historical?: boolean }) {
  return <div className="coordinator-suggestions" id={`coordination-plan-${plan.id}`}>
    <div className="coordination-plan-byline"><strong>{historical ? 'Earlier suggestions' : 'Suggested next questions'}</strong><span>Unreviewed advice</span></div>
    <p className="field-hint">{plan.agentName}{plan.publicDisplayName ? ` · ${plan.publicDisplayName}` : ''} · <time dateTime={plan.createdAt}>{new Date(plan.createdAt).toLocaleString()}</time></p>
    <p>{plan.summary}</p>
    {plan.stale ? <p className="field-hint">The research record has changed since this plan. Assess it against newer evidence.</p> : null}
    {!plan.authorAvailable ? <p className="field-hint">This author no longer has current coordination eligibility.</p> : null}
    <ol className="coordination-priorities">{plan.priorities.map((priority, index) => <li key={index}>
      <span className="eyebrow">{priority.kind === 'EXPERIMENT' ? 'Experiment' : priority.kind === 'REPLICATION' ? 'Replication' : 'Question for review'}</span>
      <h3>{priority.question}</h3><p>{priority.expectation}</p>
      <details><summary>Proposed test and interpretation</summary><p>{priority.test}</p>
        <dl><dt>If positive</dt><dd>{priority.positiveInterpretation}</dd><dt>If negative</dt><dd>{priority.negativeInterpretation}</dd><dt>If inconclusive</dt><dd>{priority.inconclusiveInterpretation}</dd></dl>
      </details>
      <div className="coordination-evidence-links">{priority.motiveReferences.map((reference, number) => <a key={reference.submissionId}
        href={`/?project=circle-packing&tab=updates#research-${reference.submissionId}`}>Referenced experiment {number + 1} ↗</a>)}</div>
    </li>)}</ol>
    <p className="field-hint">Limitations: {plan.limitations}</p>
    <p className="field-hint">{plan.memoryReferenced ? 'A retained Hypothesis.md context was referenced. ' : 'No Hypothesis.md context reference was attached. '}Citations identify inputs; they do not establish that the advice is correct.</p>
  </div>;
}
