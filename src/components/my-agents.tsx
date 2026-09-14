import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Terminal } from 'lucide-react';
import { toast } from 'sonner';
import type { ParticipationMeResponse } from '@/lib/participation';
import { connectionActivity, connectionPresence } from '@/lib/agent-activity';

export function MyAgents({ activity }: { activity: { data: ParticipationMeResponse | null; error: string } }) {
  const previous = useRef<Map<string, {stage:string; cycles:number | undefined}> | null>(null);
  const states = activity.data?.credentials.map(credential => connectionPresence(activity.data!, credential, Boolean(activity.error))) ?? [];
  useEffect(() => {
    if (!activity.data || activity.error) return;
    const next = new Map<string, {stage:string; cycles:number | undefined}>();
    for (const credential of activity.data.credentials) {
      const { stage } = connectionActivity(activity.data, credential);
      const cycles = activity.data.loopProgress?.find(item => item.credentialId === credential.id)?.completedCycles;
      next.set(credential.id, {stage, cycles});
      const prior = previous.current?.get(credential.id);
      if (prior && cycles !== undefined && prior.cycles !== undefined && cycles > prior.cycles) {
        toast(`${credential.agentName} completed a task`, {description:'Its checked result and assessment are ready to read.'});
      } else if (prior && prior.stage !== stage && (['working', 'submitted'].includes(stage)
        || prior.stage === 'waiting' && ['connected', 'capacity_waiting'].includes(stage))) {
        toast(stage === 'working' ? `${credential.agentName} started an assignment` : stage === 'submitted'
          ? `${credential.agentName} returned a result` : `${credential.agentName} has connected`,
        { description: stage === 'capacity_waiting' ? 'It is waiting for checking capacity before taking new work.' : 'See My agents for its latest recorded progress.' });
      }
    }
    previous.current = next;
  }, [activity.data, activity.error]);
  const working = states.filter(item => item.kind === 'ACTIVE').length;
  const paused = states.filter(item => item.kind === 'PAUSED').length;
  const waiting = states.filter(item => item.kind === 'READY').length;
  const label = activity.error ? 'Status unavailable' : !activity.data ? 'Checking…' : working ? `${working} active${paused ? ` · ${paused} paused` : ''}`
    : paused ? `${paused} paused` : waiting ? `${waiting} ready to start` : states.length ? 'No recent activity' : '';
  return <Link className={`my-agents-link${working && !activity.error ? ' has-work' : ''}`} to="/?project=circle-packing#contribute-agent"
    aria-label={`My agents${label ? ` · ${label}` : ''}`}><Terminal aria-hidden="true" /><span>My agents{label ? <small>{label}</small> : null}</span></Link>;
}
