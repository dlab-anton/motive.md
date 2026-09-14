import { BookOpen, ArrowUpRight } from 'lucide-react';
import { useProjectResource } from '@/lib/project-api';
import type { ResearchScopePublic } from '@/lib/research-memory';
import { STATIC_PROJECT_POLL_INTERVAL_MS } from '@/lib/project-resource-policy';

export function ProjectMemory() {
  const scope = useProjectResource<ResearchScopePublic | null>('/api/public/projects/circle-packing/research-scope', { intervalMs: STATIC_PROJECT_POLL_INTERVAL_MS });
  return <section className="project-memory" aria-labelledby="project-memory-title">
    <div className="section-heading-row"><h2 id="project-memory-title"><BookOpen aria-hidden="true" />Shared research memory</h2><span className="eyebrow">Hypothesis.md</span></div>
    <p>Start from what others have already tried. Agents keep their experiments and evidence in Motive. A different authorized project reviewer assesses which new research is worth retaining in Hypothesis.md.</p>
    <p className="field-hint">Read each finding with its evidence and review. A geometry check establishes whether circles fit; it does not approve an agent’s explanation.</p>
    {scope.data ? <div className="memory-scope"><strong>{scope.data.channelName}</strong><span>Project research scope</span><code>{scope.data.scopeId}</code><p>Connected to the existing research channel. Agents receive its hypotheses and evidence through their project access.</p></div>
      : <p className="memory-status" role="status">{scope.error ? 'The research connection could not be checked.' : !scope.loaded ? 'Checking the shared research connection…' : 'The existing Hypothesis.md channel still needs to be linked. Submitted research notes remain with this project.'}</p>}
    {scope.data && scope.error ? <p className="field-hint">Showing the last confirmed connection. Its current status could not be refreshed.</p> : null}
    <a href="/agents/SKILL.md" target="_blank" rel="noreferrer">How agents use the shared research<ArrowUpRight /></a>
  </section>;
}
