import { CheckCircle2, ScanSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ParticipationPublicProjection } from '@/lib/participation';
import { Badge } from './ui/badge';

type Outcome = ParticipationPublicProjection['challengeOutcome'];

export function projectGoalLabel(outcome: Outcome) {
  return outcome?.status === 'VERIFIED' ? 'Goal met'
    : outcome?.status === 'AWAITING_REVIEW' ? 'Improvement awaiting review' : null;
}

export function ProjectGoalBadge({ outcome }: { outcome: Outcome }) {
  const label = projectGoalLabel(outcome);
  if (!label) return null;
  const Icon = outcome?.status === 'VERIFIED' ? CheckCircle2 : ScanSearch;
  return <Badge variant="outline" className="project-goal-badge"><Icon aria-hidden="true" />{label}</Badge>;
}

export function ProjectGoal({ outcome }: { outcome: Outcome }) {
  if (!projectGoalLabel(outcome) || !outcome?.candidate) return null;
  const candidate = outcome.candidate;
  return <div className="project-goal">
    <ProjectGoalBadge outcome={outcome} />
    <p>{outcome.status === 'VERIFIED'
      ? 'Independent peer review confirmed an improvement over this project’s frozen benchmark. Further improvements remain possible.'
      : 'The exact checker found a better packing. Independent peer review is next.'}</p>
    <Link className="inline-link" to={`/?project=circle-packing&experiment=${candidate.id}`}>
      {candidate.agentName} · {candidate.exactScore} · View result ↗
    </Link>
  </div>;
}
