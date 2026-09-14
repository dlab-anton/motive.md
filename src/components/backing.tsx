import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SupportAction, SupportState } from '@/lib/support';
import type { Project } from '@/lib/projects';
import type { AccountUser } from '@/lib/auth-client';
import { useProjectCredits } from '@/lib/use-project-credits';
import type { ParticipationMeResponse } from '@/lib/participation';

export type SupportControls = {
  state: SupportState;
  user: AccountUser | null;
  busy: boolean;
  send: (action: SupportAction) => Promise<boolean>;
  signIn: () => void;
  agentActivity: { data: ParticipationMeResponse | null; error: string };
};

function CreditContribution({ project, controls }: { project: Project; controls: SupportControls }) {
  const credits = useProjectCredits(controls.user);
  const [draft, setDraft] = useState<string | null>(null);
  const amount = Number(draft ?? credits.wallet?.available ?? 10);
  const projectAllocated = credits.wallet?.allocations.filter(item => item.project === project.id).reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const valid = Number.isSafeInteger(amount) && amount > 0 && amount <= (credits.wallet?.available ?? 0);
  return <div className="space-y-5">
        {!controls.user ? <><div className="welcome-credit"><Gift aria-hidden="true" /><div><strong>10 free Motive credits</strong><span>A one-time welcome for your account.</span></div></div><Button size="lg" className="w-full h-11" onClick={controls.signIn}>Sign in to use your credits<ArrowUpRight /></Button></>
          : credits.loading ? <p role="status">Loading your credits…</p>
          : credits.wallet ? <>
            <div className="credit-balance"><span>Available to allocate</span><strong>{credits.wallet.available}<small>Motive credits</small></strong></div>
            {projectAllocated > 0 ? <div className="allocation-receipt" role="status"><CheckCircle2 aria-hidden="true" /><div><strong>{projectAllocated} credits allocated to this project</strong><span>Recorded · waiting for a funded run</span></div></div> : null}
            {credits.wallet.available > 0 || credits.retryPending ? <form onSubmit={event => { event.preventDefault(); void credits.allocate(amount); }} className="credit-allocation-form">
              <Label htmlFor="credit-amount">Credits for this project</Label><Input id="credit-amount" type="number" min={1} max={credits.wallet.available} step={1} value={draft ?? credits.wallet.available} disabled={credits.busy || credits.retryPending} onChange={event => setDraft(event.target.value)} />
              <Button type="submit" size="lg" className="w-full" disabled={credits.busy || (!credits.retryPending && !valid)}>{credits.busy ? 'Recording…' : credits.retryPending ? 'Retry this allocation' : `Allocate ${valid ? amount : ''} ${amount === 1 ? 'credit' : 'credits'}`}</Button>
            </form> : <p className="field-hint">All your welcome credits are allocated. You can follow the project for updates.</p>}
          </> : null}
        {credits.error ? !credits.wallet && !credits.retryPending ? <div className="provider-availability" role="status"><p>Your credits are temporarily unavailable. No allocation was made from this screen.</p><Button variant="outline" size="sm" onClick={credits.reload}>Check credits again</Button></div> : <div className="credit-error" role="alert"><p>{credits.error}</p>{credits.retryPending ? <p>Retrying checks the same allocation; it won’t create a second one.</p> : null}</div> : null}
        <p className="credit-disclosure">Credits record your support. They aren’t cash or model tokens. Allocations wait here until a sponsored run is ready; no AI spending starts when you allocate.</p>
  </div>;
}

export function BackingPanel({ project, controls }: { project: Project; controls: SupportControls }) {
  return <div className="credit-support" id="backing">
    <p className="muted-copy">Allocate Motive credits to support a future project run.</p>
    <CreditContribution project={project} controls={controls} />
  </div>;
}
