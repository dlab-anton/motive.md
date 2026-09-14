import type { Digest } from '../../packages/domain/src/contracts.ts';
import type { CircleEvaluatorReport } from '../../packages/evaluator-circle/src/contract.ts';
import type { SubmissionInvestigationInput } from './participation.ts';

export type HostedCircleResultStatus = 'VALID' | 'REJECTED';
export type HostedCircleReviewDecision = 'ACCEPTED' | 'REJECTED';
export type HostedInvestigationStatus = 'VALID' | 'INVALID' | 'NOT_PROVIDED';
export type HostedInvestigationValidationCode = 'VALID' | 'NOT_PROVIDED' | 'INVALID_STRUCTURE' | 'INVALID_REFERENCE';

export type HostedCircleReview = {
  id: string;
  decision: HostedCircleReviewDecision;
  decidedAt: string;
};

export type HostedCircleResultSummary = {
  id: string;
  attemptId: string;
  model: { id: string; inferenceProfileDigest: Digest };
  status: HostedCircleResultStatus;
  exactScore: string | null;
  exceedsReference: boolean | null;
  artifactManifestDigest: Digest;
  candidateDigest: Digest;
  evaluationProfileDigest: Digest;
  reportDigest: Digest;
  artifactAvailable: boolean;
  investigation: {
    status: HostedInvestigationStatus;
    href: string;
  };
  createdAt: string;
  review: HostedCircleReview | null;
};

export type HostedCirclePublicResults = {
  projectSlug: string;
  totalResults: number;
  acceptedResults: number;
  bestAccepted: HostedCircleResultSummary | null;
  results: readonly HostedCircleResultSummary[];
};

export type HostedCirclePublicReport = {
  resultId: string;
  reportDigest: Digest;
  report: CircleEvaluatorReport;
  review: HostedCircleReview | null;
};

export type HostedCirclePublicArtifact = {
  resultId: string;
  filename: 'candidate.json';
  mediaType: 'application/json';
  digest: Digest;
  bytes: Uint8Array;
};

export type HostedCirclePublicInvestigation = {
  format: 'motive.hosted-investigation.public.v1';
  resultId: string;
  status: HostedInvestigationStatus;
  binding: {
    attemptId: string;
    artifactManifestDigest: Digest;
    investigationDigest: Digest | null;
    model: { id: string; inferenceProfileDigest: Digest };
  };
  investigation: SubmissionInvestigationInput | null;
  validationCode: HostedInvestigationValidationCode;
  interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' | 'NOT_PROVIDED' | 'INVALID_STRUCTURE' | 'INVALID_REFERENCE';
  notice: 'Hosted investigation notes are agent statements retained separately from the numerical evaluator report and human acceptance.';
};

export type ReviewHostedCircleResultInput = {
  decision: HostedCircleReviewDecision;
  rationale: string;
  expected: {
    attemptId: string;
    artifactManifestDigest: Digest;
    evaluationProfileDigest: Digest;
    reportDigest: Digest;
  };
};
