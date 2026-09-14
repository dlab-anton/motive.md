import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { canonicalJson,digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService,type ParticipationService } from '../../server/participation/index.ts';
import { createHypothesisSubmissionAdmissionService,createHypothesisSubmissionDeliveryService,
  createResearchMemoryService } from '../../server/research-memory/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';
import { parseFindingDecision,parseFindingPreview,parseFindingPublic } from '../../src/lib/finding-review-client.ts';
import type { FindingReviewPackageV1,FindingReviewPackageV2,FindingReviewPreview } from '../../src/lib/finding-assessment.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;
const apiBase='https://engine.invalid/api/v1',apiKey=`he_${'f'.repeat(43)}`;const vaultKey=Buffer.alloc(32,31);

function engineMock(){const requests:Array<{path:string;body:Record<string,unknown>}>=[];const draftIds=new Set<string>();
  const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    requests.push({path:url.pathname,body});const now='2026-09-09T01:00:00.000Z';
    if(url.pathname.endsWith('/hypotheses')){const id=randomUUID();draftIds.add(id);return Response.json({id,statement:body.statement,context:body.context,
      falsification_criteria:null,status:'draft',confidence:null,initial_confidence:null,tags:[],created_by:body.created_by,parent_id:null,is_archived:false,
      evidence_counts:{supporting:0,contradicting:0,neutral:0},deadline:null,metadata:body.metadata,null_hypothesis:null,
      experimental_design:body.experimental_design,significance_level:null,outcome:null,channel:body.channel,created_at:now,updated_at:now},{status:201});}
    const match=/\/hypotheses\/([a-f0-9-]+)\/evidence$/.exec(url.pathname);if(!match||!draftIds.has(match[1]!))throw new Error('unexpected engine request');
    const hypothesisId=match[1]!;return Response.json({evidence:{id:randomUUID(),hypothesis_id:hypothesisId,content:body.content,
      source:body.source,evidence_type:'neutral',strength:null,confidence_after:null,created_by:body.created_by,created_at:now},
      hypothesis:{id:hypothesisId,statement:requests[0]!.body.statement,context:requests[0]!.body.context,falsification_criteria:null,status:'draft',
        confidence:null,initial_confidence:null,tags:[],created_by:body.created_by,parent_id:null,is_archived:false,
        evidence_counts:{supporting:0,contradicting:0,neutral:1},deadline:null,metadata:requests[0]!.body.metadata,null_hypothesis:null,
        experimental_design:requests[0]!.body.experimental_design,significance_level:null,outcome:null,channel:requests[0]!.body.channel,
        created_at:now,updated_at:now}},{status:201});};return{fetcher,requests};}

function historicalPreview(value:FindingReviewPreview){
  if(value.package.format!=='motive.finding-review-package/0.1')throw new Error('expected historical finding package');
  return value as FindingReviewPreview&{package:FindingReviewPackageV1};
}

pgDescribe('finding assessment on isolated PostgreSQL',()=>{
  const databaseName=`motive_finding_assessment_${randomUUID().replaceAll('-','')}`;const issuer=`operator:${randomUUID()}`;
  const owner=`account:${randomUUID()}`,reviewer=`account:${randomUUID()}`;const active=new Set([owner,reviewer]);
  let admin:Pool,pool:Pool,participation:ParticipationService,projectId:string,workOrderId:string,scopeId:string,referenceWitness:string;
  const engine=engineMock();let delivery:ReturnType<typeof createHypothesisSubmissionDeliveryService>;
  let admission:ReturnType<typeof createHypothesisSubmissionAdmissionService>;let finding:ReturnType<typeof createFindingAssessmentService>;

  beforeAll(async()=>{const source=new URL(baseUrl!);expect(['postgres:','postgresql:']).toContain(source.protocol);
    expect(['127.0.0.1','localhost']).toContain(source.hostname);expect(source.search).toBe('');expect(source.hash).toBe('');
    const adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});await admin.query(`CREATE DATABASE ${databaseName}`);const isolated=new URL(source);isolated.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:isolated.toString(),max:16});await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',visibility:'PUBLIC',revisionContent:{title:'Finding assessment'}})).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,[owner,owner.slice(8),reviewer,reviewer.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$5),($4,$2,$6,'REVIEWER',ARRAY['project:review'],$5)`,[randomUUID(),projectId,owner,randomUUID(),issuer,reviewer]);
    participation=createParticipationService(pool,{tokenSecret:`finding-${'s'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:actorId=>active.has(actorId)});workOrderId=(await participation.ensureCircleWorkOrder()).id;
    referenceWitness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');scopeId=randomUUID();
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,
      channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,api_version,
      inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,
      $6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,[scopeId,projectId,apiBase,randomUUID(),randomUUID(),`sha256:${'a'.repeat(64)}`,
      encryptSecret(vaultKey,apiKey,`research-scope:v1:${scopeId}:${projectId}`),`sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'7'.repeat(40),owner]);
    delivery=createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive:actor=>active.has(actor),fetch:engine.fetcher,timeoutMs:2000});
    admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),sender:delivery});
    finding=createFindingAssessmentService({pool,isActorActive:actor=>active.has(actor)});
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){try{await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(0);
  }finally{await admin.end();}}});

  async function newScope(seed:string,status:'CONNECTED'|'REPLACEMENT_PENDING'='CONNECTED'){
    const id=randomUUID();await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,
      channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,api_version,
      inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,
      $6,$7,$8,$9,'1.8.0',$10,$11,$12,clock_timestamp())`,[id,projectId,apiBase,randomUUID(),randomUUID(),`sha256:${seed.repeat(64)}`,
      encryptSecret(vaultKey,apiKey,`research-scope:v1:${id}:${projectId}`),`sha256:${seed.repeat(64)}`,`sha256:${seed.repeat(64)}`,
      seed.repeat(40),status,owner]);return id;
  }

  async function completed(label:string,contributor=`account:${randomUUID()}`,execute=true,publish=true,withProtocol=false){active.add(contributor);await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()) ON CONFLICT DO NOTHING`,[contributor,contributor.slice(8)]);
    const joined=await participation.join(contributor,`Contributor ${label}`,{projectSlug:'circle-packing',publishDisplayName:publish,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context=await participation.authenticateBearer(joined.token);const claim=await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);
    if(claim.leaseEpoch===null)throw new Error('claim lease missing');const leaseEpoch=claim.leaseEpoch;
    const experimentProtocol={format:'motive.experiment-protocol.v1' as const,procedure:'finding-review-test/v1',
      inputs:[{name:'seed',value:'17'}],purpose:'EXPLORATORY' as const};
    const intent={leaseEpoch,proposal:`Pre-test ${label} proposal.`,expectation:`Pre-test ${label} expectation.`,conditions:['Use the frozen checker.'],
      ...(withProtocol?{experimentProtocol}:{})};
    await participation.declareAssignmentIntent(context,workOrderId,intent,`intent-${randomUUID()}`);
    const investigation={format:'motive.investigation.v1' as const,proposal:`Final ${label} proposal.`,expectation:`Final ${label} expectation.`,
      conditions:['Use the frozen checker.'],observations:['The immutable witness was checked.'],assessment:'The result remains scoped to one investigation.',nextAction:'Independent finding assessment.',
      ...(withProtocol?{experimentProtocol}:{})};
    const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch,witness:referenceWitness,investigation},`submit-${randomUUID()}`);
    const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    const publicSummary={question:`What did the ${label} checker run test?`,finding:`The ${label} run reproduces one bounded checked result.`};
    await participation.createPostCheckAssessment(context,submission.id,{reportDigest:String(artifact.rows[0].report_digest),assessment:'Post-check observation.',nextAction:'Review the scoped finding.',publicSummary},`post-${randomUUID()}`);
    await participation.completeAssignment(context,workOrderId,{leaseEpoch,submissionId:submission.id},`complete-${randomUUID()}`);
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:submission.id,idempotencyKey:`prepare-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    if(!execute)return{submissionId:submission.id,contributor,intent};
    const preview=await admission.prepareAdmissionPreview(reviewer,submission.id);expect(preview.package.postCheck.publicSummary).toEqual(publicSummary);await admission.decideAdmission(reviewer,submission.id,{packageDigest:preview.packageDigest,
      expectedDecisionId:null,decision:'ADMIT',rationale:'The exact neutral delivery may proceed.'},`admit-${randomUUID()}`);
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:submission.id,idempotencyKey:`execute-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:true});return{submissionId:submission.id,contributor,intent};}

  it('assesses immutable completed evidence with CAS, replay, correction and public-safe projections',async()=>{const source=await completed('primary');
    expect(await finding.eligibility(source.contributor,source.submissionId)).toMatchObject({canReview:false,reason:'ORIGINAL_CONTRIBUTOR'});
    const preview=parseFindingPreview(await finding.preview(reviewer,source.submissionId),source.submissionId);
    expect(preview.package.project.revision).toBe(preview.package.workOrder.projectRevision);
    expect(preview.package.source.declaredIntent).toMatchObject({proposal:source.intent.proposal,expectation:source.intent.expectation,
      conditions:source.intent.conditions});expect(preview.package.source.investigation.proposal).toContain('Final primary');
    expect(preview.package.source.postCheck.publicSummary).toEqual({question:'What did the primary checker run test?',finding:'The primary run reproduces one bounded checked result.'});
    const input={packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT' as const,outcome:'CONTRADICTED' as const,
      finding:'This completed investigation contradicts its scoped expectation.',limitations:'One protected checker run and its retained neutral evidence.',
      novelty:'DISTINCT' as const,duplicateOfSubmissionId:null,rationale:'The immutable report and post-check support this bounded assessment.'};
    const key=`finding-${randomUUID()}`;const first=parseFindingDecision(await finding.decide(reviewer,source.submissionId,input,key),source.submissionId);
    const replay=parseFindingDecision(await finding.decide(reviewer,source.submissionId,input,key),source.submissionId);expect(replay).toMatchObject({id:first.id,replayed:true});
    const legacyBuilder=finding as unknown as {buildPackageV1(client:Pool,submissionId:string):Promise<{
      pkg:FindingReviewPackageV1;digest:string}>};
    const legacySuccessor=await legacyBuilder.buildPackageV1(pool,source.submissionId);
    await expect(pool.query(`INSERT INTO motive.finding_review_decisions
      (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
       finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,'DECLINE',NULL,NULL,NULL,NULL,NULL,NULL,$7,$8,$9,$10)`,
    [randomUUID(),projectId,source.submissionId,JSON.stringify(legacySuccessor.pkg),legacySuccessor.digest,first.id,reviewer,
      'A v0.2 chain cannot switch to v0.1.',`v2-to-v1-${randomUUID()}`,digestCanonicalJson({first:first.id})]))
      .rejects.toMatchObject({code:'23514'});
    await expect(finding.decide(reviewer,source.submissionId,{...input,finding:'Changed under same key.'},key)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(finding.decide(reviewer,randomUUID(),input,key)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(finding.decide(reviewer,source.submissionId,{...input,expectedDecisionId:null},`stale-${randomUUID()}`)).rejects.toMatchObject({code:'CONFLICT'});
    const replacement=await newScope('d','REPLACEMENT_PENDING');await pool.query('BEGIN');
    try{await pool.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacement]);
      await pool.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacement]);await pool.query('COMMIT');
    }catch(error){await pool.query('ROLLBACK');throw error;}scopeId=replacement;
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`pending-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    expect((await finding.preview(reviewer,source.submissionId)).packageDigest).toBe(preview.packageDigest);
    const nextAdmission=await admission.prepareAdmissionPreview(reviewer,source.submissionId);await admission.decideAdmission(reviewer,source.submissionId,
      {packageDigest:nextAdmission.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Admit the replacement-scope delivery.'},`admit-${randomUUID()}`);
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`execute-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:true});
    const findingCalls=engine.requests.length;
    const latestPreview=await finding.preview(reviewer,source.submissionId);expect(latestPreview.packageDigest).toBe(preview.packageDigest);
    expect((await finding.decide(reviewer,source.submissionId,input,key)).id).toBe(first.id);
    const correction=await finding.decide(reviewer,source.submissionId,{...input,packageDigest:latestPreview.packageDigest,expectedDecisionId:first.id,decision:'DECLINE',outcome:null,
      finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'The earlier scoped assessment is retracted.'},`decline-${randomUUID()}`);
    const publicView=parseFindingPublic(await finding.publicReview('circle-packing',source.submissionId),source.submissionId);
    expect(publicView.latestDecision).toMatchObject({id:correction.id,decision:'DECLINE'});expect(JSON.stringify(publicView)).not.toContain(reviewer);
    expect(JSON.stringify(publicView)).not.toContain('sourceIntentPayload');expect(engine.requests).toHaveLength(findingCalls);
    const journal=await participation.publicResearchJournalEntry(source.submissionId);expect(journal.update.findingReview).toMatchObject({id:correction.id,decision:'DECLINE'});
    await pool.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE owner_actor_id=$1',[source.contributor]);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,source.contributor]);
    await pool.query("UPDATE motive.account_identities SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp() WHERE actor_id=$1",[source.contributor]);
    expect((await finding.preview(reviewer,source.submissionId)).latestDecision?.id).toBe(correction.id);
  },60000);

  it('retains an optional canonical experiment protocol in the finding review package',async()=>{
    const source=await completed('protocol',`account:${randomUUID()}`,true,true,true);
    const preview=parseFindingPreview(await finding.preview(reviewer,source.submissionId),source.submissionId);
    expect(preview.package.source.declaredIntent?.experimentProtocol).toEqual(source.intent.experimentProtocol);
    await finding.decide(reviewer,source.submissionId,{packageDigest:preview.packageDigest,expectedDecisionId:null,
      decision:'DECLINE',outcome:null,finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,
      rationale:'The optional protocol remains bound while this finding is declined.'},`protocol-review-${randomUUID()}`);
  });

  it('pins duplicate findings and serializes identical concurrent decisions without multiplying credit',async()=>{const distinct=await completed('distinct');const targetPreview=await finding.preview(reviewer,distinct.submissionId);
    const accepted=await finding.decide(reviewer,distinct.submissionId,{packageDigest:targetPreview.packageDigest,expectedDecisionId:null,decision:'ACCEPT',outcome:'INCONCLUSIVE',
      finding:'The bounded experiment is inconclusive.',limitations:'One retained trial.',novelty:'DISTINCT',duplicateOfSubmissionId:null,
      rationale:'The neutral evidence does not resolve the scoped expectation.'},`distinct-${randomUUID()}`);
    const duplicate=await completed('duplicate');const preview=await finding.preview(reviewer,duplicate.submissionId);const key=`duplicate-${randomUUID()}`;
    const input={packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT' as const,outcome:'SUPPORTED' as const,
      finding:'This repeats the earlier bounded finding.',limitations:'Judged duplicate by the reviewer.',novelty:'DUPLICATE' as const,
      duplicateOfSubmissionId:distinct.submissionId,rationale:'This completed investigation duplicates the cited accepted finding.'};
    const raced=await Promise.all([finding.decide(reviewer,duplicate.submissionId,input,key),finding.decide(reviewer,duplicate.submissionId,input,key)]);
    expect(new Set(raced.map(item=>item.id))).toEqual(new Set([raced[0]!.id]));expect(raced.filter(item=>item.replayed)).toHaveLength(1);
    const count=await pool.query('SELECT count(*)::int count FROM motive.finding_review_decisions WHERE source_submission_id=$1',[duplicate.submissionId]);expect(count.rows[0].count).toBe(1);
    const projection=await participation.publicProjection();const contributor=projection.contributors.find(item=>item.publicSubmissionIds.includes(distinct.submissionId));
    expect(contributor?.acceptedFindingCount).toBe(1);expect((await participation.publicContributorAcceptedFindings(contributor!.id)).items.map(item=>item.submission.id)).toEqual([distinct.submissionId]);
    await finding.decide(reviewer,distinct.submissionId,{packageDigest:targetPreview.packageDigest,expectedDecisionId:accepted.id,decision:'DECLINE',outcome:null,
      finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'Retract the distinct target.'},`retract-${randomUUID()}`);
    const next=await completed('invalid-duplicate');const nextPreview=await finding.preview(reviewer,next.submissionId);
    await expect(finding.decide(reviewer,next.submissionId,{...input,packageDigest:nextPreview.packageDigest,duplicateOfSubmissionId:distinct.submissionId},`invalid-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});
  },90000);

  it('accepts complete undelivered evidence, fails closed on lost authority, and enforces database immutability',async()=>{
    const partial=await completed('partial',undefined,false);
    expect(await finding.publicReview('circle-packing',partial.submissionId)).toMatchObject({available:true,reason:null});
    expect((await finding.preview(reviewer,partial.submissionId)).package).toMatchObject({format:'motive.finding-review-package/0.2'});
    const source=await completed('authority');const preview=await finding.preview(reviewer,source.submissionId);
    const input={packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT' as const,outcome:'SUPPORTED' as const,
      finding:'The retained result supports this scoped finding.',limitations:'One bounded completed investigation.',novelty:'DISTINCT' as const,
      duplicateOfSubmissionId:null,rationale:'The immutable local package supports this assessment.'};
    await expect(finding.decide(reviewer,source.submissionId,{...input,packageDigest:`sha256:${'0'.repeat(64)}`},`tamper-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});
    active.delete(reviewer);expect(await finding.eligibility(reviewer,source.submissionId)).toMatchObject({canReview:false,reason:'ACCOUNT_INACTIVE'});
    await expect(finding.decide(reviewer,source.submissionId,input,`inactive-${randomUUID()}`)).rejects.toMatchObject({code:'UNAUTHORIZED'});active.add(reviewer);
    const localInactive=`account:${randomUUID()}`;active.add(localInactive);await pool.query(`INSERT INTO motive.account_identities
      (actor_id,provider,subject_id,status,deletion_requested_at,created_at) VALUES($1,'supabase',$2,'DELETION_PENDING',clock_timestamp(),clock_timestamp())`,
    [localInactive,localInactive.slice(8)]);await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[randomUUID(),projectId,localInactive,issuer]);
    expect(await finding.eligibility(localInactive,source.submissionId)).toMatchObject({canReview:false,reason:'ACCOUNT_INACTIVE'});
    const retiring=`account:${randomUUID()}`;active.add(retiring);const retiringMembership=randomUUID();await pool.query(`INSERT INTO motive.account_identities
      (actor_id,provider,subject_id,status,created_at) VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[retiring,retiring.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[retiringMembership,projectId,retiring,issuer]);
    const blocker=await pool.connect();let denied:Promise<{value?:unknown;error?:unknown}>|undefined;
    try{await blocker.query('BEGIN');await blocker.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE id=$1',[retiringMembership]);
      denied=finding.decide(retiring,source.submissionId,input,`retiring-${randomUUID()}`)
        .then(value=>({value}),error=>({error}));const deadline=Date.now()+2000;let observed=false;
      while(Date.now()<deadline){const waiting=await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'
            AND query LIKE '%FROM motive.memberships membership%' LIMIT 1`);
        if(waiting.rowCount){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      expect(observed).toBe(true);await blocker.query('COMMIT');
    }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release();}
    expect(denied).toBeDefined();expect((await denied!).error).toMatchObject({code:'FORBIDDEN'});
    const saved=await finding.decide(reviewer,source.submissionId,input,`saved-${randomUUID()}`);
    await expect(pool.query('UPDATE motive.finding_review_decisions SET rationale=$2 WHERE id=$1',[saved.id,'changed']))
      .rejects.toMatchObject({code:'55000'});
    const other=await completed('substitution');
    await expect(pool.query(`INSERT INTO motive.finding_review_decisions(id,project_id,source_submission_id,review_package,review_package_digest,
      previous_decision_id,decision,outcome,finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,
      reviewer_actor_id,rationale,idempotency_key,request_digest)
      SELECT $1,project_id,$2,review_package,review_package_digest,NULL,'ACCEPT','SUPPORTED','Substituted','Invalid package',
        'DISTINCT',NULL,NULL,reviewer_actor_id,'Must fail','direct-substitution',request_digest
      FROM motive.finding_review_decisions WHERE id=$3`,[randomUUID(),other.submissionId,saved.id])).rejects.toBeTruthy();
    const direct=await pool.query('SELECT count(*)::int count FROM motive.finding_review_decisions WHERE source_submission_id=$1',[other.submissionId]);
    expect(direct.rows[0].count).toBe(0);
    const racedSource=await completed('different-race');const racedPreview=await finding.preview(reviewer,racedSource.submissionId);
    const racedBase={...input,packageDigest:racedPreview.packageDigest};const raced=await Promise.allSettled([
      finding.decide(reviewer,racedSource.submissionId,racedBase,`race-a-${randomUUID()}`),
      finding.decide(reviewer,racedSource.submissionId,{...racedBase,outcome:'CONTRADICTED'},`race-b-${randomUUID()}`)]);
    expect(raced.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(raced.filter(item=>item.status==='rejected')).toHaveLength(1);
    expect(raced.find(item=>item.status==='rejected')).toMatchObject({reason:{code:'CONFLICT'}});
    const refSource=await completed('invalid-retained-ref');const intent=await pool.query('SELECT intent.claim_id,intent.research_context FROM motive.participation_claim_intents intent JOIN motive.submissions submission ON submission.claim_id=intent.claim_id WHERE submission.id=$1',[refSource.submissionId]);
    await pool.query('ALTER TABLE motive.participation_claim_intents DISABLE TRIGGER participation_claim_intents_immutable');
    try{await pool.query('UPDATE motive.participation_claim_intents SET research_context=$2::jsonb WHERE claim_id=$1',[intent.rows[0].claim_id,
        JSON.stringify({scopeId, snapshotId:randomUUID(),snapshotDigest:`sha256:${'9'.repeat(64)}`})]);
      await expect(finding.preview(reviewer,refSource.submissionId)).rejects.toMatchObject({code:'CONFLICT'});
      await pool.query('UPDATE motive.participation_claim_intents SET research_context=$2::jsonb WHERE claim_id=$1',[intent.rows[0].claim_id,intent.rows[0].research_context]);
    }finally{await pool.query('ALTER TABLE motive.participation_claim_intents ENABLE TRIGGER participation_claim_intents_immutable');}
  },90000);

  it('rechecks locked reviewer authority before returning a private preview',async()=>{const source=await completed('preview-revocation');
    let callbackCalls=0;const racedFinding=createFindingAssessmentService({pool,isActorActive:async actor=>{
      callbackCalls+=1;if(actor===reviewer)await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp()
        WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL`,[projectId,reviewer]);return true;}});
    try{await expect(racedFinding.preview(reviewer,source.submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});
      expect(callbackCalls).toBe(1);
    }finally{await pool.query(`UPDATE motive.memberships SET revoked_at=NULL WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);}
    expect((await finding.preview(reviewer,source.submissionId)).package.findingId).toBe(source.submissionId);
  },90000);

  it('keeps accepted-finding count and journal pagination in exact named-submission parity across rotated keys',async()=>{
    const contributor=`account:${randomUUID()}`;const accepted=new Map<string,{packageDigest:string;decisionId:string}>();
    for(let index=0;index<21;index+=1){const source=await completed(`page-${index}`,contributor);const preview=await finding.preview(reviewer,source.submissionId);
      const saved=await finding.decide(reviewer,source.submissionId,{packageDigest:preview.packageDigest,expectedDecisionId:null,
        decision:'ACCEPT',outcome:index%2?'SUPPORTED':'INCONCLUSIVE',finding:`Bounded accepted finding ${index}.`,
        limitations:'One completed investigation only.',novelty:'DISTINCT',duplicateOfSubmissionId:null,
        rationale:`Independent scoped assessment ${index}.`},`page-review-${randomUUID()}`);
      accepted.set(source.submissionId,{packageDigest:preview.packageDigest,decisionId:saved.id});}
    const hidden=await completed('page-hidden',contributor,true,false);const hiddenPreview=await finding.preview(reviewer,hidden.submissionId);
    await finding.decide(reviewer,hidden.submissionId,{packageDigest:hiddenPreview.packageDigest,expectedDecisionId:null,decision:'ACCEPT',outcome:'SUPPORTED',
      finding:'A private-attribution finding.',limitations:'The artifact did not consent to public contributor naming.',novelty:'DISTINCT',duplicateOfSubmissionId:null,
      rationale:'The assessment exists but does not enter the named contributor aggregate.'},`hidden-review-${randomUUID()}`);
    const projection=await participation.publicProjection();const card=projection.contributors.find(item=>item.publicSubmissionIds.some(id=>accepted.has(id)));
    expect(card?.acceptedFindingCount).toBe(21);
    const first=await participation.publicContributorAcceptedFindings(card!.id);expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
    expect(first.items.every(item=>item.update.findingReview?.decision==='ACCEPT'&&item.update.findingReview.novelty==='DISTINCT')).toBe(true);
    const second=await participation.publicContributorAcceptedFindings(card!.id,first.nextCursor!);expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(item=>item.submission.id))).toEqual(new Set(accepted.keys()));
    const removedCursor=first.nextCursor!;const bound=accepted.get(removedCursor)!;
    await finding.decide(reviewer,removedCursor,{packageDigest:bound.packageDigest,expectedDecisionId:bound.decisionId,decision:'DECLINE',
      outcome:null,finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'Retract one accepted finding.'},`page-retract-${randomUUID()}`);
    const after=(await participation.publicProjection()).contributors.find(item=>item.id===card!.id);expect(after?.acceptedFindingCount).toBe(20);
    await expect(participation.publicContributorAcceptedFindings(card!.id,removedCursor)).rejects.toMatchObject({code:'NOT_FOUND'});
  },180000);

  it('pages actionable first reviews before the limit and retains a reviewed cursor across an exact timestamp tie',async()=>{
    const setSubmissionClock=async(value:string)=>pool.query(
      `ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT '${value}'::timestamptz`);
    const pending:Awaited<ReturnType<typeof completed>>[]=[];
    try{for(let index=0;index<19;index+=1){await setSubmissionClock(
        new Date(Date.parse('2030-01-01T00:00:00.000Z')-index*1000).toISOString());
      pending.push(await completed(`queue-${index}`));}
      await setSubmissionClock('2029-01-01T00:00:00.123456Z');
      pending.push(await completed('queue-19'),await completed('queue-20'));
    }finally{await pool.query('ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT clock_timestamp()');}
    const tieAt='2029-01-01T00:00:00.123456Z';const orderedPair=[pending[19]!,pending[20]!]
      .sort((a,b)=>b.submissionId.localeCompare(a.submissionId));
    const tied=await pool.query('SELECT count(*)::int count FROM motive.submissions WHERE id=ANY($1::uuid[]) AND created_at=$2',
      [[orderedPair[0].submissionId,orderedPair[1].submissionId],tieAt]);expect(tied.rows[0].count).toBe(2);

    let partial:Awaited<ReturnType<typeof completed>>,own:Awaited<ReturnType<typeof completed>>;
    try{await setSubmissionClock('2031-01-01T00:00:00.000001Z');partial=await completed('queue-partial',undefined,false);
      await setSubmissionClock('2031-01-01T00:00:01.000001Z');own=await completed('queue-own',reviewer,false);
    }finally{await pool.query('ALTER TABLE motive.submissions ALTER COLUMN created_at SET DEFAULT clock_timestamp()');}
    const ownAdmission=await admission.prepareAdmissionPreview(owner,own.submissionId);
    await admission.decideAdmission(owner,own.submissionId,{packageDigest:ownAdmission.packageDigest,expectedDecisionId:null,
      decision:'ADMIT',rationale:'The owner independently admits the reviewer-owned fixture.'},`queue-own-${randomUUID()}`);
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:own.submissionId,idempotencyKey:`queue-own-execute-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:true});

    const retired=pending[0]!;await pool.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE owner_actor_id=$1',[retired.contributor]);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,retired.contributor]);
    const replacement=await newScope('6','REPLACEMENT_PENDING');await pool.query('BEGIN');
    try{await pool.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacement]);
      await pool.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacement]);await pool.query('COMMIT');
    }catch(error){await pool.query('ROLLBACK');throw error;}scopeId=replacement;
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:pending[1]!.submissionId,
      idempotencyKey:`queue-newer-partial-${randomUUID()}`,approvedApiBaseUrl:apiBase,
      contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});

    const engineCalls=engine.requests.length;const first=await participation.findingReviewQueue(reviewer);
    expect(engine.requests).toHaveLength(engineCalls);expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe(pending[18]!.submissionId);
    expect(first.items.map(item=>item.submission.id)).toContain(retired.submissionId);
    expect(first.items.map(item=>item.submission.id)).toContain(pending[1]!.submissionId);
    expect(first.items.map(item=>item.submission.id)).toContain(partial.submissionId);
    expect(first.items.map(item=>item.submission.id)).not.toContain(own.submissionId);
    expect(JSON.stringify(first)).not.toContain(reviewer);

    const cursorPreview=await finding.preview(reviewer,orderedPair[0].submissionId);
    await finding.decide(reviewer,orderedPair[0].submissionId,{packageDigest:cursorPreview.packageDigest,expectedDecisionId:null,
      decision:'DECLINE',outcome:null,finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,
      rationale:'The first independent finding assessment is recorded.'},`queue-cursor-${randomUUID()}`);
    const second=await participation.findingReviewQueue(reviewer,orderedPair[0].submissionId);
    expect(second.items[0]!.submission.id).toBe(orderedPair[1].submissionId);
    expect(second.items.map(item=>item.submission.id)).not.toContain(orderedPair[0].submissionId);
    await expect(participation.findingReviewQueue(reviewer,own.submissionId)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(participation.findingReviewQueue(reviewer,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});

    const localInactive=`account:${randomUUID()}`,remoteInactive=`account:${randomUUID()}`,revoked=`account:${randomUUID()}`;
    for(const [actor,status,revokedAt] of [[localInactive,'DELETION_PENDING',null],[remoteInactive,'ACTIVE',null],
      [revoked,'ACTIVE',new Date()]] as const){if(status==='ACTIVE')active.add(actor);
      await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,deletion_requested_at,created_at)
        VALUES($1,'supabase',$2,$3,$4,clock_timestamp())`,[actor,randomUUID(),status,status==='ACTIVE'?null:new Date()]);
      await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by,revoked_at)
        VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4,$5)`,[randomUUID(),projectId,actor,issuer,revokedAt]);}
    active.delete(remoteInactive);
    for(const actor of [localInactive,remoteInactive,revoked])
      await expect(participation.findingReviewQueue(actor)).rejects.toMatchObject({code:'FORBIDDEN'});



  },180000);

  it('pages the immutable correction chain independently of timestamps and retains historical evidence after reviewer retirement',async()=>{
    let historyQueryCount=0;
    const countedFinding=createFindingAssessmentService({pool:{query:(sql:string,params?:unknown[])=>{
      historyQueryCount+=1;return pool.query(sql,params);}} as unknown as Pool,isActorActive:actor=>active.has(actor)});
    const readHistory=async(submissionId:string,before?:string)=>{historyQueryCount=0;
      try{return await countedFinding.publicHistory('circle-packing',submissionId,before);}
      finally{expect(historyQueryCount).toBe(1);}};
    const empty=await completed('history-empty');
    expect(await readHistory(empty.submissionId)).toEqual({
      format:'motive.finding-review.history/0.1',submissionId:empty.submissionId,latestDecisionId:null,items:[],nextCursor:null});

    const source=await completed('history-chain');
    const historyReviewer=`account:${randomUUID()}`;active.add(historyReviewer);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[historyReviewer,historyReviewer.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[randomUUID(),projectId,historyReviewer,issuer]);

    const decisions:Array<{id:string;previousDecisionId:string|null;hypothesisId:string;evidenceId:string}>=[];
    const setDecisionClock=(value:string)=>pool.query(
      `ALTER TABLE motive.finding_review_decisions ALTER COLUMN created_at SET DEFAULT '${value}'::timestamptz`);
    let oldPreview:ReturnType<typeof historicalPreview>;
    let currentPreview:ReturnType<typeof historicalPreview>;
    try{
      await setDecisionClock('2040-01-01T00:00:00.123456Z');
      const legacyBuilder=finding as unknown as {buildPackageV1(client:Pool,submissionId:string):Promise<{
        pkg:FindingReviewPackageV1;digest:string}>};
      const legacy=await legacyBuilder.buildPackageV1(pool,source.submissionId);const rootId=randomUUID();
      await pool.query(`INSERT INTO motive.finding_review_decisions
        (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
         finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4::jsonb,$5,NULL,'ACCEPT','INCONCLUSIVE',$6,$7,'DISTINCT',NULL,NULL,$8,$9,$10,$11)`,
      [rootId,projectId,source.submissionId,JSON.stringify(legacy.pkg),legacy.digest,
        'The first scoped experiment remains inconclusive.','This finding is bound to the earlier retained delivery.',
        historyReviewer,'The earlier immutable package supports only this bounded historical assessment.',
        `history-root-${randomUUID()}`,`sha256:${'8'.repeat(64)}`]);
      oldPreview=historicalPreview(await finding.preview(historyReviewer,source.submissionId));
      expect(oldPreview.packageDigest).toBe(legacy.digest);expect(oldPreview.latestDecision?.id).toBe(rootId);
      let previous:{id:string}={id:rootId};
      decisions.push({id:previous.id,previousDecisionId:null,hypothesisId:oldPreview.package.engine.hypothesis.id,
        evidenceId:oldPreview.package.engine.evidence.id});
      const nativeBuilder=finding as unknown as {buildPackageV2(client:Pool,submissionId:string):Promise<{
        pkg:FindingReviewPackageV2;digest:string}>};
      const nativeSuccessor=await nativeBuilder.buildPackageV2(pool,source.submissionId);
      await expect(pool.query(`INSERT INTO motive.finding_review_decisions
        (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
         finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,'DECLINE',NULL,NULL,NULL,NULL,NULL,NULL,$7,$8,$9,$10)`,
      [randomUUID(),projectId,source.submissionId,JSON.stringify(nativeSuccessor.pkg),nativeSuccessor.digest,rootId,
        historyReviewer,'A v0.1 chain cannot switch to v0.2.',`v1-to-v2-${randomUUID()}`,
        digestCanonicalJson({rootId})])).rejects.toMatchObject({code:'23514'});

      const replacement=await newScope('f','REPLACEMENT_PENDING');await pool.query('BEGIN');
      try{await pool.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacement]);
        await pool.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacement]);await pool.query('COMMIT');
      }catch(error){await pool.query('ROLLBACK');throw error;}scopeId=replacement;
      await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`history-prepare-${randomUUID()}`,
        approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
      const nextAdmission=await admission.prepareAdmissionPreview(reviewer,source.submissionId);
      await admission.decideAdmission(reviewer,source.submissionId,{packageDigest:nextAdmission.packageDigest,expectedDecisionId:null,
        decision:'ADMIT',rationale:'Admit the later delivery for correction-history coverage.'},`history-admit-${randomUUID()}`);
      await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`history-execute-${randomUUID()}`,
        approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:true});
      currentPreview=historicalPreview(await finding.preview(historyReviewer,source.submissionId));
      expect(currentPreview.package.engine.hypothesis.id).not.toBe(oldPreview.package.engine.hypothesis.id);

      for(let index=1;index<25;index+=1){
        const second=index===2?59:60-index;
        await setDecisionClock(`2039-01-01T00:00:${String(second).padStart(2,'0')}.123456Z`);
        const accept=index%2===0;
        const saved=await finding.decide(historyReviewer,source.submissionId,{packageDigest:currentPreview.packageDigest,
          expectedDecisionId:previous.id,decision:accept?'ACCEPT':'DECLINE',outcome:accept?'SUPPORTED':null,
          finding:accept?`Historical scoped finding ${index}.`:null,
          limitations:accept?'One immutable experiment and its retained delivery.':null,
          novelty:accept?'DISTINCT':null,duplicateOfSubmissionId:null,
          rationale:`Correction chain decision ${index}; this text remains public and bounded.`},`history-${index}-${randomUUID()}`);
        decisions.push({id:saved.id,previousDecisionId:previous.id,hypothesisId:currentPreview.package.engine.hypothesis.id,
          evidenceId:currentPreview.package.engine.evidence.id});previous=saved;
      }
    }finally{await pool.query('ALTER TABLE motive.finding_review_decisions ALTER COLUMN created_at SET DEFAULT clock_timestamp()');}

    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,historyReviewer]);
    active.delete(historyReviewer);
    const beforeRead=(await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.finding_review_decisions) decisions,
      (SELECT count(*)::integer FROM motive.research_context_snapshots) snapshots,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_deliveries) deliveries,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_results) results`)).rows[0];
    const engineCalls=engine.requests.length;const newest=[...decisions].reverse();
    const first=await readHistory(source.submissionId);
    expect(first.latestDecisionId).toBe(newest[0]!.id);expect(first.items.map(item=>item.id)).toEqual(newest.slice(0,20).map(item=>item.id));
    expect(first.nextCursor).toBe(newest[19]!.id);
    expect(first.items.map(item=>item.previousDecisionId)).toEqual(newest.slice(0,20).map(item=>item.previousDecisionId));
    const second=await readHistory(source.submissionId,first.nextCursor!);
    expect(second.latestDecisionId).toBe(newest[0]!.id);expect(second.items.map(item=>item.id)).toEqual(newest.slice(20).map(item=>item.id));
    expect(second.nextCursor).toBeNull();
    const all=[...first.items,...second.items];
    expect(Date.parse(all[0]!.reviewedAt)).toBeLessThan(Date.parse(all.at(-1)!.reviewedAt));
    expect(all.find(item=>item.id===decisions[1]!.id)!.reviewedAt)
      .toBe(all.find(item=>item.id===decisions[2]!.id)!.reviewedAt);
    const excludingLatest=await readHistory(source.submissionId,newest[0]!.id);
    expect(excludingLatest.items[0]!.id).toBe(newest[1]!.id);expect(excludingLatest.latestDecisionId).toBe(newest[0]!.id);
    const root=second.items.at(-1)!;expect(root.previousDecisionId).toBeNull();
    expect(root).toMatchObject({packageDigest:oldPreview!.packageDigest,
      hypothesis:{id:oldPreview!.package.engine.hypothesis.id,responseDigest:oldPreview!.package.engine.hypothesis.responseDigest},
      evidence:{engineEvidence:{id:oldPreview!.package.engine.evidence.id,
        responseDigest:oldPreview!.package.engine.evidence.responseDigest}}});
    expect(first.items[0]).toMatchObject({packageDigest:currentPreview!.packageDigest,
      hypothesis:{id:currentPreview!.package.engine.hypothesis.id,responseDigest:currentPreview!.package.engine.hypothesis.responseDigest},
      evidence:{engineEvidence:{id:currentPreview!.package.engine.evidence.id,
        responseDigest:currentPreview!.package.engine.evidence.responseDigest}}});
    expect(JSON.stringify([first,second])).not.toMatch(/reviewerActorId|duplicateOfDecisionId|review_package|sourceIntentPayload/);
    expect(JSON.stringify([first,second])).not.toContain(historyReviewer);

    const foreign=(await pool.query(`SELECT id::text FROM motive.finding_review_decisions
      WHERE source_submission_id<>$1 ORDER BY id LIMIT 1`,[source.submissionId])).rows[0];
    expect(foreign).toBeTruthy();
    await expect(readHistory(source.submissionId,String(foreign.id))).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(readHistory(source.submissionId,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});

    const ledger=new LedgerKernel(pool);const privateProject=await ledger.createProject({actorId:issuer,idempotencyKey:randomUUID(),
      slug:`private-history-${randomUUID()}`,visibility:'PRIVATE',revisionContent:{title:'Private finding history'}});
    const template=(await pool.query('SELECT terms FROM motive.work_orders WHERE id=$1',[workOrderId])).rows[0].terms as Record<string,unknown>;
    const privateWork=await ledger.createWorkOrder({actorId:issuer,idempotencyKey:randomUUID(),projectId:privateProject.id,
      workOrderKey:'private-history',revision:1,state:'READY',terms:{...template,project_id:privateProject.id,
        agreement_id:`agreement:${randomUUID()}`} as never});
    const privateClaim=randomUUID(),privateSubmission=randomUUID();await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'ACTIVE',clock_timestamp()+interval '10 minutes')`,
    [privateClaim,privateProject.id,privateWork.id,`agent:${randomUUID()}`,privateWork.termsDigest]);
    await pool.query(`INSERT INTO motive.submissions(id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,
      claim_id,lease_epoch,format,base_commit,artifact_manifest_digest,provenance,usage_status,license_acceptance_ref)
      SELECT $1,$2,$3,1,'EXTERNAL',claim.operator_actor_id,$4,1,'motive.submission/0.1',$5,$6,'{}'::jsonb,
        'unmetered_external','private-history-test' FROM motive.work_claims claim WHERE claim.id=$4`,
    [privateSubmission,privateProject.id,privateWork.id,privateClaim,'a'.repeat(40),`sha256:${'b'.repeat(64)}`]);
    await expect(readHistory(privateSubmission)).rejects.toMatchObject({code:'NOT_FOUND'});
    const afterRead=(await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.finding_review_decisions) decisions,
      (SELECT count(*)::integer FROM motive.research_context_snapshots) snapshots,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_deliveries) deliveries,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_results) results`)).rows[0];
    expect(afterRead).toEqual(beforeRead);expect(engine.requests).toHaveLength(engineCalls);
  },180000);

  it('omits a source-only finding tail from engine context while retaining immutable context snapshots',async()=>{
    const target=await completed('memory-duplicate-target');const targetPreview=await finding.preview(reviewer,target.submissionId);
    await finding.decide(reviewer,target.submissionId,{packageDigest:targetPreview.packageDigest,expectedDecisionId:null,
      decision:'ACCEPT',outcome:'CONTRADICTED',finding:'The target experiment contradicts its bounded expectation.',
      limitations:'One retained protected-checker result.',novelty:'DISTINCT',duplicateOfSubmissionId:null,
      rationale:'This creates the explicit duplicate target for the recall fixture.'},`memory-target-${randomUUID()}`);
    const source=await completed('memory-recall');

    type Remote={channelId:string;hypothesis:Record<string,unknown>;evidence:Record<string,unknown>};
    const loadRemote=async():Promise<Remote>=>{const result=await pool.query(`SELECT scope.channel_id::text,
        evidence_result.response_body->'hypothesis' AS hypothesis,evidence_result.response_body->'evidence' AS evidence
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.project_research_scopes scope ON scope.id=delivery.scope_id
      JOIN motive.hypothesis_submission_delivery_results draft_result ON draft_result.delivery_id=delivery.id
        AND draft_result.operation='DRAFT_HYPOTHESIS'
      JOIN motive.hypothesis_submission_delivery_results evidence_result ON evidence_result.delivery_id=delivery.id
        AND evidence_result.operation='NEUTRAL_EVIDENCE'
      WHERE delivery.project_id=$1 AND delivery.scope_id=$2 AND delivery.source_submission_id=$3`,
    [projectId,scopeId,source.submissionId]);expect(result.rowCount).toBe(1);return{channelId:String(result.rows[0].channel_id),
      hypothesis:result.rows[0].hypothesis as Record<string,unknown>,evidence:result.rows[0].evidence as Record<string,unknown>};};
    let remote=await loadRemote();const memoryReads:string[]=[];
    const memoryFetch:typeof fetch=async input=>{const url=new URL(String(input));memoryReads.push(`${url.pathname}${url.search}`);
      const channel={id:remote.channelId,name:'circle-packing',goal:'Recall retained independently assessed findings.',
        created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'};
      const evidencePage={hypothesis_id:remote.hypothesis.id,items:[remote.evidence],total:1,offset:0,limit:20};
      let body:unknown;
      if(url.pathname.includes('/context/hypotheses/'))body={format:'hypothesis.hypothesis-context.v1',channel,
        hypothesis:remote.hypothesis,evidence_page:evidencePage};
      else if(url.pathname.endsWith('/context'))body={format:'hypothesis.channel-context.v1',channel,
        active_hypotheses:{items:[remote.hypothesis],total:1,offset:0,limit:6},
        archived_hypotheses:{items:[],total:0,offset:0,limit:6},insights:{items:[],total:0,offset:0,limit:20},
        evidence_pages:[evidencePage]};
      else if(url.pathname.endsWith('/channels/circle-packing'))body=channel;
      else if(url.pathname.endsWith('/hypotheses'))body=url.searchParams.get('is_archived')==='true'
        ?{items:[],total:0,offset:0,limit:6}:{items:[remote.hypothesis],total:1,offset:0,limit:6};
      else if(url.pathname.endsWith('/evidence'))body={items:[remote.evidence],total:1,offset:0,limit:20};
      else if(url.pathname.endsWith('/insights'))body={items:[],total:0,offset:0,limit:20};
      else return new Response('{}',{status:404});return Response.json(body);};
    const now=()=>new Date('2026-09-09T08:00:00.000Z');
    const legacy=createResearchMemoryService({pool,vaultKey,fetch:memoryFetch,now});
    const batched=createResearchMemoryService({pool,vaultKey,fetch:memoryFetch,contextTransport:'channel-context-v1',now});
    const before=await batched.getContext('circle-packing');const beforeHypothesis=before.hypotheses[0]!;
    expect(beforeHypothesis.motiveSubmission).not.toHaveProperty('latestFindingReview');
    const retainedBefore=await batched.getSnapshot(projectId,before.snapshotId);

    const reviewPreview=await finding.preview(reviewer,source.submissionId);const reviewedHypothesisId=String(remote.hypothesis.id);
    const reviewedEvidenceId=String(remote.evidence.id);const engineCallsBefore=engine.requests.length;
    const accepted=await finding.decide(reviewer,source.submissionId,{packageDigest:reviewPreview.packageDigest,expectedDecisionId:null,
      decision:'ACCEPT',outcome:'INCONCLUSIVE',finding:'The completed experiment remains inconclusive within its frozen conditions.',
      limitations:'One protected-checker result with neutral engine evidence.',novelty:'DUPLICATE',duplicateOfSubmissionId:target.submissionId,
      rationale:'The scoped result duplicates the retained target without claiming global support.'},`memory-accept-${randomUUID()}`);
    expect(engine.requests).toHaveLength(engineCallsBefore);

    memoryReads.length=0;const querySpy=vi.spyOn(pool,'query');
    const legacyFresh=await legacy.getContext('circle-packing');const batchedFresh=await batched.getContext('circle-packing');
    const targeted=await batched.getHypothesisContext('circle-packing',reviewedHypothesisId);
    const provenanceQueries=querySpy.mock.calls.filter(call=>typeof call[0]==='string'&&call[0].includes('WITH candidates AS'));
    querySpy.mockRestore();expect(provenanceQueries).toHaveLength(3);
    expect(memoryReads).toHaveLength(7);
    const legacyFinding=legacyFresh.hypotheses[0]!.motiveSubmission!.latestFindingReview;
    const batchedFinding=batchedFresh.hypotheses[0]!.motiveSubmission!.latestFindingReview;
    const targetedFinding=targeted.hypotheses[0].motiveSubmission!.latestFindingReview;
    expect(legacyFinding).toBeUndefined();expect(batchedFinding).toBeUndefined();expect(targetedFinding).toBeUndefined();
    const acceptedRetained=await batched.getSnapshot(projectId,batchedFresh.snapshotId);

    const replacement=await newScope('e','REPLACEMENT_PENDING');await pool.query('BEGIN');
    try{await pool.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacement]);
      await pool.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacement]);await pool.query('COMMIT');
    }catch(error){await pool.query('ROLLBACK');throw error;}scopeId=replacement;
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`memory-prepare-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    const nextAdmission=await admission.prepareAdmissionPreview(reviewer,source.submissionId);await admission.decideAdmission(reviewer,source.submissionId,
      {packageDigest:nextAdmission.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Admit the later delivery.'},`memory-admit-${randomUUID()}`);
    await delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:source.submissionId,idempotencyKey:`memory-execute-${randomUUID()}`,
      approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:true});remote=await loadRemote();
    expect(String(remote.hypothesis.id)).not.toBe(reviewedHypothesisId);
    const afterDelivery=await batched.getContext('circle-packing');expect(afterDelivery.hypotheses[0]!.id).toBe(String(remote.hypothesis.id));
    expect(afterDelivery.hypotheses[0]!.motiveSubmission!.latestFindingReview).toBeUndefined();

    const correctionPreview=await finding.preview(reviewer,source.submissionId);const declined=await finding.decide(reviewer,source.submissionId,
      {packageDigest:correctionPreview.packageDigest,expectedDecisionId:accepted.id,decision:'DECLINE',outcome:null,finding:null,
        limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'Withdraw the prior scoped assessment after independent correction.'},
      `memory-decline-${randomUUID()}`);
    await pool.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,reviewer]);
    const retired=await batched.getContext('circle-packing');
    expect(retired.hypotheses[0]!.motiveSubmission!.latestFindingReview).toBeUndefined();
    expect(retired.snapshotDigest).toBe(afterDelivery.snapshotDigest);
    const retiredAgain=await batched.getContext('circle-packing');
    expect({id:retiredAgain.snapshotId,digest:retiredAgain.snapshotDigest}).toEqual({id:retired.snapshotId,digest:retired.snapshotDigest});
    expect(await batched.getSnapshot(projectId,batchedFresh.snapshotId)).toEqual(acceptedRetained);
    expect(acceptedRetained.hypotheses[0]!.motiveSubmission!.latestFindingReview).toBeUndefined();
    expect(await batched.getSnapshot(projectId,before.snapshotId)).toEqual(retainedBefore);
    expect(retainedBefore.hypotheses[0]!.motiveSubmission).not.toHaveProperty('latestFindingReview');
  },120000);

  });
