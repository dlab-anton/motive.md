import { useEffect, useState } from 'react';
import { matmul444Profile } from '@/lib/projects';
import { checkMatmulWitness, MATMUL_MAX_BYTES, type MatmulWitness } from '@/lib/matmul';

/** Sign pattern of the three factor matrices: one row per product, one column per matrix entry. */
export function SchemeFigure({ witness, label }: { witness: MatmulWitness; label: string }) {
  const [a, b, c] = witness.shape;
  const widths = [a * b, b * c, c * a];
  const gap = 2;
  const width = widths.reduce((sum, item) => sum + item, 0) + gap * 2;
  const offsets = [0, widths[0] + gap, widths[0] + widths[1] + gap * 2];
  return <svg viewBox={`0 0 ${width} ${witness.rank}`} role="img" aria-label={label} className="scheme-figure" preserveAspectRatio="xMidYMid meet">
    {[witness.u, witness.v, witness.w].map((factor, index) => <g key={index} transform={`translate(${offsets[index]} 0)`}>
      <rect x="0" y="0" width={widths[index]} height={witness.rank} className="scheme-block" />
      {factor.flatMap((row, product) => row.map((entry, column) => entry === 0 ? null
        : <rect key={`${product}-${column}`} x={column} y={product} width="1" height="1" className={entry > 0 ? 'scheme-cell-positive' : 'scheme-cell-negative'} />))}
    </g>)}
  </svg>;
}

export type CheckedSchemeCandidate = { artifactUrl: string; artifactSha256: string; score: string };

/** A submitted scheme, re-fetched, digest-verified and re-checked in the browser before it is drawn. */
export function CheckedScheme({ candidate, submitted = false }: { candidate: CheckedSchemeCandidate; submitted?: boolean }) {
  const [witness, setWitness] = useState<MatmulWitness | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(candidate.artifactUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('Candidate unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MATMUL_MAX_BYTES) throw new Error('Candidate too large');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== candidate.artifactSha256.replace(/^sha256:/, '')) throw new Error('Candidate changed');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const checked = checkMatmulWitness(source);
        if (!checked.ok || String(checked.report.rank) !== candidate.score) throw new Error('Candidate failed validation');
        if (!controller.signal.aborted) setWitness(JSON.parse(source) as MatmulWitness);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [candidate.artifactUrl, candidate.artifactSha256, candidate.score]);
  return <figure className="reference-arrangement reference-scheme"><div className="arrangement-label"><span>{submitted ? 'The submitted scheme' : 'Best checked Motive candidate'}</span><span>U · V · W sign patterns</span></div>
    {witness ? <SchemeFigure witness={witness} label={submitted ? `The submitted and exactly checked scheme with ${witness.rank} products` : `The best checked Motive scheme with ${witness.rank} products`} />
      : <div className="arrangement-placeholder" role="status">{failed ? 'Preview unavailable. Download the checked scheme in Evidence.' : 'Loading the checked scheme…'}</div>}
    <figcaption><strong>{candidate.score}</strong><span>Products · integer coefficients</span><small>{submitted ? 'Drawn from this submission’s exact scheme file. Each row is one product; the tensor check and review status are recorded separately above.' : 'Tensor check passed; review status is recorded separately.'}</small></figcaption>
  </figure>;
}

export function MatmulReference({ referenceOnly = false }: { referenceOnly?: boolean }) {
  const [witness, setWitness] = useState<MatmulWitness | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/projects/matmul-4x4x4/reference-witness.json', { signal: controller.signal });
        if (!response.ok) throw new Error('Reference unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MATMUL_MAX_BYTES) throw new Error('Reference too large');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== matmul444Profile.reference.witnessSha256) throw new Error('Reference changed');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!checkMatmulWitness(source).ok) throw new Error('Reference failed validation');
        if (!controller.signal.aborted) setWitness(JSON.parse(source) as MatmulWitness);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, []);

  return <div className={`reference-comparison${referenceOnly ? ' reference-single' : ''}`}>
    <figure className="reference-arrangement reference-scheme">
      <div className="arrangement-label"><span>Checked starting point</span><span>U · V · W sign patterns</span></div>
      {witness ? <SchemeFigure witness={witness} label="The frozen reference scheme: 49 products, Strassen applied twice" />
        : <div className="arrangement-placeholder" role="status">{failed ? 'Reference preview unavailable. Download the reference scheme below.' : 'Loading the checked reference…'}</div>}
      <figcaption><strong>49</strong><span>Products · integer coefficients</span><small>Strassen (1969) applied to 2×2 blocks. Each row is one product; each column one matrix entry; filled cells are +1 or −1. The tensor check is exact.</small></figcaption>
    </figure>
  </div>;
}
