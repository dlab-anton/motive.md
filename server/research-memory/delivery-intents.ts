import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { currentPolicyApprover, currentPolicyAuthority, policyIdFromPrincipal } from './delivery-policy-authority.ts';
import type { ResearchDeliveryMode } from '../../src/lib/research-delivery-policy.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9._~-]{8,200}$/;
const ACCOUNT = /^account:[A-Za-z0-9._~-]{1,480}$/;
const ACTION = 'research.hypothesis-writeback.prepare';

type JsonObject = Record<string, unknown>;
export type PrepareDeliveryIntentInput = {
  projectSlug: string;
  scopeId: string;
  submissionId: string;
  idempotencyKey: string;
};
export type PreparedDeliveryIntent = {
  id: string;
  state: 'ENGINE_WRITE_UNAVAILABLE';
  disposition: 'PROPOSED_UNREVIEWED';
  requestDigest: string;
  payloadDigest: string;
  payload: JsonObject;
  createdAt: string;
  replayed: boolean;
};
type Options = { pool: Pool; isActorActive(actorId: string): boolean | Promise<boolean> };
type Normalized = PrepareDeliveryIntentInput;

export class DeliveryIntentError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409,
  ) { super(message); this.name = 'DeliveryIntentError'; }
}

function text(row: QueryResultRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${name}.`);
  return value;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid stored optional text.');
  return value;
}
function dateText(value: unknown): string {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid stored timestamp.');
  return result.toISOString();
}
function normalize(input: PrepareDeliveryIntentInput): Normalized {
  if (!input || typeof input !== 'object'
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['idempotencyKey', 'projectSlug', 'scopeId', 'submissionId'])
    || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.projectSlug)
    || !UUID.test(input.scopeId) || !UUID.test(input.submissionId) || !KEY.test(input.idempotencyKey)) {
    throw new DeliveryIntentError('VALIDATION', 'Writeback preparation input is invalid.', 400);
  }
  return { ...input, scopeId: input.scopeId.toLowerCase(), submissionId: input.submissionId.toLowerCase() };
}
function projection(row: QueryResultRow, replayed: boolean): PreparedDeliveryIntent {
  return {
    id: text(row, 'id'), state: 'ENGINE_WRITE_UNAVAILABLE', disposition: 'PROPOSED_UNREVIEWED',
    requestDigest: text(row, 'request_digest'), payloadDigest: text(row, 'payload_digest'),
    payload: row.payload as JsonObject, createdAt: dateText(row.created_at), replayed,
  };
}

export class HypothesisDeliveryIntentService {
  constructor(private readonly options: Options) {}

  async prepare(actorId: string, raw: PrepareDeliveryIntentInput): Promise<PreparedDeliveryIntent> {
    return this.preparePrincipal(actorId, raw, false);
  }

  /** Internal review preparation only. It grants no engine execution authority. */
  async prepareForReview(actorId: string, raw: PrepareDeliveryIntentInput): Promise<PreparedDeliveryIntent> {
    return this.preparePrincipal(actorId, raw, true);
  }

  private async preparePrincipal(actorId: string, raw: PrepareDeliveryIntentInput, reviewPreparation: boolean): Promise<PreparedDeliveryIntent> {
    const policyId = policyIdFromPrincipal(actorId);
    if ((reviewPreparation && !ACCOUNT.test(actorId)) || (!reviewPreparation && !ACCOUNT.test(actorId) && !policyId)
      || (ACCOUNT.test(actorId) && !await this.options.isActorActive(actorId))) {
      throw new DeliveryIntentError('UNAUTHORIZED', 'A current active account is required.', 401);
    }
    const input = normalize(raw);
    if(policyId){const approver=await currentPolicyApprover(this.options.pool,policyId);
      if(!approver||!await this.options.isActorActive(approver))throw new DeliveryIntentError('FORBIDDEN','Current research delivery policy authority is unavailable.',403);}
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      let projectId: string;let authorityMode:ResearchDeliveryMode|null=null;
      if (policyId) {
        const authority = await currentPolicyAuthority(client, policyId, input);
        if (!authority) {
          throw new DeliveryIntentError('FORBIDDEN', 'Current research delivery policy authority is unavailable.', 403);
        }
        projectId = authority.projectId;authorityMode=authority.deliveryMode;
      } else {
        const roles = reviewPreparation ? "('OWNER','STEWARD','REVIEWER')" : "('OWNER','STEWARD')";
        const project = await client.query(`SELECT project.id FROM motive.projects project
          JOIN motive.memberships membership ON membership.project_id=project.id
          WHERE project.slug=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
            AND membership.role IN ${roles} FOR KEY SHARE OF project,membership`, [input.projectSlug, actorId]);
        if (project.rowCount !== 1) throw new DeliveryIntentError('FORBIDDEN', reviewPreparation
          ? 'A current project reviewer, owner, or steward is required for review preparation.'
          : 'A current project owner or steward is required.', 403);
        projectId = text(project.rows[0], 'id');
      }

      // Preserve the historical no-target replay path before consulting mutable
      // scope state. Target-aware digests are resolved below from their claim row.
      const legacyRequestDigest=digestCanonicalJson({projectSlug:input.projectSlug,scopeId:input.scopeId,submissionId:input.submissionId});
      const legacyPrior=await this.intentForUpdate(client,actorId,input.idempotencyKey);
      if(legacyPrior&&text(legacyPrior,'request_digest')===legacyRequestDigest&&text(legacyPrior,'project_id')===projectId){
        await client.query('COMMIT');return projection(legacyPrior,true);
      }

      const source = await client.query(`SELECT scope.id AS scope_id,scope.channel_id,scope.channel_name,
          scope.channel_snapshot_digest,scope.configuration_digest,scope.api_version,scope.inspected_source_revision,
          submission.id AS submission_id,submission.operator_actor_id,submission.work_order_revision,
          submission.claim_id,submission.lease_epoch,submission.format AS submission_format,submission.base_commit,
          submission.artifact_manifest_digest,submission.provenance,submission.license_acceptance_ref,
          submission.created_at AS submission_created_at,work.id AS work_order_id,work.project_revision,
          work.terms_digest,claim.origin AS claim_origin,claim.status AS claim_status,claim.created_at AS claim_created_at,
          artifact.witness_format,artifact.witness_bytes,artifact.witness_digest,artifact.report AS report_status,
          artifact.report_body,artifact.report_digest,artifact.exact_score,artifact.exceeds_reference,
          token.id AS agent_token_id,token.owner_actor_id,token.agent_name,token.model_name,
          review.decision AS review_decision,review.reviewer_actor_id,review.rationale AS review_rationale,
          review.created_at AS review_created_at,target.binding AS target_binding,target.binding_digest AS target_binding_digest
        FROM motive.project_research_scopes scope
        JOIN motive.submissions submission ON submission.id=$3 AND submission.project_id=scope.project_id
        JOIN motive.work_orders work ON work.id=submission.work_order_id AND work.project_id=submission.project_id
        JOIN motive.work_claims claim ON claim.id=submission.claim_id AND claim.work_order_id=submission.work_order_id
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          AND artifact.project_id=submission.project_id
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
          AND token.project_id=submission.project_id
        LEFT JOIN motive.participation_submission_reviews review ON review.submission_id=submission.id
        LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=submission.claim_id
          AND target.project_id=submission.project_id
        WHERE scope.id=$1 AND scope.project_id=$2 AND scope.status='CONNECTED' AND submission.origin='EXTERNAL'
          AND submission.attempt_id IS NULL AND submission.operator_actor_id=claim.operator_actor_id
          AND submission.operator_actor_id=('agent:' || token.id::text)
          AND submission.lease_epoch=claim.lease_epoch AND submission.work_order_revision=work.revision
        FOR KEY SHARE OF scope,submission,work,claim,artifact,token`, [input.scopeId, projectId, input.submissionId]);
      if (source.rowCount !== 1) throw new DeliveryIntentError('NOT_FOUND', 'Connected scope and immutable participation submission were not found for this project.', 404);
      const row = source.rows[0]; const engineActor = `motive:project:${projectId}`;
      const targetBinding=row.target_binding===null?null:row.target_binding as JsonObject;
      const deliveryMode:ResearchDeliveryMode=targetBinding?'APPEND_EXISTING':'NEW_DRAFT';
      if(authorityMode&&authorityMode!==deliveryMode)throw new DeliveryIntentError('FORBIDDEN','Research delivery policy does not authorize the declared target mode.',403);
      if(targetBinding&&(targetBinding.format!=='motive.research-delivery-target/0.1'
        ||targetBinding.scopeConfigurationDigest!==row.configuration_digest
        ||(targetBinding.selection as JsonObject|undefined)?.scopeId!==input.scopeId
        ||digestCanonicalJson(targetBinding)!==row.target_binding_digest))
        throw new DeliveryIntentError('CONFLICT','Immutable research delivery target binding is invalid.',409);
      const request=targetBinding
        ?{projectSlug:input.projectSlug,scopeId:input.scopeId,submissionId:input.submissionId,researchDeliveryTarget:targetBinding}
        :{projectSlug:input.projectSlug,scopeId:input.scopeId,submissionId:input.submissionId};
      const requestDigest=digestCanonicalJson(request);
      const prior = await this.intentForUpdate(client, actorId, input.idempotencyKey);
      if (prior) {
        if (text(prior, 'request_digest') !== requestDigest || text(prior, 'project_id') !== projectId) {
          throw new DeliveryIntentError('CONFLICT', 'Idempotency-Key is already bound to another preparation request.', 409);
        }
        await client.query('COMMIT');
        return projection(prior, true);
      }
      const provenance = row.provenance as JsonObject;
      const localReview = row.review_decision === null ? null : {
        decision: text(row, 'review_decision'), reviewerActor: text(row, 'reviewer_actor_id'),
        rationale: text(row, 'review_rationale'), createdAt: dateText(row.review_created_at),
      };
      const payload: JsonObject = {
        format: 'motive.hypothesis-writeback-preparation/0.1', state: 'ENGINE_WRITE_UNAVAILABLE',
        disposition: 'PROPOSED_UNREVIEWED',
        assessment: { hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED' },
        scope: { projectId, scopeId: text(row, 'scope_id'), channelId: text(row, 'channel_id'),
          channelName: text(row, 'channel_name'), channelSnapshotDigest: text(row, 'channel_snapshot_digest'),
          configurationDigest: text(row, 'configuration_digest'), apiVersion: text(row, 'api_version'),
          inspectedSourceRevision: text(row, 'inspected_source_revision') },
        attribution: { engineActor, preparedBy: actorId, originalContributor: text(row, 'owner_actor_id'),
          submissionActor: text(row, 'operator_actor_id'), agentTokenId: text(row, 'agent_token_id'),
          agentName: text(row, 'agent_name'), modelName: nullableText(row.model_name) },
        ...(targetBinding?{researchDeliveryTarget:targetBinding}:{}),
        source: {
          submission: { id: text(row, 'submission_id'), format: text(row, 'submission_format'),
            createdAt: dateText(row.submission_created_at), baseCommit: text(row, 'base_commit'),
            artifactManifestDigest: text(row, 'artifact_manifest_digest'),
            licenseAcceptanceRef: text(row, 'license_acceptance_ref') },
          workOrder: { id: text(row, 'work_order_id'), revision: Number(row.work_order_revision),
            projectRevision: Number(row.project_revision), termsDigest: text(row, 'terms_digest') },
          claim: { id: text(row, 'claim_id'), leaseEpoch: Number(row.lease_epoch),
            origin: text(row, 'claim_origin'), status: text(row, 'claim_status'), createdAt: dateText(row.claim_created_at) },
          artifact: { format: text(row, 'witness_format'), witness: (row.witness_bytes as Buffer).toString('utf8'),
            witnessDigest: text(row, 'witness_digest') },
          report: { status: text(row, 'report_status'), body: row.report_body as JsonObject,
            digest: text(row, 'report_digest'), exactScore: nullableText(row.exact_score),
            exceedsReference: row.exceeds_reference as boolean | null },
          investigation: provenance.investigation ?? null, localReview,
        },
      };
      const payloadDigest = digestCanonicalJson(payload); const id = randomUUID();
      const inserted = await client.query(`INSERT INTO motive.hypothesis_writeback_intents
        (id,project_id,scope_id,source_submission_id,prepared_by_actor_id,idempotency_key,request_digest,
         payload,payload_digest,engine_actor,disposition,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'PROPOSED_UNREVIEWED','ENGINE_WRITE_UNAVAILABLE')
        ON CONFLICT(prepared_by_actor_id,idempotency_key) DO NOTHING RETURNING *`,
      [id,projectId,input.scopeId,input.submissionId,actorId,input.idempotencyKey,requestDigest,JSON.stringify(payload),payloadDigest,engineActor]);
      const saved = inserted.rowCount ? inserted.rows[0] : await this.intentForUpdate(client, actorId, input.idempotencyKey);
      if (!saved || text(saved, 'request_digest') !== requestDigest || text(saved, 'project_id') !== projectId) {
        throw new DeliveryIntentError('CONFLICT', 'Idempotency-Key is already bound to another preparation request.', 409);
      }
      await client.query('COMMIT');
      return projection(saved, inserted.rowCount === 0);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async intentForUpdate(client: PoolClient, actorId: string, key: string): Promise<QueryResultRow | null> {
    const result = await client.query(`SELECT * FROM motive.hypothesis_writeback_intents
      WHERE prepared_by_actor_id=$1 AND idempotency_key=$2 FOR UPDATE`, [actorId, key]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

export function createHypothesisDeliveryIntentService(options: Options) {
  return new HypothesisDeliveryIntentService(options);
}
