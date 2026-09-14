import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import type { SubmissionInvestigationInput, SubmissionMotiveReference, SubmissionResearchContext,
  SubmissionResearchReference } from '../../src/lib/participation.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import type { ParticipationAgentContext } from '../participation/service.ts';
import type { FindingDeclaredReferences, FindingReviewDecisionInput, FindingReviewDecisionResponse,
  FindingReviewAgentDecisionResponse, FindingReviewAgentPreview, FindingReviewEligibility, FindingReviewMemoryStatus,
  FindingReviewHistoryDecision, FindingReviewHistoryPage, FindingReviewPackage,
  FindingReviewPreview, FindingReviewPrivateDecision,
  FindingReviewPublicDecision, FindingReviewPublicProjection, FindingReviewEvidenceReference } from '../../src/lib/finding-assessment.ts';
import { buildDraftBody, buildNeutralEvidenceBody, preparedDeliverySource,
  type Delivery } from './submission-delivery.ts';
import type { PreparedDeliveryIntent } from './delivery-intents.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACCOUNT=/^account:[A-Za-z0-9._~-]{1,480}$/;const DIGEST=/^sha256:[a-f0-9]{64}$/;
const KEY=/^[A-Za-z0-9._~-]{8,200}$/;const MAX_PACKAGE_BYTES=524288;

export class FindingAssessmentError extends Error{
  readonly statusCode:400|401|403|404|409;
  constructor(readonly code:'VALIDATION'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT',message:string){super(message);
    this.name='FindingAssessmentError';this.statusCode=code==='VALIDATION'?400:code==='UNAUTHORIZED'?401:code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:409;}
}
function fail(code:FindingAssessmentError['code'],message:string):never{throw new FindingAssessmentError(code,message);}
function text(row:QueryResultRow,name:string){const value=row[name];if(typeof value!=='string'||!value)fail('CONFLICT',`Stored ${name} is invalid.`);return value;}
function dateText(value:unknown){const date=value instanceof Date?value:new Date(String(value));if(!Number.isFinite(date.getTime()))fail('CONFLICT','Stored timestamp is invalid.');return date.toISOString();}
function object(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function exact(value:Record<string,unknown>,names:string[]){return Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));}
function nested(value:unknown,name:string){if(!object(value))fail('CONFLICT',`Stored ${name} is invalid.`);return value;}
function same(left:unknown,right:unknown){return digestCanonicalJson(left)===digestCanonicalJson(right);}
function validateNativeCanonicalJson(value:unknown):void{
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value))fail('CONFLICT','Motive-native finding evidence contains an unsupported number.');
    return;
  }
  if(Array.isArray(value)){value.forEach(validateNativeCanonicalJson);return;}
  if(!object(value))fail('CONFLICT','Motive-native finding evidence is not canonical JSON.');
  for(const [key,item] of Object.entries(value)){
    if([...key].some(character=>character.codePointAt(0)!>0x7f))
      fail('CONFLICT','Motive-native finding evidence contains an unsupported object key.');
    validateNativeCanonicalJson(item);
  }
}

type Options={pool:Pool;isActorActive:(actorId:string)=>boolean|Promise<boolean>;
  admitAgentFinding?:(context:ParticipationAgentContext,findingDecisionId:string)=>Promise<FindingReviewMemoryStatus>};
type ReadinessReason='NOT_FOUND'|'NOT_COMPLETED'|'POST_CHECK_REQUIRED'|'COMPLETE_DELIVERY_REQUIRED';
type Built={pkg:FindingReviewPackage;digest:string;row:QueryResultRow};

function timed<T>(finalValue:T|undefined,intentValue:T|undefined):{timing:'PRE_TEST_INTENT'|'SUBMISSION_NOTES';value:T}|null{
  if(finalValue===undefined)return null;
  return{timing:intentValue!==undefined&&same(finalValue,intentValue)?'PRE_TEST_INTENT':'SUBMISSION_NOTES',value:finalValue};
}
function declaredReferences(investigation:SubmissionInvestigationInput,intent:QueryResultRow):FindingDeclaredReferences{
  return{
    researchContext:timed(investigation.researchContext,intent.intent_research_context as SubmissionResearchContext|undefined),
    researchReferences:timed(investigation.researchReferences,intent.intent_research_references as SubmissionResearchReference[]|undefined),
    motiveReferences:timed(investigation.motiveReferences,intent.intent_motive_references as SubmissionMotiveReference[]|undefined),
  };
}

export class FindingAssessmentService{
  constructor(private readonly options:Options){}
  private async transaction<T>(work:(client:PoolClient)=>Promise<T>){const client=await this.options.pool.connect();try{await client.query('BEGIN');
    const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}

  private async projectFor(submissionId:string,client:Pool|PoolClient=this.options.pool){
    if(!UUID.test(submissionId))return null;
    const result=await client.query(`SELECT project.id::text AS project_id,project.slug
      FROM motive.projects project JOIN motive.submissions submission ON submission.project_id=project.id
      WHERE submission.id=$1 AND project.slug='circle-packing' AND project.visibility='PUBLIC'`,[submissionId]);
    return result.rowCount===1?result.rows[0]:null;
  }

  private async authority(client:Pool|PoolClient,actorId:string,projectId:string,lock=false){
    if(!ACCOUNT.test(actorId))return'ACCOUNT_INACTIVE' as const;
    const result=await client.query(`SELECT membership.role,identity.status FROM motive.memberships membership
      JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
      WHERE membership.project_id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
        AND membership.role IN ('OWNER','STEWARD','REVIEWER') ${lock?'FOR SHARE OF membership,identity':''}`,[projectId,actorId]);
    if(result.rowCount!==1)return'MEMBERSHIP_REQUIRED' as const;
    return result.rows[0].status==='ACTIVE'?'ELIGIBLE' as const:'ACCOUNT_INACTIVE' as const;
  }

  private async originalContributor(submissionId:string,client:Pool|PoolClient=this.options.pool){const result=await client.query(`SELECT token.owner_actor_id
    FROM motive.participation_submission_artifacts artifact JOIN motive.participation_agent_tokens token
      ON token.id=artifact.agent_token_id AND token.project_id=artifact.project_id WHERE artifact.submission_id=$1`,[submissionId]);
    return result.rowCount===1?text(result.rows[0],'owner_actor_id'):null;}

  private async readiness(submissionId:string,client:Pool|PoolClient=this.options.pool):Promise<ReadinessReason|null>{
    const state=await client.query(`SELECT completion.submission_id,assessment.submission_id AS assessment_id,
      artifact.submission_id AS artifact_id FROM motive.submissions submission
      LEFT JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id AND completion.claim_id=submission.claim_id
      LEFT JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      LEFT JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
        AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
        AND assessment.report_digest=artifact.report_digest
      WHERE submission.id=$1 AND submission.origin='EXTERNAL'`,[submissionId]);
    if(state.rowCount!==1)return'NOT_FOUND';const row=state.rows[0];
    if(row.submission_id===null)return'NOT_COMPLETED';if(row.artifact_id===null||row.assessment_id===null)return'POST_CHECK_REQUIRED';return null;
  }

  private validateStoredEngine(row:QueryResultRow){
    const draftBody=nested(row.draft_request_body,'draft request body'),evidenceBody=nested(row.evidence_request_body,'evidence request body');
    const draftResponse=nested(row.draft_response_body,'draft response'),evidenceResponse=nested(row.evidence_response_body,'evidence response');
    if(digestCanonicalJson(draftBody)!==text(row,'draft_body_digest')
      ||digestCanonicalJson({method:'POST',path:text(row,'draft_path'),body:draftBody})!==text(row,'draft_request_digest')
      ||digestCanonicalJson(evidenceBody)!==text(row,'evidence_body_digest')
      ||digestCanonicalJson({method:'POST',path:text(row,'evidence_path'),body:evidenceBody})!==text(row,'evidence_request_digest')
      ||digestCanonicalJson(draftResponse)!==text(row,'draft_response_digest')
      ||digestCanonicalJson(evidenceResponse)!==text(row,'evidence_response_digest'))fail('CONFLICT','Retained engine operation digest is invalid.');
    const evidence=nested(evidenceResponse.evidence,'evidence response row'),hypothesis=nested(evidenceResponse.hypothesis,'evidence hypothesis response');
    if(draftResponse.id!==row.draft_resource_id||draftResponse.statement!==draftBody.statement
      ||draftResponse.context!==draftBody.context||draftResponse.status!=='draft'||draftResponse.created_by!==row.engine_actor
      ||draftResponse.channel!==draftBody.channel||!same(draftResponse.experimental_design,draftBody.experimental_design)
      ||!same(draftResponse.metadata,draftBody.metadata)||draftResponse.confidence!==null||draftResponse.initial_confidence!==null
      ||draftResponse.outcome!==null||draftResponse.is_archived!==false
      ||evidence.id!==row.evidence_resource_id||evidence.hypothesis_id!==row.draft_resource_id
      ||hypothesis.id!==row.draft_resource_id||evidence.content!==evidenceBody.content||evidence.source!==evidenceBody.source
      ||evidence.evidence_type!=='neutral'||evidence.created_by!==evidenceBody.created_by
      ||hypothesis.status!=='draft'||hypothesis.confidence!==draftResponse.confidence
      ||hypothesis.initial_confidence!==draftResponse.initial_confidence||hypothesis.outcome!==null
      ||row.evidence_target_id!==row.draft_resource_id)fail('CONFLICT','Retained engine responses do not match their exact operations.');
    return{draftBody,evidenceBody,draftResponse,evidenceResponse};
  }

  private async validateDeclaredSources(client:Pool|PoolClient,projectId:string,
    contexts:Array<SubmissionResearchContext|null|undefined>,referenceSets:Array<SubmissionResearchReference[]|null|undefined>,
    motiveSets:Array<SubmissionMotiveReference[]|null|undefined>){
    for(const context of contexts){if(!context)continue;
      if(!UUID.test(context.scopeId)||!UUID.test(context.snapshotId)||!DIGEST.test(context.snapshotDigest))
        fail('CONFLICT','Stored research context is malformed.');
      const retained=await client.query(`SELECT payload,snapshot_digest FROM motive.research_context_snapshots
        WHERE id=$1 AND scope_id=$2 AND project_id=$3`,[context.snapshotId,context.scopeId,projectId]);
      const payload=retained.rows[0]?.payload;
      if(retained.rowCount!==1||retained.rows[0].snapshot_digest!==context.snapshotDigest||!object(payload)
        ||!['motive.research-context.v1','motive.research-hypothesis-context.v1'].includes(String(payload.format))
        ||digestCanonicalJson(payload)!==context.snapshotDigest)fail('CONFLICT','Stored research context is not a retained project snapshot.');
    }
    for(const references of referenceSets){if(!references)continue;if(!Array.isArray(references)||references.length>10)
      fail('CONFLICT','Stored research references are malformed.');
      for(const reference of references){
        if(!UUID.test(reference.scopeId)||!UUID.test(reference.snapshotId)||!UUID.test(reference.hypothesisId)
          ||!DIGEST.test(reference.snapshotDigest)||!Array.isArray(reference.evidenceIds)||reference.evidenceIds.length>20
          ||reference.evidenceIds.some(id=>!UUID.test(id)))fail('CONFLICT','Stored research reference is malformed.');
        const retained=await client.query(`SELECT payload,snapshot_digest FROM motive.research_context_snapshots
          WHERE id=$1 AND scope_id=$2 AND project_id=$3`,[reference.snapshotId,reference.scopeId,projectId]);
        const payload=retained.rows[0]?.payload;
        if(retained.rowCount!==1||retained.rows[0].snapshot_digest!==reference.snapshotDigest||!object(payload)
          ||!['motive.research-context.v1','motive.research-hypothesis-context.v1'].includes(String(payload.format))
          ||digestCanonicalJson(payload)!==reference.snapshotDigest)fail('CONFLICT','Stored research reference is not a retained project snapshot.');
        const hypotheses=payload.hypotheses;if(!Array.isArray(hypotheses))fail('CONFLICT','Stored research reference lacks retained hypotheses.');
        const hypothesis=hypotheses.find(value=>object(value)&&value.id===reference.hypothesisId);
        const observed=new Date(reference.observedUpdatedAt);
        if(!Number.isFinite(observed.getTime())||observed.toISOString()!==reference.observedUpdatedAt
          ||!object(hypothesis)||hypothesis.updatedAt!==reference.observedUpdatedAt||!Array.isArray(hypothesis.evidence)
          ||reference.evidenceIds.some(id=>!(hypothesis.evidence as unknown[]).some(value=>object(value)&&value.id===id)))
          fail('CONFLICT','Stored research reference is outside the retained snapshot boundary.');
      }
    }
    for(const references of motiveSets){if(!references)continue;if(!Array.isArray(references)||references.length>20)
      fail('CONFLICT','Stored Motive references are malformed.');
      const ids=references.map(reference=>reference.submissionId);
      if(new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id)))fail('CONFLICT','Stored Motive references are malformed.');
      const found=await client.query(`SELECT artifact.submission_id::text,artifact.report_digest,artifact.witness_digest
        FROM motive.participation_submission_artifacts artifact JOIN motive.submissions submission
          ON submission.id=artifact.submission_id AND submission.project_id=artifact.project_id
        WHERE artifact.project_id=$1 AND artifact.submission_id=ANY($2::uuid[]) AND submission.origin='EXTERNAL'`,[projectId,ids]);
      const rows=new Map(found.rows.map(value=>[text(value,'submission_id'),value]));
      if(found.rowCount!==references.length||references.some(reference=>{const value=rows.get(reference.submissionId);
        return !value||value.report_digest!==reference.reportDigest||value.witness_digest!==reference.artifactDigest;}))
        fail('CONFLICT','Stored Motive references do not match immutable project artifacts.');
    }
  }

  private async buildPackageV1(client:Pool|PoolClient,submissionId:string):Promise<Built>{
    const result=await client.query(`SELECT project.id::text AS project_id,project.slug,
      submission.id::text AS submission_id,submission.format AS submission_format,submission.created_at AS submission_created_at,
      submission.base_commit,submission.artifact_manifest_digest,submission.license_acceptance_ref,submission.provenance,
      work.id::text AS work_order_id,work.revision AS work_order_revision,work.project_revision,work.terms_digest AS work_terms_digest,work.terms,
      claim.id::text AS claim_id,claim.lease_epoch,claim.terms_digest AS claim_terms_digest,completion.completed_at,
      artifact.agent_token_id::text,artifact.witness_format,artifact.witness_bytes,artifact.witness_digest,artifact.report AS report_status,
      artifact.report_body,artifact.report_digest,token.owner_actor_id,token.agent_name,
      assessment.request_digest AS post_request_digest,assessment.report_digest AS post_report_digest,
      assessment.assessment AS post_assessment,assessment.next_action AS post_next_action,
      assessment.public_question AS post_public_question,assessment.public_finding AS post_public_finding,
      assessment.created_at AS post_created_at,
      reproducibility.request_digest AS repro_request_digest,reproducibility.solver_source_digest,reproducibility.trial_results_digest,
      claim_intent.research_context AS intent_research_context,claim_intent.research_references AS intent_research_references,
      claim_intent.motive_references AS intent_motive_references,claim_intent.experiment_protocol AS intent_experiment_protocol,
      claim_intent.proposal AS intent_proposal,
      claim_intent.expectation AS intent_expectation,claim_intent.conditions AS intent_conditions,
      claim_intent.created_at AS intent_created_at,claim_intent.request_digest AS intent_request_digest,
      delivery.id::text AS delivery_id,delivery.scope_id::text,delivery.engine_actor,delivery.created_at AS delivery_created_at,
      delivery.engine_api_base_url,delivery.scope_configuration_digest,delivery.engine_api_version,
      delivery.reviewed_contract_digest,delivery.reviewed_contract_version,delivery.reviewed_contract_surface_digest,
      delivery.reviewed_implementation_digest,
      intent.id::text AS source_intent_id,intent.payload_digest AS source_intent_payload_digest,intent.payload AS source_intent_payload,
      draft.request_path AS draft_path,draft.request_body AS draft_request_body,draft.request_body_digest AS draft_body_digest,
      draft.request_digest AS draft_request_digest,draft_result.resource_id::text AS draft_resource_id,
      draft_result.response_body AS draft_response_body,draft_result.response_digest AS draft_response_digest,
      evidence.target_hypothesis_id::text AS evidence_target_id,evidence.request_path AS evidence_path,
      evidence.request_body AS evidence_request_body,evidence.request_body_digest AS evidence_body_digest,
      evidence.request_digest AS evidence_request_digest,evidence_result.resource_id::text AS evidence_resource_id,
      evidence_result.response_body AS evidence_response_body,evidence_result.response_digest AS evidence_response_digest
      FROM motive.projects project JOIN motive.submissions submission ON submission.project_id=project.id AND submission.id=$1
      JOIN motive.work_orders work ON work.id=submission.work_order_id AND work.project_id=submission.project_id
      JOIN motive.work_claims claim ON claim.id=submission.claim_id AND claim.project_id=submission.project_id
      JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id AND completion.submission_id=submission.id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id AND artifact.project_id=submission.project_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=submission.project_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
        AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
        AND assessment.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
        AND reproducibility.project_id=submission.project_id AND reproducibility.agent_token_id=artifact.agent_token_id
        AND reproducibility.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_claim_intents claim_intent ON claim_intent.claim_id=claim.id
        AND claim_intent.project_id=submission.project_id AND claim_intent.work_order_id=work.id
        AND claim_intent.work_order_revision=work.revision AND claim_intent.work_order_terms_digest=work.terms_digest
        AND claim_intent.lease_epoch=claim.lease_epoch AND claim_intent.agent_token_id=artifact.agent_token_id
      JOIN LATERAL(SELECT candidate.* FROM motive.hypothesis_submission_deliveries candidate
        WHERE candidate.source_submission_id=submission.id AND candidate.project_id=submission.project_id
          AND EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results r WHERE r.delivery_id=candidate.id AND r.operation='DRAFT_HYPOTHESIS')
          AND EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results r WHERE r.delivery_id=candidate.id AND r.operation='NEUTRAL_EVIDENCE')
        ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1) delivery ON true
      JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
        AND intent.payload_digest=delivery.source_intent_payload_digest
      JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id AND draft.operation='DRAFT_HYPOTHESIS'
      JOIN motive.hypothesis_submission_delivery_results draft_result ON draft_result.delivery_id=draft.delivery_id AND draft_result.operation=draft.operation
      JOIN motive.hypothesis_submission_delivery_operations evidence ON evidence.delivery_id=delivery.id AND evidence.operation='NEUTRAL_EVIDENCE'
      JOIN motive.hypothesis_submission_delivery_results evidence_result ON evidence_result.delivery_id=evidence.delivery_id AND evidence_result.operation=evidence.operation
      WHERE project.slug='circle-packing' AND project.visibility='PUBLIC' AND submission.origin='EXTERNAL'`,[submissionId]);
    if(result.rowCount!==1)fail('NOT_FOUND','A completed investigation with retained engine observations was not found.');
    const row=result.rows[0],provenance=nested(row.provenance,'submission provenance');
    const envelope=nested(provenance.investigation,'investigation provenance'),investigation=nested(envelope.investigation,'investigation') as SubmissionInvestigationInput;
    if(investigation.format!=='motive.investigation.v1')fail('CONFLICT','Stored investigation is invalid.');
    const sourcePayload=nested(row.source_intent_payload,'source intent payload');
    if(digestCanonicalJson(sourcePayload)!==text(row,'source_intent_payload_digest'))fail('CONFLICT','Stored source intent payload digest is invalid.');
    const payloadSource=nested(sourcePayload.source,'source intent source'),payloadSubmission=nested(payloadSource.submission,'source intent submission');
    const payloadArtifact=nested(payloadSource.artifact,'source intent artifact'),payloadReport=nested(payloadSource.report,'source intent report');
    const payloadWork=nested(payloadSource.workOrder,'source intent work order'),payloadClaim=nested(payloadSource.claim,'source intent claim');
    const payloadAttribution=nested(sourcePayload.attribution,'source intent attribution');
    if(payloadSubmission.id!==submissionId||payloadSubmission.format!==row.submission_format
      ||payloadSubmission.baseCommit!==row.base_commit||payloadSubmission.artifactManifestDigest!==row.artifact_manifest_digest
      ||payloadSubmission.licenseAcceptanceRef!==row.license_acceptance_ref
      ||payloadWork.id!==row.work_order_id||payloadWork.revision!==Number(row.work_order_revision)
      ||payloadWork.projectRevision!==Number(row.project_revision)||payloadWork.termsDigest!==row.work_terms_digest
      ||payloadClaim.id!==row.claim_id||payloadClaim.leaseEpoch!==Number(row.lease_epoch)
      ||payloadAttribution.originalContributor!==row.owner_actor_id||payloadAttribution.agentTokenId!==row.agent_token_id
      ||payloadAttribution.agentName!==row.agent_name||payloadArtifact.format!==row.witness_format
      ||payloadArtifact.witness!==(row.witness_bytes as Buffer).toString('utf8')||payloadArtifact.witnessDigest!==row.witness_digest
      ||payloadReport.status!==row.report_status||!same(payloadReport.body,row.report_body)||payloadReport.digest!==row.report_digest)
      fail('CONFLICT','Stored source intent differs from the immutable investigation.');
    const prepared:PreparedDeliveryIntent={id:text(row,'source_intent_id'),state:'ENGINE_WRITE_UNAVAILABLE',
      disposition:'PROPOSED_UNREVIEWED',requestDigest:'sha256:'+''.padStart(64,'0'),
      payloadDigest:text(row,'source_intent_payload_digest'),payload:sourcePayload,createdAt:dateText(row.delivery_created_at),replayed:false};
    const sourceMaterial=preparedDeliverySource(prepared);if(!sourceMaterial)fail('CONFLICT','Stored source intent lacks an investigation.');
    const delivery:Delivery={id:text(row,'delivery_id'),projectId:text(row,'project_id'),scopeId:text(row,'scope_id'),
      submissionId,sourceIntentId:text(row,'source_intent_id'),sourceIntentPayloadDigest:text(row,'source_intent_payload_digest'),
      engineActor:text(row,'engine_actor'),apiBaseUrl:text(row,'engine_api_base_url'),
      configurationDigest:text(row,'scope_configuration_digest'),apiVersion:text(row,'engine_api_version'),
      contractDigest:text(row,'reviewed_contract_digest'),contractVersion:text(row,'reviewed_contract_version'),
      contractSurfaceDigest:text(row,'reviewed_contract_surface_digest'),
      implementationDigest:text(row,'reviewed_implementation_digest'),payload:sourcePayload,
      mode:'NEW_DRAFT',target:null,targetBindingDigest:null};
    await this.validateDeclaredSources(client,text(row,'project_id'),
      [investigation.researchContext,row.intent_research_context as SubmissionResearchContext|null],
      [investigation.researchReferences,row.intent_research_references as SubmissionResearchReference[]|null],
      [investigation.motiveReferences,row.intent_motive_references as SubmissionMotiveReference[]|null]);
    const engine=this.validateStoredEngine(row);
    if(!same(engine.draftBody,buildDraftBody(delivery,sourceMaterial,'circle-packing'))
      ||!same(engine.evidenceBody,buildNeutralEvidenceBody(delivery,sourceMaterial,'circle-packing')))
      fail('CONFLICT','Retained engine operations differ from the immutable local source.');
    const references=declaredReferences(investigation,row);
    const reproducibility=row.repro_request_digest===null?null:{requestDigest:text(row,'repro_request_digest'),
      solverSourceDigest:text(row,'solver_source_digest'),trialResultsDigest:text(row,'trial_results_digest')};
    const pkg:FindingReviewPackage={format:'motive.finding-review-package/0.1',findingId:submissionId,
      project:{id:text(row,'project_id'),slug:'circle-packing',revision:Number(row.project_revision)},
      workOrder:{id:text(row,'work_order_id'),revision:Number(row.work_order_revision),projectRevision:Number(row.project_revision),
        termsDigest:text(row,'work_terms_digest'),terms:row.terms},claim:{id:text(row,'claim_id'),leaseEpoch:Number(row.lease_epoch),
        termsDigest:text(row,'claim_terms_digest'),completedAt:dateText(row.completed_at)},
      source:{declaredIntent:row.intent_proposal===null?null:{proposal:text(row,'intent_proposal'),
        expectation:text(row,'intent_expectation'),conditions:row.intent_conditions as string[],
        researchContext:row.intent_research_context as SubmissionResearchContext|null,
        researchReferences:row.intent_research_references as SubmissionResearchReference[]|null,
        motiveReferences:row.intent_motive_references as SubmissionMotiveReference[]|null,
        ...(row.intent_experiment_protocol===null?{}:{experimentProtocol:row.intent_experiment_protocol as ExperimentProtocol}),
        declaredAt:dateText(row.intent_created_at),requestDigest:text(row,'intent_request_digest')},
        submission:{id:submissionId,format:text(row,'submission_format'),createdAt:dateText(row.submission_created_at),
        baseCommit:text(row,'base_commit'),artifactManifestDigest:text(row,'artifact_manifest_digest'),
        licenseAcceptanceRef:text(row,'license_acceptance_ref'),sourceIntentId:text(row,'source_intent_id'),
        sourceIntentPayloadDigest:text(row,'source_intent_payload_digest'),sourceIntentPayload:sourcePayload},
        attribution:{contributorActorId:text(row,'owner_actor_id'),agentTokenId:text(row,'agent_token_id'),agentName:text(row,'agent_name')},
        investigation:{proposal:String(investigation.proposal),expectation:String(investigation.expectation),conditions:[...investigation.conditions],
          observations:[...investigation.observations],assessment:String(investigation.assessment),nextAction:String(investigation.nextAction),
          digest:digestCanonicalJson(investigation)},references,artifact:{format:text(row,'witness_format'),
          witness:(row.witness_bytes as Buffer).toString('utf8'),digest:text(row,'witness_digest')},
        report:{status:text(row,'report_status') as FindingReviewPackage['source']['report']['status'],body:row.report_body,
          digest:text(row,'report_digest')},postCheck:{requestDigest:text(row,'post_request_digest'),reportDigest:text(row,'post_report_digest'),
        assessment:text(row,'post_assessment'),nextAction:text(row,'post_next_action'),
        ...(row.post_public_question===null?{}:{publicSummary:{question:text(row,'post_public_question'),finding:text(row,'post_public_finding')}}),
        createdAt:dateText(row.post_created_at)},reproducibility},
      delivery:{id:text(row,'delivery_id'),scopeId:text(row,'scope_id'),engineActor:text(row,'engine_actor'),createdAt:dateText(row.delivery_created_at)},
      engine:{hypothesis:{requestBody:engine.draftBody,requestBodyDigest:text(row,'draft_body_digest'),requestDigest:text(row,'draft_request_digest'),
        id:text(row,'draft_resource_id'),responseBody:engine.draftResponse,responseDigest:text(row,'draft_response_digest')},
        evidence:{requestBody:engine.evidenceBody,requestBodyDigest:text(row,'evidence_body_digest'),requestDigest:text(row,'evidence_request_digest'),
          id:text(row,'evidence_resource_id'),responseBody:engine.evidenceResponse,responseDigest:text(row,'evidence_response_digest')}},
      assessment:{engineHypothesisSupport:'UNASSESSED',engineConclusionApproval:'UNASSESSED'}};
    const encoded=JSON.stringify(pkg);if(Buffer.byteLength(encoded,'utf8')>MAX_PACKAGE_BYTES)fail('CONFLICT','Finding review package exceeds the retained size limit.');
    return{pkg,digest:digestCanonicalJson(pkg),row};
  }

  private async buildPackageV2(client:Pool|PoolClient,submissionId:string):Promise<Built>{
    const result=await client.query(`SELECT project.id::text AS project_id,project.slug,
      submission.id::text AS submission_id,submission.format AS submission_format,submission.created_at AS submission_created_at,
      submission.base_commit,submission.artifact_manifest_digest,submission.license_acceptance_ref,submission.provenance,
      work.id::text AS work_order_id,work.revision AS work_order_revision,work.project_revision,work.terms_digest AS work_terms_digest,work.terms,
      claim.id::text AS claim_id,claim.lease_epoch,claim.terms_digest AS claim_terms_digest,completion.completed_at,
      artifact.agent_token_id::text,artifact.witness_format,artifact.witness_bytes,artifact.witness_digest,artifact.report AS report_status,
      artifact.report_body,artifact.report_digest,token.owner_actor_id,token.agent_name,
      assessment.request_digest AS post_request_digest,assessment.report_digest AS post_report_digest,
      assessment.assessment AS post_assessment,assessment.next_action AS post_next_action,
      assessment.public_question AS post_public_question,assessment.public_finding AS post_public_finding,
      assessment.created_at AS post_created_at,
      reproducibility.request_digest AS repro_request_digest,reproducibility.solver_source_digest,reproducibility.trial_results_digest,
      claim_intent.research_context AS intent_research_context,claim_intent.research_references AS intent_research_references,
      claim_intent.motive_references AS intent_motive_references,claim_intent.experiment_protocol AS intent_experiment_protocol,
      claim_intent.proposal AS intent_proposal,claim_intent.expectation AS intent_expectation,claim_intent.conditions AS intent_conditions,
       claim_intent.created_at AS intent_created_at,claim_intent.request_digest AS intent_request_digest,
       claim_target.binding AS research_target
      FROM motive.projects project JOIN motive.submissions submission ON submission.project_id=project.id AND submission.id=$1
      JOIN motive.work_orders work ON work.id=submission.work_order_id AND work.project_id=submission.project_id
      JOIN motive.work_claims claim ON claim.id=submission.claim_id AND claim.project_id=submission.project_id
      JOIN motive.participation_claim_completions completion ON completion.claim_id=claim.id AND completion.submission_id=submission.id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id AND artifact.project_id=submission.project_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=submission.project_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
        AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
        AND assessment.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=submission.id
        AND reproducibility.project_id=submission.project_id AND reproducibility.agent_token_id=artifact.agent_token_id
        AND reproducibility.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_claim_intents claim_intent ON claim_intent.claim_id=claim.id
        AND claim_intent.project_id=submission.project_id AND claim_intent.work_order_id=work.id
        AND claim_intent.work_order_revision=work.revision AND claim_intent.work_order_terms_digest=work.terms_digest
        AND claim_intent.lease_epoch=claim.lease_epoch AND claim_intent.agent_token_id=artifact.agent_token_id
      LEFT JOIN motive.participation_claim_research_targets claim_target ON claim_target.claim_id=claim_intent.claim_id
        AND claim_target.project_id=claim_intent.project_id
      WHERE project.slug='circle-packing' AND project.visibility='PUBLIC' AND submission.origin='EXTERNAL'`,[submissionId]);
    if(result.rowCount!==1)fail('NOT_FOUND','A completed Motive investigation was not found.');
    const row=result.rows[0],provenance=nested(row.provenance,'submission provenance');
    const envelope=nested(provenance.investigation,'investigation provenance'),investigation=nested(envelope.investigation,'investigation') as SubmissionInvestigationInput;
    if(investigation.format!=='motive.investigation.v1')fail('CONFLICT','Stored investigation is invalid.');
    await this.validateDeclaredSources(client,text(row,'project_id'),
      [investigation.researchContext,row.intent_research_context as SubmissionResearchContext|null],
      [investigation.researchReferences,row.intent_research_references as SubmissionResearchReference[]|null],
      [investigation.motiveReferences,row.intent_motive_references as SubmissionMotiveReference[]|null]);
    const references=declaredReferences(investigation,row);
    const reproducibility=row.repro_request_digest===null?null:{requestDigest:text(row,'repro_request_digest'),
      solverSourceDigest:text(row,'solver_source_digest'),trialResultsDigest:text(row,'trial_results_digest')};
    const baseSource={declaredIntent:row.intent_proposal===null?null:{proposal:text(row,'intent_proposal'),
        expectation:text(row,'intent_expectation'),conditions:row.intent_conditions as string[],
        researchContext:row.intent_research_context as SubmissionResearchContext|null,
        researchReferences:row.intent_research_references as SubmissionResearchReference[]|null,
        motiveReferences:row.intent_motive_references as SubmissionMotiveReference[]|null,
        ...(row.intent_experiment_protocol===null?{}:{experimentProtocol:row.intent_experiment_protocol as ExperimentProtocol}),
        declaredAt:dateText(row.intent_created_at),requestDigest:text(row,'intent_request_digest')},
        submission:{id:submissionId,format:text(row,'submission_format'),createdAt:dateText(row.submission_created_at),
          baseCommit:text(row,'base_commit'),artifactManifestDigest:text(row,'artifact_manifest_digest'),
          licenseAcceptanceRef:text(row,'license_acceptance_ref')},
        attribution:{contributorActorId:text(row,'owner_actor_id'),agentTokenId:text(row,'agent_token_id'),agentName:text(row,'agent_name')},
        investigation:{proposal:String(investigation.proposal),expectation:String(investigation.expectation),conditions:[...investigation.conditions],
          observations:[...investigation.observations],assessment:String(investigation.assessment),nextAction:String(investigation.nextAction),
          digest:digestCanonicalJson(investigation)},references,artifact:{format:text(row,'witness_format'),
          witness:(row.witness_bytes as Buffer).toString('utf8'),digest:text(row,'witness_digest')},
        report:{status:text(row,'report_status') as FindingReviewPackage['source']['report']['status'],body:row.report_body,
          digest:text(row,'report_digest')},postCheck:{requestDigest:text(row,'post_request_digest'),reportDigest:text(row,'post_report_digest'),
          assessment:text(row,'post_assessment'),nextAction:text(row,'post_next_action'),
          ...(row.post_public_question===null?{}:{publicSummary:{question:text(row,'post_public_question'),finding:text(row,'post_public_finding')} }),
          createdAt:dateText(row.post_created_at)},reproducibility};
    const root={findingId:submissionId,
      project:{id:text(row,'project_id'),slug:'circle-packing' as const,revision:Number(row.project_revision)},
      workOrder:{id:text(row,'work_order_id'),revision:Number(row.work_order_revision),projectRevision:Number(row.project_revision),
        termsDigest:text(row,'work_terms_digest'),terms:row.terms},claim:{id:text(row,'claim_id'),leaseEpoch:Number(row.lease_epoch),
        termsDigest:text(row,'claim_terms_digest'),completedAt:dateText(row.completed_at)},
      assessment:{engineHypothesisSupport:'UNASSESSED' as const,engineConclusionApproval:'UNASSESSED' as const}};
    const pkg:FindingReviewPackage=row.research_target===null
      ?{...root,format:'motive.finding-review-package/0.2',source:baseSource}
      :{...root,format:'motive.finding-review-package/0.3',source:{...baseSource,target:row.research_target}} as FindingReviewPackage;
    validateNativeCanonicalJson(pkg);
    const encoded=JSON.stringify(pkg);if(Buffer.byteLength(encoded,'utf8')>MAX_PACKAGE_BYTES)fail('CONFLICT','Finding review package exceeds the retained size limit.');
    return{pkg,digest:digestCanonicalJson(pkg),row};
  }

  private async buildPackage(client:Pool|PoolClient,submissionId:string,latest:QueryResultRow|null):Promise<Built>{
    if(latest){const stored=this.storedPackage(latest);
      if(stored.format==='motive.finding-review-package/0.1')return this.buildPackageV1(client,submissionId);
      if(!['motive.finding-review-package/0.2','motive.finding-review-package/0.3'].includes(stored.format))fail('CONFLICT','Stored finding review package is invalid.');}
    return this.buildPackageV2(client,submissionId);
  }

  private storedPackage(row:QueryResultRow):FindingReviewPackage{
    const stored=row.review_package;if(!object(stored)
      ||!['motive.finding-review-package/0.1','motive.finding-review-package/0.2','motive.finding-review-package/0.3'].includes(String(stored.format)))
      fail('CONFLICT','Stored finding review package digest is invalid.');
    if(stored.format!=='motive.finding-review-package/0.1')validateNativeCanonicalJson(stored);
    if(digestCanonicalJson(stored)!==text(row,'review_package_digest'))
      fail('CONFLICT','Stored finding review package digest is invalid.');
    return stored as FindingReviewPackage;
  }

  private evidence(pkg:FindingReviewPackage):FindingReviewEvidenceReference{return{artifactDigest:pkg.source.artifact.digest,
    reportDigest:pkg.source.report.digest,investigationDigest:pkg.source.investigation.digest,
    postCheckRequestDigest:pkg.source.postCheck.requestDigest,reproducibility:pkg.source.reproducibility,
    declaredIntent:pkg.source.declaredIntent,declared:pkg.source.references,
    engineEvidence:pkg.format==='motive.finding-review-package/0.1'
      ?{id:pkg.engine.evidence.id,responseDigest:pkg.engine.evidence.responseDigest}:null};}
  private publicDecision(row:QueryResultRow):FindingReviewPublicDecision{const pkg=this.storedPackage(row);
    return{id:text(row,'id'),decision:text(row,'decision') as FindingReviewPublicDecision['decision'],
      ...(row.reviewer_agent_token_id===null||row.reviewer_agent_token_id===undefined?{}:{
        reviewerAgentTokenId:text(row,'reviewer_agent_token_id'),reviewSubmissionId:text(row,'review_submission_id')}),
      outcome:row.outcome as FindingReviewPublicDecision['outcome'],finding:row.finding as string|null,
      limitations:row.limitations as string|null,novelty:row.novelty as FindingReviewPublicDecision['novelty'],
      duplicateOfSubmissionId:row.duplicate_of_submission_id===null?null:text(row,'duplicate_of_submission_id'),
      rationale:text(row,'rationale'),reviewedAt:dateText(row.created_at),packageDigest:text(row,'review_package_digest'),
      evidence:this.evidence(pkg),hypothesis:pkg.format==='motive.finding-review-package/0.1'?{id:pkg.engine.hypothesis.id,
        statement:String(nested(pkg.engine.hypothesis.responseBody,'hypothesis response').statement),responseDigest:pkg.engine.hypothesis.responseDigest}:null};}
  private privateDecision(row:QueryResultRow):FindingReviewPrivateDecision{return{...this.publicDecision(row),
    reviewerActorId:text(row,'reviewer_actor_id'),previousDecisionId:row.previous_decision_id===null?null:text(row,'previous_decision_id'),
    duplicateOfDecisionId:row.duplicate_of_decision_id===null?null:text(row,'duplicate_of_decision_id')}};
  private historyDecision(row:QueryResultRow):FindingReviewHistoryDecision{return{...this.publicDecision(row),
    previousDecisionId:row.previous_decision_id===null?null:text(row,'previous_decision_id')}};
  private async tail(submissionId:string,client:Pool|PoolClient=this.options.pool){const result=await client.query(`SELECT item.* FROM motive.finding_review_decisions item
    WHERE item.source_submission_id=$1 AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
      WHERE successor.previous_decision_id=item.id)`,[submissionId]);return result.rowCount===1?result.rows[0]:null;}

  private async agentProof(client:PoolClient,context:ParticipationAgentContext,reviewSubmissionId:string,
    targetId:string,lock:'SHARE'|'UPDATE',extraSubmissionId?:string|null){
    if(!UUID.test(context.tokenId)||!ACCOUNT.test(context.ownerActorId)||!UUID.test(context.projectId)
      ||!UUID.test(reviewSubmissionId)||!UUID.test(targetId)||extraSubmissionId!==undefined&&extraSubmissionId!==null&&!UUID.test(extraSubmissionId))
      fail('VALIDATION','Agent finding review identifiers are invalid.');
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    const authority=await client.query(`SELECT token.id FROM motive.participation_agent_tokens token
      JOIN motive.projects project ON project.id=token.project_id
      JOIN motive.memberships membership ON membership.project_id=project.id
        AND membership.actor_id=token.owner_actor_id AND membership.revoked_at IS NULL
      JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id AND identity.status='ACTIVE'
      WHERE token.id=$1 AND token.project_id=$2 AND token.owner_actor_id=$3
        AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
      FOR SHARE OF token,project,membership,identity`,[context.tokenId,context.projectId,context.ownerActorId]);
    if(authority.rowCount!==1)fail('FORBIDDEN','Current replication credential authority is required.');
    const ids=[...new Set([reviewSubmissionId,targetId,...(extraSubmissionId?[extraSubmissionId]:[])])].sort();
    const completed=await client.query(`SELECT submission_id::text FROM motive.participation_claim_completions
      WHERE submission_id=ANY($1::uuid[]) ORDER BY submission_id FOR ${lock}`,[ids]);
    if(completed.rowCount!==ids.length)fail('FORBIDDEN','Completed review and target evidence are required.');
    const proof=await client.query(`SELECT motive.valid_agent_finding_review_proof($1,$2,$3,$4,$5) AS valid`,
      [context.ownerActorId,context.tokenId,reviewSubmissionId,targetId,context.projectId]);
    if(proof.rows[0]?.valid!==true)fail('FORBIDDEN','Exact current replication proof is required.');
    const targetProof=await client.query(`SELECT source_target.binding AS source_binding,review_target.binding AS review_binding
      FROM motive.submissions source_item
      JOIN motive.submissions review_item ON review_item.id=$2 AND review_item.project_id=source_item.project_id
      LEFT JOIN motive.participation_claim_research_targets source_target ON source_target.claim_id=source_item.claim_id
      LEFT JOIN motive.participation_claim_research_targets review_target ON review_target.claim_id=review_item.claim_id
      WHERE source_item.id=$1 AND source_item.project_id=$3`,[targetId,reviewSubmissionId,context.projectId]);
    if(targetProof.rowCount!==1||!same(targetProof.rows[0].source_binding,targetProof.rows[0].review_binding))
      fail('FORBIDDEN','Replication must preserve the exact pre-test research delivery target.');
  }

  async previewFromAgent(context:ParticipationAgentContext,reviewSubmissionId:string,targetId:string):Promise<FindingReviewAgentPreview>{
    return this.transaction(async client=>{
      await this.agentProof(client,context,reviewSubmissionId,targetId,'SHARE');
      const project=await this.projectFor(targetId,client);
      if(!project||text(project,'project_id')!==context.projectId)fail('NOT_FOUND','Finding review is not available.');
      const readiness=await this.readiness(targetId,client);
      if(readiness!==null)fail(readiness==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Finding review is not available.');
      const latest=await this.tail(targetId,client);const built=await this.buildPackage(client,targetId,latest);
      if(!['motive.finding-review-package/0.2','motive.finding-review-package/0.3'].includes(built.pkg.format))
        fail('CONFLICT','Automatic review requires a native finding package.');
      const reviewed=await client.query(`SELECT * FROM motive.finding_review_decisions
        WHERE review_submission_id=$1`,[reviewSubmissionId]);
      return{format:'motive.finding-review.preview/0.1',submissionId:targetId,package:built.pkg,packageDigest:built.digest,
        latestDecision:latest?this.privateDecision(latest):null,reviewerAgentTokenId:context.tokenId,reviewSubmissionId,
        reviewDecision:reviewed.rowCount===1?this.privateDecision(reviewed.rows[0]):null};
    });
  }

  async decideFromAgent(context:ParticipationAgentContext,reviewSubmissionId:string,targetId:string,
    input:FindingReviewDecisionInput,idempotencyKey:string):Promise<FindingReviewAgentDecisionResponse>{
    const saved=await this.persistAgentDecision(context,reviewSubmissionId,targetId,input,idempotencyKey);
    let memoryAdmission:FindingReviewMemoryStatus;
    if(saved.decision==='DECLINE')memoryAdmission={status:'NOT_REQUESTED',reason:'FINDING_DECLINED'};
    else{
      // The scientific decision is already committed. Missing memory infrastructure
      // must not lose it or make a retry look like a second scientific decision.
      try{memoryAdmission=this.options.admitAgentFinding
        ?await this.options.admitAgentFinding(context,saved.id)
        :{status:'PENDING',reason:'MEMORY_UNAVAILABLE'};}
      catch{memoryAdmission={status:'PENDING',reason:'MEMORY_UNAVAILABLE'};}
    }
    return{...saved,memoryAdmission};
  }

  private async persistAgentDecision(context:ParticipationAgentContext,reviewSubmissionId:string,targetId:string,
    input:FindingReviewDecisionInput,idempotencyKey:string):Promise<Omit<FindingReviewAgentDecisionResponse,'memoryAdmission'>>{
    this.validateInput(input,idempotencyKey);
    const requestDigest=digestCanonicalJson({reviewerAgentTokenId:context.tokenId,reviewSubmissionId,targetId,...input});
    try{return await this.transaction(async client=>{
      await this.agentProof(client,context,reviewSubmissionId,targetId,'UPDATE',input.duplicateOfSubmissionId);
      const replay=await client.query(`SELECT * FROM motive.finding_review_decisions
        WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[context.ownerActorId,idempotencyKey]);
      if(replay.rowCount){const row=replay.rows[0];
        if(row.reviewer_agent_token_id!==context.tokenId||row.review_submission_id!==reviewSubmissionId
          ||row.source_submission_id!==targetId||text(row,'request_digest')!==requestDigest)
          fail('CONFLICT','Idempotency-Key is bound to another finding review.');
        return{format:'motive.finding-review.decision/0.1',submissionId:targetId,...this.privateDecision(row),
          reviewerAgentTokenId:context.tokenId,reviewSubmissionId,replayed:true};}
      const used=await client.query(`SELECT id FROM motive.finding_review_decisions WHERE review_submission_id=$1`,[reviewSubmissionId]);
      if(used.rowCount)fail('CONFLICT','Review submission has already recorded a finding decision.');
      const project=await this.projectFor(targetId,client);
      if(!project||text(project,'project_id')!==context.projectId)fail('NOT_FOUND','Finding review was not found.');
      const latest=await this.tail(targetId,client);const built=await this.buildPackage(client,targetId,latest);
      if(!['motive.finding-review-package/0.2','motive.finding-review-package/0.3'].includes(built.pkg.format))
        fail('CONFLICT','Automatic review requires a native finding package.');
      if(built.digest!==input.packageDigest)fail('CONFLICT','Finding review package has changed.');
      if((latest?text(latest,'id'):null)!==input.expectedDecisionId)fail('CONFLICT','Finding review expected decision is stale.');
      let duplicateDecisionId:string|null=null;
      if(input.novelty==='DUPLICATE'){
        if(input.duplicateOfSubmissionId===targetId)fail('CONFLICT','A finding cannot duplicate itself.');
        const duplicateProject=await this.projectFor(input.duplicateOfSubmissionId!,client);
        if(!duplicateProject||text(duplicateProject,'project_id')!==context.projectId)fail('CONFLICT','Duplicate finding target is unavailable.');
        const duplicate=await this.tail(input.duplicateOfSubmissionId!,client);
        if(!duplicate||duplicate.decision!=='ACCEPT'||duplicate.novelty!=='DISTINCT')fail('CONFLICT','Duplicate target must be a current accepted distinct finding.');
        duplicateDecisionId=text(duplicate,'id');
      }
      const id=randomUUID();const saved=await client.query(`INSERT INTO motive.finding_review_decisions
        (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
         finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,
         reviewer_agent_token_id,review_submission_id,rationale,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT DO NOTHING RETURNING *`,[id,context.projectId,targetId,JSON.stringify(built.pkg),built.digest,
        input.expectedDecisionId,input.decision,input.outcome,input.finding,input.limitations,input.novelty,
        input.duplicateOfSubmissionId,duplicateDecisionId,context.ownerActorId,context.tokenId,reviewSubmissionId,
        input.rationale,idempotencyKey,requestDigest]);
      if(saved.rowCount)return{format:'motive.finding-review.decision/0.1',submissionId:targetId,
        ...this.privateDecision(saved.rows[0]),reviewerAgentTokenId:context.tokenId,reviewSubmissionId,replayed:false};
      const concurrent=await client.query(`SELECT * FROM motive.finding_review_decisions
        WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[context.ownerActorId,idempotencyKey]);
      if(concurrent.rowCount!==1||concurrent.rows[0].reviewer_agent_token_id!==context.tokenId
        ||concurrent.rows[0].review_submission_id!==reviewSubmissionId
        ||concurrent.rows[0].source_submission_id!==targetId||text(concurrent.rows[0],'request_digest')!==requestDigest)
        fail('CONFLICT','Finding review conflicts with retained state.');
      return{format:'motive.finding-review.decision/0.1',submissionId:targetId,
        ...this.privateDecision(concurrent.rows[0]),reviewerAgentTokenId:context.tokenId,reviewSubmissionId,replayed:true};
    });}catch(error){const code=(error as{code?:string}).code;
      if(code==='42501')fail('FORBIDDEN','Exact current replication proof is required.');
      if(['40001','23505','23503','23514','22P02'].includes(String(code)))fail('CONFLICT','Finding review conflicts with retained state.');
      throw error;}
  }

  async eligibility(actorId:string,submissionId:string):Promise<FindingReviewEligibility>{
    const project=await this.projectFor(submissionId);if(!project)return{format:'motive.finding-review.eligibility/0.1',submissionId,canReview:false,reason:'NOT_FOUND'};
    const original=await this.originalContributor(submissionId);if(original===actorId)return{format:'motive.finding-review.eligibility/0.1',submissionId,canReview:false,reason:'ORIGINAL_CONTRIBUTOR'};
    const authority=await this.authority(this.options.pool,actorId,text(project,'project_id'));
    if(authority!=='ELIGIBLE')return{format:'motive.finding-review.eligibility/0.1',submissionId,canReview:false,reason:authority};
    if(!await this.options.isActorActive(actorId))return{format:'motive.finding-review.eligibility/0.1',submissionId,canReview:false,reason:'ACCOUNT_INACTIVE'};
    const readiness=await this.readiness(submissionId);return{format:'motive.finding-review.eligibility/0.1',submissionId,
      canReview:readiness===null,reason:readiness??'ELIGIBLE'};
  }

  async preview(actorId:string,submissionId:string):Promise<FindingReviewPreview>{
    if(!ACCOUNT.test(actorId)||!await this.options.isActorActive(actorId))fail('FORBIDDEN','Finding review is not available.');
    return this.transaction(async client=>{
      const project=await this.projectFor(submissionId,client);if(!project)fail('NOT_FOUND','Finding review is not available.');
      const projectId=text(project,'project_id');const authority=await this.authority(client,actorId,projectId,true);
      if(authority!=='ELIGIBLE')fail('FORBIDDEN','Finding review is not available.');
      const original=await this.originalContributor(submissionId,client);
      if(original===actorId)fail('FORBIDDEN','Finding review is not available.');
      const locked=await client.query(`SELECT submission_id FROM motive.participation_claim_completions
        WHERE submission_id=$1 FOR SHARE`,[submissionId]);
      if(locked.rowCount!==1)fail('FORBIDDEN','Finding review is not available.');
      const readiness=await this.readiness(submissionId,client);
      if(readiness!==null)fail(readiness==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Finding review is not available.');
      const latest=await this.tail(submissionId,client);const built=await this.buildPackage(client,submissionId,latest);
      return{format:'motive.finding-review.preview/0.1',submissionId,package:built.pkg,packageDigest:built.digest,
        latestDecision:latest?this.privateDecision(latest):null};
    });
  }

  private validateInput(input:FindingReviewDecisionInput,key:string){
    if(!object(input)||!exact(input,['packageDigest','expectedDecisionId','decision','outcome','finding','limitations','novelty','duplicateOfSubmissionId','rationale'])
      ||!DIGEST.test(String(input.packageDigest))||!(input.expectedDecisionId===null||typeof input.expectedDecisionId==='string'&&UUID.test(input.expectedDecisionId))
      ||!['ACCEPT','DECLINE'].includes(String(input.decision))||typeof input.rationale!=='string'||input.rationale.trim()!==input.rationale
      ||input.rationale.length<1||input.rationale.length>2000||!KEY.test(key))fail('VALIDATION','Finding review input is invalid.');
    if(input.decision==='DECLINE'){
      if(input.outcome!==null||input.finding!==null||input.limitations!==null||input.novelty!==null||input.duplicateOfSubmissionId!==null)
        fail('VALIDATION','A declined finding must leave outcome and finding fields null.');return;
    }
    if(!['SUPPORTED','CONTRADICTED','INCONCLUSIVE'].includes(String(input.outcome))
      ||typeof input.finding!=='string'||input.finding.trim()!==input.finding||input.finding.length<1||input.finding.length>2000
      ||typeof input.limitations!=='string'||input.limitations.trim()!==input.limitations||input.limitations.length<1||input.limitations.length>2000
      ||!['DISTINCT','DUPLICATE'].includes(String(input.novelty)))fail('VALIDATION','An accepted finding requires bounded outcome, finding, limitations, and novelty.');
    if(input.novelty==='DISTINCT'&&input.duplicateOfSubmissionId!==null||input.novelty==='DUPLICATE'
      &&(typeof input.duplicateOfSubmissionId!=='string'||!UUID.test(input.duplicateOfSubmissionId)))
      fail('VALIDATION','Finding novelty and duplicate target are inconsistent.');
  }

  async decide(actorId:string,submissionId:string,input:FindingReviewDecisionInput,idempotencyKey:string):Promise<FindingReviewDecisionResponse>{
    this.validateInput(input,idempotencyKey);if(!ACCOUNT.test(actorId)||!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current active account is required.');
    const requestDigest=digestCanonicalJson({submissionId,...input});
    const prior=await this.options.pool.query(`SELECT project_id::text,source_submission_id::text
      FROM motive.finding_review_decisions WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[actorId,idempotencyKey]);
    if(prior.rowCount){return this.transaction(async client=>{
      const projectId=text(prior.rows[0],'project_id'),storedSubmissionId=text(prior.rows[0],'source_submission_id');
      const authority=await this.authority(client,actorId,projectId,true);if(authority!=='ELIGIBLE')fail('FORBIDDEN','Current reviewer authority is required.');
      const locked=await client.query(`SELECT submission_id FROM motive.participation_claim_completions
        WHERE submission_id=$1 FOR UPDATE`,[storedSubmissionId]);
      if(locked.rowCount!==1)fail('CONFLICT','Finding review requires its completed source investigation.');
      const replay=await client.query(`SELECT * FROM motive.finding_review_decisions
        WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[actorId,idempotencyKey]);
      if(replay.rowCount!==1||text(replay.rows[0],'request_digest')!==requestDigest)
        fail('CONFLICT','Idempotency-Key is bound to another finding review.');
      return{format:'motive.finding-review.decision/0.1',submissionId,...this.privateDecision(replay.rows[0]),replayed:true};
    });}
    const project=await this.projectFor(submissionId);if(!project)fail('NOT_FOUND','Finding review was not found.');const projectId=text(project,'project_id');
    try{return await this.transaction(async client=>{
      const authority=await this.authority(client,actorId,projectId,true);if(authority!=='ELIGIBLE')fail('FORBIDDEN','Current reviewer authority is required.');
      const original=await this.originalContributor(submissionId,client);if(original===actorId)fail('FORBIDDEN','An independent reviewer is required.');
      const lockIds=[submissionId,...(input.duplicateOfSubmissionId?[input.duplicateOfSubmissionId]:[])].sort();
      const locked=await client.query(`SELECT submission_id::text FROM motive.participation_claim_completions
        WHERE submission_id=ANY($1::uuid[]) ORDER BY submission_id FOR UPDATE`,[lockIds]);
      if(locked.rowCount!==lockIds.length)fail('CONFLICT','Finding review requires completed source investigations.');
      const replay=await client.query(`SELECT * FROM motive.finding_review_decisions WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[actorId,idempotencyKey]);
      if(replay.rowCount){if(text(replay.rows[0],'request_digest')!==requestDigest)fail('CONFLICT','Idempotency-Key is bound to another finding review.');
        return{format:'motive.finding-review.decision/0.1',submissionId,...this.privateDecision(replay.rows[0]),replayed:true};}
      const latest=await this.tail(submissionId,client);const built=await this.buildPackage(client,submissionId,latest);
      if(built.digest!==input.packageDigest)fail('CONFLICT','Finding review package has changed.');
      if((latest?text(latest,'id'):null)!==input.expectedDecisionId)fail('CONFLICT','Finding review expected decision is stale.');
      let duplicateDecisionId:string|null=null;
      if(input.novelty==='DUPLICATE'){
        if(input.duplicateOfSubmissionId===submissionId)fail('CONFLICT','A finding cannot duplicate itself.');
        const duplicateProject=await this.projectFor(input.duplicateOfSubmissionId!,client);
        if(!duplicateProject||text(duplicateProject,'project_id')!==projectId)fail('CONFLICT','Duplicate finding target is unavailable.');
        const duplicate=await this.tail(input.duplicateOfSubmissionId!,client);
        if(!duplicate||duplicate.decision!=='ACCEPT'||duplicate.novelty!=='DISTINCT')fail('CONFLICT','Duplicate target must be a current accepted distinct finding.');
        duplicateDecisionId=text(duplicate,'id');
      }
      const id=randomUUID();const saved=await client.query(`INSERT INTO motive.finding_review_decisions
        (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
         finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT(reviewer_actor_id,idempotency_key) DO NOTHING RETURNING *`,
      [id,projectId,submissionId,JSON.stringify(built.pkg),built.digest,input.expectedDecisionId,input.decision,input.outcome,
        input.finding,input.limitations,input.novelty,input.duplicateOfSubmissionId,duplicateDecisionId,actorId,input.rationale,idempotencyKey,requestDigest]);
      if(saved.rowCount)return{format:'motive.finding-review.decision/0.1',submissionId,...this.privateDecision(saved.rows[0]),replayed:false};
      const concurrent=await client.query(`SELECT * FROM motive.finding_review_decisions
        WHERE reviewer_actor_id=$1 AND idempotency_key=$2`,[actorId,idempotencyKey]);
      if(concurrent.rowCount!==1||text(concurrent.rows[0],'request_digest')!==requestDigest)
        fail('CONFLICT','Idempotency-Key is bound to another finding review.');
      return{format:'motive.finding-review.decision/0.1',submissionId,...this.privateDecision(concurrent.rows[0]),replayed:true};
    });}catch(error){const code=(error as{code?:string}).code;if(code==='42501')fail('FORBIDDEN','Current independent reviewer authority is required.');
      if(['40001','23505','23503','23514','22P02'].includes(String(code)))fail('CONFLICT','Finding review conflicts with retained state.');throw error;}
  }

  async publicReview(projectSlug:string,submissionId:string):Promise<FindingReviewPublicProjection>{
    if(projectSlug!=='circle-packing'||!UUID.test(submissionId))fail('NOT_FOUND','Submission was not found.');
    const project=await this.projectFor(submissionId);if(!project)fail('NOT_FOUND','Submission was not found.');
    const readiness=await this.readiness(submissionId);const latest=await this.tail(submissionId);
    return{format:'motive.finding-review.public/0.1',submissionId,available:readiness===null,
      reason:readiness,latestDecision:latest?this.publicDecision(latest):null};
  }

  async publicHistory(projectSlug:string,submissionId:string,before?:string):Promise<FindingReviewHistoryPage>{
    if(projectSlug!=='circle-packing'||!UUID.test(submissionId)||before!==undefined&&!UUID.test(before))
      fail('NOT_FOUND','Finding review history was not found.');
    const result=await this.options.pool.query(`WITH RECURSIVE subject AS (
        SELECT submission.id AS submission_id,submission.project_id
        FROM motive.submissions submission JOIN motive.projects project ON project.id=submission.project_id
        WHERE submission.id=$1 AND project.slug=$2 AND project.visibility='PUBLIC'
      ), latest AS (
        SELECT decision.id
        FROM motive.finding_review_decisions decision JOIN subject
          ON subject.project_id=decision.project_id AND subject.submission_id=decision.source_submission_id
        WHERE NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
          WHERE successor.previous_decision_id=decision.id AND successor.project_id=decision.project_id
            AND successor.source_submission_id=decision.source_submission_id)
      ), cursor_row AS (
        SELECT decision.id,decision.previous_decision_id
        FROM motive.finding_review_decisions decision JOIN subject
          ON subject.project_id=decision.project_id AND subject.submission_id=decision.source_submission_id
        WHERE decision.id=$3::uuid
      ), anchor AS (
        SELECT subject.submission_id,latest.id AS latest_decision_id,
          CASE WHEN $3::uuid IS NULL THEN latest.id ELSE cursor_row.previous_decision_id END AS start_id,
          ($3::uuid IS NULL OR cursor_row.id IS NOT NULL) AS cursor_found
        FROM subject LEFT JOIN latest ON true LEFT JOIN cursor_row ON true
      ), history AS (
        SELECT decision.id,decision.previous_decision_id,decision.project_id,decision.source_submission_id,1 AS depth
        FROM motive.finding_review_decisions decision
        JOIN anchor ON decision.id=anchor.start_id
        UNION ALL
        SELECT predecessor.id,predecessor.previous_decision_id,predecessor.project_id,
          predecessor.source_submission_id,history.depth+1
        FROM history
        JOIN motive.finding_review_decisions predecessor ON predecessor.id=history.previous_decision_id
          AND predecessor.project_id=history.project_id
          AND predecessor.source_submission_id=history.source_submission_id
        WHERE history.depth<21
      )
      SELECT anchor.submission_id,anchor.latest_decision_id,anchor.cursor_found,
        EXISTS(SELECT 1 FROM history lookahead WHERE lookahead.depth=21) AS has_more,decision.*
      FROM anchor LEFT JOIN history ON history.depth<=20
      LEFT JOIN motive.finding_review_decisions decision ON decision.id=history.id
      ORDER BY history.depth NULLS LAST`,[submissionId,projectSlug,before??null]);
    if(!result.rowCount||result.rows[0].cursor_found!==true)fail('NOT_FOUND','Finding review history was not found.');
    const decisions=result.rows.filter(row=>row.id!==null).map(row=>this.historyDecision(row));
    return{format:'motive.finding-review.history/0.1',submissionId,
      latestDecisionId:result.rows[0].latest_decision_id===null?null:text(result.rows[0],'latest_decision_id'),items:decisions,
      nextCursor:result.rows[0].has_more===true?decisions[decisions.length-1]!.id:null};
  }
}

export function createFindingAssessmentService(options:Options){return new FindingAssessmentService(options);}
