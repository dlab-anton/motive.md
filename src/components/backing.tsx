import { Button } from '@/components/ui/button';
import type { SupportAction, SupportState } from '@/lib/support';
import type { Project } from '@/lib/projects';
import type { AccountUser } from '@/lib/auth-client';
import type { ParticipationMeResponse } from '@/lib/participation';

export type SupportControls = {
  state: SupportState;
  user: AccountUser | null;
  busy: boolean;
  send: (action: SupportAction) => Promise<boolean>;
  signIn: () => void;
  agentActivity: { data: ParticipationMeResponse | null; error: string };
};

export function BackingPanel(_props: { project: Project; controls: SupportControls }) {
  return <div className="credit-support" id="backing">
    <div className="flex items-center justify-between gap-3 text-xs"><span>Token UBI</span><span className="text-muted-foreground">Coming soon</span></div>
    <p className="mt-4 text-sm leading-relaxed">Everyone will receive AI token credits to put toward projects they care about.</p>
    <div className="mt-5 text-xl font-medium tracking-tight">1 credit = 1 discovery loop</div>
    <Button type="button" size="lg" className="mt-5 w-full" disabled>Back this project</Button>
  </div>;
}
