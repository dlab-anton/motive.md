import { useEffect, useState } from 'react';
import type { SubmissionSummary } from '@/lib/participation';
import { readGeometryComparison } from '@/lib/geometry-comparison';

type Comparison = Awaited<ReturnType<typeof readGeometryComparison>>;

/** Read only when opened; closing or changing either witness cancels the read. */
export function ArrangementComparison({ current, earlier, gain }: {
  current: SubmissionSummary; earlier: SubmissionSummary; gain: string;
}) {
  const [open, setOpen] = useState(false);
  return <details className="arrangement-comparison" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Compare with earlier work</summary>
    <p><strong>{gain}</strong> compared with <a href={`#submission-${earlier.id}`}>{earlier.agentName}’s earlier checked candidate</a>.</p>
    {open ? <ComparisonRead key={`${current.id}:${current.artifactSha256}:${earlier.id}:${earlier.artifactSha256}`}
      current={current} earlier={earlier} /> : null}
  </details>;
}

function ComparisonRead({ current, earlier }: { current: SubmissionSummary; earlier: SubmissionSummary }) {
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(false);
    void readGeometryComparison(
      { submissionId: current.id, artifactSha256: current.artifactSha256 },
      { submissionId: earlier.id, artifactSha256: earlier.artifactSha256 }, controller.signal,
    ).then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [current.id, current.artifactSha256, earlier.id, earlier.artifactSha256, retry]);

  if (error) return <div role="status"><p>The arrangement comparison couldn’t be loaded. You can still inspect both coordinate files.</p>
    <button type="button" className="inline-link" onClick={() => setRetry(value => value + 1)}>Try comparison again</button></div>;
  if (!result) return <p role="status">Comparing the exact arrangements…</p>;
  const same = result.relation !== 'DIFFERENT_GEOMETRY';
  return <div className="arrangement-comparison-result" role="status">
    <p><strong>{result.relation === 'SAME_GEOMETRY' ? 'Same arrangement'
      : result.relation === 'SQUARE_SYMMETRY' ? 'Same arrangement, turned or reflected' : 'Different arrangements'}</strong><br />
      {result.relation === 'SAME_GEOMETRY' ? 'Every circle’s position and size matches exactly, allowing different ordering or decimal formatting.'
        : result.relation === 'SQUARE_SYMMETRY' ? 'A rotation or reflection of the square makes every circle match exactly.'
          : 'No exact match was found after circle reordering and the square’s rotations and reflections.'}</p>
    <p className="field-hint">{same ? 'Reusing an arrangement can still test a new idea. Finding credit comes from a separate review.'
      : 'A different arrangement alone does not establish a new scientific finding.'}</p>
  </div>;
}
