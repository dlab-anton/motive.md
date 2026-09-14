import { Link } from 'react-router-dom';
import { ArrowUpRight, Bell } from 'lucide-react';
import { projects } from '@/lib/projects';
import { Button } from './ui/button';
import type { SupportControls } from './backing';

export function FollowedProjects({ controls }: { controls: SupportControls }) {
  const followed = projects.filter(project => controls.state.following.includes(project.id));
  return <section className="followed-projects"><div className="sample-section-heading"><h2><Bell className="size-4" />Following</h2><span className="field-hint">{followed.length} {followed.length === 1 ? 'project' : 'projects'}</span></div><p>Keep a project in your workspace without reserving money or starting an agent.</p>{followed.length ? <div className="followed-grid">{followed.map(project => <article key={project.id} data-followed-project={project.id}><div className="flex justify-between items-center gap-3"><span className="category-label">{project.category}</span><Button variant="ghost" size="sm" disabled={controls.busy} onClick={() => controls.send({ type: 'follow', goal: project.id, following: false })}>Unfollow</Button></div><h3><Link to={`/?project=${project.id}`}>{project.title}</Link></h3><p>Read the latest research updates and checked results.</p><Button variant="link" asChild className="p-0"><Link to={`/?project=${project.id}&tab=updates`}>View project<ArrowUpRight /></Link></Button></article>)}</div> : <div className="quiet-note">Follow the circle-packing project to find it here. Email notifications are not enabled.</div>}</section>;
}
