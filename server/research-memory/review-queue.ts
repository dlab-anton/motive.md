import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import {
  REVIEW_QUEUE_KIND,
  type CreateReviewQueueGrantInput,
  type CreateReviewQueueGrantResponse,
  type ReleaseReviewQueueClaimInput,
  type ReviewQueueAgentState,
  type ReviewQueueClaimResponse,
  type ReviewQueueGrant,
  type ReviewQueueGrantList,
  type ReleaseReviewQueueClaimResponse,
} from '../../src/lib/review-queue.ts';
import {
  HypothesisSubmissionAdmissionService,
  SubmissionAdmissionError,
  type ResearchAdmissionAgentAccessProjection,
} from './submission-admission.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACCOUNT=/^account:[A-Za-z0-9._~-]{1,480}$/;
const KEY=/^[A-Za-z0-9._~-]{8,200}$/;
const TOKEN=/^motive_review_queue_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/;
const PROJECT='circle-packing' as const;
const EMPTY_RETRY_SECONDS=30;

export class ReviewQueueError extends Error{
  constructor(readonly code:'VALIDATION'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT',message:string,
    readonly statusCode:400|401|403|404|409=code==='VALIDATION'?400:code==='UNAUTHORIZED'?401:code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:409){
    super(message);this.name='ReviewQueueError';
  }
}
function fail(code:ReviewQueueError['code'],message:string):never{throw new ReviewQueueError(code,message);}
function text(row:QueryResultRow,key:string):string{const value=row[key];if(typeof value!=='string'||!value)fail('CONFLICT',`Stored ${key} is invalid.`);return value;}
function iso(value:unknown):string{return(value instanceof Date?value:new Date(String(value))).toISOString();}

export type ReviewQueueAgentContext=Readonly<{grantId:string;tokenDigest:string;reviewerActorId:string;projectId:string}>;
export type ResearchReviewQueueServiceOptions=Readonly<{
  pool:Pool;
  admission:HypothesisSubmissionAdmissionService;
  tokenSecret:string;
  isActorActive(actorId:string):Promise<boolean>;
  now?:()=>Date;
}>;

export class ResearchReviewQueueService{
  private readonly now:()=>Date;
  constructor(private readonly options:ResearchReviewQueueServiceOptions){
    if(Buffer.byteLength(options.tokenSecret,'utf8')<32)throw new Error('Review queue agent token secret must be at least 32 UTF-8 bytes.');
    this.now=options.now??(()=>new Date());
  }

  private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.options.pool.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
  private rawToken(id:string,actorId:string):string{const signature=createHmac('sha256',this.options.tokenSecret)
    .update(`motive-review-queue-agent-v1\0${id}\0${actorId}`).digest('base64url');return`motive_review_queue_${id.replaceAll('-','')}_${signature}`;}
  private digest(token:string):string{return`sha256:${createHash('sha256').update(token).digest('hex')}`;}

  private async authority(client:Pool|PoolClient,actorId:string,lock=false):Promise<string>{
    if(!ACCOUNT.test(actorId))fail('UNAUTHORIZED','A current reviewer account is required.');
    const found=await client.query(`SELECT project.id FROM motive.projects project
      JOIN motive.memberships membership ON membership.project_id=project.id AND membership.actor_id=$2
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
      JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id AND identity.status='ACTIVE'
      WHERE project.slug=$1 AND project.visibility='PUBLIC' ${lock?'FOR SHARE OF membership,identity':''}`,[PROJECT,actorId]);
    if(found.rowCount!==1)fail('FORBIDDEN','Current project reviewer authority is required.');
    return text(found.rows[0],'id');
  }

  private projection(row:QueryResultRow):ReviewQueueGrant{
    const used=Number(row.decisions_used??0),max=Number(row.max_decisions),revokedAt=row.revoked_at===null?null:iso(row.revoked_at);
    const expired=row.unexpired===undefined?new Date(row.expires_at as Date|string).getTime()<=this.now().getTime():row.unexpired!==true;
    const status:ReviewQueueGrant['status']=revokedAt?'REVOKED':expired?'EXPIRED':used>=max?'EXHAUSTED':'ACTIVE';
    return{id:text(row,'id'),projectSlug:PROJECT,reviewKind:REVIEW_QUEUE_KIND,status,maxDecisions:max,decisionsUsed:used,
      remainingDecisions:Math.max(0,max-used),expiresAt:iso(row.expires_at),revokedAt,
      firstSeenAt:row.first_seen_at===null?null:iso(row.first_seen_at),lastSeenAt:row.last_seen_at===null?null:iso(row.last_seen_at),
      createdAt:iso(row.created_at),currentAssignment:row.current_submission_id===null||row.current_submission_id===undefined?null:{
        submissionId:text(row,'current_submission_id'),question:row.current_question===null?null:text(row,'current_question'),claimedAt:iso(row.current_claimed_at),
        firstSeenAt:row.current_first_seen_at===null?null:iso(row.current_first_seen_at)}};
  }

  private grantSql(where:string):string{return`SELECT grant_row.*,grant_row.expires_at>clock_timestamp() AS unexpired,
      (SELECT count(*)::integer FROM motive.project_review_queue_agent_claims used
        WHERE used.grant_id=grant_row.id AND used.consumed_at IS NOT NULL) AS decisions_used,
      current_claim.submission_id AS current_submission_id,current_claim.created_at AS current_claimed_at,
      coalesce(current_assessment.public_question,current_submission.provenance#>>'{investigation,investigation,proposal}') AS current_question,
      child.first_seen_at AS current_first_seen_at
    FROM motive.project_review_queue_agent_grants grant_row
    LEFT JOIN LATERAL (SELECT claim.submission_id,claim.child_access_id,claim.created_at
      FROM motive.project_review_queue_agent_claims claim WHERE claim.grant_id=grant_row.id
        AND claim.released_at IS NULL AND claim.expired_at IS NULL AND claim.consumed_at IS NULL
        AND claim.assignment_expires_at>clock_timestamp() ORDER BY claim.created_at DESC,claim.id DESC LIMIT 1) current_claim ON true
    LEFT JOIN motive.submissions current_submission ON current_submission.id=current_claim.submission_id
      AND current_submission.project_id=grant_row.project_id
    LEFT JOIN motive.participation_post_check_assessments current_assessment
      ON current_assessment.submission_id=current_submission.id AND current_assessment.project_id=grant_row.project_id
    LEFT JOIN motive.hypothesis_submission_admission_agent_access child ON child.id=current_claim.child_access_id ${where}`;}

  async createGrant(actorId:string,input:CreateReviewQueueGrantInput,idempotencyKey:string):Promise<CreateReviewQueueGrantResponse>{
    if(!Number.isInteger(input?.maxDecisions)||input.maxDecisions<1||input.maxDecisions>10||!KEY.test(idempotencyKey))
      fail('VALIDATION','Review queue agent access request is invalid.');
    await this.authority(this.options.pool,actorId);if(!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current reviewer account is required.');
    const requestDigest=digestCanonicalJson({reviewKind:REVIEW_QUEUE_KIND,maxDecisions:input.maxDecisions});
    return this.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`review-queue-grant:${actorId}`]);
      const projectId=await this.authority(client,actorId,true);
      const prior=await client.query(this.grantSql('WHERE grant_row.reviewer_actor_id=$1 AND grant_row.issuance_idempotency_key=$2 FOR UPDATE OF grant_row'),[actorId,idempotencyKey]);
      if(prior.rowCount===1){const row=prior.rows[0];if(text(row,'issuance_request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is already bound to another review queue request.');
        const token=this.rawToken(text(row,'id'),actorId);if(this.digest(token)!==text(row,'token_digest'))fail('CONFLICT','Retained review queue access cannot be recovered.');
        return{grant:this.projection(row),token};}
      const current=await client.query(`SELECT id FROM motive.project_review_queue_agent_grants
        WHERE project_id=$1 AND reviewer_actor_id=$2 AND review_kind=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()
          AND (SELECT count(*) FROM motive.project_review_queue_agent_claims claim WHERE claim.grant_id=project_review_queue_agent_grants.id AND claim.consumed_at IS NOT NULL)<max_decisions
        FOR UPDATE`,[projectId,actorId,REVIEW_QUEUE_KIND]);
      if(current.rowCount)fail('CONFLICT','An active review queue agent session already exists.');
      const id=randomUUID(),token=this.rawToken(id,actorId),tokenDigest=this.digest(token);
      await client.query(`INSERT INTO motive.project_review_queue_agent_grants
        (id,project_id,reviewer_actor_id,review_kind,max_decisions,token_digest,token_hint,issuance_idempotency_key,issuance_request_digest,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '1 hour')`,
      [id,projectId,actorId,REVIEW_QUEUE_KIND,input.maxDecisions,tokenDigest,tokenDigest.slice(-12),idempotencyKey,requestDigest]);
      const saved=await client.query(this.grantSql('WHERE grant_row.id=$1'),[id]);return{grant:this.projection(saved.rows[0]),token};});
  }

  async listGrants(actorId:string):Promise<ReviewQueueGrantList>{
    await this.authority(this.options.pool,actorId);if(!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current reviewer account is required.');
    const found=await this.options.pool.query(this.grantSql('WHERE grant_row.reviewer_actor_id=$1 ORDER BY grant_row.created_at DESC,grant_row.id DESC LIMIT 20'),[actorId]);
    return{format:'motive.review-queue-grants/0.1',grants:found.rows.map(row=>this.projection(row))};
  }

  async revokeGrant(actorId:string,grantId:string,idempotencyKey:string):Promise<{grant:ReviewQueueGrant}>{
    if(!UUID.test(grantId)||!KEY.test(idempotencyKey))fail('VALIDATION','Review queue revoke request is invalid.');
    await this.authority(this.options.pool,actorId);if(!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current reviewer account is required.');
    return this.transaction(async client=>{await this.authority(client,actorId,true);
      const found=await client.query(`SELECT * FROM motive.project_review_queue_agent_grants WHERE id=$1 AND reviewer_actor_id=$2 FOR UPDATE`,[grantId,actorId]);
      if(found.rowCount!==1)fail('NOT_FOUND','Review queue agent session was not found.');
      if(found.rows[0].revoked_at===null)await client.query(`UPDATE motive.project_review_queue_agent_grants SET revoked_at=clock_timestamp() WHERE id=$1`,[grantId]);
      await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access child SET revoked_at=coalesce(child.revoked_at,clock_timestamp())
        WHERE child.queue_grant_id=$1 AND child.consumed_at IS NULL`,[grantId]);
      await client.query(`UPDATE motive.project_review_queue_agent_claims SET expired_at=clock_timestamp()
        WHERE grant_id=$1 AND released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL`,[grantId]);
      const saved=await client.query(this.grantSql('WHERE grant_row.id=$1'),[grantId]);return{grant:this.projection(saved.rows[0])};});
  }

  async authenticate(rawToken:string):Promise<ReviewQueueAgentContext>{
    if(!TOKEN.test(rawToken))fail('UNAUTHORIZED','Review queue agent token is invalid.');const tokenDigest=this.digest(rawToken);
    const found=await this.options.pool.query(`SELECT id,project_id,reviewer_actor_id,token_digest FROM motive.project_review_queue_agent_grants WHERE token_digest=$1`,[tokenDigest]);
    if(found.rowCount!==1)fail('UNAUTHORIZED','Review queue agent token is invalid.');const row=found.rows[0];
    return{grantId:text(row,'id'),projectId:text(row,'project_id'),reviewerActorId:text(row,'reviewer_actor_id'),tokenDigest};
  }

  private async lockCurrentGrant(client:PoolClient,context:ReviewQueueAgentContext):Promise<{row:QueryResultRow;grant:ReviewQueueGrant}>{
    const projectId=await this.authority(client,context.reviewerActorId,true);if(projectId!==context.projectId)fail('FORBIDDEN','Current project reviewer authority is required.');
    const found=await client.query(this.grantSql('WHERE grant_row.id=$1 FOR UPDATE OF grant_row'),[context.grantId]);
    if(found.rowCount!==1)fail('UNAUTHORIZED','Review queue agent token is invalid.');const row=found.rows[0];
    if(text(row,'token_digest')!==context.tokenDigest||text(row,'reviewer_actor_id')!==context.reviewerActorId||text(row,'project_id')!==context.projectId)
      fail('UNAUTHORIZED','Review queue agent token binding is invalid.');
    return{row,grant:this.projection(row)};
  }

  private requireUsable(grant:ReviewQueueGrant):void{
    if(grant.status==='REVOKED')fail('FORBIDDEN','Review queue agent session was revoked.');
    if(grant.status==='EXPIRED')fail('FORBIDDEN','Review queue agent session expired.');
  }

  private async markSeen(client:PoolClient,grantId:string):Promise<void>{const result=await client.query(`UPDATE motive.project_review_queue_agent_grants
    SET first_seen_at=coalesce(first_seen_at,clock_timestamp()),last_seen_at=clock_timestamp()
    WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[grantId]);
    if(result.rowCount!==1)fail('FORBIDDEN','Review queue agent session is no longer active.');}

  private async expireClaims(client:PoolClient,projectId:string,grantId?:string):Promise<void>{
    const expired=await client.query(`SELECT claim.id,claim.grant_id,claim.child_access_id FROM motive.project_review_queue_agent_claims claim
      WHERE claim.project_id=$1 AND ($2::uuid IS NULL OR claim.grant_id=$2) AND claim.released_at IS NULL
        AND claim.expired_at IS NULL AND claim.consumed_at IS NULL AND claim.assignment_expires_at<=clock_timestamp()
      ORDER BY claim.created_at,claim.id`,[projectId,grantId??null]);
    for(const item of expired.rows){
      await client.query(`SELECT id FROM motive.project_review_queue_agent_grants WHERE id=$1 FOR SHARE`,[item.grant_id]);
      await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access SET revoked_at=coalesce(revoked_at,clock_timestamp())
        WHERE queue_grant_id=$1 AND (id=$2 OR issuance_idempotency_key=$3) AND consumed_at IS NULL`,
      [item.grant_id,item.child_access_id??null,`review-queue-${item.id}`]);
      await client.query(`UPDATE motive.project_review_queue_agent_claims SET expired_at=clock_timestamp()
        WHERE id=$1 AND released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL
          AND assignment_expires_at<=clock_timestamp()`,[item.id]);
    }
  }

  private async currentState(client:PoolClient,context:ReviewQueueAgentContext,markSeen:boolean):Promise<ReviewQueueAgentState>{
    await this.expireClaims(client,context.projectId,context.grantId);if(markSeen)await this.markSeen(client,context.grantId);
    const current=await client.query(this.grantSql('WHERE grant_row.id=$1 FOR UPDATE OF grant_row'),[context.grantId]);const grant=this.projection(current.rows[0]);
    this.requireUsable(grant);
    if(grant.status==='EXHAUSTED')return{format:'motive.review-queue-agent-state/0.1',state:'EXHAUSTED',grant,assignment:null,retryAfterSeconds:null};
    const claim=await client.query(`SELECT claim.*,child.token_digest AS child_token_digest,child.review_package_digest,
        child.expected_decision_id,child.expires_at AS child_expires_at,child.first_seen_at,child.last_seen_at,
        child.consumed_at AS child_consumed_at,child.revoked_at AS child_revoked_at,child.created_at AS child_created_at
      FROM motive.project_review_queue_agent_claims claim
      LEFT JOIN motive.hypothesis_submission_admission_agent_access child ON child.id=claim.child_access_id
      WHERE claim.grant_id=$1 AND claim.released_at IS NULL AND claim.expired_at IS NULL AND claim.consumed_at IS NULL
        AND claim.assignment_expires_at>clock_timestamp() ORDER BY claim.created_at DESC LIMIT 1 FOR UPDATE OF claim`,[context.grantId]);
    if(claim.rowCount!==1||claim.rows[0].child_access_id===null)return{format:'motive.review-queue-agent-state/0.1',state:'AVAILABLE',grant,assignment:null,retryAfterSeconds:null};
    const row=claim.rows[0],accessId=text(row,'child_access_id'),token=this.options.admission.recoverAgentAccessToken(accessId,context.reviewerActorId);
    if(this.digest(token)!==text(row,'child_token_digest'))fail('CONFLICT','Retained review assignment credential cannot be recovered.');
    const access:ResearchAdmissionAgentAccessProjection=await this.options.admission.inspectAgentAccess(
      context.reviewerActorId,text(row,'submission_id'),accessId,client,false);
    return{format:'motive.review-queue-agent-state/0.1',state:'WORKING',grant,assignment:{claimId:text(row,'id'),submissionId:text(row,'submission_id'),
      access,token,claimedAt:iso(row.created_at)},retryAfterSeconds:null};
  }

  private async retainedClaimState(client:PoolClient,context:ReviewQueueAgentContext,claimId:string):Promise<ReviewQueueClaimResponse>{
    const claim=await client.query(`SELECT claim.*,child.token_digest AS child_token_digest
      FROM motive.project_review_queue_agent_claims claim
      LEFT JOIN motive.hypothesis_submission_admission_agent_access child ON child.id=claim.child_access_id
      WHERE claim.id=$1 AND claim.grant_id=$2 FOR UPDATE OF claim`,[claimId,context.grantId]);
    if(claim.rowCount!==1||claim.rows[0].child_access_id===null)fail('CONFLICT','Retained review queue claim did not finish preparing.');
    const grantRow=await client.query(this.grantSql('WHERE grant_row.id=$1'),[context.grantId]);
    const grant=this.projection(grantRow.rows[0]),row=claim.rows[0],accessId=text(row,'child_access_id');
    const token=this.options.admission.recoverAgentAccessToken(accessId,context.reviewerActorId);
    if(this.digest(token)!==text(row,'child_token_digest'))fail('CONFLICT','Retained review assignment credential cannot be recovered.');
    const access=await this.options.admission.inspectAgentAccess(context.reviewerActorId,text(row,'submission_id'),accessId,client,false);
    return{format:'motive.review-queue-agent-state/0.1',state:'WORKING',grant,assignment:{claimId:text(row,'id'),
      submissionId:text(row,'submission_id'),access,token,claimedAt:iso(row.created_at)},retryAfterSeconds:null};
  }

  async state(context:ReviewQueueAgentContext):Promise<ReviewQueueAgentState>{
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Review queue reviewer account is no longer active.');
    return this.transaction(async client=>{const {grant}=await this.lockCurrentGrant(client,context);this.requireUsable(grant);
      return this.currentState(client,context,true);});
  }

  private async reserveClaim(context:ReviewQueueAgentContext,idempotencyKey:string):Promise<{claimId:string;submissionId:string;replay:boolean}|ReviewQueueAgentState>{
    return this.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`review-queue-project:${context.projectId}`]);
      const {grant}=await this.lockCurrentGrant(client,context);this.requireUsable(grant);await this.markSeen(client,context.grantId);
      await this.expireClaims(client,context.projectId);
      const requestDigest=digestCanonicalJson({});
      const prior=await client.query(`SELECT request.*,claim.submission_id,claim.child_access_id,claim.released_at,claim.expired_at,claim.consumed_at
        FROM motive.project_review_queue_agent_claim_requests request
        LEFT JOIN motive.project_review_queue_agent_claims claim ON claim.id=request.claim_id
        WHERE request.grant_id=$1 AND request.idempotency_key=$2`,[context.grantId,idempotencyKey]);
      if(prior.rowCount===1){if(text(prior.rows[0],'request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is already bound to another queue claim request.');
        if(prior.rows[0].outcome==='EMPTY')return{format:'motive.review-queue-agent-state/0.1',state:'EMPTY',grant,assignment:null,retryAfterSeconds:EMPTY_RETRY_SECONDS};
        if(prior.rows[0].child_access_id===null&&(prior.rows[0].released_at!==null||prior.rows[0].expired_at!==null||prior.rows[0].consumed_at!==null))
          fail('CONFLICT','Retained review queue claim did not finish preparing.');
        return{claimId:text(prior.rows[0],'claim_id'),submissionId:text(prior.rows[0],'submission_id'),replay:prior.rows[0].child_access_id!==null};}
      if(grant.status==='EXHAUSTED')return this.currentState(client,context,false);
      const working=await client.query(`SELECT id FROM motive.project_review_queue_agent_claims WHERE grant_id=$1
        AND released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL FOR UPDATE`,[context.grantId]);
      if(working.rowCount){const claimId=text(working.rows[0],'id');await client.query(`INSERT INTO motive.project_review_queue_agent_claim_requests
          (id,grant_id,idempotency_key,request_digest,claim_id,outcome) VALUES($1,$2,$3,$4,$5,'ASSIGNED')`,
        [randomUUID(),context.grantId,idempotencyKey,requestDigest,claimId]);
        const existing=await client.query(`SELECT submission_id,child_access_id FROM motive.project_review_queue_agent_claims WHERE id=$1`,[claimId]);
        return{claimId,submissionId:text(existing.rows[0],'submission_id'),replay:existing.rows[0].child_access_id!==null};}
      const candidate=await client.query(`SELECT submission.id
        FROM motive.submissions submission
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id AND artifact.project_id=submission.project_id
        JOIN motive.participation_agent_tokens contributor ON contributor.id=artifact.agent_token_id AND contributor.project_id=artifact.project_id
        JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id AND completion.claim_id=submission.claim_id
        JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id AND assessment.project_id=submission.project_id
          AND assessment.agent_token_id=artifact.agent_token_id AND assessment.report_digest=artifact.report_digest
        JOIN motive.project_research_scopes scope ON scope.project_id=submission.project_id AND scope.status='CONNECTED'
        WHERE submission.project_id=$1 AND submission.origin='EXTERNAL' AND submission.attempt_id IS NULL
          AND submission.operator_actor_id=('agent:'||contributor.id::text)
          AND submission.provenance ? 'investigation'
          AND artifact.report_body->'agentInvestigation'=submission.provenance->'investigation'
          AND contributor.owner_actor_id<>$2
          AND EXISTS(SELECT 1 FROM motive.work_claims source_claim
            JOIN motive.work_orders source_work ON source_work.id=source_claim.work_order_id
              AND source_work.project_id=submission.project_id AND source_work.revision=submission.work_order_revision
            WHERE source_claim.id=submission.claim_id AND source_claim.work_order_id=submission.work_order_id
              AND source_claim.operator_actor_id=submission.operator_actor_id AND source_claim.lease_epoch=submission.lease_epoch)
          AND NOT EXISTS(SELECT 1 FROM motive.project_review_queue_agent_claims prior WHERE prior.grant_id=$3 AND prior.submission_id=submission.id)
          AND NOT EXISTS(SELECT 1 FROM motive.project_review_queue_agent_claims open_claim WHERE open_claim.project_id=submission.project_id
            AND open_claim.submission_id=submission.id AND open_claim.released_at IS NULL AND open_claim.expired_at IS NULL
            AND open_claim.consumed_at IS NULL AND open_claim.assignment_expires_at>clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_deliveries delivery
            JOIN motive.hypothesis_submission_delivery_admission_decisions decision ON decision.delivery_id=delivery.id
            WHERE delivery.project_id=submission.project_id AND delivery.source_submission_id=submission.id)
        ORDER BY submission.created_at,submission.id FOR UPDATE OF submission SKIP LOCKED LIMIT 1`,
      [context.projectId,context.reviewerActorId,context.grantId]);
      if(candidate.rowCount!==1){await client.query(`INSERT INTO motive.project_review_queue_agent_claim_requests
          (id,grant_id,idempotency_key,request_digest,outcome) VALUES($1,$2,$3,$4,'EMPTY')`,
        [randomUUID(),context.grantId,idempotencyKey,requestDigest]);
        return{format:'motive.review-queue-agent-state/0.1',state:'EMPTY',grant,assignment:null,retryAfterSeconds:EMPTY_RETRY_SECONDS};}
      const claimId=randomUUID(),submissionId=text(candidate.rows[0],'id');
      await client.query(`INSERT INTO motive.project_review_queue_agent_claims
        (id,grant_id,project_id,submission_id,claim_idempotency_key,claim_request_digest,assignment_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,least(clock_timestamp()+interval '2 minutes',(SELECT expires_at FROM motive.project_review_queue_agent_grants WHERE id=$2)))`,
      [claimId,context.grantId,context.projectId,submissionId,idempotencyKey,requestDigest]);
      await client.query(`INSERT INTO motive.project_review_queue_agent_claim_requests
        (id,grant_id,idempotency_key,request_digest,claim_id,outcome) VALUES($1,$2,$3,$4,$5,'ASSIGNED')`,
      [randomUUID(),context.grantId,idempotencyKey,requestDigest,claimId]);return{claimId,submissionId,replay:false};});
  }

  async claim(context:ReviewQueueAgentContext,idempotencyKey:string):Promise<ReviewQueueClaimResponse>{
    if(!KEY.test(idempotencyKey))fail('VALIDATION','Review queue claim Idempotency-Key is invalid.');
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Review queue reviewer account is no longer active.');
    const reserved=await this.reserveClaim(context,idempotencyKey);if('format'in reserved)return reserved;
    if(reserved.replay)return this.transaction(client=>this.retainedClaimState(client,context,reserved.claimId));
    try{
      const preview=await this.options.admission.prepareAdmissionPreview(context.reviewerActorId,reserved.submissionId);
      const issued=await this.options.admission.issueAgentAccess(context.reviewerActorId,reserved.submissionId,
        {packageDigest:preview.packageDigest,expectedDecisionId:preview.latestDecision?.id??null},`review-queue-${reserved.claimId}`,
        context.grantId,reserved.claimId);
      await this.transaction(async client=>{const {grant}=await this.lockCurrentGrant(client,context);if(grant.status!=='ACTIVE')fail('FORBIDDEN','Review queue agent session is no longer active.');
        const claim=await client.query(`SELECT * FROM motive.project_review_queue_agent_claims WHERE id=$1 AND grant_id=$2 FOR UPDATE`,[reserved.claimId,context.grantId]);
        if(claim.rowCount!==1||claim.rows[0].released_at!==null||claim.rows[0].expired_at!==null||claim.rows[0].consumed_at!==null)
          fail('CONFLICT','Review queue claim is no longer current.');
        if(claim.rows[0].child_access_id===null)await client.query(`UPDATE motive.project_review_queue_agent_claims
          SET delivery_id=$2,child_access_id=$3,
            assignment_expires_at=(SELECT expires_at FROM motive.hypothesis_submission_admission_agent_access WHERE id=$3)
          WHERE id=$1`,[reserved.claimId,preview.package.delivery.id,issued.access.id]);
        else if(claim.rows[0].child_access_id!==issued.access.id)fail('CONFLICT','Review queue claim child access conflicts with retained state.');});
      return this.transaction(client=>this.retainedClaimState(client,context,reserved.claimId));
    }catch(error){
      if(error instanceof SubmissionAdmissionError||error instanceof ReviewQueueError){await this.transaction(async client=>{
        await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access SET revoked_at=coalesce(revoked_at,clock_timestamp())
          WHERE queue_grant_id=$1 AND issuance_idempotency_key=$2 AND consumed_at IS NULL`,
        [context.grantId,`review-queue-${reserved.claimId}`]);
        await client.query(`UPDATE motive.project_review_queue_agent_claims SET expired_at=clock_timestamp()
          WHERE id=$1 AND grant_id=$2 AND child_access_id IS NULL AND released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL`,[reserved.claimId,context.grantId]);}).catch(()=>undefined);}
      throw error;
    }
  }

  async release(context:ReviewQueueAgentContext,input:ReleaseReviewQueueClaimInput,idempotencyKey:string):Promise<ReleaseReviewQueueClaimResponse>{
    if(!KEY.test(idempotencyKey)||typeof input?.reason!=='string'||input.reason.trim()!==input.reason||input.reason.length<1||input.reason.length>500
      ||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.reason))fail('VALIDATION','Review queue release request is invalid.');
    if(!await this.options.isActorActive(context.reviewerActorId))fail('UNAUTHORIZED','Review queue reviewer account is no longer active.');
    const requestDigest=digestCanonicalJson(input);
    return this.transaction(async client=>{const {grant}=await this.lockCurrentGrant(client,context);this.requireUsable(grant);
      await this.markSeen(client,context.grantId);await this.expireClaims(client,context.projectId,context.grantId);
      const replay=await client.query(`SELECT id,submission_id,release_reason,released_at,release_request_digest
        FROM motive.project_review_queue_agent_claims WHERE grant_id=$1 AND release_idempotency_key=$2`,[context.grantId,idempotencyKey]);
      if(replay.rowCount===1){if(text(replay.rows[0],'release_request_digest')!==requestDigest)
          fail('CONFLICT','Idempotency-Key is already bound to another queue release request.');
        return{format:'motive.review-queue-release/0.1',claimId:text(replay.rows[0],'id'),submissionId:text(replay.rows[0],'submission_id'),
          reason:text(replay.rows[0],'release_reason'),releasedAt:iso(replay.rows[0].released_at)};}
      if(grant.status==='EXHAUSTED')fail('CONFLICT','No current review queue assignment exists.');
      const candidate=await client.query(`SELECT id,submission_id,child_access_id FROM motive.project_review_queue_agent_claims WHERE grant_id=$1
        AND released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL`,[context.grantId]);
      if(candidate.rowCount!==1)fail('CONFLICT','No current review queue assignment exists.');const row=candidate.rows[0];
      if(row.child_access_id)await client.query(`SELECT id FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1 FOR UPDATE`,[row.child_access_id]);
      const claim=await client.query(`SELECT * FROM motive.project_review_queue_agent_claims WHERE id=$1 AND grant_id=$2 FOR UPDATE`,[row.id,context.grantId]);
      if(claim.rowCount!==1||claim.rows[0].released_at!==null||claim.rows[0].expired_at!==null||claim.rows[0].consumed_at!==null)
        fail('CONFLICT','No current review queue assignment exists.');
      if(row.child_access_id)await client.query(`UPDATE motive.hypothesis_submission_admission_agent_access
        SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1 AND consumed_at IS NULL`,[row.child_access_id]);
      const saved=await client.query(`UPDATE motive.project_review_queue_agent_claims SET released_at=clock_timestamp(),release_reason=$2,
        release_idempotency_key=$3,release_request_digest=$4 WHERE id=$1 RETURNING id,submission_id,release_reason,released_at`,
      [row.id,input.reason,idempotencyKey,requestDigest]);
      return{format:'motive.review-queue-release/0.1',claimId:text(saved.rows[0],'id'),submissionId:text(saved.rows[0],'submission_id'),
        reason:text(saved.rows[0],'release_reason'),releasedAt:iso(saved.rows[0].released_at)};});
  }
}

export function createResearchReviewQueueService(options:ResearchReviewQueueServiceOptions){return new ResearchReviewQueueService(options);}
