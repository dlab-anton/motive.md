export const REVIEW_QUEUE_KIND = 'MEMORY_ADMISSION' as const;

export type ReviewQueueKind = typeof REVIEW_QUEUE_KIND;
export type ReviewQueueGrantStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED';

export type ReviewQueueGrant = Readonly<{
  id: string;
  projectSlug: string;
  reviewKind: ReviewQueueKind;
  status: ReviewQueueGrantStatus;
  maxDecisions: number;
  decisionsUsed: number;
  remainingDecisions: number;
  expiresAt: string;
  revokedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  currentAssignment: Readonly<{
    submissionId: string;
    question: string | null;
    claimedAt: string;
    firstSeenAt: string | null;
  }> | null;
}>; 

export type ReviewQueueGrantList = Readonly<{
  format: 'motive.review-queue-grants/0.1';
  grants: readonly ReviewQueueGrant[];
}>;

export type CreateReviewQueueGrantInput = Readonly<{ maxDecisions: number }>;
export type CreateReviewQueueGrantResponse = Readonly<{ grant: ReviewQueueGrant; token: string }>;

export type ReviewQueueChildAccess = Readonly<{
  id: string;
  submissionId: string;
  packageDigest: string;
  expectedDecisionId: string | null;
  status: 'READY' | 'CONSUMED' | 'REVOKED' | 'EXPIRED' | 'STALE';
  expiresAt: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}>;

export type ReviewQueueCurrentAssignment = Readonly<{
  claimId: string;
  submissionId: string;
  access: ReviewQueueChildAccess;
  token: string;
  claimedAt: string;
}>;

export type ReviewQueueAgentState = Readonly<{
  format: 'motive.review-queue-agent-state/0.1';
  state: 'AVAILABLE' | 'WORKING' | 'EMPTY' | 'EXHAUSTED';
  grant: ReviewQueueGrant;
  assignment: ReviewQueueCurrentAssignment | null;
  retryAfterSeconds: number | null;
}>;

export type ReviewQueueClaimResponse = ReviewQueueAgentState;
export type ReleaseReviewQueueClaimInput = Readonly<{ reason: string }>;
export type ReleaseReviewQueueClaimResponse = Readonly<{
  format: 'motive.review-queue-release/0.1';
  claimId: string;
  submissionId: string;
  reason: string;
  releasedAt: string;
}>;

export function isCreateReviewQueueGrantInput(value: unknown): value is CreateReviewQueueGrantInput {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 1
    && Number.isInteger((value as Record<string, unknown>).maxDecisions)
    && Number((value as Record<string, unknown>).maxDecisions) >= 1
    && Number((value as Record<string, unknown>).maxDecisions) <= 10;
}

export function isReleaseReviewQueueClaimInput(value: unknown): value is ReleaseReviewQueueClaimInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value as Record<string, unknown>).length !== 1) return false;
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.length >= 1 && reason.length <= 500
    && reason.trim() === reason && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(reason);
}
