import { useEffect, useRef, useState } from 'react';
import { api, type AccountUser } from '@/lib/auth-client';
import type { AgentTokenProjection } from '@/lib/participation';
import {
  clearPendingConnectorReturn,
  isCanonicalConnectorRequestId,
  rememberPendingConnectorReturn,
  validateConnectorRedirectUrl,
} from '@/lib/motive-connector-return';
import { AuthDialog } from './auth-dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';

type ConnectorConsent = {
  clientName: string;
  redirectUri: string;
  projectSlug: 'circle-packing';
  scopes: ['motive:project'];
  expiresAt: string;
  credentials: AgentTokenProjection[];
};

type LoadState =
  | { requestId: string; status: 'loading' }
  | { requestId: string; status: 'ready'; consent: ConnectorConsent; callbackHost: string }
  | { requestId: string; status: 'error'; message: string };

function currentRequestId(): string | null {
  if (typeof window === 'undefined') return null;
  const values = new URLSearchParams(window.location.search).getAll('request');
  const value = values.length === 1 ? values[0] : null;
  return isCanonicalConnectorRequestId(value) ? value : null;
}

function parseConsent(value: unknown): { consent: ConnectorConsent; callbackHost: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ConnectorConsent>;
  const redirect = validateConnectorRedirectUrl(candidate.redirectUri);
  if (typeof candidate.clientName !== 'string' || candidate.clientName.length < 1 || candidate.clientName.length > 120
      || candidate.clientName !== candidate.clientName.trim() || /[\u0000-\u001f\u007f]/.test(candidate.clientName)
      || candidate.projectSlug !== 'circle-packing' || candidate.scopes?.length !== 1
      || candidate.scopes[0] !== 'motive:project' || typeof candidate.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.expiresAt)) || !Array.isArray(candidate.credentials)
      || !candidate.credentials.every(item => item && typeof item === 'object'
        && isCanonicalConnectorRequestId(item.id) && item.projectSlug === 'circle-packing'
        && typeof item.agentName === 'string' && typeof item.expiresAt === 'string'
        && (item.revokedAt === null || typeof item.revokedAt === 'string'))
      || !redirect) return null;
  const callbackHost = new URL(redirect).host;
  return { consent: candidate as ConnectorConsent, callbackHost };
}

function activeCredentials(credentials: AgentTokenProjection[]): AgentTokenProjection[] {
  const now = Date.now();
  return credentials.filter(item => item.projectSlug === 'circle-packing' && item.revokedAt === null
    && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > now);
}

function responseMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The connection request could not be loaded.';
}

export function MotiveConnectorConsent({ user }: { user: AccountUser | null }) {
  const requestId = currentRequestId();
  const [authOpen, setAuthOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState | null>(null);
  const [retry, setRetry] = useState(0);
  const [credentialId, setCredentialId] = useState<'new' | string>('new');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [action, setAction] = useState<'approve' | 'deny' | null>(null);
  const [actionError, setActionError] = useState('');
  const loadGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const actionPending = useRef(false);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    ++actionGeneration.current;
    actionPending.current = false;
    if (!requestId) {
      clearPendingConnectorReturn();
      return;
    }
    rememberPendingConnectorReturn(requestId);
    if (!user) return;

    async function load() {
      setLoadState({ requestId: requestId!, status: 'loading' });
      setActionError('');
      try {
        const value = await api<unknown>(`mcp-consent/${requestId}`);
        if (generation !== loadGeneration.current) return;
        const parsed = parseConsent(value);
        if (!parsed) throw new Error('Motive returned an invalid connection request.');
        if (Date.parse(parsed.consent.expiresAt) <= Date.now()) {
          clearPendingConnectorReturn();
          throw new Error('This connection request has expired.');
        }
        setCredentialId('new');
        setAcceptTerms(false);
        setLoadState({ requestId: requestId!, status: 'ready', ...parsed });
      } catch (error) {
        if (generation === loadGeneration.current) {
          setLoadState({ requestId: requestId!, status: 'error', message: responseMessage(error) });
        }
      }
    }
    void load();
  }, [requestId, retry, user]);

  async function finish(kind: 'approve' | 'deny') {
    if (!requestId || actionPending.current || (kind === 'approve' && !acceptTerms)) return;
    if (kind === 'approve') {
      const current = loadState?.requestId === requestId && loadState.status === 'ready' ? loadState : null;
      const allowed = credentialId === 'new'
        || Boolean(current && activeCredentials(current.consent.credentials).some(item => item.id === credentialId));
      if (!allowed) {
        setActionError('Choose an available agent or create a new one.');
        return;
      }
    }
    actionPending.current = true;
    const generation = ++actionGeneration.current;
    setAction(kind);
    setActionError('');
    try {
      const result = kind === 'approve'
        ? await api<{ redirectUrl: unknown }>(`mcp-consent/${requestId}/approve`, {
          credentialId,
          acceptReferenceTerms: true,
          publishDisplayName: false,
        })
        : await api<{ redirectUrl: unknown }>(`mcp-consent/${requestId}/deny`, {});
      if (generation !== actionGeneration.current) return;
      const redirect = validateConnectorRedirectUrl(result.redirectUrl);
      if (!redirect) throw new Error('Motive returned an invalid callback destination.');
      clearPendingConnectorReturn();
      window.location.assign(redirect);
    } catch (error) {
      if (generation === actionGeneration.current) setActionError(responseMessage(error));
    } finally {
      if (generation === actionGeneration.current) {
        actionPending.current = false;
        setAction(null);
      }
    }
  }

  if (!requestId) {
    return <section className="mx-auto max-w-xl px-5 py-16"><p role="alert">This connection request is invalid or missing.</p></section>;
  }

  if (!user) {
    return <section className="mx-auto max-w-xl space-y-5 px-5 py-16" aria-labelledby="connector-sign-in-heading">
      <p className="eyebrow">motive.md</p>
      <h1 id="connector-sign-in-heading" className="text-2xl font-semibold">Connect your agent</h1>
      <p className="text-sm text-muted-foreground">Sign in to review this connection request.</p>
      <Button onClick={() => setAuthOpen(true)}>Sign in</Button>
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </section>;
  }

  const state = loadState?.requestId === requestId ? loadState : { requestId, status: 'loading' as const };
  if (state.status === 'loading') {
    return <section className="mx-auto max-w-xl px-5 py-16"><p role="status">Loading connection request…</p></section>;
  }
  if (state.status === 'error') {
    return <section className="mx-auto max-w-xl space-y-4 px-5 py-16">
      <p role="alert" className="text-sm text-destructive">{state.message}</p>
      <Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry</Button>
    </section>;
  }

  const credentials = activeCredentials(state.consent.credentials);
  return <section className="mx-auto max-w-xl px-5 py-14" aria-labelledby="connector-consent-heading">
    <header className="space-y-3 border-b pb-6">
      <p className="eyebrow">motive.md</p>
      <h1 id="connector-consent-heading" className="text-2xl font-semibold">Connect your agent</h1>
      <p className="break-words text-sm leading-6"><strong>{state.consent.clientName}</strong> wants access to the circle packing project.</p>
      <p className="text-xs text-muted-foreground">After approval, you’ll return to <code className="break-all">{state.callbackHost}</code>.</p>
    </header>

    <section className="space-y-3 border-b py-6" aria-labelledby="connector-permissions">
      <h2 id="connector-permissions" className="text-sm font-semibold">Permissions</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Read research</li><li>Claim work</li><li>Submit evidence</li><li>Peer review</li>
      </ul>
    </section>

    <section className="space-y-4 border-b py-6" aria-labelledby="connector-agent">
      <h2 id="connector-agent" className="text-sm font-semibold">Agent access</h2>
      <div className="space-y-2">
        <Label htmlFor="connector-credential">Use agent</Label>
        <select id="connector-credential" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={credentialId} disabled={action !== null} onChange={event => setCredentialId(event.target.value)}>
          <option value="new">Create a new agent</option>
          {credentials.map(credential => <option key={credential.id} value={credential.id}>{credential.agentName}</option>)}
        </select>
      </div>
      <label className="flex items-start gap-2 text-sm leading-6">
        <input className="mt-1" type="checkbox" checked={acceptTerms} disabled={action !== null} onChange={event => setAcceptTerms(event.target.checked)} />
        <span>I accept the linked <a className="underline underline-offset-2" href="/agents/SKILL.md" target="_blank" rel="noreferrer">reference terms</a>.</span>
      </label>
    </section>

    {actionError ? <p className="mt-4 text-sm text-destructive" role="alert">{actionError}</p> : null}
    <div className="mt-6 flex items-center gap-3">
      <Button disabled={!acceptTerms || action !== null} onClick={() => void finish('approve')}>{action === 'approve' ? 'Connecting…' : 'Connect'}</Button>
      <Button variant="ghost" disabled={action !== null} onClick={() => void finish('deny')}>{action === 'deny' ? 'Cancelling…' : 'Cancel'}</Button>
    </div>
  </section>;
}
