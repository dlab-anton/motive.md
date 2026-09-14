import type { SubmissionMotiveReference, SubmissionResearchContext, SubmissionResearchReference,
  SubmissionReportStatus } from './participation';
import type { PublicResearchSummary } from './research-summary';
import type { ExperimentProtocol } from './experiment-protocol';
import type { ResearchDeliveryTargetBinding } from './research-delivery-target';

export type FindingReviewDecisionKind = 'ACCEPT' | 'DECLINE';
export type FindingOutcome = 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE';
export type FindingNovelty = 'DISTINCT' | 'DUPLICATE';
export type FindingReferenceTiming = 'PRE_TEST_INTENT' | 'SUBMISSION_NOTES';
export type TimedFindingReference<T> = { timing: FindingReferenceTiming; value: T };
export type FindingDeclaredReferences = {
  researchContext: TimedFindingReference<SubmissionResearchContext> | null;
  researchReferences: TimedFindingReference<SubmissionResearchReference[]> | null;
  motiveReferences: TimedFindingReference<SubmissionMotiveReference[]> | null;
};
export type FindingDeclaredIntent = { proposal: string; expectation: string; conditions: string[];
  researchContext: SubmissionResearchContext | null;
  researchReferences: SubmissionResearchReference[] | null;
  motiveReferences: SubmissionMotiveReference[] | null;
  experimentProtocol?: ExperimentProtocol;
  declaredAt: string; requestDigest: string };

export type FindingReviewEvidenceReference = {
  artifactDigest: string;
  reportDigest: string;
  investigationDigest: string;
  postCheckRequestDigest: string;
  reproducibility: null | {
    requestDigest: string;
    solverSourceDigest: string;
    trialResultsDigest: string;
  };
  declaredIntent: FindingDeclaredIntent | null;
  declared: FindingDeclaredReferences;
  engineEvidence: null | {
    id: string;
    responseDigest: string;
  };
};

export type FindingReviewPublicDecision = {
  id: string;
  /** Present for a decision backed by a completed contributor replication. */
  reviewerAgentTokenId?: string;
  reviewSubmissionId?: string;
  decision: FindingReviewDecisionKind;
  outcome: FindingOutcome | null;
  finding: string | null;
  limitations: string | null;
  novelty: FindingNovelty | null;
  duplicateOfSubmissionId: string | null;
  rationale: string;
  reviewedAt: string;
  packageDigest: string;
  evidence: FindingReviewEvidenceReference;
  hypothesis: null | {
    id: string;
    statement: string;
    responseDigest: string;
  };
};

export type FindingReviewHistoryDecision = FindingReviewPublicDecision & {
  previousDecisionId: string | null;
};

export type FindingReviewHistoryPage = {
  format: 'motive.finding-review.history/0.1';
  submissionId: string;
  latestDecisionId: string | null;
  items: FindingReviewHistoryDecision[];
  nextCursor: string | null;
};

export type FindingReviewPublicProjection = {
  format: 'motive.finding-review.public/0.1';
  submissionId: string;
  available: boolean;
  reason: string | null;
  latestDecision: FindingReviewPublicDecision | null;
};

export type FindingReviewEligibilityReason = 'ELIGIBLE' | 'NOT_FOUND' | 'ACCOUNT_INACTIVE'
  | 'MEMBERSHIP_REQUIRED' | 'ORIGINAL_CONTRIBUTOR' | 'NOT_COMPLETED' | 'POST_CHECK_REQUIRED'
  | 'COMPLETE_DELIVERY_REQUIRED';

export type FindingReviewEligibility = {
  format: 'motive.finding-review.eligibility/0.1';
  submissionId: string;
  canReview: boolean;
  reason: FindingReviewEligibilityReason;
};

type FindingReviewPackageSource = {
  declaredIntent: FindingDeclaredIntent | null;
  attribution: { contributorActorId: string; agentTokenId: string; agentName: string };
  investigation: { proposal: string; expectation: string; conditions: string[]; observations: string[];
    assessment: string; nextAction: string; digest: string };
  references: FindingReviewEvidenceReference['declared'];
  artifact: { format: string; witness: string; digest: string };
  report: { status: SubmissionReportStatus; body: unknown; digest: string };
  postCheck: { requestDigest: string; reportDigest: string; assessment: string; nextAction: string;
    publicSummary?: PublicResearchSummary; createdAt: string };
  reproducibility: FindingReviewEvidenceReference['reproducibility'];
};

type FindingReviewPackageRoot = {
  findingId: string;
  project: { id: string; slug: 'circle-packing'; revision: number };
  workOrder: { id: string; revision: number; projectRevision: number; termsDigest: string; terms: unknown };
  claim: { id: string; leaseEpoch: number; termsDigest: string; completedAt: string };
  assessment: { engineHypothesisSupport: 'UNASSESSED'; engineConclusionApproval: 'UNASSESSED' };
};

export type FindingReviewPackageV1 = FindingReviewPackageRoot & {
  format: 'motive.finding-review-package/0.1';
  source: FindingReviewPackageSource & {
    submission: { id: string; format: string; createdAt: string; baseCommit: string; artifactManifestDigest: string;
      licenseAcceptanceRef: string; sourceIntentId: string; sourceIntentPayloadDigest: string; sourceIntentPayload: unknown };
  };
  delivery: { id: string; scopeId: string; engineActor: string; createdAt: string };
  engine: {
    hypothesis: { requestBody: unknown; requestBodyDigest: string; requestDigest: string; id: string;
      responseBody: unknown; responseDigest: string };
    evidence: { requestBody: unknown; requestBodyDigest: string; requestDigest: string; id: string;
      responseBody: unknown; responseDigest: string };
  };
};

export type FindingReviewPackageV2 = FindingReviewPackageRoot & {
  /** Canonical digest data is bounded to controlled ASCII object keys and JSON safe-integer numbers. */
  format: 'motive.finding-review-package/0.2';
  source: FindingReviewPackageSource & {
    submission: { id: string; format: string; createdAt: string; baseCommit: string; artifactManifestDigest: string;
      licenseAcceptanceRef: string };
  };
};

export type FindingReviewPackageV3 = FindingReviewPackageRoot & {
  /** Target-aware native review of the exact pre-test observed thread. */
  format: 'motive.finding-review-package/0.3';
  source: FindingReviewPackageSource & {
    submission: { id: string; format: string; createdAt: string; baseCommit: string; artifactManifestDigest: string;
      licenseAcceptanceRef: string };
    target: ResearchDeliveryTargetBinding;
  };
};

export type FindingReviewPackage = FindingReviewPackageV1 | FindingReviewPackageV2 | FindingReviewPackageV3;

export type FindingReviewPrivateDecision = FindingReviewPublicDecision & {
  reviewerActorId: string;
  previousDecisionId: string | null;
  duplicateOfDecisionId: string | null;
};

export type FindingReviewPreview = {
  format: 'motive.finding-review.preview/0.1';
  submissionId: string;
  package: FindingReviewPackage;
  packageDigest: string;
  latestDecision: FindingReviewPrivateDecision | null;
};

export type FindingReviewAgentPreview = FindingReviewPreview & {
  reviewerAgentTokenId: string;
  reviewSubmissionId: string;
  reviewDecision: FindingReviewPrivateDecision | null;
};

export type FindingReviewDecisionInput = {
  packageDigest: string;
  expectedDecisionId: string | null;
  decision: FindingReviewDecisionKind;
  outcome: FindingOutcome | null;
  finding: string | null;
  limitations: string | null;
  novelty: FindingNovelty | null;
  duplicateOfSubmissionId: string | null;
  rationale: string;
};

export type FindingReviewDecisionResponse = FindingReviewPrivateDecision & {
  format: 'motive.finding-review.decision/0.1';
  submissionId: string;
  replayed: boolean;
};

export type FindingReviewAgentDecisionResponse = FindingReviewDecisionResponse & {
  reviewerAgentTokenId: string;
  reviewSubmissionId: string;
  memoryAdmission: FindingReviewMemoryStatus;
};

export type FindingReviewMemoryStatus =
  | { status: 'ADMITTED'; admissionDecisionId: string }
  | { status: 'PENDING'; reason: 'OWNER_APPROVAL_REQUIRED' | 'CONTRACT_UNAVAILABLE'
      | 'REVIEW_NO_LONGER_CURRENT' | 'MEMORY_UNAVAILABLE' }
  | { status: 'NOT_REQUESTED'; reason: 'FINDING_DECLINED' };
