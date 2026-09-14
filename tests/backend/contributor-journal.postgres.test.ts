import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, ParticipationError, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('public contributor research journal on isolated PostgreSQL',()=>{
  const databaseName=`motive_contributor_journal_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:contributor-journal-${randomUUID()}`;
  const tokenSecret='contributor-journal-test-secret-more-than-thirty-two-bytes';
  let admin:Pool;let pool:Pool;let service:ParticipationService;let projectId:string;let assignmentId:string;let testUrl:string;
  let scopeId:string;

  beforeAll(async()=>{
    const source=new URL(baseUrl!);expect(['localhost','127.0.0.1']).toContain(source.hostname);
    const adminUrl=new URL(source);adminUrl.pathname='/postgres';admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated=new URL(source);isolated.pathname=`/${databaseName}`;testUrl=isolated.toString();
    pool=new Pool({connectionString:testUrl,max:4});await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Contributor journal test'}})).id;
    service=createParticipationService(pool,{tokenSecret,issuerActorId:issuer});
    assignmentId=(await service.ensureCircleWorkOrder()).id;
    scopeId=randomUUID();
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,clock_timestamp())`,[scopeId,projectId,randomUUID(),randomUUID(),
      `sha256:${'a'.repeat(64)}`,Buffer.alloc(48,7),`sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'d'.repeat(40),issuer]);
  },30_000);

  afterAll(async()=>{await pool?.end();if(admin){await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}});

  async function participant(name:string,publish:boolean,owner=`account:${randomUUID()}`){
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()) ON CONFLICT(actor_id) DO NOTHING`,[owner,randomUUID()]);
    const joined=await service.join(owner,name,{projectSlug:'circle-packing',publishDisplayName:publish,
      acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context=await service.authenticateBearer(joined.token);
    const claim=await service.claimAssignment(context,assignmentId,`claim-${randomUUID()}`);
    const membership=(await pool.query(`SELECT id::text FROM motive.memberships WHERE project_id=$1 AND actor_id=$2`,
      [projectId,owner])).rows[0];
    return{owner,joined,context,claim,membershipId:String(membership.id)};
  }

  async function insertSubmission(input:{projectId:string;workOrderId:string;tokenId:string;claimId:string;
    leaseEpoch:number;createdAt:string;id?:string;displayName?:string|null}){
    const id=input.id??randomUUID();const witness=Buffer.from(`{"contributor-journal":"${id}"}`);
    const witnessDigest=digestCanonicalJson({kind:'contributor-journal-witness',id});
    const reportBody={format:'contributor-journal-test-report',submissionId:id};const reportDigest=digestCanonicalJson(reportBody);
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status,created_at)
      SELECT $1,$2,$3,work.revision,'EXTERNAL','agent:' || token.id::text,$4,$5,'motive.submission/0.1',$6,$7,
        '{}'::jsonb,'unmetered_external',token.license_acceptance_ref,'REJECTED',$8::timestamptz
      FROM motive.work_orders work JOIN motive.participation_agent_tokens token ON token.id=$9 WHERE work.id=$3`,
    [id,input.projectId,input.workOrderId,input.claimId,input.leaseEpoch,'0'.repeat(40),
      digestCanonicalJson({kind:'contributor-journal-manifest',id}),input.createdAt,input.tokenId]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,
       report_digest,contributor_display_name,created_at)
      SELECT $1,$2,token.id,'motive.csqv.witness.v1',$3,$4,'REJECTED',$5::jsonb,$6,
        CASE WHEN $7::boolean THEN $8::text ELSE token.public_display_name END,$9::timestamptz
      FROM motive.participation_agent_tokens token WHERE token.id=$10`,[id,input.projectId,witness,witnessDigest,
      JSON.stringify(reportBody),reportDigest,input.displayName!==undefined,input.displayName??null,input.createdAt,input.tokenId]);
    return{id,reportDigest};
  }

  async function foreignProjectSubmission(createdAt:string){
    const foreignIssuer=`operator:foreign-contributor-${randomUUID()}`;
    const foreignProjectId=(await new LedgerKernel(pool).createProject({actorId:foreignIssuer,idempotencyKey:randomUUID(),
      slug:`foreign-${randomUUID()}`,visibility:'PUBLIC',revisionContent:{title:'Foreign contributor journal'}})).id;
    const sourceWork=(await pool.query('SELECT * FROM motive.work_orders WHERE id=$1',[assignmentId])).rows[0];
    const workOrderId=randomUUID();const terms={...(sourceWork.terms as Record<string,unknown>),project_id:foreignProjectId};
    const termsDigest=digestCanonicalJson(terms);
    await pool.query(`INSERT INTO motive.work_orders
      (id,project_id,work_order_key,revision,project_revision,terms_format,terms,terms_digest,created_by)
      VALUES($1,$2,'foreign-contributor-journal',1,1,'motive.work-order/0.1',$3::jsonb,$4,$5)`,
    [workOrderId,foreignProjectId,JSON.stringify(terms),termsDigest,foreignIssuer]);
    await pool.query(`INSERT INTO motive.work_order_states(work_order_id,state,state_revision,updated_by)
      VALUES($1,'READY',1,$2)`,[workOrderId,foreignIssuer]);
    const owner=`account:${randomUUID()}`,membershipId=randomUUID(),tokenId=randomUUID(),claimId=randomUUID();
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'CONTRIBUTOR',ARRAY['external:claim','external:submit'],$4)`,[membershipId,foreignProjectId,owner,foreignIssuer]);
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,public_display_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'Foreign agent','Foreign person',$4,$5,'journal-test',clock_timestamp()+interval '1 day')`,
    [tokenId,foreignProjectId,owner,digestCanonicalJson({tokenId}),'f'.repeat(12)]);
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at,released_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'RELEASED',clock_timestamp()+interval '1 day',clock_timestamp())`,
    [claimId,foreignProjectId,workOrderId,`agent:${tokenId}`,termsDigest]);
    const submission=await insertSubmission({projectId:foreignProjectId,workOrderId,tokenId,claimId,leaseEpoch:1,createdAt});
    return{membershipId:String(membershipId),submissionId:submission.id};
  }

  async function seedCorrectedAdmission(submissionId:string,tokenId:string,reportDigest:string){
    const assessment='The contributor journal retains this corrected review.';const nextAction='Continue from the retained finding.';
    const assessmentRequest=digestCanonicalJson({submissionId,assessment,nextAction});
    await pool.query(`INSERT INTO motive.participation_post_check_assessments
      (submission_id,project_id,agent_token_id,report_digest,assessment,next_action,request_digest,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'2026-09-09T04:00:01.000Z')`,
    [submissionId,projectId,tokenId,reportDigest,assessment,nextAction,assessmentRequest]);
    const scope=(await pool.query(`SELECT api_base_url,configuration_digest,api_version FROM motive.project_research_scopes WHERE id=$1`,[scopeId])).rows[0];
    const intentId=randomUUID(),deliveryId=randomUUID(),engineActor=`motive:project:${projectId}`;
    const payload={format:'motive.hypothesis-writeback-preparation/0.1',disposition:'PROPOSED_UNREVIEWED',state:'ENGINE_WRITE_UNAVAILABLE',
      scope:{scopeId,projectId,configurationDigest:scope.configuration_digest,apiVersion:scope.api_version},attribution:{engineActor},
      source:{submission:{id:submissionId}},assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'}};
    const payloadDigest=digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.hypothesis_writeback_intents
      (id,project_id,scope_id,source_submission_id,prepared_by_actor_id,idempotency_key,request_digest,payload,payload_digest,
       engine_actor,disposition,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'PROPOSED_UNREVIEWED','ENGINE_WRITE_UNAVAILABLE')`,
    [intentId,projectId,scopeId,submissionId,issuer,`intent-${randomUUID()}`,digestCanonicalJson({submissionId}),JSON.stringify(payload),payloadDigest,engineActor]);
    await pool.query(`INSERT INTO motive.hypothesis_submission_deliveries
      (id,project_id,scope_id,source_submission_id,source_intent_id,source_intent_payload_digest,engine_actor,engine_api_base_url,
       scope_configuration_digest,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
       reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'test-contract',$12,$13,$14)`,
    [deliveryId,projectId,scopeId,submissionId,intentId,payloadDigest,engineActor,scope.api_base_url,scope.configuration_digest,
      scope.api_version,`sha256:${'1'.repeat(64)}`,'2'.repeat(64),'3'.repeat(64),issuer]);
    const body={statement:'Durably delivered draft.'};
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_operations
      (delivery_id,operation,target_hypothesis_id,request_path,idempotency_key,request_body,request_body_digest,request_digest)
      VALUES($1,'DRAFT_HYPOTHESIS',NULL,'/api/v1/hypotheses',$2,$3::jsonb,$4,$5)`,
    [deliveryId,`motive-delivery:${deliveryId}:draft`,JSON.stringify(body),digestCanonicalJson(body),digestCanonicalJson({body})]);
    const response={id:randomUUID()};
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_results
      (delivery_id,operation,resource_id,response_body,response_digest) VALUES($1,'DRAFT_HYPOTHESIS',$2,$3::jsonb,$4)`,
    [deliveryId,response.id,JSON.stringify(response),digestCanonicalJson(response)]);
    const reviewer=`account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[reviewer,randomUUID()]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'STEWARD',ARRAY['project:review'],$4)`,[randomUUID(),projectId,reviewer,issuer]);
    const row=(await pool.query(`SELECT delivery.*,artifact.report AS report_status,artifact.report_digest,
        artifact.exact_score,artifact.exceeds_reference,assessment.request_digest AS assessment_request_digest,
        assessment.report_digest AS assessment_report_digest,assessment.assessment AS assessment_text,
        assessment.next_action,assessment.created_at AS assessment_created_at,draft.request_path,draft.request_body,
        draft.request_body_digest,draft.request_digest AS draft_request_digest
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id AND draft.operation='DRAFT_HYPOTHESIS'
      WHERE delivery.id=$1`,[deliveryId])).rows[0];
    const reviewPackage={format:'motive.research-delivery-review-package/0.1',
      delivery:{id:deliveryId,projectId:String(row.project_id),scopeId:String(row.scope_id),sourceSubmissionId:String(row.source_submission_id),
        sourceIntentId:String(row.source_intent_id),sourceIntentPayloadDigest:String(row.source_intent_payload_digest)},
      scope:{configurationDigest:String(row.scope_configuration_digest),apiBaseUrl:String(row.engine_api_base_url),
        apiVersion:String(row.engine_api_version),engineActor:String(row.engine_actor)},
      report:{status:String(row.report_status),digest:String(row.report_digest),exactScore:null,exceedsReference:null},
      postCheck:{requestDigest:String(row.assessment_request_digest),reportDigest:String(row.assessment_report_digest),
        assessment:String(row.assessment_text),nextAction:String(row.next_action),createdAt:(row.assessment_created_at as Date).toISOString()},
      reproducibility:null,contract:{fileDigest:String(row.reviewed_contract_digest),contractVersion:String(row.reviewed_contract_version),
        apiVersion:String(row.engine_api_version),schemaRevision:'017_write_idempotency',surfaceDigest:String(row.reviewed_contract_surface_digest),
        implementationDigest:String(row.reviewed_implementation_digest)},assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'},
      operations:{draft:{method:'POST',path:String(row.request_path),body:row.request_body,bodyDigest:String(row.request_body_digest),
        requestDigest:String(row.draft_request_digest)},neutralEvidence:null}};
    let previous:string|null=null;let reviewedAt='';
    for(const decision of ['ADMIT','DECLINE'] as const){const id=randomUUID();const request={packageDigest:digestCanonicalJson(reviewPackage),
      expectedDecisionId:previous,decision,rationale:`${decision} corrected contributor history.`};
      const saved=await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_admission_decisions
        (id,delivery_id,review_package,review_package_digest,previous_decision_id,decision,reviewer_actor_id,rationale,
         idempotency_key,request_digest) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at`,
      [id,deliveryId,JSON.stringify(reviewPackage),request.packageDigest,previous,decision,reviewer,request.rationale,
        `review-${randomUUID()}`,digestCanonicalJson(request)]);previous=id;reviewedAt=(saved.rows[0].created_at as Date).toISOString();}
    return reviewedAt;
  }

  it('paginates all named history across retired credentials and excludes private attribution',async()=>{
    const owner=`account:${randomUUID()}`;const first=await participant('Public contributor',true,owner);
    const second=await participant('Renamed contributor',true,owner);
    const named:Array<{id:string;reportDigest:string}>=[];
    for(let index=0;index<63;index+=1){const tied=index===19||index===20;
      named.push(await insertSubmission({projectId,workOrderId:assignmentId,
        tokenId:index<32?first.context.tokenId:second.context.tokenId,
        claimId:index<32?first.claim.claimId!:second.claim.claimId!,leaseEpoch:index<32?first.claim.leaseEpoch!:second.claim.leaseEpoch!,
        id:index===19?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':index===20?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':undefined,
        createdAt:tied?'2026-09-09T04:00:00.123456Z':index<19
          ?new Date(Date.parse('2026-09-09T05:00:00.001Z')+index*1_000).toISOString()
          :new Date(Date.parse('2026-09-09T03:00:00.001Z')+index*1_000).toISOString()}));}
    const privateNewest=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:second.context.tokenId,
      claimId:second.claim.claimId!,leaseEpoch:second.claim.leaseEpoch!,createdAt:'2026-09-09T05:00:00.000001Z',displayName:null});
    const privateOlder=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:first.context.tokenId,
      claimId:first.claim.claimId!,leaseEpoch:first.claim.leaseEpoch!,createdAt:'2026-09-09T02:00:00.000001Z',displayName:null});
    const reviewed=named[0]!;
    const correctedAt=await seedCorrectedAdmission(reviewed.id,first.context.tokenId,reviewed.reportDigest);
    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=ANY($1::uuid[])`,
      [[first.context.tokenId,second.context.tokenId]]);
    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE id=$1`,[first.membershipId]);
    const expected=(await pool.query(`SELECT submission.id::text FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      WHERE submission.project_id=$1 AND token.owner_actor_id=$2 AND artifact.contributor_display_name IS NOT NULL
      ORDER BY submission.created_at DESC,submission.id DESC`,[projectId,owner])).rows.map(row=>String(row.id));
    expect(expected).toHaveLength(63);
    expect(expected[19]).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(expected[20]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const collected:string[]=[];const credentialIds=new Set<string>();let before:string|undefined;const sizes:number[]=[];
    do{const page=await service.publicContributorResearchJournal(first.membershipId,before);
      expect(page).toMatchObject({format:'motive.contributor-journal/0.1',projectSlug:'circle-packing',contributorId:first.membershipId});
      sizes.push(page.items.length);collected.push(...page.items.map(item=>item.submission.id));
      for(const item of page.items)credentialIds.add(item.submission.contributorId);before=page.nextCursor??undefined;
      expect(JSON.stringify(page)).not.toContain(owner);
      for(const item of page.items){expect(item.submission.contributorDisplayName).not.toBeNull();
        expect(item.update.contributorDisplayName).not.toBeNull();}
    }while(before);
    expect(sizes).toEqual([20,20,20,3]);expect(collected).toEqual(expected);
    expect([...credentialIds].sort()).toEqual([first.context.tokenId,second.context.tokenId].sort());
    expect(collected[19]).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(collected[20]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(collected).not.toContain(privateNewest.id);expect(collected).not.toContain(privateOlder.id);
    const corrected=(await service.publicContributorResearchJournal(first.membershipId)).items.find(item=>item.submission.id===reviewed.id);
    expect(corrected?.update.memoryReview).toEqual({latestDecision:{decision:'DECLINE',reviewedAt:correctedAt},hasEngineRecords:true});
    const legacyPublic=await service.publicResearchJournal();
    expect(legacyPublic.items.map(item=>item.submission.id)).toContain(privateNewest.id);
    const legacyOwned=await service.ownedResearchJournal(owner);
    expect(legacyOwned.items.map(item=>item.submission.id)).toContain(privateNewest.id);
    expect((await service.publicResearchJournalEntry(privateNewest.id)).submission.id).toBe(privateNewest.id);
  },30_000);

  it('counts public task XP from complete report-bound history rather than bounded rows or finding acceptance',async()=>{
    const owner=`account:${randomUUID()}`;
    const negative=await participant('Task XP contributor',true,owner);
    const negativeSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:negative.context.tokenId,
      claimId:negative.claim.claimId!,leaseEpoch:negative.claim.leaseEpoch!,createdAt:'2026-09-08T01:00:00.000Z'});
    await insertSubmission({projectId,workOrderId:assignmentId,tokenId:negative.context.tokenId,
      claimId:negative.claim.claimId!,leaseEpoch:negative.claim.leaseEpoch!,createdAt:'2026-09-08T01:01:00.000Z'});
    await service.completeAssignment(negative.context,assignmentId,
      {leaseEpoch:negative.claim.leaseEpoch!,submissionId:negativeSubmission.id},`complete-${randomUUID()}`);
    await service.createPostCheckAssessment(negative.context,negativeSubmission.id,{reportDigest:negativeSubmission.reportDigest,
      assessment:'The completed bounded task was negative.',nextAction:'Retain the negative result.'},`post-${randomUUID()}`);

    const inconclusive=await participant('Task XP contributor',true,owner);
    const inconclusiveSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:inconclusive.context.tokenId,
      claimId:inconclusive.claim.claimId!,leaseEpoch:inconclusive.claim.leaseEpoch!,createdAt:'2026-09-08T01:02:00.000Z'});
    await service.completeAssignment(inconclusive.context,assignmentId,
      {leaseEpoch:inconclusive.claim.leaseEpoch!,submissionId:inconclusiveSubmission.id},`complete-${randomUUID()}`);
    await service.createPostCheckAssessment(inconclusive.context,inconclusiveSubmission.id,{reportDigest:inconclusiveSubmission.reportDigest,
      assessment:'The completed bounded task was inconclusive.',nextAction:'Retain its limit.'},`post-${randomUUID()}`);

    const noPostCheck=await participant('Task XP contributor',true,owner);
    const noPostCheckSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:noPostCheck.context.tokenId,
      claimId:noPostCheck.claim.claimId!,leaseEpoch:noPostCheck.claim.leaseEpoch!,createdAt:'2026-09-08T01:03:00.000Z'});
    await service.completeAssignment(noPostCheck.context,assignmentId,
      {leaseEpoch:noPostCheck.claim.leaseEpoch!,submissionId:noPostCheckSubmission.id},`complete-${randomUUID()}`);

    const noCompletion=await participant('Task XP contributor',true,owner);
    const noCompletionSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:noCompletion.context.tokenId,
      claimId:noCompletion.claim.claimId!,leaseEpoch:noCompletion.claim.leaseEpoch!,createdAt:'2026-09-08T01:04:00.000Z'});
    await service.createPostCheckAssessment(noCompletion.context,noCompletionSubmission.id,{reportDigest:noCompletionSubmission.reportDigest,
      assessment:'This update has no completion.',nextAction:'Do not count it as a task.'},`post-${randomUUID()}`);
    const newer:string[]=[];
    for(let index=0;index<51;index+=1)newer.push((await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:noCompletion.context.tokenId,claimId:noCompletion.claim.claimId!,leaseEpoch:noCompletion.claim.leaseEpoch!,
      createdAt:new Date(Date.parse('2026-09-10T00:00:00.000Z')+index*1_000).toISOString()})).id);

    const privateTask=await participant('Task XP contributor',false,owner);
    const privateSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:privateTask.context.tokenId,
      claimId:privateTask.claim.claimId!,leaseEpoch:privateTask.claim.leaseEpoch!,createdAt:'2026-09-08T01:05:00.000Z'});
    await service.completeAssignment(privateTask.context,assignmentId,
      {leaseEpoch:privateTask.claim.leaseEpoch!,submissionId:privateSubmission.id},`complete-${randomUUID()}`);
    await service.createPostCheckAssessment(privateTask.context,privateSubmission.id,{reportDigest:privateSubmission.reportDigest,
      assessment:'This completed task has private attribution.',nextAction:'Keep it out of the named public XP total.'},`post-${randomUUID()}`);

    const projection=await service.publicProjection();
    const contributor=projection.contributors.find(item=>item.id===negative.membershipId);
    expect(contributor).toMatchObject({submissionCount:56,taskXp:200,acceptedFindingCount:0});
    expect(contributor?.publicSubmissionIds).toHaveLength(50);
    expect(contributor?.publicSubmissionIds).toEqual(newer.slice(1).reverse());
    expect(contributor?.publicSubmissionIds).not.toContain(negativeSubmission.id);
    expect(contributor?.publicSubmissionIds).not.toContain(inconclusiveSubmission.id);
    expect(contributor?.publicSubmissionIds).not.toContain(noPostCheckSubmission.id);
    expect(contributor?.publicSubmissionIds).not.toContain(noCompletionSubmission.id);
    expect(contributor?.publicSubmissionIds).not.toContain(privateSubmission.id);
  },30_000);

  it('returns the same not-found boundary for unauthorized contributor and cursor scopes',async()=>{
    const requested=await participant('Requested contributor',true);const requestedRow=await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:requested.context.tokenId,claimId:requested.claim.claimId!,leaseEpoch:requested.claim.leaseEpoch!,createdAt:'2026-09-09T06:00:00.000001Z'});
    const privateOnly=await participant('Private only',false);const privateRow=await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:privateOnly.context.tokenId,claimId:privateOnly.claim.claimId!,leaseEpoch:privateOnly.claim.leaseEpoch!,createdAt:'2026-09-09T06:00:00.000002Z'});
    const other=await participant('Other public person',true);const otherRow=await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:other.context.tokenId,claimId:other.claim.claimId!,leaseEpoch:other.claim.leaseEpoch!,createdAt:'2026-09-09T06:00:00.000003Z'});
    const foreign=await foreignProjectSubmission('2026-09-09T06:00:00.000004Z');
    for(const action of [()=>service.publicContributorResearchJournal(randomUUID()),
      ()=>service.publicContributorResearchJournal(privateOnly.membershipId),
      ()=>service.publicContributorResearchJournal(foreign.membershipId),
      ()=>service.publicContributorResearchJournal(requested.membershipId,privateRow.id),
      ()=>service.publicContributorResearchJournal(requested.membershipId,otherRow.id),
      ()=>service.publicContributorResearchJournal(requested.membershipId,foreign.submissionId),
      ()=>service.publicContributorResearchJournal(requested.membershipId,randomUUID())])
      await expect(action()).rejects.toMatchObject({code:'NOT_FOUND'} satisfies Partial<ParticipationError>);
    for(const value of ['not-a-uuid',requested.membershipId.toUpperCase()])
      await expect(service.publicContributorResearchJournal(value)).rejects.toMatchObject({code:'VALIDATION'});
    await expect(service.publicContributorResearchJournal(requested.membershipId,requestedRow.id.toUpperCase()))
      .rejects.toMatchObject({code:'VALIDATION'});
  },30_000);

  it('keeps contributor journal query count fixed',async()=>{
    const contributor=(await pool.query(`SELECT membership.id::text FROM motive.memberships membership
      WHERE membership.project_id=$1 AND EXISTS(SELECT 1 FROM motive.participation_agent_tokens token
        JOIN motive.participation_submission_artifacts artifact ON artifact.agent_token_id=token.id
        WHERE token.owner_actor_id=membership.actor_id AND artifact.project_id=$1 AND artifact.contributor_display_name IS NOT NULL)
      ORDER BY (SELECT count(*) FROM motive.participation_agent_tokens token
        JOIN motive.participation_submission_artifacts artifact ON artifact.agent_token_id=token.id
        WHERE token.owner_actor_id=membership.actor_id AND artifact.project_id=$1 AND artifact.contributor_display_name IS NOT NULL) DESC
      LIMIT 1`,[projectId])).rows[0];
    const countedPool=new Pool({connectionString:testUrl,max:1});let queries=0;const instrumented=new WeakSet<PoolClient>();
    const connect=countedPool.connect.bind(countedPool);
    Object.defineProperty(countedPool,'connect',{value:async()=>{const client=await connect();const query=client.query.bind(client);
      if(!instrumented.has(client)){client.query=((...args:unknown[])=>{queries+=1;
        return (query as unknown as (...values:unknown[])=>unknown)(...args);}) as PoolClient['query'];instrumented.add(client);}return client;}});
    try{const counted=createParticipationService(countedPool,{tokenSecret,issuerActorId:issuer});
      expect((await counted.publicContributorResearchJournal(String(contributor.id))).items).toHaveLength(20);expect(queries).toBe(5);
    }finally{await countedPool.end();}
  },30_000);
});
