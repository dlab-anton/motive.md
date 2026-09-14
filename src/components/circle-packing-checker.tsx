import { useRef, useState } from 'react';
import { CheckCircle2, Download, FileJson2, ShieldAlert } from 'lucide-react';
import { checkCirclePackingWitness, CSQV_MAX_BYTES, type CirclePackingCheck } from '@/lib/circle-packing';
import { circlePackingProfile } from '@/lib/projects';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

type Point = { x: number; y: number; r: number };

function pointsFrom(source: string): Point[] {
  const value = JSON.parse(source) as { circles: Array<{ x: string; y: string; r: string }> };
  return value.circles.map(circle => ({ x: Number(circle.x), y: Number(circle.y), r: Number(circle.r) }));
}

async function sha256(source: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(source).buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function CirclePackingChecker() {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<CirclePackingCheck | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [busy, setBusy] = useState(false);
  const [frozenReference, setFrozenReference] = useState(false);
  const generation = useRef(0);

  const check = (text: string) => {
    const checked = checkCirclePackingWitness(text);
    setResult(checked);
    setPoints(checked.ok ? pointsFrom(text) : []);
  };

  async function loadReference() {
    const current = ++generation.current;
    setBusy(true); setResult(null); setPoints([]); setSource(''); setName(''); setFrozenReference(false);
    try {
      const response = await fetch('/projects/circle-packing/reference-witness.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Frozen reference is unavailable.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (current !== generation.current) return;
      if (bytes.byteLength > CSQV_MAX_BYTES) throw new Error('Frozen reference exceeds the checker limit.');
      if (await sha256(bytes) !== circlePackingProfile.laterReference.witnessSha256) throw new Error('Frozen reference bytes do not match the published SHA-256.');
      if (current !== generation.current) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      setSource(text); setName('Frozen N=101 reference'); setFrozenReference(true); check(text);
    } catch (error) {
      setResult({ ok: false, error: { code: 'REFERENCE_LOAD_FAILED', message: error instanceof Error ? error.message : 'Frozen reference is unavailable.' } });
      setPoints([]);
    } finally { if (current === generation.current) setBusy(false); }
  }

  return <section className="witness-checker" aria-labelledby="witness-checker-title">
    <div className="sample-section-heading"><div><p className="eyebrow">Exact arithmetic</p><h2 id="witness-checker-title">Check a witness locally</h2></div><Badge variant="outline">Not an official evaluation</Badge></div>
    <p>Upload a data-only <code>motive.csqv.witness.v1</code> JSON file. This local checker verifies that all 101 circles fit, rejects even tiny overlaps, and recomputes the radius sum.</p>
    <Card><CardHeader><CardTitle className="text-base">Witness input</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="form-field"><Label htmlFor="circle-witness">JSON witness · at most 32 KiB</Label><Input id="circle-witness" type="file" accept="application/json,.json" disabled={busy} onChange={event => {
        const current = ++generation.current;
        const file = event.target.files?.[0]; setBusy(false); setResult(null); setPoints([]); setSource(''); setName(file?.name ?? ''); setFrozenReference(false);
        if (!file) return;
        if (file.size > CSQV_MAX_BYTES) { setResult({ ok: false, error: { code: 'SIZE_LIMIT', message: `Witness must be at most ${CSQV_MAX_BYTES} UTF-8 bytes.` } }); return; }
        void file.text().then(text => { if (current === generation.current) setSource(text); }).catch(() => { if (current === generation.current) setResult({ ok: false, error: { code: 'READ_FAILED', message: 'Could not read that file.' } }); });
      }} /></div>
      <div className="flex flex-wrap gap-2"><Button onClick={() => check(source)} disabled={!source || busy}><FileJson2 />Check selected witness</Button><Button variant="outline" onClick={() => void loadReference()} disabled={busy}>{busy ? 'Loading…' : 'Check frozen reference'}</Button><Button variant="ghost" asChild><a href="/projects/circle-packing/reference-witness.json" download><Download />Download frozen reference</a></Button></div>
      {name ? <p className="field-hint">Loaded: {name}</p> : null}
    </CardContent></Card>
    {result?.ok ? <div className="checker-result checker-pass" role="status"><div><CheckCircle2 /><strong>Feasible under the local exact checker</strong></div><p className="checker-score">Radius sum: <strong>{result.report.objective.exact_decimal}</strong> · {{ greater: 'greater than', equal: 'equal to', less: 'less than' }[result.report.objective.versus_frozen_reference_5_29109518547430697]} the frozen reference.</p><p>This is local feedback. It is not an accepted Motive result and has no official evaluator or human review.</p><details><summary>Check details</summary><dl>
      <div><dt>Minimum boundary slack</dt><dd>{result.report.minimum_boundary_slack.exact_decimal} · circle {result.report.minimum_boundary_slack.circle}</dd></div>
      <div><dt>Minimum squared pair slack</dt><dd>{result.report.minimum_squared_pair_slack.exact_decimal} · circles {result.report.minimum_squared_pair_slack.circles.join(' / ')}</dd></div>
      <div><dt>Exact arithmetic</dt><dd>Length scale 10^{result.report.decimal_places}; squared scale for pair slack</dd></div>
    </dl></details></div> : result ? <div className="checker-result checker-fail" role="alert"><div><ShieldAlert /><strong>Witness rejected · {result.error.code}</strong></div><p>{result.error.message}</p></div> : null}
    {points.length ? <figure className="packing-figure"><svg viewBox="0 0 1 1" role="img" aria-label={`Approximate plot of ${points.length} circles from the checked witness`}>
      <rect x="0" y="0" width="1" height="1" />{points.map((point, index) => <circle key={index} cx={point.x} cy={1 - point.y} r={point.r} />)}
    </svg><figcaption>Approximate plot for inspection. Feasibility and objective use the exact decimal strings above.{frozenReference ? ` Frozen reference attributed to ${circlePackingProfile.laterReference.attribution}.` : ''}</figcaption></figure> : null}
  </section>;
}
