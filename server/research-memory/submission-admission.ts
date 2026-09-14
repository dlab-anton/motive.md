import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { createHypothesisSubmissionDeliveryService, type HypothesisSubmissionDeliveryService,
  type JsonObject, type SubmissionDeliveryOptions } from './submission-delivery.ts';
import { LEGACY_REVIEWED_WRITEBACK_CONTRACT,PINNED_REVIEWED_WRITEBACK_CONTRACT,registeredReviewedWritebackContract,
  type ReviewedWritebackContract } from './pinned-writeback-contract.ts';
import type { ResearchRetainedSnapshot } from '../../src/lib/research-memory.ts';
import type { PublicResearchSummary } from '../../src/lib/research-summary.ts';
import type { FindingReviewMemoryStatus } from '../../src/lib/finding-assessment.ts';
import type { ResearchDeliveryTargetBinding } from '../../src/lib/research-delivery-target.ts';
import { currentPolicyAuthority, policyIdFromPrincipal, type PolicyAuthority } from './delivery-policy-authority.ts';
import type { ResearchDeliveryMode } from '../../src/lib/research-delivery-policy.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT=/^account:[A-Za-z0-9._~-]{1,480}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const KEY=/^[A-Za-z0-9._~-]{8,200}$/;
const REVIEW_AGENT_TOKEN=/^motive_review_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/;
const MAX_RETAINED_SNAPSHOT_BYTES=524_288;
const SNAPSHOT_NOTICE='Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.' as const;

export type ResearchDeliveryReviewPackageV1=Readonly<{
  format:'motive.research-delivery-review-package/0.1';
  delivery:{id:string;projectId:string;scopeId:string;sourceSubmissionId:string;sourceIntentId:string;sourceIntentPayloadDigest:string};
  scope:{configurationDigest:string;apiBaseUrl:string;apiVersion:string;engineActor:string};
  report:{status:'VALID'|'REJECTED'|'INCONCLUSIVE';digest:string;exactScore:string|null;exceedsReference:boolean|null};
  postCheck:{requestDigest:string;reportDigest:string;assessment:string;nextAction:string;publicSummary?:PublicResearchSummary;createdAt:string};
  reproducibility:null|{requestDigest:string;solverSourceDigest:string;trialResultsDigest:string};
  contract:ReviewedWritebackContract;
  assessment:{hypothesisSupport:'UNASSESSED';conclusionApproval:'UNASSESSED'};
  operations:{draft:{method:'POST';path:'/api/v1/hypotheses';body:JsonObject;bodyDigest:string;requestDigest:string};
    neutralEvidence:{method:'POST';pathTemplate:'/api/v1/hypotheses/{createdHypothesisId}/evidence';body:JsonObject;bodyDigest:string;requestTemplateDigest:string}};
}>;
export type ResearchDeliveryReviewPackageV2=Readonly<{
  format:'motive.research-delivery-review-package/0.2';
  delivery:{id:string;projectId:string;scopeId:string;sourceSubmissionId:string;sourceIntentId:string;
    sourceIntentPayloadDigest:string;mode:'APPEND_EXISTING';target:ResearchDeliveryTargetBinding;targetBindingDigest:string};
  scope:ResearchDeliveryReviewPackageV1['scope'];report:ResearchDeliveryReviewPackageV1['report'];
  postCheck:ResearchDeliveryReviewPackageV1['postCheck'];reproducibility:ResearchDeliveryReviewPackageV1['reproducibility'];
  contract:ReviewedWritebackContract;assessment:ResearchDeliveryReviewPackageV1['assessment'];
  observationManifest:{href:string;digest:string;body:JsonObject};
  operations:{neutralEvidence:{method:'POST';path:string;body:JsonObject;bodyDigest:string;requestDigest:string}};
}>;
export type ResearchDeliveryReviewPackage=ResearchDeliveryReviewPackageV1|ResearchDeliveryReviewPackageV2;
export type ResearchDeliveryAdmissionDecision=Readonly<{format:'motive.research-delivery-admission/0.1';id:string;deliveryId:string;
  packageDigest:string;previousDecisionId:string|null;decision:'ADMIT'|'DECLINE';rationale:string;reviewerActorId:string;createdAt:string}>;
export type ResearchDeliveryAdmissionPreview=Readonly<{format:'motive.research-delivery-admission-preview/0.1';package:ResearchDeliveryReviewPackage;
  packageDigest:string;latestDecision:ResearchDeliveryAdmissionDecision|null}>;
export type PublicResearchDeliveryAdmission=Readonly<{format:'motive.research-delivery-admission-public/0.1';submissionId:string;
  status:'PENDING'|'ADMITTED'|'DECLINED'|'STALE'|'DELIVERED_UNREVIEWED';latestReview:null|{decision:'ADMIT'|'DECLINE';rationale:string;reviewedAt:string}}>;
export type ResearchDeliveryAdmissionEligibility=Readonly<{canReview:boolean;reason:'ELIGIBLE'|'NOT_FOUND'|'ACCOUNT_INACTIVE'|'MEMBERSHIP_REQUIRED'|'ORIGINAL_CONTRIBUTOR'|'AUTHORITY_UNAVAILABLE'}>;
export type DecideResearchDeliveryAdmissionInput=Readonly<{packageDigest:string;expectedDecisionId:string|null;decision:'ADMIT'|'DECLINE';rationale:string}>;
export type ResearchAdmissionAgentAccessStatus='READY'|'STALE'|'CONSUMED'|'REVOKED'|'EXPIRED';
export type ResearchAdmissionAgentAccessProjection=Readonly<{id:string;submissionId:string;packageDigest:string;
  expectedDecisionId:string|null;status:ResearchAdmissionAgentAccessStatus;expiresAt:string;firstSeenAt:string|null;
  lastSeenAt:string|null;consumedAt:string|null;revokedAt:string|null;createdAt:string}>;
export type ResearchAdmissionAgentAccessResponse=Readonly<{access:ResearchAdmissionAgentAccessProjection|null}>;
export type IssueResearchAdmissionAgentAccessInput=Readonly<{packageDigest:string;expectedDecisionId:string|null}>;
export type IssueResearchAdmissionAgentAccessResponse=Readonly<{access:ResearchAdmissionAgentAccessProjection;token:string}>;
export type ResearchAdmissionAgentContext=Readonly<{accessId:string;tokenDigest:string;reviewerActorId:string;projectId:string;
  submissionId:string;deliveryId:string;packageDigest:string;expectedDecisionId:string|null;allowConsumedQueueReplay?:boolean}>;
export type ResearchAdmissionAgentSnapshotDescriptor=Readonly<{scopeId:string;snapshotId:string;snapshotDigest:string;
  declaredIn:ReadonlyArray<'PRE_TEST_INTENT'|'SUBMISSION_NOTES'>;href:string}>;
export type ResearchAdmissionAgentAssignment=Readonly<{format:'motive.research-admission-agent-assignment/0.1';accessId:string;
  submissionId:string;package:ResearchDeliveryReviewPackage;packageDigest:string;expectedDecisionId:string|null;expiresAt:string;
  reportHref:string;investigationHref:string|null;reproducibilityHref:string|null;
  researchSnapshots:ReadonlyArray<ResearchAdmissionAgentSnapshotDescriptor>}>;
export type DecideResearchAdmissionFromAgentInput=Readonly<{decision:'ADMIT'|'DECLINE';rationale:string}>;
export type ResearchAdmissionAgentDecision=Readonly<{format:'motive.research-admission-agent-decision/0.1';submissionId:string;
  packageDigest:string;decision:'ADMIT'|'DECLINE';rationale:string;reviewedAt:string}>;

export class SubmissionAdmissionError extends Error{
  readonly statusCode:400|401|403|404|409;
  constructor(readonly code:'VALIDATION'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT',message:string,statusCode?:400|401|403|404|409){super(message);this.name='SubmissionAdmissionError';
    this.statusCode=statusCode??(code==='VALIDATION'?400:code==='UNAUTHORIZED'?401:code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:409);}
}
function fail(code:SubmissionAdmissionError['code'],message:string):never{throw new SubmissionAdmissionError(code,message);}
function dateText(value:unknown){return(value instanceof Date?value:new Date(String(value))).toISOString();}
function text(row:QueryResultRow,name:string){const value=row[name];if(typeof value!=='string'||!value)fail('CONFLICT',`Stored ${name} is invalid.`);return value;}
function nullableText(row:QueryResultRow,name:string){return row[name]===null||row[name]===undefined?null:text(row,name);}
function exact(value:unknown,names:string[]){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
  &&JSON.stringify(Object.keys(value as Record<string,unknown>).sort())===JSON.stringify([...names].sort());}
function storedObject(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('CONFLICT',`Stored ${label} is invalid.`);
  return value as Record<string,unknown>;
}
type SnapshotCitation=Readonly<{scopeId:string;snapshotId:string;snapshotDigest:string}>;
function snapshotCitation(value:unknown,label:string):SnapshotCitation{
  if(!exact(value,['scopeId','snapshotDigest','snapshotId']))fail('CONFLICT',`Stored ${label} is invalid.`);
  const item=value as Record<string,unknown>;
  if(typeof item.scopeId!=='string'||!UUID.test(item.scopeId)||typeof item.snapshotId!=='string'||!UUID.test(item.snapshotId)
    ||typeof item.snapshotDigest!=='string'||!DIGEST.test(item.snapshotDigest))fail('CONFLICT',`Stored ${label} is invalid.`);
  return{scopeId:item.scopeId.toLowerCase(),snapshotId:item.snapshotId.toLowerCase(),snapshotDigest:item.snapshotDigest};
}
function snapshotCitations(value:Record<string,unknown>,label:string):SnapshotCitation[]{
  const citations:SnapshotCitation[]=[];
  if(value.researchContext!==undefined&&value.researchContext!==null)
    citations.push(snapshotCitation(value.researchContext,`${label} research context`));
  if(value.researchReferences!==undefined&&value.researchReferences!==null){
    if(!Array.isArray(value.researchReferences)||value.researchReferences.length<1||value.researchReferences.length>10)
      fail('CONFLICT',`Stored ${label} research references are invalid.`);
    for(const [index,entry] of value.researchReferences.entries()){
      if(!exact(entry,['evidenceIds','hypothesisId','observedUpdatedAt','scopeId','snapshotDigest','snapshotId']))
        fail('CONFLICT',`Stored ${label} research reference ${index} is invalid.`);
      const reference=entry as Record<string,unknown>;
      if(typeof reference.hypothesisId!=='string'||!UUID.test(reference.hypothesisId)
        ||typeof reference.observedUpdatedAt!=='string'||reference.observedUpdatedAt.length>40
        ||!Number.isFinite(Date.parse(reference.observedUpdatedAt))||!Array.isArray(reference.evidenceIds)
        ||reference.evidenceIds.length>20||new Set(reference.evidenceIds).size!==reference.evidenceIds.length
        ||reference.evidenceIds.some(id=>typeof id!=='string'||!UUID.test(id)))
        fail('CONFLICT',`Stored ${label} research reference ${index} is invalid.`);
      citations.push(snapshotCitation({scopeId:reference.scopeId,snapshotId:reference.snapshotId,
        snapshotDigest:reference.snapshotDigest},`${label} research reference ${index}`));
    }
  }
  return citations;
}
function decision(row:QueryResultRow):ResearchDeliveryAdmissionDecision{return{format:'motive.research-delivery-admission/0.1',id:text(row,'id'),deliveryId:text(row,'delivery_id'),
  packageDigest:text(row,'review_package_digest'),previousDecisionId:row.previous_decision_id===null?null:text(row,'previous_decision_id'),
  decision:text(row,'decision') as 'ADMIT'|'DECLINE',rationale:text(row,'rationale'),reviewerActorId:text(row,'reviewer_actor_id'),createdAt:dateText(row.created_at)}}
export type AgentMemoryAdmissionContext=Readonly<{tokenId:string;ownerActorId:string;projectId:string}>;
type AutomaticSender=Pick<HypothesisSubmissionDeliveryService,'prepareForReview'|'reviewPackage'|'syncWithPolicyPrincipal'>;
export type SubmissionAdmissionOptions=SubmissionDeliveryOptions&Readonly<{sender?:AutomaticSender;agentTokenSecret?:string}>;

export class HypothesisSubmissionAdmissionService{
  private readonly sender:AutomaticSender;
  constructor(private readonly options:SubmissionAdmissionOptions){
    if(options.agentTokenSecret!==undefined&&Buffer.byteLength(options.agentTokenSecret,'utf8')<32)
      throw new Error('Research admission agent token secret must be at least 32 UTF-8 bytes.');
    this.sender=options.sender??createHypothesisSubmissionDeliveryService(options);
  }

  private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.options.pool.connect();try{await client.query('BEGIN');const result=await work(client);
      await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }

  private requireAgentSecret(){if(!this.options.agentTokenSecret)fail('CONFLICT','Research admission agent access is not configured.');return this.options.agentTokenSecret;}
  private accessToken(id:string,actorId:string){const signature=createHmac('sha256',this.requireAgentSecret())
    .update(`motive-research-admission-agent-v1\0${id}\0${actorId}`).digest('base64url');
    return`motive_review_${id.replaceAll('-','')}_${signature}`;}
  recoverAgentAccessToken(accessId:string,reviewerActorId:string){
    if(!UUID.test(accessId)||!ACCOUNT.test(reviewerActorId))fail('VALIDATION','Reviewer agent access identity is invalid.');
    return this.accessToken(accessId,reviewerActorId);
  }
  private tokenDigest(raw:string){return`sha256:${createHash('sha256').update(raw).digest('hex')}`;}
  private accessProjection(row:QueryResultRow,current:boolean):ResearchAdmissionAgentAccessProjection{
    const revokedAt=row.revoked_at===null?null:dateText(row.revoked_at),consumedAt=row.consumed_at===null?null:dateText(row.consumed_at);
    const status:ResearchAdmissionAgentAccessStatus=revokedAt?'REVOKED':consumedAt?'CONSUMED':
      new Date(row.expires_at as Date|string).getTime()<=Date.now()?'EXPIRED':current?'READY':'STALE';
    return{id:text(row,'id'),submissionId:text(row,'submission_id'),packageDigest:text(row,'review_package_digest'),
      expectedDecisionId:row.expected_decision_id===null?null:text(row,'expected_decision_id'),status,expiresAt:dateText(row.expires_at),
      firstSeenAt:row.first_seen_at===null?null:dateText(row.first_seen_at),lastSeenAt:row.last_seen_at===null?null:dateText(row.last_seen_at),
      consumedAt,revokedAt,createdAt:dateText(row.created_at)};
  }

  private async authority(actorId:string,submissionId:string,client:Pool|PoolClient=this.options.pool,lock=false,checkExternal=true){
    if(!ACCOUNT.test(actorId))return{reason:'ACCOUNT_INACTIVE' as const,row:null};
    if(!UUID.test(submissionId))return{reason:'NOT_FOUND' as const,row:null};
    const result=await client.query(`SELECT submission.id AS submission_id,submission.project_id,project.slug AS project_slug,
        token.owner_actor_id,scope.id AS scope_id,scope.api_base_url
      FROM motive.submissions submission JOIN motive.projects project ON project.id=submission.project_id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      JOIN motive.project_research_scopes scope ON scope.project_id=submission.project_id AND scope.status='CONNECTED'
      WHERE submission.id=$1 ${lock?'FOR SHARE OF token,artifact,scope':''}`,[submissionId]);
    if(result.rowCount!==1)return{reason:'NOT_FOUND' as const,row:null};
    if(text(result.rows[0],'owner_actor_id')===actorId)return{reason:'ORIGINAL_CONTRIBUTOR' as const,row:result.rows[0]};
    const member=await client.query(`SELECT membership.role,identity.status FROM motive.memberships membership
      JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
      WHERE membership.project_id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
        AND membership.role IN ('OWNER','STEWARD','REVIEWER') ${lock?'FOR SHARE OF membership,identity':''}`,[result.rows[0].project_id,actorId]);
    if(member.rowCount!==1)return{reason:'MEMBERSHIP_REQUIRED' as const,row:result.rows[0]};
    if(member.rows[0].status!=='ACTIVE'||(checkExternal&&!await this.options.isActorActive(actorId)))return{reason:'ACCOUNT_INACTIVE' as const,row:result.rows[0]};
    return{reason:'ELIGIBLE' as const,row:result.rows[0]};
  }

  async admissionEligibility(reviewerActorId:string,submissionId:string):Promise<ResearchDeliveryAdmissionEligibility>{
    const found=await this.authority(reviewerActorId,submissionId);
    return{canReview:found.reason==='ELIGIBLE',reason:found.reason};
  }

  private async tail(deliveryId:string,client:Pool|PoolClient=this.options.pool){const result=await client.query(`SELECT item.*
    FROM motive.hypothesis_submission_delivery_admission_decisions item WHERE item.delivery_id=$1
      AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor WHERE successor.previous_decision_id=item.id)`,[deliveryId]);
    return result.rowCount===1?decision(result.rows[0]):null;}

  private validateDecisionInput(input:DecideResearchDeliveryAdmissionInput,idempotencyKey:string){
    if(!input||!exact(input as unknown as Record<string,unknown>,['decision','expectedDecisionId','packageDigest','rationale'])
      ||!DIGEST.test(input.packageDigest)||!(input.expectedDecisionId===null||UUID.test(input.expectedDecisionId))
      ||!['ADMIT','DECLINE'].includes(input.decision)||typeof input.rationale!=='string'||input.rationale.trim()!==input.rationale
      ||input.rationale.length<1||input.rationale.length>2000||!KEY.test(idempotencyKey))fail('VALIDATION','Research admission decision input is invalid.');
  }

  private async lockedState(client:PoolClient,reviewerActorId:string,submissionId:string){
    const authority=await this.authority(reviewerActorId,submissionId,client,true,false);
    if(authority.reason!=='ELIGIBLE'||!authority.row)fail(authority.reason==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
    const delivery=await client.query(`SELECT id FROM motive.hypothesis_submission_deliveries WHERE scope_id=$1 AND source_submission_id=$2 FOR UPDATE`,
    [authority.row.scope_id,submissionId]);
    if(delivery.rowCount!==1)fail('NOT_FOUND','A prepared research delivery was not found.');
    return{authority:authority.row,deliveryId:text(delivery.rows[0],'id')};
  }

  private async insertDecision(client:PoolClient,reviewerActorId:string,submissionId:string,input:DecideResearchDeliveryAdmissionInput,
    idempotencyKey:string,state:Awaited<ReturnType<HypothesisSubmissionAdmissionService['lockedState']>>){
    const requestDigest=digestCanonicalJson({submissionId,packageDigest:input.packageDigest,expectedDecisionId:input.expectedDecisionId,
      decision:input.decision,rationale:input.rationale});
    const prior=await client.query(`SELECT * FROM motive.hypothesis_submission_delivery_admission_decisions
      WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[reviewerActorId,idempotencyKey]);
    if(prior.rowCount===1){if(text(prior.rows[0],'request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is already bound to another decision.');return decision(prior.rows[0]);}
    const reviewPackage=await this.sender.reviewPackage(state.deliveryId,client);
    if(digestCanonicalJson(reviewPackage)!==input.packageDigest)fail('CONFLICT','Reviewed research delivery package is stale.');
    const latest=await this.tail(state.deliveryId,client);
    if((latest?.id??null)!==input.expectedDecisionId)fail('CONFLICT','Expected research admission decision is stale.');
    const id=randomUUID();const inserted=await client.query(`INSERT INTO motive.hypothesis_submission_delivery_admission_decisions
      (id,delivery_id,review_package,review_package_digest,previous_decision_id,decision,reviewer_actor_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id,state.deliveryId,JSON.stringify(reviewPackage),input.packageDigest,
      input.expectedDecisionId,input.decision,reviewerActorId,input.rationale,idempotencyKey,requestDigest]);
    return decision(inserted.rows[0]);
  }

  async prepareAdmissionPreview(reviewerActorId:string,submissionId:string):Promise<ResearchDeliveryAdmissionPreview>{
    const authority=await this.authority(reviewerActorId,submissionId);
    if(authority.reason!=='ELIGIBLE'||!authority.row)fail(authority.reason==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
    const delivery=await this.options.pool.query(`SELECT id FROM motive.hypothesis_submission_deliveries WHERE scope_id=$1 AND source_submission_id=$2`,[authority.row.scope_id,submissionId]);
    let deliveryId:string;
    if(delivery.rowCount===1)deliveryId=text(delivery.rows[0],'id'); else{
      const result=await this.sender.prepareForReview(reviewerActorId,{projectSlug:text(authority.row,'project_slug'),scopeId:text(authority.row,'scope_id'),submissionId,
        idempotencyKey:`admission-${submissionId}`,approvedApiBaseUrl:text(authority.row,'api_base_url'),contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
      if(!result.deliveryId)fail('CONFLICT','An exact delivery preview could not be prepared.');deliveryId=result.deliveryId;
    }
    return this.transaction(async client=>{
      const state=await this.lockedState(client,reviewerActorId,submissionId);
      if(state.deliveryId!==deliveryId)fail('CONFLICT','Research admission preview is stale.');
      const reviewPackage=await this.sender.reviewPackage(deliveryId,client);const packageDigest=digestCanonicalJson(reviewPackage);
      return{format:'motive.research-delivery-admission-preview/0.1',package:reviewPackage,packageDigest,
        latestDecision:await this.tail(deliveryId,client)};
    });
  }

  async decideAdmission(reviewerActorId:string,submissionId:string,input:DecideResearchDeliveryAdmissionInput,idempotencyKey:string):Promise<ResearchDeliveryAdmissionDecision>{
    this.validateDecisionInput(input,idempotencyKey);
    if(!ACCOUNT.test(reviewerActorId)||!await this.options.isActorActive(reviewerActorId))fail('UNAUTHORIZED','A current active account is required.');
    try{return await this.transaction(async client=>this.insertDecision(client,reviewerActorId,submissionId,input,idempotencyKey,
      await this.lockedState(client,reviewerActorId,submissionId)));
    }catch(error){const code=(error as {code?:string}).code;
      if(code==='42501')fail('FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
      if(code==='40001'||code==='23505'||code==='23503'||code==='23514')fail('CONFLICT','Research admission decision conflicts with retained state.');
      throw error;}
  }

  private packageIsRetained(row:QueryResultRow){return digestCanonicalJson(row.review_package)===text(row,'review_package_digest');}
  private async accessIsCurrent(row:QueryResultRow,client:Pool|PoolClient=this.options.pool){
    if(!this.packageIsRetained(row))return false;
    try{const retained=await this.sender.reviewPackage(text(row,'delivery_id'),client);const latest=await this.tail(text(row,'delivery_id'),client);
      return digestCanonicalJson(retained)===text(row,'review_package_digest')
        &&(latest?.id??null)===(row.expected_decision_id===null?null:text(row,'expected_decision_id'));
    }catch{return false;}
  }

  async getAgentAccess(reviewerActorId:string,submissionId:string):Promise<ResearchAdmissionAgentAccessResponse>{
    const authorized=await this.authority(reviewerActorId,submissionId);
    if(authorized.reason!=='ELIGIBLE')fail(authorized.reason==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
    const found=await this.options.pool.query(`SELECT * FROM motive.hypothesis_submission_admission_agent_access
      WHERE reviewer_actor_id=$1 AND submission_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,[reviewerActorId,submissionId]);
    if(found.rowCount!==1)return{access:null};const row=found.rows[0];const terminal=row.revoked_at!==null||row.consumed_at!==null
      ||new Date(row.expires_at as Date|string).getTime()<=Date.now();const current=terminal?false:await this.accessIsCurrent(row);
    return{access:this.accessProjection(row,current)};
  }

  async inspectAgentAccess(reviewerActorId:string,submissionId:string,accessId:string,
    client:Pool|PoolClient=this.options.pool,checkExternal=true):Promise<ResearchAdmissionAgentAccessProjection>{
    if(!UUID.test(accessId))fail('NOT_FOUND','Research admission agent access was not found.');
    const authorized=await this.authority(reviewerActorId,submissionId,client,client!==this.options.pool,checkExternal);
    if(authorized.reason!=='ELIGIBLE')fail(authorized.reason==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
    const found=await client.query(`SELECT * FROM motive.hypothesis_submission_admission_agent_access
      WHERE id=$1 AND reviewer_actor_id=$2 AND submission_id=$3`,[accessId,reviewerActorId,submissionId]);
    if(found.rowCount!==1)fail('NOT_FOUND','Research admission agent access was not found.');const row=found.rows[0];
    const terminal=row.revoked_at!==null||row.consumed_at!==null||new Date(row.expires_at as Date|string).getTime()<=Date.now();
    return this.accessProjection(row,terminal?false:await this.accessIsCurrent(row,client));
  }

  async issueAgentAccess(reviewerActorId:string,submissionId:string,input:IssueResearchAdmissionAgentAccessInput,
    idempotencyKey:string,queueGrantId?:string,queueClaimId?:string):Promise<IssueResearchAdmissionAgentAccessResponse>{
    this.requireAgentSecret();
    if(!input||!exact(input as unknown as Record<string,unknown>,['expectedDecisionId','packageDigest'])||!DIGEST.test(input.packageDigest)
      ||!(input.expectedDecisionId===null||UUID.test(input.expectedDecisionId))||!KEY.test(idempotencyKey)
      ||!(queueGrantId===undefined&&queueClaimId===undefined||UUID.test(queueGrantId??'')&&UUID.test(queueClaimId??'')))
      fail('VALIDATION','Research admission agent access input is invalid.');
    if(!ACCOUNT.test(reviewerActorId)||!await this.options.isActorActive(reviewerActorId))fail('UNAUTHORIZED','A current active account is required.');
    const requestDigest=digestCanonicalJson({submissionId,packageDigest:input.packageDigest,expectedDecisionId:input.expectedDecisionId});
    try{return await this.transaction(async client=>{const state=await this.lockedState(client,reviewerActorId,submissionId);
      if(queueGrantId!==undefined){const queue=await client.query(`SELECT grant_row.expires_at FROM motive.project_review_queue_agent_grants grant_row
        JOIN motive.project_review_queue_agent_claims queue_claim ON queue_claim.grant_id=grant_row.id
          AND queue_claim.id=$4 AND queue_claim.project_id=grant_row.project_id AND queue_claim.submission_id=$5
          AND queue_claim.released_at IS NULL AND queue_claim.expired_at IS NULL AND queue_claim.consumed_at IS NULL
          AND queue_claim.assignment_expires_at>clock_timestamp()
        WHERE grant_row.id=$1 AND grant_row.project_id=$2 AND grant_row.reviewer_actor_id=$3
          AND grant_row.review_kind='MEMORY_ADMISSION' AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()
          AND (SELECT count(*) FROM motive.project_review_queue_agent_claims claim
            WHERE claim.grant_id=grant_row.id AND claim.consumed_at IS NOT NULL)<grant_row.max_decisions FOR SHARE OF grant_row,queue_claim`,
      [queueGrantId,state.authority.project_id,reviewerActorId,queueClaimId,submissionId]);if(queue.rowCount!==1)fail('FORBIDDEN','Review queue agent session is no longer active.');}
      const prior=await client.query(`SELECT * FROM motive.hypothesis_submission_admission_agent_access
        WHERE reviewer_actor_id=$1 AND issuance_idempotency_key=$2 FOR UPDATE`,[reviewerActorId,idempotencyKey]);
      if(prior.rowCount===1){const row=prior.rows[0];if(text(row,'issuance_request_digest')!==requestDigest)
        fail('CONFLICT','Idempotency-Key is already bound to another reviewer agent access request.');
        const raw=this.accessToken(text(row,'id'),reviewerActorId);if(this.tokenDigest(raw)!==text(row,'token_digest'))
          fail('CONFLICT','Retained reviewer agent access cannot be replayed with the configured token secret.');
        return{access:this.accessProjection(row,await this.accessIsCurrent(row,client)),token:raw};}
      const open=await client.query(`SELECT access.*,access.expires_at>clock_timestamp() AS unexpired
        FROM motive.hypothesis_submission_admission_agent_access access
        WHERE reviewer_actor_id=$1 AND delivery_id=$2 AND revoked_at IS NULL AND consumed_at IS NULL FOR UPDATE`,[reviewerActorId,state.deliveryId]);
      if(open.rowCount===1&&open.rows[0].unexpired!==true){
        await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access SET revoked_at=clock_timestamp()
          WHERE id=$1`,[open.rows[0].id]);
      }else if(open.rowCount===1)fail('CONFLICT','An unconsumed reviewer agent access already exists for this delivery. Revoke it before issuing another.');
      const reviewPackage=await this.sender.reviewPackage(state.deliveryId,client),packageDigest=digestCanonicalJson(reviewPackage);
      const latest=await this.tail(state.deliveryId,client);
      if(packageDigest!==input.packageDigest||(latest?.id??null)!==input.expectedDecisionId)
        fail('CONFLICT','Research admission preview is stale.');
      const id=randomUUID(),raw=this.accessToken(id,reviewerActorId),tokenDigest=this.tokenDigest(raw);
      const inserted=await client.query(`INSERT INTO motive.hypothesis_submission_admission_agent_access
        (id,project_id,submission_id,delivery_id,reviewer_actor_id,review_package,review_package_digest,expected_decision_id,
         token_digest,token_hint,issuance_idempotency_key,issuance_request_digest,expires_at,queue_grant_id)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,
           least(clock_timestamp()+interval '1 hour',coalesce((SELECT grant_row.expires_at
             FROM motive.project_review_queue_agent_grants grant_row WHERE grant_row.id=$13),clock_timestamp()+interval '1 hour')),$13) RETURNING *`,
      [id,state.authority.project_id,submissionId,state.deliveryId,reviewerActorId,JSON.stringify(reviewPackage),packageDigest,
        input.expectedDecisionId,tokenDigest,tokenDigest.slice(-12),idempotencyKey,requestDigest,queueGrantId??null]);
      return{access:this.accessProjection(inserted.rows[0],true),token:raw};
    });}catch(error){const code=(error as {code?:string}).code;if(code==='42501')fail('FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
      if(code==='40001'||code==='23505'||code==='23503'||code==='23514')fail('CONFLICT','Research admission agent access conflicts with retained state.');throw error;}
  }

  async revokeAgentAccess(reviewerActorId:string,submissionId:string,accessId:string,idempotencyKey:string):Promise<ResearchAdmissionAgentAccessResponse>{
    if(!ACCOUNT.test(reviewerActorId)||!UUID.test(submissionId)||!UUID.test(accessId)||!KEY.test(idempotencyKey))
      fail('VALIDATION','Research admission agent revoke request is invalid.');
    if(!await this.options.isActorActive(reviewerActorId))fail('UNAUTHORIZED','A current active account is required.');
    return this.transaction(async client=>{const found=await client.query(`SELECT * FROM motive.hypothesis_submission_admission_agent_access
      WHERE id=$1 AND reviewer_actor_id=$2 AND submission_id=$3 FOR UPDATE`,[accessId,reviewerActorId,submissionId]);
      if(found.rowCount!==1)fail('NOT_FOUND','Research admission agent access was not found.');
      const saved=found.rows[0].revoked_at===null?await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access
        SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING *`,[accessId]):found;
      return{access:this.accessProjection(saved.rows[0],false)};});
  }

  async authenticateReviewAgent(rawToken:string,allowConsumedQueueReplay=false):Promise<ResearchAdmissionAgentContext>{
    this.requireAgentSecret();if(!REVIEW_AGENT_TOKEN.test(rawToken))fail('UNAUTHORIZED','Research admission agent token is invalid.');
    const tokenDigest=this.tokenDigest(rawToken);const found=await this.options.pool.query(`SELECT access.*,access.expires_at>clock_timestamp() AS unexpired,
        queue_claim.id AS queue_claim_id,queue_claim.released_at AS queue_released_at,queue_claim.expired_at AS queue_expired_at,
        queue_claim.consumed_at AS queue_consumed_at,queue_grant.revoked_at AS queue_revoked_at,
        queue_grant.expires_at AS queue_expires_at,queue_grant.max_decisions AS queue_max_decisions,
        (SELECT count(*)::integer FROM motive.project_review_queue_agent_claims used
          WHERE used.grant_id=queue_grant.id AND used.consumed_at IS NOT NULL) AS queue_decisions_used
      FROM motive.hypothesis_submission_admission_agent_access access
      JOIN motive.memberships membership ON membership.project_id=access.project_id AND membership.actor_id=access.reviewer_actor_id
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
      JOIN motive.account_identities identity ON identity.actor_id=access.reviewer_actor_id AND identity.status='ACTIVE'
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=access.submission_id AND artifact.project_id=access.project_id
      JOIN motive.participation_agent_tokens contributor ON contributor.id=artifact.agent_token_id
        AND contributor.owner_actor_id<>access.reviewer_actor_id
      LEFT JOIN motive.project_review_queue_agent_grants queue_grant ON queue_grant.id=access.queue_grant_id
      LEFT JOIN motive.project_review_queue_agent_claims queue_claim ON queue_claim.child_access_id=access.id
      WHERE access.token_digest=$1`,[tokenDigest]);
    if(found.rowCount!==1)fail('UNAUTHORIZED','Research admission agent token is invalid.');const row=found.rows[0];
    const completedQueueReplay=allowConsumedQueueReplay&&row.consumed_at!==null&&row.queue_consumed_at!==null;
    if(row.revoked_at!==null||row.unexpired!==true||!this.packageIsRetained(row)
      ||(row.queue_grant_id!==null&&(row.queue_released_at!==null||row.queue_expired_at!==null
        ||(!completedQueueReplay&&row.queue_consumed_at!==null)||row.queue_revoked_at!==null
        ||new Date(row.queue_expires_at as Date|string).getTime()<=Date.now()
        ||(!completedQueueReplay&&Number(row.queue_decisions_used)>=Number(row.queue_max_decisions))))
      ||!await this.options.isActorActive(text(row,'reviewer_actor_id')))fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');
    return{accessId:text(row,'id'),tokenDigest,reviewerActorId:text(row,'reviewer_actor_id'),projectId:text(row,'project_id'),
      submissionId:text(row,'submission_id'),deliveryId:text(row,'delivery_id'),packageDigest:text(row,'review_package_digest'),
      expectedDecisionId:row.expected_decision_id===null?null:text(row,'expected_decision_id'),allowConsumedQueueReplay};
  }

  private async lockedAccess(client:PoolClient,context:ResearchAdmissionAgentContext,state:Awaited<ReturnType<HypothesisSubmissionAdmissionService['lockedState']>>){
    const queue=await client.query(`SELECT queue_claim.id AS queue_claim_id,queue_claim.released_at AS queue_released_at,
        queue_claim.expired_at AS queue_expired_at,queue_claim.consumed_at AS queue_consumed_at,
        queue_grant.revoked_at AS queue_revoked_at,queue_grant.expires_at>clock_timestamp() AS queue_unexpired,
        queue_grant.max_decisions AS queue_max_decisions,(SELECT count(*)::integer
          FROM motive.project_review_queue_agent_claims used WHERE used.grant_id=queue_grant.id AND used.consumed_at IS NOT NULL) AS queue_decisions_used
      FROM motive.hypothesis_submission_admission_agent_access queue_access
      JOIN motive.project_review_queue_agent_grants queue_grant ON queue_grant.id=queue_access.queue_grant_id
      LEFT JOIN motive.project_review_queue_agent_claims queue_claim ON queue_claim.child_access_id=queue_access.id
      WHERE queue_access.id=$1 FOR SHARE OF queue_grant`,[context.accessId]);
    const found=await client.query(`SELECT access.*,access.expires_at>clock_timestamp() AS unexpired
      FROM motive.hypothesis_submission_admission_agent_access access WHERE id=$1 FOR UPDATE`,[context.accessId]);
    if(found.rowCount!==1)fail('UNAUTHORIZED','Research admission agent token is invalid.');const row=found.rows[0];
    if(queue.rowCount===1)Object.assign(row,queue.rows[0]);
    if(text(row,'token_digest')!==context.tokenDigest||text(row,'reviewer_actor_id')!==context.reviewerActorId
      ||text(row,'project_id')!==context.projectId||text(row,'submission_id')!==context.submissionId
      ||text(row,'delivery_id')!==context.deliveryId||text(row,'delivery_id')!==state.deliveryId
      ||text(row,'review_package_digest')!==context.packageDigest
      ||(row.expected_decision_id===null?null:text(row,'expected_decision_id'))!==context.expectedDecisionId||!this.packageIsRetained(row))
      fail('UNAUTHORIZED','Research admission agent token binding is invalid.');
    const completedQueueReplay=context.allowConsumedQueueReplay===true&&row.consumed_at!==null&&row.queue_consumed_at!==null;
    if(row.revoked_at!==null||row.unexpired!==true
      ||(row.queue_grant_id!==null&&(row.queue_released_at!==null||row.queue_expired_at!==null
        ||(!completedQueueReplay&&row.queue_consumed_at!==null)||row.queue_revoked_at!==null||row.queue_unexpired!==true
        ||(!completedQueueReplay&&Number(row.queue_decisions_used)>=Number(row.queue_max_decisions)))))
      fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');return row;
  }

  private async reviewAgentResearchSnapshots(client:PoolClient,context:ResearchAdmissionAgentContext,
    access:QueryResultRow):Promise<ResearchAdmissionAgentSnapshotDescriptor[]>{
    const reviewPackage=storedObject(access.review_package,'review package');
    const packageDelivery=storedObject(reviewPackage.delivery,'review package delivery');
    if(typeof packageDelivery.sourceIntentId!=='string'||!UUID.test(packageDelivery.sourceIntentId)
      ||typeof packageDelivery.sourceIntentPayloadDigest!=='string'||!DIGEST.test(packageDelivery.sourceIntentPayloadDigest)
      ||packageDelivery.projectId!==context.projectId||packageDelivery.sourceSubmissionId!==context.submissionId)
      fail('CONFLICT','Stored review package source binding is invalid.');
    const result=await client.query(`SELECT intent.payload,intent.payload_digest,
        submission.claim_id,submission.work_order_id,submission.work_order_revision,submission.lease_epoch,
        artifact.agent_token_id,intent_row.project_id AS intent_project_id,intent_row.work_order_id AS intent_work_order_id,
        intent_row.work_order_revision AS intent_work_order_revision,
        intent_row.work_order_terms_digest AS intent_work_order_terms_digest,intent_row.lease_epoch AS intent_lease_epoch,
        intent_row.agent_token_id AS intent_agent_token_id,intent_row.research_context AS intent_research_context,
        intent_row.research_references AS intent_research_references
      FROM motive.hypothesis_writeback_intents intent
      JOIN motive.submissions submission ON submission.id=intent.source_submission_id
        AND submission.project_id=intent.project_id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
        AND artifact.project_id=submission.project_id
      LEFT JOIN motive.participation_claim_intents intent_row ON intent_row.claim_id=submission.claim_id
      WHERE intent.id=$1 AND intent.project_id=$2 AND intent.source_submission_id=$3 AND intent.payload_digest=$4`,
    [packageDelivery.sourceIntentId,context.projectId,context.submissionId,packageDelivery.sourceIntentPayloadDigest]);
    if(result.rowCount!==1)fail('CONFLICT','Stored review package source is unavailable.');
    const row=result.rows[0],payload=storedObject(row.payload,'review package source payload');
    if(text(row,'payload_digest')!==packageDelivery.sourceIntentPayloadDigest
      ||digestCanonicalJson(payload)!==packageDelivery.sourceIntentPayloadDigest)
      fail('CONFLICT','Stored review package source digest is invalid.');
    const scope=storedObject(payload.scope,'review package source scope');
    const attribution=storedObject(payload.attribution,'review package source attribution');
    const source=storedObject(payload.source,'review package source');
    const submission=storedObject(source.submission,'review package source submission');
    const claim=storedObject(source.claim,'review package source claim');
    const workOrder=storedObject(source.workOrder,'review package source work order');
    if(scope.projectId!==context.projectId||submission.id!==context.submissionId||claim.id!==row.claim_id
      ||claim.leaseEpoch!==Number(row.lease_epoch)||workOrder.id!==row.work_order_id
      ||workOrder.revision!==Number(row.work_order_revision)||attribution.agentTokenId!==row.agent_token_id)
      fail('CONFLICT','Stored review package source bindings are invalid.');

    const all:Array<{citation:SnapshotCitation;declaredIn:'PRE_TEST_INTENT'|'SUBMISSION_NOTES'}>=[];
    if(row.intent_project_id!==null){
      if(row.intent_project_id!==context.projectId||row.intent_work_order_id!==workOrder.id
        ||Number(row.intent_work_order_revision)!==workOrder.revision
        ||row.intent_work_order_terms_digest!==workOrder.termsDigest||Number(row.intent_lease_epoch)!==claim.leaseEpoch
        ||row.intent_agent_token_id!==attribution.agentTokenId)
        fail('CONFLICT','Stored pre-test intent binding is invalid.');
      const intentCitations=snapshotCitations({researchContext:row.intent_research_context,
        researchReferences:row.intent_research_references},'pre-test intent');
      for(const citation of intentCitations)all.push({citation,declaredIn:'PRE_TEST_INTENT'});
    }else if(row.intent_research_context!==null||row.intent_research_references!==null){
      fail('CONFLICT','Stored pre-test intent is invalid.');
    }
    const envelope=storedObject(source.investigation,'review package source investigation');
    const notes=storedObject(envelope.investigation,'review package source investigation notes');
    for(const citation of snapshotCitations(notes,'submission notes'))all.push({citation,declaredIn:'SUBMISSION_NOTES'});
    if(all.length>22)fail('CONFLICT','Stored review package has too many research snapshot citations.');

    const descriptors:ResearchAdmissionAgentSnapshotDescriptor[]=[];
    const byId=new Map<string,ResearchAdmissionAgentSnapshotDescriptor>();
    for(const {citation,declaredIn} of all){
      const prior=byId.get(citation.snapshotId);
      if(prior){
        if(prior.scopeId!==citation.scopeId||prior.snapshotDigest!==citation.snapshotDigest)
          fail('CONFLICT','Stored review package cites one research snapshot inconsistently.');
        if(!prior.declaredIn.includes(declaredIn))
          (prior.declaredIn as Array<'PRE_TEST_INTENT'|'SUBMISSION_NOTES'>).push(declaredIn);
        continue;
      }
      const descriptor:ResearchAdmissionAgentSnapshotDescriptor={...citation,declaredIn:[declaredIn],
        href:`/api/review-agent/research-context/snapshots/${citation.snapshotId}`};
      descriptors.push(descriptor);byId.set(citation.snapshotId,descriptor);
    }
    return descriptors;
  }

  private async lockedCurrentReviewAgentAccess(client:PoolClient,context:ResearchAdmissionAgentContext){
    const state=await this.lockedState(client,context.reviewerActorId,context.submissionId);
    const access=await this.lockedAccess(client,context,state);
    if(access.consumed_at!==null)fail('CONFLICT','This reviewer agent access already recorded its one decision.');
    const currentPackage=await this.sender.reviewPackage(state.deliveryId,client),latest=await this.tail(state.deliveryId,client);
    if(digestCanonicalJson(currentPackage)!==text(access,'review_package_digest')
      ||(latest?.id??null)!==(access.expected_decision_id===null?null:text(access,'expected_decision_id')))
      fail('CONFLICT','Research admission preview is stale.');
    return{state,access,researchSnapshots:await this.reviewAgentResearchSnapshots(client,context,access)};
  }

  private async markReviewAgentSeen(client:PoolClient,context:ResearchAdmissionAgentContext){
    const seen=await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access
      SET first_seen_at=coalesce(first_seen_at,clock_timestamp()),last_seen_at=clock_timestamp()
      WHERE id=$1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`,[context.accessId]);
    if(seen.rowCount!==1)fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');
    return seen.rows[0];
  }

  async reviewAgentAssignment(context:ResearchAdmissionAgentContext):Promise<ResearchAdmissionAgentAssignment>{
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');
    return this.transaction(async client=>{const {state,access,researchSnapshots}=await this.lockedCurrentReviewAgentAccess(client,context);
      const seen=await this.markReviewAgentSeen(client,context);
      const links=await client.query(`SELECT submission.provenance ? 'investigation' AS has_investigation,
        reproducibility.submission_id IS NOT NULL AS has_reproducibility FROM motive.submissions submission
        LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
        WHERE submission.id=$1`,[context.submissionId]);const slug=text(state.authority,'project_slug');
      return{format:'motive.research-admission-agent-assignment/0.1',accessId:context.accessId,submissionId:context.submissionId,
        package:access.review_package as ResearchDeliveryReviewPackage,packageDigest:text(access,'review_package_digest'),
        expectedDecisionId:access.expected_decision_id===null?null:text(access,'expected_decision_id'),expiresAt:dateText(seen.expires_at),
        reportHref:`/api/public/projects/${slug}/submissions/${context.submissionId}/report`,
        investigationHref:links.rows[0]?.has_investigation?`/api/public/projects/${slug}/submissions/${context.submissionId}/investigation`:null,
        reproducibilityHref:links.rows[0]?.has_reproducibility?`/api/public/projects/${slug}/submissions/${context.submissionId}/reproducibility`:null,
        researchSnapshots};});
  }

  async reviewAgentSnapshot(context:ResearchAdmissionAgentContext,snapshotId:string):Promise<ResearchRetainedSnapshot>{
    if(!UUID.test(snapshotId)||snapshotId!==snapshotId.toLowerCase())fail('NOT_FOUND','Research snapshot not found.');
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');
    return this.transaction(async client=>{const {researchSnapshots}=await this.lockedCurrentReviewAgentAccess(client,context);
      const citation=researchSnapshots.find(item=>item.snapshotId===snapshotId);
      if(!citation)fail('NOT_FOUND','Research snapshot not found.');
      const found=await client.query(`SELECT snapshot.id,snapshot.project_id,snapshot.scope_id,snapshot.retrieved_at,
          snapshot.payload,snapshot.snapshot_digest
        FROM motive.research_context_snapshots snapshot WHERE snapshot.project_id=$1 AND snapshot.id=$2`,
      [context.projectId,snapshotId]);
      if(found.rowCount!==1)fail('NOT_FOUND','Research snapshot not found.');
      const row=found.rows[0],payload=storedObject(row.payload,'research snapshot payload');
      const retrievedAt=row.retrieved_at instanceof Date?row.retrieved_at:new Date(String(row.retrieved_at));
      if(text(row,'id')!==snapshotId||text(row,'project_id')!==context.projectId||text(row,'scope_id')!==citation.scopeId
        ||text(row,'snapshot_digest')!==citation.snapshotDigest||payload.scopeId!==citation.scopeId
        ||!['motive.research-context.v1','motive.research-hypothesis-context.v1'].includes(String(payload.format))
        ||Buffer.byteLength(JSON.stringify(payload),'utf8')>MAX_RETAINED_SNAPSHOT_BYTES
        ||digestCanonicalJson(payload)!==citation.snapshotDigest||!Number.isFinite(retrievedAt.getTime()))
        fail('CONFLICT','Cited research snapshot differs from its immutable citation.');
      await this.markReviewAgentSeen(client,context);
      return{...payload,snapshotId,retrievedAt:retrievedAt.toISOString(),snapshotDigest:citation.snapshotDigest,
        notice:SNAPSHOT_NOTICE} as ResearchRetainedSnapshot;});
  }

  async decideAdmissionFromAgent(context:ResearchAdmissionAgentContext,input:DecideResearchAdmissionFromAgentInput,
    idempotencyKey:string):Promise<ResearchAdmissionAgentDecision>{
    if(!input||!exact(input as unknown as Record<string,unknown>,['decision','rationale'])||!['ADMIT','DECLINE'].includes(input.decision)
      ||typeof input.rationale!=='string'||input.rationale.trim()!==input.rationale||input.rationale.length<1||input.rationale.length>2000
      ||!KEY.test(idempotencyKey))fail('VALIDATION','Research admission agent decision input is invalid.');
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Research admission agent token is invalid or expired.');
    const bodyDigest=digestCanonicalJson(input),downstreamKey=`review-agent-${context.accessId}`;
    try{const retained=await this.transaction(async client=>{const state=await this.lockedState(client,context.reviewerActorId,context.submissionId);
      const access=await this.lockedAccess(client,context,state);if(access.consumed_at!==null&&text(access,'consumed_request_digest')!==bodyDigest)
        fail('CONFLICT','This reviewer agent access is already bound to another decision.');
      const bound:DecideResearchDeliveryAdmissionInput={packageDigest:text(access,'review_package_digest'),
        expectedDecisionId:access.expected_decision_id===null?null:text(access,'expected_decision_id'),decision:input.decision,rationale:input.rationale};
      const decided=await this.insertDecision(client,context.reviewerActorId,context.submissionId,bound,downstreamKey,state);
      if(access.consumed_at===null){await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access
        SET first_seen_at=coalesce(first_seen_at,clock_timestamp()),last_seen_at=clock_timestamp(),consumed_decision_id=$2,
          consumed_idempotency_key=$3,consumed_request_digest=$4,consumed_at=clock_timestamp() WHERE id=$1`,
      [context.accessId,decided.id,idempotencyKey,bodyDigest]);
        if(access.queue_claim_id!==null)await client.query(`UPDATE motive.project_review_queue_agent_claims
          SET consumed_decision_id=$2,consumed_at=(SELECT consumed_at
            FROM motive.hypothesis_submission_admission_agent_access WHERE id=$3)
          WHERE id=$1 AND consumed_at IS NULL`,[access.queue_claim_id,decided.id,context.accessId]);}
      return decided;});
      return{format:'motive.research-admission-agent-decision/0.1',submissionId:context.submissionId,packageDigest:retained.packageDigest,
        decision:retained.decision,rationale:retained.rationale,reviewedAt:retained.createdAt};
    }catch(error){const code=(error as {code?:string}).code;if(code==='42501')fail('FORBIDDEN','Independent current reviewer, owner, or steward authority is required.');
      if(code==='40001'||code==='23505'||code==='23503'||code==='23514')fail('CONFLICT','Research admission agent decision conflicts with retained state.');throw error;}
  }

  private async automaticPolicy(client:PoolClient,projectId:string,submissionId:string,contract:ReviewedWritebackContract,
    deliveryMode:ResearchDeliveryMode,binding?:{scopeId:string;apiBaseUrl:string;configurationDigest:string;policyId:string},targetScopeId?:string){
    const candidates=await client.query(`SELECT policy.id,policy.scope_id FROM motive.project_research_delivery_policies policy
      JOIN motive.submissions submission ON submission.id=$2 AND submission.project_id=policy.project_id
      WHERE policy.project_id=$1 AND policy.reviewed_contract_digest=$3 AND policy.reviewed_contract_version=$4
        AND policy.reviewed_contract_surface_digest=$5 AND policy.reviewed_implementation_digest=$6
        AND policy.engine_api_version=$7 AND policy.delivery_mode=$8 AND ($9::uuid IS NULL OR policy.scope_id=$9)
        AND ($10::uuid IS NULL OR policy.id=$10)
      ORDER BY policy.created_at DESC,policy.id DESC LIMIT 20`,[projectId,submissionId,contract.fileDigest,
      contract.contractVersion,contract.surfaceDigest,contract.implementationDigest,contract.apiVersion,deliveryMode,binding?.scopeId??targetScopeId??null,
      binding?.policyId??null]);
    for(const candidate of candidates.rows){const authority=await currentPolicyAuthority(client,text(candidate,'id'),{
        projectId,scopeId:text(candidate,'scope_id'),submissionId,...(binding?{apiBaseUrl:binding.apiBaseUrl,
          configurationDigest:binding.configurationDigest}:{}),apiVersion:contract.apiVersion,contractDigest:contract.fileDigest,
        contractVersion:contract.contractVersion,contractSurfaceDigest:contract.surfaceDigest,
          implementationDigest:contract.implementationDigest,deliveryMode});
      if(authority)return authority;}
    return null;
  }

  private async lockedAgentFinding(client:PoolClient,context:AgentMemoryAdmissionContext,findingDecisionId:string){
    const found=await client.query(`SELECT finding.*
      FROM motive.finding_review_decisions finding
      JOIN motive.participation_agent_tokens review_token ON review_token.id=finding.reviewer_agent_token_id
      JOIN motive.memberships membership ON membership.project_id=finding.project_id
        AND membership.actor_id=finding.reviewer_actor_id
      JOIN motive.account_identities identity ON identity.actor_id=finding.reviewer_actor_id
      JOIN motive.participation_claim_completions source_completion ON source_completion.submission_id=finding.source_submission_id
      JOIN motive.participation_claim_completions review_completion ON review_completion.submission_id=finding.review_submission_id
      WHERE finding.id=$1
      FOR SHARE OF finding,review_token,membership,identity,source_completion,review_completion`,[findingDecisionId]);
    if(found.rowCount!==1)fail('FORBIDDEN','A current accepted exact replication finding is required.');
    const row=found.rows[0];
    const fresh=await client.query(`SELECT
        NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
          WHERE successor.previous_decision_id=$1) AS is_current,
        motive.valid_agent_finding_review_proof($2,$3,$4,$5,$6) AS proof_valid`,
      [findingDecisionId,row.reviewer_actor_id,row.reviewer_agent_token_id,row.review_submission_id,
        row.source_submission_id,row.project_id]);
    row.is_current=fresh.rows[0]?.is_current;row.proof_valid=fresh.rows[0]?.proof_valid;
    if(row.reviewer_actor_id!==context.ownerActorId||row.reviewer_agent_token_id!==context.tokenId
      ||row.project_id!==context.projectId||row.review_submission_id===null
      ||!['motive.finding-review-package/0.2','motive.finding-review-package/0.3'].includes(String(row.review_package?.format))
      ||row.proof_valid!==true)
      fail('FORBIDDEN','A current accepted exact replication finding is required.');
    return row;
  }

  /**
   * Post-finding mutation hook. It prepares only under an already-current owner
   * policy and never executes an engine request.
   */
  async admitFromAgentFinding(context:AgentMemoryAdmissionContext,findingDecisionId:string):Promise<FindingReviewMemoryStatus>{
    if(!context||!UUID.test(context.tokenId)||!ACCOUNT.test(context.ownerActorId)||!UUID.test(context.projectId)
      ||!UUID.test(findingDecisionId))fail('VALIDATION','Automatic memory admission identity is invalid.');
    const initial=await this.transaction(async client=>{
      const finding=await this.lockedAgentFinding(client,context,findingDecisionId);
      if(finding.is_current!==true)return{status:'PENDING',reason:'REVIEW_NO_LONGER_CURRENT'} as const;
      if(finding.decision==='DECLINE')return{status:'NOT_REQUESTED',reason:'FINDING_DECLINED'} as const;
      if(finding.decision!=='ACCEPT')fail('CONFLICT','Stored finding decision is invalid.');
      const submissionId=text(finding,'source_submission_id');
      const deliveryMode:ResearchDeliveryMode=finding.review_package?.format==='motive.finding-review-package/0.3'
        ?'APPEND_EXISTING':'NEW_DRAFT';
      const deliveries=await client.query(`SELECT scope_id,engine_api_base_url,scope_configuration_digest,engine_api_version,
          reviewed_contract_digest,reviewed_contract_version,reviewed_contract_surface_digest,reviewed_implementation_digest,
           created_by_actor_id,delivery_mode,target_binding
        FROM motive.hypothesis_submission_deliveries WHERE project_id=$1 AND source_submission_id=$2
        ORDER BY created_at,id FOR SHARE`,[context.projectId,submissionId]);
      let contract:ReviewedWritebackContract=PINNED_REVIEWED_WRITEBACK_CONTRACT;
      let binding:{scopeId:string;apiBaseUrl:string;configurationDigest:string;policyId:string}|undefined;
      if(deliveries.rowCount){
        if(deliveries.rowCount!==1)return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'} as const;
        const row=deliveries.rows[0];const retained=registeredReviewedWritebackContract({fileDigest:row.reviewed_contract_digest,
          contractVersion:row.reviewed_contract_version,apiVersion:row.engine_api_version,schemaRevision:'017_write_idempotency',
          surfaceDigest:row.reviewed_contract_surface_digest,implementationDigest:row.reviewed_implementation_digest});
        if(!retained)return{status:'PENDING',reason:'CONTRACT_UNAVAILABLE'} as const;
        const policyId=policyIdFromPrincipal(text(row,'created_by_actor_id'));
        if(!policyId)return{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'} as const;
        if(row.delivery_mode!==deliveryMode)return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'} as const;contract=retained;
        if(deliveryMode==='APPEND_EXISTING'&&digestCanonicalJson(row.target_binding)!==digestCanonicalJson(finding.review_package.source.target))
          return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'} as const;
        binding={scopeId:text(row,'scope_id'),apiBaseUrl:text(row,'engine_api_base_url'),
          configurationDigest:text(row,'scope_configuration_digest'),policyId};
      }
      const targetScopeId=deliveryMode==='APPEND_EXISTING'?String(finding.review_package.source.target.selection.scopeId):undefined;
      const authority=await this.automaticPolicy(client,context.projectId,submissionId,contract,deliveryMode,binding,targetScopeId);
      if(!authority){
          if(!deliveries.rowCount&&deliveryMode==='NEW_DRAFT'){const older=await this.automaticPolicy(client,context.projectId,submissionId,
            // A cap2-only owner policy cannot authorize a newly prepared cap3 delivery.
            LEGACY_REVIEWED_WRITEBACK_CONTRACT,deliveryMode);
          if(older)return{status:'PENDING',reason:'CONTRACT_UNAVAILABLE'} as const;}
        return{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'} as const;
      }
      if(!await this.options.isActorActive(authority.approvedByActorId))
        return{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'} as const;
      return{status:'READY' as const,authority,contract,submissionId,deliveryMode};
    });
    if(initial.status!=='READY')return initial;

    let prepared:Awaited<ReturnType<HypothesisSubmissionDeliveryService['syncWithPolicyPrincipal']>>;
    try{prepared=await this.sender.syncWithPolicyPrincipal(initial.authority.policyId,{
      projectSlug:initial.authority.projectSlug,scopeId:initial.authority.scopeId,submissionId:initial.submissionId,
      idempotencyKey:`agent-admission-${findingDecisionId}`,approvedApiBaseUrl:initial.authority.apiBaseUrl,
      contract:initial.contract,execute:false});}
    catch(error){const code=(error as {code?:string}).code;
      if(['FORBIDDEN','NOT_FOUND','CONFLICT'].includes(String(code)))return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'};
      throw error;}
    if(!prepared.deliveryId)return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'};
    const deliveryId=prepared.deliveryId;

    return this.transaction(async client=>{
      const finding=await this.lockedAgentFinding(client,context,findingDecisionId);
      if(finding.is_current!==true)return{status:'PENDING',reason:'REVIEW_NO_LONGER_CURRENT'};
      if(finding.decision!=='ACCEPT')return finding.decision==='DECLINE'
        ?{status:'NOT_REQUESTED',reason:'FINDING_DECLINED'}:{status:'PENDING',reason:'REVIEW_NO_LONGER_CURRENT'};
      const authority=await currentPolicyAuthority(client,initial.authority.policyId,{projectId:context.projectId,
        scopeId:initial.authority.scopeId,submissionId:initial.submissionId,apiBaseUrl:initial.authority.apiBaseUrl,
        configurationDigest:initial.authority.configurationDigest,apiVersion:initial.authority.apiVersion,
        contractDigest:initial.authority.contractDigest,contractVersion:initial.authority.contractVersion,
         contractSurfaceDigest:initial.authority.contractSurfaceDigest,implementationDigest:initial.authority.implementationDigest,
         deliveryMode:initial.deliveryMode});
      if(!authority||!await this.options.isActorActive(authority.approvedByActorId))
        return{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'};
      const delivery=await client.query(`SELECT id FROM motive.hypothesis_submission_deliveries
        WHERE id=$1 AND project_id=$2 AND scope_id=$3 AND source_submission_id=$4 FOR UPDATE`,
      [deliveryId,context.projectId,authority.scopeId,initial.submissionId]);
      if(delivery.rowCount!==1)return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'};
      const reviewPackage=await this.sender.reviewPackage(deliveryId,client),packageDigest=digestCanonicalJson(reviewPackage);
      const rationale='An independent completed replication accepted this exact finding for shared-memory retention.';
      const idempotencyKey=`agent-memory-${findingDecisionId}`;
      const requestDigest=digestCanonicalJson({findingDecisionId,deliveryId,packageDigest,
        expectedDecisionId:null,decision:'ADMIT',rationale});
      const existing=await client.query(`SELECT * FROM motive.hypothesis_submission_delivery_admission_decisions
        WHERE finding_decision_id=$1 OR (reviewer_actor_id=$2 AND idempotency_key=$3) FOR UPDATE`,
      [findingDecisionId,context.ownerActorId,idempotencyKey]);
      if(existing.rowCount){const row=existing.rows[0];
        if(existing.rowCount!==1||row.finding_decision_id!==findingDecisionId||row.delivery_id!==deliveryId
          ||row.reviewer_actor_id!==context.ownerActorId||row.review_package_digest!==packageDigest
          ||row.previous_decision_id!==null||row.decision!=='ADMIT'||row.rationale!==rationale
          ||row.idempotency_key!==idempotencyKey||row.request_digest!==requestDigest
          ||digestCanonicalJson(row.review_package)!==packageDigest)
          fail('CONFLICT','Automatic memory admission replay conflicts with retained state.');
        const currentTail=await client.query(`SELECT item.id FROM motive.hypothesis_submission_delivery_admission_decisions item
          WHERE item.delivery_id=$1 AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
            WHERE successor.previous_decision_id=item.id) FOR UPDATE`,[deliveryId]);
        if(currentTail.rowCount!==1||currentTail.rows[0].id!==row.id)
          return{status:'PENDING',reason:'REVIEW_NO_LONGER_CURRENT'};
        return{status:'ADMITTED',admissionDecisionId:text(row,'id')};}
      const latest=await client.query(`SELECT item.id FROM motive.hypothesis_submission_delivery_admission_decisions item
        WHERE item.delivery_id=$1 AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
          WHERE successor.previous_decision_id=item.id) FOR UPDATE`,[deliveryId]);
      if(latest.rowCount)return{status:'PENDING',reason:'MEMORY_UNAVAILABLE'};
      const inserted=await client.query(`INSERT INTO motive.hypothesis_submission_delivery_admission_decisions
        (id,delivery_id,review_package,review_package_digest,previous_decision_id,decision,reviewer_actor_id,rationale,
         idempotency_key,request_digest,finding_decision_id)
        VALUES($1,$2,$3::jsonb,$4,NULL,'ADMIT',$5,$6,$7,$8,$9) RETURNING id`,
      [randomUUID(),deliveryId,JSON.stringify(reviewPackage),packageDigest,context.ownerActorId,rationale,
        idempotencyKey,requestDigest,findingDecisionId]);
      return{status:'ADMITTED',admissionDecisionId:text(inserted.rows[0],'id')};
    });
  }

  async publicAdmission(projectSlug:string,submissionId:string):Promise<PublicResearchDeliveryAdmission>{
    if(!/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectSlug)||!UUID.test(submissionId))fail('NOT_FOUND','Submission was not found.');
    const result=await this.options.pool.query(`SELECT delivery.id,(SELECT count(*) FROM motive.hypothesis_submission_delivery_results r WHERE r.delivery_id=delivery.id)::integer AS result_count
      FROM motive.projects project JOIN motive.submissions submission ON submission.project_id=project.id AND submission.id=$2
      LEFT JOIN LATERAL (SELECT item.id FROM motive.hypothesis_submission_deliveries item
        WHERE item.project_id=project.id AND item.source_submission_id=submission.id ORDER BY item.created_at DESC,item.id DESC LIMIT 1) delivery ON true
      WHERE project.slug=$1 AND project.visibility='PUBLIC'`,[projectSlug,submissionId]);
    if(result.rowCount!==1)fail('NOT_FOUND','Submission was not found.');if(result.rows[0].id===null)return{format:'motive.research-delivery-admission-public/0.1',submissionId,status:'PENDING',latestReview:null};
    const deliveryId=text(result.rows[0],'id');const latest=await this.tail(deliveryId);if(!latest)return{format:'motive.research-delivery-admission-public/0.1',submissionId,
      status:Number(result.rows[0].result_count)>0?'DELIVERED_UNREVIEWED':'PENDING',latestReview:null};
    let current=false;try{const pkg=await this.sender.reviewPackage(deliveryId);current=digestCanonicalJson(pkg)===latest.packageDigest;
      const provenance=await this.options.pool.query(`SELECT finding_decision_id FROM motive.hypothesis_submission_delivery_admission_decisions
        WHERE id=$1`,[latest.id]);const findingDecisionId=provenance.rows[0]?.finding_decision_id as string|null|undefined;
      if(findingDecisionId){const client=await this.options.pool.connect();try{await client.query('BEGIN');
          const delivery=await client.query(`SELECT project_id,scope_id,source_submission_id,engine_api_base_url,
              scope_configuration_digest,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
              reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id
            FROM motive.hypothesis_submission_deliveries
            WHERE id=$1 FOR SHARE`,[deliveryId]);
          if(delivery.rowCount!==1)current=false;else{const row=delivery.rows[0],policyId=policyIdFromPrincipal(text(row,'created_by_actor_id'));
            const proof=await client.query(
              `SELECT motive.valid_agent_memory_admission_proof($1,$2,$3) AS valid`,[latest.reviewerActorId,findingDecisionId,deliveryId]);
            const policy=policyId?await currentPolicyAuthority(client,policyId,{projectId:text(row,'project_id'),
              scopeId:text(row,'scope_id'),submissionId:text(row,'source_submission_id'),apiBaseUrl:text(row,'engine_api_base_url'),
              configurationDigest:text(row,'scope_configuration_digest'),apiVersion:text(row,'engine_api_version'),
              contractDigest:text(row,'reviewed_contract_digest'),contractVersion:text(row,'reviewed_contract_version'),
              contractSurfaceDigest:text(row,'reviewed_contract_surface_digest'),implementationDigest:text(row,'reviewed_implementation_digest')}):null;
            current=current&&proof.rows[0]?.valid===true&&Boolean(policy)
              &&await this.options.isActorActive(latest.reviewerActorId)
              &&await this.options.isActorActive(policy?.approvedByActorId??'');}
          await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
      else{const reviewer=await this.authority(latest.reviewerActorId,submissionId);current=current&&reviewer.reason==='ELIGIBLE';}}
    catch{current=false;}
    return{format:'motive.research-delivery-admission-public/0.1',submissionId,status:current?(latest.decision==='ADMIT'?'ADMITTED':'DECLINED'):'STALE',
      latestReview:{decision:latest.decision,rationale:latest.rationale,reviewedAt:latest.createdAt}};
  }
}
export function createHypothesisSubmissionAdmissionService(options:SubmissionAdmissionOptions){return new HypothesisSubmissionAdmissionService(options);}
