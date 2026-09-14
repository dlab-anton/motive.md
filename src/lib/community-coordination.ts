import type { SubmissionMotiveReference, SubmissionResearchContext } from './participation';

export const COMMUNITY_COORDINATION_PROJECT_SLUG = 'circle-packing' as const;
export const COMMUNITY_COORDINATION_CLASSIFICATION = 'PUBLIC_UNREVIEWED_ADVICE' as const;

export type CommunityCoordinationGrantStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED';
export type CommunityCoordinationGrant = Readonly<{
  id: string;
  projectSlug: typeof COMMUNITY_COORDINATION_PROJECT_SLUG;
  agentTokenId: string;
  status: CommunityCoordinationGrantStatus;
  maxTurns: number;
  turnsUsed: number;
  remainingTurns: number;
  expiresAt: string;
  revokedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  currentTurn: CommunityCoordinationTurn | null;
  createdAt: string;
}>;

export type CommunityCoordinationAccountState = Readonly<{
  format: 'motive.community-coordination-account-state.v1';
  projectSlug: typeof COMMUNITY_COORDINATION_PROJECT_SLUG;
  eligible: boolean;
  reason: 'ELIGIBLE' | 'ACCOUNT_INACTIVE' | 'MEMBERSHIP_REQUIRED' | 'NO_ACTIVE_AGENT_TOKEN';
  agentTokens: readonly Readonly<{ id: string; agentName: string; expiresAt: string }>[];
  grants: readonly CommunityCoordinationGrant[];
}>;

export type CreateCommunityCoordinationGrantInput = Readonly<{ agentTokenId: string; maxTurns: number }>;
export type CreateCommunityCoordinationGrantResponse = Readonly<{ grant: CommunityCoordinationGrant; replayed: boolean }>;

export type CommunityCoordinationPriority = Readonly<{
  kind: 'EXPERIMENT' | 'REPLICATION' | 'REVIEW';
  question: string;
  expectation: string;
  test: string;
  positiveInterpretation: string;
  negativeInterpretation: string;
  inconclusiveInterpretation: string;
  motiveReferences: readonly SubmissionMotiveReference[];
}>;

export type CommunityCoordinationPlanInput = Readonly<{
  format: 'motive.community-coordination-plan.v1';
  summary: string;
  limitations: string;
  researchContext?: SubmissionResearchContext;
  priorities: readonly CommunityCoordinationPriority[];
}>;

export type CommunityCoordinationTurn = Readonly<{
  id: string;
  grantId: string;
  projectSlug: typeof COMMUNITY_COORDINATION_PROJECT_SLUG;
  signalDigest: string;
  status: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'COMPLETED';
  expiresAt: string;
  hardExpiresAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  completedAt: string | null;
  createdAt: string;
}>;

export type CommunityCoordinationAgentState = Readonly<{
  format: 'motive.community-coordination-agent-state.v1';
  state: 'NOT_ENROLLED' | 'AVAILABLE' | 'WORKING' | 'WAITING' | 'EXHAUSTED';
  grant: CommunityCoordinationGrant | null;
  turn: CommunityCoordinationTurn | null;
  retryAfterSeconds: number | null;
}>;

export type ClaimCommunityCoordinationTurnInput = Readonly<{ grantId: string }>;
export type RenewCommunityCoordinationTurnInput = Readonly<{ grantId: string; turnId: string }>;
export type ReleaseCommunityCoordinationTurnInput = Readonly<{ grantId: string; turnId: string; reason: string }>;
export type CompleteCommunityCoordinationTurnInput = Readonly<{
  grantId: string;
  turnId: string;
  plan: CommunityCoordinationPlanInput;
}>;

export type CommunityCoordinationPlanRecord = Readonly<{
  id: string;
  turnId: string;
  projectSlug: typeof COMMUNITY_COORDINATION_PROJECT_SLUG;
  projectRevision: number;
  signalDigest: string;
  planDigest: string;
  classification: typeof COMMUNITY_COORDINATION_CLASSIFICATION;
  plan: CommunityCoordinationPlanInput;
  createdAt: string;
  replayed: boolean;
}>;

export type PublicCommunityCoordinationPlan = Readonly<{
  id: string;
  projectRevision: number;
  signalDigest: string;
  planDigest: string;
  classification: typeof COMMUNITY_COORDINATION_CLASSIFICATION;
  summary: string;
  limitations: string;
  priorities: readonly CommunityCoordinationPriority[];
  memoryReferenced: boolean;
  stale: boolean;
  authorAvailable: boolean;
  agentName: string;
  publicDisplayName: string | null;
  createdAt: string;
}>;

export type PublicCommunityCoordinationProjection = Readonly<{
  format: 'motive.community-coordination.public.v1';
  projectSlug: typeof COMMUNITY_COORDINATION_PROJECT_SLUG;
  coordinatorAvailable: boolean;
  currentSuggestions: PublicCommunityCoordinationPlan | null;
  activeTurn: Readonly<{ id: string; agentName: string; publicDisplayName: string | null;
    createdAt: string; expiresAt: string; lastSeenAt: string | null }> | null;
  history: readonly PublicCommunityCoordinationPlan[];
  retryAfterSeconds: number;
  notice: 'Coordinator plans are public unreviewed advice from account-delegated volunteer capacity. They do not authorize work, spending, acceptance, review, or engine writes, and a declared model is not verified.';
}>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SURROGATE = /[\uD800-\uDFFF]/u;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim() === value
    && !CONTROL.test(value) && !SURROGATE.test(value);
}

export function isCreateCommunityCoordinationGrantInput(value: unknown): value is CreateCommunityCoordinationGrantInput {
  return object(value) && exact(value, ['agentTokenId', 'maxTurns']) && typeof value.agentTokenId === 'string'
    && UUID.test(value.agentTokenId) && Number.isInteger(value.maxTurns) && Number(value.maxTurns) >= 1 && Number(value.maxTurns) <= 5;
}

export function isClaimCommunityCoordinationTurnInput(value: unknown): value is ClaimCommunityCoordinationTurnInput {
  return object(value) && exact(value, ['grantId']) && typeof value.grantId === 'string' && UUID.test(value.grantId);
}

export function isRenewCommunityCoordinationTurnInput(value: unknown): value is RenewCommunityCoordinationTurnInput {
  return object(value) && exact(value, ['grantId', 'turnId']) && typeof value.grantId === 'string' && UUID.test(value.grantId)
    && typeof value.turnId === 'string' && UUID.test(value.turnId);
}

export function isReleaseCommunityCoordinationTurnInput(value: unknown): value is ReleaseCommunityCoordinationTurnInput {
  return object(value) && exact(value, ['grantId', 'turnId', 'reason']) && typeof value.grantId === 'string' && UUID.test(value.grantId)
    && typeof value.turnId === 'string' && UUID.test(value.turnId) && boundedText(value.reason, 500);
}

export function isCommunityCoordinationPlanInput(value: unknown): value is CommunityCoordinationPlanInput {
  if (!object(value) || !exact(value, ['format', 'summary', 'limitations', 'priorities'], ['researchContext'])
      || value.format !== 'motive.community-coordination-plan.v1' || !Array.isArray(value.priorities)
      || value.priorities.length < 1 || value.priorities.length > 3
      || !boundedText(value.summary, 1000) || !boundedText(value.limitations, 1000)) return false;
  if (value.researchContext !== undefined) {
    const context = value.researchContext;
    if (!object(context) || !exact(context, ['scopeId', 'snapshotId', 'snapshotDigest'])
        || typeof context.scopeId !== 'string' || !UUID.test(context.scopeId)
        || typeof context.snapshotId !== 'string' || !UUID.test(context.snapshotId)
        || typeof context.snapshotDigest !== 'string' || !DIGEST.test(context.snapshotDigest)) return false;
  }
  let references = 0;
  for (const item of value.priorities) {
    if (!object(item) || !exact(item, ['kind', 'question', 'expectation', 'test', 'positiveInterpretation', 'negativeInterpretation',
      'inconclusiveInterpretation', 'motiveReferences']) || !['EXPERIMENT', 'REPLICATION', 'REVIEW'].includes(String(item.kind))
      || !boundedText(item.question, 500) || !boundedText(item.expectation, 500) || !boundedText(item.test, 1000)
      || !boundedText(item.positiveInterpretation, 500) || !boundedText(item.negativeInterpretation, 500)
      || !boundedText(item.inconclusiveInterpretation, 500) || !Array.isArray(item.motiveReferences)
      || item.motiveReferences.length < 1 || item.motiveReferences.length > 5) return false;
    references += item.motiveReferences.length;
    const seen = new Set<string>();
    for (const reference of item.motiveReferences) {
      if (!object(reference) || !exact(reference, ['submissionId', 'reportDigest', 'artifactDigest'])
          || typeof reference.submissionId !== 'string' || !UUID.test(reference.submissionId)
          || typeof reference.reportDigest !== 'string' || !DIGEST.test(reference.reportDigest)
          || typeof reference.artifactDigest !== 'string' || !DIGEST.test(reference.artifactDigest)
          || seen.has(reference.submissionId)) return false;
      seen.add(reference.submissionId);
    }
  }
  return references <= 10 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16_384;
}

export function isCompleteCommunityCoordinationTurnInput(value: unknown): value is CompleteCommunityCoordinationTurnInput {
  return object(value) && exact(value, ['grantId', 'turnId', 'plan']) && typeof value.grantId === 'string'
    && UUID.test(value.grantId) && typeof value.turnId === 'string' && UUID.test(value.turnId)
    && isCommunityCoordinationPlanInput(value.plan);
}
