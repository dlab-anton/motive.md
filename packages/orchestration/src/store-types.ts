import type { DecimalAmount, Digest } from '../../domain/src/contracts.ts';
import type { FrozenVercelNativeWorkspaceBinding } from '../../artifact-storage/src/vercel-native-reader.ts';

/** Private collector provenance, never exposed through member evidence reads. */
export type WorkerWorkspaceBindingInput = {
  binding: FrozenVercelNativeWorkspaceBinding;
  workerRuntimeDigest: Digest;
};
export interface WorkerWorkspaceBindingStore {
  getWorkerWorkspaceBinding(lease: ControllerLease, environmentId: string): Promise<WorkerWorkspaceBindingInput | null>;
  recordWorkerWorkspaceBinding(lease: ControllerLease, environmentId: string, input: WorkerWorkspaceBindingInput): Promise<WorkerWorkspaceBindingInput>;
}

/**
 * The frozen, operator-approved artifact path set. It is persisted before a
 * native worker VM is dispatched, rather than being reconstructed from worker
 * output during collection.
 */
export type NativeCollectionApprovedPath = {
  relativePath: string;
  mediaType: string;
  availability: 'REQUIRED' | 'OPTIONAL_ON_FAILURE';
  /** A finite per-helper-command byte ceiling. */
  maximumBytes: number;
};

export type FreezeNativeCollectionPlanInput = {
  /** Reviewed collector/launcher/runtime registry identity. */
  collectorRuntimeDigest: Digest;
  /** Current Vercel ASCII/base64 transport hard cap, further bounded by profile policy. */
  maximumFileBytes: number;
  /** Every helper command is bounded by this total across the frozen paths. */
  maximumTotalBytes: number;
  approvedPaths: readonly NativeCollectionApprovedPath[];
};

export type NativeCollectionFrozenPath = NativeCollectionApprovedPath & {
  pathDigest: Digest;
};

export type WorkerExecutionBoundaryKind = 'PROTECTED_RUNTIME' | 'PROVIDER_UNTRUSTED_CIRCLE_DATA';

/** Private provider-effect budget. One bootstrap plus at most one capture per path. */
export type NativeCollectionPlanProjection = {
  environmentId: string;
  attemptId: string;
  leaseEpoch: number;
  controllerGeneration: string;
  profileDigest: Digest;
  executionBoundaryKind: WorkerExecutionBoundaryKind;
  executionBoundaryDigest: Digest;
  /** Present only for the historical protected native runtime boundary. */
  workerRuntimeDigest: Digest | null;
  collectorRuntimeDigest: Digest;
  collectionPlanDigest: Digest;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumFiles: number;
  maximumHelperCommands: number;
  paths: readonly NativeCollectionFrozenPath[];
  createdAt: string;
};

export type NativeCollectionEffectKind = 'BOOTSTRAP' | 'CAPTURE';
export type NativeCollectionEffectState =
  | 'INTENT_RECORDED'
  | 'CLAIMED'
  | 'START_RECORDED'
  | 'COMPLETED'
  | 'UNKNOWN';

/** Durable metadata only. Raw helper stdout and candidate artifact bytes stay out of PostgreSQL. */
export type NativeCollectionEffectProjection = {
  effectId: string;
  environmentId: string;
  attemptId: string;
  workerCommandEffectId: string;
  kind: NativeCollectionEffectKind;
  state: NativeCollectionEffectState;
  effectKey: string;
  provider: string;
  externalId: string;
  sessionId: string;
  leaseEpoch: number;
  controllerGeneration: string;
  profileDigest: Digest;
  workerRuntimeDigest: Digest;
  collectorRuntimeDigest: Digest;
  collectionPlanDigest: Digest;
  bootstrapEffectId: string | null;
  relativePath: string | null;
  pathDigest: Digest | null;
  maximumBytes: number | null;
  /** The frozen protected workspace identity passed directly to capture. */
  workspaceIdentity: string | null;
  claimed: boolean;
  claimedAt: string | null;
  providerCommandId: string | null;
  exitCode: number | null;
  stdoutDigest: Digest | null;
  stdoutBytes: number | null;
  unknownReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type NativeCollectionCompletionInput = {
  exitCode: number;
  /** Digest of exact, bounded helper stdout bytes; never the bytes themselves. */
  stdoutDigest: Digest;
  stdoutBytes: number;
};

export type RecordNativeBootstrapBindingInput = NativeCollectionCompletionInput & {
  binding: FrozenVercelNativeWorkspaceBinding;
};

export type PlanNativeCaptureInput = {
  /** Must name one path in the frozen plan exactly. */
  relativePath: string;
};

/**
 * Separate from generic environment effects because a worker already has one
 * COMMAND effect. These commands are still remote finite VM work and need
 * their own durable intent/claim/recovery fence.
 */
export interface NativeCollectionStore {
  freezeNativeCollectionPlan(lease: ControllerLease, environmentId: string, input: FreezeNativeCollectionPlanInput): Promise<NativeCollectionPlanProjection>;
  getNativeCollectionPlan(lease: ControllerLease, environmentId: string): Promise<NativeCollectionPlanProjection | null>;
  planNativeBootstrap(lease: ControllerLease, environmentId: string): Promise<{ effect: NativeCollectionEffectProjection }>;
  planNativeCapture(lease: ControllerLease, environmentId: string, input: PlanNativeCaptureInput): Promise<{ effect: NativeCollectionEffectProjection }>;
  claimNativeCollectionEffect(lease: ControllerLease, effectId: string): Promise<{ effectId: string; claimed: boolean }>;
  /** Persists the exact provider command id before waits or log decoding. */
  recordNativeCollectionStarted(lease: ControllerLease, effectId: string, handle: CommandHandle): Promise<NativeCollectionEffectProjection>;
  /** Atomically records a successful bootstrap command and its first protected binding. */
  recordNativeBootstrapBinding(lease: ControllerLease, effectId: string, input: RecordNativeBootstrapBindingInput): Promise<WorkerWorkspaceBindingInput>;
  recordNativeCollectionCompleted(lease: ControllerLease, effectId: string, input: NativeCollectionCompletionInput): Promise<NativeCollectionEffectProjection>;
  /** Any post-claim ambiguity is terminal for dispatch and may only be reconciled by provider command id. */
  markNativeCollectionUnknown(lease: ControllerLease, effectId: string, reason: string): Promise<NativeCollectionEffectProjection>;
  getNativeCollectionEffect(lease: ControllerLease, effectId: string): Promise<NativeCollectionEffectProjection>;
  listNativeCollectionEffects(lease: ControllerLease, environmentId: string): Promise<readonly NativeCollectionEffectProjection[]>;
}

/**
 * Private durable-controller contract.  Values here are deliberately small:
 * run capabilities, provider credentials, request bodies, and arbitrary
 * profile secrets never cross this persistence boundary.
 */

export type EnvironmentKind = 'WORKER' | 'EVALUATOR';

/** A non-terminal state always consumes one physical-environment slot. */
export type EnvironmentState =
  | 'RESERVED'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'STOP_REQUESTED'
  | 'UNKNOWN'
  | 'ORPHANED'
  /** A recorded create intent was never claimed, so no provider request was possible. */
  | 'ABANDONED'
  | 'TERMINATED';

export type EffectKind = 'CREATE' | 'COMMAND' | 'STOP';
export type EffectState = 'INTENT_RECORDED' | 'CLAIMED' | 'RESULT_RECORDED' | 'UNKNOWN' | 'ABANDONED';

export type ControllerLease = {
  attemptId: string;
  ownerId: string;
  /** Monotonically increases only when ownership changes or the prior lease expires. */
  epoch: number;
  controllerGeneration: string;
  expiresAt: string;
};

/** A provider resource identity only; it contains no bearer capability. */
export type EnvironmentHandle = {
  provider: string;
  externalId: string;
  /** Exact provider session identity. A replacement session is a new environment. */
  sessionId: string;
};

/** A provider command identity only; command text remains outside the store. */
export type CommandHandle = {
  providerCommandId: string;
};

export type ProviderObservation = {
  providerStatus: string;
  /** The adapter may report a provider TTL, but the store never infers termination from it. */
  providerExpiresAt?: string | null;
  observedAt?: string;
  state: Exclude<EnvironmentState, 'RESERVED' | 'ORPHANED' | 'ABANDONED'>;
  /** Required and true before the store can make an environment TERMINATED. */
  providerTerminal: boolean;
};

export type EnvironmentProjection = {
  id: string;
  attemptId: string | null;
  sourceId: string | null;
  grantId: string | null;
  kind: EnvironmentKind;
  state: EnvironmentState;
  leaseEpoch: number | null;
  controllerGeneration: string | null;
  profileDigest: Digest | null;
  profileSnapshot: Record<string, unknown> | null;
  launchPlanDigest: Digest | null;
  infrastructureAuthorizationId: string | null;
  maximumCostUsd: DecimalAmount | null;
  heldCostUsd: DecimalAmount | null;
  consumedCostUsd: DecimalAmount | null;
  provider: string | null;
  externalId: string | null;
  sessionId: string | null;
  providerStatus: string | null;
  providerExpiresAt: string | null;
  lastObservedAt: string | null;
  terminatedAt: string | null;
  orphanReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EffectIntent = {
  effectId: string;
  environmentId: string;
  attemptId: string | null;
  kind: EffectKind;
  state: EffectState;
  /** True only for the single durable caller permitted to send the remote request. */
  claimed: boolean;
  commandDigest: Digest | null;
  /** Present only after the single command result is durably recorded. */
  providerCommandId: string | null;
  claimedAt: string | null;
};

export type ExecutionProjection = {
  attemptId: string;
  lease: ControllerLease | null;
  environments: readonly EnvironmentProjection[];
  effects: readonly EffectIntent[];
  artifactSeal: ArtifactSealProjection | null;
};

export type InfrastructureAuthorizationProjection = {
  id: string;
  sourceAccountId: string;
  sourceAccountRef: string;
  actorId: string;
  limitUsd: DecimalAmount;
  heldUsd: DecimalAmount;
  consumedUsd: DecimalAmount;
  availableUsd: DecimalAmount;
  deficitUsd: DecimalAmount;
  expiresAt: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  createdAt: string;
};

export type ArtifactSealProjection = {
  environmentId: string;
  attemptId: string;
  manifestDigest: Digest | null;
  receiptId: string;
  status: 'SEALED' | 'FAILED';
  failureCode: string | null;
  createdAt: string;
};

export type ReserveEnvironmentInput = {
  kind: EnvironmentKind;
  profileDigest: Digest;
  /** Frozen reviewed configuration only. Secrets and capabilities are rejected. */
  profileSnapshot: Record<string, unknown>;
  launchPlanDigest: Digest;
  infrastructureAuthorizationId: string;
  maximumCostUsd: DecimalAmount;
};

export type PlanCommandInput = { commandDigest: Digest };

export type EvaluatorReportClaim = {
  reportDigest: Digest;
  /** Null records the deliberately synthesized unavailable report. */
  commandId: string | null;
};

export type CreateInfrastructureAuthorizationInput = {
  /** Caller-generated stable identity makes authorization retries non-additive. */
  id: string;
  sourceAccountId: string;
  sourceAccountRef: string;
  actorId: string;
  limitUsd: DecimalAmount;
  expiresAt: string;
};

export type SettleInfrastructureUsageInput = {
  environmentId: string;
  actualCostUsd: DecimalAmount;
  providerUsageId: string;
  rawProviderAmount?: string;
  /** Only an authoritative final bill may release the remaining reservation. */
  final?: boolean;
};

export type RecordArtifactSealInput = {
  manifestDigest: Digest;
  receiptId: string;
};

export type RecordArtifactFailureInput = {
  receiptId: string;
  failureCode: string;
};

export type RecordOrphanInput = {
  kind: EnvironmentKind;
  handle: EnvironmentHandle;
  providerStatus: string;
  /** A deterministic provider-owned identity/tag reference; no secret data. */
  identityDigest: Digest;
  observedAt?: string;
};

export type ReconciliationCandidate = {
  environment: EnvironmentProjection;
  effects: readonly EffectIntent[];
  reason:
    | 'CREATE_UNRESOLVED'
    | 'COMMAND_UNRESOLVED'
    | 'STOP_UNRESOLVED'
    | 'ENVIRONMENT_UNOBSERVED'
    | 'ORPHANED'
    | 'STOP_REQUESTED';
};

export type OutboxMessage = {
  id: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  dedupeKey: string;
  payload: unknown;
  deliveryAttempts: number;
};

export type DeliveryClaim = {
  outboxId: string;
  claimToken: string;
  expiresAt: string;
  message: OutboxMessage;
};

export type ClaimDeliveryBatchInput = {
  consumerId: string;
  limit: number;
  leaseMs: number;
  /** The dispatcher must only lease topics it can durably reconcile. */
  topics: readonly string[];
  /** Optional atomic narrowing for a project-owned hosted-attempt dispatcher. */
  attemptScope?: {
    kind: 'PROJECT_LEAD_ACTIVATION';
    projectSlug: string;
    beneficiaryActorId: string;
  };
};

export type AcknowledgeDeliveryInput = {
  outboxId: string;
  claimToken: string;
  triggerRunId: string;
};

export type DeferDeliveryInput = {
  outboxId: string;
  claimToken: string;
  retryAt: string;
  errorCode: string;
};

export interface OrchestrationStore extends NativeCollectionStore {
  acquireLease(attemptId: string, ownerId: string, ttlSeconds: number): Promise<ControllerLease>;
  heartbeat(lease: ControllerLease, ttlSeconds: number): Promise<ControllerLease>;
  createInfrastructureAuthorization(input: CreateInfrastructureAuthorizationInput): Promise<InfrastructureAuthorizationProjection>;
  reserveEnvironment(lease: ControllerLease, input: ReserveEnvironmentInput): Promise<{
    environment: EnvironmentProjection;
    effect: EffectIntent;
  }>;
  freezeEvaluatorLaunchPlan(lease: ControllerLease, environmentId: string,
    plan: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Current controllers may read a plan frozen by an older environment generation for cleanup/recovery. */
  getEvaluatorLaunchPlan(lease: ControllerLease, environmentId: string): Promise<Record<string, unknown> | null>;
  claimEffect(lease: ControllerLease, effectId: string): Promise<{ effectId: string; claimed: boolean }>;
  recordCreateResult(lease: ControllerLease, effectId: string, handle: EnvironmentHandle): Promise<EnvironmentProjection>;
  /** Persists a discovery-backed create result after a prior ambiguous create; never creates again. */
  recordRecoveredCreate(lease: ControllerLease, effectId: string, handle: EnvironmentHandle): Promise<EnvironmentProjection>;
  markEffectUnknown(lease: ControllerLease, effectId: string, reason: string): Promise<void>;
  /** Releases a never-claimed create intent; it does not claim a physical terminal observation. */
  abandonReservedEnvironment(lease: ControllerLease, environmentId: string): Promise<EnvironmentProjection>;
  getExecution(attemptId: string): Promise<ExecutionProjection | null>;
  /** Exact provider identity lookup for owned-environment inventory; never name-prefix guessing. */
  findEnvironment(handle: EnvironmentHandle): Promise<EnvironmentProjection | null>;
  planCommand(lease: ControllerLease, environmentId: string, input: PlanCommandInput): Promise<{ effect: EffectIntent }>;
  recordCommandResult(lease: ControllerLease, effectId: string, handle: CommandHandle): Promise<void>;
  claimEvaluatorReport(lease: ControllerLease, environmentId: string,
    input: EvaluatorReportClaim): Promise<EvaluatorReportClaim>;
  getEvaluatorReportClaim(lease: ControllerLease, environmentId: string): Promise<EvaluatorReportClaim | null>;
  recordObservation(lease: ControllerLease, environmentId: string, observation: ProviderObservation): Promise<EnvironmentProjection>;
  /** Cleanup-only admission closure for already terminal or planless tracked environments. */
  closeAttemptAdmission(lease: ControllerLease, environmentId: string, options?: { preserveEvaluation?: boolean }): Promise<void>;
  requestStop(lease: ControllerLease, environmentId: string, options?: { preserveEvaluation?: boolean }): Promise<{ effect: EffectIntent }>;
  recordStopResult(lease: ControllerLease, effectId: string, observation: ProviderObservation): Promise<EnvironmentProjection>;
  /** Closes evaluator admission after durable evidence and complete physical teardown. */
  finishEvaluation(lease: ControllerLease, environmentId: string, evaluationId: string): Promise<void>;
  settleInfrastructureUsage(lease: ControllerLease, input: SettleInfrastructureUsageInput): Promise<InfrastructureAuthorizationProjection>;
  recordArtifactSeal(lease: ControllerLease, environmentId: string, input: RecordArtifactSealInput): Promise<ArtifactSealProjection>;
  recordArtifactFailure(lease: ControllerLease, environmentId: string, input: RecordArtifactFailureInput): Promise<ArtifactSealProjection>;
  /** Records an untracked owned provider environment and creates a durable stop intent. */
  recordOrphan(input: RecordOrphanInput): Promise<{ environment: EnvironmentProjection; effect: EffectIntent }>;
  claimOrphanStop(reconcilerId: string, effectId: string): Promise<{ effectId: string; claimed: boolean }>;
  markOrphanStopUnknown(reconcilerId: string, effectId: string, reason: string): Promise<void>;
  recordOrphanStopResult(reconcilerId: string, effectId: string, observation: ProviderObservation): Promise<EnvironmentProjection>;
  /** A later trusted provider observation is the only way an orphan releases physical capacity. */
  recordOrphanObservation(environmentId: string, observation: ProviderObservation): Promise<EnvironmentProjection>;
  listReconciliationCandidates(limit: number): Promise<readonly ReconciliationCandidate[]>;
  claimDeliveryBatch(input: ClaimDeliveryBatchInput): Promise<readonly DeliveryClaim[]>;
  acknowledgeDelivery(input: AcknowledgeDeliveryInput): Promise<boolean>;
  deferDelivery(input: DeferDeliveryInput): Promise<boolean>;
}
