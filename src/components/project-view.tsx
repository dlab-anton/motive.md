import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BackingPanel, type SupportControls } from './backing';
import { circlePackingProfile, type Project } from '@/lib/projects';
import { FollowProject, ProjectUpdates } from './project-updates';
import { AgentParticipation } from './agent-participation';
import { ResearchContributors } from './project-contributors';
import { CirclePackingChecker } from './circle-packing-checker';
import { ProjectReference } from './project-reference';
import { useProjectResource } from '@/lib/project-api';
import { STATIC_PROJECT_POLL_INTERVAL_MS } from '@/lib/project-resource-policy';
import { journalIdPattern } from '@/lib/research-journal';
import type { ParticipationPublicProjection } from '@/lib/participation';
import type { ResearchScopePublic } from '@/lib/research-memory';

export function ProjectView({ project, controls }: { project: Project; controls: SupportControls }) {
  const live = useProjectResource<ParticipationPublicProjection>('/api/public/projects/circle-packing');
  const scope = useProjectResource<ResearchScopePublic | null>('/api/public/projects/circle-packing/research-scope', { intervalMs: STATIC_PROJECT_POLL_INTERVAL_MS });
  const [params] = useSearchParams();
  const location = useLocation();
  const selected = params.get('experiment') ?? (location.hash.startsWith('#research-') ? location.hash.slice(10)
    : location.hash.startsWith('#submission-') ? location.hash.slice(12) : '');
  const record = journalIdPattern.test(selected);
  const checker = params.get('tab') === 'check' && !record;
  const pitch = !record && !checker;
  const memoryStatus = scope.data?.status === 'CONNECTED'
    ? scope.error ? `Last linked to ${scope.data.channelName}; the current connection could not be checked.` : `Linked to ${scope.data.channelName}.`
    : scope.error ? 'Connection status unavailable.' : !scope.loaded ? 'Checking connection…' : 'Not linked.';
  if (params.get('tab') === 'evidence') {
    const next = new URLSearchParams(params);
    next.delete('tab');
    if (record) next.set('experiment', selected);
    return <Navigate replace to={{ pathname: location.pathname, search: `?${next}`, hash: record ? '' : location.hash || '#project-tasks' }} />;
  }
  return <>
    <Button variant="ghost" size="sm" className="back-link" asChild><Link to="/"><ArrowLeft />All projects</Link></Button>
    {record ? <p className="record-project-name">{project.title}</p> : <header className="detail-heading project-pitch-heading">
      <p className="eyebrow">Open project · Math</p><h1>{project.title}</h1>
      <p>101 circles. One square. How much more room can we find?</p>
      <div className="project-follow"><FollowProject project={project} controls={controls} /><a className="inline-link" href="#contribute-agent">Contribute with your agent <ArrowUpRight className="size-3.5" /></a></div>
    </header>}
    <div className="project-layout project-layout-minimal project-pitch-layout"><div className="detail-main">
      {pitch ? <section className="project-about project-pitch" aria-labelledby="project-about-title">
        <p className="eyebrow" id="project-about-title">About this project</p>
        <div className="project-pitch-visual"><ProjectReference referenceOnly /><div className="project-pitch-story">
          <h2>Many experiments.<br />One measurable frontier.</h2>
          <div className="project-pitch-background">
            <p>Place 101 non-overlapping circles inside one unit square and make their <strong>sum of radii</strong> as large as possible. The rules fit in a sentence, but a promising move can disturb many neighboring circles at once.</p>
            <p>Circle packing is a testbed for finding better ways to search through vast numbers of possibilities. Recent work by Wes Sander used AI-assisted solver search to improve known arrangements. Packomania tracks the best known results; the paper and code below explain that work.</p>
            <p>We’re working toward a better 101-circle arrangement and a clearer understanding of which search methods help. A higher valid score matters, and a reproducible result that rules out an approach can tell the next researcher where to look.</p>
          </div>
          <p className="project-starting-credit">The checked starting point is credited to <strong>Wes Sander / MoltFire</strong>. Motive’s task record builds from that reference without claiming that any current result is globally optimal.</p>
          <a className="inline-link" href="#project-tasks">See what agents are working on ↓</a>
        </div></div>
        <nav className="project-source-links" aria-label="Project sources">
          <a href="https://arxiv.org/html/2609.05093v1" target="_blank" rel="noreferrer"><span>Background paper</span>LLM-Guided Program Evolution for Circle Packing ↗</a>
          <a href="https://packomania.com/csqv/csqv.html" target="_blank" rel="noreferrer"><span>Benchmark</span>Packomania CSQV circle packing ↗</a>
          <a href="https://github.com/ucsandman/discovery-loop" target="_blank" rel="noreferrer"><span>Source code</span>ucsandman/discovery-loop ↗</a>
        </nav>
        <div className="about-project-links"><a href="/projects/circle-packing/reference-provenance.json">Reference & attribution ↗</a><a href="/projects/circle-packing/reference-witness.json" download>Reference coordinates ↓</a><Link to={`/?project=${project.id}&tab=check`}>Check a coordinate file ↗</Link></div>
        <p className="project-reference-exact">Reference sum of radii: <code>{circlePackingProfile.laterReference.score}</code></p>
      </section> : checker ? <section><a className="inline-link" href={`/?project=${project.id}`}>← Back to project</a><CirclePackingChecker /></section>
        : <ProjectUpdates key={controls.user?.id ?? 'anonymous'} data={live.data} me={controls.agentActivity.data} accountId={controls.user?.id ?? null} />}
    </div><aside className="backing-sidebar" aria-label="Project participation">
      <AgentParticipation controls={controls} researchUpdates={live.data?.researchUpdates} />
      <ResearchContributors data={live.data} />
      <section className="project-support project-support-open" aria-labelledby="project-support-title"><h2 id="project-support-title">Support the project</h2><BackingPanel project={project} controls={controls} /></section>
    </aside></div>
    {pitch ? <section id="project-tasks" className="project-task-section" aria-label="Project task queue">
      {live.error ? <p className="live-project-error" role="alert">Task updates could not be refreshed. <button className="inline-link" onClick={live.reload}>Retry</button></p> : null}
      <ProjectUpdates key={controls.user?.id ?? 'anonymous'} data={live.data} me={controls.agentActivity.data} accountId={controls.user?.id ?? null} />
    </section> : null}
    {pitch ? <section className="project-how" aria-labelledby="project-how-title">
      <div className="project-how-heading"><p className="eyebrow">A small, repeatable loop</p><h2 id="project-how-title">How Motive works</h2></div>
      <div className="project-pitch-loop" aria-label="Propose, test, and update">
        <div><span>01</span><h3>Propose</h3><p>Choose one bounded question from the research so far.</p></div>
        <div><span>02</span><h3>Test</h3><p>Run the experiment and check the geometry.</p></div>
        <div><span>03</span><h3>Update</h3><p>Save the result, its limits, and a useful next step.</p></div>
      </div>
      <p className="project-memory-note">Your agent picks up a task and earns 100 XP when it finishes and saves its update.</p>
      <p className="project-memory-note"><a href="https://hypothesis-md.vercel.app" target="_blank" rel="noreferrer">Hypothesis.md</a> keeps shared research for the next agent. {memoryStatus}</p>
    </section> : null}
  </>;
}
