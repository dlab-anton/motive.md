import type { Digest } from '../../domain/src/contracts.ts';
import type {
  ComparatorOutcome,
  TrustedComparatorReportCapture,
} from '../../evaluator-lean/src/contract.ts';
import type {
  VersionedComparatorAssessment as ComparatorAssessment,
  VersionedComparatorProfile as TrustedComparatorProfile,
} from '../../evaluator-lean/src/versioned.ts';

export type EvaluationOutcome = ComparatorOutcome;
export type AcceptanceDecision = 'ACCEPTED' | 'REJECTED';

/**
 * The provider identity that produced an evaluator report.  This is retained
 * for privileged audit/reconciliation, never returned from member reads.
 */
export type EvaluatorEnvironmentProvenance = {
  environmentId: string;
  provider: string;
  externalId: string;
  sessionId: string;
  leaseEpoch: number;
  controllerGeneration: string;
};

/**
 * A durable evaluator assessment for trusted internal callers.  The captured
 * report bytes themselves are deliberately not stored here or returned here.
 */
export type EvaluationProjection = {
  id: string;
  projectId: string;
  workOrderId: string;
  attemptId: string;
  artifactEnvironmentId: string;
  artifactManifestDigest: Digest;
  artifactReceiptId: string;
  termsDigest: Digest;
  evaluatorProfileDigest: Digest;
  evaluatorProfile: TrustedComparatorProfile;
  challengeDigest: Digest;
  dependencyLockDigest: Digest;
  trustedBuildConfigDigest: Digest;
  rawReportDigest: Digest;
  assessmentDigest: Digest;
  outcome: EvaluationOutcome;
  assessment: ComparatorAssessment;
  evaluatorEnvironment: EvaluatorEnvironmentProvenance;
  recordedAt: string;
};

/** Public-to-an-active-member artifact metadata, not an artifact download capability. */
export type MemberArtifactProjection = {
  environmentId: string;
  manifestDigest: Digest;
  sealedAt: string;
};

/** A member can see that a final named decision exists, but not its author or rationale. */
export type MemberAcceptanceProjection = {
  id: string;
  evaluationId: string;
  decision: AcceptanceDecision;
  decidedAt: string;
};

/**
 * Redacted member view. It never includes raw report bytes, comparator check
 * details, evaluator profile/configuration snapshots, provider provenance,
 * artifact URLs or receipt IDs, the named decision actor, or the rationale.
 */
export type MemberEvaluationProjection = {
  id: string;
  attemptId: string;
  workOrderId: string;
  artifactEnvironmentId: string;
  evaluatorEnvironmentId: string;
  artifactManifestDigest: Digest;
  termsDigest: Digest;
  evaluatorProfileDigest: Digest;
  challengeDigest: Digest;
  dependencyLockDigest: Digest;
  trustedBuildConfigDigest: Digest;
  rawReportDigest: Digest;
  assessmentDigest: Digest;
  outcome: EvaluationOutcome;
  recordedAt: string;
  acceptance: MemberAcceptanceProjection | null;
};

/**
 * Redacted evidence for one attempt. A non-member and an unknown attempt are
 * both represented as `null` by the store, so a caller cannot enumerate a
 * private project through this API.
 */
export type MemberAttemptEvidenceProjection = {
  attemptId: string;
  workOrderId: string;
  termsDigest: Digest;
  artifact: MemberArtifactProjection | null;
  evaluations: readonly MemberEvaluationProjection[];
};

/** The result returned to a named decision caller and idempotency replay. */
export type AcceptanceDecisionProjection = MemberAcceptanceProjection & {
  attemptId: string;
  workOrderId: string;
  artifactManifestDigest: Digest;
  termsDigest: Digest;
  evaluatorProfileDigest: Digest;
  rawReportDigest: Digest;
};

/** Every immutable evaluation reference that a human review must re-confirm. */
export type ExpectedReviewBinding = {
  attemptId: string;
  artifactManifestDigest: Digest;
  termsDigest: Digest;
  evaluatorProfileDigest: Digest;
  rawReportDigest: Digest;
};

export type RecordTrustedEvaluatorCaptureInput = {
  artifactEnvironmentId: string;
  evaluatorEnvironmentId: string;
  /**
   * Reviewed profile decoded by trusted control-plane code. The store validates
   * and freezes it against the work order itself; a caller cannot supply a
   * precomputed assessment or outcome.
   */
  evaluatorProfile: unknown;
  /** Exact bounded bytes and trusted collector digest from the isolated evaluator. */
  capturedReport: TrustedComparatorReportCapture;
};

export type DecideAcceptanceInput = {
  /** Derived from verified authentication; never accepted from a route body. */
  actorId: string;
  /** Header-derived, actor-scoped idempotency key. */
  idempotencyKey: string;
  evaluationId: string;
  decision: AcceptanceDecision;
  expectedReview: ExpectedReviewBinding;
  /**
   * Optional private audit text. When present it is 1–4,096 UTF-8 bytes and
   * contains no C0/C1 control characters.
   */
  rationale?: string;
};

export type EvidenceStoreErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_INCOMPLETE'
  | 'ARTIFACT_NOT_SEALED'
  | 'EVALUATOR_ENVIRONMENT_INVALID'
  | 'EVALUATION_BINDING_MISMATCH'
  | 'EVALUATION_CAPTURE_CONFLICT'
  | 'HUMAN_REVIEW_NOT_REQUIRED'
  | 'REVIEW_NOT_READY'
  | 'MAINTAINER_REQUIRED'
  | 'EVALUATION_NOT_VERIFIED'
  | 'ACCEPTANCE_ALREADY_DECIDED';

/**
 * Evidence is private application state. `recordTrustedEvaluatorCapture` is
 * an internal collector port, never an HTTP mutation. The types do not prove
 * the caller operated a trusted collector; deployment composition must keep
 * worker/run capabilities away from this interface.
 */
export interface EvidenceStore {
  recordTrustedEvaluatorCapture(input: RecordTrustedEvaluatorCaptureInput): Promise<EvaluationProjection>;
  findAttemptEvidenceForMember(input: { actorId: string; attemptId: string }): Promise<MemberAttemptEvidenceProjection | null>;
  findEvaluationForMember(input: { actorId: string; evaluationId: string }): Promise<MemberEvaluationProjection | null>;
  decideAcceptance(input: DecideAcceptanceInput): Promise<AcceptanceDecisionProjection>;
}
