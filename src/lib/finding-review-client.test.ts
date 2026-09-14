import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FindingDeclaredReferences,
  FindingReviewDecisionResponse,
  FindingReviewPackageV1,
  FindingReviewPackageV2,
  FindingReviewPreview,
  FindingReviewPublicDecision,
  FindingReviewPublicProjection,
} from './finding-assessment';
import type { FindingReviewHistoryDecision, FindingReviewHistoryPage } from './finding-assessment';
import {
  parseFindingDecision,
  parseFindingEligibility,
  parseFindingPreview,
  parseFindingPublic,
} from './finding-review-client';
import { FindingHistoryReadError, parseFindingHistory, readFindingHistory } from './finding-history';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const timestamp = '2026-09-09T03:00:00.000Z';
const submissionId = id(1);
const projectId = id(2);
const hypothesisId = id(3);
const evidenceId = id(4);

function declared(): FindingDeclaredReferences {
  return {
    researchContext: { timing: 'PRE_TEST_INTENT', value: {
      scopeId: id(10), snapshotId: id(11), snapshotDigest: digest('a'),
    } },
    researchReferences: { timing: 'SUBMISSION_NOTES', value: [{
      scopeId: id(10), snapshotId: id(11), snapshotDigest: digest('a'), hypothesisId: id(12),
      observedUpdatedAt: timestamp, evidenceIds: [id(13)],
    }] },
    motiveReferences: { timing: 'PRE_TEST_INTENT', value: [{
      submissionId: id(14), reportDigest: digest('b'), artifactDigest: digest('c'),
    }] },
  };
}

type FindingReviewPreviewV1 = Omit<FindingReviewPreview, 'package'> & { package: FindingReviewPackageV1 };
type FindingReviewPreviewV2 = Omit<FindingReviewPreview, 'package'> & { package: FindingReviewPackageV2 };

function packageFixture(): FindingReviewPackageV1 {
  const scopeId = id(5); const engineActor = `motive:project:${projectId}`;
  return {
    format: 'motive.finding-review-package/0.1',
    findingId: submissionId,
    project: { id: projectId, slug: 'circle-packing', revision: 2 },
    workOrder: { id: id(6), revision: 3, projectRevision: 2, termsDigest: digest('d'),
      terms: { format: 'motive.work-order/0.1', objective: 'Check the candidate.' } },
    claim: { id: id(7), leaseEpoch: 1, termsDigest: digest('d'), completedAt: timestamp },
    source: {
      submission: {
        id: submissionId, format: 'motive.submission/0.1', createdAt: timestamp, baseCommit: 'a'.repeat(40),
        artifactManifestDigest: digest('e'), licenseAcceptanceRef: 'license:accepted', sourceIntentId: id(8),
        sourceIntentPayloadDigest: digest('f'), sourceIntentPayload: {
          format: 'motive.hypothesis-writeback-preparation/0.1', scope: { projectId, scopeId },
          attribution: { engineActor }, source: { submission: { id: submissionId } },
        },
      },
      attribution: { contributorActorId: 'account:contributor', agentTokenId: id(9), agentName: 'Research agent' },
      declaredIntent: { proposal: 'Try the original bounded candidate.', expectation: 'The first checker run may pass.',
        conditions: ['Use the declared exact arithmetic.'], declaredAt: timestamp, requestDigest: digest('0'),
        researchContext: null, researchReferences: null, motiveReferences: null },
      investigation: {
        proposal: 'Try the bounded candidate.', expectation: 'The checker will decide.', conditions: ['Use exact arithmetic.'],
        observations: ['The protected checker completed.'], assessment: 'The candidate is informative.',
        nextAction: 'Record the finding.', digest: digest('1'),
      },
      references: declared(),
      artifact: { format: 'motive.csqv.witness.v1', witness: '{"circles":[]}', digest: digest('2') },
      report: { status: 'VALID', body: { result: { status: 'VALID' } }, digest: digest('3') },
      postCheck: { requestDigest: digest('4'), reportDigest: digest('3'), assessment: 'The check supports review.',
        nextAction: 'Request independent review.', createdAt: timestamp },
      reproducibility: { requestDigest: digest('5'), solverSourceDigest: digest('6'), trialResultsDigest: digest('7') },
    },
    delivery: { id: id(15), scopeId, engineActor, createdAt: timestamp },
    engine: {
      hypothesis: {
        requestBody: { statement: 'A bounded finding.' }, requestBodyDigest: digest('8'), requestDigest: digest('9'),
        id: hypothesisId, responseBody: { id: hypothesisId, statement: 'A bounded finding.' }, responseDigest: digest('a'),
      },
      evidence: {
        requestBody: { content: 'Neutral checker observation.' }, requestBodyDigest: digest('b'), requestDigest: digest('c'),
        id: evidenceId, responseBody: { evidence: { id: evidenceId, hypothesis_id: hypothesisId }, hypothesis: { id: hypothesisId } },
        responseDigest: digest('d'),
      },
    },
    assessment: { engineHypothesisSupport: 'UNASSESSED', engineConclusionApproval: 'UNASSESSED' },
  };
}

function publicDecision(): FindingReviewPublicDecision {
  const pkg = packageFixture();
  return {
    id: id(20), decision: 'ACCEPT', outcome: 'SUPPORTED', finding: 'The bounded candidate passed.',
    limitations: 'The result applies only to the retained candidate.', novelty: 'DISTINCT', duplicateOfSubmissionId: null,
    rationale: 'The immutable package supports this scoped finding.', reviewedAt: timestamp, packageDigest: digest('e'),
    evidence: {
      artifactDigest: pkg.source.artifact.digest, reportDigest: pkg.source.report.digest,
      investigationDigest: pkg.source.investigation.digest, postCheckRequestDigest: pkg.source.postCheck.requestDigest,
      reproducibility: pkg.source.reproducibility, declaredIntent: pkg.source.declaredIntent, declared: pkg.source.references,
      engineEvidence: { id: pkg.engine.evidence.id, responseDigest: pkg.engine.evidence.responseDigest },
    },
    hypothesis: { id: hypothesisId, statement: 'A bounded finding.', responseDigest: pkg.engine.hypothesis.responseDigest },
  };
}

function publicFixture(): FindingReviewPublicProjection {
  return { format: 'motive.finding-review.public/0.1', submissionId, available: true, reason: null,
    latestDecision: publicDecision() };
}

function historyDecision(value:number,previousDecisionId:string|null,reviewedAt=timestamp):FindingReviewHistoryDecision {
  return {...publicDecision(),id:id(value),reviewedAt,previousDecisionId};
}

function historyPage(count:number,continues=false):FindingReviewHistoryPage {
  const items=Array.from({length:count},(_,index)=>historyDecision(100+index,index===count-1
    ?(continues?id(900):null):id(101+index)));
  return {format:'motive.finding-review.history/0.1',submissionId,latestDecisionId:items[0]?.id??null,items,
    nextCursor:continues?items.at(-1)!.id:null};
}

function previewFixture(): FindingReviewPreviewV1 {
  const pkg = packageFixture(); const decision = publicDecision();
  return {
    format: 'motive.finding-review.preview/0.1', submissionId, package: pkg, packageDigest: decision.packageDigest,
    latestDecision: { ...decision, reviewerActorId: 'account:reviewer', previousDecisionId: null,
      duplicateOfDecisionId: null },
  };
}

function decisionFixture(): FindingReviewDecisionResponse {
  const decision = publicDecision();
  return {
    format: 'motive.finding-review.decision/0.1', submissionId, ...decision, novelty: 'DUPLICATE',
    duplicateOfSubmissionId: id(30), reviewerActorId: 'account:reviewer', previousDecisionId: id(19),
    duplicateOfDecisionId: id(31), replayed: false,
  };
}

function sourceOnlyPackageFixture(): FindingReviewPackageV2 {
  const legacy = packageFixture();
  const submission = legacy.source.submission;
  return {
    format: 'motive.finding-review-package/0.2',
    findingId: legacy.findingId,
    project: legacy.project,
    workOrder: legacy.workOrder,
    claim: legacy.claim,
    source: {
      ...legacy.source,
      submission: {
        id: submission.id,
        format: submission.format,
        createdAt: submission.createdAt,
        baseCommit: submission.baseCommit,
        artifactManifestDigest: submission.artifactManifestDigest,
        licenseAcceptanceRef: submission.licenseAcceptanceRef,
      },
    },
    assessment: legacy.assessment,
  };
}

function sourceOnlyPublicDecision(): FindingReviewPublicDecision {
  const legacy = publicDecision();
  return {
    ...legacy,
    evidence: { ...legacy.evidence, engineEvidence: null },
    hypothesis: null,
  };
}

function sourceOnlyPreviewFixture(): FindingReviewPreviewV2 {
  const decision = sourceOnlyPublicDecision();
  return {
    format: 'motive.finding-review.preview/0.1',
    submissionId,
    package: sourceOnlyPackageFixture(),
    packageDigest: decision.packageDigest,
    latestDecision: {
      ...decision,
      reviewerActorId: 'account:reviewer',
      previousDecisionId: null,
      duplicateOfDecisionId: null,
    },
  };
}

function sourceOnlyDecisionFixture(): FindingReviewDecisionResponse {
  return {
    format: 'motive.finding-review.decision/0.1',
    submissionId,
    ...sourceOnlyPublicDecision(),
    reviewerActorId: 'account:reviewer',
    previousDecisionId: null,
    duplicateOfDecisionId: null,
    replayed: false,
  };
}

describe('finding review response parsers', () => {
  it('preserves queued reviewer attribution in public, preview and history records', () => {
    const attribution = { reviewerAgentTokenId: id(70), reviewSubmissionId: id(71) };
    const publicValue = { ...publicFixture(), latestDecision: { ...sourceOnlyPublicDecision(), ...attribution } };
    expect(parseFindingPublic(publicValue, submissionId)).toBe(publicValue);
    const preview = sourceOnlyPreviewFixture(); Object.assign(preview.latestDecision!, attribution);
    expect(parseFindingPreview(preview, submissionId)).toBe(preview);
    const page = historyPage(1); Object.assign(page.items[0]!, attribution);
    expect(parseFindingHistory(page, submissionId)).toBe(page);
    const missingPair = structuredClone(publicValue) as any; delete missingPair.latestDecision.reviewSubmissionId;
    expect(() => parseFindingPublic(missingPair, submissionId)).toThrow();
    const selfReview = structuredClone(publicValue); selfReview.latestDecision.reviewSubmissionId = submissionId;
    expect(() => parseFindingPublic(selfReview, submissionId)).toThrow();
  });

  it('reads an append-native package only with an exact pre-test retained target', () => {
    const native = sourceOnlyPackageFixture();
    const reference = declared().researchReferences!.value[0]!;
    native.source.declaredIntent!.researchReferences = [reference];
    native.source.references.researchReferences = { timing: 'PRE_TEST_INTENT', value: [reference] };
    const target = { format: 'motive.research-delivery-target/0.1',
      selection: { mode: 'APPEND_EXISTING', scopeId: reference.scopeId, snapshotId: reference.snapshotId,
        snapshotDigest: reference.snapshotDigest, hypothesisId: reference.hypothesisId, observedUpdatedAt: reference.observedUpdatedAt },
      channelId: id(44), scopeConfigurationDigest: digest('a'), hypothesisContentDigest: digest('b'), statementDigest: digest('c') };
    const preview = { ...sourceOnlyPreviewFixture(), latestDecision: null,
      package: { ...native, format: 'motive.finding-review-package/0.3', source: { ...native.source, target } } };
    expect(parseFindingPreview(preview, submissionId)).toBe(preview);
    const changed = structuredClone(preview); changed.package.source.target.selection.hypothesisId = id(45);
    expect(() => parseFindingPreview(changed, submissionId)).toThrow();
    const late = structuredClone(preview); late.package.source.references.researchReferences!.timing = 'SUBMISSION_NOTES';
    expect(() => parseFindingPreview(late, submissionId)).toThrow();
    const legacy = { ...preview, package: { ...preview.package, format: 'motive.finding-review-package/0.2' } };
    expect(() => parseFindingPreview(legacy, submissionId)).toThrow();
  });

  it('returns strict public, eligibility, preview, and decision responses', () => {
    const publicValue = publicFixture(); const preview = previewFixture(); const decision = decisionFixture();
    const eligibility = { format: 'motive.finding-review.eligibility/0.1', submissionId,
      canReview: true, reason: 'ELIGIBLE' };
    expect(parseFindingPublic(publicValue, submissionId)).toBe(publicValue);
    expect(parseFindingEligibility(eligibility, submissionId)).toBe(eligibility);
    expect(parseFindingPreview(preview, submissionId)).toBe(preview);
    expect(parseFindingDecision(decision, submissionId)).toBe(decision);
  });

  it('accepts exact source-only previews, public decisions, history, and decision responses', () => {
    const preview = sourceOnlyPreviewFixture();
    expect(parseFindingPreview(preview, submissionId)).toBe(preview);

    const publicValue: FindingReviewPublicProjection = {
      ...publicFixture(), latestDecision: sourceOnlyPublicDecision(),
    };
    expect(parseFindingPublic(publicValue, submissionId)).toBe(publicValue);

    const sourceOnlyHistory = historyPage(1);
    sourceOnlyHistory.items = [{ ...sourceOnlyPublicDecision(), id: id(100), previousDecisionId: null }];
    sourceOnlyHistory.latestDecisionId = sourceOnlyHistory.items[0]!.id;
    expect(parseFindingHistory(sourceOnlyHistory, submissionId)).toBe(sourceOnlyHistory);

    const decision = sourceOnlyDecisionFixture();
    expect(parseFindingDecision(decision, submissionId)).toBe(decision);
  });

  it('rejects mixed or forged engine fields across source-only response shapes', () => {
    const mixedHypothesis = { ...publicFixture(), latestDecision: sourceOnlyPublicDecision() };
    mixedHypothesis.latestDecision.hypothesis = publicDecision().hypothesis;
    expect(() => parseFindingPublic(mixedHypothesis, submissionId)).toThrow('finding review response could not be read');

    const mixedEvidence = { ...publicFixture(), latestDecision: sourceOnlyPublicDecision() };
    mixedEvidence.latestDecision.evidence.engineEvidence = publicDecision().evidence.engineEvidence;
    expect(() => parseFindingPublic(mixedEvidence, submissionId)).toThrow('finding review response could not be read');

    const forgedDecision = sourceOnlyDecisionFixture() as FindingReviewDecisionResponse & {
      evidence: { engineEvidence: Record<string, unknown> };
    };
    forgedDecision.evidence.engineEvidence = { id: evidenceId, responseDigest: digest('d'), requestDigest: digest('e') };
    forgedDecision.hypothesis = publicDecision().hypothesis;
    expect(() => parseFindingDecision(forgedDecision, submissionId)).toThrow('finding review decision could not be read');

    const forgedPackage = sourceOnlyPreviewFixture() as FindingReviewPreviewV2 & { package: Record<string, unknown> };
    forgedPackage.package.engine = packageFixture().engine;
    expect(() => parseFindingPreview(forgedPackage, submissionId)).toThrow('finding review preview could not be read');

    const forgedDelivery = sourceOnlyPreviewFixture() as FindingReviewPreviewV2 & { package: Record<string, unknown> };
    forgedDelivery.package.delivery = packageFixture().delivery;
    expect(() => parseFindingPreview(forgedDelivery, submissionId)).toThrow('finding review preview could not be read');
  });

  it('binds current decisions to the package version without weakening historical parsing', () => {
    const nullEngineOnV1 = previewFixture();
    nullEngineOnV1.latestDecision!.evidence.engineEvidence = null;
    nullEngineOnV1.latestDecision!.hypothesis = null;
    expect(() => parseFindingPreview(nullEngineOnV1, submissionId)).toThrow('finding review preview could not be read');

    const engineDecisionOnV2 = sourceOnlyPreviewFixture();
    engineDecisionOnV2.latestDecision = {
      ...publicDecision(), reviewerActorId: 'account:reviewer', previousDecisionId: null,
      duplicateOfDecisionId: null,
    };
    expect(() => parseFindingPreview(engineDecisionOnV2, submissionId)).toThrow('finding review preview could not be read');

    const historicalV1 = historyPage(1);
    expect(parseFindingHistory(historicalV1, submissionId)).toBe(historicalV1);
    const historicalV2 = historyPage(1);
    historicalV2.items = [{ ...sourceOnlyPublicDecision(), id: id(100), previousDecisionId: null }];
    expect(parseFindingHistory(historicalV2, submissionId)).toBe(historicalV2);
  });

  it.each([
    ['finding ID', (value: FindingReviewPreviewV2) => { value.package.findingId = id(40); }],
    ['submission ID', (value: FindingReviewPreviewV2) => { value.package.source.submission.id = id(41); }],
    ['claim terms', (value: FindingReviewPreviewV2) => { value.package.claim.termsDigest = digest('0'); }],
    ['post-check report', (value: FindingReviewPreviewV2) => { value.package.source.postCheck.reportDigest = digest('0'); }],
    ['decision report', (value: FindingReviewPreviewV2) => { value.latestDecision!.evidence.reportDigest = digest('0'); }],
    ['legacy source intent field', (value: FindingReviewPreviewV2) => {
      (value.package.source.submission as unknown as Record<string, unknown>).sourceIntentId = id(8);
    }],
  ])('rejects an inconsistent source-only preview: %s', (_name, mutate) => {
    const value = sourceOnlyPreviewFixture();
    mutate(value);
    expect(() => parseFindingPreview(value, submissionId)).toThrow('finding review preview could not be read');
  });

  it('rejects public private-field leakage and envelope inconsistencies', () => {
    const leaked = publicFixture();
    (leaked.latestDecision as FindingReviewPublicDecision & { reviewerActorId: string }).reviewerActorId = 'account:private';
    expect(() => parseFindingPublic(leaked, submissionId)).toThrow('finding review response could not be read');

    const unavailable = publicFixture(); unavailable.available = false;
    expect(() => parseFindingPublic(unavailable, submissionId)).toThrow('finding review response could not be read');

    const wrongId = publicFixture(); wrongId.submissionId = id(99);
    expect(() => parseFindingPublic(wrongId, submissionId)).toThrow('finding review response could not be read');
  });

  it('enforces ACCEPT, DECLINE, and duplicate decision shapes', () => {
    const incompleteAccept = publicFixture(); incompleteAccept.latestDecision!.limitations = null;
    expect(() => parseFindingPublic(incompleteAccept, submissionId)).toThrow();

    const selfDuplicate = publicFixture(); Object.assign(selfDuplicate.latestDecision!, {
      novelty: 'DUPLICATE', duplicateOfSubmissionId: submissionId,
    });
    expect(() => parseFindingPublic(selfDuplicate, submissionId)).toThrow();

    const declined = publicFixture(); Object.assign(declined.latestDecision!, {
      decision: 'DECLINE', outcome: null, finding: null, limitations: null, novelty: null, duplicateOfSubmissionId: null,
    });
    expect(parseFindingPublic(declined, submissionId)).toBe(declined);
    declined.latestDecision!.finding = 'Private editorial text';
    expect(() => parseFindingPublic(declined, submissionId)).toThrow();

    const duplicate = decisionFixture(); duplicate.duplicateOfDecisionId = null;
    expect(() => parseFindingDecision(duplicate, submissionId)).toThrow();
  });

  it('binds eligibility state to its reason and requested submission', () => {
    const denied = { format: 'motive.finding-review.eligibility/0.1', submissionId,
      canReview: false, reason: 'ORIGINAL_CONTRIBUTOR' };
    expect(parseFindingEligibility(denied, submissionId)).toBe(denied);
    expect(() => parseFindingEligibility({ ...denied, canReview: true }, submissionId)).toThrow();
    expect(() => parseFindingEligibility({ ...denied, reason: 'ADMIN' }, submissionId)).toThrow();
    expect(() => parseFindingEligibility({ ...denied, submissionId: id(42) }, submissionId)).toThrow();
  });

  it.each([
    ['package finding ID', (value: FindingReviewPreviewV1) => { value.package.findingId = id(40); }],
    ['source submission ID', (value: FindingReviewPreviewV1) => { value.package.source.submission.id = id(41); }],
    ['claim terms', (value: FindingReviewPreviewV1) => { value.package.claim.termsDigest = digest('0'); }],
    ['post-check report', (value: FindingReviewPreviewV1) => { value.package.source.postCheck.reportDigest = digest('0'); }],
    ['source intent', (value: FindingReviewPreviewV1) => {
      (value.package.source.submission.sourceIntentPayload as { source: { submission: { id: string } } })
        .source.submission.id = id(42);
    }],
    ['declared intent', (value: FindingReviewPreviewV1) => { value.package.source.declaredIntent!.requestDigest = 'not-a-digest'; }],
    ['engine evidence', (value: FindingReviewPreviewV1) => {
      (value.package.engine.evidence.responseBody as { evidence: { id: string } }).evidence.id = id(43);
    }],
    ['decision evidence', (value: FindingReviewPreviewV1) => { value.latestDecision!.evidence.reportDigest = digest('0'); }],
  ])('rejects an inconsistent private preview: %s', (_name, mutate) => {
    const value = previewFixture(); mutate(value);
    expect(() => parseFindingPreview(value, submissionId)).toThrow('finding review preview could not be read');
  });

  it('requires lowercase sha256 digests and exact expected schemas', () => {
    const bareDigest = previewFixture(); bareDigest.packageDigest = 'a'.repeat(64);
    expect(() => parseFindingPreview(bareDigest, submissionId)).toThrow();
    const wrongFormat = previewFixture();
    (wrongFormat.package.source.artifact as { format: string }).format = 'motive.unknown/0.1';
    expect(() => parseFindingPreview(wrongFormat, submissionId)).toThrow();
    const arrayBody = previewFixture(); arrayBody.package.source.report.body = [];
    expect(() => parseFindingPreview(arrayBody, submissionId)).toThrow();
  });

  it('preserves bounded raw witness whitespace', () => {
    const value = previewFixture(); value.package.source.artifact.witness = '\n {"circles": []}\n';
    expect(parseFindingPreview(value, submissionId)).toBe(value);
  });

  it('accepts legacy and summarized finding review packages without rewriting them', () => {
    const legacy = previewFixture();
    expect(parseFindingPreview(legacy, submissionId)).toBe(legacy);

    const summarized = previewFixture();
    summarized.package.source.postCheck.publicSummary = {
      question: 'Did the checked candidate improve the reference score?',
      finding: 'The checker found no improvement in this candidate.',
    };
    expect(parseFindingPreview(summarized, submissionId)).toBe(summarized);
  });

  it('accepts a canonical optional experiment protocol and rejects malformed or reordered package values', () => {
    const value = previewFixture();
    value.package.source.declaredIntent!.experimentProtocol = { format: 'motive.experiment-protocol.v1',
      procedure: 'bounded-search/v1', inputs: [{ name: 'limit', value: '30' }, { name: 'seed', value: '17' }],
      purpose: 'REPLICATION' };
    value.latestDecision = null;
    expect(parseFindingPreview(value, submissionId)).toBe(value);
    const reordered = structuredClone(value);
    reordered.package.source.declaredIntent!.experimentProtocol!.inputs.reverse();
    expect(() => parseFindingPreview(reordered, submissionId)).toThrow('finding review preview could not be read');
    const malformed = structuredClone(value) as unknown as { package: { source: { declaredIntent: Record<string, unknown> } } };
    malformed.package.source.declaredIntent.experimentProtocol = null;
    expect(() => parseFindingPreview(malformed, submissionId)).toThrow('finding review preview could not be read');
  });

  it.each([
    null,
    { question: 'Only a question' },
    { finding: 'Only a finding' },
    { question: 'A question', finding: 'A finding', editorial: true },
    { question: 'q'.repeat(181), finding: 'A finding' },
    { question: 'A question', finding: 'f'.repeat(321) },
    { question: 'A question\ncontinued', finding: 'A finding' },
    { question: 'A question', finding: 'A finding\u0000hidden' },
  ])('rejects a malformed public summary in a finding review package: %j', publicSummary => {
    const value = previewFixture();
    (value.package.source.postCheck as unknown as Record<string, unknown>).publicSummary = publicSummary;
    expect(() => parseFindingPreview(value, submissionId)).toThrow('finding review preview could not be read');
  });

  it('accepts an older valid decision when a newer package has a different digest', () => {
    const value = previewFixture();
    value.packageDigest = digest('0');
    value.package.source.report.digest = digest('1');
    value.package.source.postCheck.reportDigest = digest('1');
    expect(parseFindingPreview(value, submissionId)).toBe(value);
  });

  it('uses sanitized errors for malformed success bodies', () => {
    const canary = 'credential-canary-private-value';
    for (const call of [
      () => parseFindingPublic({ format: canary }, submissionId),
      () => parseFindingEligibility({ reason: canary }, submissionId),
      () => parseFindingPreview({ package: canary }, submissionId),
      () => parseFindingDecision({ rationale: canary }, submissionId),
    ]) {
      try { call(); throw new Error('parser accepted malformed body'); }
      catch (error) {
        expect((error as Error).message).not.toContain(canary);
        expect((error as Error).message).toContain('Please try again.');
      }
    }
  });
});

describe('finding review history client',()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it('accepts root, paged, and exhausted-before-root history shapes',()=>{
    const root=historyPage(3);expect(parseFindingHistory(root,submissionId)).toBe(root);
    const paged=historyPage(20,true);expect(parseFindingHistory(paged,submissionId)).toBe(paged);
    const exhausted:FindingReviewHistoryPage={format:'motive.finding-review.history/0.1',submissionId,
      latestDecisionId:id(99),items:[],nextCursor:null};
    expect(parseFindingHistory(exhausted,submissionId)).toBe(exhausted);
    const none={...exhausted,latestDecisionId:null};expect(parseFindingHistory(none,submissionId)).toBe(none);
  });

  it('requires exact public decision fields and never accepts private review metadata',()=>{
    for(const field of ['reviewerActorId','duplicateOfDecisionId','accountId','reviewPackage'] as const){
      const value=historyPage(1) as FindingReviewHistoryPage&{items:Array<Record<string,unknown>>};
      value.items[0]![field]='private-canary';
      expect(()=>parseFindingHistory(value,submissionId)).toThrow('Finding review history could not be read');
    }
  });

  it('rejects broken adjacency, duplicate IDs, self links, and cycles',()=>{
    const broken=historyPage(3);broken.items[0]!.previousDecisionId=id(999);
    expect(()=>parseFindingHistory(broken,submissionId)).toThrow();
    const duplicate=historyPage(3);duplicate.items[1]!.id=duplicate.items[0]!.id;
    expect(()=>parseFindingHistory(duplicate,submissionId)).toThrow();
    const self=historyPage(1);self.items[0]!.previousDecisionId=self.items[0]!.id;
    expect(()=>parseFindingHistory(self,submissionId)).toThrow();
    const cycle=historyPage(20,true);cycle.items.at(-1)!.previousDecisionId=cycle.items[0]!.id;
    expect(()=>parseFindingHistory(cycle,submissionId)).toThrow();
  });

  it('binds the submission and accepts equal or reversed serialized timestamps',()=>{
    const value=historyPage(3);
    value.items[0]!.reviewedAt='2026-09-09T03:00:00.000Z';
    value.items[1]!.reviewedAt='2026-09-09T03:00:00.000Z';
    value.items[2]!.reviewedAt='2026-09-10T03:00:00.000Z';
    expect(parseFindingHistory(value,submissionId)).toBe(value);
    expect(()=>parseFindingHistory({...value,submissionId:id(2)},submissionId)).toThrow();
    expect(()=>parseFindingHistory(value,id(2))).toThrow();
  });

  it('enforces the exclusive cursor boundary and terminal-root semantics',()=>{
    const shortContinuation=historyPage(3);shortContinuation.items.at(-1)!.previousDecisionId=id(900);
    shortContinuation.nextCursor=shortContinuation.items.at(-1)!.id;
    expect(()=>parseFindingHistory(shortContinuation,submissionId)).toThrow();
    const wrongCursor=historyPage(20,true);wrongCursor.nextCursor=id(901);
    expect(()=>parseFindingHistory(wrongCursor,submissionId)).toThrow();
    const rootWithCursor=historyPage(20);rootWithCursor.nextCursor=rootWithCursor.items.at(-1)!.id;
    expect(()=>parseFindingHistory(rootWithCursor,submissionId)).toThrow();
    const malformed=historyPage(20,true);malformed.nextCursor='not-a-cursor';
    expect(()=>parseFindingHistory(malformed,submissionId)).toThrow();
    const noLatest=historyPage(1);noLatest.latestDecisionId=null;
    expect(()=>parseFindingHistory(noLatest,submissionId)).toThrow();
  });

  it('keeps pages and decision text within their declared bounds',()=>{
    const tooMany=historyPage(20,true);tooMany.items.push(historyDecision(500,id(900)));
    expect(()=>parseFindingHistory(tooMany,submissionId)).toThrow();
    const rationale=historyPage(1);rationale.items[0]!.rationale='x'.repeat(2_001);
    expect(()=>parseFindingHistory(rationale,submissionId)).toThrow();
    const finding=historyPage(1);finding.items[0]!.finding='x'.repeat(2_001);
    expect(()=>parseFindingHistory(finding,submissionId)).toThrow();
  });

  it('reads the exact public route without account authorization and bypasses caches',async()=>{
    const page=historyPage(20,true);const before=id(42);
    const request=vi.fn(async(_path:string,_init?:RequestInit)=>new Response(JSON.stringify(page),
      {status:200,headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',request);
    await expect(readFindingHistory(submissionId,before,new AbortController().signal)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe(`/api/public/projects/circle-packing/submissions/${submissionId}/finding-review/history?before=${before}`);
    const init=request.mock.calls[0]![1] as RequestInit;
    expect(init).toMatchObject({method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',headers:{Accept:'application/json'}});
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects malformed request IDs before fetch',async()=>{
    const request=vi.fn();vi.stubGlobal('fetch',request);
    await expect(readFindingHistory(id(10).toUpperCase(),null,new AbortController().signal))
      .rejects.toMatchObject({reset:false});
    await expect(readFindingHistory(submissionId,'not-a-cursor',new AbortController().signal))
      .rejects.toMatchObject({reset:false});
    expect(request).not.toHaveBeenCalled();
  });

  it('propagates caller aborts while sanitizing network failures',async()=>{
    const controller=new AbortController();const reason=new DOMException('caller stopped','AbortError');controller.abort(reason);
    vi.stubGlobal('fetch',vi.fn(async(_path:string,init:RequestInit)=>{throw init.signal?.reason;}));
    await expect(readFindingHistory(submissionId,null,controller.signal)).rejects.toBe(reason);
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('private-network-canary');}));
    await expect(readFindingHistory(submissionId,null,new AbortController().signal)).rejects.toSatisfy((error:unknown)=>{
      expect(error).toBeInstanceOf(FindingHistoryReadError);expect(error).toMatchObject({reset:false});
      expect((error as Error).message).not.toContain('private-network-canary');return true;
    });
  });

  it('resets only on 404 and preserves state for other failures or malformed JSON',async()=>{
    for(const [response,reset] of [
      [new Response('missing',{status:404}),true],
      [new Response('private-server-canary',{status:503}),false],
      [new Response('{bad json',{status:200}),false],
    ] as const){
      vi.stubGlobal('fetch',vi.fn(async()=>response));
      await expect(readFindingHistory(submissionId,null,new AbortController().signal)).rejects.toSatisfy((error:unknown)=>{
        expect(error).toBeInstanceOf(FindingHistoryReadError);expect(error).toMatchObject({reset});
        expect((error as Error).message).not.toMatch(/missing|private-server-canary|bad json/);return true;
      });
    }
  });
});
