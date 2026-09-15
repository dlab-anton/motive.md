import { ArrowUpRight, CheckCircle2, Clock3, FileText } from 'lucide-react';
import type { HostedCirclePublicResults, HostedCircleResultSummary } from '@/lib/hosted-results';
import { HostedInvestigation } from './hosted-investigation';

export const hostedResultPath = (id: string) => `/api/public/projects/circle-packing/hosted-results/${encodeURIComponent(id)}`;

function HostedReview(_props: { result: HostedCircleResultSummary }) {
  return null;
}

export function HostedEvidence({ data, canReview }: { data: HostedCirclePublicResults | null; canReview: boolean }) {
  if (!data?.results.length) return null;
  return <section aria-labelledby="hosted-evidence-title"><h3 id="hosted-evidence-title">Project-funded research</h3>
    <div className="submitted-evidence">{data.results.map(result => <article className="submission-card" key={result.id} id={`hosted-result-${result.id}`}>
      <div className="submission-heading"><div><span className="eyebrow">Hosted research agent</span><h3>{result.model.id === 'openai/gpt-6-astra' ? 'OpenAI Astra' : result.model.id}</h3></div>
        <span className={`result-state result-${result.status.toLowerCase()}`}>{result.status === 'VALID' ? <CheckCircle2 /> : <FileText />}{result.status === 'VALID' ? 'Geometry valid' : 'Candidate rejected'}</span></div>
      <p className="field-hint">{result.model.id} · model fixed in the run agreement</p>
      {result.exactScore !== null ? <div className="submission-score"><span>Exact sum of radii</span><strong>{result.exactScore}</strong><p>{result.exceedsReference === true ? 'Exceeds the frozen reference. External record status has not been established.' : 'Does not exceed the frozen reference. This still records a checked outcome.'}</p></div>
        : <p>This attempt did not establish a valid packing. The report records what failed.</p>}
      <div className="submission-acceptance"><Clock3 /><span>{result.review?.decision === 'ACCEPTED' ? 'Accepted by a project reviewer' : result.review?.decision === 'REJECTED' ? 'Acceptance declined' : 'Awaiting project review'}</span><time dateTime={result.createdAt}>{new Date(result.createdAt).toLocaleString()}</time></div>
      <div className="evidence-file-links">{result.artifactAvailable ? <a href={`${hostedResultPath(result.id)}/artifact`} target="_blank" rel="noreferrer">Coordinate file<ArrowUpRight /></a> : null}<a href={`${hostedResultPath(result.id)}/report`} target="_blank" rel="noreferrer">Evaluator report<ArrowUpRight /></a></div>
      <HostedInvestigation result={result} />
      {canReview && !result.review ? <HostedReview result={result} /> : null}
    </article>)}</div>
  </section>;
}
