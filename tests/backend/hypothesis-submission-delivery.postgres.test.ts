import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { canonicalJson, digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService,type ParticipationAgentContext,type ParticipationService } from '../../server/participation/index.ts';
import {
  createHypothesisSubmissionDeliveryService,
  createHypothesisSubmissionAdmissionService,
  type ReviewedWritebackContract,type SyncSubmissionResearchInput,
} from '../../server/research-memory/index.ts';
import { LEGACY_REVIEWED_WRITEBACK_CONTRACT,PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;
const contract:ReviewedWritebackContract=PINNED_REVIEWED_WRITEBACK_CONTRACT;
const apiBase='https://engine.invalid/api/v1';const apiKey=`he_${'k'.repeat(43)}`;const vaultKey=Buffer.alloc(32,9);
const UUID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type RequestRecord={path:string;key:string;body:Record<string,unknown>};
function engineMock(){
  const committed=new Map<string,{path:string;body:string;response:Record<string,unknown>}>();const requests:RequestRecord[]=[];
  const loseNext=new Set<'draft'|'evidence'>();const conflictNext=new Set<'draft'|'evidence'>();
  const now='2026-09-08T10:00:00.000Z';
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));const headers=new Headers(init?.headers);expect(headers.get('X-API-Key')).toBe(apiKey);
    expect(init?.redirect).toBe('error');expect(init?.method).toBe('POST');
    const key=headers.get('Idempotency-Key')!;const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    const path=url.pathname;requests.push({path,key,body});const encoded=canonicalJson(body);const prior=committed.get(key);
    const kind=path.endsWith('/hypotheses')?'draft':'evidence';if(conflictNext.delete(kind))return new Response('changed',{status:409});
    if(prior){if(prior.path!==path||prior.body!==encoded)return new Response('{}',{status:409});
      return new Response(JSON.stringify(prior.response),{status:201,headers:{'content-type':'application/json'}});}
    const draft=path.endsWith('/hypotheses');let response:Record<string,unknown>;
    if(draft){response={id:randomUUID(),statement:body.statement,context:body.context,falsification_criteria:null,status:'draft',
      confidence:null,initial_confidence:null,tags:[],created_by:body.created_by,parent_id:null,is_archived:false,
      evidence_counts:{supporting:0,contradicting:0,neutral:0},deadline:null,metadata:body.metadata,null_hypothesis:null,
      experimental_design:body.experimental_design,significance_level:null,outcome:null,channel:body.channel,created_at:now,updated_at:now};}
    else{const match=/\/hypotheses\/([a-f0-9-]+)\/evidence$/.exec(path);if(!match)throw new Error('unexpected engine path');
      const hypothesisId=match[1]!;const draftCommit=[...committed.values()].find(value=>(value.response.id===hypothesisId));
      if(!draftCommit)throw new Error('draft commit missing');const hypothesis:Record<string,unknown>={...draftCommit.response,
        evidence_counts:{supporting:0,contradicting:0,neutral:1},updated_at:now};
      response={evidence:{id:randomUUID(),hypothesis_id:hypothesisId,content:body.content,source:body.source,
        evidence_type:'neutral',strength:null,confidence_after:hypothesis['confidence'],created_by:body.created_by,created_at:now},hypothesis};}
    committed.set(key,{path,body:encoded,response});
    if(loseNext.delete(kind))throw new Error(`simulated ${kind} response loss ${apiKey}`);
    return new Response(JSON.stringify(response),{status:201,headers:{'content-type':'application/json'}});
  };
  return{fetcher,requests,committed,loseNext,conflictNext};
}

pgDescribe('checked participation submission delivery on isolated PostgreSQL',()=>{
  const databaseName=`motive_submission_delivery_${randomUUID().replaceAll('-','')}`;const operator=`operator:${randomUUID()}`;
  const owner=`account:${randomUUID()}`;const steward=`account:${randomUUID()}`;const contributor=`account:${randomUUID()}`;
  const active=new Set([owner,steward,contributor]);let admin:Pool;let pool:Pool;let participation:ParticipationService;
  let contributorContext:ParticipationAgentContext;let workOrderId:string;let scopeId:string;let channelId:string;
  let projectId:string;let referenceWitness:string;

  const notes={format:'motive.investigation.v1' as const,proposal:'Retain this checked construction as a bounded draft proposal.',
    expectation:'The protected checker should determine whether the construction satisfies the frozen reference.',
    conditions:['Use the exact protected checker.','Keep contributor claims separate from the checker report.'],
    observations:['A submission was made.'],assessment:'The report remains separate evidence.',nextAction:'Record a neutral observation only.'};

  async function submit(withNotes=true,negative=false){const submission=await participation.submitWitness(contributorContext,workOrderId,
    {leaseEpoch:1,witness:negative?'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}':referenceWitness,
      ...(withNotes?{investigation:notes}:{})},`submit-${randomUUID()}`);const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    await participation.createPostCheckAssessment(contributorContext,submission.id,{reportDigest:artifact.rows[0].report_digest,
      assessment:'The protected checker report is retained without a support conclusion.',nextAction:'Review the bounded result independently.'},`post-${randomUUID()}`);return submission.id;}
  function service(mock=engineMock()){return{mock,value:createHypothesisSubmissionDeliveryService({pool,vaultKey,
    isActorActive:actor=>active.has(actor),fetch:mock.fetcher,timeoutMs:2000})};}
  function input(submissionId:string,key=`prepare-${randomUUID()}`,execute=true,
    frozenContract:ReviewedWritebackContract=contract):SyncSubmissionResearchInput{return{
    projectSlug:'circle-packing',scopeId,submissionId,idempotencyKey:key,approvedApiBaseUrl:apiBase,contract:frozenContract,execute};}
  async function admit(sender:ReturnType<typeof createHypothesisSubmissionDeliveryService>,submissionId:string){
    const admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),sender});
    const preview=await admission.prepareAdmissionPreview(steward,submissionId);
    expect(preview.package.postCheck).not.toHaveProperty('publicSummary');
    expect(preview.packageDigest).toBe(digestCanonicalJson(preview.package));
    await admission.decideAdmission(steward,submissionId,{packageDigest:preview.packageDigest,expectedDecisionId:preview.latestDecision?.id??null,
      decision:'ADMIT',rationale:'Independent review admits this exact checked record as neutral context only.'},`admit-${randomUUID()}`);
  }

  beforeAll(async()=>{const source=new URL(baseUrl!);const adminUrl=new URL(source);adminUrl.pathname='/postgres';admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);const testUrl=new URL(source);testUrl.pathname=`/${databaseName}`;pool=new Pool({connectionString:testUrl.toString(),max:16});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project=await new LedgerKernel(pool).createProject({actorId:operator,idempotencyKey:randomUUID(),slug:'circle-packing',visibility:'PUBLIC',revisionContent:{title:'Delivery test'}});projectId=project.id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp()),($5,'supabase',$6,'ACTIVE',clock_timestamp())`,
      [owner,owner.slice(8),steward,steward.slice(8),contributor,contributor.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$5),($4,$2,$6,'STEWARD',ARRAY['project:admin'],$5)`,
    [randomUUID(),projectId,owner,randomUUID(),operator,steward]);
    participation=createParticipationService(pool,{tokenSecret:`test-${'s'.repeat(48)}`,issuerActorId:operator});workOrderId=(await participation.ensureCircleWorkOrder()).id;
    const joined=await participation.join(contributor,'Source contributor',{projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    contributorContext=await participation.authenticateBearer(joined.token);await participation.claimAssignment(contributorContext,workOrderId,`claim-${randomUUID()}`);
    referenceWitness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');scopeId=randomUUID();channelId=randomUUID();
    const configurationDigest=`sha256:${'c'.repeat(64)}`;const encrypted=encryptSecret(vaultKey,apiKey,`research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,
      channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,api_version,
      inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,
      $6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,[scopeId,projectId,apiBase,randomUUID(),channelId,
      `sha256:${'a'.repeat(64)}`,encrypted,`sha256:${'b'.repeat(64)}`,configurationDigest,'7'.repeat(40),owner]);
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}});

  it('denies a contributor and allows a current steward to prepare without an engine call',async()=>{const submissionId=await submit();const {mock,value}=service();
    await expect(value.sync(contributor,input(submissionId,`prepare-${randomUUID()}`,false))).rejects.toMatchObject({code:'FORBIDDEN'});
    const result=await value.sync(steward,input(submissionId,`prepare-${randomUUID()}`,false));expect(result).toMatchObject({status:'PENDING',pendingOperation:'DRAFT_HYPOTHESIS',reason:'EXECUTION_NOT_REQUESTED'});
    expect(mock.requests).toHaveLength(0);
  });

  it('requires an independent exact admission and serializes competing review decisions',async()=>{const submissionId=await submit(true,true);const {mock,value}=service();
    await value.sync(owner,input(submissionId,`prepare-${randomUUID()}`,false));
    await expect(value.sync(owner,input(submissionId,`execute-${randomUUID()}`,true))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(mock.requests).toHaveLength(0);
    const reviewedCount=async()=>((await participation.publicProjection()).contributors.find(item=>item.displayName==='Source contributor')?.reviewedArtifactCount??-1);
    expect(await reviewedCount()).toBe(0);
    const admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),sender:value});
    const preview=await admission.prepareAdmissionPreview(steward,submissionId);
    await expect(admission.decideAdmission(contributor,submissionId,{packageDigest:preview.packageDigest,expectedDecisionId:null,
      decision:'ADMIT',rationale:'A contributor cannot independently admit their own record.'},`own-${randomUUID()}`)).rejects.toMatchObject({code:'FORBIDDEN'});
    const competing=await Promise.allSettled(['ADMIT','DECLINE'].map((decision,index)=>admission.decideAdmission(steward,submissionId,
      {packageDigest:preview.packageDigest,expectedDecisionId:null,decision:decision as 'ADMIT'|'DECLINE',rationale:`Independent competing review ${index}.`},`race-${randomUUID()}`)));
    expect(competing.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(competing.filter(item=>item.status==='rejected')).toHaveLength(1);
    let current=await admission.prepareAdmissionPreview(steward,submissionId);if(current.latestDecision?.decision==='DECLINE'){
      await admission.decideAdmission(steward,submissionId,{packageDigest:current.packageDigest,expectedDecisionId:current.latestDecision.id,
        decision:'ADMIT',rationale:'The exact neutral delivery is now admitted after independent review.'},`admit-${randomUUID()}`);}
    expect(await reviewedCount()).toBe(1);
    current=await admission.prepareAdmissionPreview(steward,submissionId);const declineKey=`decline-${randomUUID()}`;
    const declined=await admission.decideAdmission(steward,submissionId,{packageDigest:current.packageDigest,expectedDecisionId:current.latestDecision!.id,
      decision:'DECLINE',rationale:'Independent review declines this delivery pending an additional reproducibility file.'},declineKey);
    await expect(admission.decideAdmission(steward,submissionId,{packageDigest:current.packageDigest,expectedDecisionId:declined.id,
      decision:'ADMIT',rationale:'Changed body under the same key.'},declineKey)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(value.sync(owner,input(submissionId,`declined-${randomUUID()}`,true))).rejects.toMatchObject({code:'FORBIDDEN'});expect(mock.requests).toHaveLength(0);
    expect(await reviewedCount()).toBe(0);
    await admission.decideAdmission(steward,submissionId,{packageDigest:current.packageDigest,expectedDecisionId:declined.id,
      decision:'ADMIT',rationale:'Independent review now admits this exact neutral package.'},`admit-${randomUUID()}`);
    const report=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submissionId]);
    await participation.createSubmissionReproducibility(contributorContext,submissionId,{reportDigest:report.rows[0].report_digest,
      solverSource:'bounded solver source',trialResults:'bounded trial results'},`repro-${randomUUID()}`);
    await expect(value.sync(owner,input(submissionId,`stale-${randomUUID()}`,true))).rejects.toMatchObject({code:'FORBIDDEN'});expect(mock.requests).toHaveLength(0);
    expect(await admission.publicAdmission('circle-packing',submissionId)).toMatchObject({status:'STALE'});
    expect(await reviewedCount()).toBe(1);
    current=await admission.prepareAdmissionPreview(steward,submissionId);await admission.decideAdmission(steward,submissionId,
      {packageDigest:current.packageDigest,expectedDecisionId:current.latestDecision!.id,decision:'ADMIT',rationale:'Independent review admits the package with its reproducibility files.'},`readmit-${randomUUID()}`);
    active.delete(steward);expect(await admission.publicAdmission('circle-packing',submissionId)).toMatchObject({status:'STALE'});
    await expect(value.sync(owner,input(submissionId,`reviewer-gone-${randomUUID()}`,true))).rejects.toMatchObject({code:'FORBIDDEN'});active.add(steward);
    expect((await value.sync(owner,input(submissionId,`execute-${randomUUID()}`,true))).status).toBe('EVIDENCE_RECORDED');expect(mock.requests).toHaveLength(2);
  });

  it('replays a completed historical delivery without admission but blocks a draft-only historical next POST',async()=>{const completedId=await submit();const first=service();await admit(first.value,completedId);
    const completed=await first.value.sync(owner,input(completedId,`complete-${randomUUID()}`,true));expect(completed.status).toBe('EVIDENCE_RECORDED');const calls=first.mock.requests.length;
    await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions DISABLE TRIGGER hypothesis_submission_delivery_admissions_immutable');
    try{await pool.query('DELETE FROM motive.hypothesis_submission_delivery_admission_decisions WHERE delivery_id=$1',[completed.deliveryId]);}
    finally{await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions ENABLE TRIGGER hypothesis_submission_delivery_admissions_immutable');}
    expect((await first.value.sync(owner,input(completedId,`historical-${randomUUID()}`,true))).status).toBe('EVIDENCE_RECORDED');expect(first.mock.requests).toHaveLength(calls);
    const history=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),sender:first.value});
    expect(await history.publicAdmission('circle-packing',completedId)).toMatchObject({status:'DELIVERED_UNREVIEWED',latestReview:null});

    const draftOnlyId=await submit();const second=service();await admit(second.value,draftOnlyId);const draftOnly=await second.value.sync(owner,input(draftOnlyId,`draft-${randomUUID()}`,true));
    expect(draftOnly.status).toBe('EVIDENCE_RECORDED');await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions DISABLE TRIGGER hypothesis_submission_delivery_admissions_immutable');
    await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_results DISABLE TRIGGER hypothesis_submission_delivery_results_immutable');
    try{await pool.query("DELETE FROM motive.hypothesis_submission_delivery_results WHERE delivery_id=$1 AND operation='NEUTRAL_EVIDENCE'",[draftOnly.deliveryId]);
      await pool.query('DELETE FROM motive.hypothesis_submission_delivery_admission_decisions WHERE delivery_id=$1',[draftOnly.deliveryId]);}
    finally{await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_results ENABLE TRIGGER hypothesis_submission_delivery_results_immutable');
      await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions ENABLE TRIGGER hypothesis_submission_delivery_admissions_immutable');}
    const before=second.mock.requests.length;await expect(second.value.sync(owner,input(draftOnlyId,`draft-historical-${randomUUID()}`,true))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(second.mock.requests).toHaveLength(before);
  });

  it('records one draft and neutral protected-report observation with complete source bindings',async()=>{const submissionId=await submit(true,true);const {mock,value}=service();
    await admit(value,submissionId);
    const result=await value.sync(owner,input(submissionId));expect(result).toMatchObject({status:'EVIDENCE_RECORDED',hypothesisId:expect.stringMatching(UUID_PATTERN),evidenceId:expect.stringMatching(UUID_PATTERN)});
    expect(mock.requests).toHaveLength(2);const [draft,evidence]=mock.requests;expect(draft!.body).toMatchObject({statement:notes.proposal,context:notes.expectation,
      experimental_design:{conditions:notes.conditions},status:'draft',created_by:`motive:project:${projectId}`});
    expect(draft!.body).not.toHaveProperty('confidence');expect(draft!.body).not.toHaveProperty('initial_confidence');expect(draft!.body).not.toHaveProperty('outcome');
    expect(evidence!.body).toMatchObject({evidence_type:'neutral',created_by:`motive:project:${projectId}`});expect(evidence!.body).not.toHaveProperty('confidence');
    expect(evidence!.body.expected_channel_id).toBe(channelId);
    const observation=JSON.parse(String(evidence!.body.content));expect(observation).toMatchObject({binding:{projectId,workOrderId,claimId:expect.any(String),submissionId},
      report:{status:'REJECTED',digest:expect.stringMatching(/^sha256:/),result:{ok:false}},sourceURLs:{artifact:expect.stringContaining('/artifact'),report:expect.stringContaining('/report'),investigation:expect.stringContaining('/investigation')}});
    expect(String(evidence!.body.source)).toContain(`/submissions/${submissionId}/report`);
    const stored=await pool.query(`SELECT delivery.source_intent_id,intent.payload,operation.operation,operation.request_body,result.response_body
      FROM motive.hypothesis_submission_deliveries delivery JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=delivery.id
      JOIN motive.hypothesis_submission_delivery_results result ON result.delivery_id=operation.delivery_id AND result.operation=operation.operation
      WHERE delivery.id=$1 ORDER BY operation.operation`,[result.deliveryId]);
    expect(stored.rowCount).toBe(2);expect(canonicalJson(stored.rows[0].payload)).toContain('"witness"');expect(canonicalJson(stored.rows)).not.toContain(apiKey);
    const publicState=await participation.publicProjection();const contributorSummary=publicState.contributors.find(item=>item.displayName==='Source contributor')!;
    const membership=await pool.query('SELECT id::text FROM motive.memberships WHERE project_id=$1 AND actor_id=$2',[projectId,contributor]);
    expect(contributorSummary).toMatchObject({id:membership.rows[0].id,reviewedArtifactCount:1});
    expect(contributorSummary.reviewedSubmissionIds).toContain(submissionId);expect(contributorSummary.publicSubmissionIds).toContain(submissionId);
    expect(JSON.stringify(contributorSummary)).not.toContain(contributor);expect(JSON.stringify(contributorSummary)).not.toContain(contributorContext.tokenId);
  });

  it('preserves a retained cap2 delivery body, digest, key, and replay without upgrading it',async()=>{
    const submissionId=await submit(true,true);const {mock,value}=service();const key=`legacy-${randomUUID()}`;
    const prepared=await value.sync(owner,input(submissionId,key,false,LEGACY_REVIEWED_WRITEBACK_CONTRACT));
    expect(prepared).toMatchObject({status:'PENDING',pendingOperation:'DRAFT_HYPOTHESIS'});
    await admit(value,submissionId);
    const result=await value.sync(owner,input(submissionId,key,true,LEGACY_REVIEWED_WRITEBACK_CONTRACT));
    expect(result.status).toBe('EVIDENCE_RECORDED');const evidence=mock.requests.find(item=>item.path.endsWith('/evidence'))!;
    expect(evidence.body).not.toHaveProperty('expected_channel_id');
    const stored=await pool.query(`SELECT delivery.reviewed_contract_version,operation.idempotency_key,
        operation.request_body,operation.request_body_digest,operation.request_digest,operation.request_path
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=delivery.id
        AND operation.operation='NEUTRAL_EVIDENCE' WHERE delivery.id=$1`,[result.deliveryId]);
    expect(stored.rows[0].reviewed_contract_version).toBe('hypothesis-http-writeback-capabilities/2');
    expect(stored.rows[0].idempotency_key).toBe(`motive-delivery:${result.deliveryId}:evidence`);
    expect(stored.rows[0].request_body_digest).toBe(digestCanonicalJson(evidence.body));
    expect(stored.rows[0].request_digest).toBe(digestCanonicalJson({method:'POST',path:stored.rows[0].request_path,body:evidence.body}));
    const before=mock.requests.length;
    expect((await value.sync(owner,input(submissionId,key,true,LEGACY_REVIEWED_WRITEBACK_CONTRACT))).status).toBe('EVIDENCE_RECORDED');
    expect(mock.requests).toHaveLength(before);
    await expect(value.sync(owner,input(submissionId,`upgrade-${randomUUID()}`,true,PINNED_REVIEWED_WRITEBACK_CONTRACT)))
      .rejects.toMatchObject({code:'CONFLICT'});
    expect((await pool.query(`SELECT reviewed_contract_version FROM motive.hypothesis_submission_deliveries
      WHERE source_submission_id=$1`,[submissionId])).rows).toEqual([{reviewed_contract_version:'hypothesis-http-writeback-capabilities/2'}]);
  });

  it('uses one winning immutable delivery across human keys and concurrent calls',async()=>{const submissionId=await submit();const shared=engineMock();const value=service(shared).value;
    const dryA=await value.sync(owner,input(submissionId,`prepare-${randomUUID()}`,false));const dryB=await value.sync(steward,input(submissionId,`prepare-${randomUUID()}`,false));
    await admit(value,submissionId);
    expect(dryB.deliveryId).toBe(dryA.deliveryId);expect(dryB.sourceIntentId).toBe(dryA.sourceIntentId);
    const calls=await Promise.all(Array.from({length:4},()=>value.sync(owner,input(submissionId,`prepare-${randomUUID()}`,true))));
    expect(new Set(calls.map(item=>item.deliveryId))).toHaveLength(1);expect(new Set(calls.map(item=>item.hypothesisId))).toHaveLength(1);
    expect(new Set(calls.map(item=>item.evidenceId))).toHaveLength(1);
    expect((await participation.publicProjection()).contributors.find(item=>item.displayName==='Source contributor')).toMatchObject({reviewedArtifactCount:2});
    const counts=await pool.query(`SELECT (SELECT count(*)::int FROM motive.hypothesis_submission_deliveries WHERE source_submission_id=$1) deliveries,
      (SELECT count(*)::int FROM motive.hypothesis_submission_delivery_operations operation JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=operation.delivery_id WHERE delivery.source_submission_id=$1) operations,
      (SELECT count(*)::int FROM motive.hypothesis_submission_delivery_results result JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id WHERE delivery.source_submission_id=$1) results`,[submissionId]);
    expect(counts.rows[0]).toEqual({deliveries:1,operations:2,results:2});
  });

  it('recovers response loss after each engine commit with the same key and body',async()=>{for(const lost of ['draft','evidence'] as const){const submissionId=await submit();const mock=engineMock();mock.loseNext.add(lost);const value=service(mock).value;const key=`prepare-${randomUUID()}`;
      await admit(value,submissionId);
      const first=await value.sync(owner,input(submissionId,key,true));expect(first.status).toBe(lost==='draft'?'PENDING':'DRAFT_RECORDED');expect(first.reason).toBe('ENGINE_ATTEMPT_UNCONFIRMED');
      const second=await value.sync(owner,input(submissionId,key,true));expect(second.status).toBe('EVIDENCE_RECORDED');
      const repeated=mock.requests.filter(item=>item.key.endsWith(`:${lost}`));expect(repeated).toHaveLength(2);expect(repeated[0]!.body).toEqual(repeated[1]!.body);
    }});

  it('surfaces an engine 409 while retaining the exact pending request for retry',async()=>{for(const operation of ['draft','evidence'] as const){const submissionId=await submit();const mock=engineMock();mock.conflictNext.add(operation);const value=service(mock).value;
      await admit(value,submissionId);
      const requested=input(submissionId);await expect(value.sync(owner,requested)).rejects.toMatchObject({code:'CONFLICT',message:expect.not.stringContaining(apiKey)});
      const results=await pool.query(`SELECT count(*)::int count FROM motive.hypothesis_submission_delivery_results result
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id WHERE delivery.source_submission_id=$1`,[submissionId]);
      expect(results.rows[0].count).toBe(operation==='draft'?0:1);
      if(operation==='evidence'){
        const pending=await pool.query(`SELECT operation.request_body,operation.idempotency_key FROM motive.hypothesis_submission_delivery_operations operation
          JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=operation.delivery_id
          WHERE delivery.source_submission_id=$1 AND operation.operation='NEUTRAL_EVIDENCE'`,[submissionId]);
        expect(pending.rows[0].request_body.expected_channel_id).toBe(channelId);
        const prior=mock.requests.at(-1)!;expect((await value.sync(owner,requested)).status).toBe('EVIDENCE_RECORDED');
        const retried=mock.requests.at(-1)!;expect(retried.key).toBe(prior.key);expect(retried.body).toEqual(prior.body);
      }
    }});

  it('returns unavailable for missing notes and detects changed durable operation material',async()=>{const missing=await submit(false);const absent=service();const unavailable=await absent.value.sync(owner,input(missing,`prepare-${randomUUID()}`,false));
    expect(unavailable).toMatchObject({status:'UNAVAILABLE',reason:'INVESTIGATION_REQUIRED',deliveryId:null});expect(absent.mock.requests).toHaveLength(0);
    const submissionId=await submit();const current=service();const completionKey=`prepare-${randomUUID()}`;
    await admit(current.value,submissionId);
    const completed=await current.value.sync(owner,input(submissionId,completionKey));
    const joined=await pool.query(`SELECT delivery.*,intent.payload,operation.request_body,operation.request_path,operation.idempotency_key,
      operation.request_body_digest,operation.request_digest,operation.target_hypothesis_id FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=delivery.id AND operation.operation='DRAFT_HYPOTHESIS'
      WHERE delivery.id=$1`,[completed.deliveryId]);const row=joined.rows[0];
    const delivery={id:row.id,projectId:row.project_id,scopeId:row.scope_id,submissionId:row.source_submission_id,sourceIntentId:row.source_intent_id,
      sourceIntentPayloadDigest:row.source_intent_payload_digest,engineActor:row.engine_actor,apiBaseUrl:row.engine_api_base_url,
      configurationDigest:row.scope_configuration_digest,apiVersion:row.engine_api_version,payload:row.payload};
    const internal=current.value as unknown as {ensureOperation(...args:unknown[]):Promise<unknown>;persistResult(...args:unknown[]):Promise<unknown>};
    await expect(internal.ensureOperation(owner,delivery,'DRAFT_HYPOTHESIS',null,row.request_path,{...row.request_body,statement:'changed'}))
      .rejects.toMatchObject({code:'CONFLICT'});
    const operation={deliveryId:row.id,operation:'DRAFT_HYPOTHESIS',targetHypothesisId:null,requestPath:row.request_path,
      idempotencyKey:row.idempotency_key,body:row.request_body,bodyDigest:row.request_body_digest,requestDigest:row.request_digest};
    await expect(internal.persistResult(owner,delivery,operation,randomUUID(),{id:randomUUID()})).rejects.toMatchObject({code:'CONFLICT'});
    const original=await pool.query(`SELECT response_digest FROM motive.hypothesis_submission_delivery_results
      WHERE delivery_id=$1 AND operation='DRAFT_HYPOTHESIS'`,[completed.deliveryId]);
    await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_results DISABLE TRIGGER hypothesis_submission_delivery_results_immutable');
    try{await pool.query(`UPDATE motive.hypothesis_submission_delivery_results SET response_digest=$2
      WHERE delivery_id=$1 AND operation='DRAFT_HYPOTHESIS'`,[completed.deliveryId,`sha256:${'0'.repeat(64)}`]);
      await expect(current.value.sync(owner,input(submissionId,completionKey))).rejects.toMatchObject({code:'CONFLICT'});
      await pool.query(`UPDATE motive.hypothesis_submission_delivery_results SET response_digest=$2
        WHERE delivery_id=$1 AND operation='DRAFT_HYPOTHESIS'`,[completed.deliveryId,original.rows[0].response_digest]);
    }finally{await pool.query('ALTER TABLE motive.hypothesis_submission_delivery_results ENABLE TRIGGER hypothesis_submission_delivery_results_immutable');}
  });

  it('rechecks active account and connected scope before outbound work',async()=>{const submissionId=await submit();const key=`prepare-${randomUUID()}`;const current=service();
    await current.value.sync(owner,input(submissionId,key,false));await admit(current.value,submissionId);active.delete(owner);
    await expect(current.value.sync(owner,input(submissionId,key,true))).rejects.toMatchObject({code:'UNAUTHORIZED'});active.add(owner);
    const replacement=randomUUID();const client=await pool.connect();try{await client.query('BEGIN');
      await client.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,
        channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,api_version,inspected_source_revision,status,bound_by,verified_at)
        SELECT $1,project_id,provider,api_base_url,$2,$3,channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,
          $4,api_version,inspected_source_revision,'REPLACEMENT_PENDING',bound_by,verified_at FROM motive.project_research_scopes WHERE id=$5`,
      [replacement,randomUUID(),randomUUID(),`sha256:${'9'.repeat(64)}`,scopeId]);
      await client.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacement]);
      await client.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacement]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await expect(current.value.sync(owner,input(submissionId,key,true))).rejects.toMatchObject({code:'FORBIDDEN'});
    const admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),sender:current.value});
    expect(await admission.publicAdmission('circle-packing',submissionId)).toMatchObject({status:'STALE'});
    expect(current.mock.requests).toHaveLength(0);
    const beforeRetirement=(await participation.publicProjection()).contributors.find(item=>item.displayName==='Source contributor')!;
    await pool.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[contributorContext.tokenId]);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id IN ($2,$3)',[projectId,contributor,steward]);
    const afterRetirement=(await participation.publicProjection()).contributors.find(item=>item.displayName==='Source contributor')!;
    expect(afterRetirement.id).toBe(beforeRetirement.id);expect(afterRetirement.reviewedArtifactCount).toBe(beforeRetirement.reviewedArtifactCount);
  });
});
