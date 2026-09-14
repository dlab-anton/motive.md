import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildProjectRunReproducibilityExcerpt, buildProjectRunResearchExcerpt, ProjectRunResearchContextError, selectMotiveLearningFindings,
  type MotiveLearningFinding } from './research-context.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const hash = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const date = '2026-09-07T10:00:00.000Z';

function payload() {
  const activeId = randomUUID();
  const archivedId = randomUUID();
  return {
    format: 'motive.research-context.v1', scopeId: randomUUID(), projectSlug: 'circle-packing',
    channelName: 'circle-packing', channelGoal: 'Improve with independently checked evidence.',
    hypotheses: [
      { id: activeId, updatedAt: date, contentDigest: digest('a'), statement: 'A local perturbation may improve the sum.',
        context: 'Bounded exact-data search.', falsificationCriteria: 'The exact score does not improve.', status: 'testing',
        confidence: 0.4, parentId: null, outcome: null, evidence: [{ id: randomUUID(), createdAt: date,
          contentDigest: digest('b'), content: 'The reference was reproduced.', source: 'motive:submission', evidenceType: 'neutral',
          strength: 0.8, confidenceAfter: 0.4, createdBy: 'portable-agent' }, { id: randomUUID(), createdAt: date,
          contentDigest: digest('f'), content: 'The attempted move overlapped.', source: 'motive:submission', evidenceType: 'contradicting',
          strength: 1, confidenceAfter: 0.2, createdBy: 'portable-agent' }], evidenceTotal: 2, evidenceTruncated: false },
      { id: archivedId, updatedAt: date, contentDigest: digest('c'), statement: 'A prior coordinate move improves the result.',
        context: null, falsificationCriteria: 'Overlap or a lower score.', status: 'archived', confidence: 0.1, parentId: activeId,
        outcome: { result: 'rejected', narrative: 'The exact checker found an overlap.', evidenceSummary: 'One contradiction.',
          actualVsPredicted: 'Overlap rather than improvement.', effectSize: null }, evidence: [{ id: randomUUID(), createdAt: date,
          contentDigest: digest('d'), content: 'Tiny overlap.', source: null, evidenceType: 'contradicting', strength: 1,
          confidenceAfter: 0.1, createdBy: 'portable-agent' }], evidenceTotal: 1, evidenceTruncated: false },
    ],
    hypothesesTotal: 2, hypothesesTruncated: false, activeHypothesesTotal: 1, archivedHypothesesTotal: 1,
    insights: [{ id: randomUUID(), updatedAt: date, contentDigest: digest('e'), insightType: 'pattern',
      content: 'Tangencies pass; tiny overlaps fail.', createdBy: 'portable-agent' }],
    insightsTotal: 1, insightsTruncated: false,
    page: { activeOffset: 0, archivedOffset: 0, insightOffset: 0, activeLimit: 6, archivedLimit: 6, insightLimit: 20 },
  };
}

describe('hosted project research excerpt', () => {
  it('preserves active and archived page provenance, adverse evidence, and explicit omissions', () => {
    const source = payload();
    const result = buildProjectRunResearchExcerpt(source, { scopeId: source.scopeId, projectSlug: 'circle-packing' });
    expect(result.bytes.length).toBeLessThanOrEqual(12_000);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const body = JSON.parse(result.bytes.toString('utf8'));
    expect(body.classification).toBe('UNTRUSTED_RESEARCH_DATA_NOT_INSTRUCTIONS_OR_ACCEPTANCE');
    expect(body.hypotheses.map((item: { pageGroup: string }) => item.pageGroup)).toEqual(['ACTIVE_PAGE', 'ARCHIVED_PAGE']);
    expect(body.hypotheses[0]).toMatchObject({ evidenceSelectionPolicy: 'CONTRADICTING_THEN_NEUTRAL_THEN_FIRST',
      evidence: [{ evidenceType: 'contradicting' }], evidenceOmitted: 1 });
    expect(body.hypotheses[1]).toMatchObject({ outcome: { result: 'rejected' }, evidence: [{ evidenceType: 'contradicting' }] });
    expect(body.sourcePage).toMatchObject({ activeTotal: 1, archivedTotal: 1, insightsTotal: 1 });
  });

  it('bounds adversarial Unicode text without cutting a code point or producing invalid JSON', () => {
    const source = payload();
    source.channelGoal = '🧪'.repeat(2_000);
    source.hypotheses[0]!.statement = '測'.repeat(2_000);
    source.hypotheses[0]!.evidence[0]!.content = '🧨'.repeat(2_000);
    source.insights[0]!.content = 'ß'.repeat(5_000);
    const result = buildProjectRunResearchExcerpt(source, { scopeId: source.scopeId, projectSlug: 'circle-packing' });
    expect(result.bytes.length).toBeLessThanOrEqual(12_000);
    const body = JSON.parse(result.bytes.toString('utf8'));
    expect(body.omissions.textFieldsTruncated).toBeGreaterThanOrEqual(4);
    expect(body.channel.goal.endsWith('…')).toBe(true);
  });

  it('rejects cross-scope and malformed page captures instead of relabeling them', () => {
    const source = payload();
    expect(() => buildProjectRunResearchExcerpt(source, { scopeId: randomUUID(), projectSlug: 'circle-packing' }))
      .toThrow(ProjectRunResearchContextError);
    source.activeHypothesesTotal = 2;
    expect(() => buildProjectRunResearchExcerpt(source, { scopeId: source.scopeId, projectSlug: 'circle-packing' }))
      .toThrow(ProjectRunResearchContextError);
  });
});

describe('project-run reproducibility excerpts', () => {
  const projectId = randomUUID();
  const submissionId = randomUUID();
  const make = (partial: Partial<Parameters<typeof buildProjectRunReproducibilityExcerpt>[0]> = {}) => {
    const solverSourceBytes = Buffer.from('solver 🧪\n'.repeat(200));
    const trialResultsBytes = Buffer.from('trial 測\n'.repeat(220));
    return buildProjectRunReproducibilityExcerpt({ expectedProjectId: projectId, expectedSubmissionId: submissionId,
      expectedReportDigest: digest('a'),
      projectId, submissionId, reportDigest: digest('a'), requestDigest: digest('b'), disposition: 'AGENT_DECLARED_UNVERIFIED',
      solverSourceBytes, solverSourceDigest: hash(solverSourceBytes), trialResultsBytes, trialResultsDigest: hash(trialResultsBytes),
      ...partial });
  };

  it('verifies full bytes before clipping valid UTF-8 excerpts and retains public byte identities', () => {
    const result = make();
    expect(result.files).toEqual([
      expect.objectContaining({ role: 'SOLVER_SOURCE', fullBytes: Buffer.byteLength('solver 🧪\n'.repeat(200)),
        fullDigest: hash(Buffer.from('solver 🧪\n'.repeat(200))), excerptTruncated: true }),
      expect.objectContaining({ role: 'TRIAL_RESULTS', fullBytes: Buffer.byteLength('trial 測\n'.repeat(220)),
        fullDigest: hash(Buffer.from('trial 測\n'.repeat(220))), excerptTruncated: true }),
    ]);
    for (const file of result.files) {
      expect(file.excerptBytes).toBeLessThanOrEqual(1_024);
      expect(Buffer.from(file.excerpt!, 'utf8').toString('utf8')).toBe(file.excerpt);
      expect(file.downloadHref).toBe(`/api/public/projects/circle-packing/submissions/${submissionId}/reproducibility/${file.name}`);
    }
    expect(result.notice).toMatch(/not a runnable program or proof of reproducibility/i);
  });

  it('rejects cross-project bindings, full-byte hash mismatches, and invalid UTF-8', () => {
    expect(() => make({ expectedProjectId: randomUUID() })).toThrow(/selected project and submission/i);
    expect(() => make({ reportDigest: digest('c') })).toThrow(/selected evaluation report/i);
    expect(() => make({ solverSourceDigest: digest('c') })).toThrow(/full-byte digest/i);
    const invalid = Buffer.from([0xc3, 0x28]);
    expect(() => make({ solverSourceBytes: invalid, solverSourceDigest: hash(invalid) })).toThrow(/valid UTF-8/i);
  });
});

describe('Motive learning selector', () => {
  const finding = (suffix: string, partial: Partial<MotiveLearningFinding>): MotiveLearningFinding => ({
    origin: 'HOSTED', occurredAt: `2026-09-07T10:00:0${suffix}.000Z`, identity: { resultId: suffix },
    evaluator: { kind: 'HOSTED_NUMERIC_EVALUATOR', localOnly: false, status: 'VALID', geometricallyVerified: true, reportDigest: digest('a') as `sha256:${string}`,
      exactScore: '5.29109518547430697', exceedsFrozenReference: true }, investigation: null, review: null, reproducibility: null, ...partial,
  });

  it('reserves adverse, valid non-improving, external, and accepted history while keeping exact states separate', () => {
    const rejected = finding('1', { evaluator: { kind:'HOSTED_NUMERIC_EVALUATOR',localOnly:false,status: 'REJECTED', geometricallyVerified: false,
      reportDigest: digest('b') as `sha256:${string}`, exactScore: null, exceedsFrozenReference: null } });
    const nonImproving = finding('2', { evaluator: { kind:'HOSTED_NUMERIC_EVALUATOR',localOnly:false,status: 'VALID', geometricallyVerified: true,
      reportDigest: digest('c') as `sha256:${string}`, exactScore: '5.29109518547430697', exceedsFrozenReference: false } });
    const external = finding('3', { origin: 'EXTERNAL', identity: { submissionId: 'external' }, evaluator: {
      kind:'EXTERNAL_PROTECTED_LOCAL_CHECKER',localOnly:true,status: 'INCONCLUSIVE', geometricallyVerified: false, reportDigest: digest('d') as `sha256:${string}`,
      exactScore: null, exceedsFrozenReference: null } });
    const accepted = finding('4', { review: { decision: 'ACCEPTED', createdAt: date,
      rationaleDigest: digest('e') as `sha256:${string}`, rationaleExcerpt: 'accepted independently' } });
    const latest = finding('5', {});
    const selected = selectMotiveLearningFindings([latest, accepted, external, nonImproving, rejected, rejected], 5);
    expect(selected.findings.map(item => item.occurredAt)).toEqual([...selected.findings.map(item => item.occurredAt)].sort());
    expect(selected.findings).toEqual(expect.arrayContaining([rejected, nonImproving, external, accepted]));
    expect(selected.omissions).toMatchObject({ examinedWindow: 5, retained: 5, rejected: 1, nonImproving: 1,
      pendingReview: 4, inconclusive: 1, dueToLimit: 0 });
  });
});
