import { useRef, useState } from 'react';
import { CheckCircle2, Download, FileJson2, ShieldAlert } from 'lucide-react';
import { checkMatmulWitness, MATMUL_MAX_BYTES, type MatmulCheck, type MatmulWitness } from '@/lib/matmul';
import { describeScheme } from '@/lib/matmul-schemes';
import { matmul444Profile } from '@/lib/projects';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SchemeFigure } from './matmul-reference';

async function sha256(source: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(source).buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const PRODUCT_PREVIEW = 12;

export function MatmulChecker() {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<MatmulCheck | null>(null);
  const [witness, setWitness] = useState<MatmulWitness | null>(null);
  const [busy, setBusy] = useState(false);
  const [frozenReference, setFrozenReference] = useState(false);
  const generation = useRef(0);

  const check = (text: string) => {
    const checked = checkMatmulWitness(text);
    setResult(checked);
    setWitness(checked.ok ? JSON.parse(text) as MatmulWitness : null);
  };

  async function loadReference() {
    const current = ++generation.current;
    setBusy(true); setResult(null); setWitness(null); setSource(''); setName(''); setFrozenReference(false);
    try {
      const response = await fetch('/projects/matmul-4x4x4/reference-witness.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Frozen reference is unavailable.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (current !== generation.current) return;
      if (bytes.byteLength > MATMUL_MAX_BYTES) throw new Error('Frozen reference exceeds the checker limit.');
      if (await sha256(bytes) !== matmul444Profile.reference.witnessSha256) throw new Error('Frozen reference bytes do not match the published SHA-256.');
      if (current !== generation.current) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      setSource(text); setName('Frozen ⟨4,4,4⟩ reference'); setFrozenReference(true); check(text);
    } catch (error) {
      setResult({ ok: false, error: { code: 'REFERENCE_LOAD_FAILED', message: error instanceof Error ? error.message : 'Frozen reference is unavailable.' } });
      setWitness(null);
    } finally { if (current === generation.current) setBusy(false); }
  }

  const rendered = witness ? describeScheme(witness) : null;
  return <section className="witness-checker" aria-labelledby="witness-checker-title">
    <div className="sample-section-heading"><div><p className="eyebrow">Exact arithmetic</p><h2 id="witness-checker-title">Check a scheme locally</h2></div><Badge variant="outline">Not an official evaluation</Badge></div>
    <p>Upload a data-only <code>motive.matmul.witness.v1</code> JSON file. This local checker reconstructs the 4×4 matrix multiplication tensor from the U, V and W factors with exact integer arithmetic, rejects any non-integer coefficient, and counts the products.</p>
    <Card><CardHeader><CardTitle className="text-base">Scheme input</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="form-field"><Label htmlFor="matmul-witness">JSON scheme · at most 256 KiB</Label><Input id="matmul-witness" type="file" accept="application/json,.json" disabled={busy} onChange={event => {
        const current = ++generation.current;
        const file = event.target.files?.[0]; setBusy(false); setResult(null); setWitness(null); setSource(''); setName(file?.name ?? ''); setFrozenReference(false);
        if (!file) return;
        if (file.size > MATMUL_MAX_BYTES) { setResult({ ok: false, error: { code: 'SIZE_LIMIT', message: `Scheme must be at most ${MATMUL_MAX_BYTES} UTF-8 bytes.` } }); return; }
        void file.text().then(text => { if (current === generation.current) setSource(text); }).catch(() => { if (current === generation.current) setResult({ ok: false, error: { code: 'READ_FAILED', message: 'Could not read that file.' } }); });
      }} /></div>
      <div className="flex flex-wrap gap-2"><Button onClick={() => check(source)} disabled={!source || busy}><FileJson2 />Check selected scheme</Button><Button variant="outline" onClick={() => void loadReference()} disabled={busy}>{busy ? 'Loading…' : 'Check frozen reference'}</Button><Button variant="ghost" asChild><a href="/projects/matmul-4x4x4/reference-witness.json" download><Download />Download reference</a></Button></div>
      {name ? <p className="field-hint">Loaded: {name}</p> : null}
    </CardContent></Card>
    {result?.ok ? <div className="checker-result checker-pass" role="status"><div><CheckCircle2 /><strong>Valid under the local exact checker</strong></div><p className="checker-score">Products: <strong>{result.report.rank}</strong> · {{ greater: 'more than', equal: 'equal to', less: 'fewer than' }[result.report.versus_frozen_reference]} the frozen reference of {result.report.reference_rank}</p><details><summary>Exact report</summary><dl>
      <div><dt>Coefficients</dt><dd>{result.report.coefficient_class === 'ternary' ? 'ternary (−1, 0, 1)' : `integers up to ±${result.report.max_abs_coefficient}`}</dd></div>
      <div><dt>Nonzero entries</dt><dd>U {result.report.nonzero_entries.u} · V {result.report.nonzero_entries.v} · W {result.report.nonzero_entries.w}</dd></div>
      <div><dt>Tensor entries checked</dt><dd>{result.report.tensor_entries_checked} · every product A[i][j]·B[j][k] reaches C[i][k] exactly once and nothing else survives</dd></div>
    </dl></details></div> : result ? <div className="checker-result checker-fail" role="alert"><div><ShieldAlert /><strong>Scheme rejected · {result.error.code}</strong></div><p>{result.error.message}</p></div> : null}
    {witness && rendered ? <figure className="scheme-preview"><SchemeFigure witness={witness} label={`Sign pattern of the checked scheme with ${witness.rank} products`} />
      <figcaption>Sign pattern for inspection: one row per product, columns for A, B and C entries. Validity and the product count use the exact check above.{frozenReference ? ` Frozen reference: ${matmul444Profile.reference.attribution}.` : ''}</figcaption>
      <details className="scheme-listing"><summary>Products as formulas</summary><pre>{[...rendered.products.slice(0, PRODUCT_PREVIEW), ...(rendered.products.length > PRODUCT_PREVIEW ? [`… ${rendered.products.length - PRODUCT_PREVIEW} more products`] : []), '', ...rendered.outputs].join('\n')}</pre></details>
    </figure> : null}
  </section>;
}
