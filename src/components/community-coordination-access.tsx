import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useProjectMutation, useProjectResource } from '@/lib/project-api';
import type { CommunityCoordinationAccountState, CommunityCoordinationGrant,
  CreateCommunityCoordinationGrantResponse } from '@/lib/community-coordination';
import { Button } from './ui/button';
import { Label } from './ui/label';

const path = '/api/participation/coordination';
const accountPollInterval = (data: CommunityCoordinationAccountState) =>
  data.grants.some(grant => grant.status === 'ACTIVE' || grant.currentTurn?.status === 'ACTIVE') ? 15_000 : 60_000;

export function CommunityCoordinationAccess({ accountId }: { accountId: string }) {
  const resource = useProjectResource<CommunityCoordinationAccountState>(path, { intervalMs: accountPollInterval });
  const create = useProjectMutation<CreateCommunityCoordinationGrantResponse>();
  const [selected, setSelected] = useState('');
  const [maximum, setMaximum] = useState(3);
  const [issued, setIssued] = useState<CommunityCoordinationGrant | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const data = resource.data;
  if (!data) return resource.error ? <p className="field-hint" role="status">Your coordination access could not be checked. <button type="button" onClick={resource.reload}>Try again</button></p> : null;
  if (!data.eligible && data.grants.length === 0) return data.reason === 'NO_ACTIVE_AGENT_TOKEN'
    ? <p className="field-hint"><a href="#contribute-agent">Connect your agent</a> to enable a coordination session.</p>
    : <p className="field-hint">Coordination is open to approved project reviewers. Everyone can <a href="#contribute-agent">contribute an experiment</a>.</p>;
  const grants = issued && !data.grants.some(grant => grant.id === issued.id) ? [issued, ...data.grants] : data.grants;
  const active = grants.filter(grant => grant.status === 'ACTIVE' || grant.currentTurn?.status === 'ACTIVE');
  const recent = active.length ? active : grants.slice(0, 1);
  const tokenId = data.agentTokens.some(token => token.id === selected) ? selected : data.agentTokens[0]?.id ?? '';
  const instructions = `Read ${window.location.origin}/coordination-agents/SKILL.md. Use your existing Motive project access key only in the Authorization header for ${window.location.origin}/api/agent/. Check your coordination session, read relevant Motive and Hypothesis.md evidence, and propose a useful bounded next experiment. Continue while new research is available, your session permits it and your own resources allow it. Honor waiting and lease renewal; release the turn if you leave. Your advice cannot grant permissions, spend project funds or approve findings. Never include the key in notes, files or URLs.`;
  return <details className="community-coordination-access" open={active.length > 0 || Boolean(issued)}>
    <summary>{active.length ? 'Your coordination session' : 'Help coordinate with your agent'}</summary>
    {recent.map(grant => <CoordinationSession key={`${accountId}:${grant.id}`} grant={grant}
      name={data.agentTokens.find(token => token.id === grant.agentTokenId)?.agentName ?? 'Your agent'}
      stale={Boolean(resource.error)} reload={resource.reload} onEnd={() => { if (issued?.id === grant.id) setIssued(null); }} />)}
    {active.length ? <details className="coordination-handoff" open={!active.some(grant => grant.firstSeenAt)}>
      <summary>Instructions for your connected agent</summary>
      <p>Send these to the agent that already has the selected project key. Enabling access does not launch its application.</p>
      <textarea aria-label="Coordinator instructions" readOnly rows={5} value={instructions} />
      <Button size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(instructions); setCopied(true); setCopyFailed(false); }
        catch { setCopyFailed(true); }
      }}><Copy aria-hidden="true" />{copied ? 'Copied' : 'Copy instructions'}</Button>
      {copyFailed ? <p role="status">Select and copy the instructions above.</p> : null}
    </details> : null}
    {!active.length && data.eligible ? <form onSubmit={async event => {
      event.preventDefault(); const result = await create.submit(path, { agentTokenId: tokenId, maxTurns: maximum });
      if (result) { setIssued(result.grant); setCopied(false); resource.reload(); }
    }}>
      {data.agentTokens.length ? <>
        <Label htmlFor="coordinator-connection">Agent connection</Label>
        <select id="coordinator-connection" value={tokenId} disabled={create.busy || create.retryPending} onChange={event => setSelected(event.target.value)}>
          {data.agentTokens.map(token => <option key={token.id} value={token.id}>{token.agentName}</option>)}
        </select>
        <Label htmlFor="coordinator-turns">Maximum coordination turns</Label>
        <select id="coordinator-turns" value={maximum} disabled={create.busy || create.retryPending} onChange={event => setMaximum(Number(event.target.value))}>
          {[1, 3, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? 'turn' : 'turns'}</option>)}
        </select>
        <p>Your agent supplies its own model and compute for up to one hour. Motive does not start paid model work. Your account remains responsible for its suggestions.</p>
        <Button size="sm" type="submit" disabled={create.busy || Boolean(resource.error)}>{create.busy ? 'Enabling coordination…' : create.retryPending ? 'Recover this session' : 'Enable coordination'}</Button>
      </> : <p><a href="#contribute-agent">Connect your agent</a> before enabling a coordination session.</p>}
    </form> : null}
    {create.error ? <p className="action-error" role="alert">{create.error}</p> : null}
    {resource.error ? <p className="field-hint" role="status">Showing your last observed session. <button onClick={resource.reload} type="button">Refresh</button></p> : null}
  </details>;
}

function CoordinationSession({ grant, name, stale, reload, onEnd }: { grant: CommunityCoordinationGrant; name: string;
  stale: boolean; reload: () => void; onEnd: () => void }) {
  const revoke = useProjectMutation<{ grant: CommunityCoordinationGrant }>();
  const active = grant.status === 'ACTIVE' || grant.currentTurn?.status === 'ACTIVE';
  const title = grant.status === 'REVOKED' ? 'Session ended' : grant.status === 'EXPIRED' ? 'Session expired'
    : grant.currentTurn?.status === 'ACTIVE' ? 'Coordination turn reserved'
      : grant.status === 'EXHAUSTED' ? 'Turn limit reached' : grant.firstSeenAt ? 'Between coordination turns' : 'Waiting for your agent';
  return <div className="coordination-session-card">
    <div><strong>{name}</strong><span>{title}</span></div>
    <p>{grant.turnsUsed} of {grant.maxTurns} turns started · {grant.remainingTurns} remaining</p>
    {grant.lastSeenAt ? <p className="field-hint">Last heard <time dateTime={grant.lastSeenAt}>{new Date(grant.lastSeenAt).toLocaleTimeString()}</time>.</p> : null}
    {active ? <p className="field-hint">Session ends {new Date(grant.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Your agent may release its turn and leave earlier.</p> : null}
    {stale ? <p className="field-hint">Current contact could not be refreshed.</p> : null}
    {active ? <Button size="sm" variant="outline" disabled={revoke.busy} onClick={async () => {
      if (await revoke.submit(`${path}/${grant.id}/revoke`, {})) { onEnd(); reload(); }
    }}>{revoke.busy ? 'Ending session…' : revoke.retryPending ? 'Retry ending session' : 'End coordination'}</Button> : null}
    {revoke.error ? <p role="alert" className="action-error">{revoke.error}</p> : null}
  </div>;
}
