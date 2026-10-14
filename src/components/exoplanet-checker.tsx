import { useRef, useState } from 'react';
import { CheckCircle2, FileJson2, ShieldAlert } from 'lucide-react';
import { checkExoplanetEvidence, EXOPLANET_MAX_BYTES, type ExoplanetCheck } from '@/lib/exoplanet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function ExoplanetChecker() {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<ExoplanetCheck | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  return <section className="witness-checker" aria-labelledby="exoplanet-checker-title">
    <p className="eyebrow">Before you submit</p>
    <h2 id="exoplanet-checker-title">Check an evidence bundle</h2>
    <p>Check that your JSON has the fields and values required by the project. This runs locally in your browser. It does not fetch telescope data, rerun an analysis, or establish that a signal is a planet.</p>
    <div className="form-field"><Label htmlFor="exoplanet-evidence">Evidence JSON · at most 32 KiB</Label>
      <Input id="exoplanet-evidence" type="file" accept="application/json,.json" onChange={event => {
        const current = ++generation.current;
        setSource(''); setResult(null); setError('');
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > EXOPLANET_MAX_BYTES) { setError('The evidence bundle must be at most 32 KiB. Retain larger source and trial logs through the reproducibility API.'); return; }
        void file.text().then(value => { if (current === generation.current) setSource(value); }).catch(() => {
          if (current === generation.current) setError('The file could not be read.');
        });
      }} />
    </div>
    <div className="about-project-links"><a href="/projects/exoplanet-hunting/evidence.schema.json">Evidence schema ↗</a><a href="/projects/exoplanet-hunting/example-evidence.json" download>Download synthetic format example ↓</a></div>
    <Button disabled={!source} onClick={() => setResult(checkExoplanetEvidence(source))}><FileJson2 />Check evidence structure</Button>
    {error ? <p role="alert">{error}</p> : null}
    {result ? result.ok ? <div className="checker-result checker-pass" role="status">
      <div><CheckCircle2 /><strong>Evidence structure checked</strong></div>
      <p>The required fields are present and structurally valid. Data provenance and scientific claims remain unverified.</p>
      <details><summary>Structure report</summary><pre>{JSON.stringify(result.report, null, 2)}</pre></details>
    </div> : <div className="checker-result checker-fail" role="alert"><div><ShieldAlert /><strong>Evidence rejected · {result.error.code}</strong></div><p>{result.error.message}</p></div> : null}
  </section>;
}
