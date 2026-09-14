import { useState } from 'react';
import { GitHubMark } from './github-mark';
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { authClient, useAccountProvider } from '@/lib/auth-client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';


export function AuthDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const account = useAccountProvider();
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [socialBusy, setSocialBusy] = useState(false);
  const signup = mode === 'signup';
  return <Dialog open={open} onOpenChange={value => { if (!busy && !socialBusy) { onOpenChange(value); setError(''); setPassword(''); setVisible(false); if (!value) setConfirmationEmail(''); } }}><DialogContent className="auth-dialog"><DialogHeader><p className="eyebrow">motive.md</p><DialogTitle>{confirmationEmail ? 'Check your email.' : signup ? 'Become part of the work.' : 'Welcome back.'}</DialogTitle><DialogDescription>{confirmationEmail ? 'Confirm your email address to finish joining Motive.' : signup ? 'Create an account to keep your contributions and profile together.' : 'Sign in to the goals you’re helping move forward.'}</DialogDescription></DialogHeader>{confirmationEmail ? <div className="account-form" role="status"><p>Look for a confirmation link at <strong>{confirmationEmail}</strong>. Open it to continue, or return here to sign in after confirming.</p><p className="field-hint">Your 10 welcome Motive credits will be available after you confirm and sign in.</p><Button size="lg" onClick={() => { setConfirmationEmail(''); setMode('signin'); }}>Back to sign in<ArrowRight /></Button></div> : <form className="account-form" onSubmit={async event => {
    event.preventDefault(); if (busy || socialBusy || account.isPending || !account.provider || account.error) return; setBusy(true); setError('');
    try { const result = signup ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password }) : await authClient.signIn.email({ email: email.trim(), password }); if (result.error) setError(result.error.message || 'Please check your details and try again.'); else if (signup && 'requiresEmailConfirmation' in result && result.requiresEmailConfirmation) { setConfirmationEmail(email.trim()); setPassword(''); setVisible(false); } else { setPassword(''); setVisible(false); onOpenChange(false); } }
    catch { setError('The account service is unavailable. Please try again.'); } finally { setBusy(false); }
  }}>
    {account.oauthProviders.includes('github') ? <>
      <Button type="button" size="lg" variant="outline" disabled={busy || socialBusy || account.isPending || Boolean(account.error)} onClick={async () => {
        if (busy || socialBusy) return;
        setSocialBusy(true); setError('');
        try {
          const result = await authClient.signIn.social({ provider: 'github' });
          if (result.error) setError(result.error.message);
        } catch { setError('GitHub sign-in could not be started. Please try again.'); }
        finally { setSocialBusy(false); }
      }}>{socialBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <GitHubMark />}{socialBusy ? 'Connecting to GitHub…' : 'Continue with GitHub'}</Button>
      <div className="auth-divider"><span>or use email</span></div>
    </> : null}
    {signup ? <div className="form-field"><Label htmlFor="account-name">Name</Label><Input id="account-name" autoComplete="name" required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></div> : null}
    <div className="form-field"><Label htmlFor="account-email">Email</Label><Input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></div>
    <div className="form-field"><Label htmlFor="account-password">Password</Label><div className="password-input"><Input id="account-password" type={visible ? 'text' : 'password'} autoComplete={signup ? 'new-password' : 'current-password'} required minLength={signup ? 10 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /><Button type="button" variant="ghost" size="icon" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff /> : <Eye />}</Button></div>{signup ? <p className="field-hint">At least 10 characters.</p> : null}</div>
    {error || account.error ? <p role="alert" className="form-error">{error || 'Sign-in is temporarily unavailable. Please reload to try again.'}</p> : null}
    <Button size="lg" type="submit" disabled={busy || socialBusy || account.isPending || !account.provider || Boolean(account.error) || (signup && !name.trim())}>{busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</Button>
    <p className="auth-switch">{signup ? 'Already have an account?' : 'New to motive.md?'} <Button type="button" variant="link" disabled={busy || socialBusy} onClick={() => { setMode(signup ? 'signin' : 'signup'); setError(''); setPassword(''); setVisible(false); }}>{signup ? 'Sign in' : 'Create account'}</Button></p>
  </form>}<p className="account-local-note">{account.provider === 'supabase' ? 'Every confirmed account starts with 10 Motive credits to support a project. These are community credits; funding AI usage is a separate contribution.' : account.provider === 'local-better-auth' ? 'Your account includes 10 welcome Motive credits, issued once. Accounts are saved on this local instance; email verification and password recovery aren’t connected yet. Guest follows stay in this browser.' : 'Your account keeps your profile and contributions together.'}</p></DialogContent></Dialog>;
}
