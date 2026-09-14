import { isIP } from 'node:net';
import Decimal from 'decimal.js';
import type { Pool, QueryResultRow } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import {
  digestCanonicalJson,
  validateWorkOrderTerms,
  type DecimalAmount,
  type Digest,
} from '../../packages/domain/src/contracts.ts';
import {
  DurableWorkerCoordinator,
  type CoordinatorDependencies,
  type ReconcileResult,
  type WorkerLaunchPlan,
} from '../../packages/orchestration/src/coordinator.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import {
  VercelOrphanProvider,
  VercelSandboxAdapter,
  createNativeVercelSdkFactory,
  requireWorkerExecutionBoundary,
  validateProfile,
  type NativeVercelCredentials,
  type SandboxExecutionProfile,
  type SandboxSdkFactory,
} from '../../packages/sandbox-vercel/src/index.ts';
import {
  ProjectRunResearchContextError,
  type ProjectRunResearchContextResolver,
} from './research-context.ts';
import {
  CIRCLE_FUNDED_MODEL,
  CIRCLE_FUNDED_WORK_ORDER_KEY,
  CIRCLE_FUNDED_WORK_ORDER_REVISION,
  CIRCLE_PROJECT_LEAD_ACTOR_ID,
  CIRCLE_PROJECT_SLUG,
  isApprovedCircleRevisionBinding,
  isApprovedCircleWorkPurpose,
} from '../funding/circle-work-authority.ts';

const PROJECT_SLUG = CIRCLE_PROJECT_SLUG;
const WORK_ORDER_KEY = CIRCLE_FUNDED_WORK_ORDER_KEY;
const MODEL = CIRCLE_FUNDED_MODEL;
export { CIRCLE_PROJECT_LEAD_ACTOR_ID };
const REFERENCE = '5.29109518547430697';
export const CIRCLE_REFERENCE_INPUT_PATH = '/opt/motive/inputs/reference-witness.json';
const CODEX_EXECUTABLE = '/usr/local/bin/codex';
const CIRCLE_CANDIDATE_COLLECTOR_DIGEST = 'sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a';
const CIRCLE_LEARNING_COLLECTOR_DIGEST = 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CircleProjectRunRuntime = {
  format: 'motive.circle-project-run-runtime/0.1';
  /** Public Motive gateway endpoint embedded in the reviewed Codex runtime. */
  gatewayUrl: string;
  inferenceProfileDigest: Digest;
  sandbox: SandboxExecutionProfile;
  /** A separately approved, finite infrastructure authorization on the attempt source. */
  infrastructureAuthorizationId: string;
  maximumCostUsd: DecimalAmount;
  capabilityTtlSeconds: number;
  /** Frozen before CREATE so the existing native collector can capture the candidate later. */
  nativeCollection: NonNullable<WorkerLaunchPlan['nativeCollection']>;
};

export type ProjectRunConfigurationReason =
  | 'RUNTIME_REQUIRED'
  | 'ARTIFACT_COLLECTOR_REQUIRED'
  | 'GATEWAY_UNREACHABLE'
  | 'RUNTIME_INVALID'
  | 'AUTHORITY_CLOSED'
  | 'INFRASTRUCTURE_AUTHORIZATION_REQUIRED'
  | 'RESEARCH_CONTEXT_REQUIRED'
  | 'RESEARCH_CONTEXT_UNAVAILABLE'
  | 'RESEARCH_CONTEXT_INVALID'
  | 'RESEARCH_SCOPE_CHANGED';

export type ProjectRunDispatchResult = Pick<ReconcileResult, 'attemptId' | 'status'> & {
  /** Present only when no provider effect was attempted. */
  reason?: ProjectRunConfigurationReason;
};

export type CircleProjectRunDispatcherOptions = {
  pool: Pool;
  ownerId: string;
  runtime?: CircleProjectRunRuntime;
  artifacts?: CoordinatorDependencies['artifacts'];
  sdk: SandboxSdkFactory;
  isActorActive(actorId: string): Promise<boolean>;
  researchContext?: ProjectRunResearchContextResolver;
  leaseSeconds?: number;
};

export type NativeCircleProjectRunDispatcherOptions = Omit<CircleProjectRunDispatcherOptions, 'sdk'> & {
  vercelCredentials: NativeVercelCredentials;
  fetch?: typeof globalThis.fetch;
};

type PlanResolution = { attempt: AttemptProjection; plan: WorkerLaunchPlan } | { attempt: AttemptProjection; reason: ProjectRunConfigurationReason };

function text(row: QueryResultRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Project run row is missing ${key}.`);
  return value;
}

function canonicalAmount(value: unknown): DecimalAmount | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const canonical = fraction.replace(/0+$/, '');
  const amount = canonical ? `${whole}.${canonical}` : whole;
  return amount !== '0' ? amount as DecimalAmount : null;
}

function gatewayIsPublicAndFrozen(runtime: CircleProjectRunRuntime): boolean {
  try {
    const url = new URL(runtime.gatewayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || url.hostname === 'localhost' || !url.hostname.includes('.') || isIP(url.hostname) !== 0) return false;
    return runtime.sandbox.egress.gateway.some(rule => rule.url === runtime.gatewayUrl
      && rule.pathMatch === 'exact' && rule.methods.length === 1 && rule.methods[0] === 'POST');
  } catch { return false; }
}

type CircleCollectionVersion = 'candidate-v1' | 'learning-v2';
function circleCollectionVersion(collection: CircleProjectRunRuntime['nativeCollection']): CircleCollectionVersion | null {
  const candidate = collection.approvedPaths[0];
  const exactCandidate = candidate?.relativePath === 'candidate.json' && candidate.mediaType === 'application/json'
    && candidate.availability === 'REQUIRED' && candidate.maximumBytes === 32 * 1024;
  if (!exactCandidate || collection.maximumFileBytes !== 32 * 1024
      || !/^sha256:[a-f0-9]{64}$/.test(collection.collectorRuntimeDigest)) return null;
  if (collection.collectorRuntimeDigest === CIRCLE_CANDIDATE_COLLECTOR_DIGEST
      && collection.maximumTotalBytes === 32 * 1024 && collection.approvedPaths.length === 1) return 'candidate-v1';
  const investigation = collection.approvedPaths[1];
  if (collection.collectorRuntimeDigest === CIRCLE_LEARNING_COLLECTOR_DIGEST
      && collection.maximumTotalBytes === 48 * 1024 && collection.approvedPaths.length === 2
      && investigation?.relativePath === 'investigation.json' && investigation.mediaType === 'application/json'
      && investigation.availability === 'OPTIONAL_ON_FAILURE' && investigation.maximumBytes === 16 * 1024) return 'learning-v2';
  return null;
}

function runtimeProblem(runtime: CircleProjectRunRuntime | undefined): ProjectRunConfigurationReason | null {
  if (!runtime) return 'RUNTIME_REQUIRED';
  try {
    validateProfile(runtime.sandbox);
    requireWorkerExecutionBoundary(runtime.sandbox);
  } catch { return 'RUNTIME_INVALID'; }
  if (!gatewayIsPublicAndFrozen(runtime)) return 'GATEWAY_UNREACHABLE';
  const collection = runtime.nativeCollection;
  if (runtime.format !== 'motive.circle-project-run-runtime/0.1'
      || !UUID.test(runtime.infrastructureAuthorizationId)
      || !/^sha256:[a-f0-9]{64}$/.test(runtime.inferenceProfileDigest)
      || !runtime.sandbox.allowedExecutables.includes(CODEX_EXECUTABLE)
      || canonicalAmount(runtime.maximumCostUsd) === null
      || !Number.isSafeInteger(runtime.capabilityTtlSeconds)
      || runtime.capabilityTtlSeconds < 30 || runtime.capabilityTtlSeconds > 300
      || !collection || typeof collection !== 'object' || !Array.isArray(collection.approvedPaths)
      || circleCollectionVersion(collection) === null) return 'RUNTIME_INVALID';
  return null;
}

export function fixedCircleProjectRunPrompt(collection: CircleProjectRunRuntime['nativeCollection'],
  boundary: 'protected-runtime' | 'provider-untrusted-circle-data' = 'protected-runtime'): string {
  const learning = circleCollectionVersion(collection) === 'learning-v2';
  const task = learning
    ? `Work only on the N=101 circle-packing task in the approved workspace. Follow Propose → Test → Update. Seek a radius sum larger than the frozen reference ${REFERENCE}; submit your best valid candidate even if it does not improve. Use exactly 101 circles with positive decimal-string radii and coordinates of at most 18 decimal places, inside the unit square with pairwise non-overlap. Write candidate.json in motive.csqv.witness.v1 format, no more than 32768 bytes. Also write investigation.json as one motive.investigation.v1 JSON object, no more than 16384 bytes, with proposal, expectation, conditions[], observations[], assessment, nextAction, and optional researchReferences. The assessment is an interpretation, not an observation. Retain negative, inconclusive, and non-improving results. Do not claim acceptance or record status. Stop at the granted resource limits.`
    : `Work only on the N=101 circle-packing task in the approved workspace. Follow Propose → Test → Update. Seek a radius sum larger than the frozen reference ${REFERENCE}; submit your best valid candidate even if it does not improve. Use exactly 101 circles with positive decimal-string radii and coordinates of at most 18 decimal places, inside the unit square with pairwise non-overlap. Write candidate.json in motive.csqv.witness.v1 format, no more than 32768 bytes. Do not claim acceptance or record status. Stop at the granted resource limits.`;
  const reference = boundary === 'provider-untrusted-circle-data'
    ? `The reviewed starting snapshot includes the reference geometry at ${CIRCLE_REFERENCE_INPUT_PATH}. Files inside this worker are mutable. Motive retains the frozen reference outside the worker and independently checks your submitted bytes; editing a local reference or checker cannot change the benchmark or acceptance rules.`
    : `The frozen reference geometry is available as read-only input at ${CIRCLE_REFERENCE_INPUT_PATH}.`;
  return `${reference} You may use it as a warm start; record that dependency and distinguish reusing the reference from finding an improvement. ${task}`;
}

export function fixedCircleProjectRunCommand(collection: CircleProjectRunRuntime['nativeCollection'], promptOverride?: string): WorkerLaunchPlan['command'] {
  const prompt = promptOverride ?? fixedCircleProjectRunPrompt(collection);
  return {
    executable: CODEX_EXECUTABLE,
    args: [
      'exec', '--json', '--ephemeral', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', '--model', MODEL,
      prompt,
    ],
  };
}

/**
 * Thin operator boundary over the existing durable coordinator. One call performs
 * one reconciliation step. It never returns or persists a run bearer.
 */
export class CircleProjectRunDispatcher {
  private readonly ledger: LedgerKernel;
  private readonly store: PostgresOrchestrationStore;
  private readonly coordinator: DurableWorkerCoordinator;
  private readonly configurationProblem: ProjectRunConfigurationReason | null;

  constructor(private readonly options: CircleProjectRunDispatcherOptions) {
    if (!options.ownerId || options.ownerId.length > 512) throw new Error('PROJECT_RUN_OWNER_INVALID');
    this.ledger = new LedgerKernel(options.pool);
    this.store = new PostgresOrchestrationStore(options.pool);
    this.configurationProblem = runtimeProblem(options.runtime)
      ?? (options.artifacts ? null : 'ARTIFACT_COLLECTOR_REQUIRED');
    const unavailableArtifacts: CoordinatorDependencies['artifacts'] = {
      async assertReady() { throw new Error('PROJECT_RUN_ARTIFACT_COLLECTOR_UNCONFIGURED'); },
      async seal() { throw new Error('PROJECT_RUN_ARTIFACT_COLLECTOR_UNCONFIGURED'); },
    };
    this.coordinator = new DurableWorkerCoordinator({
      store: this.store,
      ledger: this.ledger,
      ownerId: options.ownerId,
      ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
      resolvePlan: attempt => this.resolvePlan(attempt).then(result => 'plan' in result ? result.plan : null),
      adapter: profile => new VercelSandboxAdapter(profile, options.sdk, { effects: 'durable-controller' }),
      orphanProvider: new VercelOrphanProvider(options.sdk, 'durable-controller'),
      artifacts: options.artifacts ?? unavailableArtifacts,
    });
  }

  async reconcileBudget(budgetId: string): Promise<ProjectRunDispatchResult> {
    if (!UUID.test(budgetId)) throw new Error('PROJECT_RUN_BUDGET_INVALID');
    const activation = await this.options.pool.query(
      `SELECT activation.attempt_id FROM motive.provider_budget_activations activation
       JOIN motive.provider_project_budgets budget ON budget.id=activation.budget_id
       WHERE activation.budget_id=$1 AND activation.assigned_agent_id IS NULL
         AND activation.beneficiary_actor_id=$2 AND activation.attempt_id IS NOT NULL`,
      [budgetId, CIRCLE_PROJECT_LEAD_ACTOR_ID]);
    if (activation.rowCount !== 1) throw new Error('PROJECT_RUN_ACTIVATION_NOT_FOUND');
    const attemptId = text(activation.rows[0], 'attempt_id');
    const attempt = await this.ledger.getAttempt(attemptId);
    if (!attempt) throw new Error('PROJECT_RUN_ATTEMPT_NOT_FOUND');
    if (this.configurationProblem) {
      const execution = await this.store.getExecution(attemptId);
      if (!execution?.environments.some(environment => !['ABANDONED', 'TERMINATED'].includes(environment.state))) {
        return { attemptId, status: 'UNCONFIGURED', reason: this.configurationProblem };
      }
      const reconciled = await this.coordinator.reconcileAttempt(attemptId);
      return { ...reconciled, reason: this.configurationProblem };
    }
    const resolved = await this.resolvePlan(attempt);
    if (!('plan' in resolved)) {
      const execution = await this.store.getExecution(attemptId);
      if ((attempt.cancellationRequestedAt !== null || attempt.admissionClosedAt !== null) && !execution?.environments.length) {
        return { attemptId, status: 'TERMINATED', reason: resolved.reason };
      }
      const reconciled = await this.coordinator.reconcileAttempt(attemptId);
      return { ...reconciled, reason: resolved.reason };
    }
    return this.coordinator.reconcileAttempt(attemptId);
  }

  /** Resolves authority from the persisted activation; callers supply no budget, actor, or profile. */
  async reconcileAttempt(attemptId: string): Promise<ProjectRunDispatchResult> {
    if (!UUID.test(attemptId)) throw new Error('PROJECT_RUN_ATTEMPT_INVALID');
    const activation = await this.options.pool.query(
      `SELECT budget_id FROM motive.provider_budget_activations
       WHERE attempt_id=$1 AND assigned_agent_id IS NULL AND beneficiary_actor_id=$2`,
      [attemptId, CIRCLE_PROJECT_LEAD_ACTOR_ID],
    );
    if (activation.rowCount !== 1) throw new Error('PROJECT_RUN_ACTIVATION_NOT_FOUND');
    return this.reconcileBudget(text(activation.rows[0], 'budget_id'));
  }

  /** Reconciles only tracked circle project-lead workers; other runtimes retain their own cleanup authority. */
  async reconcileOrphans(): Promise<{ status: 'COMPLETE' | 'INCOMPLETE'; inspected: number; unresolved: number;
    truncated: boolean }> {
    const limit = 500;
    const candidates = await this.options.pool.query(
      `SELECT DISTINCT activation.attempt_id
       FROM motive.provider_budget_activations activation
       JOIN motive.work_orders work ON work.id=activation.work_order_id
       JOIN motive.projects project ON project.id=work.project_id
       JOIN motive.orchestration_environments environment ON environment.attempt_id=activation.attempt_id
       WHERE activation.assigned_agent_id IS NULL AND activation.beneficiary_actor_id=$1
         AND project.slug=$2 AND environment.kind='WORKER'
         AND environment.state NOT IN ('TERMINATED','ABANDONED')
       ORDER BY activation.attempt_id LIMIT $3`,
      [CIRCLE_PROJECT_LEAD_ACTOR_ID, PROJECT_SLUG, limit],
    );
    let failed = false;
    for (const row of candidates.rows) {
      try { await this.coordinator.reconcileAttempt(text(row, 'attempt_id')); }
      catch { failed = true; }
    }
    const remaining = await this.options.pool.query(
      `SELECT count(DISTINCT activation.attempt_id)::int AS count
       FROM motive.provider_budget_activations activation
       JOIN motive.work_orders work ON work.id=activation.work_order_id
       JOIN motive.projects project ON project.id=work.project_id
       JOIN motive.orchestration_environments environment ON environment.attempt_id=activation.attempt_id
       WHERE activation.assigned_agent_id IS NULL AND activation.beneficiary_actor_id=$1
         AND project.slug=$2 AND environment.kind='WORKER'
         AND environment.state NOT IN ('TERMINATED','ABANDONED')`,
      [CIRCLE_PROJECT_LEAD_ACTOR_ID, PROJECT_SLUG],
    );
    const unresolved = Number(remaining.rows[0]?.count ?? 0);
    const truncated = candidates.rowCount === limit;
    return { status: !failed && !truncated ? 'COMPLETE' : 'INCOMPLETE', inspected: candidates.rowCount ?? 0,
      unresolved, truncated };
  }

  private async resolvePlan(attempt: AttemptProjection): Promise<PlanResolution> {
    const runtime = this.options.runtime;
    if (this.configurationProblem || !runtime || !this.options.artifacts) {
      return { attempt, reason: this.configurationProblem ?? 'RUNTIME_REQUIRED' };
    }
    const result = await this.options.pool.query(
      `SELECT activation.status AS activation_status, activation.profile_digest AS activation_profile_digest,
         activation.beneficiary_actor_id, activation.budget_id, budget.status AS budget_status,
         budget.owner_actor_id, budget.source_id, budget.grant_id, budget.model_id, connection.status AS connection_status,
         funding_grant.status AS grant_status, work.work_order_key, work.revision AS work_revision,
         work.id AS work_order_id, work.project_revision, work.terms, work.terms_digest, work.created_by,
         state.state AS work_state, state.admission_closed_at AS work_admission_closed_at,
         project.slug, project.current_revision, project.visibility, revision.content_digest,
         infrastructure.status AS infrastructure_status, infrastructure.expires_at AS infrastructure_expires_at,
         infrastructure.source_account_id, infrastructure.limit_usd::text AS infrastructure_limit_usd,
         EXISTS (SELECT 1 FROM motive.memberships membership WHERE membership.project_id=project.id
           AND membership.actor_id=$3 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD')) AS lead_active
       FROM motive.provider_budget_activations activation
       JOIN motive.provider_project_budgets budget ON budget.id=activation.budget_id
       JOIN motive.provider_connections connection ON connection.id=budget.connection_id
       JOIN motive.grants funding_grant ON funding_grant.id=activation.grant_id
       JOIN motive.work_orders work ON work.id=activation.work_order_id
       JOIN motive.work_order_states state ON state.work_order_id=work.id
       JOIN motive.projects project ON project.id=work.project_id
       JOIN motive.project_revisions revision ON revision.project_id=project.id AND revision.revision=project.current_revision
       LEFT JOIN motive.infrastructure_authorizations infrastructure ON infrastructure.id=$2
       WHERE activation.attempt_id=$1`,
      [attempt.id, runtime.infrastructureAuthorizationId, CIRCLE_PROJECT_LEAD_ACTOR_ID]);
    if (result.rowCount !== 1) return { attempt, reason: 'AUTHORITY_CLOSED' };
    const row = result.rows[0];
    if (row.activation_status !== 'AWAITING_DISPATCH' || row.budget_status !== 'ACTIVE'
        || row.connection_status !== 'CONNECTED' || row.grant_status !== 'ACTIVE'
        || row.beneficiary_actor_id !== CIRCLE_PROJECT_LEAD_ACTOR_ID || row.created_by !== CIRCLE_PROJECT_LEAD_ACTOR_ID
        || row.slug !== PROJECT_SLUG || row.visibility !== 'PUBLIC'
        || row.work_order_key !== WORK_ORDER_KEY || Number(row.work_revision) !== CIRCLE_FUNDED_WORK_ORDER_REVISION
        || row.work_state !== 'READY' || row.work_admission_closed_at !== null
        || row.model_id !== MODEL || row.activation_profile_digest !== runtime.inferenceProfileDigest
        || row.source_id !== attempt.sourceId || row.grant_id !== attempt.grantId
        || row.work_order_id !== attempt.workOrderId || row.lead_active !== true
        || attempt.profileDigest !== runtime.inferenceProfileDigest
        || !await this.options.isActorActive(text(row, 'owner_actor_id'))) {
      return { attempt, reason: 'AUTHORITY_CLOSED' };
    }
    if (row.infrastructure_status !== 'ACTIVE' || row.source_account_id !== attempt.sourceId
        || !(row.infrastructure_expires_at instanceof Date) || row.infrastructure_expires_at.getTime() <= Date.now()
        || canonicalAmount(row.infrastructure_limit_usd) === null
        || new Decimal(runtime.maximumCostUsd).greaterThan(new Decimal(row.infrastructure_limit_usd))) {
      return { attempt, reason: 'INFRASTRUCTURE_AUTHORIZATION_REQUIRED' };
    }
    let terms;
    try { terms = validateWorkOrderTerms(row.terms); } catch { return { attempt, reason: 'AUTHORITY_CLOSED' }; }
    if (row.terms_digest !== attempt.termsDigest || digestCanonicalJson(terms) !== attempt.termsDigest
        || terms.project_id !== attempt.projectId
        || !isApprovedCircleRevisionBinding({
          currentProjectRevision: row.current_revision,
          workProjectRevision: row.project_revision,
          termsProjectRevision: terms.project_revision,
          contentDigest: row.content_digest,
        })
        || !isApprovedCircleWorkPurpose({ objective: terms.objective, allowedEffects: terms.allowed_effects })
        || terms.hosted.enabled !== true || terms.hosted.inference.profile_digest !== runtime.inferenceProfileDigest
        || runtime.sandbox.timeoutMs > terms.hosted.maximum_runtime_seconds * 1000
        || attempt.inputDigest !== digestCanonicalJson({ budgetId: text(row, 'budget_id'), beneficiaryActorId: CIRCLE_PROJECT_LEAD_ACTOR_ID, workOrderId: attempt.workOrderId})) {
      return { attempt, reason: 'AUTHORITY_CLOSED' };
    }
    const basePrompt = fixedCircleProjectRunPrompt(runtime.nativeCollection,
      requireWorkerExecutionBoundary(runtime.sandbox).kind);
    let command = fixedCircleProjectRunCommand(runtime.nativeCollection, basePrompt);
    if (circleCollectionVersion(runtime.nativeCollection) === 'learning-v2') {
      if (!this.options.researchContext) return { attempt, reason: 'RESEARCH_CONTEXT_REQUIRED' };
      try {
        const frozen = await this.options.researchContext.resolve(attempt, basePrompt);
        command = fixedCircleProjectRunCommand(runtime.nativeCollection, frozen.promptText);
      } catch (error) {
        if (!(error instanceof ProjectRunResearchContextError)) return { attempt, reason: 'RESEARCH_CONTEXT_UNAVAILABLE' };
        const reason: ProjectRunConfigurationReason = error.code === 'REQUIRED' ? 'RESEARCH_CONTEXT_REQUIRED'
          : error.code === 'UNAVAILABLE' ? 'RESEARCH_CONTEXT_UNAVAILABLE'
          : error.code === 'SCOPE_CHANGED' ? 'RESEARCH_SCOPE_CHANGED' : 'RESEARCH_CONTEXT_INVALID';
        return { attempt, reason };
      }
    }
    return { attempt, plan: {
      format: 'motive.worker-launch/0.1', workOrderId: attempt.workOrderId, termsDigest: attempt.termsDigest,
      inputDigest: attempt.inputDigest, inferenceProfileDigest: attempt.profileDigest, actorId: CIRCLE_PROJECT_LEAD_ACTOR_ID,
      sandbox: runtime.sandbox, infrastructureAuthorizationId: runtime.infrastructureAuthorizationId,
      maximumCostUsd: runtime.maximumCostUsd, capabilityTtlSeconds: runtime.capabilityTtlSeconds,
      command, nativeCollection: runtime.nativeCollection,
    } };
  }
}

/** Production composition uses the repository's single-attempt Vercel SDK boundary. */
export function createNativeCircleProjectRunDispatcher(options: NativeCircleProjectRunDispatcherOptions): CircleProjectRunDispatcher {
  const { vercelCredentials, fetch, ...dispatcher } = options;
  return new CircleProjectRunDispatcher({ ...dispatcher,
    sdk: createNativeVercelSdkFactory(vercelCredentials, fetch ?? globalThis.fetch) });
}
