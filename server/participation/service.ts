import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson, type WorkOrderTerms } from '../../packages/domain/src/contracts.ts';
import { checkCirclePackingWitness, CSQV_MAX_BYTES } from '../../src/lib/circle-packing.ts';
import { compareCirclePackingWitnesses } from '../../src/lib/circle-packing-equivalence.ts';
import type { GeometryComparisonResponse } from '../../src/lib/geometry-comparison.ts';
import { validatePublicResearchSummary } from '../../src/lib/research-summary.ts';
import { ExperimentProtocolValidationError, experimentProtocolFingerprintPreimage, validateExperimentProtocol,
  type ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import {
  PARTICIPATION_PROJECT_SLUG,
  type AcceptanceStatus,
  type AgentAssignmentResponse,
  type AgentSessionProjection,
  type SetAgentSessionInput,
  type AgentWorkQueueResponse,
  type AgentWorkQueueValidationTarget,
  type AgentTokenProjection,
  type AssignmentIntentProjection,
  type AssignmentProjection,
  type CompleteAssignmentInput,
  type DeclareAssignmentIntentInput,
  type ExperimentProtocolMatches,
  type FencedAssignmentInput,
  type JoinParticipationInput,
  type JoinParticipationResponse,
  type ParticipationActivity,
  type ParticipationCredentialLoopProgress,
  type ParticipationMeResponse,
  type ParticipationPublicProjection,
  type PostCheckAssessmentInput,
  type PublicPostCheckAssessment,
  type PublicActiveResearchIntent,
  type PublicResearchHandoff,
  type PublicResearchHandoffPage,
  type PublicContributorJournalPage,
  type PublicResearchUpdate,
  type ResearchJournalEntry,
  type ResearchJournalPage,
  type PublicSubmissionReproducibility,
  type PublicSubmissionInvestigation,
  type ReviewSubmissionInput,
  type ReleaseAssignmentInput,
  type SubmissionInvestigationInput,
  type SubmissionMotiveReference,
  type SubmissionOwnershipProjection,
  type SubmissionResearchContext,
  type SubmissionResearchReference,
  type SubmissionSummary,
  type SubmissionReproducibilityInput,
  type SubmitCircleWitnessInput,
} from '../../src/lib/participation.ts';
import { researchDeliveryTargetSelectionsEqual, validateResearchDeliveryTargetBinding,
  validateResearchDeliveryTargetSelection, type ResearchDeliveryTargetBinding,
  type ResearchDeliveryTargetSelection } from '../../src/lib/research-delivery-target.ts';
import type { AgentResearchDeliveryCheckpoint, RecoveredFindingCheckpoint } from '../../src/lib/research-delivery-policy.ts';
import type { ProjectReviewerChange, ProjectReviewers } from '../../src/lib/project-reviewers.ts';
import type { ContributorReviewedArtifactsPage } from '../../src/lib/reviewed-artifacts.ts';

const WORK_ORDER_KEY = 'circle-packing-external';
const WORK_ORDER_REVISION = 1;
const AGREEMENT_ID = 'circle-packing-external-v1';
const REFERENCE_COMMIT = '80f08aa72d9d85d7d9d2a871825b46bdec471bb2';
const REFERENCE_SCORE = '5.29109518547430697';
const REFERENCE_WITNESS_DIGEST = 'sha256:4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e';
const CHECKER_FORMAT = 'motive.csqv.local-check.v1';
const CHECKER_VERSION = 1;
const CHECKER_SOURCE_DIGEST = 'sha256:a2f9904fe0359edda76b41b6c840b2ff219288c9cb8671d85376c1b1c0693559';
const LICENSE_REF = 'circle-packing-reference-terms-v1';
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const AGENT_CONTACT_FRESHNESS_MS = 2 * 60 * 1000;
const THIRTY_MINUTE_SESSION_MS = 30 * 60 * 1000;
const CLAIM_LIFETIME_MS = 15 * 60 * 1000;
const MAX_ACTIVE_CLAIMS = 100;
const MAX_SOLVER_SOURCE_BYTES = 16 * 1024;
const MAX_TRIAL_RESULTS_BYTES = 32 * 1024;
const MAX_REPRODUCIBILITY_BYTES = MAX_SOLVER_SOURCE_BYTES + MAX_TRIAL_RESULTS_BYTES;
const CANONICAL_ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANONICAL_SHA256 = /^sha256:[a-f0-9]{64}$/;
const LATEST_SUBMISSION_ADMISSION_CTES = `delivery_tails AS (
    SELECT delivery.source_submission_id,decision.decision,decision.created_at,decision.id,decision.rationale
    FROM motive.hypothesis_submission_delivery_admission_decisions decision
    JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=decision.delivery_id
    WHERE delivery.project_id=$1
      AND NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
        WHERE successor.previous_decision_id=decision.id)
  ), latest_submission_decision AS (
    SELECT DISTINCT ON (source_submission_id) source_submission_id,decision,created_at,id,rationale
    FROM delivery_tails ORDER BY source_submission_id,created_at DESC,id DESC
  )`;
const DURABLE_VERIFIED_IMPROVEMENTS_CTE=`durable_verified_improvements AS (
    SELECT source_artifact.project_id,source_artifact.submission_id,source_artifact.exact_score,
      finding.id AS finding_decision_id,finding.review_submission_id
    FROM motive.participation_submission_artifacts source_artifact
    JOIN motive.submissions source_submission ON source_submission.id=source_artifact.submission_id
      AND source_submission.project_id=source_artifact.project_id AND source_submission.origin='EXTERNAL'
      AND jsonb_typeof(source_submission.provenance->'investigation')='object'
    JOIN motive.participation_agent_tokens source_token ON source_token.id=source_artifact.agent_token_id
      AND source_token.project_id=source_artifact.project_id
    JOIN motive.participation_claim_completions source_completion
      ON source_completion.submission_id=source_submission.id AND source_completion.claim_id=source_submission.claim_id
    JOIN motive.participation_post_check_assessments source_post ON source_post.submission_id=source_submission.id
      AND source_post.project_id=source_submission.project_id AND source_post.agent_token_id=source_artifact.agent_token_id
      AND source_post.report_digest=source_artifact.report_digest
    JOIN motive.participation_submission_reproducibility source_repro ON source_repro.submission_id=source_submission.id
      AND source_repro.project_id=source_submission.project_id AND source_repro.agent_token_id=source_artifact.agent_token_id
      AND source_repro.report_digest=source_artifact.report_digest
    JOIN motive.finding_review_decisions finding ON finding.project_id=source_artifact.project_id
      AND finding.source_submission_id=source_artifact.submission_id
    JOIN motive.submissions review_submission ON review_submission.id=finding.review_submission_id
      AND review_submission.project_id=finding.project_id AND review_submission.origin='EXTERNAL'
    JOIN motive.work_claims review_claim ON review_claim.id=review_submission.claim_id
      AND review_claim.project_id=review_submission.project_id AND review_claim.work_order_id=review_submission.work_order_id
      AND review_claim.lease_epoch=review_submission.lease_epoch
    JOIN motive.participation_submission_artifacts review_artifact ON review_artifact.submission_id=review_submission.id
      AND review_artifact.project_id=review_submission.project_id AND review_artifact.agent_token_id=finding.reviewer_agent_token_id
    JOIN motive.participation_agent_tokens review_token ON review_token.id=review_artifact.agent_token_id
      AND review_token.project_id=review_artifact.project_id AND review_token.owner_actor_id=finding.reviewer_actor_id
    JOIN motive.participation_claim_completions review_completion
      ON review_completion.submission_id=review_submission.id AND review_completion.claim_id=review_claim.id
    JOIN motive.participation_post_check_assessments review_post ON review_post.submission_id=review_submission.id
      AND review_post.project_id=review_submission.project_id AND review_post.agent_token_id=review_artifact.agent_token_id
      AND review_post.report_digest=review_artifact.report_digest
    JOIN motive.participation_submission_reproducibility review_repro ON review_repro.submission_id=review_submission.id
      AND review_repro.project_id=review_submission.project_id AND review_repro.agent_token_id=review_artifact.agent_token_id
      AND review_repro.report_digest=review_artifact.report_digest
    JOIN motive.participation_claim_intents review_intent ON review_intent.claim_id=review_claim.id
      AND review_intent.project_id=review_submission.project_id AND review_intent.work_order_id=review_submission.work_order_id
      AND review_intent.work_order_revision=review_submission.work_order_revision
      AND review_intent.work_order_terms_digest=review_claim.terms_digest
      AND review_intent.lease_epoch=review_claim.lease_epoch AND review_intent.agent_token_id=review_artifact.agent_token_id
    WHERE source_artifact.report='VALID' AND source_artifact.exceeds_reference=TRUE
      AND review_artifact.report='VALID' AND review_artifact.exceeds_reference=TRUE
      AND review_submission.operator_actor_id='agent:'||review_token.id::text
      AND source_token.owner_actor_id<>review_token.owner_actor_id
      AND finding.decision='ACCEPT' AND finding.outcome='SUPPORTED'
      AND finding.reviewer_agent_token_id IS NOT NULL AND finding.review_submission_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=finding.id)
      AND finding.review_package->>'format' IN ('motive.finding-review-package/0.2','motive.finding-review-package/0.3')
      AND finding.review_package->>'findingId'=source_submission.id::text
      AND finding.review_package#>>'{project,id}'=source_submission.project_id::text
      AND finding.review_package#>>'{source,submission,id}'=source_submission.id::text
      AND finding.review_package#>>'{source,artifact,digest}'=source_artifact.witness_digest
      AND finding.review_package#>>'{source,report,digest}'=source_artifact.report_digest
      AND finding.review_package#>>'{source,report,status}'=source_artifact.report::text
      AND finding.review_package#>'{source,report,body}'=source_artifact.report_body
      AND finding.review_package_digest='sha256:'||encode(sha256(convert_to(
        motive.finding_review_canonical_json(finding.review_package),'UTF8')),'hex')
      AND review_intent.experiment_protocol->>'format'='motive.experiment-protocol.v1'
      AND review_intent.experiment_protocol->>'purpose'='REPLICATION'
      AND (SELECT count(*) FROM jsonb_array_elements(review_intent.experiment_protocol->'inputs') entry
        WHERE entry->>'name'='review_target_submission_id'
          AND entry->>'value'=source_submission.id::text)=1
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(review_intent.motive_references) reference
        WHERE reference->>'submissionId'=source_submission.id::text
          AND reference->>'reportDigest'=source_artifact.report_digest
          AND reference->>'artifactDigest'=source_artifact.witness_digest)
  )`;
const CONNECTION_ADJECTIVES = ['Bright', 'Calm', 'Clear', 'Clever', 'Curious', 'Gentle', 'Keen', 'Lively',
  'Nimble', 'Patient', 'Quiet', 'Steady', 'Thoughtful', 'Vivid', 'Warm', 'Wise'] as const;
const CONNECTION_NOUNS = ['Badger', 'Finch', 'Fox', 'Heron', 'Kestrel', 'Lark', 'Otter', 'Panda',
  'Robin', 'Sparrow', 'Tern', 'Thrush', 'Turtle', 'Wren', 'Yak', 'Zebra'] as const;

export type ParticipationAgentContext = {
  tokenId: string;
  actorId: string;
  ownerActorId: string;
  projectId: string;
  expiresAt: string;
};

export class ParticipationError extends Error {
  constructor(readonly code: 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED', message: string) {
    super(message); this.name = 'ParticipationError';
  }
}

type ServiceOptions = { tokenSecret: string; issuerActorId: string; now?: () => Date;
  isActorActive?: (actorId: string) => boolean | Promise<boolean>;
  validateResearchContext?: (projectId: string, context: SubmissionResearchContext, client: PoolClient) => Promise<void>;
  validateResearchReferences?: (projectId: string, references: SubmissionResearchReference[], client: PoolClient) => Promise<void>;
  resolveResearchDeliveryTarget?: (projectId: string, selection: ResearchDeliveryTargetSelection,
    client: PoolClient) => Promise<ResearchDeliveryTargetBinding>;
  nextReadyRecoveredFinding?: (context: ParticipationAgentContext) => Promise<RecoveredFindingCheckpoint | null>;
  nextReadyResearchDelivery?: (context: ParticipationAgentContext) => Promise<AgentResearchDeliveryCheckpoint | null> };
type IdempotentResult<T> = { response: T; effectId: string; replayed: boolean };

function text(row: QueryResultRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`Database field ${name} is missing.`);
  return value;
}
function nullableText(row: QueryResultRow, name: string): string | null {
  return row[name] === null || row[name] === undefined ? null : text(row, name);
}
function dateText(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Database timestamp is invalid.');
  return date.toISOString();
}
function sha256(bytes: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function agentActor(tokenId: string) { return `agent:${tokenId}`; }
function connectionName(tokenId: string): string {
  const bytes = createHash('sha256').update(`motive-agent-connection-name-v1\0${tokenId}`).digest();
  return `${CONNECTION_ADJECTIVES[bytes[0]! % CONNECTION_ADJECTIVES.length]} ${CONNECTION_NOUNS[bytes[1]! % CONNECTION_NOUNS.length]}`;
}

function agentSessionInput(input: SetAgentSessionInput): SetAgentSessionInput {
  if (!input || typeof input !== 'object') throw new ParticipationError('VALIDATION', 'Agent session declaration is invalid.');
  const keys = Object.keys(input).sort();
  const runModes = new Set(['ONE_TASK', 'THIRTY_MINUTES', 'UNTIL_STOPPED']);
  if (!input || typeof input !== 'object' || !runModes.has(input.runMode)
    || (input.status !== 'RUNNING' && input.status !== 'PAUSED')
    || (input.status === 'RUNNING' && JSON.stringify(keys) !== JSON.stringify(['runMode', 'status']))
    || (input.status === 'PAUSED' && JSON.stringify(keys) !== JSON.stringify(input.stopReason === undefined
      ? ['runMode', 'status'] : ['runMode', 'status', 'stopReason']))
    || (input.status === 'PAUSED' && input.stopReason !== undefined
      && (typeof input.stopReason !== 'string' || input.stopReason.length < 1 || input.stopReason.length > 280
        || input.stopReason !== input.stopReason.trim()
        || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u.test(input.stopReason)))) {
    throw new ParticipationError('VALIDATION', 'Agent session declaration is invalid.');
  }
  return input;
}

function validateProtocol(value: unknown): ExperimentProtocol {
  try { return validateExperimentProtocol(value); }
  catch (error) { throw new ParticipationError('VALIDATION', error instanceof ExperimentProtocolValidationError
    ? error.message : 'experimentProtocol is invalid.'); }
}

type ProtocolMatchCursor = { v: 1; projectId: string; workOrderId: string; workOrderRevision: number;
  protocolFingerprint: string; claimId: string };
function encodeProtocolCursor(value: ProtocolMatchCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeProtocolCursor(value: string | undefined): ProtocolMatchCursor | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ParticipationError('VALIDATION', 'Experiment protocol match cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['claimId','projectId','protocolFingerprint','v','workOrderId','workOrderRevision'])
      || parsed.v !== 1 || typeof parsed.projectId !== 'string' || !CANONICAL_ACCOUNT_ID.test(parsed.projectId)
      || typeof parsed.workOrderId !== 'string' || !CANONICAL_ACCOUNT_ID.test(parsed.workOrderId)
      || !Number.isSafeInteger(parsed.workOrderRevision) || Number(parsed.workOrderRevision) < 1
      || typeof parsed.protocolFingerprint !== 'string' || !CANONICAL_SHA256.test(parsed.protocolFingerprint)
      || typeof parsed.claimId !== 'string' || !CANONICAL_ACCOUNT_ID.test(parsed.claimId)) throw new Error();
    return parsed as ProtocolMatchCursor;
  } catch {
    throw new ParticipationError('VALIDATION', 'Experiment protocol match cursor is invalid.');
  }
}

function boundedInvestigationText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim();
}

function requireInvestigationText(name: string, value: unknown, maximum: number): asserts value is string {
  if (!boundedInvestigationText(value, maximum)) {
    throw new ParticipationError('VALIDATION', `investigation.${name} must be nonblank, trimmed text of at most ${maximum} characters.`);
  }
}

function researchDeliveryTarget(value: unknown, field: string): ResearchDeliveryTargetSelection {
  try { return validateResearchDeliveryTargetSelection(value); }
  catch { throw new ParticipationError('VALIDATION', `${field} must identify one canonical retained hypothesis target.`); }
}

function targetHasMatchingReference(target: ResearchDeliveryTargetSelection,
  references: SubmissionResearchReference[] | undefined): boolean {
  return references?.some(reference => reference.scopeId === target.scopeId
    && reference.snapshotId === target.snapshotId && reference.snapshotDigest === target.snapshotDigest
    && reference.hypothesisId === target.hypothesisId
    && reference.observedUpdatedAt === target.observedUpdatedAt) === true;
}

export function validateMotiveReferences(value: unknown): SubmissionMotiveReference[] | undefined {
  if (value === undefined) return undefined;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const digest = /^sha256:[a-f0-9]{64}$/;
  const keys = ['artifactDigest', 'reportDigest', 'submissionId'];
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new ParticipationError('VALIDATION', 'motiveReferences must contain 1â€“10 references when present.');
  }
  const seen = new Set<string>();
  for (const [index, reference] of value.entries()) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(keys)) {
      throw new ParticipationError('VALIDATION', `motiveReferences[${index}] must contain exactly submissionId, reportDigest, and artifactDigest.`);
    }
    const item = reference as Record<string, unknown>;
    if (typeof item.submissionId !== 'string' || !uuid.test(item.submissionId)) {
      throw new ParticipationError('VALIDATION', `motiveReferences[${index}].submissionId must be a canonical lowercase UUID.`);
    }
    if (typeof item.reportDigest !== 'string' || !digest.test(item.reportDigest)
      || typeof item.artifactDigest !== 'string' || !digest.test(item.artifactDigest)) {
      throw new ParticipationError('VALIDATION', `motiveReferences[${index}] digests must be lowercase sha256 digests.`);
    }
    if (seen.has(item.submissionId)) throw new ParticipationError('VALIDATION', 'motiveReferences submissionId values must be unique.');
    seen.add(item.submissionId);
  }
  return value as SubmissionMotiveReference[];
}

export function validateInvestigation(value: SubmissionInvestigationInput | undefined): SubmissionInvestigationInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParticipationError('VALIDATION', 'investigation must be an object.');
  }
  const exactKeys = ['assessment', 'conditions', 'expectation', 'format', 'nextAction', 'observations', 'proposal'];
  const optionalKeys = new Set(['researchContext', 'researchReferences', 'motiveReferences', 'experimentProtocol', 'researchDeliveryTarget']);
  const keys = Object.keys(value).filter(key => !optionalKeys.has(key)).sort();
  if (Object.keys(value).some(key => !optionalKeys.has(key) && !exactKeys.includes(key))
    || JSON.stringify(keys) !== JSON.stringify(exactKeys)) {
    throw new ParticipationError('VALIDATION', 'investigation fields must be exactly format, proposal, expectation, conditions, observations, assessment, and nextAction, with optional research context, references, and experimentProtocol.');
  }
  if (value.format !== 'motive.investigation.v1') {
    throw new ParticipationError('VALIDATION', 'investigation.format must equal motive.investigation.v1.');
  }
  requireInvestigationText('proposal', value.proposal, 2000);
  requireInvestigationText('expectation', value.expectation, 1000);
  if (!Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 12) {
    throw new ParticipationError('VALIDATION', 'investigation.conditions must contain 1â€“12 text items.');
  }
  for (const [index, item] of value.conditions.entries()) {
    if (!boundedInvestigationText(item, 500)) {
      throw new ParticipationError('VALIDATION', `investigation.conditions[${index}] must be nonblank, trimmed text of at most 500 characters.`);
    }
  }
  if (!Array.isArray(value.observations) || value.observations.length < 1 || value.observations.length > 20) {
    throw new ParticipationError('VALIDATION', 'investigation.observations must contain 1â€“20 text items.');
  }
  for (const [index, item] of value.observations.entries()) {
    if (!boundedInvestigationText(item, 1000)) {
      throw new ParticipationError('VALIDATION', `investigation.observations[${index}] must be nonblank, trimmed text of at most 1000 characters.`);
    }
  }
  requireInvestigationText('assessment', value.assessment, 2000);
  requireInvestigationText('nextAction', value.nextAction, 1000);
  if (value.researchContext !== undefined) {
    const context = value.researchContext;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (!context || typeof context !== 'object' || Array.isArray(context)
      || JSON.stringify(Object.keys(context).sort()) !== JSON.stringify(['scopeId', 'snapshotDigest', 'snapshotId'])) {
      throw new ParticipationError('VALIDATION', 'investigation.researchContext must contain exactly scopeId, snapshotId, and snapshotDigest.');
    }
    if (!uuid.test(context.scopeId) || !uuid.test(context.snapshotId)) {
      throw new ParticipationError('VALIDATION', 'investigation.researchContext scopeId and snapshotId must be canonical lowercase UUIDs.');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(context.snapshotDigest)) {
      throw new ParticipationError('VALIDATION', 'investigation.researchContext.snapshotDigest must be a lowercase sha256 digest.');
    }
  }
  if (value.researchReferences !== undefined) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    const referenceKeys = ['evidenceIds', 'hypothesisId', 'observedUpdatedAt', 'scopeId', 'snapshotDigest', 'snapshotId'];
    if (!Array.isArray(value.researchReferences) || value.researchReferences.length < 1 || value.researchReferences.length > 10) {
      throw new ParticipationError('VALIDATION', 'investigation.researchReferences must contain 1â€“10 references when present.');
    }
    for (const [index, ref] of value.researchReferences.entries()) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)
        || JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(referenceKeys)) {
        throw new ParticipationError('VALIDATION', `investigation.researchReferences[${index}] must contain exactly scopeId, snapshotId, snapshotDigest, hypothesisId, observedUpdatedAt, and evidenceIds.`);
      }
      if (![ref.scopeId, ref.snapshotId, ref.hypothesisId].every(id => typeof id === 'string' && uuid.test(id))) {
        throw new ParticipationError('VALIDATION', `investigation.researchReferences[${index}] scopeId, snapshotId, and hypothesisId must be UUIDs.`);
      }
      if (typeof ref.snapshotDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.snapshotDigest)) {
        throw new ParticipationError('VALIDATION', `investigation.researchReferences[${index}].snapshotDigest must be a lowercase sha256 digest.`);
      }
      if (typeof ref.observedUpdatedAt !== 'string' || ref.observedUpdatedAt.length > 40 || !Number.isFinite(Date.parse(ref.observedUpdatedAt))) {
        throw new ParticipationError('VALIDATION', `investigation.researchReferences[${index}].observedUpdatedAt must be a valid timestamp of at most 40 characters.`);
      }
      if (!Array.isArray(ref.evidenceIds) || ref.evidenceIds.length > 20
        || new Set(ref.evidenceIds).size !== ref.evidenceIds.length
        || !ref.evidenceIds.every(id => typeof id === 'string' && uuid.test(id))) {
        throw new ParticipationError('VALIDATION', `investigation.researchReferences[${index}].evidenceIds must contain at most 20 unique UUIDs.`);
      }
    }
  }
  validateMotiveReferences(value.motiveReferences);
  const experimentProtocol = value.experimentProtocol === undefined ? undefined : validateProtocol(value.experimentProtocol);
  const target = value.researchDeliveryTarget === undefined ? undefined
    : researchDeliveryTarget(value.researchDeliveryTarget, 'investigation.researchDeliveryTarget');
  if (target && !targetHasMatchingReference(target, value.researchReferences)) {
    throw new ParticipationError('VALIDATION', 'investigation.researchDeliveryTarget requires a matching researchReferences observation.');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16384) {
    throw new ParticipationError('VALIDATION', 'investigation must be at most 16384 UTF-8 bytes as JSON.');
  }
  return { ...value, ...(experimentProtocol ? { experimentProtocol } : {}),
    ...(target ? { researchDeliveryTarget: target } : {}) };
}

export function validateAssignmentIntent(value: DeclareAssignmentIntentInput): DeclareAssignmentIntentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['leaseEpoch','proposal','expectation','conditions','researchContext','researchReferences','motiveReferences','experimentProtocol','researchDeliveryTarget'].includes(key))
    || !['leaseEpoch','proposal','expectation','conditions'].every(key => Object.hasOwn(value, key))) {
    throw new ParticipationError('VALIDATION', 'Intent must contain leaseEpoch, proposal, expectation, and conditions, with optional research context and references.');
  }
  if (!Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1) {
    throw new ParticipationError('VALIDATION', 'intent.leaseEpoch must be a positive integer.');
  }
  // The investigation validator owns the exact shared citation and text bounds.
  const checked = validateInvestigation({ format: 'motive.investigation.v1', proposal: value.proposal,
    expectation: value.expectation, conditions: value.conditions, observations: ['Intent declaration only.'],
    assessment: 'Intent declaration only.', nextAction: 'Intent declaration only.',
    ...(value.researchContext === undefined ? {} : { researchContext: value.researchContext }),
    ...(value.researchReferences === undefined ? {} : { researchReferences: value.researchReferences }),
    ...(value.motiveReferences === undefined ? {} : { motiveReferences: value.motiveReferences }),
    ...(value.experimentProtocol === undefined ? {} : { experimentProtocol: value.experimentProtocol }),
    ...(value.researchDeliveryTarget === undefined ? {} : { researchDeliveryTarget: value.researchDeliveryTarget }) })!;
  const reviewTarget=checked.experimentProtocol?.inputs.find(item=>item.name==='review_target_submission_id');
  if(reviewTarget&&(checked.experimentProtocol?.purpose!=='REPLICATION'||!CANONICAL_ACCOUNT_ID.test(reviewTarget.value)
    ||checked.motiveReferences?.filter(reference=>reference.submissionId===reviewTarget.value).length!==1)){
    throw new ParticipationError('VALIDATION','review_target_submission_id requires a REPLICATION protocol and one matching target motive reference.');
  }
  return { leaseEpoch: value.leaseEpoch, proposal: checked.proposal, expectation: checked.expectation,
    conditions: checked.conditions, ...(checked.researchContext ? { researchContext: checked.researchContext } : {}),
    ...(checked.researchReferences ? { researchReferences: checked.researchReferences } : {}),
    ...(checked.motiveReferences ? { motiveReferences: checked.motiveReferences } : {}),
    ...(checked.experimentProtocol ? { experimentProtocol: checked.experimentProtocol } : {}),
    ...(checked.researchDeliveryTarget ? { researchDeliveryTarget: checked.researchDeliveryTarget } : {}) };
}

function validatePostCheckAssessment(value: PostCheckAssessmentInput): PostCheckAssessmentInput {
  const bounded = (item: unknown, maximum: number) => typeof item === 'string' && item.length > 0
    && item.length <= maximum && item === item.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![['assessment','nextAction','reportDigest'],['assessment','nextAction','publicSummary','reportDigest']]
      .some(keys=>JSON.stringify(Object.keys(value).sort())===JSON.stringify(keys))
    || !/^sha256:[a-f0-9]{64}$/.test(value.reportDigest)
    || !bounded(value.assessment, 2000) || !bounded(value.nextAction, 1000)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096) {
    throw new ParticipationError('VALIDATION', 'Post-check assessment must contain an exact report digest and nonblank bounded assessment and next action.');
  }
  if(value.publicSummary===undefined)return value;
  try{return{...value,publicSummary:validatePublicResearchSummary(value.publicSummary)};}
  catch{throw new ParticipationError('VALIDATION','Post-check publicSummary must contain a one-paragraph question of at most 180 characters and finding of at most 320 characters.');}
}

function validateReleaseAssignment(value:ReleaseAssignmentInput):ReleaseAssignmentInput{
  const keys=value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort():[];
  const accepted=JSON.stringify(keys)===JSON.stringify(['leaseEpoch'])
    ||JSON.stringify(keys)===JSON.stringify(['leaseEpoch','stopReason']);
  if(!accepted||!Number.isSafeInteger(value.leaseEpoch)||value.leaseEpoch<1
    ||value.stopReason!==undefined&&(typeof value.stopReason!=='string'||value.stopReason.length<1
      ||value.stopReason.length>1000||value.stopReason.trim()!==value.stopReason||value.stopReason.includes('\u0000'))){
    throw new ParticipationError('VALIDATION','Release must contain a positive leaseEpoch and may contain a trimmed stopReason of 1â€“1000 characters.');
  }
  return{leaseEpoch:value.leaseEpoch,...(value.stopReason===undefined?{}:{stopReason:value.stopReason})};
}

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function validateSubmissionReproducibility(value: SubmissionReproducibilityInput): SubmissionReproducibilityInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['reportDigest', 'solverSource', 'trialResults'])) {
    throw new ParticipationError('VALIDATION', 'Reproducibility body must contain exactly reportDigest, solverSource, and trialResults.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.reportDigest)) {
    throw new ParticipationError('VALIDATION', 'reproducibility.reportDigest must be a lowercase sha256 digest.');
  }
  for (const [name, content, maximum] of [
    ['solverSource', value.solverSource, MAX_SOLVER_SOURCE_BYTES],
    ['trialResults', value.trialResults, MAX_TRIAL_RESULTS_BYTES],
  ] as const) {
    if (typeof content !== 'string' || content.length === 0) {
      throw new ParticipationError('VALIDATION', `reproducibility.${name} must be a nonempty UTF-8 text file.`);
    }
    if (!hasOnlyPairedSurrogates(content)) {
      throw new ParticipationError('VALIDATION', `reproducibility.${name} contains invalid Unicode and cannot be encoded losslessly as UTF-8.`);
    }
    if (Buffer.byteLength(content, 'utf8') > maximum) {
      throw new ParticipationError('VALIDATION', `reproducibility.${name} must be at most ${maximum} UTF-8 bytes.`);
    }
  }
  if (Buffer.byteLength(value.solverSource, 'utf8') + Buffer.byteLength(value.trialResults, 'utf8') > MAX_REPRODUCIBILITY_BYTES) {
    throw new ParticipationError('VALIDATION', `Reproducibility files must be at most ${MAX_REPRODUCIBILITY_BYTES} UTF-8 bytes combined.`);
  }
  return value;
}

export class ParticipationService {
  private readonly ledger: LedgerKernel;
  private readonly now: () => Date;
  constructor(private readonly pool: Pool, private readonly options: ServiceOptions) {
    if (Buffer.byteLength(options.tokenSecret, 'utf8') < 32) throw new Error('Participation token secret must be at least 32 UTF-8 bytes.');
    if (!/^operator:[A-Za-z0-9._~-]{1,480}$/.test(options.issuerActorId)) throw new Error('Participation issuerActorId is invalid.');
    this.ledger = new LedgerKernel(pool); this.now = options.now ?? (() => new Date());
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async actorIsActive(actorId: string): Promise<boolean> {
    if (!this.options.isActorActive) return false;
    try { return await this.options.isActorActive(actorId) === true; }
    catch { return false; }
  }

  private reviewerActor(accountId: string): string {
    if (!CANONICAL_ACCOUNT_ID.test(accountId)) {
      throw new ParticipationError('VALIDATION', 'accountId must be a canonical lowercase UUID.');
    }
    return `account:${accountId}`;
  }

  private async reviewerProjectId(client: Pick<Pool, 'query'> | PoolClient): Promise<string> {
    const project = await client.query(`SELECT id FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'`,
      [PARTICIPATION_PROJECT_SLUG]);
    if (project.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Reviewer management is unavailable.');
    return text(project.rows[0], 'id');
  }

  private async preflightReviewerOwner(ownerActorId: string): Promise<string> {
    const accountId = ownerActorId.startsWith('account:') ? ownerActorId.slice('account:'.length) : '';
    if (!CANONICAL_ACCOUNT_ID.test(accountId)) throw new ParticipationError('UNAUTHORIZED', 'A live owner account is required.');
    const projectId = await this.reviewerProjectId(this.pool);
    const authority = await this.pool.query(`SELECT 1 FROM motive.account_identities account
      JOIN motive.memberships membership ON membership.actor_id=account.actor_id AND membership.project_id=$2
      WHERE account.actor_id=$1 AND account.provider='supabase' AND account.subject_id=$3::text
        AND account.status='ACTIVE' AND membership.role='OWNER' AND membership.revoked_at IS NULL`,
    [ownerActorId, projectId, accountId]);
    if (authority.rowCount !== 1 || !await this.actorIsActive(ownerActorId)) {
      throw new ParticipationError('FORBIDDEN', 'Current project owner authority is required.');
    }
    return projectId;
  }

  private async lockReviewerAuthority(client: PoolClient, ownerActorId: string, projectId: string,
    targetActorId?: string): Promise<{ accounts: Map<string, QueryResultRow>; memberships: Map<string, QueryResultRow> }> {
    const actors = [...new Set([ownerActorId, ...(targetActorId ? [targetActorId] : [])])].sort();
    const accounts = await client.query(`SELECT actor_id,provider,subject_id::text,status
      FROM motive.account_identities WHERE actor_id=ANY($1::text[]) ORDER BY actor_id FOR SHARE`, [actors]);
    const accountMap = new Map(accounts.rows.map(row => [text(row, 'actor_id'), row]));
    const owner = accountMap.get(ownerActorId);
    if (!owner || owner.provider !== 'supabase' || owner.status !== 'ACTIVE'
      || `account:${text(owner, 'subject_id')}` !== ownerActorId) {
      throw new ParticipationError('FORBIDDEN', 'Current project owner authority is required.');
    }
    const memberships = await client.query(`SELECT id,actor_id,role,scopes,revoked_at
      FROM motive.memberships WHERE project_id=$1 AND actor_id=ANY($2::text[])
      ORDER BY actor_id FOR UPDATE`, [projectId, actors]);
    const membershipMap = new Map(memberships.rows.map(row => [text(row, 'actor_id'), row]));
    const ownerMembership = membershipMap.get(ownerActorId);
    if (!ownerMembership || ownerMembership.revoked_at || ownerMembership.role !== 'OWNER') {
      throw new ParticipationError('FORBIDDEN', 'Current project owner authority is required.');
    }
    return { accounts: accountMap, memberships: membershipMap };
  }

  private async idempotent<T>(client: PoolClient, actorId: string, action: string, key: string, body: unknown,
    work: (effectId: string) => Promise<{ response: T; resourceType: string; resourceId: string }>): Promise<IdempotentResult<T>> {
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(key)) throw new ParticipationError('VALIDATION', 'Idempotency-Key must be 8â€“200 URL-safe characters.');
    const bodyDigest = digestCanonicalJson(body); const effectId = randomUUID();
    const inserted = await client.query(`INSERT INTO motive.idempotency_records
      (actor_id,action,idempotency_key,body_digest,effect_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING RETURNING effect_id`, [actorId, action, key, bodyDigest, effectId]);
    const saved = await client.query(`SELECT body_digest,response,effect_id FROM motive.idempotency_records
      WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3 FOR UPDATE`, [actorId, action, key]);
    if (saved.rowCount !== 1 || text(saved.rows[0], 'body_digest') !== bodyDigest) {
      throw new ParticipationError('CONFLICT', 'Idempotency-Key is already bound to another request.');
    }
    const durableEffectId = text(saved.rows[0], 'effect_id');
    if (inserted.rowCount === 0) {
      if (saved.rows[0].response === null) throw new Error('Incomplete idempotency record was visible.');
      return { response: saved.rows[0].response as T, effectId: durableEffectId, replayed: true };
    }
    const result = await work(durableEffectId);
    await client.query(`UPDATE motive.idempotency_records SET resource_type=$4,resource_id=$5,response=$6::jsonb
      WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3`,
    [actorId, action, key, result.resourceType, result.resourceId, JSON.stringify(result.response)]);
    return { response: result.response, effectId: durableEffectId, replayed: false };
  }

  private tokenValue(id: string, ownerActorId: string): string {
    const secret = createHmac('sha256', this.options.tokenSecret).update(`motive-agent-token-v1\0${id}\0${ownerActorId}`).digest('base64url');
    return `motive_agent_${id.replaceAll('-', '')}_${secret}`;
  }

  private credential(row: QueryResultRow): AgentTokenProjection {
    return { id: text(row, 'id'), projectSlug: PARTICIPATION_PROJECT_SLUG, agentName: text(row, 'agent_name'),
      modelName: nullableText(row, 'model_name'), publicDisplayName: nullableText(row, 'public_display_name'),
      expiresAt: dateText(row.expires_at), revokedAt: row.revoked_at ? dateText(row.revoked_at) : null,
      lastSeenAt: row.last_used_at ? dateText(row.last_used_at) : null, createdAt: dateText(row.created_at) };
  }

  private agentSession(token: QueryResultRow, event?: QueryResultRow): AgentSessionProjection {
    const accessStatus: AgentSessionProjection['accessStatus'] = token.revoked_at ? 'REVOKED'
      : new Date(token.expires_at).getTime() <= this.now().getTime() ? 'EXPIRED' : 'AVAILABLE';
    const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown> : null;
    const status: AgentSessionProjection['status'] = payload?.status === 'RUNNING' || payload?.status === 'PAUSED' ? payload.status : null;
    const runMode: AgentSessionProjection['runMode'] = payload?.runMode === 'ONE_TASK' || payload?.runMode === 'THIRTY_MINUTES'
      || payload?.runMode === 'UNTIL_STOPPED' ? payload.runMode : null;
    const declaredAt = event ? dateText(event.created_at) : null;
    const lastContactAt = token.last_used_at ? dateText(token.last_used_at) : null;
    const base = { credentialId: text(token, 'id'), status, runMode, declaredAt,
      stopReason: typeof payload?.stopReason === 'string' ? payload.stopReason : null, lastContactAt, accessStatus };
    if (accessStatus === 'REVOKED') return { ...base, presence: 'UNKNOWN', presenceReason: 'ACCESS_REVOKED' };
    if (accessStatus === 'EXPIRED') return { ...base, presence: 'UNKNOWN', presenceReason: 'ACCESS_EXPIRED' };
    if (!status || !runMode || !declaredAt) return { ...base, presence: 'UNKNOWN', presenceReason: 'NO_DECLARATION' };
    if (status === 'PAUSED') return { ...base, presence: 'PAUSED', presenceReason: 'EXPLICITLY_PAUSED' };
    const now = this.now().getTime();
    if (runMode === 'THIRTY_MINUTES' && now >= new Date(declaredAt).getTime() + THIRTY_MINUTE_SESSION_MS) {
      return { ...base, presence: 'UNKNOWN', presenceReason: 'RUN_LIMIT_REACHED' };
    }
    if (!lastContactAt || now - new Date(lastContactAt).getTime() > AGENT_CONTACT_FRESHNESS_MS) {
      return { ...base, presence: 'UNKNOWN', presenceReason: 'STALE_CONTACT' };
    }
    return { ...base, presence: 'ACTIVE', presenceReason: 'FRESH_CONTACT' };
  }

  private async agentSessions(client: PoolClient, tokens: QueryResultRow[]): Promise<AgentSessionProjection[]> {
    if (!tokens.length) return [];
    const tokenIds = tokens.map(token => text(token, 'id'));
    const latest = await client.query(`SELECT DISTINCT ON (event.aggregate_id)
        event.aggregate_id,event.payload,event.created_at,event.id
      FROM motive.events event
      WHERE event.project_id=$1 AND event.aggregate_type='participation_agent'
        AND event.event_type='external.agent_session_updated' AND event.aggregate_id=ANY($2::uuid[])
      ORDER BY event.aggregate_id,event.created_at DESC,event.id DESC`, [tokens[0].project_id, tokenIds]);
    const byCredential = new Map(latest.rows.map(row => [text(row, 'aggregate_id'), row]));
    return tokens.map(token => this.agentSession(token, byCredential.get(text(token, 'id'))));
  }

  async ensureCircleWorkOrder(): Promise<{ id: string; termsDigest: string; projectRevision: number }> {
    const project = await this.pool.query(`SELECT id,current_revision,created_by FROM motive.projects
      WHERE slug=$1 AND visibility='PUBLIC'`, [PARTICIPATION_PROJECT_SLUG]);
    if (project.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'The public circle-packing project is unavailable.');
    const row = project.rows[0]; const projectId = text(row, 'id'); const revision = Number(row.current_revision);
    if (text(row, 'created_by') !== this.options.issuerActorId) throw new ParticipationError('FORBIDDEN', 'The configured issuer does not own the curated project.');
    await this.pool.query(`INSERT INTO motive.memberships (id,project_id,actor_id,role,scopes,granted_by)
      VALUES ($1,$2,$3,'OWNER',ARRAY['project:admin','work-order:create'],$3)
      ON CONFLICT (project_id,actor_id) DO NOTHING`, [randomUUID(), projectId, this.options.issuerActorId]);
    const evaluationProfile = digestCanonicalJson({ format: CHECKER_FORMAT, version: CHECKER_VERSION,
      sourceDigest: CHECKER_SOURCE_DIGEST, n: 101,
      witnessFormat: 'motive.csqv.witness.v1', maximumBytes: 32768, maximumDecimalPlaces: 18,
      referenceWitnessDigest: REFERENCE_WITNESS_DIGEST });
    const terms: WorkOrderTerms = {
      format: 'motive.work-order/0.1', project_id: projectId, project_revision: revision,
      agreement_id: AGREEMENT_ID, objective: `Run one bounded N=101 witness test, retain its exact checker outcome, and compare its radius sum with ${REFERENCE_SCORE}.`,
      input_commit: REFERENCE_COMMIT, allowed_effects: ['submit-data-only-circle-witness'],
      hosted: { enabled: false, inference: { currency: 'USD', ceiling: '0', profile_digest: evaluationProfile }, maximum_runtime_seconds: 1 },
      external: { enabled: true, claim_required: true, max_active_claims: MAX_ACTIVE_CLAIMS, max_lease_seconds: CLAIM_LIFETIME_MS / 1000,
        late_submission_policy: 'reject', review_admission: 'manual', artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
      evaluation: { profile_digest: evaluationProfile, human_acceptance_required: true },
      public_novelty_claim: 'A valid submission is a candidate only; an independent owner or steward decides acceptance.',
    };
    const work = await this.ledger.createWorkOrder({ actorId: this.options.issuerActorId,
      idempotencyKey: `${AGREEMENT_ID}-work-order`, projectId, workOrderKey: WORK_ORDER_KEY,
      revision: WORK_ORDER_REVISION, terms, state: 'READY' });
    return { id: work.id, termsDigest: work.termsDigest, projectRevision: revision };
  }

  private async workOrder(client: PoolClient): Promise<QueryResultRow> {
    const result = await client.query(`SELECT w.*,s.state,p.slug,p.visibility FROM motive.work_orders w
      JOIN motive.work_order_states s ON s.work_order_id=w.id JOIN motive.projects p ON p.id=w.project_id
      WHERE p.slug=$1 AND w.work_order_key=$2 AND w.revision=$3`, [PARTICIPATION_PROJECT_SLUG, WORK_ORDER_KEY, WORK_ORDER_REVISION]);
    if (result.rowCount !== 1 || result.rows[0].state !== 'READY' || result.rows[0].visibility !== 'PUBLIC') {
      throw new ParticipationError('NOT_FOUND', 'External contribution assignment is not available.');
    }
    return result.rows[0];
  }

  private async assignment(client: PoolClient, token: QueryResultRow, work?: QueryResultRow): Promise<AssignmentProjection> {
    const workOrder = work ?? await this.workOrder(client); const actorId = agentActor(text(token, 'id'));
    const claims = await client.query(`SELECT claim.*,completion.completed_at,intent.claim_id AS intent_claim_id,
      intent.lease_epoch AS intent_lease_epoch,intent.work_order_revision AS intent_work_order_revision,
      intent.work_order_terms_digest AS intent_terms_digest,intent.proposal AS intent_proposal,
      intent.expectation AS intent_expectation,intent.conditions AS intent_conditions,
      intent.research_context AS intent_research_context,intent.research_references AS intent_research_references,
      intent.motive_references AS intent_motive_references,intent.experiment_protocol AS intent_experiment_protocol,
      intent.protocol_fingerprint AS intent_protocol_fingerprint,
      target.binding AS intent_research_delivery_target_binding,
      intent.created_at AS intent_created_at FROM motive.work_claims claim
      LEFT JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id
      LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=claim.id
      LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=intent.claim_id
      WHERE claim.work_order_id=$1 AND claim.operator_actor_id=$2
      ORDER BY claim.lease_epoch DESC,claim.created_at DESC,claim.id DESC LIMIT 1`, [workOrder.id, actorId]);
    const terms = workOrder.terms as WorkOrderTerms;
    if (!claims.rowCount) return { id: text(workOrder, 'id'), credentialId: text(token, 'id'), claimId: null,
      projectSlug: PARTICIPATION_PROJECT_SLUG,
      projectRevision: Number(workOrder.project_revision), workOrderId: text(workOrder, 'id'), workOrderRevision: Number(workOrder.revision),
      agreementId: terms.agreement_id, termsDigest: text(workOrder, 'terms_digest'), status: 'AVAILABLE', leaseEpoch: null,
      expiresAt: null, createdAt: dateText(workOrder.created_at), completedAt: null, intent: null };
    const claim = claims.rows[0]; const completedAt = claim.completed_at ? dateText(claim.completed_at) : null;
    let status = text(claim, 'status') as AssignmentProjection['status'];
    if (completedAt) status = 'COMPLETED';
    else if (status === 'ACTIVE' && new Date(claim.expires_at).getTime() <= this.now().getTime()) status = 'EXPIRED';
    return { id: text(workOrder, 'id'), credentialId: text(token, 'id'), claimId: text(claim, 'id'),
      projectSlug: PARTICIPATION_PROJECT_SLUG,
      projectRevision: Number(workOrder.project_revision), workOrderId: text(workOrder, 'id'), workOrderRevision: Number(workOrder.revision),
      agreementId: terms.agreement_id, termsDigest: text(workOrder, 'terms_digest'), status, leaseEpoch: Number(claim.lease_epoch),
      expiresAt: dateText(claim.expires_at), createdAt: dateText(claim.created_at), completedAt,
      intent: this.assignmentIntent(claim) };
  }

  private assignmentIntent(row: QueryResultRow): AssignmentIntentProjection | null {
    if (!row.intent_claim_id) return null;
    return { claimId: text(row, 'intent_claim_id'), leaseEpoch: Number(row.intent_lease_epoch),
      workOrderRevision: Number(row.intent_work_order_revision), termsDigest: text(row, 'intent_terms_digest'),
      proposal: text(row, 'intent_proposal'), expectation: text(row, 'intent_expectation'),
      conditions: row.intent_conditions as string[],
      ...(row.intent_research_context ? { researchContext: row.intent_research_context as SubmissionResearchContext } : {}),
      ...(row.intent_research_references ? { researchReferences: row.intent_research_references as SubmissionResearchReference[] } : {}),
      ...(row.intent_motive_references ? { motiveReferences: row.intent_motive_references as SubmissionMotiveReference[] } : {}),
      ...(row.intent_experiment_protocol ? { experimentProtocol: row.intent_experiment_protocol as ExperimentProtocol } : {}),
      ...(row.intent_research_delivery_target_binding ? { researchDeliveryTarget:
        validateResearchDeliveryTargetBinding(row.intent_research_delivery_target_binding).selection } : {}),
      ...(row.intent_protocol_fingerprint ? { protocolFingerprint: text(row, 'intent_protocol_fingerprint') } : {}),
      declaredAt: dateText(row.intent_created_at) };
  }

  async join(ownerActorId: string, accountName: string, input: JoinParticipationInput, idempotencyKey: string): Promise<JoinParticipationResponse> {
    if (!/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId)) throw new ParticipationError('UNAUTHORIZED', 'A live account is required.');
    if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['acceptReferenceTerms', 'projectSlug', 'publishDisplayName'])
      || input.projectSlug !== PARTICIPATION_PROJECT_SLUG || typeof input.publishDisplayName !== 'boolean'
      || input.acceptReferenceTerms !== true) throw new ParticipationError('VALIDATION', 'Join request is invalid.');
    await this.ensureCircleWorkOrder();
    const result = await this.transaction(async client => {
      const work = await this.workOrder(client);
      await client.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
        VALUES($1,$2,$3,'CONTRIBUTOR',ARRAY['external:claim','external:submit'],$4) ON CONFLICT(project_id,actor_id) DO NOTHING`,
      [randomUUID(), work.project_id, ownerActorId, this.options.issuerActorId]);
      const membership = await client.query(`SELECT 1 FROM motive.memberships WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL FOR KEY SHARE`,
        [work.project_id, ownerActorId]);
      if (membership.rowCount !== 1) throw new ParticipationError('FORBIDDEN', 'Project membership is revoked. An owner or steward must restore access.');
      return this.idempotent(client, ownerActorId, 'participation.join', idempotencyKey, input, async tokenId => {
        const created = this.now(); const expires = new Date(created.getTime() + TOKEN_LIFETIME_MS);
        const token = this.tokenValue(tokenId, ownerActorId); const digest = sha256(token);
        const inserted = await client.query(`INSERT INTO motive.participation_agent_tokens
          (id,project_id,owner_actor_id,agent_name,model_name,public_display_name,token_digest,token_hint,license_acceptance_ref,expires_at,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [tokenId, work.project_id, ownerActorId,
          connectionName(tokenId), null, input.publishDisplayName ? accountName : null, digest,
          digest.slice(-12), LICENSE_REF, expires, created]);
        const credential = this.credential(inserted.rows[0]); const assignment = await this.assignment(client, inserted.rows[0], work);
        await this.event(client, text(work, 'project_id'), 'participation_agent', tokenId, 'external.contributor_joined', ownerActorId,
          { contributor_id: tokenId, contributor_display_name: credential.publicDisplayName });
        return { response: { credential, assignment }, resourceType: 'participation_agent', resourceId: tokenId };
      });
    });
    return { token: this.tokenValue(result.effectId, ownerActorId), credential: result.response.credential,
      assignment: result.response.assignment, warning: 'The token is shown in this response only. Send it only in the Authorization header.' };
  }

  /** Server-only exchange for a consented connector grant; never expose this value to a browser. */
  async resolveConnectorCredential(ownerActorId: string, tokenId: string): Promise<{ projectKey: string; expiresAt: string }> {
    const unauthorized = () => new ParticipationError('UNAUTHORIZED', 'The connected agent is no longer authorized.');
    if (!CANONICAL_ACCOUNT_ID.test(tokenId) || !this.options.isActorActive
      || !await this.options.isActorActive(ownerActorId)) throw unauthorized();
    const result = await this.pool.query(`SELECT token.* FROM motive.participation_agent_tokens token
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
      JOIN motive.projects project ON project.id=token.project_id
      WHERE token.id=$1 AND token.owner_actor_id=$2 AND project.slug=$3
        AND token.revoked_at IS NULL AND token.expires_at>$4 AND membership.revoked_at IS NULL`,
    [tokenId, ownerActorId, PARTICIPATION_PROJECT_SLUG, this.now()]);
    if (result.rowCount !== 1) throw unauthorized();
    const row = result.rows[0];
    const projectKey = this.tokenValue(tokenId, ownerActorId);
    if (sha256(projectKey) !== row.token_digest) throw unauthorized();
    return { projectKey, expiresAt: dateText(row.expires_at) };
  }

  async authenticateBearer(raw: string): Promise<ParticipationAgentContext> {
    if (!/^motive_agent_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(raw)) throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid.');
    const digest = sha256(raw); const observedAt = this.now();
    const result = await this.pool.query(`UPDATE motive.participation_agent_tokens
      SET last_used_at=clock_timestamp()
      WHERE token_digest=$1 AND revoked_at IS NULL AND expires_at>$2
      RETURNING *`, [digest, observedAt]);
    if (result.rowCount !== 1) {
      const known = await this.pool.query(`SELECT 1 FROM motive.participation_agent_tokens WHERE token_digest=$1`, [digest]);
      if (known.rowCount !== 1) throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid.');
      throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid or expired.');
    }
    const row = result.rows[0];
    if (row.revoked_at || new Date(row.expires_at).getTime() <= this.now().getTime()) throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid or expired.');
    return { tokenId: text(row, 'id'), actorId: agentActor(text(row, 'id')), ownerActorId: text(row, 'owner_actor_id'),
      projectId: text(row, 'project_id'), expiresAt: dateText(row.expires_at) };
  }

  private async tokenForUpdate(client: PoolClient, context: ParticipationAgentContext): Promise<QueryResultRow> {
    const result = await client.query(`SELECT token.* FROM motive.participation_agent_tokens token
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
      WHERE token.id=$1 AND membership.revoked_at IS NULL FOR UPDATE OF token FOR KEY SHARE OF membership`, [context.tokenId]);
    if (result.rowCount !== 1 || result.rows[0].revoked_at || new Date(result.rows[0].expires_at).getTime() <= this.now().getTime()) {
      throw new ParticipationError('UNAUTHORIZED', 'Agent token is invalid or expired.');
    }
    const token = result.rows[0];
    if (context.actorId !== agentActor(text(token, 'id')) || context.ownerActorId !== text(token, 'owner_actor_id')
      || context.projectId !== text(token, 'project_id')) throw new ParticipationError('UNAUTHORIZED', 'Agent token context is invalid.');
    return token;
  }

  async getAgentAssignment(context: ParticipationAgentContext): Promise<AgentAssignmentResponse> {
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context);
      return { credential: this.credential(token), assignment: await this.assignment(client, token), submissionPath: '/api/agent/assignments/{assignmentId}/submissions' };
    });
  }

  async setAgentSession(context: ParticipationAgentContext, rawInput: SetAgentSessionInput,
    idempotencyKey: string): Promise<AgentSessionProjection> {
    const input = agentSessionInput(rawInput);
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context);
      const result = await this.idempotent(client, context.actorId, 'participation.agent.session.update', idempotencyKey,
        input, async () => {
          await this.event(client, context.projectId, 'participation_agent', context.tokenId,
            'external.agent_session_updated', context.actorId, {
              status: input.status, runMode: input.runMode,
              stopReason: input.status === 'PAUSED' ? input.stopReason ?? null : null,
            });
          const session = (await this.agentSessions(client, [token]))[0];
          if (!session) throw new Error('Agent session projection is unavailable.');
          return { response: session, resourceType: 'participation_agent', resourceId: context.tokenId };
        });
      return result.response;
    });
  }

  async getOwnedAgentWorkQueue(ownerActorId: string, tokenId: string): Promise<AgentWorkQueueResponse> {
    if (!/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId) || !CANONICAL_ACCOUNT_ID.test(tokenId)) {
      throw new ParticipationError('NOT_FOUND', 'Agent credential not found.');
    }
    const result = await this.pool.query(`SELECT token.* FROM motive.participation_agent_tokens token
      JOIN motive.projects project ON project.id=token.project_id
      WHERE token.id=$1 AND token.owner_actor_id=$2 AND project.slug=$3`,
    [tokenId, ownerActorId, PARTICIPATION_PROJECT_SLUG]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Agent credential not found.');
    const token = result.rows[0];
    return this.agentWorkQueue({ tokenId, actorId: agentActor(tokenId), ownerActorId,
      projectId: text(token, 'project_id'), expiresAt: dateText(token.expires_at) });
  }

  private async validationCandidate(client:PoolClient,context:ParticipationAgentContext,
    benchmarkImprovementOnly:boolean):Promise<AgentWorkQueueValidationTarget|null>{
    const candidates = await client.query(`WITH ${DURABLE_VERIFIED_IMPROVEMENTS_CTE}
      SELECT submission.id,submission.work_order_id,
        true AS has_investigation,true AS has_post_check_assessment,true AS has_reproducibility,
        artifact.agent_token_id,artifact.contributor_display_name,token.agent_name,token.model_name,
        submission.created_at,artifact.report,artifact.report_digest,artifact.witness_digest,artifact.exact_score,
        artifact.exceeds_reference,review.decision
      FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
        AND artifact.project_id=submission.project_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
        AND token.project_id=submission.project_id
      JOIN motive.participation_claim_completions completion ON completion.claim_id=submission.claim_id
        AND completion.submission_id=submission.id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
        AND assessment.project_id=submission.project_id AND assessment.report_digest=artifact.report_digest
      JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
        AND reproducibility.project_id=submission.project_id AND reproducibility.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id
      WHERE submission.project_id=$1 AND submission.origin='EXTERNAL'
        AND token.owner_actor_id<>$2
        AND jsonb_typeof(submission.provenance->'investigation')='object'
        AND (NOT $3::boolean OR (artifact.report='VALID' AND artifact.exceeds_reference=TRUE))
        AND NOT EXISTS (SELECT 1 FROM motive.finding_review_decisions legacy
          WHERE legacy.source_submission_id=submission.id
            AND legacy.review_package->>'format'='motive.finding-review-package/0.1')
        AND (NOT $3::boolean OR NOT EXISTS(SELECT 1 FROM durable_verified_improvements verified
          WHERE verified.project_id=submission.project_id AND verified.submission_id=submission.id))
        AND (NOT $3::boolean
          OR NOT EXISTS(SELECT 1 FROM durable_verified_improvements verified
            WHERE verified.project_id=submission.project_id)
          OR artifact.exact_score::numeric>(SELECT max(verified.exact_score::numeric)
            FROM durable_verified_improvements verified WHERE verified.project_id=submission.project_id))
        AND NOT EXISTS (
          SELECT 1 FROM motive.participation_claim_intents cited_intent
          JOIN motive.participation_agent_tokens cited_token ON cited_token.id=cited_intent.agent_token_id
          JOIN motive.participation_claim_completions cited_completion ON cited_completion.claim_id=cited_intent.claim_id
          WHERE cited_intent.project_id=$1 AND cited_token.owner_actor_id=$2
            AND motive.valid_agent_finding_review_proof($2,cited_token.id,
              cited_completion.submission_id,submission.id,$1))
      ORDER BY CASE WHEN $3::boolean THEN artifact.exact_score::numeric END DESC NULLS LAST,
        submission.created_at ASC,submission.id ASC LIMIT 1`,
    [context.projectId,context.ownerActorId,benchmarkImprovementOnly]);
    if(!candidates.rowCount)return null;const row=candidates.rows[0];
    return{submission:this.submissionSummary(row),reference:{submissionId:text(row,'id'),
      reportDigest:text(row,'report_digest'),artifactDigest:text(row,'witness_digest')}};
  }

  async agentWorkQueue(context: ParticipationAgentContext): Promise<AgentWorkQueueResponse> {
    const queued = await this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context);
      const assignment = await this.assignment(client, token);
      const response = (nextTask: AgentWorkQueueResponse['nextTask']): AgentWorkQueueResponse => ({
        format: 'motive.agent-work-queue.v1', assignment, nextTask,
        cadence: { discovery: 1, validation: 1 }, validationAuthority: nextTask.kind==='FINDING_REVIEW'
          ?'REPLICATION_BOUND_FINDING_DECISION':'EVIDENCE_ONLY',
      });
      if (assignment.status === 'ACTIVE') {
        return response({ kind: 'RESUME', reason: 'ACTIVE_CLAIM', target: null });
      }

      const pendingReview=await client.query(`SELECT completion.submission_id::text AS review_submission_id,
          marker.target_submission_id::text
        FROM motive.participation_claim_intents intent
        JOIN motive.participation_claim_completions completion ON completion.claim_id=intent.claim_id
        JOIN LATERAL(SELECT CASE WHEN input->>'value'~
          '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
          THEN (input->>'value')::uuid ELSE NULL END AS target_submission_id
          FROM jsonb_array_elements(intent.experiment_protocol->'inputs') input
          WHERE input->>'name'='review_target_submission_id') marker ON marker.target_submission_id IS NOT NULL
        JOIN motive.submissions target ON target.id=marker.target_submission_id AND target.project_id=intent.project_id
          AND jsonb_typeof(target.provenance->'investigation')='object'
        WHERE intent.project_id=$1 AND intent.agent_token_id=$2
          AND intent.experiment_protocol->>'purpose'='REPLICATION'
          AND motive.valid_agent_finding_review_proof($3,$2,completion.submission_id,marker.target_submission_id,$1)
          AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions decision
            WHERE decision.review_submission_id=completion.submission_id)
          AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions legacy
            WHERE legacy.source_submission_id=marker.target_submission_id
              AND legacy.review_package->>'format'='motive.finding-review-package/0.1')
        ORDER BY completion.completed_at ASC,completion.submission_id ASC LIMIT 1`,
      [context.projectId,context.tokenId,context.ownerActorId]);
      if(pendingReview.rowCount){
        const reviewSubmissionId=text(pendingReview.rows[0],'review_submission_id');
        const targetSubmissionId=text(pendingReview.rows[0],'target_submission_id');
        const base=`/api/agent/finding-reviews/${reviewSubmissionId}/targets/${targetSubmissionId}`;
        return response({kind:'FINDING_REVIEW',reason:'COMPLETED_REPLICATION_PENDING_REVIEW',target:{
          reviewSubmissionId,targetSubmissionId,previewHref:`${base}/preview`,decisionHref:`${base}/decisions`}});
      }

      const priorityImprovement=await this.validationCandidate(client,context,true);
      if(priorityImprovement)return response({kind:'VALIDATION',reason:'BENCHMARK_IMPROVEMENT_PRIORITY',
        target:priorityImprovement});

      const history = await client.query(`SELECT
          count(*)::integer AS completed_attempts,
          (SELECT coalesce(marker.target_submission_id IS NOT NULL
              AND motive.valid_agent_finding_review_proof($4,$3,recent_completion.submission_id,
                marker.target_submission_id,$1)
              AND EXISTS(SELECT 1 FROM motive.finding_review_decisions decision
                WHERE decision.review_submission_id=recent_completion.submission_id
                  AND decision.reviewer_agent_token_id=$3
                  AND decision.source_submission_id=marker.target_submission_id),FALSE)
            FROM motive.participation_claim_completions recent_completion
            JOIN motive.work_claims recent_claim ON recent_claim.id=recent_completion.claim_id
            LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=recent_claim.id
            LEFT JOIN LATERAL(SELECT CASE WHEN count(*)=1 AND min(input->>'value')~
                '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
                THEN min(input->>'value')::uuid ELSE NULL END AS target_submission_id
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(intent.experiment_protocol->'inputs')='array'
                THEN intent.experiment_protocol->'inputs' ELSE '[]'::jsonb END) input
              WHERE input->>'name'='review_target_submission_id') marker ON TRUE
            WHERE recent_claim.project_id=$1 AND recent_claim.operator_actor_id=$2
            ORDER BY recent_completion.completed_at DESC,recent_completion.claim_id DESC LIMIT 1)
            AS latest_qualified_peer_validation
        FROM motive.participation_claim_completions completion
        JOIN motive.work_claims claim ON claim.id=completion.claim_id
        WHERE claim.project_id=$1 AND claim.operator_actor_id=$2`,
      [context.projectId,context.actorId,context.tokenId,context.ownerActorId]);
      const completedAttempts = Number(history.rows[0]?.completed_attempts ?? 0);
      if (!completedAttempts || history.rows[0]?.latest_qualified_peer_validation === true) {
        return response({ kind: 'DISCOVERY', reason: 'DISCOVERY_TURN', target: null });
      }

      const candidate=await this.validationCandidate(client,context,false);
      if (!candidate) {
        return response({ kind: 'DISCOVERY', reason: 'EMPTY_PEER_POOL', target: null });
      }
      return response({ kind: 'VALIDATION', reason: 'PEER_VALIDATION_DUE', target: candidate });
    });
    if (queued.nextTask.kind === 'RESUME' || queued.nextTask.kind === 'FINDING_REVIEW') return queued;
    const recovered = await this.options.nextReadyRecoveredFinding?.(context);
    if (recovered) {
      if (recovered.format !== 'motive.agent-memory-recovery-checkpoint/0.1' || recovered.status !== 'READY'
        || !recovered.policyId || !recovered.deliveryId || !recovered.findingDecisionId || !recovered.syncPath) {
        throw new Error('Ready recovered finding callback returned an invalid checkpoint.');
      }
      return { ...queued, nextTask: { kind: 'RESEARCH_SYNC', reason: 'READY_RESEARCH_DELIVERY', researchDelivery: recovered } };
    }
    if (!this.options.nextReadyResearchDelivery) return queued;
    const delivery = await this.options.nextReadyResearchDelivery(context);
    if (!delivery) return queued;
    if (delivery.status !== 'READY' || delivery.reason !== 'READY_FOR_SYNC'
      || !delivery.policyId || !delivery.syncPath) {
      throw new Error('Ready research delivery callback returned an invalid checkpoint.');
    }
    return { ...queued, nextTask: { kind: 'RESEARCH_SYNC', reason: 'READY_RESEARCH_DELIVERY', researchDelivery: delivery } };
  }

  async experimentProtocolMatches(context: ParticipationAgentContext, rawProtocol: unknown,
    rawCursor?: string): Promise<ExperimentProtocolMatches> {
    const protocol = validateProtocol(rawProtocol);
    const cursor = decodeProtocolCursor(rawCursor);
    return this.transaction(async client => {
      await this.tokenForUpdate(client, context);
      const work = await this.workOrder(client);
      if (text(work, 'project_id') !== context.projectId) throw new ParticipationError('UNAUTHORIZED', 'Project access is unavailable.');
      const fingerprint = digestCanonicalJson(experimentProtocolFingerprintPreimage({ projectId: context.projectId,
        workOrderId: text(work, 'id'), workOrderRevision: Number(work.revision),
        workOrderTermsDigest: text(work, 'terms_digest') }, protocol));
      if (cursor && (cursor.projectId !== context.projectId || cursor.workOrderId !== text(work, 'id')
        || cursor.workOrderRevision !== Number(work.revision) || cursor.protocolFingerprint !== fingerprint)) {
        throw new ParticipationError('VALIDATION', 'Experiment protocol match cursor does not match this project and protocol.');
      }
      if (cursor) {
        const anchor = await client.query(`SELECT 1 FROM motive.participation_claim_intents
          WHERE project_id=$1 AND work_order_id=$2 AND work_order_revision=$3
            AND protocol_fingerprint=$4 AND claim_id=$5`,
        [context.projectId, work.id, work.revision, fingerprint, cursor.claimId]);
        if (anchor.rowCount !== 1) throw new ParticipationError('VALIDATION', 'Experiment protocol match cursor is unavailable.');
      }
      const result = await client.query(`WITH page AS MATERIALIZED (
          SELECT intent.claim_id,intent.experiment_protocol,intent.proposal,intent.created_at,claim.expires_at,
            CASE WHEN completion.claim_id IS NOT NULL THEN 'COMPLETED'
              WHEN claim.status='EXPIRED' OR (claim.status='ACTIVE' AND claim.expires_at<=clock_timestamp()) THEN 'EXPIRED'
              WHEN claim.status='RELEASED' THEN 'RELEASED' ELSE 'ACTIVE' END AS match_status
          FROM motive.participation_claim_intents intent
          JOIN motive.work_claims claim ON claim.id=intent.claim_id AND claim.project_id=intent.project_id
          LEFT JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id
          WHERE intent.project_id=$1 AND intent.work_order_id=$2 AND intent.work_order_revision=$3
            AND intent.protocol_fingerprint=$4
            AND (completion.claim_id IS NOT NULL OR claim.status IN ('ACTIVE','EXPIRED','RELEASED'))
            AND ($5::uuid IS NULL OR intent.created_at < (SELECT anchor.created_at
                  FROM motive.participation_claim_intents anchor WHERE anchor.claim_id=$5::uuid)
              OR (intent.created_at = (SELECT anchor.created_at
                  FROM motive.participation_claim_intents anchor WHERE anchor.claim_id=$5::uuid)
                AND intent.claim_id<$5::uuid))
          ORDER BY intent.created_at DESC,intent.claim_id DESC LIMIT 21
        ) SELECT page.*,
          receipt.submission_id,receipt.report_digest,receipt.witness_digest,release.stop_reason
        FROM page
        LEFT JOIN LATERAL (SELECT submission.id AS submission_id,artifact.report_digest,artifact.witness_digest
          FROM motive.submissions submission JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          WHERE submission.claim_id=page.claim_id AND submission.project_id=$1
          ORDER BY submission.created_at DESC,submission.id DESC LIMIT 1) receipt ON true
        LEFT JOIN LATERAL (SELECT event.payload->>'stop_reason' AS stop_reason FROM motive.events event
          WHERE event.project_id=$1 AND event.aggregate_type='work_claim' AND event.aggregate_id=page.claim_id
            AND event.event_type='external.assignment_released' AND jsonb_typeof(event.payload->'stop_reason')='string'
          ORDER BY event.created_at DESC,event.id DESC LIMIT 1) release ON true
        ORDER BY page.created_at DESC,page.claim_id DESC`,
      [context.projectId, work.id, work.revision, fingerprint, cursor?.claimId ?? null]);
      const page = result.rows.slice(0, 20);
      const last = page.at(-1);
      return { format: 'motive.experiment-protocol-matches.v1', experimentProtocol: protocol, protocolFingerprint: fingerprint,
        matches: page.map(row => ({ claimId: text(row, 'claim_id'), status: text(row, 'match_status') as 'ACTIVE'|'COMPLETED'|'EXPIRED'|'RELEASED',
          purpose: (row.experiment_protocol as ExperimentProtocol).purpose, proposal: text(row, 'proposal'), declaredAt: dateText(row.created_at),
          expiresAt: dateText(row.expires_at), stopReason: nullableText(row, 'stop_reason'), submission: row.submission_id ? { submissionId: text(row, 'submission_id'),
            reportDigest: text(row, 'report_digest'), artifactDigest: text(row, 'witness_digest') } : null })),
        nextCursor: result.rows.length > 20 && last ? encodeProtocolCursor({ v: 1, projectId: context.projectId,
          workOrderId: text(work, 'id'), workOrderRevision: Number(work.revision), protocolFingerprint: fingerprint,
          claimId: text(last, 'claim_id') }) : null,
        notice: 'Exact declared protocol inputs are advisory coordination data. They do not reserve an idea or establish geometric or scientific equivalence.' };
    });
  }

  private async activeClaim(client: PoolClient, context: ParticipationAgentContext, workOrderId: string, leaseEpoch?: number): Promise<QueryResultRow> {
    const result = await client.query(`SELECT claim.* FROM motive.work_claims claim
      WHERE claim.work_order_id=$1 AND claim.operator_actor_id=$2 AND claim.status='ACTIVE'
      ORDER BY claim.created_at DESC LIMIT 1 FOR UPDATE`, [workOrderId, context.actorId]);
    if (result.rowCount !== 1) throw new ParticipationError('CONFLICT', 'No active claim exists for this assignment.');
    const row = result.rows[0];
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
      await client.query(`UPDATE motive.work_claims SET status='EXPIRED',updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      throw new ParticipationError('EXPIRED', 'The assignment claim expired. Claim it again.');
    }
    if (leaseEpoch !== undefined && Number(row.lease_epoch) !== leaseEpoch) throw new ParticipationError('CONFLICT', 'The assignment lease epoch is stale.');
    return row;
  }

  async claimAssignment(context: ParticipationAgentContext, assignmentId: string, idempotencyKey: string): Promise<AssignmentProjection> {
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context); const work = await this.workOrder(client);
      if (text(work, 'id') !== assignmentId) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
      await client.query(`SELECT id FROM motive.work_orders WHERE id=$1 FOR UPDATE`, [assignmentId]);
      return (await this.idempotent(client, context.actorId, 'participation.assignment.claim', idempotencyKey,
        { assignmentId }, async effectId => {
          await client.query(`UPDATE motive.work_claims SET status='EXPIRED',updated_at=clock_timestamp()
            WHERE work_order_id=$1 AND status='ACTIVE' AND expires_at<=clock_timestamp()`, [assignmentId]);
          const current = await client.query(`SELECT id FROM motive.work_claims WHERE work_order_id=$1 AND operator_actor_id=$2 AND status='ACTIVE'`, [assignmentId, context.actorId]);
          if (!current.rowCount) {
            const terms = work.terms as WorkOrderTerms;
            const count = await client.query(`SELECT count(*)::integer AS count FROM motive.work_claims WHERE work_order_id=$1 AND status='ACTIVE'`, [assignmentId]);
            if (Number(count.rows[0].count) >= terms.external.max_active_claims) throw new ParticipationError('CONFLICT', 'No external assignment capacity is available.');
            const slot = await client.query(`SELECT candidate FROM generate_series(1,$2::integer) candidate
              WHERE NOT EXISTS (SELECT 1 FROM motive.work_claims claim WHERE claim.work_order_id=$1 AND claim.slot=candidate AND claim.status='ACTIVE')
              ORDER BY candidate LIMIT 1`, [assignmentId, terms.external.max_active_claims]);
            if (!slot.rowCount) throw new ParticipationError('CONFLICT', 'No external assignment slot is available.');
            const priorEpoch = await client.query(`SELECT coalesce(max(lease_epoch),0)::integer AS epoch
              FROM motive.work_claims WHERE work_order_id=$1 AND operator_actor_id=$2`, [assignmentId, context.actorId]);
            const leaseEpoch = Number(priorEpoch.rows[0].epoch) + 1;
            const expiration = new Date(Math.min(this.now().getTime() + CLAIM_LIFETIME_MS, new Date(token.expires_at).getTime()));
            await client.query(`INSERT INTO motive.work_claims
              (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at)
              VALUES ($1,$2,$3,$4,'EXTERNAL',$5,$6,$7,'ACTIVE',$8)`,
            [effectId, work.project_id, assignmentId, context.actorId, slot.rows[0].candidate, leaseEpoch, work.terms_digest, expiration]);
            await this.event(client, text(work, 'project_id'), 'work_claim', effectId, 'external.assignment_claimed', context.actorId,
              { contributor_id: context.tokenId, contributor_display_name: token.public_display_name, claim_id: effectId });
          }
          return { response: await this.assignment(client, token, work), resourceType: 'work_claim', resourceId: current.rows[0]?.id ?? effectId };
        })).response;
    });
  }

  async renewAssignment(context: ParticipationAgentContext, assignmentId: string, input: FencedAssignmentInput, idempotencyKey: string): Promise<AssignmentProjection> {
    return this.fencedMutation(context, assignmentId, input, idempotencyKey, 'renew', async (client, token, work, claim) => {
      const expiration = new Date(Math.min(this.now().getTime() + CLAIM_LIFETIME_MS, new Date(token.expires_at).getTime()));
      await client.query(`UPDATE motive.work_claims SET expires_at=$2,updated_at=clock_timestamp() WHERE id=$1`, [claim.id, expiration]);
      return this.assignment(client, token, work);
    });
  }

  private async assertMotiveReferences(projectId: string, references: SubmissionMotiveReference[], client: PoolClient): Promise<void> {
    const found = await client.query(`SELECT artifact.submission_id::text,artifact.report_digest,artifact.witness_digest
      FROM motive.participation_submission_artifacts artifact
      JOIN motive.submissions submission ON submission.id=artifact.submission_id AND submission.project_id=artifact.project_id
      WHERE artifact.project_id=$1 AND artifact.submission_id=ANY($2::uuid[]) AND artifact.created_at<clock_timestamp()
        AND submission.origin='EXTERNAL' FOR KEY SHARE OF artifact,submission`,
    [projectId,references.map(reference => reference.submissionId)]);
    if (found.rowCount !== references.length) throw new ParticipationError('VALIDATION', 'Motive references must identify prior submissions from this project.');
    const rows = new Map(found.rows.map(row => [text(row,'submission_id'),row]));
    for (const reference of references) {
      const row = rows.get(reference.submissionId);
      if (!row || text(row,'report_digest') !== reference.reportDigest || text(row,'witness_digest') !== reference.artifactDigest) {
        throw new ParticipationError('VALIDATION', 'Motive references must match immutable project artifact and report digests.');
      }
    }
  }

  async declareAssignmentIntent(context: ParticipationAgentContext, assignmentId: string,
    rawInput: DeclareAssignmentIntentInput, idempotencyKey: string): Promise<AssignmentProjection> {
    const input = validateAssignmentIntent(rawInput);
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context);
      const account = await client.query(`SELECT account.status FROM motive.account_identities account
        JOIN motive.memberships membership ON membership.actor_id=account.actor_id
        WHERE account.actor_id=$1 AND membership.project_id=$2 AND membership.revoked_at IS NULL
        FOR SHARE OF account,membership`, [context.ownerActorId, context.projectId]);
      if (account.rowCount !== 1 || account.rows[0].status !== 'ACTIVE') {
        throw new ParticipationError('UNAUTHORIZED', 'The owning account is no longer active.');
      }
      const work = await this.workOrder(client);
      if (text(work, 'id') !== assignmentId) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
      const protocolFingerprint = input.experimentProtocol ? digestCanonicalJson(experimentProtocolFingerprintPreimage({
        projectId: text(work, 'project_id'), workOrderId: text(work, 'id'), workOrderRevision: Number(work.revision),
        workOrderTermsDigest: text(work, 'terms_digest') }, input.experimentProtocol)) : null;
      const current = await client.query(`SELECT 1 FROM motive.projects project
        JOIN motive.work_orders work ON work.project_id=project.id
        JOIN motive.work_order_states state ON state.work_order_id=work.id
        WHERE work.id=$1 AND project.id=$2 AND project.current_revision=work.project_revision
          AND project.visibility='PUBLIC' AND state.state='READY' AND work.terms_digest=$3 FOR SHARE OF project,work,state`,
      [assignmentId, context.projectId, work.terms_digest]);
      if (current.rowCount !== 1) throw new ParticipationError('CONFLICT', 'Assignment terms are no longer current.');
      const request = { assignmentId, ...input };
      return (await this.idempotent(client, context.actorId, 'participation.assignment.intent', idempotencyKey, request, async () => {
        const claim = await this.activeClaim(client, context, assignmentId, input.leaseEpoch);
        if (text(claim, 'terms_digest') !== text(work, 'terms_digest')) {
          throw new ParticipationError('CONFLICT', 'The assignment claim terms are no longer current.');
        }
        const requestDigest = digestCanonicalJson(request);
        const existing = await client.query(`SELECT request_digest FROM motive.participation_claim_intents
          WHERE claim_id=$1 FOR KEY SHARE`, [claim.id]);
        if (existing.rowCount) {
          if (text(existing.rows[0], 'request_digest') !== requestDigest) {
            throw new ParticipationError('CONFLICT', 'This claim already has a different immutable intent declaration.');
          }
        } else {
          const submitted = await client.query(`SELECT 1 FROM motive.submissions WHERE claim_id=$1 LIMIT 1`, [claim.id]);
          if (submitted.rowCount) throw new ParticipationError('CONFLICT', 'Intent must be declared before the first submission for this claim.');
          if (input.researchContext) {
            if (!this.options.validateResearchContext) throw new ParticipationError('VALIDATION', 'Shared research context is not configured.');
            try { await this.options.validateResearchContext(context.projectId, input.researchContext, client); }
            catch { throw new ParticipationError('VALIDATION', 'Research context must match a retained snapshot for this project.'); }
          }
          if (input.researchReferences?.length) {
            if (!this.options.validateResearchReferences) throw new ParticipationError('VALIDATION', 'Shared research references are not configured.');
            try { await this.options.validateResearchReferences(context.projectId, input.researchReferences, client); }
            catch { throw new ParticipationError('VALIDATION', 'Research references must match retained snapshots for this project.'); }
          }
          if (input.motiveReferences) await this.assertMotiveReferences(context.projectId,input.motiveReferences,client);
          let targetBinding: ResearchDeliveryTargetBinding | undefined;
          if (input.researchDeliveryTarget) {
            if (!this.options.resolveResearchDeliveryTarget) {
              throw new ParticipationError('VALIDATION', 'Research delivery target selection is not configured.');
            }
            try {
              targetBinding = validateResearchDeliveryTargetBinding(await this.options.resolveResearchDeliveryTarget(
                context.projectId, input.researchDeliveryTarget, client));
            } catch (error) {
              if (error instanceof ParticipationError) throw error;
              throw new ParticipationError('VALIDATION', 'Research delivery target must match a retained hypothesis observation for this project.');
            }
            if (!researchDeliveryTargetSelectionsEqual(targetBinding.selection, input.researchDeliveryTarget)) {
              throw new ParticipationError('VALIDATION', 'Resolved research delivery target does not match the declared selection.');
            }
          }
          const insertedIntent = await client.query(`INSERT INTO motive.participation_claim_intents
            (claim_id,project_id,work_order_id,work_order_revision,work_order_terms_digest,lease_epoch,agent_token_id,
             proposal,expectation,conditions,research_context,research_references,motive_references,experiment_protocol,protocol_fingerprint,request_digest)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)
            RETURNING created_at`,
          [claim.id, context.projectId, assignmentId, work.revision, work.terms_digest, input.leaseEpoch, context.tokenId,
            input.proposal, input.expectation, input.conditions,
            input.researchContext ? JSON.stringify(input.researchContext) : null,
            input.researchReferences ? JSON.stringify(input.researchReferences) : null,
            input.motiveReferences ? JSON.stringify(input.motiveReferences) : null,
            input.experimentProtocol ? JSON.stringify(input.experimentProtocol) : null, protocolFingerprint, requestDigest]);
          if (targetBinding) {
            if (insertedIntent.rowCount !== 1) throw new Error('Inserted intent is unavailable.');
            await client.query(`INSERT INTO motive.participation_claim_research_targets
              (claim_id,project_id,binding,binding_digest,intent_request_digest,declared_at)
              VALUES($1,$2,$3::jsonb,$4,$5,$6)`, [claim.id, context.projectId, JSON.stringify(targetBinding),
              digestCanonicalJson(targetBinding), requestDigest, insertedIntent.rows[0].created_at]);
          }
          await this.event(client, context.projectId, 'work_claim', text(claim, 'id'),
            'external.assignment_intent_declared', context.actorId,
            { contributor_id: context.tokenId, contributor_display_name: token.public_display_name, claim_id: claim.id });
        }
        return { response: await this.assignment(client, token, work), resourceType: 'participation_claim_intent',
          resourceId: text(claim, 'id') };
      })).response;
    });
  }

  async releaseAssignment(context: ParticipationAgentContext, assignmentId: string, rawInput: ReleaseAssignmentInput, idempotencyKey: string): Promise<AssignmentProjection> {
    const input=validateReleaseAssignment(rawInput);
    return this.fencedMutation(context, assignmentId, input, idempotencyKey, 'release', async (client, token, work, claim) => {
      await client.query(`UPDATE motive.work_claims SET status='RELEASED',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [claim.id]);
      await this.event(client, text(work, 'project_id'), 'work_claim', text(claim, 'id'), 'external.assignment_released', context.actorId,
        { contributor_id: context.tokenId, contributor_display_name: token.public_display_name,
          agent_name: token.agent_name, claim_id: claim.id,
          ...(input.stopReason === undefined ? {} : { stop_reason: input.stopReason }) });
      return this.assignment(client, token, work);
    });
  }

  private async fencedMutation(context: ParticipationAgentContext, assignmentId: string, input: FencedAssignmentInput, key: string, action: string,
    mutate: (client: PoolClient, token: QueryResultRow, work: QueryResultRow, claim: QueryResultRow) => Promise<AssignmentProjection>): Promise<AssignmentProjection> {
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context); const work = await this.workOrder(client);
      if (text(work, 'id') !== assignmentId) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
      return (await this.idempotent(client, context.actorId, `participation.assignment.${action}`, key, { assignmentId, ...input }, async () => {
        const claim = await this.activeClaim(client, context, assignmentId, input.leaseEpoch);
        return { response: await mutate(client, token, work, claim), resourceType: 'work_claim', resourceId: text(claim, 'id') };
      })).response;
    });
  }

  async submitWitness(context: ParticipationAgentContext, assignmentId: string, input: SubmitCircleWitnessInput, idempotencyKey: string): Promise<SubmissionSummary> {
    const bytes = Buffer.from(input.witness, 'utf8');
    if (bytes.length < 1 || bytes.length > 32768) throw new ParticipationError('VALIDATION', 'Witness must be 1â€“32768 UTF-8 bytes.');
    const investigation = validateInvestigation(input.investigation);
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context); const work = await this.workOrder(client);
      if (text(work, 'id') !== assignmentId) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
      return (await this.idempotent(client, context.actorId, 'participation.submission.create', idempotencyKey,
        { assignmentId, ...input }, async submissionId => {
          const claim = await this.activeClaim(client, context, assignmentId, input.leaseEpoch);
          const declaredIntent = await client.query(`SELECT intent.motive_references,intent.experiment_protocol,target.binding AS research_delivery_target_binding
            FROM motive.participation_claim_intents intent
            LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=intent.claim_id
            WHERE intent.claim_id=$1 FOR KEY SHARE OF intent`, [claim.id]);
          if (declaredIntent.rowCount && !investigation) {
            throw new ParticipationError('VALIDATION', 'A claim with a declared intent must submit a final investigation record.');
          }
          const declaredTarget = declaredIntent.rowCount && declaredIntent.rows[0].research_delivery_target_binding
            ? validateResearchDeliveryTargetBinding(declaredIntent.rows[0].research_delivery_target_binding).selection : undefined;
          if (declaredTarget || investigation?.researchDeliveryTarget) {
            if (!declaredTarget || !investigation?.researchDeliveryTarget
              || !researchDeliveryTargetSelectionsEqual(declaredTarget, investigation.researchDeliveryTarget)) {
              throw new ParticipationError('VALIDATION', 'The research delivery target must be declared before testing and repeated unchanged in the final investigation.');
            }
          }
          const declaredMotiveReferences = declaredIntent.rowCount && declaredIntent.rows[0].motive_references !== null
            ? declaredIntent.rows[0].motive_references as SubmissionMotiveReference[] : undefined;
          if (declaredMotiveReferences || investigation?.motiveReferences) {
            if (!declaredIntent.rowCount || !declaredMotiveReferences || !investigation?.motiveReferences
              || digestCanonicalJson(declaredMotiveReferences) !== digestCanonicalJson(investigation.motiveReferences)) {
              throw new ParticipationError('VALIDATION', 'Motive references must be declared in the claim intent and repeated unchanged in the final investigation.');
            }
            await this.assertMotiveReferences(context.projectId,investigation.motiveReferences,client);
          }
          const declaredProtocol = declaredIntent.rowCount && declaredIntent.rows[0].experiment_protocol !== null
            ? declaredIntent.rows[0].experiment_protocol as ExperimentProtocol : undefined;
          if (declaredProtocol || investigation?.experimentProtocol) {
            if (!declaredIntent.rowCount || !declaredProtocol || !investigation?.experimentProtocol
              || digestCanonicalJson(declaredProtocol) !== digestCanonicalJson(investigation.experimentProtocol)) {
              throw new ParticipationError('VALIDATION', 'The experiment protocol must be declared in the claim intent and repeated unchanged in the final investigation.');
            }
          }
          if (investigation?.researchContext) {
            if (!this.options.validateResearchContext) throw new ParticipationError('VALIDATION', 'Shared research context is not configured.');
            try { await this.options.validateResearchContext(context.projectId, investigation.researchContext, client); }
            catch { throw new ParticipationError('VALIDATION', 'Research context must match a retained snapshot for this project.'); }
          }
          if (investigation?.researchReferences?.length) {
            if (!this.options.validateResearchReferences) throw new ParticipationError('VALIDATION', 'Shared research references are not configured.');
            try { await this.options.validateResearchReferences(context.projectId, investigation.researchReferences, client); }
            catch { throw new ParticipationError('VALIDATION', 'Research references must match retained snapshots for this project.'); }
          }
          const checked = checkCirclePackingWitness(input.witness);
          const witnessDigest = sha256(bytes);
          const manifestDigest = digestCanonicalJson({ format: 'motive.external-circle-artifact/0.1', witness_digest: witnessDigest, bytes: bytes.length });
          const terms = work.terms as WorkOrderTerms;
          const attribution = { kind: 'AGENT_DECLARED' as const, agentName: text(token, 'agent_name'),
            modelName: nullableText(token, 'model_name'), contributorDisplayName: nullableText(token, 'public_display_name') };
          const agentInvestigation = investigation ? { attribution, investigation,
            interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' as const } : null;
          const reportEnvelope = { format: 'motive.csqv.checked-report.v1', binding: {
            projectId: text(work, 'project_id'), projectRevision: Number(work.project_revision), workOrderId: assignmentId,
            workOrderRevision: Number(work.revision), agreementId: terms.agreement_id, termsDigest: text(work, 'terms_digest'),
            claimId: text(claim, 'id'), leaseEpoch: Number(claim.lease_epoch), submissionId,
            artifactDigest: witnessDigest, artifactManifestDigest: manifestDigest,
            checker: { format: CHECKER_FORMAT, version: CHECKER_VERSION, sourceDigest: CHECKER_SOURCE_DIGEST,
              evaluationProfileDigest: terms.evaluation.profile_digest },
          }, agentInvestigation, result: checked };
          const reportDigest = digestCanonicalJson(reportEnvelope);
          const valid = checked.ok; const exactScore = valid ? checked.report.objective.exact_decimal : null;
          const improves = valid ? checked.report.objective.versus_frozen_reference_5_29109518547430697 === 'greater' : null;
          await client.query(`INSERT INTO motive.submissions
            (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
             artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
            VALUES ($1,$2,$3,$4,'EXTERNAL',$5,$6,$7,'motive.submission/0.1',$8,$9,$10::jsonb,'unmetered_external',$11,$12)`,
          [submissionId, work.project_id, assignmentId, work.revision, context.actorId, claim.id, claim.lease_epoch,
            REFERENCE_COMMIT, manifestDigest, JSON.stringify({ agent_name: token.agent_name, model_name: token.model_name,
              usage_status: 'unmetered_external', declared_usage: null, ...(agentInvestigation ? { investigation: agentInvestigation } : {}) }),
            token.license_acceptance_ref, valid ? 'PENDING_EVALUATION' : 'REJECTED']);
          await client.query(`INSERT INTO motive.participation_submission_artifacts
            (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,report_digest,
             exact_score,exceeds_reference,contributor_display_name)
            VALUES ($1,$2,$3,'motive.csqv.witness.v1',$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
          [submissionId, work.project_id, token.id, bytes, witnessDigest, valid ? 'VALID' : 'REJECTED', JSON.stringify(reportEnvelope), reportDigest,
            exactScore, improves, token.public_display_name]);
          await this.event(client, text(work, 'project_id'), 'submission', submissionId, 'external.submission_checked', context.actorId,
            { contributor_id: context.tokenId, contributor_display_name: token.public_display_name, submission_id: submissionId,
              report_status: valid ? 'VALID' : 'REJECTED', exact_score: exactScore, exceeds_reference: improves });
          const summary = await this.submissionById(client, submissionId);
          return { response: summary, resourceType: 'submission', resourceId: submissionId };
        })).response;
    });
  }

  async completeAssignment(context: ParticipationAgentContext, assignmentId: string, input: CompleteAssignmentInput, key: string): Promise<AssignmentProjection> {
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context); const work = await this.workOrder(client);
      if (text(work, 'id') !== assignmentId) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
      return (await this.idempotent(client, context.actorId, 'participation.assignment.complete', key, { assignmentId, ...input }, async () => {
        const claim = await this.activeClaim(client, context, assignmentId, input.leaseEpoch);
        const submission = await client.query(`SELECT submission.id FROM motive.submissions submission
          JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          WHERE submission.id=$1 AND submission.claim_id=$2`, [input.submissionId, claim.id]);
        if (submission.rowCount !== 1) throw new ParticipationError('CONFLICT', 'Completion requires a checked submission from the current claim.');
        await client.query(`INSERT INTO motive.participation_claim_completions(claim_id,submission_id) VALUES($1,$2)`, [claim.id, input.submissionId]);
        await client.query(`UPDATE motive.work_claims SET status='RELEASED',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [claim.id]);
        await this.event(client, text(work, 'project_id'), 'work_claim', text(claim, 'id'), 'external.assignment_completed', context.actorId,
          { contributor_id: context.tokenId, contributor_display_name: token.public_display_name,
            claim_id: claim.id, submission_id: input.submissionId });
        return { response: await this.assignment(client, token, work), resourceType: 'work_claim', resourceId: text(claim, 'id') };
      })).response;
    });
  }

  async revokeToken(ownerActorId: string, tokenId: string, idempotencyKey: string): Promise<AgentTokenProjection> {
    return this.transaction(async client => {
      const result = await this.idempotent(client, ownerActorId, 'participation.token.revoke', idempotencyKey, { tokenId }, async () => {
        const result = await client.query(`SELECT * FROM motive.participation_agent_tokens WHERE id=$1 AND owner_actor_id=$2 FOR UPDATE`, [tokenId, ownerActorId]);
        if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Agent credential not found.');
        if (!result.rows[0].revoked_at) {
          await client.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1`, [tokenId]);
          await client.query(`UPDATE motive.work_claims SET status='REVOKED',released_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE operator_actor_id=$1 AND status='ACTIVE'`, [agentActor(tokenId)]);
        }
        const saved = await client.query(`SELECT * FROM motive.participation_agent_tokens WHERE id=$1`, [tokenId]);
        return { response: this.credential(saved.rows[0]), resourceType: 'participation_agent', resourceId: tokenId };
      });
      return result.response;
    });
  }

  async reviewSubmission(reviewerActorId: string, submissionId: string, input: ReviewSubmissionInput, idempotencyKey: string): Promise<SubmissionSummary> {
    return this.transaction(async client => {
      const artifact = await client.query(`SELECT artifact.project_id,artifact.report,token.owner_actor_id
        FROM motive.participation_submission_artifacts artifact JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
        WHERE artifact.submission_id=$1 FOR KEY SHARE OF artifact,token`, [submissionId]);
      if (artifact.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
      if (text(artifact.rows[0], 'owner_actor_id') === reviewerActorId) throw new ParticipationError('FORBIDDEN', 'Contributors cannot review their own submission.');
      const authority = await client.query(`SELECT 1 FROM motive.memberships WHERE project_id=$1 AND actor_id=$2
        AND revoked_at IS NULL AND role IN ('OWNER','STEWARD','REVIEWER') FOR SHARE`, [artifact.rows[0].project_id, reviewerActorId]);
      if (authority.rowCount !== 1) throw new ParticipationError('FORBIDDEN', 'Only an active project reviewer, owner, or steward can review submissions.');
      if (input.decision === 'ACCEPTED' && artifact.rows[0].report !== 'VALID') {
        throw new ParticipationError('VALIDATION', 'Only a valid checked result can be accepted.');
      }
      const result = await this.idempotent(client, reviewerActorId, 'participation.submission.review', idempotencyKey, { submissionId, ...input }, async () => {
        const existing = await client.query(`SELECT decision,reviewer_actor_id,rationale FROM motive.participation_submission_reviews WHERE submission_id=$1`, [submissionId]);
        if (existing.rowCount) {
          if (existing.rows[0].decision !== input.decision || existing.rows[0].reviewer_actor_id !== reviewerActorId || existing.rows[0].rationale !== input.rationale) {
            throw new ParticipationError('CONFLICT', 'The submission already has an immutable review.');
          }
        } else {
          await client.query(`INSERT INTO motive.participation_submission_reviews
            (submission_id,project_id,decision,reviewer_actor_id,rationale) VALUES($1,$2,$3,$4,$5)`,
          [submissionId, artifact.rows[0].project_id, input.decision, reviewerActorId, input.rationale]);
          await this.event(client, text(artifact.rows[0], 'project_id'), 'submission', submissionId, 'external.submission_reviewed', reviewerActorId,
            { submission_id: submissionId, decision: input.decision });
        }
        return { response: await this.submissionById(client, submissionId), resourceType: 'submission', resourceId: submissionId };
      });
      return result.response;
    });
  }

  async createPostCheckAssessment(context: ParticipationAgentContext, submissionId: string, rawInput: PostCheckAssessmentInput,
    idempotencyKey: string): Promise<PublicPostCheckAssessment> {
    const input = validatePostCheckAssessment(rawInput);
    return this.transaction(async client => {
      const token = await this.tokenForUpdate(client, context);
      const account = await client.query(`SELECT status FROM motive.account_identities WHERE actor_id=$1 FOR KEY SHARE`,
        [context.ownerActorId]);
      if (account.rowCount !== 1 || account.rows[0].status !== 'ACTIVE') {
        throw new ParticipationError('UNAUTHORIZED', 'The owning account is no longer active.');
      }
      const artifact = await client.query(`SELECT project_id,agent_token_id,report_digest
        FROM motive.participation_submission_artifacts WHERE submission_id=$1 FOR KEY SHARE`, [submissionId]);
      if (artifact.rowCount !== 1 || text(artifact.rows[0], 'project_id') !== context.projectId) {
        throw new ParticipationError('NOT_FOUND', 'Submission not found.');
      }
      if (text(artifact.rows[0], 'agent_token_id') !== context.tokenId) {
        throw new ParticipationError('FORBIDDEN', 'Only the original submitting credential can add a post-check assessment.');
      }
      if (text(artifact.rows[0], 'report_digest') !== input.reportDigest) {
        throw new ParticipationError('CONFLICT', 'Post-check assessment reportDigest does not match the retained checker report.');
      }
      const request = { submissionId, ...input };
      return (await this.idempotent(client, context.actorId, 'participation.submission.post-check-assessment', idempotencyKey,
        request, async () => {
          const requestDigest = digestCanonicalJson(request);
          const existing = await client.query(`SELECT request_digest FROM motive.participation_post_check_assessments
            WHERE submission_id=$1 FOR KEY SHARE`, [submissionId]);
          if (existing.rowCount) {
            if (text(existing.rows[0], 'request_digest') !== requestDigest) {
              throw new ParticipationError('CONFLICT', 'The submission already has a different immutable post-check assessment.');
            }
          } else {
            await client.query(`INSERT INTO motive.participation_post_check_assessments
              (submission_id,project_id,agent_token_id,report_digest,assessment,next_action,request_digest,public_question,public_finding)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [submissionId, context.projectId, context.tokenId, input.reportDigest,
              input.assessment, input.nextAction, requestDigest,input.publicSummary?.question??null,input.publicSummary?.finding??null]);
            await this.event(client, context.projectId, 'submission', submissionId, 'external.submission_assessed', context.actorId,
              { contributor_id: context.tokenId, contributor_display_name: token.public_display_name,
                submission_id: submissionId, report_digest: input.reportDigest });
          }
          return { response: await this.postCheckAssessment(client, submissionId),
            resourceType: 'participation_post_check_assessment', resourceId: submissionId };
        })).response;
    });
  }

  async createSubmissionReproducibility(context: ParticipationAgentContext, submissionId: string,
    rawInput: SubmissionReproducibilityInput, idempotencyKey: string): Promise<PublicSubmissionReproducibility> {
    const input = validateSubmissionReproducibility(rawInput);
    const solverBytes = Buffer.from(input.solverSource, 'utf8'); const trialBytes = Buffer.from(input.trialResults, 'utf8');
    return this.transaction(async client => {
      await this.tokenForUpdate(client, context);
      const account = await client.query(`SELECT status FROM motive.account_identities WHERE actor_id=$1 FOR KEY SHARE`,
        [context.ownerActorId]);
      if (account.rowCount !== 1 || account.rows[0].status !== 'ACTIVE') {
        throw new ParticipationError('UNAUTHORIZED', 'The owning account is no longer active.');
      }
      const artifact = await client.query(`SELECT project_id,agent_token_id,report_digest
        FROM motive.participation_submission_artifacts WHERE submission_id=$1 FOR KEY SHARE`, [submissionId]);
      if (artifact.rowCount !== 1 || text(artifact.rows[0], 'project_id') !== context.projectId) {
        throw new ParticipationError('NOT_FOUND', 'Submission not found.');
      }
      if (text(artifact.rows[0], 'agent_token_id') !== context.tokenId) {
        throw new ParticipationError('FORBIDDEN', 'Only the original submitting credential can add reproducibility files.');
      }
      if (text(artifact.rows[0], 'report_digest') !== input.reportDigest) {
        throw new ParticipationError('CONFLICT', 'Reproducibility reportDigest does not match the retained checker report.');
      }
      const request = { submissionId, ...input };
      return (await this.idempotent(client, context.actorId, 'participation.submission.reproducibility', idempotencyKey,
        request, async () => {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`participation.reproducibility:${submissionId}`]);
          const requestDigest = digestCanonicalJson(request);
          const existing = await client.query(`SELECT request_digest FROM motive.participation_submission_reproducibility
            WHERE submission_id=$1 FOR KEY SHARE`, [submissionId]);
          if (existing.rowCount) {
            if (text(existing.rows[0], 'request_digest') !== requestDigest) {
              throw new ParticipationError('CONFLICT', 'The submission already has different immutable reproducibility files.');
            }
          } else {
            await client.query(`INSERT INTO motive.participation_submission_reproducibility
              (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
               trial_results_bytes,trial_results_digest,request_digest)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [submissionId, context.projectId, context.tokenId, input.reportDigest,
              solverBytes, sha256(solverBytes), trialBytes, sha256(trialBytes), requestDigest]);
          }
          return { response: await this.submissionReproducibility(client, submissionId, false),
            resourceType: 'participation_submission_reproducibility', resourceId: submissionId };
        })).response;
    });
  }

  private async submissionReproducibility(client: Pick<PoolClient, 'query'>, submissionId: string,
    requirePublic: boolean): Promise<PublicSubmissionReproducibility> {
    const result = await client.query(`SELECT reproducibility.*,token.agent_name,token.model_name,token.public_display_name
      FROM motive.participation_submission_reproducibility reproducibility
      JOIN motive.participation_agent_tokens token ON token.id=reproducibility.agent_token_id
      JOIN motive.projects project ON project.id=reproducibility.project_id
      WHERE reproducibility.submission_id=$1 AND (NOT $2::boolean OR project.visibility='PUBLIC')`, [submissionId, requirePublic]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission reproducibility files not found.');
    const row = result.rows[0]; const base = `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${submissionId}/reproducibility`;
    return { format: 'motive.submission-reproducibility.public.v1', submissionId,
      reportDigest: text(row, 'report_digest'), createdAt: dateText(row.created_at), attribution: {
        kind: 'AGENT_DECLARED', credentialId: text(row, 'agent_token_id'), agentName: text(row, 'agent_name'),
        modelName: nullableText(row, 'model_name'), contributorDisplayName: nullableText(row, 'public_display_name') },
      files: [
        { role: 'SOLVER_SOURCE', name: 'solver-source.txt', mediaType: 'text/plain',
          bytes: (row.solver_source_bytes as Buffer).byteLength, digest: text(row, 'solver_source_digest'),
          href: `${base}/solver-source.txt` },
        { role: 'TRIAL_RESULTS', name: 'trial-results.txt', mediaType: 'text/plain',
          bytes: (row.trial_results_bytes as Buffer).byteLength, digest: text(row, 'trial_results_digest'),
          href: `${base}/trial-results.txt` },
      ], disposition: 'AGENT_DECLARED_UNVERIFIED',
      notice: 'These contributor-supplied source and trial files are tied to the retained checker report for reproducibility. Motive did not execute or check them, and they do not indicate support or acceptance.' };
  }

  private async submissionById(client: PoolClient, submissionId: string): Promise<SubmissionSummary> {
    const result = await client.query(`SELECT submission.id,submission.work_order_id,submission.provenance ? 'investigation' AS has_investigation,
      assessment.submission_id IS NOT NULL AS has_post_check_assessment,
      reproducibility.submission_id IS NOT NULL AS has_reproducibility,
      artifact.agent_token_id,artifact.contributor_display_name,
      token.agent_name,token.model_name,submission.created_at,artifact.report,artifact.witness_digest,artifact.exact_score,
      artifact.exceeds_reference,review.decision FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id
      LEFT JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
      LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
      WHERE submission.id=$1`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
    return this.submissionSummary(result.rows[0]);
  }

  private submissionSummary(row: QueryResultRow): SubmissionSummary {
    const decision = nullableText(row, 'decision') as AcceptanceStatus | null;
    return { id: text(row, 'id'), assignmentId: text(row, 'work_order_id'), contributorId: text(row, 'agent_token_id'),
      contributorDisplayName: nullableText(row, 'contributor_display_name'), agentName: text(row, 'agent_name'), modelName: nullableText(row, 'model_name'),
      createdAt: dateText(row.created_at), reportStatus: text(row, 'report') as SubmissionSummary['reportStatus'], artifactSha256: text(row, 'witness_digest'),
      exactScore: nullableText(row, 'exact_score'), exceedsReference: row.exceeds_reference === null ? null : Boolean(row.exceeds_reference),
      acceptance: decision ?? 'PENDING', artifactHref: `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/artifact`,
      reportHref: `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/report`,
      investigationHref: row.has_investigation ? `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/investigation` : null,
      postCheckAssessmentHref: row.has_post_check_assessment
        ? `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/post-check-assessment` : null,
      reproducibilityHref: row.has_reproducibility
        ? `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/reproducibility` : null };
  }

  private async challengeOutcome(client:PoolClient,projectId:string):Promise<NonNullable<ParticipationPublicProjection['challengeOutcome']>>{
    const verified=await client.query(`WITH ${DURABLE_VERIFIED_IMPROVEMENTS_CTE}
      SELECT finding_decision_id,review_submission_id,submission_id
      FROM durable_verified_improvements WHERE project_id=$1
      ORDER BY exact_score::numeric DESC,submission_id ASC LIMIT 1`,[projectId]);
    if(verified.rowCount){const row=verified.rows[0];return{status:'VERIFIED',
      candidate:await this.submissionById(client,text(row,'submission_id')),
      findingDecisionId:text(row,'finding_decision_id'),reviewSubmissionId:text(row,'review_submission_id')};}
    const awaiting=await client.query(`SELECT artifact.submission_id
      FROM motive.participation_submission_artifacts artifact
      WHERE artifact.project_id=$1 AND artifact.report='VALID' AND artifact.exceeds_reference=TRUE
      ORDER BY artifact.exact_score::numeric DESC,artifact.created_at ASC,artifact.submission_id ASC LIMIT 1`,[projectId]);
    return awaiting.rowCount?{status:'AWAITING_REVIEW',
      candidate:await this.submissionById(client,text(awaiting.rows[0],'submission_id')),
      findingDecisionId:null,reviewSubmissionId:null}
      :{status:'OPEN',candidate:null,findingDecisionId:null,reviewSubmissionId:null};
  }

  private async credentialLoopProgress(client: PoolClient, credentialIds: string[]): Promise<ParticipationCredentialLoopProgress[]> {
    if (!credentialIds.length) return [];
    const result = await client.query(`WITH completed AS (
        SELECT token.id AS credential_id,count(DISTINCT completion.claim_id)::integer AS count
        FROM motive.participation_agent_tokens token
        JOIN motive.work_claims claim ON claim.operator_actor_id='agent:' || token.id::text
          AND claim.project_id=token.project_id AND claim.origin='EXTERNAL'
        JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id
        WHERE token.id=ANY($1::uuid[]) GROUP BY token.id
      ), checked AS (
        SELECT agent_token_id AS credential_id,count(*)::integer AS count
        FROM motive.participation_submission_artifacts WHERE agent_token_id=ANY($1::uuid[]) GROUP BY agent_token_id
      ), updates AS (
        SELECT agent_token_id AS credential_id,count(*)::integer AS count
        FROM motive.participation_post_check_assessments WHERE agent_token_id=ANY($1::uuid[]) GROUP BY agent_token_id
      ), cycles AS (
        SELECT assessment.agent_token_id AS credential_id,count(DISTINCT assessment.submission_id)::integer AS count
        FROM motive.participation_post_check_assessments assessment
        JOIN motive.participation_claim_completions completion ON completion.submission_id=assessment.submission_id
        WHERE assessment.agent_token_id=ANY($1::uuid[]) GROUP BY assessment.agent_token_id
      ), accepted_findings AS (
        SELECT artifact.agent_token_id AS credential_id,count(*)::integer AS count
        FROM motive.participation_submission_artifacts artifact
        WHERE artifact.agent_token_id=ANY($1::uuid[])
          AND EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
            WHERE finding.source_submission_id=artifact.submission_id AND finding.project_id=artifact.project_id
              AND finding.decision='ACCEPT' AND finding.novelty='DISTINCT'
              AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
                WHERE successor.previous_decision_id=finding.id))
        GROUP BY artifact.agent_token_id
      )
      SELECT token.id,coalesce(completed.count,0)::integer AS completed_attempts,
        coalesce(checked.count,0)::integer AS checked_submissions,coalesce(updates.count,0)::integer AS recorded_updates,
        coalesce(cycles.count,0)::integer AS completed_cycles,
        coalesce(accepted_findings.count,0)::integer AS accepted_distinct_findings
      FROM motive.participation_agent_tokens token
      LEFT JOIN completed ON completed.credential_id=token.id LEFT JOIN checked ON checked.credential_id=token.id
      LEFT JOIN updates ON updates.credential_id=token.id LEFT JOIN cycles ON cycles.credential_id=token.id
      LEFT JOIN accepted_findings ON accepted_findings.credential_id=token.id
      WHERE token.id=ANY($1::uuid[]) ORDER BY token.created_at DESC,token.id DESC`, [credentialIds]);
    return result.rows.map(row => ({ credentialId: text(row, 'id'), completedAttempts: Number(row.completed_attempts),
      checkedSubmissions: Number(row.checked_submissions), recordedUpdates: Number(row.recorded_updates),
      completedCycles: Number(row.completed_cycles), acceptedDistinctFindings: Number(row.accepted_distinct_findings),
      xp: Number(row.completed_cycles) * 100 }));
  }

  async projectReviewers(ownerActorId: string): Promise<ProjectReviewers> {
    const projectId = await this.preflightReviewerOwner(ownerActorId);
    return this.transaction(async client => {
      await this.lockReviewerAuthority(client, ownerActorId, projectId);
      const result = await client.query(`SELECT account.subject_id::text AS account_id
        FROM motive.memberships membership
        JOIN motive.account_identities account ON account.actor_id=membership.actor_id
        WHERE membership.project_id=$1 AND membership.role='REVIEWER' AND membership.revoked_at IS NULL
          AND account.provider='supabase'
          AND account.actor_id='account:' || account.subject_id::text
        ORDER BY account.subject_id LIMIT 100`, [projectId]);
      return { format: 'motive.project-reviewers/0.1', projectSlug: PARTICIPATION_PROJECT_SLUG,
        reviewers: result.rows.map(row => ({ accountId: text(row, 'account_id') })) };
    });
  }

  async grantProjectReviewer(ownerActorId: string, accountId: string, idempotencyKey: string): Promise<ProjectReviewerChange> {
    return this.changeProjectReviewer(ownerActorId, accountId, 'GRANT', idempotencyKey);
  }

  async removeProjectReviewer(ownerActorId: string, accountId: string, idempotencyKey: string): Promise<ProjectReviewerChange> {
    return this.changeProjectReviewer(ownerActorId, accountId, 'REMOVE', idempotencyKey);
  }

  private async changeProjectReviewer(ownerActorId: string, accountId: string, action: 'GRANT' | 'REMOVE',
    idempotencyKey: string): Promise<ProjectReviewerChange> {
    const targetActorId = this.reviewerActor(accountId);
    if (targetActorId === ownerActorId) throw new ParticipationError('VALIDATION', 'An owner cannot change their own reviewer role.');
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(idempotencyKey)) {
      throw new ParticipationError('VALIDATION', 'Idempotency-Key must be 8â€“200 URL-safe characters.');
    }
    const projectId = await this.preflightReviewerOwner(ownerActorId);
    const idempotencyAction = `participation.reviewer.${action.toLowerCase()}`;
    const requestBody = { accountId }; const bodyDigest = digestCanonicalJson(requestBody);
    const prior = await this.pool.query(`SELECT body_digest FROM motive.idempotency_records
      WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3`, [ownerActorId, idempotencyAction, idempotencyKey]);
    if (prior.rowCount === 1) {
      if (text(prior.rows[0], 'body_digest') !== bodyDigest) {
        throw new ParticipationError('CONFLICT', 'Idempotency-Key is already bound to another request.');
      }
      return this.transaction(async client => {
        await this.lockReviewerAuthority(client, ownerActorId, projectId);
        const replay = await this.idempotent<ProjectReviewerChange>(client, ownerActorId,
          idempotencyAction, idempotencyKey, requestBody, async () => { throw new Error('A completed reviewer change was not replayed.'); });
        return { ...replay.response, replayed: replay.replayed };
      });
    }
    if (action === 'GRANT') {
      const target = await this.pool.query(`SELECT 1 FROM motive.account_identities
        WHERE actor_id=$1 AND provider='supabase' AND subject_id=$2::text AND status='ACTIVE'`, [targetActorId, accountId]);
      if (target.rowCount !== 1 || !await this.actorIsActive(targetActorId)) {
        throw new ParticipationError('NOT_FOUND', 'Reviewer account is unavailable.');
      }
    }
    return this.transaction(async client => {
      const authority = await this.lockReviewerAuthority(client, ownerActorId, projectId, targetActorId);
      const result = await this.idempotent<ProjectReviewerChange>(client, ownerActorId,
        idempotencyAction, idempotencyKey, requestBody, async effectId => {
          const targetAccount = authority.accounts.get(targetActorId);
          if (!targetAccount || targetAccount.provider !== 'supabase'
            || `account:${text(targetAccount, 'subject_id')}` !== targetActorId
            || (action === 'GRANT' && targetAccount.status !== 'ACTIVE')) {
            throw new ParticipationError('NOT_FOUND', 'Reviewer account is unavailable.');
          }
          let membership = authority.memberships.get(targetActorId);
          let created = false;
          if (action === 'GRANT' && !membership) {
            const insertedMembership = await client.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
              VALUES($1,$2,$3,'REVIEWER',ARRAY['external:claim','external:submit','project:review'],$4)
              ON CONFLICT(project_id,actor_id) DO NOTHING RETURNING id`,
            [randomUUID(), projectId, targetActorId, ownerActorId]);
            created = insertedMembership.rowCount === 1;
            const inserted = await client.query(`SELECT id,actor_id,role,scopes,revoked_at FROM motive.memberships
              WHERE project_id=$1 AND actor_id=$2 FOR UPDATE`, [projectId, targetActorId]);
            membership = inserted.rows[0];
          }
          if (!membership || membership.revoked_at) {
            throw new ParticipationError('CONFLICT', 'Reviewer membership is unavailable.');
          }
          const role = text(membership, 'role');
          if (role === 'OWNER' || role === 'STEWARD') {
            throw new ParticipationError('CONFLICT', 'The account has a role that reviewer management cannot change.');
          }
          const scopes = Array.isArray(membership.scopes) ? membership.scopes as string[] : [];
          let changed = false;
          if (action === 'GRANT') {
            if (role !== 'CONTRIBUTOR' && role !== 'REVIEWER' && role !== 'SUPPORTER') {
              throw new ParticipationError('CONFLICT', 'The account has a role that reviewer management cannot change.');
            }
            changed = created || role !== 'REVIEWER' || !scopes.includes('project:review');
            if (changed) await client.query(`UPDATE motive.memberships SET role='REVIEWER',
              scopes=CASE WHEN 'project:review'=ANY(scopes) THEN scopes ELSE array_append(scopes,'project:review') END
              WHERE id=$1`, [membership.id]);
          } else {
            if (role !== 'CONTRIBUTOR' && role !== 'REVIEWER') {
              throw new ParticipationError('CONFLICT', 'The account has a role that reviewer management cannot change.');
            }
            changed = role === 'REVIEWER' || scopes.includes('project:review');
            if (changed && role === 'REVIEWER') await client.query(`UPDATE motive.memberships SET role='CONTRIBUTOR',
              scopes=(SELECT array_agg(scope ORDER BY ordinal) FROM (
                SELECT scope,min(ordinal) AS ordinal FROM unnest(array_remove(scopes,'project:review')
                  || ARRAY['external:claim','external:submit']) WITH ORDINALITY item(scope,ordinal)
                GROUP BY scope) distinct_scopes) WHERE id=$1`, [membership.id]);
            else if (changed) await client.query(`UPDATE motive.memberships SET scopes=array_remove(scopes,'project:review')
              WHERE id=$1`, [membership.id]);
            const revokedAccess = await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access
              SET revoked_at=clock_timestamp() WHERE project_id=$1 AND reviewer_actor_id=$2
                AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id`, [projectId, targetActorId]);
            changed = changed || (revokedAccess.rowCount ?? 0) > 0;
          }
          const response: ProjectReviewerChange = { format: 'motive.project-reviewer-change/0.1',
            projectSlug: PARTICIPATION_PROJECT_SLUG, accountId, action, changed, replayed: false };
          if (changed) await this.event(client, projectId, 'membership', text(membership, 'id'),
            action === 'GRANT' ? 'participation.reviewer_granted' : 'participation.reviewer_removed', ownerActorId,
            { account_id: accountId, effect_id: effectId });
          return { response, resourceType: 'membership', resourceId: text(membership, 'id') };
        });
      return { ...result.response, replayed: result.replayed };
    });
  }

  async getMe(ownerActorId: string): Promise<ParticipationMeResponse> {
    return this.transaction(async client => {
      const tokens = await client.query(`SELECT token.* FROM motive.participation_agent_tokens token JOIN motive.projects project ON project.id=token.project_id
        WHERE token.owner_actor_id=$1 AND project.slug=$2 ORDER BY token.created_at DESC LIMIT 50`, [ownerActorId, PARTICIPATION_PROJECT_SLUG]);
      const assignments = await Promise.all(tokens.rows.map(token => this.assignment(client, token)));
      const submissions = await client.query(`SELECT artifact.submission_id FROM motive.participation_submission_artifacts artifact
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id WHERE token.owner_actor_id=$1 ORDER BY artifact.created_at DESC LIMIT 50`, [ownerActorId]);
      const membership = await client.query(`SELECT membership.role,account.status FROM motive.memberships membership
        JOIN motive.projects project ON project.id=membership.project_id
        LEFT JOIN motive.account_identities account ON account.actor_id=membership.actor_id
        WHERE project.slug=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL`, [PARTICIPATION_PROJECT_SLUG, ownerActorId]);
      const role = membership.rowCount === 1 ? String(membership.rows[0].role) : null;
      const identityAllowsReview = membership.rowCount === 1
        && (membership.rows[0].status === null || membership.rows[0].status === 'ACTIVE');
      const loopProgress = await this.credentialLoopProgress(client, tokens.rows.map(row => text(row, 'id')));
      const sessions = await this.agentSessions(client, tokens.rows);
      return { projectSlug: PARTICIPATION_PROJECT_SLUG,
        canReview: identityAllowsReview && role !== null && ['OWNER','STEWARD','REVIEWER'].includes(role),
        canManageReviewers: role === 'OWNER' && membership.rows[0].status === 'ACTIVE',
        credentials: tokens.rows.map(row => this.credential(row)), assignments,
        submissions: await Promise.all(submissions.rows.map(row => this.submissionById(client, text(row, 'submission_id')))),
        loopProgress, sessions };
    });
  }

  private researchUpdate(row: QueryResultRow): PublicResearchUpdate {
    const provenance = row.provenance as Record<string, unknown>;
    const stored = provenance.investigation as { investigation?: SubmissionInvestigationInput } | null;
    const investigation = stored?.investigation;
    const postCheck = nullableText(row, 'post_check_assessment');
    const latestAssessment = postCheck ?? investigation?.assessment ?? null;
    const assessmentTiming = postCheck ? 'AFTER_CHECK' : investigation?.assessment ? 'AT_SUBMISSION' : null;
    const assessmentSourceDigest = latestAssessment === null ? null : digestCanonicalJson({
      format: 'motive.research-assessment-source.v1', assessment: latestAssessment, timing: assessmentTiming });
    const publicSummary=row.public_question===null?undefined:{question:text(row,'public_question'),finding:text(row,'public_finding')};
    const links = row.cited_submissions as Array<Record<string, unknown>>;
    return { submissionId: text(row, 'id'), reportDigest: text(row, 'report_digest'), agentName: text(row, 'agent_name'),
      contributorDisplayName: nullableText(row, 'contributor_display_name'), createdAt: dateText(row.created_at),
      proposal: investigation?.proposal ?? nullableText(row, 'intent_proposal') ?? null,
      expectation: investigation?.expectation ?? nullableText(row, 'intent_expectation') ?? null,
      latestAssessment, assessmentTiming, assessmentSourceDigest,...(publicSummary?{publicSummary}:{}),
      observedOutcome: { reportStatus: text(row, 'report') as SubmissionSummary['reportStatus'],
        exactScore: nullableText(row, 'exact_score'),
        exceedsReference: row.exceeds_reference === null ? null : Boolean(row.exceeds_reference),
        reportHref: `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/report` },
      completed: row.completed === true,
      memoryReview: { latestDecision: row.memory_review_decision === null ? null : {
        decision: text(row, 'memory_review_decision') as 'ADMIT'|'DECLINE',
        reviewedAt: dateText(row.memory_reviewed_at) },
        hasEngineRecords: row.memory_has_engine_records === true },
      findingReview: row.finding_review_id === null ? null : {
        id: text(row, 'finding_review_id'),
        decision: text(row, 'finding_review_decision') as 'ACCEPT'|'DECLINE',
        outcome: row.finding_review_outcome as 'SUPPORTED'|'CONTRADICTED'|'INCONCLUSIVE'|null,
        finding: nullableText(row, 'finding_review_finding'),
        limitations: nullableText(row, 'finding_review_limitations'),
        novelty: row.finding_review_novelty as 'DISTINCT'|'DUPLICATE'|null,
        reviewedAt: dateText(row.finding_reviewed_at),
        ...(row.finding_reviewer_agent_token_id===null?{}:{
          reviewerAgentTokenId:text(row,'finding_reviewer_agent_token_id'),
          reviewSubmissionId:text(row,'finding_review_submission_id')}) },
      citedEarlierMotiveSubmissions: links.map(link => ({ submissionId: String(link.submission_id), agentName: String(link.agent_name),
        question: link.question === null ? null : String(link.question),
        reportHref: String(link.report_href), investigationHref: link.investigation_href === null ? null : String(link.investigation_href),
        postCheckAssessmentHref: link.post_check_assessment_href === null ? null : String(link.post_check_assessment_href) })) };
  }

  private async researchJournalEntries(client: PoolClient, projectId: string, options: {
    ownerActorId: string|null; before: string|null; submissionId: string|null; limit: number;
    contributorMembershipId?: string|null; namedOnly?: boolean; acceptedFindingsOnly?: boolean;
    findingQueueActorId?: string|null; memoryQueueActorId?: string|null;
    citingTargetSubmissionId?: string|null;
  }): Promise<{ entries: ResearchJournalEntry[]; cursorFound: boolean }> {
    const result = await client.query(`WITH citation_target AS (
        SELECT target.id,target.created_at,artifact.report_digest,artifact.witness_digest
        FROM motive.submissions target
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=target.id
          AND artifact.project_id=target.project_id
        WHERE target.project_id=$1 AND target.id=$11::uuid
      ), eligible_sequence AS NOT MATERIALIZED (
        SELECT candidate.id,candidate.created_at
        FROM motive.submissions candidate
        WHERE candidate.project_id=$1 AND ($11::uuid IS NULL OR EXISTS(
          SELECT 1 FROM citation_target target
          WHERE candidate.origin='EXTERNAL' AND candidate.id<>target.id
            AND (candidate.created_at,candidate.id)>(target.created_at,target.id)
            AND EXISTS(SELECT 1
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(candidate.provenance #> '{investigation,investigation,motiveReferences}')='array'
                  THEN candidate.provenance #> '{investigation,investigation,motiveReferences}'
                ELSE '[]'::jsonb END) reference
              WHERE reference=jsonb_build_object('submissionId',target.id::text,
                'reportDigest',target.report_digest,'artifactDigest',target.witness_digest))
        ))
      ), cursor_row AS (
        SELECT submission.id,submission.created_at
        FROM motive.submissions submission
        JOIN eligible_sequence eligible ON eligible.id=submission.id
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          AND artifact.project_id=submission.project_id
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
          AND token.project_id=artifact.project_id
        WHERE submission.project_id=$1 AND submission.id=$3::uuid
          AND ($2::text IS NULL OR token.owner_actor_id=$2)
          AND ($10::text IS NULL OR (submission.origin='EXTERNAL' AND token.owner_actor_id<>$10))
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM motive.memberships membership
            WHERE membership.id=$6 AND membership.project_id=submission.project_id
              AND membership.actor_id=token.owner_actor_id))
          AND (NOT $7::boolean OR artifact.contributor_display_name IS NOT NULL)
          AND (NOT $8::boolean OR EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
            WHERE finding.source_submission_id=submission.id AND finding.project_id=submission.project_id
              AND finding.decision='ACCEPT' AND finding.novelty='DISTINCT'
              AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
                WHERE successor.previous_decision_id=finding.id)))
          AND ($9::text IS NULL OR (submission.origin='EXTERNAL' AND token.owner_actor_id<>$9))
      ), selected AS (
        SELECT submission.id,submission.work_order_id,submission.claim_id,submission.created_at,submission.provenance,
          submission.provenance ? 'investigation' AS has_investigation,
          artifact.agent_token_id,artifact.contributor_display_name,artifact.report,artifact.report_digest,
          artifact.witness_digest,artifact.exact_score,artifact.exceeds_reference,
          token.agent_name,token.model_name,review.decision,
          assessment.submission_id IS NOT NULL AS has_post_check_assessment,
          assessment.assessment AS post_check_assessment,assessment.public_question,assessment.public_finding,
          reproducibility.submission_id IS NOT NULL AS has_reproducibility,
          intent.proposal AS intent_proposal,intent.expectation AS intent_expectation,
          completion.claim_id IS NOT NULL AS completed
        FROM motive.submissions submission
        JOIN eligible_sequence eligible ON eligible.id=submission.id
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          AND artifact.project_id=submission.project_id
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
          AND token.project_id=artifact.project_id
        LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id
        LEFT JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
        LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
        LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=submission.claim_id
        LEFT JOIN motive.participation_claim_completions completion ON completion.claim_id=submission.claim_id
          AND completion.submission_id=submission.id
        WHERE submission.project_id=$1 AND ($2::text IS NULL OR token.owner_actor_id=$2)
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM motive.memberships membership
            WHERE membership.id=$6 AND membership.project_id=submission.project_id
              AND membership.actor_id=token.owner_actor_id))
          AND (NOT $7::boolean OR artifact.contributor_display_name IS NOT NULL)
          AND (NOT $8::boolean OR EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
            WHERE finding.source_submission_id=submission.id AND finding.project_id=submission.project_id
              AND finding.decision='ACCEPT' AND finding.novelty='DISTINCT'
              AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
                WHERE successor.previous_decision_id=finding.id)))
          AND ($9::text IS NULL OR (submission.origin='EXTERNAL' AND token.owner_actor_id<>$9
            AND EXISTS(SELECT 1 FROM motive.participation_claim_completions queue_completion
              WHERE queue_completion.submission_id=submission.id AND queue_completion.claim_id=submission.claim_id)
            AND EXISTS(SELECT 1 FROM motive.participation_post_check_assessments queue_assessment
              WHERE queue_assessment.submission_id=submission.id AND queue_assessment.project_id=submission.project_id
                AND queue_assessment.agent_token_id=artifact.agent_token_id
                AND queue_assessment.report_digest=artifact.report_digest)
            AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions queue_review
              WHERE queue_review.source_submission_id=submission.id AND queue_review.project_id=submission.project_id)))
          AND ($10::text IS NULL OR (submission.origin='EXTERNAL' AND submission.attempt_id IS NULL
            AND token.owner_actor_id<>$10 AND submission.operator_actor_id=('agent:' || token.id::text)
            AND submission.provenance ? 'investigation'
            AND artifact.report_body->'agentInvestigation'=submission.provenance->'investigation'
            AND EXISTS(SELECT 1 FROM motive.work_claims queue_claim
              JOIN motive.work_orders queue_work ON queue_work.id=queue_claim.work_order_id
                AND queue_work.project_id=submission.project_id AND queue_work.revision=submission.work_order_revision
              WHERE queue_claim.id=submission.claim_id AND queue_claim.work_order_id=submission.work_order_id
                AND queue_claim.operator_actor_id=submission.operator_actor_id
                AND queue_claim.lease_epoch=submission.lease_epoch)
            AND EXISTS(SELECT 1 FROM motive.participation_claim_completions queue_completion
              WHERE queue_completion.submission_id=submission.id AND queue_completion.claim_id=submission.claim_id)
            AND EXISTS(SELECT 1 FROM motive.participation_post_check_assessments queue_assessment
              WHERE queue_assessment.submission_id=submission.id AND queue_assessment.project_id=submission.project_id
                AND queue_assessment.agent_token_id=artifact.agent_token_id
                AND queue_assessment.report_digest=artifact.report_digest)
            AND EXISTS(SELECT 1 FROM motive.project_research_scopes queue_scope
              WHERE queue_scope.project_id=submission.project_id AND queue_scope.status='CONNECTED')
            AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_deliveries queue_delivery
              JOIN motive.hypothesis_submission_delivery_admission_decisions queue_decision
                ON queue_decision.delivery_id=queue_delivery.id
              WHERE queue_delivery.source_submission_id=submission.id AND queue_delivery.project_id=submission.project_id)))
          AND ($4::uuid IS NULL OR submission.id=$4::uuid)
          AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM cursor_row)
            AND (submission.created_at,submission.id)<((SELECT created_at FROM cursor_row),(SELECT id FROM cursor_row)))
        ORDER BY submission.created_at DESC,submission.id DESC LIMIT $5
      ), latest_deliveries AS (
        SELECT DISTINCT ON (delivery.source_submission_id)
          delivery.source_submission_id,delivery.id AS delivery_id
        FROM motive.hypothesis_submission_deliveries delivery
        JOIN selected ON selected.id=delivery.source_submission_id
        WHERE delivery.project_id=$1
        ORDER BY delivery.source_submission_id,delivery.created_at DESC,delivery.id DESC
      ), memory_reviews AS (
        SELECT delivery.source_submission_id,tail.decision,tail.created_at AS reviewed_at,
          EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results result
            WHERE result.delivery_id=delivery.delivery_id) AS has_engine_records
        FROM latest_deliveries delivery
        LEFT JOIN LATERAL (
          SELECT decision.decision,decision.created_at
          FROM motive.hypothesis_submission_delivery_admission_decisions decision
          WHERE decision.delivery_id=delivery.delivery_id
            AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
              WHERE successor.previous_decision_id=decision.id)
          ORDER BY decision.created_at DESC,decision.id DESC LIMIT 1
        ) tail ON TRUE
      ), finding_reviews AS (
        SELECT selected.id AS source_submission_id,tail.id,tail.decision,tail.outcome,tail.finding,
          tail.limitations,tail.novelty,tail.created_at AS reviewed_at,
          tail.reviewer_agent_token_id,tail.review_submission_id
        FROM selected
        LEFT JOIN LATERAL (
          SELECT decision.id,decision.decision,decision.outcome,decision.finding,decision.limitations,
            decision.novelty,decision.created_at,decision.reviewer_agent_token_id,decision.review_submission_id
          FROM motive.finding_review_decisions decision
          WHERE decision.source_submission_id=selected.id AND decision.project_id=$1
            AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
              WHERE successor.previous_decision_id=decision.id)
          LIMIT 1
        ) tail ON TRUE
      ), mappings AS (
        SELECT delivery.project_id,delivery.scope_id,result.resource_id AS hypothesis_id,
          delivery.source_submission_id,
          count(*) OVER (PARTITION BY delivery.project_id,delivery.scope_id,result.resource_id) AS association_count
        FROM motive.hypothesis_submission_delivery_results result
        JOIN motive.hypothesis_submission_delivery_operations operation
          ON operation.delivery_id=result.delivery_id AND operation.operation=result.operation
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id
        WHERE result.operation='DRAFT_HYPOTHESIS' AND delivery.project_id=$1
      ), append_mappings AS (
        SELECT delivery.project_id,delivery.scope_id,operation.target_hypothesis_id AS hypothesis_id,
          result.resource_id AS evidence_id,delivery.source_submission_id,
          count(*) OVER (PARTITION BY delivery.project_id,delivery.scope_id,
            operation.target_hypothesis_id,result.resource_id) AS association_count
        FROM motive.hypothesis_submission_delivery_results result
        JOIN motive.hypothesis_submission_delivery_operations operation
          ON operation.delivery_id=result.delivery_id AND operation.operation=result.operation
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id
        WHERE result.operation='NEUTRAL_EVIDENCE' AND delivery.delivery_mode='APPEND_EXISTING'
          AND operation.target_hypothesis_id IS NOT NULL AND delivery.project_id=$1
      ), enriched AS (
        SELECT selected.*,coalesce(citations.links,'[]'::jsonb) AS cited_submissions,
          memory.decision AS memory_review_decision,memory.reviewed_at AS memory_reviewed_at,
          coalesce(memory.has_engine_records,false) AS memory_has_engine_records,
          finding.id AS finding_review_id,finding.decision AS finding_review_decision,
          finding.outcome AS finding_review_outcome,finding.finding AS finding_review_finding,
          finding.limitations AS finding_review_limitations,finding.novelty AS finding_review_novelty,
          finding.reviewed_at AS finding_reviewed_at,
          finding.reviewer_agent_token_id AS finding_reviewer_agent_token_id,
          finding.review_submission_id AS finding_review_submission_id
        FROM selected
        LEFT JOIN memory_reviews memory ON memory.source_submission_id=selected.id
        LEFT JOIN finding_reviews finding ON finding.source_submission_id=selected.id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'submission_id',link.submission_id,'agent_name',link.agent_name,
            'question',link.question,
            'report_href','/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/' || link.submission_id || '/report',
            'investigation_href',CASE WHEN link.has_investigation THEN '/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/' || link.submission_id || '/investigation' ELSE NULL END,
            'post_check_assessment_href',CASE WHEN link.has_assessment THEN '/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/' || link.submission_id || '/post-check-assessment' ELSE NULL END)
            ORDER BY link.created_at,link.submission_id) AS links
          FROM (
            SELECT DISTINCT ON (candidate.submission_id) candidate.*,
              CASE
                WHEN nullif(btrim(candidate.public_question),'') IS NOT NULL THEN candidate.public_question
                WHEN jsonb_typeof(candidate.prior_provenance #> '{investigation,investigation,proposal}')='string'
                  AND nullif(btrim(candidate.prior_provenance #>> '{investigation,investigation,proposal}'),'') IS NOT NULL
                  THEN candidate.prior_provenance #>> '{investigation,investigation,proposal}'
                ELSE NULL END AS question
            FROM (
              SELECT mapping.source_submission_id::text AS submission_id,
                prior.created_at,prior_token.agent_name,(prior.provenance ? 'investigation') AS has_investigation,
                prior_assessment.submission_id IS NOT NULL AS has_assessment,
                prior.provenance AS prior_provenance,prior_assessment.public_question
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(selected.provenance #> '{investigation,investigation,researchReferences}')='array'
                  THEN selected.provenance #> '{investigation,investigation,researchReferences}' ELSE '[]'::jsonb END) reference
              JOIN motive.research_context_snapshots snapshot
                ON snapshot.project_id=$1 AND snapshot.scope_id::text=reference->>'scopeId'
                AND snapshot.id::text=reference->>'snapshotId' AND snapshot.snapshot_digest=reference->>'snapshotDigest'
              JOIN mappings mapping ON mapping.project_id=$1 AND mapping.scope_id=snapshot.scope_id
                AND mapping.hypothesis_id::text=reference->>'hypothesisId' AND mapping.association_count=1
              JOIN motive.submissions prior ON prior.id=mapping.source_submission_id AND prior.project_id=$1
                AND prior.created_at<selected.created_at
              JOIN motive.participation_submission_artifacts prior_artifact ON prior_artifact.submission_id=prior.id
              JOIN motive.participation_agent_tokens prior_token ON prior_token.id=prior_artifact.agent_token_id
              LEFT JOIN motive.participation_post_check_assessments prior_assessment ON prior_assessment.submission_id=prior.id
              UNION ALL
              SELECT mapping.source_submission_id::text AS submission_id,
                prior.created_at,prior_token.agent_name,(prior.provenance ? 'investigation') AS has_investigation,
                prior_assessment.submission_id IS NOT NULL AS has_assessment,
                prior.provenance AS prior_provenance,prior_assessment.public_question
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(selected.provenance #> '{investigation,investigation,researchReferences}')='array'
                  THEN selected.provenance #> '{investigation,investigation,researchReferences}' ELSE '[]'::jsonb END) reference
              JOIN motive.research_context_snapshots snapshot
                ON snapshot.project_id=$1 AND snapshot.scope_id::text=reference->>'scopeId'
                AND snapshot.id::text=reference->>'snapshotId' AND snapshot.snapshot_digest=reference->>'snapshotDigest'
              JOIN append_mappings mapping ON mapping.project_id=$1 AND mapping.scope_id=snapshot.scope_id
                AND mapping.hypothesis_id::text=reference->>'hypothesisId' AND mapping.association_count=1
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(reference->'evidenceIds') AS referenced(value)
                  WHERE referenced.value=mapping.evidence_id::text)
              JOIN motive.submissions prior ON prior.id=mapping.source_submission_id AND prior.project_id=$1
                AND prior.created_at<selected.created_at
              JOIN motive.participation_submission_artifacts prior_artifact ON prior_artifact.submission_id=prior.id
                AND prior_artifact.project_id=$1
              JOIN motive.participation_agent_tokens prior_token ON prior_token.id=prior_artifact.agent_token_id
              LEFT JOIN motive.participation_post_check_assessments prior_assessment ON prior_assessment.submission_id=prior.id
              UNION ALL
              SELECT prior.id::text AS submission_id,
                prior.created_at,prior_token.agent_name,(prior.provenance ? 'investigation') AS has_investigation,
                prior_assessment.submission_id IS NOT NULL AS has_assessment,
                prior.provenance AS prior_provenance,prior_assessment.public_question
              FROM jsonb_array_elements(CASE
                WHEN jsonb_typeof(selected.provenance #> '{investigation,investigation,motiveReferences}')='array'
                  THEN selected.provenance #> '{investigation,investigation,motiveReferences}' ELSE '[]'::jsonb END) reference
              JOIN motive.submissions prior ON prior.project_id=$1 AND prior.id::text=reference->>'submissionId'
                AND prior.created_at<selected.created_at AND prior.origin='EXTERNAL'
              JOIN motive.participation_submission_artifacts prior_artifact ON prior_artifact.submission_id=prior.id
                AND prior_artifact.project_id=$1 AND prior_artifact.report_digest=reference->>'reportDigest'
                AND prior_artifact.witness_digest=reference->>'artifactDigest'
              JOIN motive.participation_agent_tokens prior_token ON prior_token.id=prior_artifact.agent_token_id
              LEFT JOIN motive.participation_post_check_assessments prior_assessment ON prior_assessment.submission_id=prior.id
            ) candidate ORDER BY candidate.submission_id,candidate.created_at
          ) link
        ) citations ON TRUE
      ), cursor_state AS (
        SELECT $3::uuid IS NULL OR EXISTS(SELECT 1 FROM cursor_row) AS cursor_found
      )
      SELECT cursor_state.cursor_found,enriched.* FROM cursor_state LEFT JOIN enriched ON TRUE
      ORDER BY enriched.created_at DESC NULLS LAST,enriched.id DESC NULLS LAST`,
    [projectId,options.ownerActorId,options.before,options.submissionId,options.limit,
      options.contributorMembershipId??null,options.namedOnly??false,options.acceptedFindingsOnly??false,
      options.findingQueueActorId??null,options.memoryQueueActorId??null,options.citingTargetSubmissionId??null]);
    const cursorFound=result.rows[0]?.cursor_found === true;
    const entries=result.rows.filter(row => row.id !== null).map(row => ({
      update:this.researchUpdate(row),submission:this.submissionSummary(row) }));
    return {entries,cursorFound};
  }

  private async publicResearchUpdates(client: PoolClient, projectId: string): Promise<PublicResearchUpdate[]> {
    const result=await this.researchJournalEntries(client,projectId,
      {ownerActorId:null,before:null,submissionId:null,limit:20});
    return result.entries.map(entry => entry.update);
  }

  private async publicJournalProject(client:PoolClient):Promise<string>{
    const project=await client.query(`SELECT id FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'`,
      [PARTICIPATION_PROJECT_SLUG]);
    if(project.rowCount!==1)throw new ParticipationError('NOT_FOUND','Research journal was not found.');
    return text(project.rows[0],'id');
  }

  private journalCursor(before:string|undefined):string|null{
    if(before===undefined)return null;
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(before))
      throw new ParticipationError('VALIDATION','before must be a canonical UUID.');
    return before;
  }

  private journalPage(entries:ResearchJournalEntry[]):ResearchJournalPage{
    const hasMore=entries.length>20;const items=entries.slice(0,20);
    return{format:'motive.research-journal-page/0.1',items,
      nextCursor:hasMore?items[items.length-1]!.submission.id:null};
  }

  async publicResearchJournal(before?:string):Promise<ResearchJournalPage>{
    const cursor=this.journalCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchJournalEntries(client,projectId,
        {ownerActorId:null,before:cursor,submissionId:null,limit:21});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Research journal cursor was not found.');
      return this.journalPage(result.entries);});
  }

  async publicResearchJournalEntry(submissionId:string):Promise<ResearchJournalEntry>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(submissionId))
      throw new ParticipationError('NOT_FOUND','Research journal entry was not found.');
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchJournalEntries(client,projectId,
        {ownerActorId:null,before:null,submissionId,limit:1});
      if(result.entries.length!==1)throw new ParticipationError('NOT_FOUND','Research journal entry was not found.');
      return result.entries[0]!;});
  }

  async publicResearchCitations(submissionId:string,before?:string):Promise<ResearchJournalPage>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(submissionId))
      throw new ParticipationError('NOT_FOUND','Research journal entry was not found.');
    const cursor=this.journalCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const target=await this.researchJournalEntries(client,projectId,
        {ownerActorId:null,before:null,submissionId,limit:1});
      if(target.entries.length!==1)throw new ParticipationError('NOT_FOUND','Research journal entry was not found.');
      const result=await this.researchJournalEntries(client,projectId,
        {ownerActorId:null,before:cursor,submissionId:null,limit:21,citingTargetSubmissionId:submissionId});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Research journal cursor was not found.');
      return this.journalPage(result.entries);});
  }

  async ownedResearchJournal(ownerActorId:string,before?:string):Promise<ResearchJournalPage>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId))
      throw new ParticipationError('UNAUTHORIZED','A live account is required.');
    const cursor=this.journalCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchJournalEntries(client,projectId,
        {ownerActorId,before:cursor,submissionId:null,limit:21});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Research journal cursor was not found.');
      return this.journalPage(result.entries);});
  }

  private researchHandoff(row:QueryResultRow):PublicResearchHandoff{
    return{id:text(row,'id'),claimId:text(row,'claim_id'),assignmentId:text(row,'assignment_id'),
      agentName:text(row,'agent_name'),contributorDisplayName:nullableText(row,'contributor_display_name'),
      createdAt:dateText(row.created_at),stopReason:text(row,'stop_reason'),
      intent:row.intent_claim_id===null?null:{proposal:text(row,'intent_proposal'),expectation:text(row,'intent_expectation'),
        conditions:row.intent_conditions as string[],workOrderRevision:Number(row.intent_work_order_revision),
        declaredAt:dateText(row.intent_declared_at)},interpretationStatus:'AGENT_DECLARED_UNVERIFIED'};
  }

  private async researchHandoffs(client:PoolClient,projectId:string,options:{
    ownerActorId:string|null;before:string|null;eventId:string|null;limit:number;
  }):Promise<{items:PublicResearchHandoff[];cursorFound:boolean}>{
    const result=await client.query(`WITH eligible AS NOT MATERIALIZED (
        SELECT event.id,event.created_at,event.aggregate_id::text AS claim_id,
          claim.work_order_id::text AS assignment_id,event.payload->>'agent_name' AS agent_name,
          event.payload->>'contributor_display_name' AS contributor_display_name,
          event.payload->>'stop_reason' AS stop_reason,
          intent.claim_id AS intent_claim_id,intent.proposal AS intent_proposal,
          intent.expectation AS intent_expectation,intent.conditions AS intent_conditions,
          intent.work_order_revision AS intent_work_order_revision,intent.created_at AS intent_declared_at
        FROM motive.events event
        JOIN motive.work_claims claim ON claim.id=event.aggregate_id AND event.aggregate_type='work_claim'
          AND claim.project_id=event.project_id AND claim.origin='EXTERNAL'
        JOIN motive.participation_agent_tokens token ON token.id::text=event.payload->>'contributor_id'
          AND token.project_id=event.project_id AND event.actor_id='agent:' || token.id::text
          AND claim.operator_actor_id='agent:' || token.id::text
        LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=claim.id
          AND intent.project_id=claim.project_id AND intent.agent_token_id=token.id
          AND intent.work_order_id=claim.work_order_id
        WHERE event.project_id=$1 AND event.event_type='external.assignment_released'
          AND jsonb_typeof(event.payload->'stop_reason')='string'
          AND length(event.payload->>'stop_reason') BETWEEN 1 AND 1000
          AND btrim(event.payload->>'stop_reason')=event.payload->>'stop_reason'
          AND jsonb_typeof(event.payload->'agent_name')='string'
          AND event.payload ? 'contributor_display_name'
          AND ($2::text IS NULL OR token.owner_actor_id=$2)
      ), cursor_row AS (
        SELECT id,created_at FROM eligible WHERE id=$3::uuid
      ), selected AS (
        SELECT eligible.* FROM eligible
        WHERE ($4::uuid IS NULL OR eligible.id=$4::uuid)
          AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM cursor_row)
            AND (eligible.created_at,eligible.id)<((SELECT created_at FROM cursor_row),(SELECT id FROM cursor_row)))
        ORDER BY eligible.created_at DESC,eligible.id DESC LIMIT $5
      ), cursor_state AS (
        SELECT $3::uuid IS NULL OR EXISTS(SELECT 1 FROM cursor_row) AS cursor_found
      ) SELECT cursor_state.cursor_found,selected.* FROM cursor_state LEFT JOIN selected ON TRUE
        ORDER BY selected.created_at DESC NULLS LAST,selected.id DESC NULLS LAST`,
    [projectId,options.ownerActorId,options.before,options.eventId,options.limit]);
    return{cursorFound:result.rows[0]?.cursor_found===true,
      items:result.rows.filter(row=>row.id!==null).map(row=>this.researchHandoff(row))};
  }

  private handoffCursor(value:string|undefined):string|null{
    if(value===undefined)return null;
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
      throw new ParticipationError('VALIDATION','before must be a canonical UUID.');
    return value;
  }

  private handoffPage(items:PublicResearchHandoff[]):PublicResearchHandoffPage{
    const hasMore=items.length>20;const page=items.slice(0,20);
    return{format:'motive.research-handoff-page/0.1',items:page,
      nextCursor:hasMore?page[page.length-1]!.id:null};
  }

  async publicResearchHandoffs(before?:string):Promise<PublicResearchHandoffPage>{
    const cursor=this.handoffCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchHandoffs(client,projectId,{ownerActorId:null,before:cursor,eventId:null,limit:21});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Research handoff cursor was not found.');
      return this.handoffPage(result.items);});
  }

  async publicResearchHandoff(eventId:string):Promise<PublicResearchHandoff>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(eventId))
      throw new ParticipationError('NOT_FOUND','Research handoff was not found.');
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchHandoffs(client,projectId,{ownerActorId:null,before:null,eventId,limit:1});
      if(result.items.length!==1)throw new ParticipationError('NOT_FOUND','Research handoff was not found.');
      return result.items[0]!;});
  }

  async ownedResearchHandoffs(ownerActorId:string,before?:string):Promise<PublicResearchHandoffPage>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId))
      throw new ParticipationError('UNAUTHORIZED','A live account is required.');
    const cursor=this.handoffCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await this.researchHandoffs(client,projectId,{ownerActorId,before:cursor,eventId:null,limit:21});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Research handoff cursor was not found.');
      return this.handoffPage(result.items);});
  }

  private async reviewQueueProject(client:Pick<Pool,'query'>|PoolClient,reviewerActorId:string,lock=false):Promise<string>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(reviewerActorId))
      throw new ParticipationError('UNAUTHORIZED','A live account is required.');
    const result=await client.query(`SELECT project.id
      FROM motive.projects project
      JOIN motive.memberships membership ON membership.project_id=project.id AND membership.actor_id=$2
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
      JOIN motive.account_identities account ON account.actor_id=membership.actor_id
        AND account.status='ACTIVE'
      WHERE project.slug=$1 AND project.visibility='PUBLIC'
      ${lock?'FOR SHARE OF membership,account':''}`,[PARTICIPATION_PROJECT_SLUG,reviewerActorId]);
    if(result.rowCount!==1)throw new ParticipationError('FORBIDDEN','Current project reviewer authority is required.');
    return text(result.rows[0],'id');
  }

  async findingReviewQueue(reviewerActorId:string,before?:string):Promise<ResearchJournalPage>{
    const cursor=this.journalCursor(before);
    const projectId=await this.reviewQueueProject(this.pool,reviewerActorId);
    if(!await this.actorIsActive(reviewerActorId))
      throw new ParticipationError('FORBIDDEN','Current project reviewer authority is required.');
    return this.transaction(async client=>{
      const currentProjectId=await this.reviewQueueProject(client,reviewerActorId,true);
      if(currentProjectId!==projectId)throw new ParticipationError('FORBIDDEN','Current project reviewer authority is required.');
      const result=await this.researchJournalEntries(client,projectId,{ownerActorId:null,before:cursor,
        submissionId:null,limit:21,findingQueueActorId:reviewerActorId});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Finding review queue cursor was not found.');
      return this.journalPage(result.entries);
    });
  }

  async memoryReviewQueue(reviewerActorId:string,before?:string):Promise<ResearchJournalPage>{
    const cursor=this.journalCursor(before);
    const projectId=await this.reviewQueueProject(this.pool,reviewerActorId);
    if(!await this.actorIsActive(reviewerActorId))
      throw new ParticipationError('FORBIDDEN','Current project reviewer authority is required.');
    return this.transaction(async client=>{
      const currentProjectId=await this.reviewQueueProject(client,reviewerActorId,true);
      if(currentProjectId!==projectId)throw new ParticipationError('FORBIDDEN','Current project reviewer authority is required.');
      const result=await this.researchJournalEntries(client,projectId,{ownerActorId:null,before:cursor,
        submissionId:null,limit:21,memoryQueueActorId:reviewerActorId});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Shared-memory review queue cursor was not found.');
      return this.journalPage(result.entries);
    });
  }

  private async hasNamedPublicContributor(client:PoolClient,projectId:string,contributorId:string):Promise<boolean>{
    const contributor=await client.query(`SELECT membership.id
      FROM motive.memberships membership
      WHERE membership.id=$2::uuid AND membership.project_id=$1
        AND EXISTS(SELECT 1 FROM motive.participation_submission_artifacts artifact
          JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
            AND token.project_id=artifact.project_id
          WHERE artifact.project_id=$1 AND token.owner_actor_id=membership.actor_id
            AND artifact.contributor_display_name IS NOT NULL)`,[projectId,contributorId]);
    return contributor.rowCount===1;
  }

  async publicContributorResearchJournal(contributorId:string,before?:string):Promise<PublicContributorJournalPage>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(contributorId))
      throw new ParticipationError('VALIDATION','contributorId must be a canonical UUID.');
    const cursor=this.journalCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      if(!await this.hasNamedPublicContributor(client,projectId,contributorId))
        throw new ParticipationError('NOT_FOUND','Contributor research journal was not found.');
      const result=await this.researchJournalEntries(client,projectId,{ownerActorId:null,before:cursor,
        submissionId:null,limit:21,contributorMembershipId:contributorId,namedOnly:true});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Contributor research journal was not found.');
      const page=this.journalPage(result.entries);
      return{format:'motive.contributor-journal/0.1',projectSlug:PARTICIPATION_PROJECT_SLUG,
        contributorId,items:page.items,nextCursor:page.nextCursor};});
  }

  async publicContributorAcceptedFindings(contributorId:string,before?:string):Promise<PublicContributorJournalPage>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(contributorId))
      throw new ParticipationError('VALIDATION','contributorId must be a canonical UUID.');
    const cursor=this.journalCursor(before);
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      if(!await this.hasNamedPublicContributor(client,projectId,contributorId))
        throw new ParticipationError('NOT_FOUND','Contributor accepted findings were not found.');
      const result=await this.researchJournalEntries(client,projectId,{ownerActorId:null,before:cursor,
        submissionId:null,limit:21,contributorMembershipId:contributorId,namedOnly:true,acceptedFindingsOnly:true});
      if(!result.cursorFound)throw new ParticipationError('NOT_FOUND','Contributor accepted findings were not found.');
      const page=this.journalPage(result.entries);
      return{format:'motive.contributor-journal/0.1',projectSlug:PARTICIPATION_PROJECT_SLUG,
        contributorId,items:page.items,nextCursor:page.nextCursor};});
  }

  async publicContributorReviewedArtifacts(contributorId:string,after?:string):Promise<ContributorReviewedArtifactsPage>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(contributorId))
      throw new ParticipationError('VALIDATION','contributorId must be a canonical UUID.');
    if(after!==undefined&&!/^[a-f0-9]{64}$/.test(after))
      throw new ParticipationError('VALIDATION','after must be a lowercase 64-character SHA-256 digest.');
    const cursor=after??null;
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      if(!await this.hasNamedPublicContributor(client,projectId,contributorId))
        throw new ParticipationError('NOT_FOUND','Contributor reviewed artifacts were not found.');
      const result=await client.query(`WITH ${LATEST_SUBMISSION_ADMISSION_CTES},
        qualifying AS (
          SELECT substring(artifact.witness_digest from 8) AS witness_digest,
            artifact.submission_id,artifact.created_at AS submitted_at,token.agent_name,
            latest.id AS review_id,latest.created_at AS reviewed_at,latest.rationale
          FROM motive.participation_submission_artifacts artifact
          JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
            AND token.project_id=artifact.project_id
          JOIN motive.memberships membership ON membership.id=$2::uuid
            AND membership.project_id=artifact.project_id AND membership.actor_id=token.owner_actor_id
          JOIN latest_submission_decision latest ON latest.source_submission_id=artifact.submission_id
            AND latest.decision='ADMIT'
          WHERE artifact.project_id=$1 AND artifact.contributor_display_name IS NOT NULL
        ), representatives AS (
          SELECT DISTINCT ON (witness_digest) witness_digest,submission_id,submitted_at,agent_name,
            review_id,reviewed_at,rationale
          FROM qualifying
          ORDER BY witness_digest,reviewed_at DESC,review_id DESC,submission_id DESC
        )
        SELECT * FROM representatives WHERE ($3::text IS NULL OR witness_digest>$3)
        ORDER BY witness_digest ASC LIMIT 21`,[projectId,contributorId,cursor]);
      const hasMore=result.rows.length>20;const rows=result.rows.slice(0,20);
      const items=rows.map(row=>({witnessDigest:text(row,'witness_digest'),submissionId:text(row,'submission_id'),
        agentName:text(row,'agent_name'),submittedAt:dateText(row.submitted_at),
        review:{id:text(row,'review_id'),decision:'ADMIT' as const,reviewedAt:dateText(row.reviewed_at),
          rationale:text(row,'rationale')}}));
      return{format:'motive.contributor-reviewed-artifacts/0.1',projectSlug:PARTICIPATION_PROJECT_SLUG,
        contributorId,items,nextCursor:hasMore?items[items.length-1]!.witnessDigest:null};});
  }

  async submissionOwnership(ownerActorId:string,submissionIds:string[]):Promise<SubmissionOwnershipProjection>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId))
      throw new ParticipationError('UNAUTHORIZED','A live account is required.');
    if(submissionIds.length<1||submissionIds.length>64||new Set(submissionIds).size!==submissionIds.length
      ||submissionIds.some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))
      throw new ParticipationError('VALIDATION','Submission ownership IDs are invalid.');
    return this.transaction(async client=>{const projectId=await this.publicJournalProject(client);
      const result=await client.query(`SELECT artifact.submission_id::text AS submission_id
        FROM motive.participation_submission_artifacts artifact
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
          AND token.project_id=artifact.project_id
        WHERE artifact.project_id=$1 AND token.owner_actor_id=$2
          AND artifact.submission_id=ANY($3::uuid[])`,[projectId,ownerActorId,submissionIds]);
      const owned=new Set(result.rows.map(row=>text(row,'submission_id')));
      return{format:'motive.submission-ownership/0.1',
        ownedSubmissionIds:submissionIds.filter(id=>owned.has(id))};});
  }

  async publicProjection(): Promise<ParticipationPublicProjection> {
    return this.transaction(async client => {
      const project = await client.query(`SELECT id,current_revision FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'`, [PARTICIPATION_PROJECT_SLUG]);
      if (project.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Project not found.');
      const projectId = text(project.rows[0], 'id');
      const counts = await client.query(`SELECT
        (SELECT count(*)::integer FROM motive.work_claims WHERE project_id=$1 AND origin='EXTERNAL' AND status='ACTIVE' AND expires_at>clock_timestamp()) active,
        (SELECT count(*)::integer FROM motive.participation_submission_artifacts WHERE project_id=$1) submissions,
        (SELECT count(*)::integer FROM motive.participation_submission_reviews WHERE project_id=$1 AND decision='ACCEPTED') accepted,
        (SELECT count(DISTINCT token.id)::integer FROM motive.work_claims claim
          JOIN motive.participation_agent_tokens token ON claim.operator_actor_id='agent:' || token.id::text
            AND token.project_id=claim.project_id
          JOIN motive.work_orders work ON work.id=claim.work_order_id AND work.project_id=claim.project_id
            AND work.terms_digest=claim.terms_digest
          JOIN motive.work_order_states state ON state.work_order_id=work.id
          JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
          JOIN motive.account_identities account ON account.actor_id=token.owner_actor_id
          LEFT JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id
          WHERE claim.project_id=$1 AND claim.origin='EXTERNAL' AND claim.status='ACTIVE' AND claim.expires_at>clock_timestamp()
            AND completion.claim_id IS NULL AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
            AND membership.revoked_at IS NULL AND account.status='ACTIVE'
            AND work.project_revision=$2 AND state.state='READY') active_agents,
        (SELECT count(DISTINCT completion.claim_id)::integer FROM motive.participation_claim_completions completion
          JOIN motive.work_claims claim ON claim.id=completion.claim_id WHERE claim.project_id=$1 AND claim.origin='EXTERNAL') completed_attempts,
        (SELECT count(*)::integer FROM motive.participation_post_check_assessments WHERE project_id=$1) recorded_updates,
        (SELECT count(*)::integer FROM motive.participation_submission_artifacts
          WHERE project_id=$1 AND contributor_display_name IS NULL) private_contributions,
        (SELECT count(DISTINCT assessment.submission_id)::integer FROM motive.participation_post_check_assessments assessment
          JOIN motive.participation_claim_completions completion ON completion.submission_id=assessment.submission_id
          WHERE assessment.project_id=$1) completed_cycles`, [projectId, project.rows[0].current_revision]);
      const submissions = await client.query(`SELECT submission_id FROM motive.participation_submission_artifacts WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`, [projectId]);
      const best = await client.query(`SELECT artifact.submission_id FROM motive.participation_submission_artifacts artifact
        JOIN motive.participation_submission_reviews review ON review.submission_id=artifact.submission_id
        WHERE artifact.project_id=$1 AND artifact.report='VALID' AND review.decision='ACCEPTED'
        ORDER BY artifact.exact_score::numeric DESC,artifact.created_at,artifact.submission_id LIMIT 1`, [projectId]);
      const bestChecked = await client.query(`SELECT artifact.submission_id
        FROM motive.participation_submission_artifacts artifact
        WHERE artifact.project_id=$1 AND artifact.report='VALID' AND artifact.exact_score IS NOT NULL
        ORDER BY artifact.exact_score::numeric DESC,artifact.created_at,artifact.submission_id LIMIT 1`, [projectId]);
      const projectedSubmissionIds = submissions.rows.map(row => text(row, 'submission_id'));
      const contributors = await client.query(`WITH ${LATEST_SUBMISSION_ADMISSION_CTES}
        SELECT membership.id::text AS id,
          (array_agg(artifact.contributor_display_name ORDER BY artifact.created_at DESC,artifact.submission_id DESC))[1] AS display_name,
          min(artifact.created_at) AS first_submitted_at,count(*)::integer AS submission_count,
          count(DISTINCT artifact.witness_digest) FILTER (WHERE latest.decision='ADMIT')::integer AS reviewed_artifact_count,
          count(*) FILTER (WHERE EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
            WHERE finding.source_submission_id=artifact.submission_id AND finding.project_id=artifact.project_id
              AND finding.decision='ACCEPT' AND finding.novelty='DISTINCT'
              AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
                WHERE successor.previous_decision_id=finding.id)))::integer AS accepted_finding_count,
          (count(DISTINCT completion.claim_id) FILTER (WHERE assessment.submission_id IS NOT NULL)*100)::integer AS task_xp,
          coalesce((array_agg(artifact.submission_id::text ORDER BY artifact.created_at DESC,artifact.submission_id DESC)
            FILTER (WHERE artifact.submission_id=ANY($2::uuid[])))[1:50],ARRAY[]::text[]) AS public_submission_ids,
          coalesce((array_agg(artifact.submission_id::text ORDER BY artifact.created_at DESC,artifact.submission_id DESC)
            FILTER (WHERE artifact.submission_id=ANY($2::uuid[]) AND latest.decision='ADMIT'))[1:50],ARRAY[]::text[]) AS reviewed_submission_ids
        FROM motive.participation_submission_artifacts artifact
        JOIN motive.submissions task_submission ON task_submission.id=artifact.submission_id
          AND task_submission.project_id=artifact.project_id AND task_submission.origin='EXTERNAL'
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=artifact.project_id
        JOIN motive.memberships membership ON membership.project_id=artifact.project_id AND membership.actor_id=token.owner_actor_id
        LEFT JOIN latest_submission_decision latest ON latest.source_submission_id=artifact.submission_id
        LEFT JOIN motive.participation_claim_completions completion ON completion.submission_id=task_submission.id
          AND completion.claim_id=task_submission.claim_id
        LEFT JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=completion.submission_id
          AND assessment.project_id=artifact.project_id AND assessment.agent_token_id=artifact.agent_token_id
          AND assessment.report_digest=artifact.report_digest
        WHERE artifact.project_id=$1 AND artifact.contributor_display_name IS NOT NULL
        GROUP BY membership.id,token.owner_actor_id ORDER BY min(artifact.created_at) LIMIT 100`, [projectId,projectedSubmissionIds]);
      const activeIntents = await client.query(`SELECT intent.claim_id,intent.work_order_id,intent.work_order_revision,
        intent.proposal,intent.expectation,intent.conditions,intent.motive_references,intent.experiment_protocol,
        target.binding AS research_delivery_target_binding,
        intent.protocol_fingerprint,intent.created_at,claim.expires_at,
        token.agent_name,token.public_display_name
        FROM motive.participation_claim_intents intent
        JOIN motive.work_claims claim ON claim.id=intent.claim_id AND claim.project_id=intent.project_id
          AND claim.work_order_id=intent.work_order_id AND claim.operator_actor_id='agent:' || intent.agent_token_id::text
        JOIN motive.work_orders work ON work.id=intent.work_order_id AND work.project_id=intent.project_id
          AND work.revision=intent.work_order_revision AND work.terms_digest=intent.work_order_terms_digest
        JOIN motive.work_order_states state ON state.work_order_id=work.id
        JOIN motive.participation_agent_tokens token ON token.id=intent.agent_token_id AND token.project_id=intent.project_id
        JOIN motive.memberships membership ON membership.project_id=intent.project_id AND membership.actor_id=token.owner_actor_id
        JOIN motive.account_identities account ON account.actor_id=token.owner_actor_id
        LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=intent.claim_id
        LEFT JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id
        WHERE intent.project_id=$1 AND claim.origin='EXTERNAL' AND claim.status='ACTIVE'
          AND claim.expires_at>clock_timestamp() AND completion.claim_id IS NULL
          AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
          AND membership.revoked_at IS NULL AND account.status='ACTIVE'
          AND work.project_revision=$2 AND state.state='READY' AND claim.terms_digest=intent.work_order_terms_digest
        ORDER BY intent.created_at DESC,intent.claim_id DESC LIMIT 100`,
      [projectId, project.rows[0].current_revision]);
      const events = await client.query(`SELECT event.id,event.event_type,event.payload,event.created_at,
        token.public_display_name AS resolved_contributor_display_name
        FROM motive.events event LEFT JOIN motive.participation_agent_tokens token
          ON token.project_id=event.project_id AND event.actor_id='agent:' || token.id::text
        WHERE event.project_id=$1
          AND event.event_type IN ('external.assignment_claimed','external.assignment_intent_declared','external.assignment_released','external.submission_checked','external.assignment_completed','external.submission_reviewed','external.submission_assessed')
        ORDER BY event.created_at DESC LIMIT 50`, [projectId]);
      const researchUpdates = await this.publicResearchUpdates(client, projectId);
      const recentResearchHandoffs = (await this.researchHandoffs(client,projectId,
        {ownerActorId:null,before:null,eventId:null,limit:6})).items;
      const challengeOutcome=await this.challengeOutcome(client,projectId);
      const total = Number(counts.rows[0].submissions); const active = Number(counts.rows[0].active); const accepted = Number(counts.rows[0].accepted);
      return { project: { slug: PARTICIPATION_PROJECT_SLUG, visibility: 'PUBLIC',
        lifecycle: total > 0 ? 'RESULTS_AVAILABLE' : active > 0 ? 'CONTRIBUTING' : 'NOT_STARTED', projectRevision: Number(project.rows[0].current_revision) },
        activeAssignments: active, totalSubmissions: total, acceptedResults: accepted,
        bestChecked: bestChecked.rowCount
          ? await this.submissionById(client, text(bestChecked.rows[0], 'submission_id')) : null,
        bestAccepted: best.rowCount ? await this.submissionById(client, text(best.rows[0], 'submission_id')) : null,
        challengeOutcome,
        contributors: contributors.rows.map(row => ({ id: text(row, 'id'), displayName: text(row, 'display_name'),
          firstSubmittedAt: dateText(row.first_submitted_at), submissionCount: Number(row.submission_count),
          reviewedArtifactCount: Number(row.reviewed_artifact_count), acceptedFindingCount:Number(row.accepted_finding_count),
          taskXp:Number(row.task_xp),
          reviewedSubmissionIds: row.reviewed_submission_ids as string[],
          publicSubmissionIds: row.public_submission_ids as string[] })),
        privateContributionCount: Number(counts.rows[0].private_contributions),
        submissions: await Promise.all(submissions.rows.map(row => this.submissionById(client, text(row, 'submission_id')))),
        activity: events.rows.map(row => this.publicActivity(row)),
        researchUpdates,recentResearchHandoffs,
        activeResearchIntents: activeIntents.rows.map(row => ({ assignmentId: text(row, 'work_order_id'),
          claimId: text(row, 'claim_id'), agentName: text(row, 'agent_name'),
          contributorDisplayName: nullableText(row, 'public_display_name'), proposal: text(row, 'proposal'),
          expectation: text(row, 'expectation'), conditions: row.conditions as string[],
          ...(row.motive_references ? { motiveReferences: row.motive_references as SubmissionMotiveReference[] } : {}),
          ...(row.experiment_protocol ? { experimentProtocol: row.experiment_protocol as ExperimentProtocol,
            protocolFingerprint: text(row, 'protocol_fingerprint') } : {}),
          ...(row.research_delivery_target_binding ? { researchDeliveryTarget:
            validateResearchDeliveryTargetBinding(row.research_delivery_target_binding).selection } : {}),
          workOrderRevision: Number(row.work_order_revision), declaredAt: dateText(row.created_at),
          expiresAt: dateText(row.expires_at) } satisfies PublicActiveResearchIntent)), loopProgress: {
          activeAgents: Number(counts.rows[0].active_agents), completedAttempts: Number(counts.rows[0].completed_attempts),
          checkedSubmissions: total, recordedUpdates: Number(counts.rows[0].recorded_updates),
        completedCycles: Number(counts.rows[0].completed_cycles) } };
    });
  }

  private publicActivity(row: QueryResultRow): ParticipationActivity {
    const payload = row.payload as Record<string, unknown>; const event = text(row, 'event_type');
    const mapping: Record<string, ParticipationActivity['type']> = { 'external.assignment_claimed': 'ASSIGNMENT_CLAIMED',
      'external.assignment_intent_declared': 'ASSIGNMENT_INTENT_DECLARED',
      'external.assignment_released': 'ASSIGNMENT_RELEASED', 'external.submission_checked': 'SUBMISSION_CHECKED',
      'external.assignment_completed': 'ASSIGNMENT_COMPLETED', 'external.submission_reviewed': 'SUBMISSION_REVIEWED',
      'external.submission_assessed': 'SUBMISSION_ASSESSED' };
    const detail = event === 'external.submission_checked' ? `${String(payload.report_status).toLowerCase()} local checker report`
      : event === 'external.submission_reviewed' ? `${String(payload.decision).toLowerCase()} by an independent reviewer`
      : event === 'external.submission_assessed' ? 'agent-declared post-check assessment added'
      : event === 'external.assignment_intent_declared' ? 'agent-declared research intent recorded'
      : event.replace('external.', '').replaceAll('_', ' ');
    const hasFrozenName=Object.prototype.hasOwnProperty.call(payload,'contributor_display_name');
    const frozenName=typeof payload.contributor_display_name==='string'?payload.contributor_display_name:null;
    return { id: text(row, 'id'), type: mapping[event], createdAt: dateText(row.created_at),
      contributorDisplayName: hasFrozenName?frozenName:nullableText(row, 'resolved_contributor_display_name'),
      submissionId: typeof payload.submission_id === 'string' ? payload.submission_id : null, detail };
  }

  async publicArtifact(submissionId: string): Promise<{ bytes: Buffer; digest: string }> {
    const result = await this.pool.query(`SELECT artifact.witness_bytes,artifact.witness_digest FROM motive.participation_submission_artifacts artifact
      JOIN motive.projects project ON project.id=artifact.project_id WHERE artifact.submission_id=$1 AND project.visibility='PUBLIC'`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
    return { bytes: result.rows[0].witness_bytes as Buffer, digest: text(result.rows[0], 'witness_digest') };
  }

  async publicGeometryComparison(leftSubmissionId: string, rightSubmissionId: string): Promise<GeometryComparisonResponse> {
    if (!CANONICAL_ACCOUNT_ID.test(leftSubmissionId) || !CANONICAL_ACCOUNT_ID.test(rightSubmissionId)) {
      throw new ParticipationError('VALIDATION', 'Geometry comparison requires canonical lowercase submission UUIDs.');
    }
    const ids = [...new Set([leftSubmissionId, rightSubmissionId])];
    const result = await this.pool.query(`SELECT artifact.submission_id::text,artifact.witness_bytes,
      artifact.witness_digest,artifact.report::text
      FROM motive.participation_submission_artifacts artifact
      JOIN motive.submissions submission ON submission.id=artifact.submission_id AND submission.project_id=artifact.project_id
      JOIN motive.projects project ON project.id=artifact.project_id
      WHERE artifact.submission_id=ANY($1::uuid[]) AND project.slug=$2 AND project.visibility='PUBLIC'`,
    [ids, PARTICIPATION_PROJECT_SLUG]);
    if (result.rowCount !== ids.length) throw new ParticipationError('NOT_FOUND', 'Submission geometry is not available.');
    const rows = new Map(result.rows.map(row => [text(row, 'submission_id'), row]));
    const read = (submissionId: string) => {
      const row = rows.get(submissionId);
      if (!row) throw new ParticipationError('NOT_FOUND', 'Submission geometry is not available.');
      if (text(row, 'report') !== 'VALID') {
        throw new ParticipationError('CONFLICT', 'Only valid protected geometry reports can be compared.');
      }
      const bytes = row.witness_bytes;
      const digest = text(row, 'witness_digest');
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > CSQV_MAX_BYTES
        || !CANONICAL_SHA256.test(digest) || sha256(bytes) !== digest) {
        throw new ParticipationError('CONFLICT', 'Stored geometry comparison evidence is invalid.');
      }
      let witness: string;
      try { witness = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new ParticipationError('CONFLICT', 'Stored geometry comparison evidence is invalid.'); }
      return { submissionId, artifactSha256: digest, witness };
    };
    const left = read(leftSubmissionId); const right = read(rightSubmissionId);
    const comparison = compareCirclePackingWitnesses(left.witness, right.witness);
    if (!comparison.ok) throw new ParticipationError('CONFLICT', 'Stored geometry comparison evidence is invalid.');
    return { format: 'motive.csqv.geometry-comparison.v1',
      left: { submissionId: left.submissionId, artifactSha256: left.artifactSha256 },
      right: { submissionId: right.submissionId, artifactSha256: right.artifactSha256 },
      relation: comparison.relation };
  }

  async publicReport(submissionId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query(`SELECT artifact.report,artifact.report_body,artifact.report_digest,artifact.witness_digest,artifact.exact_score,
      artifact.exceeds_reference,review.decision,submission.id AS submission_id,submission.project_id,submission.work_order_id,
      submission.work_order_revision,submission.claim_id,submission.lease_epoch,submission.artifact_manifest_digest,work.terms_digest,work.terms FROM motive.participation_submission_artifacts artifact
      JOIN motive.submissions submission ON submission.id=artifact.submission_id
      JOIN motive.work_orders work ON work.id=submission.work_order_id
      JOIN motive.projects project ON project.id=artifact.project_id
      LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=artifact.submission_id
      WHERE artifact.submission_id=$1 AND project.visibility='PUBLIC'`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
    const row = result.rows[0]; const terms = row.terms as WorkOrderTerms;
    return { format: 'motive.csqv.public-report.v1', reportStatus: row.report, reportDigest: row.report_digest,
      binding: { projectId: row.project_id, projectRevision: terms.project_revision, workOrderId: row.work_order_id,
        workOrderRevision: row.work_order_revision, agreementId: terms.agreement_id, termsDigest: row.terms_digest,
        claimId: row.claim_id, leaseEpoch: Number(row.lease_epoch), submissionId: row.submission_id,
        artifactDigest: row.witness_digest, artifactManifestDigest: row.artifact_manifest_digest,
        checker: { format: CHECKER_FORMAT, version: CHECKER_VERSION, sourceDigest: CHECKER_SOURCE_DIGEST,
          evaluationProfileDigest: terms.evaluation.profile_digest } },
      exactScore: row.exact_score, exceedsReference: row.exceeds_reference,
      acceptance: row.decision ?? 'PENDING', localOnly: true, report: row.report_body };
  }

  async publicInvestigation(submissionId: string): Promise<PublicSubmissionInvestigation> {
    const result = await this.pool.query(`SELECT submission.id,submission.created_at,submission.provenance,
      artifact.report,artifact.exact_score,artifact.exceeds_reference,intent.claim_id AS intent_claim_id,
      intent.proposal AS intent_proposal,intent.expectation AS intent_expectation,intent.conditions AS intent_conditions,
      intent.research_context AS intent_research_context,intent.research_references AS intent_research_references,
        intent.motive_references AS intent_motive_references,intent.experiment_protocol AS intent_experiment_protocol,
        target.binding AS intent_research_delivery_target_binding,
        intent.protocol_fingerprint AS intent_protocol_fingerprint,
      intent.work_order_revision AS intent_work_order_revision,intent.created_at AS intent_created_at
      FROM motive.submissions submission JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      JOIN motive.projects project ON project.id=submission.project_id
      LEFT JOIN motive.participation_claim_intents intent ON intent.claim_id=submission.claim_id
      LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=intent.claim_id
      WHERE submission.id=$1 AND project.visibility='PUBLIC'`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
    const row = result.rows[0]; const provenance = row.provenance as Record<string, unknown>;
    const stored = provenance.investigation as { attribution?: PublicSubmissionInvestigation['attribution']; investigation?: SubmissionInvestigationInput } | null;
    if (!stored?.attribution || !stored.investigation) throw new ParticipationError('NOT_FOUND', 'This submission has no investigation record.');
    return { format: 'motive.investigation.public.v1', submissionId: text(row, 'id'), createdAt: dateText(row.created_at),
      attribution: stored.attribution, investigation: stored.investigation,
      claimIntent: row.intent_claim_id ? { claimId: text(row, 'intent_claim_id'), proposal: text(row, 'intent_proposal'),
        expectation: text(row, 'intent_expectation'), conditions: row.intent_conditions as string[],
        ...(row.intent_research_context ? { researchContext: row.intent_research_context as SubmissionResearchContext } : {}),
        ...(row.intent_research_references ? { researchReferences: row.intent_research_references as SubmissionResearchReference[] } : {}),
        ...(row.intent_motive_references ? { motiveReferences: row.intent_motive_references as SubmissionMotiveReference[] } : {}),
        ...(row.intent_experiment_protocol ? { experimentProtocol: row.intent_experiment_protocol as ExperimentProtocol } : {}),
        ...(row.intent_research_delivery_target_binding ? { researchDeliveryTarget:
          validateResearchDeliveryTargetBinding(row.intent_research_delivery_target_binding).selection } : {}),
        ...(row.intent_protocol_fingerprint ? { protocolFingerprint: text(row, 'intent_protocol_fingerprint') } : {}),
        workOrderRevision: Number(row.intent_work_order_revision), declaredAt: dateText(row.intent_created_at) } : null,
      evidence: { reportStatus: text(row, 'report') as PublicSubmissionInvestigation['evidence']['reportStatus'],
        exactScore: nullableText(row, 'exact_score'), exceedsReference: row.exceeds_reference === null ? null : Boolean(row.exceeds_reference),
        reportHref: `/api/public/projects/${PARTICIPATION_PROJECT_SLUG}/submissions/${row.id}/report` },
      interpretationStatus: 'AGENT_DECLARED_UNVERIFIED',
      notice: 'The proposal, expectation, observations, assessment, and next action are contributor statements. A research-context citation records the retained baseline supplied with the investigation; it does not prove the contributor used it in its reasoning. The protected checker report is separate evidence.' };
  }

  private async postCheckAssessment(client: PoolClient, submissionId: string, publicOnly = false): Promise<PublicPostCheckAssessment> {
    const result = await client.query(`SELECT assessment.submission_id,assessment.report_digest,assessment.assessment,
      assessment.next_action,assessment.public_question,assessment.public_finding,assessment.created_at,
      token.id AS credential_id,token.agent_name,token.model_name,token.public_display_name
      FROM motive.participation_post_check_assessments assessment
      JOIN motive.participation_agent_tokens token ON token.id=assessment.agent_token_id
      JOIN motive.projects project ON project.id=assessment.project_id
      WHERE assessment.submission_id=$1${publicOnly ? " AND project.visibility='PUBLIC'" : ''}`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'This submission has no post-check assessment.');
    const row = result.rows[0];
    return { format: 'motive.post-check-assessment.public.v1', submissionId: text(row, 'submission_id'),
      reportDigest: text(row, 'report_digest'), createdAt: dateText(row.created_at),
      attribution: { kind: 'AGENT_DECLARED', credentialId: text(row, 'credential_id'), agentName: text(row, 'agent_name'),
        modelName: nullableText(row, 'model_name'), contributorDisplayName: nullableText(row, 'public_display_name') },
      assessment: text(row, 'assessment'), nextAction: text(row, 'next_action'),
      ...(row.public_question===null?{}:{publicSummary:{question:text(row,'public_question'),finding:text(row,'public_finding')}}),
      disposition: 'AGENT_DECLARED_UNVERIFIED',
      notice: 'This post-check assessment and next action are contributor statements tied to the protected checker report. They do not indicate support or acceptance.' };
  }

  async publicPostCheckAssessment(submissionId: string): Promise<PublicPostCheckAssessment> {
    return this.transaction(client => this.postCheckAssessment(client, submissionId, true));
  }

  async publicSubmissionReproducibility(submissionId: string): Promise<PublicSubmissionReproducibility> {
    return this.submissionReproducibility(this.pool, submissionId, true);
  }

  async publicSubmissionReproducibilityFile(submissionId: string, role: 'SOLVER_SOURCE' | 'TRIAL_RESULTS'):
    Promise<{ bytes: Buffer; digest: string; name: string; mediaType: 'text/plain' }> {
    const result = await this.pool.query(`SELECT reproducibility.solver_source_bytes,reproducibility.solver_source_digest,
      reproducibility.trial_results_bytes,reproducibility.trial_results_digest
      FROM motive.participation_submission_reproducibility reproducibility
      JOIN motive.projects project ON project.id=reproducibility.project_id
      WHERE reproducibility.submission_id=$1 AND project.visibility='PUBLIC'`, [submissionId]);
    if (result.rowCount !== 1) throw new ParticipationError('NOT_FOUND', 'Submission reproducibility files not found.');
    const row = result.rows[0]; const source = role === 'SOLVER_SOURCE';
    const bytes = row[source ? 'solver_source_bytes' : 'trial_results_bytes'] as Buffer;
    const digest = text(row, source ? 'solver_source_digest' : 'trial_results_digest');
    if (sha256(bytes) !== digest) throw new Error('Stored reproducibility file digest is invalid.');
    return { bytes, digest, name: source ? 'solver-source.txt' : 'trial-results.txt', mediaType: 'text/plain' };
  }

  private async event(client: PoolClient, projectId: string, aggregateType: string, aggregateId: string,
    eventType: string, actorId: string, payload: Record<string, unknown>) {
    await client.query(`INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [randomUUID(), projectId, aggregateType, aggregateId, eventType, JSON.stringify(payload), actorId]);
  }
}

export function createParticipationService(pool: Pool, options: ServiceOptions) { return new ParticipationService(pool, options); }
