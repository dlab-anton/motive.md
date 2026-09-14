import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { HostedCirclePublicInvestigation, HostedCircleResultSummary } from '@/lib/hosted-results';
import { useProjectResource } from '@/lib/project-api';

function InvestigationRecord({ result }: { result: HostedCircleResultSummary }) {
  const path = `/api/public/projects/circle-packing/hosted-results/${encodeURIComponent(result.id)}/investigation`;
  const record = useProjectResource<HostedCirclePublicInvestigation>(path);
  if (record.error) return <p className="action-error" role="alert">Research notes are unavailable. Please try again.</p>;
  if (!record.data) return <p role="status">Loading research notes…</p>;
  const data = record.data;
  if (data.resultId !== result.id || data.binding.attemptId !== result.attemptId
      || data.binding.artifactManifestDigest !== result.artifactManifestDigest) {
    return <p className="action-error" role="alert">These notes could not be matched to this result.</p>;
  }
  const notes = data.status === 'VALID' ? data.investigation : null;
  if (!notes) return <p>No validated research notes are available for this attempt.</p>;
  return <div className="investigation-loop hosted-investigation-body">
    <p className="field-hint">Recorded by the research agent. Assess these notes alongside the evaluator report; accepting a packing does not approve its explanation.</p>
    <section><h4>Propose</h4><p>{notes.proposal}</p><p><strong>Expected:</strong> {notes.expectation}</p></section>
    <section><h4>Test</h4><p className="investigation-label">Conditions</p><ul>{notes.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
      <p className="investigation-label">Observations</p><ul>{notes.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul></section>
    <section><h4>Update</h4><p>{notes.assessment}</p><p><strong>Next:</strong> {notes.nextAction}</p></section>
    {notes.researchReferences?.length ? <p className="field-hint">Draws on {notes.researchReferences.length} retained Hypothesis {notes.researchReferences.length === 1 ? 'reference' : 'references'}. The full record identifies the exact snapshots.</p> : null}
    <a className="hosted-investigation-source" href={path} target="_blank" rel="noreferrer">Full research record<ArrowUpRight /></a>
  </div>;
}

export function HostedInvestigation({ result }: { result: HostedCircleResultSummary }) {
  const [open, setOpen] = useState(false);
  const status = result.investigation?.status ?? 'NOT_PROVIDED';
  if (status === 'NOT_PROVIDED') return <p className="field-hint hosted-investigation-notice">No research notes were retained for this attempt.</p>;
  if (status === 'INVALID') return <p className="field-hint hosted-investigation-notice">The agent’s research notes could not be validated. The geometry check is recorded separately above.</p>;
  return <details className="investigation-record hosted-investigation" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Research notes · Propose → Test → Update</summary>
    {open ? <InvestigationRecord result={result} /> : null}
  </details>;
}
