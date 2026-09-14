import { ArrowUpRight, Clock3 } from 'lucide-react';
import type { ProjectRunDonorReceipt, ProjectRunState, PublicProjectRuns } from '@/lib/project-runs';

export const runStateLabel: Record<ProjectRunState, string> = {
  queued: 'Queued', running: 'Research running', stopping: 'Stopping', checking: 'Checking the candidate',
  'awaiting-review': 'Awaiting project review', finished: 'Review complete', cancelled: 'Cancelled',
  failed: 'Attempt failed', unresolved: 'Run status needs checking',
};

export function projectRunHeadline(data: PublicProjectRuns | null): string {
  if (!data) return 'Checking hosted research…';
  if (data.totalRuns === 0) return 'First funded attempt not started';
  for (const state of ['running', 'stopping', 'checking', 'queued', 'unresolved', 'awaiting-review'] as const) {
    if (data.stateCounts[state] > 0) return runStateLabel[state];
  }
  return 'Past attempts available';
}

const evidenceHref = (resultId: string) => `/?project=circle-packing&tab=evidence#hosted-result-${encodeURIComponent(resultId)}`;
const modelLabel = (model: string) => model === 'openai/gpt-6-astra' ? 'OpenAI Astra' : model;

export function HostedRunActivity({ data }: { data: PublicProjectRuns | null }) {
  if (!data?.runs.length) return null;
  return <section className="project-activity hosted-run-activity" aria-labelledby="hosted-runs-title">
    <div className="section-heading-row"><h2 id="hosted-runs-title">Funded research attempts</h2><span className="eyebrow">{data.totalRuns} total</span></div>
    <ol>{data.runs.map(run => <li key={run.attemptId}><span className="activity-dot" aria-hidden="true" /><div>
      <p>{runStateLabel[run.state]}</p><span>{modelLabel(run.model)}</span>
      <time dateTime={run.endedAt ?? run.startedAt ?? run.createdAt}>{run.endedAt ? 'Worker stopped' : run.startedAt ? 'Started' : 'Queued'} {new Date(run.endedAt ?? run.startedAt ?? run.createdAt).toLocaleString()}</time>
      {run.state === 'failed' ? <p className="field-hint">This attempt did not return a checkable result.</p> : null}
      {run.state === 'unresolved' ? <p className="field-hint">The recorded execution state is uncertain. Motive needs to reconcile it before reporting an outcome.</p> : null}
      {run.result ? <a className="inline-link" href={evidenceHref(run.result.id)}>View the evidence <ArrowUpRight className="size-3.5" /></a> : null}
    </div></li>)}</ol>
  </section>;
}

export function RunBudgetReceipt({ run }: { run: ProjectRunDonorReceipt }) {
  return <div className="run-budget-receipt">
    <p className="run-receipt-state"><Clock3 aria-hidden="true" />{runStateLabel[run.state]}</p>
    <dl>
      <div><dt>Provider model cost</dt><dd>{run.inference.providerActualCostUsd === null ? 'Not reported' : `$${run.inference.providerActualCostUsd}`}</dd></div>
      <div><dt>Compute cost</dt><dd>{run.compute.actualCostUsd === null ? 'Not reported' : `$${run.compute.actualCostUsd}`}</dd></div>
      <div><dt>Model funds held</dt><dd>${run.inference.heldUsd}</dd></div>
      {Number(run.inference.unresolvedExposureUsd) > 0 ? <div><dt>Awaiting reconciliation</dt><dd>${run.inference.unresolvedExposureUsd}</dd></div> : null}
    </dl>
    <p className="field-hint">{run.attemptClosed ? 'The model allowance for this attempt is closed.' : 'This receipt may change as provider usage is reconciled.'} Unreported costs are not counted as zero.</p>
    <details><summary>Usage detail</summary><p>Motive has accounted for ${run.inference.consumedUsd} of model use. The provider’s confirmed cost is shown separately above.</p><p>Compute and model costs are separate records.</p></details>
    {run.result ? <a className="inline-link" href={evidenceHref(run.result.id)}>View this attempt’s evidence <ArrowUpRight className="size-3.5" /></a> : null}
  </div>;
}
