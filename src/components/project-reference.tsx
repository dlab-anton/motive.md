import { useEffect, useState } from 'react';
import { CircleDashed } from 'lucide-react';
import { circlePackingProfile } from '@/lib/projects';
import { checkCirclePackingWitness, CSQV_MAX_BYTES } from '@/lib/circle-packing';

type Circle = { x: string; y: string; r: string };

export type AcceptedPacking = { artifactUrl: string; artifactSha256: string; score: string };

export function CheckedArrangement({ candidate, submitted = false }: { candidate: AcceptedPacking; submitted?: boolean }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(candidate.artifactUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('Candidate unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > CSQV_MAX_BYTES) throw new Error('Candidate too large');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== candidate.artifactSha256.replace(/^sha256:/, '')) throw new Error('Candidate changed');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const checked = checkCirclePackingWitness(source);
        if (!checked.ok || checked.report.objective.exact_decimal !== candidate.score) throw new Error('Candidate failed validation');
        if (!controller.signal.aborted) setCircles((JSON.parse(source) as { circles: Circle[] }).circles);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [candidate.artifactUrl, candidate.artifactSha256, candidate.score]);
  return <figure className="reference-arrangement"><div className="arrangement-label"><span>{submitted ? 'The submitted arrangement' : 'Best accepted Motive candidate'}</span><span>101 circles</span></div>
    {circles ? <svg viewBox="0 0 1 1" role="img" aria-label={submitted ? 'The submitted and geometrically checked arrangement of 101 circles' : 'The accepted Motive arrangement of 101 circles'}>{circles.map((circle, index) => <circle key={index} cx={Number(circle.x)} cy={1 - Number(circle.y)} r={Number(circle.r)} />)}</svg>
      : <div className="arrangement-placeholder" role="status">{failed ? 'Preview unavailable. Download the checked coordinates in Evidence.' : 'Loading the checked arrangement…'}</div>}
    <figcaption><strong>{Number(candidate.score).toFixed(6)}</strong><span>Sum of radii · rounded for display</span><small>{submitted ? 'Drawn from this submission’s exact coordinate file. Drawing is approximate; the geometry check and review status are recorded separately above.' : 'Geometry checked; accepted by a project reviewer. This does not establish global optimality.'}</small></figcaption>
  </figure>;
}

export function ProjectReference({ candidate, referenceOnly = false }: { candidate?: AcceptedPacking | null; referenceOnly?: boolean }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/projects/circle-packing/reference-witness.json', { signal: controller.signal });
        if (!response.ok) throw new Error('Reference unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > CSQV_MAX_BYTES) throw new Error('Reference too large');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== circlePackingProfile.laterReference.witnessSha256) throw new Error('Reference changed');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!checkCirclePackingWitness(source).ok) throw new Error('Reference failed validation');
        if (!controller.signal.aborted) setCircles((JSON.parse(source) as { circles: Circle[] }).circles);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, []);

  return <div className={`reference-comparison${referenceOnly ? ' reference-single' : ''}`}>
    <figure className="reference-arrangement">
      <div className="arrangement-label"><span>Checked starting point</span><span>101 circles</span></div>
      {circles ? <svg viewBox="0 0 1 1" role="img" aria-label="The independently checked reference arrangement of 101 circles">
        {circles.map((circle, index) => <circle key={index} cx={Number(circle.x)} cy={1 - Number(circle.y)} r={Number(circle.r)} />)}
      </svg> : <div className="arrangement-placeholder" role="status">{failed ? 'Reference preview unavailable. Download the reference coordinates below.' : 'Loading the checked reference…'}</div>}
      <figcaption><strong>5.291095</strong><span>Sum of radii · rounded for display</span><small>Coordinates credited to Wes Sander / MoltFire. Drawing is approximate; the numerical check is exact.</small></figcaption>
    </figure>
    {referenceOnly ? null : candidate ? <CheckedArrangement key={candidate.artifactSha256} candidate={candidate} /> : <div className="candidate-awaiting"><CircleDashed aria-hidden="true" /><span className="eyebrow">The next result</span><h3>Room for discovery.</h3><p>No accepted Motive candidate yet. Open a completed task to inspect its checked arrangement and review status.</p></div>}
  </div>;
}
