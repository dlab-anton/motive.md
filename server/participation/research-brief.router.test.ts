import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { ParticipationPublicProjection, SubmissionSummary } from '../../src/lib/participation.ts';
import { createParticipationRouters } from './router.ts';
import { buildResearchBrief } from './research-brief.ts';
import type { ParticipationService } from './service.ts';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const summary = (id: string, acceptance: SubmissionSummary['acceptance']): SubmissionSummary => ({
  id, assignmentId: randomUUID(), contributorId: randomUUID(), contributorDisplayName: 'Public contributor',
  agentName: 'Brief Agent', modelName: 'local-model', createdAt: '2026-09-14T03:00:00.000Z',
  reportStatus: 'VALID', artifactSha256: digest('a'), exactScore: '5.291', exceedsReference: false, acceptance,
  artifactHref: `/api/public/projects/circle-packing/submissions/${id}/artifact`,
  reportHref: `/api/public/projects/circle-packing/submissions/${id}/report`,
  investigationHref: `/api/public/projects/circle-packing/submissions/${id}/investigation`,
  postCheckAssessmentHref: `/api/public/projects/circle-packing/submissions/${id}/post-check-assessment`,
  reproducibilityHref: `/api/public/projects/circle-packing/submissions/${id}/reproducibility`,
});

function projection(): ParticipationPublicProjection {
  const currentId = randomUUID(); const legacyId = randomUUID();
  return {
    project: { slug: 'circle-packing', visibility: 'PUBLIC', lifecycle: 'RESULTS_AVAILABLE', projectRevision: 7 },
    activeAssignments: 2, totalSubmissions: 44, acceptedResults: 1,
    bestChecked: summary(currentId, 'PENDING'), bestAccepted: summary(randomUUID(), 'ACCEPTED'),
    contributors: [{ id: randomUUID(), displayName: 'Omitted contributor', firstSubmittedAt: '2026-09-13T00:00:00.000Z',
      submissionCount: 3, reviewedArtifactCount: 1, acceptedFindingCount: 1,
      reviewedSubmissionIds: [], publicSubmissionIds: [] }], privateContributionCount: 4,
    submissions: [], activity: [],
    activeResearchIntents: [{ assignmentId: randomUUID(), claimId: randomUUID(), agentName: 'Active Agent',
      contributorDisplayName: null, proposal: 'Test an overlapping protocol.', expectation: 'The outcome changes.',
      conditions: ['Bound the run.'], motiveReferences: [{ submissionId: currentId, reportDigest: digest('b'),
        artifactDigest: digest('c') }], experimentProtocol: { format: 'motive.experiment-protocol.v1',
        procedure: 'brief-test', inputs: [{ name: 'seed', value: '4' }], purpose: 'EXPLORATORY' },
      researchDeliveryTarget: { mode: 'APPEND_EXISTING', scopeId: randomUUID(), snapshotId: randomUUID(),
        snapshotDigest: digest('d'), hypothesisId: randomUUID(), observedUpdatedAt: '2026-09-14T02:00:00.000Z' },
      protocolFingerprint: digest('e'), workOrderRevision: 2, declaredAt: '2026-09-14T03:10:00.000Z',
      expiresAt: '2026-09-14T04:10:00.000Z' }],
    recentResearchHandoffs: [{ id: randomUUID(), claimId: randomUUID(), assignmentId: randomUUID(),
      agentName: 'Paused Agent', contributorDisplayName: 'Operator trial', createdAt: '2026-09-14T02:50:00.000Z',
      stopReason: 'The bounded input was unavailable.', intent: { proposal: 'Check one input.',
        expectation: 'The input is present.', conditions: ['Do not fabricate it.'], workOrderRevision: 1,
        declaredAt: '2026-09-14T02:30:00.000Z' }, interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' }],
    researchUpdates: [{ submissionId: currentId, reportDigest: digest('f'), agentName: 'Brief Agent',
      contributorDisplayName: 'private-canary-contributor', createdAt: '2026-09-14T03:00:00.000Z',
      proposal: 'private-canary-proposal', expectation: 'private-canary-expectation',
      latestAssessment: 'private-canary-long-assessment', assessmentTiming: 'AFTER_CHECK',
      publicSummary: { question: 'Did the bounded check help?', finding: 'The check finished, but did not improve the baseline.' },
      observedOutcome: { reportStatus: 'VALID', exactScore: '5.291', exceedsReference: false,
        reportHref: `/api/public/projects/circle-packing/submissions/${currentId}/report` }, completed: true,
      memoryReview: { latestDecision: null, hasEngineRecords: false }, findingReview: null,
      citedEarlierMotiveSubmissions: [] },
    { submissionId: legacyId, reportDigest: digest('0'), agentName: 'Legacy Agent', contributorDisplayName: null,
      createdAt: '2026-09-14T02:00:00.000Z', proposal: 'Legacy bounded proposal.', expectation: 'private-legacy-expectation',
      latestAssessment: null, assessmentTiming: 'AT_SUBMISSION',
      observedOutcome: { reportStatus: 'REJECTED', exactScore: null, exceedsReference: null,
        reportHref: `/api/public/projects/circle-packing/submissions/${legacyId}/report` }, completed: false,
      citedEarlierMotiveSubmissions: [] }],
    loopProgress: { activeAgents: 2, completedAttempts: 44, checkedSubmissions: 43, recordedUpdates: 42, completedCycles: 41 },
  };
}

describe('public research brief', () => {
  it('projects bounded orientation fields and leaves the original project response unchanged', async () => {
    const source = projection(); let reads = 0;
    const service = { publicProjection: async () => { reads += 1; return source; } } as unknown as ParticipationService;
    const { publicRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/public/projects/circle-packing', publicRouter);
    const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind.');
      const origin = `http://127.0.0.1:${address.port}/api/public/projects/circle-packing`;
      const response = await fetch(`${origin}/research-brief`);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(reads).toBe(1);
      const body = await response.json() as Record<string, any>;
      expect(Object.keys(body)).toEqual(['format','project','bestChecked','bestAccepted','activeAssignments','totalSubmissions',
        'activeResearchIntents','recentResearchHandoffs','recentTasks','projectHref','researchJournalHref','notice']);
      expect(body.bestChecked).toEqual(source.bestChecked); expect(body.bestAccepted).toEqual(source.bestAccepted);
      expect(body.activeResearchIntents).toEqual(source.activeResearchIntents);
      expect(body.recentResearchHandoffs).toEqual(source.recentResearchHandoffs);
      expect(body.recentTasks).toHaveLength(2);
      expect(body.recentTasks[0]).toEqual({ submissionId: source.researchUpdates![0]!.submissionId,
        reportDigest: digest('f'), agentName: 'Brief Agent', createdAt: '2026-09-14T03:00:00.000Z', completed: true,
        assessmentTiming: 'AFTER_CHECK', observedOutcome: source.researchUpdates![0]!.observedOutcome,
        publicSummary: source.researchUpdates![0]!.publicSummary,
        entryHref: `/api/public/projects/circle-packing/research-updates/${source.researchUpdates![0]!.submissionId}` });
      expect(Object.hasOwn(body.recentTasks[0], 'proposal')).toBe(false);
      expect(body.recentTasks[1]).toMatchObject({ completed: false, assessmentTiming: 'AT_SUBMISSION',
        publicSummary: null, proposal: 'Legacy bounded proposal.',
        observedOutcome: { reportStatus: 'REJECTED', exactScore: null, exceedsReference: null },
        entryHref: `/api/public/projects/circle-packing/research-updates/${source.researchUpdates![1]!.submissionId}` });
      expect(JSON.stringify(body)).not.toContain('private-canary');
      expect(body.projectHref).toBe(origin.replace(/^http:\/\/[^/]+/, ''));
      expect(body.researchJournalHref).toBe('/api/public/projects/circle-packing/research-updates');

      const original = await fetch(origin); expect(await original.json()).toEqual(source); expect(reads).toBe(2);
      const invalid = await fetch(`${origin}/research-brief?before=${randomUUID()}`);
      expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: 'validation',
        message: 'Research brief does not accept query parameters.' }); expect(reads).toBe(2);
    } finally { server.close(); await once(server, 'close'); }
  });

  it('uses explicit empty and unknown values without synthesizing summaries', () => {
    const value = projection(); value.bestChecked = undefined; value.bestAccepted = null;
    value.activeResearchIntents = undefined; value.recentResearchHandoffs = undefined; value.researchUpdates = undefined;
    const brief = buildResearchBrief(value);
    expect(brief).toMatchObject({ bestChecked: null, bestAccepted: null, activeResearchIntents: [],
      recentResearchHandoffs: [], recentTasks: [] });
  });
});
