import { useEffect, useState, type ComponentType } from 'react';
import { CheckCircle2, Circle, Clock3, OctagonX } from 'lucide-react';
import type { ParticipationPublicProjection, PublicPostCheckAssessment } from '@/lib/participation';

export type TaskStatusKind = 'complete' | 'needs-update' | 'in-progress' | 'stopped';

const statusDetails: Record<TaskStatusKind, { label: string; className: string; icon: ComponentType<{ 'aria-hidden'?: boolean }> }> = {
  complete: { label: 'Complete', className: 'is-complete', icon: CheckCircle2 },
  'needs-update': { label: 'Needs update', className: 'needs-update', icon: Clock3 },
  'in-progress': { label: 'In progress', className: 'is-progress', icon: Circle },
  stopped: { label: 'Stopped', className: 'is-stopped', icon: OctagonX },
};

export function TaskStatusIcon({ kind }: { kind: TaskStatusKind }) {
  const status = statusDetails[kind];
  const Icon = status.icon;
  return <span className={`task-status task-status-icon ${status.className}`} role="img" aria-label={status.label} title={status.label}>
    <Icon aria-hidden={true} />
  </span>;
}

export function agentInitials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2)).toUpperCase();
}

export function TaskAgent({ name }: { name: string }) {
  return <span className="task-agent" title={name}><span className="task-agent-avatar" aria-hidden="true">{agentInitials(name)}</span>
    <span className="task-agent-name">{name}</span></span>;
}

export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function relativeTaskTime(value: string, now: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  const delta = now - timestamp;
  const future = delta < -30_000;
  const elapsed = Math.abs(delta);
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.max(1, Math.floor(elapsed / 60_000));
  const amount = minutes < 60 ? minutes : minutes < 1_440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1_440);
  const unit = minutes < 60 ? 'min' : minutes < 1_440 ? 'hr' : 'day';
  return future ? `in ${amount} ${unit}${unit === 'day' && amount !== 1 ? 's' : ''}` : `${amount} ${unit}${unit === 'day' && amount !== 1 ? 's' : ''} ago`;
}

export function TaskTime({ value, now }: { value: string; now: number }) {
  const timestamp = Date.parse(value);
  const valid = Number.isFinite(timestamp);
  return <time className="task-time" dateTime={value} title={valid ? new Date(timestamp).toLocaleString() : 'Time unavailable'}>{relativeTaskTime(value, now)}</time>;
}

export function QueueNext() {
  return <span className="task-next task-next-queue"><span className="task-next-label">Next queue</span>
    <span>The queue assigns research, independent review or shared-memory follow-up.</span></span>;
}

function concise(value: string) {
  const text = value.trim().replace(/\s+/gu, ' ');
  return text.length <= 180 ? text : `${text.slice(0, 177).trimEnd()}…`;
}

function SuggestedNext({ href, submissionId, reportDigest }: { href: string | null; submissionId: string; reportDigest: string }) {
  const [record, setRecord] = useState<{ href: string; nextAction?: string; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!href) return;
    const controller = new AbortController();
    void fetch(href, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      credentials: 'same-origin', redirect: 'error' }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      const value = await response.json() as Partial<PublicPostCheckAssessment>;
      if (value.format !== 'motive.post-check-assessment.public.v1' || value.submissionId !== submissionId
        || value.reportDigest !== reportDigest || typeof value.nextAction !== 'string') throw new Error('Invalid retained recommendation');
      if (!controller.signal.aborted) setRecord({ href, nextAction: value.nextAction.trim() ? value.nextAction : undefined });
    }).catch(() => { if (!controller.signal.aborted) setRecord({ href, failed: true }); });
    return () => controller.abort();
  }, [href, reportDigest, submissionId]);
  if (!href || record?.href === href && (record.failed || !record.nextAction)) return <QueueNext />;
  if (record?.href !== href) return <span className="task-next"><span className="task-next-label">Suggested next</span><span>Checking saved recommendation…</span></span>;
  return <span className="task-next"><span className="task-next-label">Suggested next</span>
    <a href={href} target="_blank" rel="noreferrer">{concise(record.nextAction!)}</a></span>;
}

/** One project-level recommendation. Task rows stay bounded and do not each fetch a narrative. */
export function ProjectNextWork({ data }: { data: ParticipationPublicProjection | null }) {
  const submissions = new Map(data?.submissions.map(item => [item.id, item]));
  const latest = (data?.researchUpdates ?? []).reduce<NonNullable<ParticipationPublicProjection['researchUpdates']>[number] | null>((selected, update) => {
    const submission = submissions.get(update.submissionId);
    if (!submission?.postCheckAssessmentHref) return selected;
    return !selected || Date.parse(update.createdAt) > Date.parse(selected.createdAt) ? update : selected;
  }, null);
  const submission = latest ? submissions.get(latest.submissionId) : null;
  const recommendationTime = latest ? Date.parse(latest.createdAt) : Number.NaN;
  const superseded = Number.isFinite(recommendationTime) && Boolean(
    data?.activeResearchIntents?.some(intent => Date.parse(intent.expiresAt) > Date.now() && Date.parse(intent.declaredAt) > recommendationTime)
    || data?.recentResearchHandoffs?.some(handoff => Date.parse(handoff.createdAt) > recommendationTime));
  return <section className="project-next-work" aria-labelledby="project-next-work-title"><h3 id="project-next-work-title">Next work</h3>
    {latest && submission && !superseded ? <SuggestedNext href={submission.postCheckAssessmentHref} submissionId={submission.id} reportDigest={latest.reportDigest} /> : <QueueNext />}
  </section>;
}
