import { useState } from 'react';
import type { ActivateProjectLeadBudgetResponse, FundedRunReadinessResponse, ProjectFundingBudget } from '@/lib/funding';
import { useProjectMutation } from '@/lib/project-api';
import { Button } from './ui/button';
import { Label } from './ui/label';

export function FundedAttempt({ budget, readiness }: { budget: ProjectFundingBudget; readiness: FundedRunReadinessResponse | null }) {
  const mutation = useProjectMutation<ActivateProjectLeadBudgetResponse>();
  const [selected, setSelected] = useState('');
  const [queued, setQueued] = useState(false);
  const eligible = readiness?.workOrders.filter(work => work.projectLeadEligible && work.model === budget.model) ?? [];
  const work = eligible.find(item => item.id === selected) ?? eligible[0];
  const open = Boolean(readiness?.controllerSpendingEnabled && work
    && !readiness.blockers.includes('CONNECTION_REQUIRED') && !readiness.blockers.includes('BUDGET_REQUIRED'));
  if (budget.status !== 'WAITING_TO_ACTIVATE' || queued) return queued ? <p role="status">Astra’s attempt is reserved. Its progress will appear here.</p> : null;
  const ceiling = work ? Number(work.ceilingUsd) < Number(budget.limitUsd) ? work.ceilingUsd : budget.limitUsd : null;
  return <div className="funded-attempt">
    <h5>Put this budget to work</h5>
    {work ? <>
      {eligible.length > 1 ? <><Label htmlFor={`funded-work-${budget.id}`}>Approved attempt</Label><select id={`funded-work-${budget.id}`} value={work.id} onChange={event => setSelected(event.target.value)} disabled={mutation.busy || mutation.retryPending}>{eligible.map(item => <option key={item.id} value={item.id}>{item.objective}</option>)}</select></> : null}
      <p>{work.objective}</p><p>OpenAI Astra · up to <strong>${ceiling}</strong> in model use · at most {work.maxRuntimeSeconds} seconds.</p>
      <p className="field-hint">This queues one bounded attempt. A useful result can confirm the reference or rule out an idea; improvement is not guaranteed. Compute is accounted for separately.</p>
    </> : <p>{readiness ? 'The project team is preparing an approved Astra attempt for this budget. It has not started spending.' : 'Checking the next approved attempt…'}</p>}
    {work && !readiness?.controllerSpendingEnabled ? <p>The project team has not opened funded execution yet.</p> : null}
    {work || mutation.retryPending ? <Button size="sm" className="w-full" disabled={mutation.busy || (!mutation.retryPending && !open)} onClick={() => {
      void mutation.submit(`/api/funding/openrouter/budgets/${budget.id}/activate`, { mode: 'PROJECT_LEAD', workOrderId: work?.id }).then(result => {
        if (result?.activation.kind === 'PROJECT_LEAD') setQueued(true);
      });
    }}>{mutation.busy ? 'Reserving the attempt…' : mutation.retryPending ? 'Check this reservation again' : 'Queue Astra attempt'}</Button> : null}
    {mutation.error ? <p className="action-error" role="alert">{mutation.error}</p> : null}
  </div>;
}
