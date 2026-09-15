import { researchDigest, researchQuestionExcerpt } from '@/lib/research-digest';
import type { PublicResearchUpdate, SubmissionMotiveReference } from '@/lib/participation';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

type ResearchIntent = {
  proposal: string;
  expectation: string;
  conditions: string[];
  declaredAt: string;
  motiveReferences?: SubmissionMotiveReference[];
};

/** A contributor's declared plan, kept separate from evaluator evidence. */
export function ResearchIntentCard({ intent, agentName, contributorName, stale = false, historical = false, relatedUpdates = [] }: {
  intent: ResearchIntent;
  agentName?: string;
  contributorName?: string | null;
  stale?: boolean;
  historical?: boolean;
  relatedUpdates?: PublicResearchUpdate[];
}) {
  const slug = useProjectSlug();
  const question = researchQuestionExcerpt(intent.proposal);
  const sources = (intent.motiveReferences ?? []).map(reference => {
    const related = relatedUpdates.find(update => update.submissionId === reference.submissionId && update.reportDigest === reference.reportDigest);
    return { id: reference.submissionId,
      label: related ? researchDigest(related).question : 'Earlier experiment',
      href: related ? `${projectLink(slug)}&tab=updates#research-${reference.submissionId}` : `${publicProjectPath(slug)}/submissions/${reference.submissionId}/report` };
  });
  return <section className="research-intent" aria-label={agentName ? `${agentName}'s proposed experiment` : 'Your agent’s proposed experiment'}>
    <div className="research-intent-heading"><span className="eyebrow">{historical ? 'Initial declared plan' : stale ? 'Last recorded proposal' : 'Proposed experiment'}</span>{agentName ? <span>{agentName}{contributorName ? ` · ${contributorName}` : ''}</span> : null}</div>
    <p className="research-intent-question">{question}</p>
    {sources.length ? <div className="research-intent-sources"><span>Building on</span>
      {sources.slice(0, 2).map(source => <a key={source.id} href={source.href}>{source.label} ↗</a>)}
      {sources.length > 2 ? <details><summary>{sources.length - 2} more cited experiments</summary>{sources.slice(2).map(source => <a key={source.id} href={source.href}>{source.label} ↗</a>)}</details> : null}
      <small>Cited as context; each result keeps its own review status.</small>
    </div> : null}
    <details><summary>Expectation and test conditions</summary>
      {question !== intent.proposal ? <p><strong>Full proposal:</strong> {intent.proposal}</p> : null}
      <p><strong>Expected:</strong> {intent.expectation}</p><ul>{intent.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
      <p className="field-hint">Declared <time dateTime={intent.declaredAt}>{new Date(intent.declaredAt).toLocaleString()}</time>, before a result was submitted to Motive. The agent may revise its approach; its final report records what it actually tried.</p>
    </details>
  </section>;
}
