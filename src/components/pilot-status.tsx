import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

type Pilot = { title: string; purpose: string; nextStep: string; revision: number; stage: 'preparation'; executionEnabled: false; externalSubmissionsEnabled: false };
type State = { kind: 'loading' | 'unconfigured' | 'missing' | 'unavailable' } | { kind: 'loaded'; project: Pilot };
const api = (import.meta.env.VITE_CONTROL_API_URL as string | undefined)?.replace(/\/$/, '');

export function PilotStatus({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: api ? 'loading' : 'unconfigured' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setState({ kind: 'loading' });
    void fetch(`${api}/v1/projects/${encodeURIComponent(slug)}`, { signal: controller.signal, credentials: 'omit' })
      .then(async response => {
        if (response.status === 404) { setState({ kind: 'missing' }); return; }
        if (!response.ok) throw new Error('Unavailable');
        const { project } = await response.json();
        if (!project || typeof project.title !== 'string' || typeof project.purpose !== 'string' || typeof project.nextStep !== 'string'
          || !Number.isSafeInteger(project.revision) || project.revision < 1 || project.stage !== 'preparation'
          || project.executionEnabled !== false || project.externalSubmissionsEnabled !== false) throw new Error('Unsupported projection');
        if (!controller.signal.aborted) setState({ kind: 'loaded', project });
      }).catch(() => { if (!controller.signal.aborted) setState({ kind: 'unavailable' }); })
      .finally(() => window.clearTimeout(timeout));
    // Timeout has a visible terminal state; unmount cancellation does not update state.
    const onAbort = () => setState({ kind: 'unavailable' });
    controller.signal.addEventListener('abort', onAbort);
    return () => { controller.signal.removeEventListener('abort', onAbort); controller.abort(); window.clearTimeout(timeout); };
  }, [slug, retry]);

  return <section className="rounded-xl border p-5 space-y-3" aria-label="First run status">
    <div className="flex items-center justify-between gap-3"><h2 className="!m-0">First run</h2><Badge variant="outline">Not launched</Badge></div>
    {state.kind === 'loading' ? <p role="status">Loading the project’s current record…</p>
      : state.kind === 'loaded' ? <><p>{state.project.nextStep || 'The first work agreement is being prepared.'}</p><p className="text-xs text-muted-foreground">Project revision {state.project.revision} · Recorded by Motive</p></>
      : state.kind === 'unavailable' ? <div role="status"><p>The pilot record is temporarily unavailable.</p><Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>
      : state.kind === 'missing' ? <p>No real pilot has been registered for this goal yet.</p>
      : <p>The first run needs approved funding, a finite limit, and an independent evaluator. None is configured on this page.</p>}
    <details><summary className="cursor-pointer text-sm font-medium">Contribute with your agent</summary><p className="mt-3">Invited contributions will open after artifact handling and independent evaluation are ready. You’ll work with your own tools and submit a candidate for review. A submission will not promise acceptance or reimbursement.</p></details>
  </section>;
}
