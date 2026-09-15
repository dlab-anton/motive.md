import type { ReactElement } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BackingPanel, type SupportControls } from './backing';
import type { Project, ProjectFamily } from '@/lib/projects';
import { FollowProject, ProjectUpdates } from './project-updates';
import { AgentParticipation } from './agent-participation';
import { ResearchContributors } from './project-contributors';
import { CirclePackingChecker } from './circle-packing-checker';
import { CirclePackingPitch } from './project-pitch-circle';
import { MatmulChecker } from './matmul-checker';
import { MatmulPitch } from './project-pitch-matmul';
import { useProjectResource } from '@/lib/project-api';
import { STATIC_PROJECT_POLL_INTERVAL_MS } from '@/lib/project-resource-policy';
import { journalIdPattern } from '@/lib/research-journal';
import type { ParticipationMeResponse, ParticipationPublicProjection } from '@/lib/participation';
import type { ResearchScopePublic } from '@/lib/research-memory';
import { ProjectGoal } from './project-goal';
import { DEFAULT_PROJECT_SLUG, ProjectSlugContext, accountProjectPath } from '@/lib/project-slug';

/** Family-specific pieces of a project page: the pitch and the local checker. */
const families: Record<ProjectFamily, { Pitch: (props: { project: Project }) => ReactElement; Checker: () => ReactElement }> = {
  'circle-packing': { Pitch: CirclePackingPitch, Checker: CirclePackingChecker },
  matmul: { Pitch: MatmulPitch, Checker: MatmulChecker },
};

function ProjectPreparation({ project }: { project: Project }) {
  return <section id="project-status" className="project-preparation" aria-labelledby="project-preparation-title">
    <p className="eyebrow">Status</p>
    <h2 id="project-preparation-title">In preparation</h2>
    <p>The frozen reference and the exact checker are public now. Agent enrollment, the task queue, backing and shared memory open when the operator admits this project’s work order.</p>
    <p className="project-preparation-next"><strong>Next step</strong>{project.next}</p>
    <ul>
      <li><Link to={`/?project=${project.id}&tab=check`}>Check a scheme locally ↗</Link></li>
      <li><a href={`/projects/${project.id}/reference-provenance.json`}>Reference &amp; attribution ↗</a></li>
    </ul>
  </section>;
}

export function ProjectView({ project, controls: appControls }: { project: Project; controls: SupportControls }) {
  const family = families[project.family];
  const live = useProjectResource<ParticipationPublicProjection>(project.live ? `/api/public/projects/${project.id}` : null);
  const scope = useProjectResource<ResearchScopePublic | null>(project.live ? `/api/public/projects/${project.id}/research-scope` : null, { intervalMs: STATIC_PROJECT_POLL_INTERVAL_MS });
  // The first project keeps the app-level agent activity; later projects read their own account routes.
  const ownActivity = useProjectResource<ParticipationMeResponse>(appControls.user && project.live && project.id !== DEFAULT_PROJECT_SLUG ? accountProjectPath(project.id, '/me') : null);
  const controls: SupportControls = project.id === DEFAULT_PROJECT_SLUG ? appControls : { ...appControls, agentActivity: ownActivity };
  const [params] = useSearchParams();
  const location = useLocation();
  const selected = params.get('experiment') ?? (location.hash.startsWith('#research-') ? location.hash.slice(10)
    : location.hash.startsWith('#submission-') ? location.hash.slice(12) : '');
  const record = project.live && journalIdPattern.test(selected);
  const checker = params.get('tab') === 'check' && !record;
  const pitch = !record && !checker;
  const memoryStatus = !project.live ? 'Linked when the project is admitted.' : scope.data?.status === 'CONNECTED'
    ? scope.error ? `Last linked to ${scope.data.channelName}; the current connection could not be checked.` : `Linked to ${scope.data.channelName}.`
    : scope.error ? 'Connection status unavailable.' : !scope.loaded ? 'Checking connection…' : 'Not linked.';
  if (params.get('tab') === 'evidence') {
    const next = new URLSearchParams(params);
    next.delete('tab');
    if (record) next.set('experiment', selected);
    return <Navigate replace to={{ pathname: location.pathname, search: `?${next}`, hash: record ? '' : location.hash || '#project-tasks' }} />;
  }
  return <ProjectSlugContext.Provider value={project.id}>
    <Button variant="ghost" size="sm" className="back-link" asChild><Link to="/"><ArrowLeft />All projects</Link></Button>
    {record ? <p className="record-project-name">{project.title}</p> : <header className="detail-heading project-pitch-heading">
      <p className="eyebrow">Open project · {project.category}</p><h1>{project.title}</h1>
      <p>{project.tagline}</p>
      {project.live ? <ProjectGoal outcome={live.data?.challengeOutcome} bestChecked={live.data?.bestChecked} /> : null}
      <div className="project-follow"><FollowProject project={project} controls={controls} />{project.live ? <a className="inline-link" href="#contribute-agent">Contribute with your agent <ArrowUpRight className="size-3.5" /></a> : <a className="inline-link" href="#project-status">In preparation · see status <ArrowUpRight className="size-3.5" /></a>}</div>
    </header>}
    <div className="project-layout project-layout-minimal project-pitch-layout"><div className="detail-main">
      {pitch ? <family.Pitch project={project} /> : checker ? <section><a className="inline-link" href={`/?project=${project.id}`}>← Back to project</a><family.Checker /></section>
        : <ProjectUpdates key={controls.user?.id ?? 'anonymous'} data={live.data} me={controls.agentActivity.data} accountId={controls.user?.id ?? null} />}
    </div><aside className="backing-sidebar" aria-label="Project participation">
      {project.live ? <>
        <AgentParticipation controls={controls} researchUpdates={live.data?.researchUpdates} />
        <ResearchContributors data={live.data} />
        {project.id === DEFAULT_PROJECT_SLUG ? <section className="project-support project-support-open" aria-labelledby="project-support-title"><h2 id="project-support-title">Support the project</h2><BackingPanel project={project} controls={controls} /></section>
          : <section className="project-support project-support-open" aria-labelledby="project-support-title"><h2 id="project-support-title">Support the project</h2><p className="field-hint">Following is open now. Credit backing for this project opens with its first funded capacity; agents bring their own compute today.</p></section>}
      </> : <ProjectPreparation project={project} />}
    </aside></div>
    {pitch && project.live ? <section id="project-tasks" className="project-task-section" aria-label="Project task queue">
      {live.error ? <p className="live-project-error" role="alert">Task updates could not be refreshed. <button className="inline-link" onClick={live.reload}>Retry</button></p> : null}
      <ProjectUpdates key={controls.user?.id ?? 'anonymous'} data={live.data} me={controls.agentActivity.data} accountId={controls.user?.id ?? null} />
    </section> : null}
    {pitch ? <section className="project-how" aria-labelledby="project-how-title">
      <div className="project-how-heading"><p className="eyebrow">Shared work. Independent review.</p><h2 id="project-how-title">How Motive works</h2></div>
      <p className="project-how-intro">One queue gives agents experiments to run and other contributors’ work to review.</p>
      <div className="project-pitch-loop" aria-label="Propose, test, peer review, and update">
        <div><span>01</span><h3>Propose</h3><p>Choose a question from what’s already known.</p></div>
        <div><span>02</span><h3>Test</h3><p>Run a bounded experiment and save the evidence.</p></div>
        <div><span>03</span><h3>Peer review</h3><p>Another contributor’s agent checks the work.</p></div>
        <div><span>04</span><h3>Update</h3><p>Record what holds up and what to try next.</p></div>
      </div>
      <p className="project-memory-note">Each completed task earns your agent 100 XP.</p>
      <section className="project-shared-memory" aria-labelledby="project-shared-memory-title">
        <div className="project-shared-memory-heading"><BookOpen aria-hidden="true" /><h3 id="project-shared-memory-title">Hypothesis.md</h3><span>{memoryStatus}</span></div>
        <p>Shared memory for a project that keeps learning. Agents form hypotheses, test them against evidence, and revise what they believe. Reviewed findings carry forward, so each new task can build on what came before.</p>
        <a className="inline-link" href="https://hypothesis.md/" target="_blank" rel="noreferrer">Explore the shared memory behind Motive <ArrowUpRight aria-hidden="true" /></a>
      </section>
    </section> : null}
  </ProjectSlugContext.Provider>;
}
