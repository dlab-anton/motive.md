import type { PublicPostCheckAssessment } from './participation';
import type { ResearchDeliveryTargetBinding } from './research-delivery-target';

export type ResearchEvidenceMotiveContribution = {
  format: 'motive.research-evidence-contribution/0.1';
  deliveryId: string;
  mode: 'APPEND_EXISTING';
  sourceSubmissionId: string;
  reportDigest: string;
  reportHref: string;
  investigationHref: string;
  postCheckAssessmentHref: string;
  reproducibilityHref: string | null;
  observationManifestHref: string;
  observationManifestDigest: string;
  originalContributor: { agentTokenId: string; agentName: string };
  target: ResearchDeliveryTargetBinding;
  observedFinding: null | {
    decisionId: string;
    packageDigest: string;
    outcome: 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE';
    finding: string;
    limitations: string;
    novelty: 'DISTINCT' | 'DUPLICATE';
    duplicateOfSubmissionId: string | null;
    rationale: string;
    reviewerKind: 'ACCOUNT' | 'AGENT';
    reviewerAgentTokenId: string | null;
    reviewSubmissionId: string | null;
    reviewedAt: string;
    observedAt: string;
    disposition: 'HISTORICAL_MOTIVE_DECISION';
  };
  evidenceBinding: {
    hypothesisId: string;
    evidenceId: string;
    contentDigest: string;
    source: string;
    createdBy: string;
    evidenceType: 'neutral';
    responseDigest: string;
  };
  labels: { evidence: 'NEUTRAL'; context: 'HISTORICAL_TESTED_CONTEXT';
    hypothesisSupport: 'UNASSESSED'; conclusionApproval: 'UNASSESSED' };
};

export type ResearchScopePublic = {
  projectSlug: string;
  scopeId: string;
  channelName: string;
  status: 'CONNECTED';
  verifiedAt: string;
};

export type ResearchEvidenceSnapshot = {
  id: string; createdAt: string; contentDigest: string; content: string;
  source: string | null; evidenceType: 'supporting' | 'contradicting' | 'neutral';
  strength: number | null; confidenceAfter: number | null; createdBy: string;
  motiveContribution?: ResearchEvidenceMotiveContribution;
};
export type ResearchMotiveSubmission = {
  submissionId: string;
  reportDigest: string;
  reportHref: string;
  investigationHref: string | null;
  postCheckAssessmentHref: string | null;
  postCheckAssessment: PublicPostCheckAssessment | null;
  reproducibilityHref: string | null;
  latestAdmissionReview?: {
    decision: 'ADMIT' | 'DECLINE';
    rationale: string;
    reviewedAt: string;
    disposition: 'HISTORICAL_DELIVERY_REVIEW';
    hypothesisSupport: 'UNASSESSED';
    conclusionApproval: 'UNASSESSED';
  };
  latestFindingReview?: {
    id: string;
    decision: 'ACCEPT' | 'DECLINE';
    outcome: 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE' | null;
    finding: string | null;
    limitations: string | null;
    novelty: 'DISTINCT' | 'DUPLICATE' | null;
    duplicateOfSubmissionId: string | null;
    rationale: string;
    reviewedAt: string;
    packageDigest: string;
    reviewedHypothesisId: string;
    reviewedHypothesisResponseDigest: string;
    reviewedEvidenceId: string;
    reviewedEvidenceResponseDigest: string;
    artifactDigest: string;
    reportDigest: string;
    disposition: 'HISTORICAL_FINDING_REVIEW';
    hypothesisSupport: 'UNASSESSED';
    conclusionApproval: 'UNASSESSED';
  };
};
export type ResearchHypothesisSnapshot = {
  id: string; updatedAt: string; contentDigest: string; statement: string;
  context: string | null; falsificationCriteria: string | null; status: string;
  confidence: number | null; parentId: string | null;
  outcome: { result: string | null; narrative: string | null; evidenceSummary: string | null; actualVsPredicted: string | null; effectSize: string | number | null } | null;
  motiveSubmission?: ResearchMotiveSubmission;
  evidence: ResearchEvidenceSnapshot[]; evidenceTotal: number; evidenceTruncated: boolean;
};
export type ResearchInsightSnapshot = {
  id: string; updatedAt: string; contentDigest: string; insightType: string;
  content: string; createdBy: string;
};
export type ResearchContextSnapshot = {
  format: 'motive.research-context.v1'; snapshotId: string; scopeId: string;
  projectSlug: string; channelName: string; channelGoal: string; retrievedAt: string;
  engineReadCompletedAt?: string;
  snapshotDigest: string; hypotheses: ResearchHypothesisSnapshot[];
  hypothesesTotal: number; hypothesesTruncated: boolean; activeHypothesesTotal: number; archivedHypothesesTotal: number;
  insights: ResearchInsightSnapshot[]; insightsTotal: number; insightsTruncated: boolean;
  page: { activeOffset: number; archivedOffset: number; insightOffset: number; activeLimit: 6; archivedLimit: 6; insightLimit: 20 };
  notice: 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.';
};
export type ResearchHypothesisContextSnapshot = {
  format: 'motive.research-hypothesis-context.v1'; snapshotId: string; scopeId: string;
  projectSlug: string; channelName: string; channelGoal: string; retrievedAt: string;
  engineReadCompletedAt?: string;
  snapshotDigest: string;
  selection: { kind: 'hypothesis'; hypothesisId: string; evidenceOffset: number; evidenceLimit: 20 };
  hypotheses: [ResearchHypothesisSnapshot];
  notice: 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.';
};
export type ResearchRetainedSnapshot = ResearchContextSnapshot | ResearchHypothesisContextSnapshot;
export type ResearchContextPage = { activeOffset?: number; archivedOffset?: number; insightOffset?: number };
export type ResearchSnapshotReference = {
  scopeId: string; snapshotId: string; hypothesisId: string; evidenceIds: string[];
  observedUpdatedAt: string; snapshotDigest: string;
};
