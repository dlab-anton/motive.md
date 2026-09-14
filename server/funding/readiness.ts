import type { Pool, QueryResultRow } from 'pg';
import { digestCanonicalJson, validateWorkOrderTerms } from '../../packages/domain/src/contracts.ts';
import { profileDigest, type GatewayProfile } from '../../packages/inference-gateway/src/profile.ts';
import type { FundedRunReadinessBlocker, FundedRunReadinessResponse, FundedWorkOrder } from '../../src/lib/funding.ts';
import {
  CIRCLE_FUNDED_MODEL,
  CIRCLE_FUNDED_WORK_ORDER_KEY,
  CIRCLE_FUNDED_WORK_ORDER_REVISION,
  CIRCLE_PROJECT_LEAD_ACTOR_ID,
  CIRCLE_PROJECT_SLUG,
  isApprovedCircleRevisionBinding,
  isApprovedCircleWorkPurpose,
  positiveProjectRevision,
} from './circle-work-authority.ts';

function text(row: QueryResultRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Funding readiness row is missing ${key}.`);
  return value;
}

export async function readCircleFundingReadiness(
  pool: Pool,
  actorId: string,
  profiles: readonly Readonly<GatewayProfile>[],
): Promise<FundedRunReadinessResponse> {
  const [projectResult, controllerResult, connectionResult, budgetResult, orderResult] = await Promise.all([
    pool.query('SELECT id, current_revision FROM motive.projects WHERE slug=$1 AND visibility=\'PUBLIC\'', [CIRCLE_PROJECT_SLUG]),
    pool.query('SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE'),
    pool.query("SELECT 1 FROM motive.provider_connections WHERE owner_actor_id=$1 AND provider='openrouter' AND status='CONNECTED'", [actorId]),
    pool.query("SELECT 1 FROM motive.provider_project_budgets budget JOIN motive.projects project ON project.id=budget.project_id WHERE budget.owner_actor_id=$1 AND project.slug='circle-packing' AND budget.status<>'REVOKED' LIMIT 1", [actorId]),
    pool.query(
      `SELECT work.id, work.project_revision, work.revision AS work_revision, work.work_order_key, work.created_by,
         work.terms, work.terms_digest, project.id AS project_id, project.current_revision, revision.content_digest,
         EXISTS (SELECT 1 FROM motive.memberships membership WHERE membership.project_id=project.id
           AND membership.actor_id=$1 AND membership.revoked_at IS NULL
           AND membership.role IN ('OWNER','STEWARD')) AS project_lead_active
       FROM motive.work_orders work JOIN motive.work_order_states state ON state.work_order_id=work.id
       JOIN motive.projects project ON project.id=work.project_id
       JOIN motive.project_revisions revision ON revision.project_id=project.id AND revision.revision=project.current_revision
       WHERE project.slug=$2 AND project.visibility='PUBLIC' AND work.project_revision=project.current_revision
         AND state.state='READY' AND state.admission_closed_at IS NULL ORDER BY work.created_at, work.id`,
      [CIRCLE_PROJECT_LEAD_ACTOR_ID, CIRCLE_PROJECT_SLUG]),
  ]);
  if (projectResult.rowCount !== 1) throw new Error('The public circle-packing project is missing.');
  const projectRevision = positiveProjectRevision(projectResult.rows[0].current_revision);
  if (projectRevision === null) throw new Error('The public circle-packing project has an invalid current revision.');
  const reviewedByDigest = new Map(profiles.map(profile => [profileDigest(profile), profile]));
  const workOrders: FundedWorkOrder[] = [];
  for (const row of orderResult.rows) {
    let terms;
    try { terms = validateWorkOrderTerms(row.terms); } catch { continue; }
    if (!terms.hosted.enabled || terms.project_id !== text(row, 'project_id')
        || positiveProjectRevision(row.current_revision) !== projectRevision
        || row.terms_digest !== digestCanonicalJson(terms)
        || !isApprovedCircleRevisionBinding({
          currentProjectRevision: row.current_revision,
          workProjectRevision: row.project_revision,
          termsProjectRevision: terms.project_revision,
          contentDigest: row.content_digest,
        })) continue;
    const profile = reviewedByDigest.get(terms.hosted.inference.profile_digest);
    if (!profile || profile.status !== 'reviewed-live' || profile.evidence.kind !== 'gate-a-reviewed') continue;
    workOrders.push({
      id: text(row, 'id'), project: CIRCLE_PROJECT_SLUG, projectRevision, model: profile.route.model,
      profileDigest: terms.hosted.inference.profile_digest, ceilingUsd: terms.hosted.inference.ceiling,
      maxRuntimeSeconds: terms.hosted.maximum_runtime_seconds, objective: terms.objective,
      projectLeadEligible: profile.route.model === CIRCLE_FUNDED_MODEL
        && row.work_order_key === CIRCLE_FUNDED_WORK_ORDER_KEY
        && Number(row.work_revision) === CIRCLE_FUNDED_WORK_ORDER_REVISION
        && row.created_by === CIRCLE_PROJECT_LEAD_ACTOR_ID && row.project_lead_active === true
        && isApprovedCircleWorkPurpose({ objective: terms.objective, allowedEffects: terms.allowed_effects }),
    });
  }
  const blockers: FundedRunReadinessBlocker[] = [];
  if (connectionResult.rowCount !== 1) blockers.push('CONNECTION_REQUIRED');
  if (budgetResult.rowCount !== 1) blockers.push('BUDGET_REQUIRED');
  if (profiles.length === 0) blockers.push('PROFILE_REQUIRED');
  if (workOrders.length === 0) blockers.push('WORK_ORDER_REQUIRED');
  const spendingEnabled = controllerResult.rows[0]?.spending_enabled === true;
  if (!spendingEnabled) blockers.push('CONTROLLER_CLOSED');
  return { project: CIRCLE_PROJECT_SLUG, projectRevision, controllerSpendingEnabled: spendingEnabled, workOrders, blockers };
}
