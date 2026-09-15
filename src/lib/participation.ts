import type { PublicResearchSummary } from './research-summary';
import type { ExperimentProtocol } from './experiment-protocol';
import type { ResearchDeliveryTargetSelection } from './research-delivery-target';
import type { AgentResearchSyncCheckpoint } from './research-delivery-policy';

export const PARTICIPATION_PROJECT_SLUG = 'circle-packing' as const;
export const PARTICIPATION_WITNESS_FORMAT = 'motive.csqv.witness.v1' as const;

export type JoinParticipationInput = {
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  publishDisplayName: boolean;
  acceptReferenceTerms: true;
};

export type AgentTokenProjection = {
  id: string;
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  agentName: string;
  modelName: string | null;
  publicDisplayName: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

export type AssignmentStatus = 'AVAILABLE' | 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'REVOKED' | 'COMPLETED';
export type AssignmentIntentProjection = {
  claimId: string;
  leaseEpoch: number;
  workOrderRevision: number;
  termsDigest: string;
  proposal: string;
  expectation: string;
  conditions: string[];
  researchContext?: SubmissionResearchContext;
  researchReferences?: SubmissionResearchReference[];
  motiveReferences?: SubmissionMotiveReference[];
  experimentProtocol?: ExperimentProtocol;
  researchDeliveryTarget?: ResearchDeliveryTargetSelection;
  protocolFingerprint?: string;
  declaredAt: string;
};
export type AssignmentProjection = {
  id: string;
  credentialId: string;
  claimId: string | null;
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  projectRevision: number;
  workOrderId: string;
  workOrderRevision: number;
  agreementId: string;
  termsDigest: string;
  status: AssignmentStatus;
  leaseEpoch: number | null;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  intent?: AssignmentIntentProjection | null;
};

export type SubmissionReportStatus = 'VALID' | 'REJECTED' | 'INCONCLUSIVE';
export type AcceptanceStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export type SubmissionSummary = {
  id: string;
  assignmentId: string;
  contributorId: string;
  contributorDisplayName: string | null;
  agentName: string;
  modelName: string | null;
  createdAt: string;
  reportStatus: SubmissionReportStatus;
  artifactSha256: string;
  exactScore: string | null;
  exceedsReference: boolean | null;
  acceptance: AcceptanceStatus;
  artifactHref: string;
  reportHref: string;
  investigationHref: string | null;
  postCheckAssessmentHref: string | null;
  reproducibilityHref: string | null;
};

export type JoinParticipationResponse = {
  token: string;
  credential: AgentTokenProjection;
  assignment: AssignmentProjection;
  warning: 'The token is shown in this response only. Send it only in the Authorization header.';
};

export type ParticipationCredentialLoopProgress = {
  credentialId: string;
  completedAttempts: number;
  checkedSubmissions: number;
  recordedUpdates: number;
  completedCycles: number;
  /** Current completed tasks with post-check updates attributed to this credential. */
  acceptedDistinctFindings?: number;
  /** 100 points per completed task with a post-check update. */
  xp?: number;
};

export type AgentSessionRunMode = 'ONE_TASK' | 'THIRTY_MINUTES' | 'UNTIL_STOPPED';
export type SetAgentSessionInput =
  | { status: 'RUNNING'; runMode: AgentSessionRunMode }
  | { status: 'PAUSED'; runMode: AgentSessionRunMode; stopReason?: string };
export type AgentSessionProjection = {
  credentialId: string;
  status: 'RUNNING' | 'PAUSED' | null;
  runMode: AgentSessionRunMode | null;
  declaredAt: string | null;
  stopReason: string | null;
  presence: 'ACTIVE' | 'PAUSED' | 'UNKNOWN';
  presenceReason: 'FRESH_CONTACT' | 'EXPLICITLY_PAUSED' | 'NO_DECLARATION' | 'STALE_CONTACT'
    | 'RUN_LIMIT_REACHED' | 'ACCESS_REVOKED' | 'ACCESS_EXPIRED';
  lastContactAt: string | null;
  accessStatus: 'AVAILABLE' | 'REVOKED' | 'EXPIRED';
};

export type ParticipationMeResponse = {
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  canReview: boolean;
  canManageReviewers?: boolean;
  credentials: AgentTokenProjection[];
  assignments: AssignmentProjection[];
  submissions: SubmissionSummary[];
  loopProgress?: ParticipationCredentialLoopProgress[];
  sessions?: AgentSessionProjection[];
};

export type AgentAssignmentResponse = {
  credential: AgentTokenProjection;
  assignment: AssignmentProjection;
  submissionPath: string;
};

export type AgentWorkQueueValidationTarget = {
  submission: SubmissionSummary;
  reference: SubmissionMotiveReference;
};

export type AgentWorkQueueFindingReviewTarget = {
  reviewSubmissionId: string;
  targetSubmissionId: string;
  previewHref: string;
  decisionHref: string;
};

export type AgentWorkQueueResponse = {
  format: 'motive.agent-work-queue.v1';
  assignment: AssignmentProjection;
  nextTask:
    | { kind: 'RESUME'; reason: 'ACTIVE_CLAIM'; target: null }
    | { kind: 'DISCOVERY'; reason: 'DISCOVERY_TURN' | 'EMPTY_PEER_POOL'; target: null }
    | { kind: 'VALIDATION'; reason: 'PEER_VALIDATION_DUE'; target: AgentWorkQueueValidationTarget }
    | { kind: 'FINDING_REVIEW'; reason: 'COMPLETED_REPLICATION_PENDING_REVIEW'; target: AgentWorkQueueFindingReviewTarget }
    | { kind: 'RESEARCH_SYNC'; reason: 'READY_RESEARCH_DELIVERY'; researchDelivery: AgentResearchSyncCheckpoint };
  cadence: { discovery: 1; validation: 1 };
  validationAuthority: 'EVIDENCE_ONLY' | 'REPLICATION_BOUND_FINDING_DECISION';
};

export type ClaimAssignmentInput = Record<string, never>;
export type FencedAssignmentInput = { leaseEpoch: number };
export type ReleaseAssignmentInput = FencedAssignmentInput & { stopReason?: string };
export type SubmissionResearchReference = {
  scopeId: string;
  snapshotId: string;
  snapshotDigest: string;
  hypothesisId: string;
  observedUpdatedAt: string;
  evidenceIds: string[];
};
/** Identifies one immutable Motive checker result; citation does not imply acceptance, admission, or hypothesis support. */
export type SubmissionMotiveReference = {
  submissionId: string;
  reportDigest: string;
  artifactDigest: string;
};
/** Identifies the retained baseline supplied with the investigation; it does not prove that the contributor used it in its reasoning. */
export type SubmissionResearchContext = {
  scopeId: string;
  snapshotId: string;
  snapshotDigest: string;
};
export type DeclareAssignmentIntentInput = FencedAssignmentInput & {
  proposal: string;
  expectation: string;
  conditions: string[];
  researchContext?: SubmissionResearchContext;
  researchReferences?: SubmissionResearchReference[];
  motiveReferences?: SubmissionMotiveReference[];
  experimentProtocol?: ExperimentProtocol;
  researchDeliveryTarget?: ResearchDeliveryTargetSelection;
};
export type SubmissionInvestigationInput = {
  format: 'motive.investigation.v1';
  proposal: string;
  expectation: string;
  conditions: string[];
  observations: string[];
  assessment: string;
  nextAction: string;
  researchContext?: SubmissionResearchContext;
  researchReferences?: SubmissionResearchReference[];
  motiveReferences?: SubmissionMotiveReference[];
  experimentProtocol?: ExperimentProtocol;
  researchDeliveryTarget?: ResearchDeliveryTargetSelection;
};
export type SubmitCircleWitnessInput = FencedAssignmentInput & { witness: string; investigation?: SubmissionInvestigationInput };
export type CompleteAssignmentInput = FencedAssignmentInput & { submissionId: string };
export type ReviewSubmissionInput = { decision: 'ACCEPTED' | 'REJECTED'; rationale: string };
export type PostCheckAssessmentInput = {
  reportDigest: string;
  assessment: string;
  nextAction: string;
  publicSummary?: PublicResearchSummary;
};

export type SubmissionReproducibilityInput = {
  reportDigest: string;
  solverSource: string;
  trialResults: string;
};

export type PublicSubmissionReproducibilityFile = {
  role: 'SOLVER_SOURCE' | 'TRIAL_RESULTS';
  name: 'solver-source.txt' | 'trial-results.txt';
  mediaType: 'text/plain';
  bytes: number;
  digest: string;
  href: string;
};

export type PublicSubmissionReproducibility = {
  format: 'motive.submission-reproducibility.public.v1';
  submissionId: string;
  reportDigest: string;
  createdAt: string;
  attribution: {
    kind: 'AGENT_DECLARED';
    credentialId: string;
    agentName: string;
    modelName: string | null;
    contributorDisplayName: string | null;
  };
  files: [PublicSubmissionReproducibilityFile, PublicSubmissionReproducibilityFile];
  disposition: 'AGENT_DECLARED_UNVERIFIED';
  notice: 'These contributor-supplied source and trial files are tied to the retained checker report for reproducibility. Motive did not execute or check them, and they do not indicate support or acceptance.';
};

export type PublicPostCheckAssessment = {
  format: 'motive.post-check-assessment.public.v1';
  submissionId: string;
  reportDigest: string;
  createdAt: string;
  attribution: {
    kind: 'AGENT_DECLARED';
    credentialId: string;
    agentName: string;
    modelName: string | null;
    contributorDisplayName: string | null;
  };
  assessment: string;
  nextAction: string;
  publicSummary?: PublicResearchSummary;
  disposition: 'AGENT_DECLARED_UNVERIFIED';
  notice: 'This post-check assessment and next action are contributor statements tied to the protected checker report. They do not indicate support or acceptance.';
};

export type PublicSubmissionInvestigation = {
  format: 'motive.investigation.public.v1';
  submissionId: string;
  createdAt: string;
  attribution: {
    kind: 'AGENT_DECLARED';
    agentName: string;
    modelName: string | null;
    contributorDisplayName: string | null;
  };
  investigation: SubmissionInvestigationInput;
  claimIntent?: Pick<AssignmentIntentProjection, 'claimId' | 'proposal' | 'expectation' | 'conditions' | 'researchContext' | 'researchReferences' | 'motiveReferences' | 'experimentProtocol' | 'researchDeliveryTarget' | 'protocolFingerprint' | 'workOrderRevision' | 'declaredAt'> | null;
  evidence: {
    reportStatus: SubmissionReportStatus;
    exactScore: string | null;
    exceedsReference: boolean | null;
    reportHref: string;
  };
  interpretationStatus: 'AGENT_DECLARED_UNVERIFIED';
  notice: 'The proposal, expectation, observations, assessment, and next action are contributor statements. A research-context citation records the retained baseline supplied with the investigation; it does not prove the contributor used it in its reasoning. The protected checker report is separate evidence.';
};

export type ParticipationActivity = {
  id: string;
  type: 'CONTRIBUTOR_JOINED' | 'ASSIGNMENT_CLAIMED' | 'ASSIGNMENT_INTENT_DECLARED' | 'ASSIGNMENT_RELEASED' | 'SUBMISSION_CHECKED' | 'ASSIGNMENT_COMPLETED' | 'SUBMISSION_REVIEWED' | 'SUBMISSION_ASSESSED';
  createdAt: string;
  contributorDisplayName: string | null;
  submissionId: string | null;
  detail: string;
};

export type ParticipationProjectLoopProgress = {
  activeAgents: number;
  completedAttempts: number;
  checkedSubmissions: number;
  recordedUpdates: number;
  completedCycles: number;
};

export type PublicActiveResearchIntent = {
  assignmentId: string;
  claimId: string;
  agentName: string;
  contributorDisplayName: string | null;
  proposal: string;
  expectation: string;
  conditions: string[];
  motiveReferences?: SubmissionMotiveReference[];
  experimentProtocol?: ExperimentProtocol;
  researchDeliveryTarget?: ResearchDeliveryTargetSelection;
  protocolFingerprint?: string;
  workOrderRevision: number;
  declaredAt: string;
  expiresAt: string;
};

export type ExperimentProtocolMatch = {
  claimId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'RELEASED';
  purpose: ExperimentProtocol['purpose'];
  proposal: string;
  declaredAt: string;
  expiresAt: string;
  stopReason: string | null;
  submission: null | { submissionId: string; reportDigest: string; artifactDigest: string };
};

export type ExperimentProtocolMatches = {
  format: 'motive.experiment-protocol-matches.v1';
  experimentProtocol: ExperimentProtocol;
  protocolFingerprint: string;
  matches: ExperimentProtocolMatch[];
  nextCursor: string | null;
  notice: 'Exact declared protocol inputs are advisory coordination data. They do not reserve an idea or establish geometric or scientific equivalence.';
};

export type PublicResearchHandoff = {
  id: string;
  claimId: string;
  assignmentId: string;
  agentName: string;
  contributorDisplayName: string | null;
  createdAt: string;
  stopReason: string;
  intent: {
    proposal: string;
    expectation: string;
    conditions: string[];
    workOrderRevision: number;
    declaredAt: string;
  } | null;
  interpretationStatus: 'AGENT_DECLARED_UNVERIFIED';
};

export type PublicResearchHandoffPage = {
  format: 'motive.research-handoff-page/0.1';
  items: PublicResearchHandoff[];
  nextCursor: string | null;
};

export type PublicResearchUpdate = {
  submissionId: string;
  reportDigest: string;
  agentName: string;
  contributorDisplayName: string | null;
  createdAt: string;
  proposal: string | null;
  expectation: string | null;
  latestAssessment: string | null;
  assessmentTiming: 'AFTER_CHECK' | 'AT_SUBMISSION' | null;
  assessmentSourceDigest?: string | null;
  publicSummary?: PublicResearchSummary;
  observedOutcome: {
    reportStatus: SubmissionReportStatus;
    exactScore: string | null;
    exceedsReference: boolean | null;
    reportHref: string;
  };
  completed: boolean;
  memoryReview?: {
    latestDecision: {
      decision: 'ADMIT' | 'DECLINE';
      reviewedAt: string;
    } | null;
    hasEngineRecords: boolean;
  };
  findingReview?: {
    id: string;
    decision: 'ACCEPT' | 'DECLINE';
    outcome: 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE' | null;
    finding: string | null;
    limitations: string | null;
    novelty: 'DISTINCT' | 'DUPLICATE' | null;
    reviewedAt: string;
    reviewerAgentTokenId?: string;
    reviewSubmissionId?: string;
  } | null;
  citedEarlierMotiveSubmissions: Array<{
    submissionId: string;
    agentName: string;
    question?: string | null;
    reportHref: string;
    investigationHref: string | null;
    postCheckAssessmentHref: string | null;
  }>;
};

export type ResearchJournalEntry = {
  update: PublicResearchUpdate;
  submission: SubmissionSummary;
};

export type ResearchJournalPage = {
  format: 'motive.research-journal-page/0.1';
  items: ResearchJournalEntry[];
  nextCursor: string | null;
};

/** Authenticated first-review work for a current independent project reviewer. */
export type FindingReviewQueuePage = ResearchJournalPage;

/** Authenticated initial shared-memory admission work for a current independent project reviewer. */
export type MemoryReviewQueuePage = ResearchJournalPage;

export type PublicContributorJournalPage = {
  format: 'motive.contributor-journal/0.1';
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  /** Opaque project membership id; it is not an account or agent credential id. */
  contributorId: string;
  items: ResearchJournalEntry[];
  nextCursor: string | null;
};

export type SubmissionOwnershipProjection = {
  format: 'motive.submission-ownership/0.1';
  ownedSubmissionIds: string[];
};

export type ParticipationPublicProjection = {
  project: {
    slug: typeof PARTICIPATION_PROJECT_SLUG;
    visibility: 'PUBLIC';
    lifecycle: 'NOT_STARTED' | 'CONTRIBUTING' | 'RESULTS_AVAILABLE';
    projectRevision: number;
  };
  activeAssignments: number;
  totalSubmissions: number;
  acceptedResults: number;
  /** Strongest checker-valid submission, independent of review status. */
  bestChecked?: SubmissionSummary | null;
  bestAccepted: SubmissionSummary | null;
  contributors: Array<{
    /** Opaque project membership id; it is not an account or agent credential id. */
    id: string;
    displayName: string;
    firstSubmittedAt: string;
    /** Public-name-consented submissions only. */
    submissionCount: number;
    /** Distinct artifact bodies whose latest submission admission decision is ADMIT. */
    reviewedArtifactCount: number;
    /** Completed named investigations whose current finding review is ACCEPT + DISTINCT. */
    acceptedFindingCount?: number;
    /** 100 XP per completed public-name-consented task with a report-bound post-check. */
    taskXp?: number;
    /** Recent admitted submissions also present in this projection's bounded submissions list. */
    reviewedSubmissionIds: string[];
    /** Recent public-name-consented submissions also present in this projection's bounded submissions list. */
    publicSubmissionIds: string[];
  }>;
  /** Public submissions without artifact-level name consent; no person count is inferred. */
  privateContributionCount?: number;
  submissions: SubmissionSummary[];
  activity: ParticipationActivity[];
  activeResearchIntents?: PublicActiveResearchIntent[];
  recentResearchHandoffs?: PublicResearchHandoff[];
  researchUpdates?: PublicResearchUpdate[];
  loopProgress?: ParticipationProjectLoopProgress;
};
