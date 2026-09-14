import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, KeyRound, Unplug } from 'lucide-react';
import type { SupportControls } from './backing';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import type { FundingStatusResponse, StartOpenRouterConnectResponse, CompleteOpenRouterConnectResponse, CreateProjectFundingBudgetResponse, FundingReadinessCode, FundedRunReadinessResponse } from '@/lib/funding';
import { FundedAttempt } from './funded-attempt';
import { RunBudgetReceipt } from './project-runs';
import { notifyProjectChanged, projectRequest, useProjectMutation, useProjectResource } from '@/lib/project-api';
import { authenticatedFetch } from '@/lib/account-fetch';

const readiness: Record<FundingReadinessCode, string> = {
  READY: 'Ready for activation', CONNECTION_REQUIRED: 'Reconnect OpenRouter', ASSIGNMENT_REQUIRED: 'Waiting for an approved agent assignment',
  CONTROLLER_CLOSED: 'Waiting for live spending to open', PROFILE_REQUIRED: 'Waiting for this model’s verified run connection',
  WORK_ORDER_REQUIRED: 'Waiting for an approved funded work order', GRANT_REVOKED: 'Authorization ended',
  AWAITING_DISPATCH: 'Reserved for the project lead; waiting for the run to start',
};

export function OpenRouterFunding({ controls }: { controls: SupportControls }) {
  const status = useProjectResource<FundingStatusResponse>(controls.user ? '/api/funding/openrouter' : null);
  const runReadiness = useProjectResource<FundedRunReadinessResponse>(controls.user ? '/api/funding/openrouter/readiness' : null);
  const budget = useProjectMutation<CreateProjectFundingBudgetResponse>();
  const [limit, setLimit] = useState('1.00');
  const [model, setModel] = useState('openai/gpt-6-astra');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const callbackHandled = useRef(false);
  const connection = status.data?.connection?.status === 'CONNECTED' ? status.data.connection : null;
  useEffect(() => {
    if (!controls.user || callbackHandled.current) return;
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const flowId = url.searchParams.get('openrouter_flow');
    if (!code || !flowId) return;
    callbackHandled.current = true;
    url.searchParams.delete('code'); url.searchParams.delete('openrouter_flow');
    window.history.replaceState(null, '', url);
    setConnecting(true);
    void projectRequest<CompleteOpenRouterConnectResponse>('/api/funding/openrouter/callback', { flowId, code })
      .then(() => { setNotice('OpenRouter connected. Choose the budget you want to authorize.'); notifyProjectChanged(); })
      .catch(error => setError(error instanceof Error ? error.message : 'OpenRouter could not be connected. Start a new connection.'))
      .finally(() => setConnecting(false));
  }, [controls.user?.id]);
  async function connect() {
    if (busy.current) return;
    busy.current = true; setConnecting(true); setError('');
    try {
      const result = await projectRequest<StartOpenRouterConnectResponse>('/api/funding/openrouter/connect', {});
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://openrouter.ai' || url.pathname !== '/auth') throw new Error('The authorization link could not be verified.');
      window.location.assign(url.href);
    } catch (error) { setError(error instanceof Error ? error.message : 'OpenRouter could not be reached.'); setConnecting(false); busy.current = false; }
  }
  async function disconnect() {
    if (busy.current) return;
    busy.current = true; setConnecting(true); setError('');
    try {
      const response = await authenticatedFetch('/api/funding/openrouter', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error?.message || 'The connection could not be removed.'); }
      setNotice('Disconnected from Motive. You can also revoke the key in your OpenRouter account.'); notifyProjectChanged();
    } catch (error) { setError(error instanceof Error ? error.message : 'The connection could not be removed.'); }
    finally { busy.current = false; setConnecting(false); }
  }
  async function authorize() {
    const result = await budget.submit('/api/funding/openrouter/budgets', { project: 'circle-packing', limitUsd: limit, model });
    if (result) setNotice(`$${result.budget.limitUsd} budget authorized. You have not been charged by this authorization.`);
  }
  return <section className="openrouter-funding" aria-labelledby="openrouter-heading">
    <div className="provider-heading"><KeyRound /><h3 id="openrouter-heading">Use my OpenRouter budget</h3></div>
    <p>Put a capped API budget behind this project. OpenRouter bills actual model use; Motive keeps the authorization and usage record.</p>
    {!controls.user ? <Button variant="outline" className="w-full" onClick={controls.signIn}>Sign in to connect OpenRouter<ArrowUpRight /></Button>
      : connecting ? <p role="status">Connecting to OpenRouter…</p>
      : !status.data && !status.error ? <p role="status">Loading your connection…</p>
      : status.error && !status.data ? null
      : !connection ? <Button className="w-full" variant="outline" onClick={() => void connect()}>Connect OpenRouter<ArrowUpRight /></Button>
      : <>
        <div className="provider-connected"><CheckCircle2 /><div><strong>OpenRouter connected</strong><span>{connection.label || 'Your private API connection'}</span></div></div>
        <form className="provider-budget-form" onSubmit={event => { event.preventDefault(); void authorize(); }}>
          <Label htmlFor="provider-budget">Maximum project budget · USD</Label><Input id="provider-budget" type="number" inputMode="decimal" min="0.01" max="100" step="0.01" required value={limit} onChange={event => setLimit(event.target.value)} disabled={budget.busy || budget.retryPending} />
          <Label htmlFor="provider-model">Model to fund</Label><select id="provider-model" required value={model} onChange={event => setModel(event.target.value)} disabled={budget.busy || budget.retryPending}><option value="">Choose a model</option>{status.data?.availableModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <p className="field-hint">This authorization is for the exact model you choose. The planned project lead is a separate role.</p>
          <Button type="submit" className="w-full" disabled={budget.busy || (!budget.retryPending && (!model || Number(limit) < .01 || Number(limit) > 100))}>{budget.busy ? 'Authorizing…' : budget.retryPending ? 'Retry this authorization' : `Authorize $${limit} budget`}</Button>
        </form>
        <Button variant="ghost" size="sm" onClick={() => void disconnect()}><Unplug />Disconnect OpenRouter</Button>
      </>}
    {error || budget.error ? <p className="action-error" role="alert">{error || budget.error}</p> : null}
    {status.error ? <div className="provider-availability" role="status"><p>We couldn’t check your OpenRouter connection. Your agent can still contribute.</p><Button variant="outline" size="sm" onClick={status.reload}>Check connection again</Button></div> : null}
    {notice ? <p className="provider-notice" role="status">{notice}</p> : null}
    {status.data?.budgets.length ? <div className="provider-budget-receipts"><h4>Your project authorizations</h4>{status.data.budgets.map(item => <div key={item.id} className="provider-budget-receipt"><strong>${item.limitUsd} <span>{item.status === 'ACTIVE' ? 'Active' : item.status === 'REVOKED' ? 'Ended' : 'Authorized'}</span></strong><span className="budget-model">{item.model}</span>{item.status === 'REVOKED' ? <p>No new spending is permitted.</p> : !item.run ? <p>{readiness[item.readiness]}</p> : null}{item.run ? <RunBudgetReceipt run={item.run} /> : <FundedAttempt budget={item} readiness={runReadiness.error ? null : runReadiness.data} />}</div>)}</div> : null}
    <p className="provider-limit-note">Connecting does not start a run. The first funded run still requires its verified model route and work assignment. Your agent can contribute with its own resources now.</p>
  </section>;
}
