import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';
import { createHypothesisSubmissionAdmissionService, createHypothesisSubmissionDeliveryService,
  createProjectResearchDeliveryPolicyService, createResearchMemoryService } from '../../server/research-memory/index.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;
const vaultKey=Buffer.alloc(32,7),apiKey=`he_${'r'.repeat(43)}`,apiBase='https://engine.invalid/api/v1';

function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

function delayedDraftEngine(){
  const entered=deferred(),release=deferred();const calls:Array<{path:string;key:string}>=[];
  const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;
    const key=new Headers(init?.headers).get('Idempotency-Key')??'';calls.push({path,key});
    if(!path.endsWith('/hypotheses'))throw new Error('An unapproved second engine operation was dispatched.');
    const body=JSON.parse(String(init?.body)) as Record<string,unknown>;entered.resolve();await release.promise;
    const now='2026-09-08T16:00:00.000Z';return new Response(JSON.stringify({id:randomUUID(),statement:body.statement,
      context:body.context,falsification_criteria:null,status:'draft',confidence:null,initial_confidence:null,tags:[],
      created_by:body.created_by,parent_id:null,is_archived:false,evidence_counts:{supporting:0,contradicting:0,neutral:0},
      deadline:null,metadata:body.metadata,null_hypothesis:null,experimental_design:body.experimental_design,
      significance_level:null,outcome:null,channel:body.channel,created_at:now,updated_at:now}),{status:201,
      headers:{'content-type':'application/json'}});};
  return{fetcher,calls,entered:entered.promise,release:()=>release.resolve()};
}

pgDescribe('independent research admission serialization on isolated PostgreSQL',()=>{
  const databaseName=`motive_admission_race_${randomUUID().replaceAll('-','')}`;
  const operator=`operator:${randomUUID()}`,owner=`account:${randomUUID()}`,reviewer=`account:${randomUUID()}`,
    contributor=`account:${randomUUID()}`;const active=new Set([owner,reviewer,contributor]);
  let admin:Pool,pool:Pool,observer:Pool,participation:ParticipationService,context:ParticipationAgentContext;
  let projectId:string,workOrderId:string,scopeId:string;

  const notes={format:'motive.investigation.v1' as const,proposal:'Test one bounded construction under the frozen checker.',
    expectation:'The checker should retain an exact negative or valid report.',conditions:['Use the exact protected checker.'],
    observations:['A bounded candidate was submitted.'],assessment:'The report is evidence, not a support conclusion.',
    nextAction:'An independent reviewer may decide whether to admit neutral context.'};

  const isActorActive=async(actorId:string)=>{await pool.query('SELECT 1');return active.has(actorId);};
  async function submission(){const saved=await participation.submitWitness(context,workOrderId,{leaseEpoch:1,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:notes},`submit-${randomUUID()}`);
    const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[saved.id]);
    await participation.createPostCheckAssessment(context,saved.id,{reportDigest:String(artifact.rows[0].report_digest),
      assessment:'The protected report rejects this candidate without establishing a general conclusion.',
      nextAction:'Retain it as a bounded negative observation if independently admitted.'},`assess-${randomUUID()}`);return saved.id;}

  type TestServices={sender:ReturnType<typeof createHypothesisSubmissionDeliveryService>;
    admission:ReturnType<typeof createHypothesisSubmissionAdmissionService>};
  function services(engine:ReturnType<typeof delayedDraftEngine>):TestServices{const sender=createHypothesisSubmissionDeliveryService({pool,vaultKey,
      isActorActive,fetch:engine.fetcher,timeoutMs:5000});const admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive,sender});
    return{sender,admission};}
  function input(submissionId:string,execute:boolean){return{projectSlug:'circle-packing',scopeId,submissionId,
    idempotencyKey:`delivery-${randomUUID()}`,approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute};}
  async function admit(submissionId:string,current:TestServices){
    await current.sender.sync(owner,input(submissionId,false));const preview=await current.admission.prepareAdmissionPreview(reviewer,submissionId);
    return current.admission.decideAdmission(reviewer,submissionId,{packageDigest:preview.packageDigest,
      expectedDecisionId:preview.latestDecision?.id??null,decision:'ADMIT',
      rationale:'Independent review admits this exact checked record as neutral research context.'},`admit-${randomUUID()}`);}
  async function waitForLock(queryFragment:string){for(let attempt=0;attempt<200;attempt++){
      const waiting=await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='admission-race-main'
        AND state='active' AND wait_event_type='Lock'
        AND position(regexp_replace($1,'\\s+',' ','g') in regexp_replace(query,'\\s+',' ','g'))>0`,[queryFragment]);
      if(waiting.rowCount)return;await new Promise<void>(resolve=>setImmediate(resolve));}
    throw new Error(`Expected blocked PostgreSQL statement was not observed: ${queryFragment}`);}
  async function restoreReviewer(){await pool.query(`UPDATE motive.memberships SET revoked_at=NULL WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);}

  beforeAll(async()=>{const source=new URL(baseUrl!),adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl=new URL(source);testUrl.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:testUrl.toString(),max:2,application_name:'admission-race-main'});
    observer=new Pool({connectionString:testUrl.toString(),max:1,application_name:'admission-race-observer'});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project=await new LedgerKernel(pool).createProject({actorId:operator,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Admission concurrency test'}});projectId=project.id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp()),
      ($5,'supabase',$6,'ACTIVE',clock_timestamp())`,[owner,owner.slice(8),reviewer,reviewer.slice(8),contributor,contributor.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$6),($4,$2,$5,'REVIEWER',ARRAY[]::text[],$6)`,
    [randomUUID(),projectId,owner,randomUUID(),reviewer,operator]);
    participation=createParticipationService(pool,{tokenSecret:`test-${'s'.repeat(48)}`,issuerActorId:operator});
    workOrderId=(await participation.ensureCircleWorkOrder()).id;
    const joined=await participation.join(contributor,'Race contributor',{projectSlug:'circle-packing',publishDisplayName:false,
      acceptReferenceTerms:true},`join-${randomUUID()}`);context=await participation.authenticateBearer(joined.token);
    await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);scopeId=randomUUID();
    const encrypted=encryptSecret(vaultKey,apiKey,`research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,
      'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [scopeId,projectId,apiBase,randomUUID(),randomUUID(),`sha256:${'a'.repeat(64)}`,encrypted,`sha256:${'b'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`,'7'.repeat(40),owner]);
  },30000);

  afterAll(async()=>{await observer?.end();await pool?.end();if(admin){
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}});

  it('holds reviewer authority through an outbound POST, retains its result, then denies the next POST',async()=>{
    const submissionId=await submission(),engine=delayedDraftEngine(),current=services(engine);await admit(submissionId,current);
    const dispatch=current.sender.sync(owner,input(submissionId,true));let dispatchSettled=false;
    void dispatch.then(()=>{dispatchSettled=true;},()=>{dispatchSettled=true;});await engine.entered;let revoke:Promise<unknown>|null=null;
    try{revoke=pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() /* reviewer-membership-race */
        WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);let revokeSettled=false;
      void revoke.then(()=>{revokeSettled=true;},()=>{revokeSettled=true;});
      await waitForLock('reviewer-membership-race');expect(revokeSettled).toBe(false);expect(dispatchSettled).toBe(false);
      engine.release();await revoke;const outcome=await Promise.allSettled([dispatch]);
      expect(outcome[0]).toMatchObject({status:'rejected',reason:{code:'FORBIDDEN'}});expect(engine.calls).toHaveLength(1);
      const retained=await pool.query(`SELECT operation FROM motive.hypothesis_submission_delivery_results result
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id
        WHERE delivery.source_submission_id=$1`,[submissionId]);expect(retained.rows).toEqual([{operation:'DRAFT_HYPOTHESIS'}]);
      await expect(current.sender.sync(owner,input(submissionId,true))).rejects.toMatchObject({code:'FORBIDDEN'});
      expect(engine.calls).toHaveLength(1);await restoreReviewer();
    }finally{engine.release();await Promise.allSettled(revoke?[dispatch,revoke]:[dispatch]);}
  },30000);

  it('serializes a concurrent decline after the in-flight POST and blocks the next operation',async()=>{
    const submissionId=await submission(),engine=delayedDraftEngine(),current=services(engine);const admitted=await admit(submissionId,current);
    const preview=await current.admission.prepareAdmissionPreview(reviewer,submissionId);
    const dispatch=current.sender.sync(owner,input(submissionId,true));let dispatchSettled=false;
    void dispatch.then(()=>{dispatchSettled=true;},()=>{dispatchSettled=true;});await engine.entered;let decline:Promise<unknown>|null=null;
    try{decline=current.admission.decideAdmission(reviewer,submissionId,{packageDigest:preview.packageDigest,
        expectedDecisionId:admitted.id,decision:'DECLINE',rationale:'Independent review now declines any further engine delivery.'},
      `decline-${randomUUID()}`);let declineSettled=false;void decline.then(()=>{declineSettled=true;},()=>{declineSettled=true;});
      await waitForLock('SELECT id FROM motive.hypothesis_submission_deliveries WHERE scope_id=');
      expect(declineSettled).toBe(false);expect(dispatchSettled).toBe(false);engine.release();
      const declined=await decline;expect(declined).toMatchObject({decision:'DECLINE',previousDecisionId:admitted.id});
      const outcome=await Promise.allSettled([dispatch]);expect(outcome[0]).toMatchObject({status:'rejected',reason:{code:'FORBIDDEN'}});
      expect(engine.calls).toHaveLength(1);const retained=await pool.query(`SELECT operation FROM motive.hypothesis_submission_delivery_results result
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id
        WHERE delivery.source_submission_id=$1`,[submissionId]);expect(retained.rows).toEqual([{operation:'DRAFT_HYPOTHESIS'}]);
      await expect(current.sender.sync(owner,input(submissionId,true))).rejects.toMatchObject({code:'FORBIDDEN'});
      expect(engine.calls).toHaveLength(1);
    }finally{engine.release();await Promise.allSettled(decline?[dispatch,decline]:[dispatch]);}
  },30000);

  it('rechecks locked reviewer authority before returning a private admission preview',async()=>{
    const submissionId=await submission(),engine=delayedDraftEngine(),current=services(engine);
    await current.sender.sync(owner,input(submissionId,false));let callbackCalls=0;
    const raced=createHypothesisSubmissionAdmissionService({pool,vaultKey,sender:current.sender,isActorActive:async actorId=>{
      callbackCalls+=1;if(actorId===reviewer)await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp()
        WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL`,[projectId,reviewer]);return active.has(actorId);}});
    try{await expect(raced.prepareAdmissionPreview(reviewer,submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});
      expect(callbackCalls).toBe(1);
    }finally{await restoreReviewer();}
    await expect(current.admission.prepareAdmissionPreview(reviewer,submissionId)).resolves.toMatchObject({package:{delivery:{sourceSubmissionId:submissionId}}});
  },30000);

  it('recovers the same immutable operation across concurrent unique-key inserts',async()=>{
    const submissionId=await submission(),engine=delayedDraftEngine(),current=services(engine);await admit(submissionId,current);
    const retained=await pool.query(`SELECT delivery.*,intent.payload FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      WHERE delivery.source_submission_id=$1`,[submissionId]);expect(retained.rowCount).toBe(1);const row=retained.rows[0];
    const delivery={id:row.id,projectId:row.project_id,scopeId:row.scope_id,submissionId:row.source_submission_id,
      sourceIntentId:row.source_intent_id,sourceIntentPayloadDigest:row.source_intent_payload_digest,engineActor:row.engine_actor,
      apiBaseUrl:row.engine_api_base_url,configurationDigest:row.scope_configuration_digest,apiVersion:row.engine_api_version,
      contractDigest:row.reviewed_contract_digest,contractVersion:row.reviewed_contract_version,
      contractSurfaceDigest:row.reviewed_contract_surface_digest,implementationDigest:row.reviewed_implementation_digest,payload:row.payload};
    const target=randomUUID(),path=`/api/v1/hypotheses/${target}/evidence`;
    const body={content:'Exact concurrent operation fixture.',evidence_type:'neutral',source:'https://example.test/report',created_by:row.engine_actor};
    const internal=current.sender as unknown as {ensureOperation(...args:unknown[]):Promise<Record<string,unknown>>};
    const operations=await Promise.all(Array.from({length:12},()=>internal.ensureOperation(owner,delivery,
      'NEUTRAL_EVIDENCE',target,path,body)));
    expect(new Set(operations.map(operation=>JSON.stringify(operation))).size).toBe(1);
    const count=await pool.query(`SELECT count(*)::int AS count FROM motive.hypothesis_submission_delivery_operations
      WHERE delivery_id=$1 AND operation='NEUTRAL_EVIDENCE'`,[row.id]);expect(count.rows[0].count).toBe(1);
    await expect(internal.ensureOperation(owner,delivery,'NEUTRAL_EVIDENCE',target,path,{...body,content:'Changed body.'}))
      .rejects.toMatchObject({code:'CONFLICT',message:'Existing engine operation is bound to a changed request.'});
  },30000);

  it('keeps reviewer preparation separate from execution and project administration',async()=>{
    const submissionId=await submission(),engine=delayedDraftEngine(),current=services(engine);
    await expect(current.admission.prepareAdmissionPreview(contributor,submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});
    const request=input(submissionId,false);
    await expect(current.sender.sync(reviewer,request)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(current.sender.prepareForReview(reviewer,{...request,execute:true})).rejects.toMatchObject({code:'VALIDATION'});
    expect(engine.calls).toHaveLength(0);
    const policy=createProjectResearchDeliveryPolicyService({pool,vaultKey,isActorActive,fetch:engine.fetcher});
    await expect(policy.approve(reviewer,{projectSlug:'circle-packing',scopeId,workOrderId,
      idempotencyKey:`policy-${randomUUID()}`,approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT},true))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    const tenantId=randomUUID(),channelId=randomUUID(),scopeKey=`he_${'q'.repeat(43)}`;let reads=0;
    const research=createResearchMemoryService({pool,vaultKey,fetch:async value=>{reads+=1;const path=new URL(String(value)).pathname;
      if(path.endsWith('/health'))return new Response(JSON.stringify({status:'ok',database:'ok',version:'1.8.0'}));
      if(path.endsWith('/keys'))return new Response(JSON.stringify([{tenant_id:tenantId,prefix:scopeKey.slice(0,10)}]));
      return new Response(JSON.stringify({id:channelId,name:'reviewer-denied',goal:'No reviewer scope authority.',
        created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'}));}});
    await expect(research.linkScope(reviewer,'circle-packing',{apiBaseUrl:'https://reviewer.invalid/api/v1',tenantId,
      channelId,channelName:'reviewer-denied',apiKey:scopeKey,replace:false})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(reads).toBe(3);
    const admitted=await admit(submissionId,current);expect(admitted.decision).toBe('ADMIT');expect(engine.calls).toHaveLength(0);
    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);
    await expect(current.admission.prepareAdmissionPreview(reviewer,submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});
    await restoreReviewer();
  },30000);
});
