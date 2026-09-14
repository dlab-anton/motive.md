import type { AgentSessionProjection, AgentTokenProjection, AssignmentProjection, ParticipationMeResponse, SubmissionSummary } from './participation';

const CONTACT_FRESHNESS_MS = 120_000;
const THIRTY_MINUTE_SESSION_MS = 30 * 60 * 1000;

const CONNECTION_PRESENCE = {
  ACTIVE: { kind: 'ACTIVE', label: 'Active' },
  PAUSED: { kind: 'PAUSED', label: 'Paused' },
  ACCESS_ENDED: { kind: 'ACCESS_ENDED', label: 'Access ended' },
  UNAVAILABLE: { kind: 'UNAVAILABLE', label: 'Status unavailable' },
  RUN_LIMIT_REACHED: { kind: 'RUN_LIMIT_REACHED', label: 'Run limit reached' },
  UNREPORTED: { kind: 'UNREPORTED', label: 'Status not reported' },
  NO_RECENT_CONTACT: { kind: 'NO_RECENT_CONTACT', label: 'No recent check-in' },
  READY: { kind: 'READY', label: 'Ready to start' },
} as const;

export type ConnectionPresence = (typeof CONNECTION_PRESENCE)[keyof typeof CONNECTION_PRESENCE];

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionFor(data: ParticipationMeResponse, credentialId: string): AgentSessionProjection | undefined {
  return data.sessions?.find(item => item.credentialId === credentialId);
}

export function connectionPresence(
  data: ParticipationMeResponse,
  credential: AgentTokenProjection,
  stale = false,
  now = Date.now(),
): ConnectionPresence {
  const session = sessionFor(data, credential.id);
  const expiresAt = timestamp(credential.expiresAt);
  const accessEnded = Boolean(credential.revokedAt) || expiresAt === null || expiresAt <= now
    || session?.accessStatus === 'REVOKED' || session?.accessStatus === 'EXPIRED'
    || session?.presenceReason === 'ACCESS_REVOKED' || session?.presenceReason === 'ACCESS_EXPIRED';
  if (accessEnded) return CONNECTION_PRESENCE.ACCESS_ENDED;
  if (stale) return CONNECTION_PRESENCE.UNAVAILABLE;

  const explicitlyPaused = session?.status === 'PAUSED' && session.presence === 'PAUSED'
    && session.presenceReason === 'EXPLICITLY_PAUSED';
  if (explicitlyPaused) return CONNECTION_PRESENCE.PAUSED;

  const declaredAt = timestamp(session?.declaredAt);
  const localRunLimitReached = session?.status === 'RUNNING' && session.runMode === 'THIRTY_MINUTES'
    && declaredAt !== null && declaredAt <= now && now >= declaredAt + THIRTY_MINUTE_SESSION_MS;
  if (session?.presenceReason === 'RUN_LIMIT_REACHED' || localRunLimitReached) {
    return CONNECTION_PRESENCE.RUN_LIMIT_REACHED;
  }

  const lastContactAt = timestamp(session?.lastContactAt);
  const freshContact = lastContactAt !== null && lastContactAt <= now
    && now - lastContactAt <= CONTACT_FRESHNESS_MS;
  const active = session?.status === 'RUNNING' && session.presence === 'ACTIVE'
    && declaredAt !== null && declaredAt <= now && freshContact;
  if (active) return CONNECTION_PRESENCE.ACTIVE;
  if (freshContact) return CONNECTION_PRESENCE.UNREPORTED;
  if (credential.lastSeenAt || session?.lastContactAt) return CONNECTION_PRESENCE.NO_RECENT_CONTACT;
  return CONNECTION_PRESENCE.READY;
}

export function agentActivity(credential: AgentTokenProjection, assignment?: AssignmentProjection, submission?: SubmissionSummary) {
  if (credential.revokedAt || Date.parse(credential.expiresAt) <= Date.now()) return { stage: 'ended', label: 'Access ended', detail: 'This key no longer allows new actions.' };
  const currentResult = submission && (!assignment || Date.parse(submission.createdAt) >= Date.parse(assignment.createdAt));
  if (currentResult) return { stage: 'submitted', label: assignment?.status === 'COMPLETED' && submission.postCheckAssessmentHref ? 'Cycle recorded' : 'Update · result checked',
    detail: `${submission.reportStatus === 'VALID' ? 'Geometry valid' : submission.reportStatus === 'REJECTED' ? 'Geometry rejected' : 'Check inconclusive'}. ${submission.postCheckAssessmentHref ? 'The agent recorded its assessment and next idea.' : 'Waiting for the agent’s assessment of the check.'} ${submission.acceptance === 'PENDING' ? 'Independent review is pending.' : submission.acceptance === 'ACCEPTED' ? 'Accepted by a reviewer.' : 'Declined by a reviewer.'}` };
  if (assignment?.status === 'ACTIVE' && assignment.expiresAt && Date.parse(assignment.expiresAt) > Date.now()) return { stage: 'working', label: 'Propose / Test · assignment active', detail: 'The agent has reserved a bounded experiment. Its next recorded checkpoint is a checked result.' };
  if (assignment?.status === 'RELEASED') return { stage: 'released', label: 'Assignment released', detail: 'The agent left its assignment. Its project key is still available.' };
  if (assignment?.status === 'EXPIRED' || assignment?.status === 'ACTIVE') return { stage: 'expired', label: 'Assignment expired', detail: 'The agent must claim work again before submitting.' };
  if (assignment?.status === 'COMPLETED') return { stage: 'submitted', label: 'Attempt complete', detail: 'The agent finished its bounded assignment.' };
  if (credential.lastSeenAt) return { stage: 'connected', label: 'Agent has connected', detail: 'Motive received an authenticated request. No active assignment is recorded.' };
  return { stage: 'waiting', label: 'Waiting for your agent', detail: 'Give your agent the copied instructions and access key. Its first contact will appear here.' };
}

export function connectionActivity(data: ParticipationMeResponse, credential: AgentTokenProjection) {
  const assignment = data.assignments.find(item => item.credentialId === credential.id);
  const submission = data.submissions.filter(item => item.contributorId === credential.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const activity = agentActivity(credential, assignment, submission);
  const cycleRecorded = activity.stage === 'submitted' && assignment?.status === 'COMPLETED' && Boolean(submission?.postCheckAssessmentHref);
  return { ...activity, submission, cycleRecorded };
}
