import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import type { ParticipationAgentContext } from '../participation/service.ts';
import type { AgentResearchDeliveryCheckpoint, AgentResearchSyncInput, ResearchDeliveryMode,
  ResearchDeliveryPolicyProjection, ResearchSyncCapability } from '../../src/lib/research-delivery-policy.ts';
import type { ResearchDeliveryTargetBinding } from '../../src/lib/research-delivery-target.ts';
import { currentPolicyApprover, currentPolicyAuthority, policyIdFromPrincipal } from './delivery-policy-authority.ts';
import { registeredReviewedWritebackContract } from './pinned-writeback-contract.ts';
import {
  createHypothesisSubmissionDeliveryService,
  type ReviewedWritebackContract,
  type SubmissionResearchDeliveryResult,
} from './submission-delivery.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/; const KEY=/^[A-Za-z0-9._~-]{8,200}$/;
const NOTICE='Research delivery is started only by an explicit agent request. Draft and neutral records do not establish support, conclusion, acceptance, or review.';

export type ApproveResearchDeliveryPolicyInput=Readonly<{projectSlug:string;scopeId:string;workOrderId:string;
  idempotencyKey:string;approvedApiBaseUrl:string;contract:ReviewedWritebackContract;deliveryMode?:ResearchDeliveryMode}>;
export type RevokeResearchDeliveryPolicyInput=Readonly<{policyId:string;idempotencyKey:string}>;
type Options=Readonly<{pool:Pool;vaultKey:Uint8Array;isActorActive(actorId:string):boolean|Promise<boolean>;
  fetch?:typeof fetch;timeoutMs?:number}>;

export class ResearchDeliveryPolicyError extends Error {
  constructor(readonly code:'VALIDATION'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT',message:string){super(message);this.name='ResearchDeliveryPolicyError';}
}
const fail=(code:ResearchDeliveryPolicyError['code'],message:string):never=>{throw new ResearchDeliveryPolicyError(code,message);};
const text=(row:QueryResultRow,name:string)=>{const value=row[name];if(typeof value!=='string'||!value)throw new Error(`Invalid ${name}.`);return value;};
const date=(value:unknown)=>value===null?null:(value instanceof Date?value:new Date(String(value))).toISOString();
function apiBase(value:string){let url:URL;try{url=new URL(value);}catch{throw new ResearchDeliveryPolicyError('VALIDATION','Approved Hypothesis API base URL is invalid.');}
  if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)
    ||(url.protocol==='http:'&&!['127.0.0.1','localhost','::1'].includes(url.hostname)))fail('VALIDATION','Approved Hypothesis API base URL is invalid.');
  url.pathname=url.pathname.replace(/\/+$/,'');return url.toString().replace(/\/$/,'');}
function projection(row:QueryResultRow,status:'DRY_RUN'|'ACTIVE'|'REVOKED',projectSlug:string):ResearchDeliveryPolicyProjection{const mode=(row.delivery_mode??'NEW_DRAFT') as ResearchDeliveryMode;return{
  format:'motive.project-research-delivery-policy/0.1',id:text(row,'id'),status,projectSlug,
  projectRevision:Number(row.project_revision),workOrderId:text(row,'work_order_id'),workOrderRevision:Number(row.work_order_revision),
  workOrderTermsDigest:text(row,'work_order_terms_digest'),scopeId:text(row,'scope_id'),
  scopeConfigurationDigest:text(row,'scope_configuration_digest'),engineApiBaseUrl:text(row,'engine_api_base_url'),
  engineApiVersion:text(row,'engine_api_version'),reviewedContractDigest:text(row,'reviewed_contract_digest'),
  deliveryMode:mode,targetSelectionRule:mode==='APPEND_EXISTING'?'PRETEST_RETAINED_SAME_CHANNEL':null,
  permittedOperations:mode==='APPEND_EXISTING'?['NEUTRAL_EVIDENCE']:['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE'],approvedByActorId:text(row,'approved_by_actor_id'),
  createdAt:date(row.created_at),revokedAt:date(row.revoked_at)}};

export class ProjectResearchDeliveryPolicyService {
  private readonly sender;
  constructor(private readonly options:Options){this.sender=createHypothesisSubmissionDeliveryService(options);}

  async approve(actorId:string,raw:ApproveResearchDeliveryPolicyInput,apply=false):Promise<ResearchDeliveryPolicyProjection>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(actorId)||!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current active account is required.');
    if(!raw||!UUID.test(raw.scopeId)||!UUID.test(raw.workOrderId)||!KEY.test(raw.idempotencyKey)
      ||!/^[a-z0-9][a-z0-9-]{0,127}$/.test(raw.projectSlug)||!registeredReviewedWritebackContract(raw.contract))
      fail('VALIDATION','Research delivery policy approval input is invalid.');
    const approvedApiBaseUrl=apiBase(raw.approvedApiBaseUrl);const deliveryMode=raw.deliveryMode??'NEW_DRAFT';
    if(!['NEW_DRAFT','APPEND_EXISTING'].includes(deliveryMode)
      ||(deliveryMode==='APPEND_EXISTING'&&raw.contract.contractVersion!=='hypothesis-http-writeback-capabilities/3'))
      fail('VALIDATION','Research delivery policy mode is invalid for the reviewed contract.');
    const request=deliveryMode==='NEW_DRAFT'&&raw.deliveryMode===undefined
      ?{projectSlug:raw.projectSlug,scopeId:raw.scopeId,workOrderId:raw.workOrderId,approvedApiBaseUrl,contract:raw.contract}
      :{projectSlug:raw.projectSlug,scopeId:raw.scopeId,workOrderId:raw.workOrderId,approvedApiBaseUrl,contract:raw.contract,deliveryMode};
    const requestDigest=digestCanonicalJson(request);
    const client=await this.options.pool.connect();
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`research-policy-approval:${actorId}:${raw.idempotencyKey}`]);
      const current=await client.query(`SELECT project.id AS project_id,project.current_revision AS project_revision,
        work.id AS work_order_id,work.revision AS work_order_revision,work.terms_digest AS work_order_terms_digest,
        scope.id AS scope_id,scope.configuration_digest AS scope_configuration_digest,scope.api_base_url AS engine_api_base_url,
        scope.api_version AS engine_api_version
      FROM motive.projects project JOIN motive.memberships membership ON membership.project_id=project.id
      JOIN motive.account_identities account ON account.actor_id=membership.actor_id AND account.status='ACTIVE'
      JOIN motive.work_orders work ON work.id=$3 AND work.project_id=project.id AND work.project_revision=project.current_revision
      JOIN motive.project_research_scopes scope ON scope.id=$4 AND scope.project_id=project.id AND scope.status='CONNECTED'
      WHERE project.slug=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD')
      FOR KEY SHARE OF project,membership,account,work,scope`,[raw.projectSlug,actorId,raw.workOrderId,raw.scopeId]);
      if(current.rowCount!==1)fail('FORBIDDEN','A current owner or steward with exact current project, work order, and scope is required.');
      const source=current.rows[0];if(apiBase(text(source,'engine_api_base_url'))!==approvedApiBaseUrl
        ||text(source,'engine_api_version')!==raw.contract.apiVersion)fail('CONFLICT','Reviewed API approval differs from the current research scope.');
      const prior=await client.query(`SELECT policy.*,revocation.created_at AS revoked_at FROM motive.project_research_delivery_policies policy
        LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
        WHERE policy.approved_by_actor_id=$1 AND policy.idempotency_key=$2 FOR UPDATE OF policy`,[actorId,raw.idempotencyKey]);
      if(prior.rowCount){if(text(prior.rows[0],'request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is already bound to another policy approval.');
        await client.query('COMMIT');return projection(prior.rows[0],prior.rows[0].revoked_at?'REVOKED':'ACTIVE',raw.projectSlug);}
      const id=randomUUID();const row={...source,id,approved_by_actor_id:actorId,reviewed_contract_digest:raw.contract.fileDigest,
        reviewed_contract_version:raw.contract.contractVersion,delivery_mode:deliveryMode,created_at:null,revoked_at:null};
      if(!apply){await client.query('ROLLBACK');return projection(row,'DRY_RUN',raw.projectSlug);}
      const inserted=await client.query(`INSERT INTO motive.project_research_delivery_policies
        (id,format,project_id,project_revision,work_order_id,work_order_revision,work_order_terms_digest,scope_id,
         scope_configuration_digest,engine_api_base_url,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
         reviewed_contract_surface_digest,reviewed_implementation_digest,permitted_operations,approved_by_actor_id,idempotency_key,request_digest,
         delivery_mode,target_selection_rule)
        VALUES($1,'motive.project-research-delivery-policy/0.1',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          $15::TEXT[],$16,$17,$18,$19,$20) RETURNING *`,[id,text(source,'project_id'),Number(source.project_revision),
        raw.workOrderId,Number(source.work_order_revision),text(source,'work_order_terms_digest'),raw.scopeId,
        text(source,'scope_configuration_digest'),approvedApiBaseUrl,text(source,'engine_api_version'),raw.contract.fileDigest,
        raw.contract.contractVersion,raw.contract.surfaceDigest,raw.contract.implementationDigest,
        deliveryMode==='APPEND_EXISTING'?['NEUTRAL_EVIDENCE']:['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE'],
        actorId,raw.idempotencyKey,requestDigest,deliveryMode,deliveryMode==='APPEND_EXISTING'?'PRETEST_RETAINED_SAME_CHANNEL':null]);
      await client.query('COMMIT');return projection({...inserted.rows[0],revoked_at:null},'ACTIVE',raw.projectSlug);
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }

  async revoke(actorId:string,raw:RevokeResearchDeliveryPolicyInput,apply=false):Promise<ResearchDeliveryPolicyProjection>{
    if(!/^account:[A-Za-z0-9._~-]{1,480}$/.test(actorId)||!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current active account is required.');
    if(!raw||!UUID.test(raw.policyId)||!KEY.test(raw.idempotencyKey))fail('VALIDATION','Research delivery policy revocation input is invalid.');
    const requestDigest=digestCanonicalJson({policyId:raw.policyId});const client=await this.options.pool.connect();
    try{await client.query('BEGIN');const policy=await client.query(`SELECT policy.*,project.slug AS project_slug,revocation.created_at AS revoked_at,
        revocation.revoked_by_actor_id,revocation.idempotency_key AS revocation_key,revocation.request_digest AS revocation_digest
      FROM motive.project_research_delivery_policies policy JOIN motive.projects project ON project.id=policy.project_id
      JOIN motive.memberships membership ON membership.project_id=policy.project_id
      JOIN motive.account_identities account ON account.actor_id=membership.actor_id AND account.status='ACTIVE'
      LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
      WHERE policy.id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD')
      FOR UPDATE OF policy`,[raw.policyId,actorId]);if(policy.rowCount!==1)fail('FORBIDDEN','A current project owner or steward is required.');
      const row=policy.rows[0];if(row.revoked_at){if(row.revoked_by_actor_id!==actorId||row.revocation_key!==raw.idempotencyKey||row.revocation_digest!==requestDigest)
        fail('CONFLICT','Policy is already revoked by another immutable request.');await client.query('COMMIT');return projection(row,'REVOKED',text(row,'project_slug'));}
      if(!apply){await client.query('ROLLBACK');return projection(row,'DRY_RUN',text(row,'project_slug'));}
      const revoked=await client.query(`INSERT INTO motive.project_research_delivery_policy_revocations
        (policy_id,revoked_by_actor_id,idempotency_key,request_digest) VALUES($1,$2,$3,$4) RETURNING created_at`,
        [raw.policyId,actorId,raw.idempotencyKey,requestDigest]);await client.query('COMMIT');
      return projection({...row,revoked_at:revoked.rows[0].created_at},'REVOKED',text(row,'project_slug'));
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }

  async capability(context:ParticipationAgentContext):Promise<ResearchSyncCapability>{
    const result=await this.options.pool.query(`SELECT policy.id,policy.approved_by_actor_id,policy.delivery_mode,
      EXISTS(SELECT 1 FROM motive.project_research_scopes connected WHERE connected.project_id=project.id AND connected.status='CONNECTED') AS has_scope
      FROM motive.participation_agent_tokens token
      JOIN motive.memberships contributor_membership ON contributor_membership.project_id=token.project_id
        AND contributor_membership.actor_id=token.owner_actor_id AND contributor_membership.revoked_at IS NULL
      JOIN motive.account_identities contributor ON contributor.actor_id=token.owner_actor_id AND contributor.status='ACTIVE'
      JOIN motive.projects project ON project.id=token.project_id
      LEFT JOIN LATERAL (SELECT candidate.id,candidate.approved_by_actor_id,candidate.delivery_mode FROM motive.project_research_delivery_policies candidate
        LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=candidate.id
        JOIN motive.work_orders work ON work.id=candidate.work_order_id AND work.project_id=project.id
          AND work.project_revision=project.current_revision AND work.revision=candidate.work_order_revision
          AND work.terms_digest=candidate.work_order_terms_digest
        JOIN motive.project_research_scopes scope ON scope.id=candidate.scope_id AND scope.status='CONNECTED'
          AND scope.configuration_digest=candidate.scope_configuration_digest AND scope.api_base_url=candidate.engine_api_base_url
        JOIN motive.memberships approver_membership ON approver_membership.project_id=project.id
          AND approver_membership.actor_id=candidate.approved_by_actor_id AND approver_membership.revoked_at IS NULL
          AND approver_membership.role IN ('OWNER','STEWARD')
        JOIN motive.account_identities approver ON approver.actor_id=candidate.approved_by_actor_id AND approver.status='ACTIVE'
        WHERE candidate.project_id=project.id AND candidate.project_revision=project.current_revision AND revocation.policy_id IS NULL
        ORDER BY candidate.created_at DESC LIMIT 1) policy ON TRUE
      WHERE token.id=$1 AND token.project_id=$2 AND token.owner_actor_id=$3 AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()`,
      [context.tokenId,context.projectId,context.ownerActorId]);
    if(result.rowCount!==1)fail('UNAUTHORIZED','Agent credential or project membership is no longer current.');
    let policyId=typeof result.rows[0].id==='string'?result.rows[0].id:null;
    if(policyId&&!await this.options.isActorActive(text(result.rows[0],'approved_by_actor_id')))policyId=null;
    const hasScope=result.rows[0].has_scope===true;const status=policyId?'AVAILABLE':hasScope?'OWNER_APPROVAL_REQUIRED':'UNAVAILABLE';
    const reason=policyId?'CURRENT_POLICY_AVAILABLE':hasScope?'OWNER_APPROVAL_REQUIRED':'RESEARCH_SCOPE_UNAVAILABLE';
    const mode=policyId?String(result.rows[0].delivery_mode):null;
    return {format:'motive.agent-research-sync-capability/0.1',status,reason,policyId,
      syncPath:policyId?'/api/agent/submissions/{submissionId}/research-sync':null,
      permittedOperations:policyId?(mode==='APPEND_EXISTING'?['NEUTRAL_EVIDENCE']:['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']):[],trigger:'EXPLICIT_AGENT_REQUEST',notice:NOTICE};
  }

  async syncFromAgent(context:ParticipationAgentContext,submissionId:string,input:AgentResearchSyncInput,idempotencyKey:string):Promise<SubmissionResearchDeliveryResult>{
    if(!UUID.test(submissionId)||!input||!UUID.test(input.policyId)||!DIGEST.test(input.reportDigest)||!KEY.test(idempotencyKey))
      fail('VALIDATION','Agent research sync request is invalid.');
    if(context.actorId!==`agent:${context.tokenId}`)fail('UNAUTHORIZED','Agent token context is invalid.');
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','The owning account is no longer active.');
    const policyApprover=await currentPolicyApprover(this.options.pool,input.policyId);
    if(!policyApprover||!await this.options.isActorActive(policyApprover))fail('FORBIDDEN','The approving owner or steward is no longer active.');
    const requestDigest=digestCanonicalJson({policyId:input.policyId,submissionId,reportDigest:input.reportDigest});
    const client=await this.options.pool.connect();let authority;let syncRequestId:string;
    try{await client.query('BEGIN');const token=await client.query(`SELECT token.* FROM motive.participation_agent_tokens token
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
      JOIN motive.account_identities account ON account.actor_id=token.owner_actor_id AND account.status='ACTIVE'
      WHERE token.id=$1 AND token.project_id=$2 AND token.owner_actor_id=$3 AND token.revoked_at IS NULL
        AND token.expires_at>clock_timestamp() AND membership.revoked_at IS NULL FOR UPDATE OF token`,
      [context.tokenId,context.projectId,context.ownerActorId]);
      if(token.rowCount!==1)fail('UNAUTHORIZED','Agent credential or project membership is no longer current.');
      const prior=await client.query(`SELECT * FROM motive.agent_research_sync_requests WHERE agent_token_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [context.tokenId,idempotencyKey]);
      if(prior.rowCount&&text(prior.rows[0],'request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is already bound to another research sync request.');
      const artifact=await client.query(`SELECT artifact.agent_token_id
        FROM motive.participation_submission_artifacts artifact
        LEFT JOIN motive.hypothesis_submission_deliveries delivery ON delivery.project_id=artifact.project_id
          AND delivery.source_submission_id=artifact.submission_id
        LEFT JOIN LATERAL (SELECT admission.* FROM motive.hypothesis_submission_delivery_admission_decisions admission
          WHERE admission.delivery_id=delivery.id
            AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
              WHERE successor.previous_decision_id=admission.id) LIMIT 1) admission ON TRUE
        LEFT JOIN motive.finding_review_decisions finding ON finding.id=admission.finding_decision_id
          AND finding.source_submission_id=artifact.submission_id AND finding.project_id=artifact.project_id
        WHERE artifact.submission_id=$2 AND artifact.project_id=$3 AND artifact.report_digest=$4
          AND (artifact.agent_token_id=$1 OR (admission.decision='ADMIT'
            AND finding.reviewer_agent_token_id=$1
            AND motive.valid_agent_memory_admission_proof(finding.reviewer_actor_id,finding.id,delivery.id)))
        FOR KEY SHARE OF artifact`,[context.tokenId,submissionId,context.projectId,input.reportDigest]);
      if(artifact.rowCount!==1)fail('FORBIDDEN','Only the source credential or its exact accepted finding reviewer may request research sync.');
      authority=await currentPolicyAuthority(client,input.policyId,{projectId:context.projectId,scopeId:await this.policyScope(client,input.policyId),submissionId});
      if(!authority)fail('FORBIDDEN','Current research delivery policy authority is unavailable.');
      if(prior.rowCount)syncRequestId=text(prior.rows[0],'id');
      else { const inserted=await client.query(`INSERT INTO motive.agent_research_sync_requests
        (id,agent_token_id,project_id,policy_id,submission_id,report_digest,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[randomUUID(),context.tokenId,context.projectId,input.policyId,submissionId,input.reportDigest,idempotencyKey,requestDigest]);
        syncRequestId=text(inserted.rows[0],'id'); }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    const contract:ReviewedWritebackContract={fileDigest:authority!.contractDigest,
      contractVersion:authority!.contractVersion as ReviewedWritebackContract['contractVersion'],
      apiVersion:authority!.apiVersion as ReviewedWritebackContract['apiVersion'],schemaRevision:'017_write_idempotency',
      surfaceDigest:authority!.contractSurfaceDigest,implementationDigest:authority!.implementationDigest};
    return this.sender.syncWithPolicyPrincipal(input.policyId,{projectSlug:authority!.projectSlug,scopeId:authority!.scopeId,
      submissionId,idempotencyKey:`agent-sync-${syncRequestId!}`,approvedApiBaseUrl:authority!.apiBaseUrl,contract,execute:true});
  }

  async pendingDelivery(context:ParticipationAgentContext,submissionId:string):Promise<AgentResearchDeliveryCheckpoint>{
    if(!UUID.test(submissionId)||context.actorId!==`agent:${context.tokenId}`)fail('VALIDATION','Research delivery checkpoint identity is invalid.');
    const client=await this.options.pool.connect();
    try{await client.query('BEGIN');
      const found=await client.query(`SELECT delivery.*,artifact.report_digest,
          tail.id AS admission_id,tail.decision AS admission_decision,tail.review_package_digest,
          tail.finding_decision_id,tail.reviewer_actor_id,
          result.resource_id AS evidence_id,blocked.reason AS blocked_reason
        FROM motive.submissions submission
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
          AND artifact.project_id=submission.project_id
        LEFT JOIN motive.hypothesis_submission_deliveries delivery ON delivery.project_id=submission.project_id
          AND delivery.source_submission_id=submission.id
        LEFT JOIN LATERAL (SELECT item.* FROM motive.hypothesis_submission_delivery_admission_decisions item
          WHERE item.delivery_id=delivery.id AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
            WHERE successor.previous_decision_id=item.id) LIMIT 1) tail ON TRUE
        LEFT JOIN motive.hypothesis_submission_delivery_results result ON result.delivery_id=delivery.id
          AND result.operation='NEUTRAL_EVIDENCE'
        LEFT JOIN motive.research_delivery_operation_blocks blocked ON blocked.delivery_id=delivery.id
          AND blocked.operation='NEUTRAL_EVIDENCE'
        WHERE submission.id=$2 AND submission.project_id=$3
          AND (artifact.agent_token_id=$1 OR EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
            WHERE finding.id=tail.finding_decision_id AND finding.source_submission_id=submission.id
              AND finding.project_id=submission.project_id AND finding.reviewer_agent_token_id=$1
              AND motive.valid_agent_memory_admission_proof(finding.reviewer_actor_id,finding.id,delivery.id)))`,
      [context.tokenId,submissionId,context.projectId]);
      if(found.rowCount!==1)fail('NOT_FOUND','Research delivery source was not found for this credential.');
      const row=found.rows[0],reportDigest=text(row,'report_digest');
      if(row.id===null){await client.query('COMMIT');return{format:'motive.agent-research-delivery-checkpoint/0.1',status:'PENDING',
        submissionId,deliveryId:null,policyId:null,mode:'NEW_DRAFT',target:null,reportDigest,syncPath:null,reason:'DELIVERY_UNAVAILABLE'};}
      const deliveryId=text(row,'id'),mode=text(row,'delivery_mode') as ResearchDeliveryMode;
      const target=row.target_binding===null?null:row.target_binding as ResearchDeliveryTargetBinding;
      const policyId=policyIdFromPrincipal(text(row,'created_by_actor_id'));
      let reason:AgentResearchDeliveryCheckpoint['reason']='ADMISSION_REQUIRED';
      if(row.admission_id!==null&&row.admission_decision==='ADMIT'&&row.evidence_id===null&&row.blocked_reason===null&&policyId){
        const proof=row.finding_decision_id===null
          ?await client.query(`SELECT EXISTS(SELECT 1 FROM motive.memberships membership
              JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id AND identity.status='ACTIVE'
              WHERE membership.project_id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
                AND membership.role IN ('OWNER','STEWARD','REVIEWER')) AS valid`,[context.projectId,row.reviewer_actor_id])
          :await client.query(`SELECT motive.valid_agent_memory_admission_proof($1,$2,$3) AS valid`,
            [row.reviewer_actor_id,row.finding_decision_id,deliveryId]);
        if(proof.rows[0]?.valid!==true){await client.query('COMMIT');return{format:'motive.agent-research-delivery-checkpoint/0.1',
          status:'PENDING',submissionId,deliveryId,policyId,mode,target,reportDigest,syncPath:null,reason:'ADMISSION_REQUIRED'};}
        const authority=await currentPolicyAuthority(client,policyId,{projectId:context.projectId,scopeId:text(row,'scope_id'),submissionId,
          apiBaseUrl:text(row,'engine_api_base_url'),configurationDigest:text(row,'scope_configuration_digest'),
          apiVersion:text(row,'engine_api_version'),contractDigest:text(row,'reviewed_contract_digest'),
          contractVersion:text(row,'reviewed_contract_version'),contractSurfaceDigest:text(row,'reviewed_contract_surface_digest'),
          implementationDigest:text(row,'reviewed_implementation_digest'),deliveryMode:mode});
        if(!authority)reason='OWNER_APPROVAL_REQUIRED';
        else {const pkg=await this.sender.reviewPackage(deliveryId,client);
          if(digestCanonicalJson(pkg)===row.review_package_digest){await client.query('COMMIT');return{
            format:'motive.agent-research-delivery-checkpoint/0.1',status:'READY',submissionId,deliveryId,policyId,mode,target,
            reportDigest,syncPath:'/api/agent/submissions/{submissionId}/research-sync',reason:'READY_FOR_SYNC'};}
          reason='ADMISSION_REQUIRED';}
      }else if(!policyId)reason='OWNER_APPROVAL_REQUIRED';
      else if(row.evidence_id!==null||row.blocked_reason!==null)reason='DELIVERY_UNAVAILABLE';
      await client.query('COMMIT');return{format:'motive.agent-research-delivery-checkpoint/0.1',status:'PENDING',submissionId,
        deliveryId,policyId,mode,target,reportDigest,syncPath:null,reason};
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }

  async nextReadyDelivery(context:ParticipationAgentContext):Promise<AgentResearchDeliveryCheckpoint|null>{
    const candidates=await this.options.pool.query(`SELECT delivery.source_submission_id
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
        AND artifact.project_id=delivery.project_id
      JOIN motive.hypothesis_submission_delivery_admission_decisions admission ON admission.delivery_id=delivery.id
        AND admission.decision='ADMIT'
        AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
          WHERE successor.previous_decision_id=admission.id)
      WHERE delivery.project_id=$2
        AND (artifact.agent_token_id=$1 OR EXISTS(SELECT 1 FROM motive.finding_review_decisions finding
          WHERE finding.id=admission.finding_decision_id AND finding.source_submission_id=delivery.source_submission_id
            AND finding.project_id=delivery.project_id AND finding.reviewer_agent_token_id=$1
            AND motive.valid_agent_memory_admission_proof(finding.reviewer_actor_id,finding.id,delivery.id)))
        AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results result
        WHERE result.delivery_id=delivery.id AND result.operation='NEUTRAL_EVIDENCE')
        AND NOT EXISTS(SELECT 1 FROM motive.research_delivery_operation_blocks blocked
          WHERE blocked.delivery_id=delivery.id AND blocked.operation='NEUTRAL_EVIDENCE')
      ORDER BY delivery.created_at,delivery.id LIMIT 20`,[context.tokenId,context.projectId]);
    for(const row of candidates.rows){const checkpoint=await this.pendingDelivery(context,text(row,'source_submission_id'));
      if(checkpoint.status==='READY')return checkpoint;}
    return null;
  }

  private async policyScope(client:import('pg').PoolClient,policyId:string):Promise<string>{const result=await client.query(
    'SELECT scope_id FROM motive.project_research_delivery_policies WHERE id=$1',[policyId]);return result.rowCount===1?text(result.rows[0],'scope_id'):fail('NOT_FOUND','Research delivery policy was not found.');}
}

export function createProjectResearchDeliveryPolicyService(options:Options){return new ProjectResearchDeliveryPolicyService(options);}
