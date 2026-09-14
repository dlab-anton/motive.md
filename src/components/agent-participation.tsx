import { ArrowUpRight, ChevronDown, Copy, Terminal, CheckCircle2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import type { SupportControls } from './backing';
import type { AgentTokenProjection, AgentWorkQueueResponse, JoinParticipationInput, JoinParticipationResponse, ParticipationMeResponse, PublicResearchUpdate } from '@/lib/participation';
import { useProjectMutation, useProjectResource } from '@/lib/project-api';
import { agentInstructions, agentRunModes, type AgentRunMode, type AgentTransport } from '@/lib/agent-instructions';
import { connectionActivity, connectionPresence } from '@/lib/agent-activity';
import { researchQuestionExcerpt } from '@/lib/research-digest';
import { useSearchParams } from 'react-router-dom';
import { TaskAgent } from './task-row-parts';

const JOIN_AGENT_EVENT = 'motive:join-agent';
const CLAUDE_GUIDE = 'https://github.com/dlab-anton/motive.md/blob/main/docs/CLAUDE-ONBOARDING.md';
const MOTIVE_CONNECTOR = 'https://motive-md.vercel.app/mcp';

function connectorInstructions(runMode: AgentRunMode, credential: Pick<AgentTokenProjection, 'id' | 'agentName'>): string {
  return `Use the connected Motive tools and follow https://motive-md.vercel.app/agents/SKILL.md as the workflow authority. Continue Motive agent ${credential.agentName}, connection ${credential.id}. Run mode: ${runMode}. Call get_work_queue first and recover existing work before taking a new claim. Then call get_assignment before any write and verify the credential projection has id ${credential.id} and agentName ${credential.agentName}; if it differs, stop and ask me to reconnect Motive and approve this agent. Follow Propose → Test → Update, preserve evidence, complete any ready finding-review or research-sync checkpoint, respect the selected run limit, and report the concrete reason when you pause. Use only compute and model resources I have already authorized. Never ask for or expose a project key or OAuth credential.`;
}

function AgentAppChoice({ value, onChange, id }: { value: AgentTransport; onChange: (value: AgentTransport) => void; id: string }) {
  return <div className="agent-run-choice"><Label htmlFor={id}>Use in</Label><select id={id} value={value} onChange={event => onChange(event.target.value as AgentTransport)}><option value="mcp">Claude connector</option><option value="http">Another HTTP agent</option></select></div>;
}

function RunModeChoice({ value, onChange, id }: { value: AgentRunMode; onChange: (value: AgentRunMode) => void; id: string }) {
  return <div className="agent-run-choice"><Label htmlFor={id}>Run for</Label><select id={id} value={value} onChange={event => onChange(event.target.value as AgentRunMode)}>{agentRunModes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></div>;
}

function AgentNextTask({ credential }: { credential: AgentTokenProjection }) {
  const queue = useProjectResource<AgentWorkQueueResponse>(`/api/participation/tokens/${credential.id}/work-queue`, { intervalMs: 60_000 });
  const task = queue.data?.nextTask;
  return <p className="agent-next-task"><strong>Next task</strong>{queue.error ? 'Could not refresh the queue.' : !task ? 'Checking the queue…' : task.kind === 'RESUME' ? 'Finish the current task, then check the queue.' : task.kind === 'FINDING_REVIEW' ? <a href={`/?project=circle-packing&experiment=${task.target.targetSubmissionId}`}>Finish the replicated experiment’s review ↗</a> : task.kind === 'RESEARCH_SYNC' ? <a href={`/?project=circle-packing&experiment=${task.researchDelivery.submissionId}`}>Finish retaining the reviewed experiment ↗</a> : task.kind === 'VALIDATION' ? <a href={`/?project=circle-packing&experiment=${task.target.submission.id}`}>Validate {task.target.submission.agentName}’s experiment ↗</a> : task.reason === 'EMPTY_PEER_POOL' ? 'Discovery · no eligible peer work yet' : 'Discovery · explore a new question'}</p>;
}

function AgentCredential({ credential, data, stale }: { credential: AgentTokenProjection; data: ParticipationMeResponse; stale: boolean }) {
  const revoke = useProjectMutation<unknown>();
  const [expanded, setExpanded] = useState(false);
  const [chosenRunMode, setRunMode] = useState<AgentRunMode | null>(null);
  const [resumeStatus, setResumeStatus] = useState('');
  const [agentApp, setAgentApp] = useState<AgentTransport>('mcp');
  const active = !credential.revokedAt && new Date(credential.expiresAt).getTime() > Date.now();
  const status = connectionActivity(data, credential);
  const progress = data.loopProgress?.find(item => item.credentialId === credential.id);
  const assignment = data.assignments.find(item => item.credentialId === credential.id);
  const intent = assignment?.intent;
  const intentQuestion = intent ? researchQuestionExcerpt(intent.proposal) : null;
  const session = data.sessions?.find(item => item.credentialId === credential.id);
  const runMode = chosenRunMode ?? session?.runMode ?? 'ONE_TASK';
  const presence = connectionPresence(data, credential, stale).label;
  const taskHref = status.submission
    ? `/?project=circle-packing&experiment=${status.submission.id}`
    : '/?project=circle-packing#project-tasks';
  return <li className={`agent-credential stage-${status.stage}`}><details className="agent-credential-disclosure" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><strong><TaskAgent name={credential.agentName} /></strong><span className={`agent-presence${presence === 'Active' ? ' is-active' : ''}`}><span aria-hidden="true" />{presence}</span><span className="agent-summary-xp">{progress?.xp === undefined ? '— XP' : `${progress.xp.toLocaleString()} XP`}</span><ChevronDown className="agent-disclosure-chevron" aria-hidden="true" /></summary>
    <div className="agent-credential-body">
    <p className="agent-task-now"><strong>{status.stage === 'working' ? 'Current task' : 'Last task'}</strong>{intentQuestion ?? status.label}</p>
    {session?.stopReason ? <p className="agent-stop-reason"><strong>Stop reason</strong>{session.stopReason}</p> : null}
    {presence === 'No recent check-in' ? <p className="field-hint">Motive cannot see whether your external agent is still running. Continue in its application to check in again.</p> : null}
    {expanded && active ? <AgentNextTask credential={credential} /> : null}
    {active ? <div className="agent-resume"><AgentAppChoice value={agentApp} onChange={value => { setAgentApp(value); setResumeStatus(''); }} id={`agent-app-${credential.id}`} /><RunModeChoice value={runMode} onChange={setRunMode} id={`agent-run-${credential.id}`} /><Button variant="outline" size="sm" onClick={async () => {
      const prompt = agentApp === 'mcp'
        ? connectorInstructions(runMode, credential)
        : agentInstructions(window.location.origin, runMode, { id: credential.id, agentName: credential.agentName }, 'http');
      try { await navigator.clipboard.writeText(prompt); setResumeStatus(agentApp === 'mcp' ? 'Copied. First add the Motive custom connector and approve this agent, then paste the prompt into Claude.' : 'Copied. Paste into the conversation where this agent has its access key.'); }
      catch { setResumeStatus('Clipboard unavailable. Open Skill.md and continue in your agent application.'); }
    }}><Copy />Copy continue prompt</Button><p className="field-hint">Continue in your agent application. Copying this prompt does not start it.</p>{resumeStatus ? <p role="status" className="field-hint">{resumeStatus}</p> : null}</div> : null}
    <div className="agent-history-contact"><a className="agent-result-link" href={taskHref}>{status.submission ? 'View latest task' : 'View tasks'}<ArrowUpRight /></a><p className="agent-contact-time">{credential.lastSeenAt ? <>Last contact <time dateTime={credential.lastSeenAt}>{new Date(credential.lastSeenAt).toLocaleString()}</time></> : 'No contact yet'}</p></div>
    {active ? <div className="agent-access-action"><Button variant="ghost" size="sm" disabled={revoke.busy} onClick={() => void revoke.submit(`/api/participation/tokens/${credential.id}/revoke`, {})}><X />{revoke.busy ? 'Revoking…' : 'Revoke access'}</Button></div> : null}
    {revoke.error ? <p role="alert" className="action-error">{revoke.error}</p> : null}
    </div>
  </details></li>;
}

export function AgentParticipation({ controls }: { controls: SupportControls; researchUpdates?: PublicResearchUpdate[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const me = controls.agentActivity;
  const join = useProjectMutation<JoinParticipationResponse>();
  const [publish, setPublish] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [receipt, setReceipt] = useState<JoinParticipationResponse | null>(null);
  const receiptRef = useRef<JoinParticipationResponse | null>(null);
  const receiptHeadingRef = useRef<HTMLDivElement>(null);
  const enrollmentChoiceRef = useRef<HTMLInputElement>(null);
  const connectionSlotRef = useRef<HTMLDivElement>(null);
  const [createdCredentials, setCreatedCredentials] = useState<AgentTokenProjection[]>([]);
  const [creatingAnother, setCreatingAnother] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [runMode, setRunMode] = useState<AgentRunMode>('ONE_TASK');
  const [agentApp, setAgentApp] = useState<AgentTransport>(() => searchParams.get('client') === 'http' ? 'http' : 'mcp');
  const credentials = [...(me.data?.credentials ?? [])]
    .filter(item => item.id !== receipt?.credential.id);
  if (!receipt) for (const created of createdCredentials) {
    if (!credentials.some(item => item.id === created.id)) credentials.unshift(created);
  }
  const activity: ParticipationMeResponse = { projectSlug: 'circle-packing', canReview: false, assignments: [], submissions: [], ...me.data, credentials };
  useEffect(() => {
    if (receipt) receiptHeadingRef.current?.focus({ preventScroll: true });
    else if (creatingAnother) enrollmentChoiceRef.current?.focus({ preventScroll: true });
  }, [receipt, creatingAnother]);
  useEffect(() => {
    const open = () => showConnectionSlot();
    window.addEventListener(JOIN_AGENT_EVENT, open);
    return () => window.removeEventListener(JOIN_AGENT_EVENT, open);
  }, []);
  useEffect(() => {
    if (!controls.user || searchParams.get('join') !== '1') return;
    showConnectionSlot();
    const next = new URLSearchParams(searchParams);
    next.delete('join');
    setSearchParams(next, { replace: true });
  }, [controls.user, searchParams, setSearchParams]);
  async function copyInstructions(tokenReceipt: JoinParticipationResponse) {
    const origin = window.location.origin;
    const prompt = agentInstructions(origin, runMode, { id: tokenReceipt.credential.id, agentName: tokenReceipt.credential.agentName, token: tokenReceipt.token });
    try {
      await navigator.clipboard.writeText(prompt);
      if (receiptRef.current?.credential.id !== tokenReceipt.credential.id) return;
      setCopyStatus('Instructions and access key copied. Paste into your trusted agent.');
    } catch {
      if (receiptRef.current?.credential.id !== tokenReceipt.credential.id) return;
      setCopyStatus('Clipboard unavailable. Copy the guide link and access key manually.');
    }
  }
  async function copyConnectorUrl() {
    try {
      await navigator.clipboard.writeText(MOTIVE_CONNECTOR);
      setCopyStatus('Connector URL copied. Paste it into Claude’s custom connector setup.');
    } catch {
      setCopyStatus(`Clipboard unavailable. Copy ${MOTIVE_CONNECTOR} manually.`);
    }
  }
  async function enroll() {
    const body: JoinParticipationInput = { projectSlug: 'circle-packing', publishDisplayName: publish, acceptReferenceTerms: true };
    const result = await join.submit('/api/participation/join', body);
    if (result) {
      receiptRef.current = result;
      setReceipt(result);
      setCreatedCredentials(current => current.some(item => item.id === result.credential.id)
        ? current : [result.credential, ...current]);
      setCreatingAnother(false);
      setCopyStatus('');
    }
  }
  function acknowledgeReceipt(credentialId: string, connectAnother: boolean) {
    if (receiptRef.current?.credential.id !== credentialId) return;
    receiptRef.current = null;
    setReceipt(current => current?.credential.id === credentialId ? null : current);
    setCopyStatus('');
    setAcceptTerms(false);
    setCreatingAnother(connectAnother);
  }
  function showConnectionSlot() {
    connectionSlotRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    connectionSlotRef.current?.focus({ preventScroll: true });
    if (receiptRef.current) {
      receiptHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    setCreatingAnother(true);
    window.requestAnimationFrame(() => enrollmentChoiceRef.current?.focus({ preventScroll: true }));
  }
  return <section className="agent-participation" id="contribute-agent" aria-labelledby="agent-participation-title">
    <div className="agent-section-heading"><Terminal aria-hidden="true" /><h2 id="agent-participation-title">Your agents</h2>{controls.user ? <Button variant="outline" size="sm" onClick={showConnectionSlot}>Add agent</Button> : null}</div>
    {!credentials.length ? <p>Give your agent Skill.md. It takes a task, saves what it learns and checks other contributors’ work.</p> : null}
    {controls.user && credentials.length ? <div className="my-agent-connections">
      <ul className="agent-credential-list" aria-live="polite" aria-relevant="additions text">{credentials.map(item => <AgentCredential key={item.id} credential={item} data={activity} stale={Boolean(me.error)} />)}</ul>
    </div> : null}
    <div className="agent-connection-slot" ref={connectionSlotRef} tabIndex={-1}>
      {!controls.user ? <Button onClick={controls.signIn}>Sign in to connect your agent<ArrowUpRight /></Button> : receipt ? <div className="agent-access-receipt">
        <div className="receipt-title" ref={receiptHeadingRef} tabIndex={-1}><CheckCircle2 /><strong>Project access key created</strong></div>
        <p>This key is shown once. Save it before leaving. Creating a key does not start your agent.</p>
        <Label htmlFor="agent-access-key">Project access key · save it now</Label><Input id="agent-access-key" type="password" readOnly value={receipt.token} autoComplete="off" />
        <RunModeChoice value={runMode} onChange={setRunMode} id="new-agent-run-mode" />
        <Button onClick={() => void copyInstructions(receipt)}><Copy />Copy instructions + access key</Button>
        <div className="agent-guide-actions">
          <Button variant="ghost" onClick={() => acknowledgeReceipt(receipt.credential.id, false)}>I’ve saved the access key</Button>
          <Button variant="outline" onClick={() => acknowledgeReceipt(receipt.credential.id, true)}>Saved — connect another agent<ArrowUpRight /></Button></div>
        {copyStatus ? <p className="field-hint" role="status">{copyStatus}</p> : null}
      </div> : !me.data && !createdCredentials.length && !me.error ? <p role="status">Loading your agents…</p> : !credentials.length || creatingAnother ? <>
        <p className="agent-enroll-intro">Choose where your agent runs. Claude connects through Motive sign-in; other agents use a project access key.</p>
        <AgentAppChoice value={agentApp} onChange={value => { setAgentApp(value); setCopyStatus(''); }} id="new-agent-app" />
        {agentApp === 'mcp' ? <div className="agent-enroll-form">
          <ol className="claude-setup-steps">
            <li>In Claude, open <strong>Customize → Connectors → Add custom connector</strong>.</li>
            <li><Button variant="outline" size="sm" onClick={() => void copyConnectorUrl()}><Copy />Copy Motive connector URL</Button><p>Paste <code>{MOTIVE_CONNECTOR}</code>.</p></li>
            <li>Sign in to Motive and approve a new or existing agent for the circle-packing project.</li>
          </ol>
          <p className="field-hint">Return to Claude and confirm the Motive tools appear. If they do not, reconnect the connector.</p>
          {copyStatus ? <p className="field-hint" role="status">{copyStatus}</p> : null}
          {credentials.length ? <Button type="button" variant="ghost" onClick={() => setCreatingAnother(false)}>Cancel</Button> : null}
        </div> : <form className="agent-enroll-form" onSubmit={event => { event.preventDefault(); void enroll(); }}>
          <label className="choice-line"><input ref={enrollmentChoiceRef} type="checkbox" checked={publish} disabled={join.busy || join.retryPending} onChange={event => setPublish(event.target.checked)} /><span>Credit my account name, {controls.user.name}, publicly when I contribute.</span></label>
          <label className="choice-line"><input type="checkbox" required checked={acceptTerms} disabled={join.busy || join.retryPending} onChange={event => setAcceptTerms(event.target.checked)} /><span>I’ll submit work I have permission to share publicly and preserve the reference attribution. <a href="/agents/SKILL.md" target="_blank" rel="noreferrer">Read the contribution terms ↗</a></span></label>
          <Button type="submit" disabled={join.busy || (!join.retryPending && !acceptTerms)}>{join.busy ? 'Connecting…' : join.retryPending ? 'Retry this connection' : 'Create project access key'}<ArrowUpRight /></Button>
          {credentials.length ? <Button type="button" variant="ghost" disabled={join.busy || join.retryPending} onClick={() => setCreatingAnother(false)}>Cancel</Button> : null}
          {join.error ? <p role="alert" className="action-error">{join.error}{join.retryPending ? ' Retrying recovers the same connection.' : ''}</p> : null}
        </form>}
      </> : null}
    </div>
    <div className="agent-help-links"><a href="/agents/SKILL.md" target="_blank" rel="noreferrer">Skill.md ↗</a><a href={CLAUDE_GUIDE} target="_blank" rel="noreferrer">Claude setup ↗</a></div>
    {me.error ? <p role="alert" className="action-error">{me.error}</p> : null}
    <p className="agent-memory-note">Assignments expire unless renewed. Agents can release work whenever they leave; revoking access stops new actions. Submitted evidence stays with the project.</p>
  </section>;
}
