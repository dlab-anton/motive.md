import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionProjection, AgentTokenProjection, AssignmentProjection, ParticipationMeResponse, SubmissionSummary } from './participation';
import { agentActivity, connectionActivity, connectionPresence } from './agent-activity';

const credential = (id: string, changes: Partial<AgentTokenProjection> = {}): AgentTokenProjection => ({
  id, projectSlug: 'circle-packing', agentName: 'Calm Finch', modelName: null, publicDisplayName: null,
  expiresAt: '2026-10-01T00:00:00.000Z', revokedAt: null, lastSeenAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', ...changes,
});
const assignment = (credentialId: string, changes: Partial<AssignmentProjection> = {}): AssignmentProjection => ({
  id: 'work-order', credentialId, claimId: 'claim', projectSlug: 'circle-packing', projectRevision: 1,
  workOrderId: 'work-order', workOrderRevision: 1, agreementId: 'agreement', termsDigest: `sha256:${'a'.repeat(64)}`,
  status: 'ACTIVE', leaseEpoch: 1, expiresAt: '2026-09-09T00:00:00.000Z',
  createdAt: '2026-09-08T11:00:00.000Z', completedAt: null, ...changes,
});
const submission = (contributorId: string, createdAt: string): SubmissionSummary => ({
  id: `submission-${contributorId}`, assignmentId: 'work-order', contributorId, contributorDisplayName: null,
  agentName: 'Calm Finch', modelName: null, createdAt, reportStatus: 'VALID',
  artifactSha256: `sha256:${'b'.repeat(64)}`, exactScore: '5.29', exceedsReference: false,
  acceptance: 'PENDING', artifactHref: '/artifact', reportHref: '/report', investigationHref: null, postCheckAssessmentHref: null, reproducibilityHref: null,
});
const state = (credentials: AgentTokenProjection[], assignments: AssignmentProjection[], submissions: SubmissionSummary[] = []): ParticipationMeResponse => ({
  projectSlug: 'circle-packing', canReview: false, credentials, assignments, submissions,
});
const session = (credentialId: string, changes: Partial<AgentSessionProjection> = {}): AgentSessionProjection => ({
  credentialId, status: 'RUNNING', runMode: 'UNTIL_STOPPED', declaredAt: '2026-09-08T11:30:00.000Z',
  stopReason: null, presence: 'ACTIVE', presenceReason: 'FRESH_CONTACT',
  lastContactAt: '2026-09-08T11:59:00.000Z', accessStatus: 'AVAILABLE', ...changes,
});
const withSession = (item: AgentTokenProjection, current?: AgentSessionProjection): ParticipationMeResponse => ({
  ...state([item], []), sessions: current ? [current] : [],
});

describe('agent activity', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z')); });
  afterEach(() => vi.useRealTimers());

  it('does not call an expired active claim working', () => {
    expect(agentActivity(credential('one'), assignment('one', { expiresAt: '2026-09-08T11:59:59.000Z' })))
      .toMatchObject({ stage: 'expired', label: 'Assignment expired' });
  });

  it('correlates multiple credentials by credentialId rather than array position', () => {
    const first = credential('first'); const second = credential('second');
    const data = state([first, second], [assignment('second'), assignment('first', { status: 'RELEASED' })]);
    expect(connectionActivity(data, first).stage).toBe('released');
    expect(connectionActivity(data, second).stage).toBe('working');
  });

  it('does not let an old submission mask a newer active claim', () => {
    const item = credential('agent');
    const data = state([item], [assignment(item.id)], [submission(item.id, '2026-09-08T10:00:00.000Z')]);
    expect(connectionActivity(data, item)).toMatchObject({ stage: 'working', submission: expect.any(Object) });
  });

  it('always reports a revoked credential as ended', () => {
    const item = credential('agent', { revokedAt: '2026-09-08T11:30:00.000Z' });
    expect(connectionActivity(state([item], [assignment(item.id)]), item)).toMatchObject({ stage: 'ended' });
  });

  it('waits for the post-check update after a completed experiment', () => {
    const item = credential('agent');
    const result = submission(item.id, '2026-09-08T11:30:00.000Z');
    expect(connectionActivity(state([item], [assignment(item.id, {status:'COMPLETED'})], [result]), item))
      .toMatchObject({cycleRecorded:false, label:'Update · result checked'});
    result.postCheckAssessmentHref = '/post-check-assessment';
    expect(connectionActivity(state([item], [assignment(item.id, {status:'COMPLETED'})], [result]), item))
      .toMatchObject({cycleRecorded:true, label:'Cycle recorded'});
  });

  it('resets the visible loop when the same connection starts its next experiment', () => {
    const item = credential('agent');
    const result = {...submission(item.id, '2026-09-08T10:30:00.000Z'), postCheckAssessmentHref:'/post-check-assessment'};
    expect(connectionActivity(state([item], [assignment(item.id)], [result]), item))
      .toMatchObject({cycleRecorded:false, stage:'working', submission:result});
  });
});

describe('connection presence', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');

  it('requires a coherent running declaration and a fresh nonfuture contact for active', () => {
    const item = credential('agent');
    expect(connectionPresence(withSession(item, session(item.id)), item, false, now))
      .toEqual({ kind: 'ACTIVE', label: 'Active' });
    expect(connectionPresence(withSession(item, session(item.id, { status: 'PAUSED' })), item, false, now))
      .toEqual({ kind: 'UNREPORTED', label: 'Status not reported' });
    expect(connectionPresence(withSession(item, session(item.id, {
      lastContactAt: '2026-09-08T12:00:00.001Z',
    })), item, false, now)).toEqual({ kind: 'NO_RECENT_CONTACT', label: 'No recent check-in' });
    expect(connectionPresence(withSession(item, session(item.id, {
      declaredAt: '2026-09-08T12:00:00.001Z',
    })), item, false, now)).toEqual({ kind: 'UNREPORTED', label: 'Status not reported' });
  });

  it('lets ended access override stale or contradictory session status', () => {
    const revoked = credential('revoked', { revokedAt: '2026-09-08T11:59:00.000Z' });
    expect(connectionPresence(withSession(revoked, session(revoked.id)), revoked, true, now))
      .toEqual({ kind: 'ACCESS_ENDED', label: 'Access ended' });
    const expired = credential('expired', { expiresAt: '2026-09-08T12:00:00.000Z' });
    expect(connectionPresence(withSession(expired, session(expired.id)), expired, false, now))
      .toEqual({ kind: 'ACCESS_ENDED', label: 'Access ended' });
    const serverEnded = credential('server-ended');
    expect(connectionPresence(withSession(serverEnded, session(serverEnded.id, {
      accessStatus: 'REVOKED', presence: 'UNKNOWN', presenceReason: 'ACCESS_REVOKED',
    })), serverEnded, false, now)).toEqual({ kind: 'ACCESS_ENDED', label: 'Access ended' });
  });

  it('reports unavailable owner state before active or paused presence', () => {
    const item = credential('agent');
    expect(connectionPresence(withSession(item, session(item.id)), item, true, now))
      .toEqual({ kind: 'UNAVAILABLE', label: 'Status unavailable' });
    const paused = session(item.id, { status: 'PAUSED', presence: 'PAUSED', presenceReason: 'EXPLICITLY_PAUSED' });
    expect(connectionPresence(withSession(item, paused), item, true, now))
      .toEqual({ kind: 'UNAVAILABLE', label: 'Status unavailable' });
    expect(connectionPresence(withSession(item, paused), item, false, now))
      .toEqual({ kind: 'PAUSED', label: 'Paused' });
  });

  it('distinguishes server-known and locally elapsed run limits', () => {
    const item = credential('agent');
    const serverLimited = session(item.id, { presence: 'UNKNOWN', presenceReason: 'RUN_LIMIT_REACHED' });
    expect(connectionPresence(withSession(item, serverLimited), item, false, now))
      .toEqual({ kind: 'RUN_LIMIT_REACHED', label: 'Run limit reached' });
    const timed = session(item.id, { runMode: 'THIRTY_MINUTES', declaredAt: '2026-09-08T11:30:00.000Z' });
    expect(connectionPresence(withSession(item, timed), item, false, now))
      .toEqual({ kind: 'RUN_LIMIT_REACHED', label: 'Run limit reached' });
    expect(connectionPresence(withSession(item, timed), item, false, now - 1))
      .toEqual({ kind: 'ACTIVE', label: 'Active' });
  });

  it('separates unreported, old, and never-contacted connections', () => {
    const seen = credential('seen', { lastSeenAt: '2026-09-08T11:00:00.000Z' });
    expect(connectionPresence(withSession(seen, session(seen.id, {
      presence: 'UNKNOWN', presenceReason: 'NO_DECLARATION', status: null, runMode: null, declaredAt: null,
    })), seen, false, now)).toEqual({ kind: 'UNREPORTED', label: 'Status not reported' });
    expect(connectionPresence(withSession(seen, session(seen.id, {
      presence: 'UNKNOWN', presenceReason: 'STALE_CONTACT', lastContactAt: '2026-09-08T11:57:59.999Z',
    })), seen, false, now)).toEqual({ kind: 'NO_RECENT_CONTACT', label: 'No recent check-in' });
    const ready = credential('ready');
    expect(connectionPresence(withSession(ready), ready, false, now))
      .toEqual({ kind: 'READY', label: 'Ready to start' });
  });
});
