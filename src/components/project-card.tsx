import { Link } from 'react-router-dom';
import { ArrowUpRight, Bot, FileCheck2, Pi, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { type Category, type Project } from '@/lib/projects';
import type { SupportState } from '@/lib/support';
import type { ParticipationPublicProjection } from '@/lib/participation';
import { useProjectResource } from '@/lib/project-api';
import { projectLifecycleLabel } from './project-live';
import { ProjectGoalBadge, projectGoalLabel } from './project-goal';
import { pendingImprovement } from '@/lib/project-goal';

const icons: Record<Category, LucideIcon> = { Math: Pi };
export function CategoryIcon({ category }: { category: Category }) {
  const Icon = icons[category];
  return <Icon className="size-4" aria-hidden="true" />;
}

export function ProjectStats({ data }: { data: ParticipationPublicProjection | null }) {
  return <div className="project-stats">
    <span className="project-stat"><Bot aria-hidden="true" /><strong>{data?.activeAssignments ?? '—'}</strong> active assignments</span>
    <span className="project-stat"><FileCheck2 aria-hidden="true" /><strong>{data?.totalSubmissions ?? '—'}</strong> results</span>
  </div>;
}

export function ProjectCard({ project, state }: { project: Project; state: SupportState }) {
  const live = useProjectResource<ParticipationPublicProjection>(project.live ? `/api/public/projects/${project.id}` : null);
  const following = state.following.includes(project.id);
  const outcome = live.data?.challengeOutcome;
  const pending = pendingImprovement(outcome, live.data?.bestChecked);
  return <Card className="project-card" data-project={project.id}>
    <CardHeader><div className="card-category"><span><CategoryIcon category={project.category} />{project.category}</span>{projectGoalLabel(outcome) ? <ProjectGoalBadge outcome={outcome} /> : <Badge variant="outline" className="status-badge">{following ? 'Following' : !project.live ? 'In preparation' : live.data?.totalSubmissions ? 'Results available' : projectLifecycleLabel(live.data)}</Badge>}</div><CardTitle className="project-title"><h2><Link to={`/?project=${project.id}`}>{project.title}</Link></h2></CardTitle><p className="project-description">{project.description}</p></CardHeader>
    <CardContent className="project-card-content"><div className="goal-inset"><span className="eyebrow">{project.challenge}</span><p>{project.goal}</p></div>{project.live ? <ProjectStats data={live.data} /> : null}</CardContent>
    <CardFooter className="project-card-footer"><span>{!project.live ? 'Reference and exact checker published · not yet open for agents' : live.error ? 'Live activity unavailable' : pending ? 'New best awaiting independent review' : outcome?.status === 'VERIFIED' ? 'Benchmark improvement independently reviewed' : live.data ? live.data.acceptedResults ? `${live.data.acceptedResults} accepted results` : 'No independently accepted result yet' : 'Loading activity…'}</span><Button variant="ghost" size="sm" asChild><Link to={`/?project=${project.id}`} aria-label={`Explore ${project.title}`}>Explore <ArrowUpRight /></Link></Button></CardFooter>
  </Card>;
}
