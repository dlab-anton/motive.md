import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Clock3, FileText } from 'lucide-react';
import type { HostedCirclePublicResults, HostedCircleResultSummary, ReviewHostedCircleResultInput } from '@/lib/hosted-results';
import { useProjectMutation } from '@/lib/project-api';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { HostedInvestigation } from './hosted-investigation';

export const hostedResultPath = (id: string) => `/api/public/projects/circle-packing/hosted-results/${encodeURIComponent(id)}`;

function HostedReview({ result }: { result: HostedCircleResultSummary }) {
  const mutation = useProjectMutation<unknown>();
  const [decision, setDecision] = useState<'ACCEPTED' | 'REJECTED'>(result.status === 'VALID' ? 'ACCEPTED' : 'REJECTED');
  const [rationale, setRationale] = useState('');
  const [saved, setSaved] = useState(false);
  if (saved) return <p role="status">Review recorded. Updating the project…</p>;
  return <details className="submission-review"><summary>Review this result</summary>
    <p>Inspect the coordinates and evaluator report. Acceptance retains this result; claims about a better method or a world record need their own evidence. The project requires an independent reviewer.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const input: ReviewHostedCircleResultInput = { decision, rationale: rationale.trim(), expected: {
        attemptId: result.attemptId, artifactManifestDigest: result.artifactManifestDigest,
        evaluationProfileDigest: result.evaluationProfileDigest, reportDigest: result.reportDigest,
      } };
      void mutation.submit(`/api/hosted-results/${result.id}/reviews`, input).then(value => { if (value) setSaved(true); });
    }}>
      <Label htmlFor={`hosted-decision-${result.id}`}>Decision</Label>
      <select id={`hosted-decision-${result.id}`} value={decision} onChange={event => setDecision(event.target.value as 'ACCEPTED' | 'REJECTED')} disabled={mutation.busy || mutation.retryPending}>
        <option value="ACCEPTED" disabled={result.status !== 'VALID'}>Accept this checked result</option><option value="REJECTED">Decline acceptance</option>
      </select>
      <Label htmlFor={`hosted-reason-${result.id}`}>Reason for your decision</Label>
      <input id={`hosted-reason-${result.id}`} required minLength={10} maxLength={1000} value={rationale} onChange={event => setRationale(event.target.value)} disabled={mutation.busy || mutation.retryPending} />
      <Button type="submit" size="sm" disabled={mutation.busy || (!mutation.retryPending && (rationale.trim().length < 10 || (decision === 'ACCEPTED' && result.status !== 'VALID')))}>{mutation.busy ? 'Saving review…' : mutation.retryPending ? 'Retry this review' : 'Record decision'}</Button>
    </form>{mutation.error ? <p role="alert" className="action-error">{mutation.error}</p> : null}
  </details>;
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
