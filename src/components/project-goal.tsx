import { CheckCircle2, ScanSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ParticipationPublicProjection, SubmissionSummary } from '@/lib/participation';
import { pendingImprovement } from '@/lib/project-goal';
import { Badge } from './ui/badge';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

type Outcome = ParticipationPublicProjection['challengeOutcome'];

export function projectGoalLabel(outcome: Outcome) {
  return outcome?.status === 'VERIFIED' ? 'Goal met'
    : outcome?.status === 'AWAITING_REVIEW' ? 'Improvement awaiting review' : null;
}

export function ProjectGoalBadge({ outcome }: { outcome: Outcome }) {
  const label = projectGoalLabel(outcome);
  if (!label) return null;
  const Icon = outcome?.status === 'VERIFIED' ? CheckCircle2 : ScanSearch;
  return <Badge variant="outline" className={`project-goal-badge${outcome?.status === 'VERIFIED' ? ' is-verified' : ''}`}><Icon aria-hidden="true" />{label}</Badge>;
}

export function ProjectGoal({ outcome, bestChecked }: { outcome: Outcome; bestChecked?: SubmissionSummary | null }) {
  const slug = useProjectSlug();
  if (!projectGoalLabel(outcome) || !outcome?.candidate) return null;
  const pending = pendingImprovement(outcome, bestChecked);
  const candidate = pending ?? outcome.candidate;
  return <div className="project-goal">
    <ProjectGoalBadge outcome={outcome} />
    <p>{outcome.status === 'VERIFIED' && pending
      ? 'The frozen benchmark has been improved and peer reviewed. A stronger new best now awaits independent review.'
      : outcome.status === 'VERIFIED'
      ? 'Independent peer review confirmed an improvement over this project’s frozen benchmark. Further improvements remain possible.'
      : 'The exact checker found a better packing. Independent peer review is next.'}</p>
    <div className="project-goal-links"><Link className="inline-link" to={`${projectLink(slug)}&experiment=${candidate.id}`}>
      {candidate.agentName} · {candidate.exactScore} · {pending ? 'View pending result' : 'View result'} ↗
    </Link>{outcome.status === 'VERIFIED' && pending ? <Link className="inline-link" to={`${projectLink(slug)}&experiment=${outcome.candidate.id}`}>Reviewed benchmark result ↗</Link> : null}</div>
  </div>;
}
