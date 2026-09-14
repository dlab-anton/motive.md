import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Settings2, UserRound, Heart } from 'lucide-react';
import { toast } from 'sonner';
import { authClient, type AccountUser } from '@/lib/auth-client';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'M';
export function AccountMenu({ user, onSignIn }: { user: AccountUser | null; onSignIn: () => void }) {
  const navigate = useNavigate();
  async function signOut() {
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || 'Could not sign out.');
      navigate('/'); toast('Signed out', { description: 'Your profile and followed projects are saved.' });
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not sign out. Please try again.'); }
  }
  if (!user) return <Button className="sign-in-trigger" variant="ghost" onClick={onSignIn}>Sign in</Button>;
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="account-trigger" aria-label="Open account menu"><Avatar className="size-8"><AvatarFallback>{initials(user.name)}</AvatarFallback></Avatar></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="account-dropdown"><DropdownMenuLabel><strong>{user.name}</strong><span>{user.email}</span></DropdownMenuLabel><DropdownMenuSeparator />{[[UserRound, 'Your profile', 'profile'], [Heart, 'Following', 'support'], [Settings2, 'Account settings', 'settings']].map(([Icon, label, view]) => { const Glyph = Icon as typeof UserRound; return <DropdownMenuItem asChild key={String(view)}><Link to={`/?view=${view}`}><Glyph />{String(label)}</Link></DropdownMenuItem>; })}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
