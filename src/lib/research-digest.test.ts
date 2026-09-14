import { describe, expect, it } from 'vitest';
import type { PublicResearchUpdate } from './participation';
import { researchDigest, researchDigests, researchSummaryLabel } from './research-digest';

describe('research summaries retain their source binding', () => {
  const submissionId = 'f414785e-ae59-4dc3-953c-cc95845fcc01';
  const current: PublicResearchUpdate = {
    submissionId, reportDigest: researchDigests[submissionId]!.reportDigest,
    assessmentSourceDigest: researchDigests[submissionId]!.assessmentSourceDigest,
    agentName: 'Synthetic Researcher', contributorDisplayName: null,
    createdAt: '2026-09-08T00:00:00Z', proposal: 'A different actual question',
    expectation: null, latestAssessment: 'A different actual finding',
    assessmentTiming: 'AFTER_CHECK', completed: true,
    observedOutcome: { reportStatus: 'VALID', exactScore: '5', exceedsReference: false, reportHref: '/synthetic-report' },
    citedEarlierMotiveSubmissions: [],
  };
  it('labels the reviewed summary as editorial only for both recorded source identities', () => {
    expect(researchDigest(current)).toMatchObject({ editorial: true, question: researchDigests[submissionId]!.question });
  });
  it.each([undefined, null, `sha256:${'1'.repeat(64)}`])('uses the current assessment when its editorial binding is absent or changed: %s', assessmentSourceDigest => {
    expect(researchDigest({ ...current, assessmentSourceDigest })).toEqual({
      editorial: false, question: current.proposal, finding: current.latestAssessment,
    });
  });
  it('uses actual source text when the report binding differs', () => {
    expect(researchDigest({ ...current, reportDigest: `sha256:${'0'.repeat(64)}` })).toEqual({
      editorial: false, question: current.proposal, finding: current.latestAssessment,
    });
  });
  it('prefers a valid post-check agent summary over an editorial summary without labelling it reviewed', () => {
    const publicSummary = { question: 'Did the tested move help?', finding: 'This test found no gain. Other moves remain untested.' };
    const digest = researchDigest({ ...current, publicSummary });
    expect(digest).toEqual({ ...publicSummary, editorial: false, agentSummary: true });
    expect(researchSummaryLabel(digest)).toBe('Agent summary');
    expect(researchSummaryLabel(researchDigest(current))).toBe('Report summary');
  });
  it('does not turn a summary into an earlier declared proposal', () => {
    const publicSummary = { question: 'A retrospective question', finding: 'An agent interpretation' };
    expect(researchDigest({ ...current, assessmentTiming: 'AT_SUBMISSION', publicSummary })).toEqual(researchDigest(current));
  });
  it.each([null, { question: 'Only one field' }, { question: 'A question', finding: 'Two\nparagraphs' },
    { question: 'A question', finding: 'A finding', approved: true }])('ignores malformed summaries from an unvalidated public response: %j', publicSummary => {
    expect(researchDigest({ ...current, publicSummary } as unknown as PublicResearchUpdate)).toEqual(researchDigest(current));
  });
});
