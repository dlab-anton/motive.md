import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import { authenticatedFetch } from '@/lib/account-fetch';
import type { ProjectReviewerChange, ProjectReviewers } from '@/lib/project-reviewers';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { accountProjectPath, projectLink, projectWords, publicProjectPath, skillPath, useProjectSlug } from '@/lib/project-slug';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Change = { accountId: string; action: 'GRANT' | 'REMOVE'; key: string };
class AccessError extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

async function request(path: string, signal: AbortSignal, slug: string, change?: Change) {
  let response: Response;
  try {
    response = await authenticatedFetch(`${accountProjectPath(slug, '/reviewers')}${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      ...(change ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': change.key },
        body: JSON.stringify({ accountId: change.accountId }) } : {}),
    });
  } catch { throw new AccessError(change ? 'We couldn’t confirm the change. Retry the same request to recover its result.' : 'Reviewer access couldn’t be loaded. Please try again.', Boolean(change)); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new AccessError('Only a current project owner can manage reviewers. Refresh your account before trying again.');
    if (response.status === 404) throw new AccessError('That account is unavailable. Ask the person to sign in and share their account ID from Settings.');
    if (response.status === 409) throw new AccessError('Access has changed or that account has a protected role. Refresh the list before trying again.');
    throw new AccessError(change ? 'The change could not be confirmed. Retry the same request.' : 'Reviewer access couldn’t be loaded. Please try again.', Boolean(change && response.status >= 500));
  }
  return body;
}

export function ProjectReviewSettings({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!UUID.test(accountId)) return null;
  return <Card className="review-access-settings"><CardHeader><CardTitle>Project review access</CardTitle>
    <p className="muted-copy">Independent reviewers help decide which results the project can rely on.</p></CardHeader>
    <CardContent>
      <Label htmlFor="review-account-id">Your account ID</Label>
      <div className="review-account-copy"><Textarea id="review-account-id" value={accountId} rows={2} readOnly spellCheck={false} />
        <Button variant="outline" type="button" aria-label={copied ? 'Account ID copied' : 'Copy account ID'} onClick={() => {
          void navigator.clipboard.writeText(accountId).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true));
        }}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</Button></div>
      <p className="field-hint">Share this ID with a project owner to request review access. It identifies your account; it isn’t a password or an agent access key.</p>
      {copyError ? <p role="status" className="field-hint">Copy is unavailable in this browser. Select and copy the account ID above.</p> : null}
      {canManage ? <ReviewerOwnerControls key={accountId} accountId={accountId} /> : <p className="field-hint">A project owner grants access. Reviewers can assess other people’s work; they cannot approve their own contributions.</p>}
    </CardContent></Card>;
}

function ReviewerOwnerControls({ accountId }: { accountId: string }) {
  const slug = useProjectSlug();
  const [open, setOpen] = useState(false);
  return <details className="reviewer-owner-controls" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Manage {slug} reviewers</summary>
    {open ? <ReviewerManager key={accountId} ownerAccountId={accountId} /> : null}
  </details>;
}

function ReviewerManager({ ownerAccountId }: { ownerAccountId: string }) {
  const slug = useProjectSlug();
  const [reviewers, setReviewers] = useState<ProjectReviewers | null>(null);
  const [accountId, setAccountId] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState<Change | null>(null);
  const lifetime = useRef(new AbortController());
  const pending = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const validId = UUID.test(accountId) && accountId !== ownerAccountId;

  async function refresh(signal: AbortSignal) {
    reading.current?.abort();
    const read = new AbortController(); reading.current = read;
    const readSignal = AbortSignal.any([signal, read.signal]);
    setLoading(true); setError('');
    try {
      const value = await request('', readSignal, slug) as ProjectReviewers;
      if (value?.format !== 'motive.project-reviewers/0.1' || value.projectSlug !== slug
        || !Array.isArray(value.reviewers) || value.reviewers.length > 100
        || value.reviewers.some(person => !person || typeof person.accountId !== 'string' || !UUID.test(person.accountId))
        || new Set(value.reviewers.map(person => person.accountId)).size !== value.reviewers.length) throw new AccessError('The access list couldn’t be read. Please refresh it.');
      if (!readSignal.aborted) setReviewers(value);
    } catch (caught) { if (!readSignal.aborted) setError(caught instanceof Error ? caught.message : 'Reviewer access couldn’t be loaded.'); }
    finally { if (!readSignal.aborted) { reading.current = null; setLoading(false); } }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  async function changeAccess(change: Change) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const signal = lifetime.current.signal;
    try {
      const value = await request(change.action === 'REMOVE' ? '/remove' : '', signal, slug, change) as ProjectReviewerChange;
      if (value?.format !== 'motive.project-reviewer-change/0.1' || value.projectSlug !== slug
        || value.accountId !== change.accountId || value.action !== change.action
        || typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean') throw new AccessError('The change could not be confirmed. Retry the same request.', true);
      if (!signal.aborted) {
        setRetry(null); setConfirmRemove(null); setAccountId('');
        setNotice(value.replayed ? 'Your earlier request was confirmed. Refresh access to check the latest permissions.' : change.action === 'GRANT' ? 'Review access granted. This person can now open reviews from the project’s Updates tab.' : 'Review access removed. This person can still contribute research.');
        await refresh(signal);
      }
    } catch (caught) {
      if (!signal.aborted) { setError(caught instanceof Error ? caught.message : 'The change could not be confirmed.'); setRetry(caught instanceof AccessError && caught.uncertain ? change : null); }
    } finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  }
  const unavailable = busy || loading || Boolean(retry);
  return <div className="reviewer-manager">
    <p>Give an existing account permission to review other contributors’ results and evidence. Reviewers cannot appoint other reviewers or authorize spending.</p>
    <form className="account-form" onSubmit={event => { event.preventDefault(); if (validId && !unavailable && !error) void changeAccess({ accountId, action: 'GRANT', key: crypto.randomUUID() }); }}>
      <div className="form-field"><Label htmlFor="new-reviewer-account">Reviewer’s account ID</Label>
        <Input id="new-reviewer-account" value={accountId} onChange={event => setAccountId(event.target.value.trim().toLowerCase())} disabled={unavailable} placeholder="Paste account ID" autoComplete="off" spellCheck={false} maxLength={36} />
        <p className="field-hint">{accountId === ownerAccountId ? 'This is your account ID. Ask a different person to share theirs from Settings.' : 'Use the ID they shared with you. Choose someone other than the contributor whose work needs review.'}</p></div>
      <Button type="submit" disabled={!validId || unavailable || Boolean(error)} className="justify-self-start">Add reviewer</Button>
    </form>
    {loading ? <p role="status">Loading reviewer access…</p> : null}
    {notice ? <p role="status" className="reviewer-access-notice">{notice}</p> : null}
    {error ? <p role="status" className="form-error">{error}</p> : null}
    {retry ? <div className="reviewer-retry"><p>A request still needs confirmation. Retrying recovers its original result without applying the change again.</p><Button variant="outline" disabled={busy || loading} onClick={() => void changeAccess(retry)}>Retry same change</Button></div> : null}
    <div className="reviewer-list-heading"><h3>Reviewer accounts</h3><Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void refresh(lifetime.current.signal)}>Refresh access</Button></div>
    {reviewers?.reviewers.length ? <ul className="reviewer-account-list">{reviewers.reviewers.map(person => <li key={person.accountId}>
      <code>{person.accountId}</code>
      {confirmRemove === person.accountId ? <div className="reviewer-remove-confirm"><p>Remove review access? Their reviewer-agent keys will stop working. Research and past reviews will remain.</p>
        <Button variant="outline" disabled={unavailable || Boolean(error)} onClick={() => void changeAccess({ accountId: person.accountId, action: 'REMOVE', key: crypto.randomUUID() })}>Remove review access</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(null)}>Keep access</Button></div>
        : <Button variant="ghost" size="sm" disabled={unavailable || Boolean(error)} onClick={() => setConfirmRemove(person.accountId)}>Remove</Button>}
    </li>)}</ul> : reviewers && !loading ? <p>No reviewer accounts have been appointed yet. Owners and stewards retain their existing review permissions.</p> : null}
    {reviewers?.reviewers.length === 100 ? <p className="field-hint">Showing the first 100 reviewer accounts.</p> : null}
    <Link className="inline-link" to={`${projectLink(slug)}&tab=updates`}>Open {slug} research →</Link>
  </div>;
}
