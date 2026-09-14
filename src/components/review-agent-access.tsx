import { useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { useProjectMutation, useProjectResource } from '@/lib/project-api';
import type { ResearchAdmissionAgentAccessProjection } from '../../server/research-memory/submission-admission';
import { Button } from './ui/button';

type AccessState = ResearchAdmissionAgentAccessProjection['status'];
type AccessResponse = { access: ResearchAdmissionAgentAccessProjection | null };
type IssuedAccess = { access: ResearchAdmissionAgentAccessProjection; token: string };

export function ReviewAgentAccess({ submissionId, packageDigest, expectedDecisionId, onStateChange }: {
  submissionId: string; packageDigest: string; expectedDecisionId: string | null;
  onStateChange: (status: AccessState | null) => void;
}) {
  const [activated, setActivated] = useState(false);
  useEffect(() => { onStateChange(null); }, [onStateChange]);
  return <details className="review-agent-access" onToggle={event => { if (event.currentTarget.open) setActivated(true); }}>
    <summary><KeyRound aria-hidden="true" />Have my agent review this package</summary>
    {activated ? <ReviewHandoff submissionId={submissionId} packageDigest={packageDigest}
      expectedDecisionId={expectedDecisionId} onStateChange={onStateChange} /> : null}
  </details>;
}

function ReviewHandoff({ submissionId, packageDigest, expectedDecisionId, onStateChange }: {
  submissionId: string; packageDigest: string; expectedDecisionId: string | null;
  onStateChange: (status: AccessState | null) => void;
}) {
  const path = `/api/participation/submissions/${submissionId}/research-admission/agent-access`;
  const resource = useProjectResource<AccessResponse>(path);
  const issue = useProjectMutation<IssuedAccess>();
  const revoke = useProjectMutation<AccessResponse>();
  const [changed, setChanged] = useState<ResearchAdmissionAgentAccessProjection | null>(null);
  const [secret, setSecret] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [needsFreshPackage, setNeedsFreshPackage] = useState(false);
  const observed = resource.data?.access ?? null;
  const newerObserved = observed && changed && observed.id !== changed.id
    && Date.parse(observed.createdAt) >= Date.parse(changed.createdAt);
  const access = newerObserved ? observed : changed && (observed?.id !== changed.id
    || ((changed.status === 'REVOKED' || changed.status === 'CONSUMED') && !observed?.revokedAt && !observed?.consumedAt))
    ? changed : observed ?? changed;
  const status = access?.status ?? null;
  const active = status === 'READY';
  const locked = issue.busy || revoke.busy || revoke.retryPending;

  useEffect(() => { onStateChange(status); }, [onStateChange, status]);
  useEffect(() => { if (status && status !== 'READY') setSecret(null); }, [status]);
  useEffect(() => { if (status === 'STALE') setNeedsFreshPackage(true); }, [status]);

  const guide = `${window.location.origin}/review-agents/SKILL.md`;
  const instructions = secret && access?.id === secret.id && active
    ? `Read ${guide}. Review the one assigned Motive research package and record a scoped shared-memory decision through the documented HTTP API. Use this credential only in the Authorization header for ${window.location.origin}/api/review-agent/:\n${secret.token}\nNever include it in a URL, artifact, repository, review rationale or log. Stop after the decision is confirmed.`
    : null;
  const title = status === 'CONSUMED' ? 'Review decision recorded'
    : status === 'REVOKED' ? 'Review access ended'
      : status === 'EXPIRED' ? 'Review access expired'
        : status === 'STALE' ? 'This handoff needs a fresh review package'
          : access?.firstSeenAt ? 'Agent opened the review' : 'Waiting for your reviewer agent';

  return <div className="review-agent-handoff">
    <p>Your agent can inspect this experiment's cited research snapshots and record one decision on your behalf. Access lasts one hour; snapshot reads end when the decision is recorded. Your account remains responsible for the review.</p>
    <p className="field-hint">This grants review access only. It does not launch an agent, fund its work, accept a packing, or send research to Hypothesis.md.</p>
    {!resource.loaded && !changed ? <p role="status">{resource.error ? 'Review access could not be checked.' : 'Checking review access…'}</p> : null}
    {access ? <div className="review-agent-status" role="status"><strong>{title}</strong>
      {active ? <p>{access.firstSeenAt ? 'The package was opened. The agent has not recorded its decision yet.' : 'Give your agent the instructions below and keep its application running.'} Access ends at {new Date(access.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</p> : null}
      {status === 'CONSUMED' ? <p>The decision and public rationale appear in the review record above. Refresh the package before starting another review.</p> : null}
      {status === 'STALE' ? <p>The evidence or prior decision changed. End this access and refresh the package before delegating again.</p> : null}
    </div> : null}
    {instructions ? <details className="review-agent-instructions" open={!access?.firstSeenAt}>
      <summary>Instructions for your reviewer agent</summary>
      <textarea aria-label="Reviewer agent instructions" readOnly rows={7} value={instructions} spellCheck={false} />
      <Button size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(instructions); setCopied(true); setCopyError(false); }
        catch { setCopyError(true); }
      }}><Copy aria-hidden="true" />{copied ? 'Instructions copied' : 'Copy reviewer instructions'}</Button>
      {copyError ? <p role="status">Select and copy the instructions above.</p> : null}
      <p className="field-hint">The key is shown only here. If you reload before saving it, end this access and create another.</p>
    </details> : active ? <p className="field-hint">Already handed off? Your agent can continue. If you lost the instructions, end this access and create a new handoff.</p> : null}
    <div className="review-agent-actions">
      {!needsFreshPackage && (resource.loaded || changed) && (issue.retryPending || !access || status === 'REVOKED' || status === 'EXPIRED') ? <Button size="sm" disabled={locked} onClick={async () => {
        const result = await issue.submit(path, { packageDigest, expectedDecisionId });
        if (result) { setChanged(result.access); setSecret({ id: result.access.id, token: result.token }); setCopied(false); resource.reload(); }
      }}>{issue.busy ? 'Creating review access…' : issue.retryPending ? 'Recover this handoff' : 'Create one-review access'}</Button> : null}
      {access && (active || status === 'STALE') ? <Button size="sm" variant="outline" disabled={locked || issue.retryPending} onClick={async () => {
        const result = await revoke.submit(`${path}/${access.id}/revoke`, {});
        if (result) { setChanged(result.access); setSecret(null); resource.reload(); }
      }}>{revoke.busy ? 'Ending access…' : revoke.retryPending ? 'Retry ending access' : 'End review access'}</Button> : null}
      <a href={guide} target="_blank" rel="noreferrer">Read the reviewer guide ↗</a>
    </div>
    {needsFreshPackage ? <p className="field-hint">Refresh the review package above before creating another handoff.</p> : null}
    {resource.error ? <p className="field-hint" role="status">Current access status is unavailable. <button type="button" onClick={resource.reload}>Check again</button></p> : null}
    {issue.error || revoke.error ? <p className="action-error" role="alert">{issue.error || revoke.error}</p> : null}
  </div>;
}
