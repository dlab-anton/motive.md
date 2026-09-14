import Decimal from 'decimal.js';
import type { Pool, QueryResultRow } from 'pg';
import type {
  ProjectRunDonorReceipt,
  ProjectRunState,
  PublicCircleProjectUsage,
  PublicProjectRun,
  PublicProjectRuns,
} from '../../src/lib/project-runs.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES: readonly ProjectRunState[] = ['queued', 'running', 'stopping', 'checking', 'awaiting-review',
  'finished', 'cancelled', 'failed', 'unresolved'];

export class ProjectRunProjectionError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'NOT_FOUND', message: string, readonly status: number) {
    super(message); this.name = 'ProjectRunProjectionError';
  }
}

export type ProjectRunStateFacts = {
  attemptStatus: string;
  cancellationRequested: boolean;
  workerState: string | null;
  commandAcknowledged: boolean;
  stopPending: boolean;
  effectUnknown: boolean;
  sealStatus: string | null;
  resultId: string | null;
  reviewId: string | null;
};

/** Maps durable facts only. Queue reservation or activation never implies execution. */
export function deriveProjectRunState(facts: ProjectRunStateFacts): ProjectRunState {
  const liveWorker = facts.workerState !== null && !['TERMINATED', 'ABANDONED'].includes(facts.workerState);
  const terminalWorker = !liveWorker;
  if (facts.workerState === 'UNKNOWN' || facts.workerState === 'ORPHANED' || facts.effectUnknown) return 'unresolved';
  if (facts.workerState === 'STOP_REQUESTED' || facts.stopPending || (facts.cancellationRequested && liveWorker)) return 'stopping';
  if (facts.workerState === 'ACTIVE' && facts.commandAcknowledged) return 'running';
  if (facts.resultId !== null) return terminalWorker
    ? (facts.reviewId === null ? 'awaiting-review' : 'finished') : 'unresolved';
  if (facts.sealStatus === 'SEALED' && terminalWorker) return 'checking';
  if ((facts.cancellationRequested || ['CANCEL_REQUESTED', 'CANCELLED'].includes(facts.attemptStatus)) && terminalWorker) return 'cancelled';
  if ((facts.sealStatus === 'FAILED' || ['FAILED', 'QUARANTINED'].includes(facts.attemptStatus)) && terminalWorker) return 'failed';
  return 'queued';
}

function text(row: QueryResultRow, key: string): string {
  if (typeof row[key] !== 'string') throw new Error(`Project run field ${key} is invalid.`);
  return row[key] as string;
}
function nullableText(row: QueryResultRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Project run timestamp is invalid.');
  return date.toISOString();
}
function amount(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Project run amount is invalid.');
  return new Decimal(value).toFixed(12).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function count(row: QueryResultRow, key: string): number {
  const value = Number(text(row, key));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Project usage field ${key} is invalid.`);
  return value;
}
function stateFacts(row: QueryResultRow): ProjectRunStateFacts {
  return {
    attemptStatus: text(row, 'attempt_status'), cancellationRequested: row.cancellation_requested_at !== null,
    workerState: nullableText(row, 'worker_state'), commandAcknowledged: row.command_acknowledged === true,
    stopPending: row.stop_pending === true, effectUnknown: row.effect_unknown === true,
    sealStatus: nullableText(row, 'seal_status'), resultId: nullableText(row, 'result_id'), reviewId: nullableText(row, 'review_id'),
  };
}
function result(row: QueryResultRow): PublicProjectRun['result'] {
  const id = nullableText(row, 'result_id'); if (!id) return null;
  const status = text(row, 'result_status');
  if (status !== 'VALID' && status !== 'REJECTED') throw new Error('Project result status is invalid.');
  const reviewId = nullableText(row, 'review_id'); const decision = nullableText(row, 'review_decision');
  if ((reviewId === null) !== (decision === null) || (decision !== null && decision !== 'ACCEPTED' && decision !== 'REJECTED')) {
    throw new Error('Project review state is invalid.');
  }
  return { id, status, exactScore: nullableText(row, 'exact_score'),
    review: reviewId ? { id: reviewId, decision: decision as 'ACCEPTED' | 'REJECTED' } : null };
}
function publicRun(row: QueryResultRow): PublicProjectRun {
  return { attemptId: text(row, 'attempt_id'), model: text(row, 'model_id'), state: deriveProjectRunState(stateFacts(row)),
    createdAt: timestamp(row.attempt_created_at)!, startedAt: timestamp(row.command_started_at),
    endedAt: timestamp(row.worker_terminated_at), result: result(row) };
}

const RUN_SELECT = `SELECT attempt.id AS attempt_id, attempt.execution_status::text AS attempt_status,
  attempt.cancellation_requested_at, attempt.created_at AS attempt_created_at, budget.model_id,
  worker.state::text AS worker_state, worker.terminated_at AS worker_terminated_at,
  command.created_at AS command_started_at,
  (command.effect_id IS NOT NULL AND command_effect.state='RESULT_RECORDED') AS command_acknowledged,
  EXISTS (SELECT 1 FROM motive.orchestration_effects stop_effect WHERE stop_effect.attempt_id=attempt.id
    AND stop_effect.kind='STOP' AND stop_effect.state IN ('INTENT_RECORDED','CLAIMED')) AS stop_pending,
  EXISTS (SELECT 1 FROM motive.orchestration_effects unknown_effect WHERE unknown_effect.attempt_id=attempt.id
    AND unknown_effect.state='UNKNOWN') AS effect_unknown,
  seal.status::text AS seal_status, result.id AS result_id, result.status::text AS result_status,
  result.exact_score, review.id AS review_id, review.decision::text AS review_decision,
  attempt.consumed_amount::text AS inference_consumed, attempt.request_held_amount::text AS inference_held,
  attempt.closed_at,
  COALESCE(operation.unknown_exposure,0)::text AS unknown_exposure,
  operation.actual_cost::text AS provider_actual_cost,
  compute.actual_cost::text AS compute_actual_cost
 FROM motive.attempts attempt
 JOIN motive.provider_budget_activations activation ON activation.attempt_id=attempt.id
 JOIN motive.provider_project_budgets budget ON budget.id=activation.budget_id
 JOIN motive.projects project ON project.id=attempt.project_id
 LEFT JOIN LATERAL (SELECT environment.* FROM motive.orchestration_environments environment
   WHERE environment.attempt_id=attempt.id AND environment.kind='WORKER'
   ORDER BY environment.lease_epoch DESC, environment.created_at DESC LIMIT 1) worker ON TRUE
 LEFT JOIN motive.orchestration_effects command_effect ON command_effect.environment_id=worker.id AND command_effect.kind='COMMAND'
 LEFT JOIN motive.orchestration_commands command ON command.effect_id=command_effect.id
 LEFT JOIN motive.orchestration_artifact_seals seal ON seal.attempt_id=attempt.id
 LEFT JOIN motive.hosted_circle_results result ON result.attempt_id=attempt.id
 LEFT JOIN motive.hosted_circle_result_reviews review ON review.result_id=result.id
 LEFT JOIN LATERAL (SELECT
   SUM(reservation.held_amount) FILTER (WHERE request.status='UNKNOWN') AS unknown_exposure,
   CASE WHEN COUNT(*) > 0 AND BOOL_AND(request.status IN ('RECONCILED','INCIDENT') AND request.actual_cost IS NOT NULL)
     THEN SUM(request.actual_cost) END AS actual_cost
   FROM motive.request_operations request
   LEFT JOIN motive.reservations reservation ON reservation.operation_id=request.provider_operation_id
   WHERE request.attempt_id=attempt.id) operation ON TRUE
 LEFT JOIN LATERAL (SELECT CASE WHEN COUNT(*) > 0 AND BOOL_AND(incurred.has_final)
   THEN SUM(incurred.total_cost) END AS actual_cost
   FROM (SELECT environment.id, COALESCE(SUM(usage.amount_usd),0) AS total_cost,
       COALESCE(BOOL_OR(usage.authoritative_final),false) AS has_final
     FROM motive.orchestration_environments environment
     LEFT JOIN motive.infrastructure_usage_records usage ON usage.environment_id=environment.id
     WHERE environment.attempt_id=attempt.id AND environment.provider IS NOT NULL
     GROUP BY environment.id) incurred) compute ON TRUE`;

export class ProjectRunProjectionService {
  constructor(private readonly pool: Pool, private readonly isActorActive?: (actorId: string) => Promise<boolean>) {}

  async publicCircleRuns(limit = 20): Promise<PublicProjectRuns> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ProjectRunProjectionError('INVALID_REQUEST', 'Run limit must be an integer from 1 to 50.', 400);
    }
    const project = await this.pool.query("SELECT 1 FROM motive.projects WHERE slug='circle-packing' AND visibility='PUBLIC'");
    if (project.rowCount !== 1) throw new ProjectRunProjectionError('NOT_FOUND', 'The public circle-packing project was not found.', 404);
    const rows = await this.pool.query(`${RUN_SELECT}
      WHERE project.slug='circle-packing' AND project.visibility='PUBLIC'
      ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT $1`, [limit]);
    const counts = Object.fromEntries(STATES.map(state => [state, 0])) as Record<ProjectRunState, number>;
    const all = await this.pool.query(`${RUN_SELECT}
      WHERE project.slug='circle-packing' AND project.visibility='PUBLIC'`);
    for (const row of all.rows) counts[deriveProjectRunState(stateFacts(row))] += 1;
    return { project: 'circle-packing', totalRuns: all.rowCount ?? all.rows.length, stateCounts: counts,
      runs: rows.rows.map(publicRun) };
  }

  async publicCircleUsage(): Promise<PublicCircleProjectUsage> {
    const result = await this.pool.query(`WITH public_project AS (
        SELECT id FROM motive.projects WHERE slug='circle-packing' AND visibility='PUBLIC'
      ), scoped AS (
        SELECT request.status::text AS status,
          CASE WHEN jsonb_typeof(request.raw_provider_usage#>'{usage,inputTokens}')='number'
            AND request.raw_provider_usage#>>'{usage,inputTokens}' ~ '^(0|[1-9][0-9]*)$'
            THEN (request.raw_provider_usage#>>'{usage,inputTokens}')::numeric END AS input_tokens,
          CASE WHEN jsonb_typeof(request.raw_provider_usage#>'{usage,outputTokens}')='number'
            AND request.raw_provider_usage#>>'{usage,outputTokens}' ~ '^(0|[1-9][0-9]*)$'
            THEN (request.raw_provider_usage#>>'{usage,outputTokens}')::numeric END AS output_tokens,
          CASE WHEN jsonb_typeof(request.raw_provider_usage#>'{usage,totalTokens}')='number'
            AND request.raw_provider_usage#>>'{usage,totalTokens}' ~ '^(0|[1-9][0-9]*)$'
            THEN (request.raw_provider_usage#>>'{usage,totalTokens}')::numeric END AS direct_total_tokens
        FROM motive.request_operations request JOIN motive.attempts attempt ON attempt.id=request.attempt_id
        JOIN public_project project ON project.id=attempt.project_id
      ), tokens AS (
        SELECT status,input_tokens,output_tokens,
          CASE
            WHEN direct_total_tokens IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
              AND direct_total_tokens<>input_tokens+output_tokens THEN NULL
            ELSE COALESCE(direct_total_tokens,CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL
              THEN input_tokens+output_tokens END)
          END AS total_tokens
        FROM scoped
      ) SELECT
        EXISTS(SELECT 1 FROM public_project) AS project_exists,
        COUNT(*)::text AS gateway_requests,
        COUNT(*) FILTER (WHERE status IN ('RECONCILED','INCIDENT'))::text AS settled_requests,
        COUNT(*) FILTER (WHERE status NOT IN ('RECONCILED','INCIDENT'))::text AS unresolved_requests,
        COUNT(*) FILTER (WHERE status IN ('RECONCILED','INCIDENT') AND total_tokens IS NOT NULL)::text AS with_tokens,
        COUNT(*) FILTER (WHERE status IN ('RECONCILED','INCIDENT') AND total_tokens IS NULL)::text AS without_tokens,
        COALESCE(SUM(input_tokens) FILTER (WHERE status IN ('RECONCILED','INCIDENT')),0)::text AS input_tokens,
        COALESCE(SUM(output_tokens) FILTER (WHERE status IN ('RECONCILED','INCIDENT')),0)::text AS output_tokens,
        COALESCE(SUM(total_tokens) FILTER (WHERE status IN ('RECONCILED','INCIDENT')),0)::text AS total_tokens,
        COUNT(*) FILTER (WHERE status IN ('RECONCILED','INCIDENT') AND input_tokens IS NULL)::text AS without_input_tokens,
        COUNT(*) FILTER (WHERE status IN ('RECONCILED','INCIDENT') AND output_tokens IS NULL)::text AS without_output_tokens,
        (SELECT COUNT(*)::text FROM motive.participation_submission_artifacts artifact
          WHERE artifact.project_id=(SELECT id FROM public_project)) AS external_submissions
      FROM tokens`);
    const row = result.rows[0];
    if (row?.project_exists !== true) throw new ProjectRunProjectionError('NOT_FOUND', 'The public circle-packing project was not found.', 404);
    const unresolvedRequests = count(row, 'unresolved_requests');
    const requestsWithoutTokenCounts = count(row, 'without_tokens');
    const inputBreakdownComplete = unresolvedRequests === 0 && count(row, 'without_input_tokens') === 0;
    const outputBreakdownComplete = unresolvedRequests === 0 && count(row, 'without_output_tokens') === 0;
    return { project: 'circle-packing', hostedGateway: {
      gatewayRequests: count(row, 'gateway_requests'), settledRequests: count(row, 'settled_requests'),
      unresolvedRequests, requestsWithTokenCounts: count(row, 'with_tokens'), requestsWithoutTokenCounts,
      recordedInputTokens: text(row, 'input_tokens'), recordedOutputTokens: text(row, 'output_tokens'),
      recordedTotalTokens: text(row, 'total_tokens'), inputBreakdownComplete, outputBreakdownComplete,
      complete: unresolvedRequests === 0 && requestsWithoutTokenCounts === 0,
    }, externalAgents: { submissions: count(row, 'external_submissions'), tokenUsage: 'NOT_RECORDED_BY_MOTIVE' },
    projectTokenLimit: { status: 'NOT_CONFIGURED', totalTokens: null } };
  }

  async donorReceipt(actorId: string, budgetId: string): Promise<ProjectRunDonorReceipt | null> {
    if (!UUID.test(budgetId) || !actorId.startsWith('account:')) {
      throw new ProjectRunProjectionError('INVALID_REQUEST', 'Funding receipt identity is invalid.', 400);
    }
    if (!this.isActorActive || !await this.isActorActive(actorId)) {
      throw new ProjectRunProjectionError('NOT_FOUND', 'Funding run receipt was not found.', 404);
    }
    return this.readOwnedReceipt(actorId, budgetId);
  }

  private async readOwnedReceipt(actorId: string, budgetId: string): Promise<ProjectRunDonorReceipt | null> {
    const owned = await this.pool.query(`SELECT activation.attempt_id FROM motive.provider_project_budgets budget
      LEFT JOIN motive.provider_budget_activations activation ON activation.budget_id=budget.id
      WHERE budget.id=$1 AND budget.owner_actor_id=$2`, [budgetId, actorId]);
    if (owned.rowCount !== 1) throw new ProjectRunProjectionError('NOT_FOUND', 'Funding run receipt was not found.', 404);
    if (owned.rows[0].attempt_id === null) return null;
    const found = await this.pool.query(`${RUN_SELECT}
      WHERE budget.id=$1 AND budget.owner_actor_id=$2 AND project.visibility='PUBLIC'`, [budgetId, actorId]);
    if (found.rowCount !== 1) throw new ProjectRunProjectionError('NOT_FOUND', 'Funding run receipt was not found.', 404);
    const row = found.rows[0];
    return { ...publicRun(row), inference: { consumedUsd: amount(row.inference_consumed), heldUsd: amount(row.inference_held),
      unresolvedExposureUsd: amount(row.unknown_exposure), providerActualCostUsd: row.provider_actual_cost === null ? null : amount(row.provider_actual_cost) },
      compute: { actualCostUsd: row.compute_actual_cost === null ? null : amount(row.compute_actual_cost) },
      attemptClosed: row.closed_at !== null && text(row, 'attempt_status') === 'CLOSED' };
  }

  async donorReceipts(actorId: string, budgetIds: readonly string[]): Promise<Map<string, ProjectRunDonorReceipt | null>> {
    if (!this.isActorActive || !await this.isActorActive(actorId)) {
      throw new ProjectRunProjectionError('NOT_FOUND', 'Funding run receipts were not found.', 404);
    }
    const result = new Map<string, ProjectRunDonorReceipt | null>();
    await Promise.all(budgetIds.map(async id => { result.set(id, await this.readOwnedReceipt(actorId, id)); }));
    return result;
  }
}
