import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';
import type { SubmissionInvestigationInput } from '../../src/lib/participation.ts';
import { createHypothesisSubmissionAdmissionService, createHypothesisSubmissionDeliveryService } from '../../server/research-memory/index.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;
const vaultKey=Buffer.alloc(32,6),agentTokenSecret=`review-agent-${'s'.repeat(48)}`;
const apiBase='https://review-agent-engine.invalid/api/v1',apiKey=`he_${'g'.repeat(43)}`;

pgDescribe('single-purpose research admission reviewer agents on isolated PostgreSQL',()=>{
  const databaseName=`motive_review_agent_${randomUUID().replaceAll('-','')}`;
  const operator=`operator:${randomUUID()}`,owner=`account:${randomUUID()}`,reviewer=`account:${randomUUID()}`,
    contributor=`account:${randomUUID()}`;const active=new Set([owner,reviewer,contributor]);
  let admin:Pool,pool:Pool,observer:Pool,participation:ParticipationService,context:ParticipationAgentContext;
  let projectId:string,workOrderId:string,scopeId:string;let engineCalls=0;
  const preSnapshotId=randomUUID(),sharedSnapshotId=randomUUID(),finalSnapshotId=randomUUID(),corruptSnapshotId=randomUUID(),
    wrongScopeSnapshotId=randomUUID(),crossProjectSnapshotId=randomUUID();
  let preSnapshotDigest:string,sharedSnapshotDigest:string,finalSnapshotDigest:string,corruptSnapshotDigest:string,
    wrongScopeSnapshotDigest:string,crossProjectSnapshotDigest:string,crossScopeId:string;
  const isActorActive=async(actorId:string)=>{await pool.query('SELECT 1');return active.has(actorId);};
  const sender=()=>createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive,fetch:async()=>{engineCalls+=1;throw new Error('No engine call is permitted.');}});
  const service=()=>{const delivery=sender();return{delivery,admission:createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive,
    sender:delivery,agentTokenSecret})};};
  let notes:SubmissionInvestigationInput={format:'motive.investigation.v1',proposal:'Check one bounded candidate before independent memory review.',
    expectation:'The protected checker records an exact negative result.',conditions:['Use the protected checker.'],
    observations:['The candidate is incomplete.'],assessment:'This negative result does not establish hypothesis support.',
    nextAction:'An independent reviewer may assess this exact package.'};

  async function prepared(){const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch:1,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:notes},`submit-${randomUUID()}`);
    const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    await participation.createPostCheckAssessment(context,submission.id,{reportDigest:String(artifact.rows[0].report_digest),
      assessment:'The protected report rejects this bounded candidate without approving a conclusion.',
      nextAction:'Retain only if an independent reviewer admits the exact delivery package.'},`assess-${randomUUID()}`);
    const current=service();await current.delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:submission.id,
      idempotencyKey:`delivery-${randomUUID()}`,approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    const preview=await current.admission.prepareAdmissionPreview(reviewer,submission.id);return{submissionId:submission.id,preview,...current};}

  async function legacyPrepared(notesOverride?:SubmissionInvestigationInput){
    const legacyContributor=`account:${randomUUID()}`;active.add(legacyContributor);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[legacyContributor,randomUUID()]);
    const joined=await participation.join(legacyContributor,'Legacy reviewer-agent source',{projectSlug:'circle-packing',
      publishDisplayName:false,acceptReferenceTerms:true},`legacy-join-${randomUUID()}`);
    const legacyContext=await participation.authenticateBearer(joined.token);
    const claim=await participation.claimAssignment(legacyContext,workOrderId,`legacy-claim-${randomUUID()}`);
    const legacyNotes:SubmissionInvestigationInput=notesOverride??{format:'motive.investigation.v1',proposal:'Retain an older source without citations.',
      expectation:'The package remains reviewable without a pre-test intent.',conditions:['Use the protected checker.'],
      observations:['No retained research snapshot was cited.'],assessment:'This fixture models an older stored delegation source.',
      nextAction:'Verify additive reviewer snapshot access compatibility.'};
    const submission=await participation.submitWitness(legacyContext,workOrderId,{leaseEpoch:claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:legacyNotes},`legacy-submit-${randomUUID()}`);
    const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    await participation.createPostCheckAssessment(legacyContext,submission.id,{reportDigest:String(artifact.rows[0].report_digest),
      assessment:'The legacy package has an exact protected report.',nextAction:'Review the retained package without snapshot access.'},
    `legacy-assess-${randomUUID()}`);
    const current=service();await current.delivery.sync(owner,{projectSlug:'circle-packing',scopeId,submissionId:submission.id,
      idempotencyKey:`legacy-delivery-${randomUUID()}`,approvedApiBaseUrl:apiBase,contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    const preview=await current.admission.prepareAdmissionPreview(reviewer,submission.id);
    return{submissionId:submission.id,preview,...current};
  }

  async function waitForLock(fragment:string){for(let attempt=0;attempt<200;attempt++){
    const waiting=await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND application_name='review-agent-main' AND state='active' AND wait_event_type='Lock' AND position($1 in query)>0`,[fragment]);
    if(waiting.rowCount)return;await new Promise<void>(resolve=>setImmediate(resolve));}
    throw new Error(`Expected blocked statement was not observed: ${fragment}`);}

  beforeAll(async()=>{const source=new URL(baseUrl!),adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl=new URL(source);testUrl.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:testUrl.toString(),max:2,application_name:'review-agent-main'});
    observer=new Pool({connectionString:testUrl.toString(),max:1,application_name:'review-agent-observer'});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project=await new LedgerKernel(pool).createProject({actorId:operator,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Reviewer agent access test'}});projectId=project.id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp()),
      ($5,'supabase',$6,'ACTIVE',clock_timestamp())`,[owner,owner.slice(8),reviewer,reviewer.slice(8),contributor,contributor.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$6),($4,$2,$5,'REVIEWER',ARRAY['project:review'],$6)`,
    [randomUUID(),projectId,owner,randomUUID(),reviewer,operator]);
    participation=createParticipationService(pool,{tokenSecret:`participation-${'t'.repeat(48)}`,issuerActorId:operator,
      validateResearchContext:async()=>undefined,validateResearchReferences:async()=>undefined});
    workOrderId=(await participation.ensureCircleWorkOrder()).id;
    const joined=await participation.join(contributor,'Reviewer agent contributor',{projectSlug:'circle-packing',publishDisplayName:false,
      acceptReferenceTerms:true},`join-${randomUUID()}`);context=await participation.authenticateBearer(joined.token);
    await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);scopeId=randomUUID();
    const encrypted=encryptSecret(vaultKey,apiKey,`research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,
      'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [scopeId,projectId,apiBase,randomUUID(),randomUUID(),`sha256:${'a'.repeat(64)}`,encrypted,`sha256:${'b'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`,'7'.repeat(40),owner]);
    const hypothesisId=randomUUID(),observedUpdatedAt='2026-09-08T00:00:00.000Z';
    const channelSnapshot=(label:string,snapshotScopeId=scopeId)=>({format:'motive.research-context.v1',scopeId:snapshotScopeId,
      projectSlug:'circle-packing',channelName:'circle-packing',channelGoal:label,hypotheses:[],hypothesesTotal:0,
      hypothesesTruncated:false,activeHypothesesTotal:0,archivedHypothesesTotal:0,insights:[],insightsTotal:0,
      insightsTruncated:false,page:{activeOffset:0,archivedOffset:0,insightOffset:0,activeLimit:6,archivedLimit:6,insightLimit:20}});
    const targetedSnapshot={format:'motive.research-hypothesis-context.v1',scopeId,projectSlug:'circle-packing',
      channelName:'circle-packing',channelGoal:'One retained hypothesis.',selection:{kind:'hypothesis',hypothesisId,evidenceOffset:0,evidenceLimit:20},
      hypotheses:[{id:hypothesisId,updatedAt:observedUpdatedAt,contentDigest:`sha256:${'1'.repeat(64)}`,
        statement:'A retained historical hypothesis.',context:null,falsificationCriteria:null,status:'active',confidence:null,parentId:null,
        outcome:null,evidence:[],evidenceTotal:0,evidenceTruncated:false}]};
    const prePayload=channelSnapshot('Pre-test baseline.'),sharedPayload=channelSnapshot('Shared baseline.'),
      finalPayload=targetedSnapshot,corruptPayload=channelSnapshot('Digest mismatch.'),
      wrongScopePayload=channelSnapshot('Wrong payload scope.',randomUUID());
    preSnapshotDigest=digestCanonicalJson(prePayload);sharedSnapshotDigest=digestCanonicalJson(sharedPayload);
    finalSnapshotDigest=digestCanonicalJson(finalPayload);corruptSnapshotDigest=`sha256:${'e'.repeat(64)}`;
    wrongScopeSnapshotDigest=digestCanonicalJson(wrongScopePayload);
    await pool.query(`INSERT INTO motive.research_context_snapshots
      (id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at) VALUES
      ($1,$2,$3,$4,$5::jsonb,'1.8.0','2026-09-08T00:00:00.123Z'),
      ($6,$2,$3,$7,$8::jsonb,'1.8.0','2026-09-08T00:00:01.234Z'),
      ($9,$2,$3,$10,$11::jsonb,'1.8.0','2026-09-08T00:00:02.345Z'),
      ($12,$2,$3,$13,$14::jsonb,'1.8.0','2026-09-08T00:00:03.456Z'),
      ($15,$2,$3,$16,$17::jsonb,'1.8.0','2026-09-08T00:00:04.567Z')`,
    [preSnapshotId,scopeId,projectId,preSnapshotDigest,JSON.stringify(prePayload),sharedSnapshotId,sharedSnapshotDigest,
      JSON.stringify(sharedPayload),finalSnapshotId,finalSnapshotDigest,JSON.stringify(finalPayload),corruptSnapshotId,
      corruptSnapshotDigest,JSON.stringify(corruptPayload),wrongScopeSnapshotId,wrongScopeSnapshotDigest,JSON.stringify(wrongScopePayload)]);
    const crossProject=await new LedgerKernel(pool).createProject({actorId:operator,idempotencyKey:randomUUID(),
      slug:`review-snapshot-${randomUUID()}`,visibility:'PUBLIC',revisionContent:{title:'Cross-project snapshot isolation'}});
    crossScopeId=randomUUID();const crossEncrypted=encryptSecret(vaultKey,apiKey,
      `research-scope:v1:${crossScopeId}:${crossProject.id}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,
      'cross-project','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [crossScopeId,crossProject.id,apiBase,randomUUID(),randomUUID(),`sha256:${'4'.repeat(64)}`,crossEncrypted,
      `sha256:${'5'.repeat(64)}`,`sha256:${'6'.repeat(64)}`,'8'.repeat(40),owner]);
    const crossPayload=channelSnapshot('Another project snapshot.',crossScopeId);
    crossProjectSnapshotDigest=digestCanonicalJson(crossPayload);
    await pool.query(`INSERT INTO motive.research_context_snapshots
      (id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0','2026-09-08T00:00:05.678Z')`,
    [crossProjectSnapshotId,crossScopeId,crossProject.id,crossProjectSnapshotDigest,JSON.stringify(crossPayload)]);
    const reference=(snapshotId:string,snapshotDigest:string,referenceScopeId=scopeId)=>({scopeId:referenceScopeId,snapshotId,snapshotDigest,hypothesisId,
      observedUpdatedAt,evidenceIds:[]});
    await participation.declareAssignmentIntent(context,workOrderId,{leaseEpoch:1,
      proposal:'Check one bounded candidate before independent memory review.',
      expectation:'The protected checker records an exact negative result.',conditions:['Use the protected checker.'],
      researchContext:{scopeId,snapshotId:preSnapshotId,snapshotDigest:preSnapshotDigest},
      researchReferences:[reference(sharedSnapshotId,sharedSnapshotDigest)]},`intent-${randomUUID()}`);
    notes={...notes,researchContext:{scopeId,snapshotId:sharedSnapshotId,snapshotDigest:sharedSnapshotDigest},
      researchReferences:[reference(finalSnapshotId,finalSnapshotDigest),reference(corruptSnapshotId,corruptSnapshotDigest),
        reference(wrongScopeSnapshotId,wrongScopeSnapshotDigest),
        reference(crossProjectSnapshotId,crossProjectSnapshotDigest,crossScopeId)]};
  },30_000);

  afterAll(async()=>{await observer?.end();await pool?.end();if(admin){
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}});

  it('binds one exact package, records one decision, and preserves bounded replay semantics',async()=>{
    const current=await prepared(),key=`issue-${randomUUID()}`;
    await expect(current.admission.issueAgentAccess(contributor,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null},`self-${randomUUID()}`)).rejects.toMatchObject({code:'FORBIDDEN'});
    const issued=await current.admission.issueAgentAccess(reviewer,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null},key);expect(issued.token).toMatch(/^motive_review_/);expect(issued.access.status).toBe('READY');
    expect(await current.admission.issueAgentAccess(reviewer,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null},key)).toEqual(issued);
    await expect(current.admission.issueAgentAccess(reviewer,current.submissionId,{packageDigest:`sha256:${'f'.repeat(64)}`,
      expectedDecisionId:null},key)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.issueAgentAccess(reviewer,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null},`other-${randomUUID()}`)).rejects.toMatchObject({code:'CONFLICT'});
    const rotated=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive,sender:current.delivery,
      agentTokenSecret:`rotated-${'x'.repeat(48)}`});
    await expect(rotated.issueAgentAccess(reviewer,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null},key)).rejects.toMatchObject({code:'CONFLICT'});
    const accountView=await current.admission.getAgentAccess(reviewer,current.submissionId);
    expect(JSON.stringify(accountView)).not.toContain(issued.token);expect(accountView.access?.firstSeenAt).toBeNull();
    const agent=await current.admission.authenticateReviewAgent(issued.token);
    const assignment=await current.admission.reviewAgentAssignment(agent);
    expect(assignment).toMatchObject({accessId:issued.access.id,submissionId:current.submissionId,
      packageDigest:current.preview.packageDigest,expectedDecisionId:null});
    expect(assignment.researchSnapshots).toEqual([
      {scopeId,snapshotId:preSnapshotId,snapshotDigest:preSnapshotDigest,declaredIn:['PRE_TEST_INTENT'],
        href:`/api/review-agent/research-context/snapshots/${preSnapshotId}`},
      {scopeId,snapshotId:sharedSnapshotId,snapshotDigest:sharedSnapshotDigest,
        declaredIn:['PRE_TEST_INTENT','SUBMISSION_NOTES'],href:`/api/review-agent/research-context/snapshots/${sharedSnapshotId}`},
      {scopeId,snapshotId:finalSnapshotId,snapshotDigest:finalSnapshotDigest,declaredIn:['SUBMISSION_NOTES'],
        href:`/api/review-agent/research-context/snapshots/${finalSnapshotId}`},
      {scopeId,snapshotId:corruptSnapshotId,snapshotDigest:corruptSnapshotDigest,declaredIn:['SUBMISSION_NOTES'],
        href:`/api/review-agent/research-context/snapshots/${corruptSnapshotId}`},
      {scopeId,snapshotId:wrongScopeSnapshotId,snapshotDigest:wrongScopeSnapshotDigest,declaredIn:['SUBMISSION_NOTES'],
        href:`/api/review-agent/research-context/snapshots/${wrongScopeSnapshotId}`},
      {scopeId:crossScopeId,snapshotId:crossProjectSnapshotId,snapshotDigest:crossProjectSnapshotDigest,
        declaredIn:['SUBMISSION_NOTES'],href:`/api/review-agent/research-context/snapshots/${crossProjectSnapshotId}`},
    ]);
    const preSnapshot=await current.admission.reviewAgentSnapshot(agent,preSnapshotId);
    expect(preSnapshot).toMatchObject({format:'motive.research-context.v1',scopeId,snapshotId:preSnapshotId,
      snapshotDigest:preSnapshotDigest,retrievedAt:'2026-09-08T00:00:00.123Z',channelGoal:'Pre-test baseline.'});
    const sharedSnapshot=await current.admission.reviewAgentSnapshot(agent,sharedSnapshotId);
    expect(sharedSnapshot).toMatchObject({format:'motive.research-context.v1',scopeId,snapshotId:sharedSnapshotId,
      snapshotDigest:sharedSnapshotDigest,retrievedAt:'2026-09-08T00:00:01.234Z',channelGoal:'Shared baseline.'});
    const finalSnapshot=await current.admission.reviewAgentSnapshot(agent,finalSnapshotId);
    expect(finalSnapshot).toMatchObject({format:'motive.research-hypothesis-context.v1',scopeId,snapshotId:finalSnapshotId,
      snapshotDigest:finalSnapshotDigest,retrievedAt:'2026-09-08T00:00:02.345Z'});
    await expect(current.admission.reviewAgentSnapshot(agent,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(current.admission.reviewAgentSnapshot(agent,corruptSnapshotId)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.reviewAgentSnapshot(agent,wrongScopeSnapshotId)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.reviewAgentSnapshot(agent,crossProjectSnapshotId)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await current.admission.getAgentAccess(reviewer,current.submissionId)).access).toMatchObject({status:'READY'});
    expect((await current.admission.getAgentAccess(reviewer,current.submissionId)).access).toMatchObject({
      firstSeenAt:expect.any(String),lastSeenAt:expect.any(String)});
    const body={decision:'ADMIT' as const,rationale:'The independent reviewer agent admits this exact package as neutral research memory.'};
    await expect(current.admission.decideAdmissionFromAgent({...agent,reviewerActorId:owner},body,`spoof-${randomUUID()}`))
      .rejects.toMatchObject({code:'UNAUTHORIZED'});
    const [decided,replayedConcurrently]=await Promise.all([
      current.admission.decideAdmissionFromAgent(agent,body,`decide-${randomUUID()}`),
      current.admission.decideAdmissionFromAgent(agent,body,`decide-${randomUUID()}`),
    ]);
    expect(decided).toMatchObject({submissionId:current.submissionId,packageDigest:current.preview.packageDigest,decision:'ADMIT'});
    expect(replayedConcurrently).toEqual(decided);
    const consumedDecisionCount=await pool.query(`SELECT count(*)::int AS count
      FROM motive.hypothesis_submission_delivery_admission_decisions decision
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=decision.delivery_id
      WHERE delivery.source_submission_id=$1`,[current.submissionId]);
    expect(consumedDecisionCount.rows[0].count).toBe(1);
    expect(await current.admission.decideAdmissionFromAgent(agent,body,`retry-${randomUUID()}`)).toEqual(decided);
    await expect(current.admission.decideAdmissionFromAgent(agent,{...body,rationale:'Changed decision rationale.'},`retry-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});
    expect((await current.admission.getAgentAccess(reviewer,current.submissionId)).access).toMatchObject({status:'CONSUMED'});
    await expect(current.admission.reviewAgentAssignment(agent)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.reviewAgentSnapshot(agent,preSnapshotId)).rejects.toMatchObject({code:'CONFLICT'});

    const admitted=await current.admission.prepareAdmissionPreview(reviewer,current.submissionId);
    const correction=await current.admission.decideAdmission(reviewer,current.submissionId,{packageDigest:admitted.packageDigest,
      expectedDecisionId:admitted.latestDecision!.id,decision:'DECLINE',
      rationale:'A later independent review corrects the admission tail without changing the consumed agent record.'},`correction-${randomUUID()}`);
    expect(await current.admission.decideAdmissionFromAgent(agent,body,`retry-after-tail-${randomUUID()}`)).toEqual(decided);

    const corrected=await current.admission.prepareAdmissionPreview(reviewer,current.submissionId);
    const replacement=await current.admission.issueAgentAccess(reviewer,current.submissionId,{packageDigest:corrected.packageDigest,
      expectedDecisionId:correction.id},`replacement-${randomUUID()}`);
    expect(replacement.access.expectedDecisionId).toBe(correction.id);
    const replacementAgent=await current.admission.authenticateReviewAgent(replacement.token);
    const newer=await current.admission.decideAdmission(reviewer,current.submissionId,{packageDigest:corrected.packageDigest,
      expectedDecisionId:correction.id,decision:'ADMIT',
      rationale:'Another independent correction advances the authoritative review tail.'},`newer-${randomUUID()}`);
    expect(newer.previousDecisionId).toBe(correction.id);
    await expect(current.admission.reviewAgentAssignment(replacementAgent)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.reviewAgentSnapshot(replacementAgent,preSnapshotId)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(current.admission.decideAdmissionFromAgent(replacementAgent,{decision:'DECLINE',
      rationale:'A stale reviewer credential cannot append after the independently advanced tail.'},`stale-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});
    expect((await current.admission.getAgentAccess(reviewer,current.submissionId)).access).toMatchObject({status:'STALE'});
    expect(await current.admission.revokeAgentAccess(reviewer,current.submissionId,replacement.access.id,`revoke-${randomUUID()}`))
      .toMatchObject({access:{status:'REVOKED'}});
    await expect(current.admission.authenticateReviewAgent(replacement.token)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await expect(pool.query(`DELETE FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1`,[replacement.access.id]))
      .rejects.toMatchObject({code:'55000'});
    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);
    await expect(current.admission.authenticateReviewAgent(issued.token)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    await expect(current.admission.getAgentAccess(reviewer,current.submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});
    await pool.query(`UPDATE motive.memberships SET revoked_at=NULL WHERE project_id=$1 AND actor_id=$2`,[projectId,reviewer]);
    expect(engineCalls).toBe(0);
  },30_000);

  it('keeps an older source without a claim intent or citations reviewable',async()=>{
    const current=await legacyPrepared();
    const issued=await current.admission.issueAgentAccess(reviewer,current.submissionId,
      {packageDigest:current.preview.packageDigest,expectedDecisionId:null},`legacy-issue-${randomUUID()}`);
    const agent=await current.admission.authenticateReviewAgent(issued.token);
    const assignment=await current.admission.reviewAgentAssignment(agent);
    expect(assignment.researchSnapshots).toEqual([]);
    const body={decision:'ADMIT' as const,rationale:'This exact historical package remains useful without retained snapshot citations.'};
    const decided=await current.admission.decideAdmissionFromAgent(agent,body,`legacy-decision-${randomUUID()}`);
    expect(decided).toMatchObject({submissionId:current.submissionId,packageDigest:current.preview.packageDigest,decision:'ADMIT'});
    expect(await current.admission.decideAdmissionFromAgent(agent,body,`legacy-replay-${randomUUID()}`)).toEqual(decided);
    expect(engineCalls).toBe(0);
  },30_000);

  it('fails closed when one stored source cites a snapshot inconsistently',async()=>{
    const hypothesisId=randomUUID(),observedUpdatedAt='2026-09-08T00:00:00.000Z';
    const reference=(snapshotDigest:string)=>({scopeId,snapshotId:sharedSnapshotId,snapshotDigest,hypothesisId,
      observedUpdatedAt,evidenceIds:[]});
    const current=await legacyPrepared({format:'motive.investigation.v1',proposal:'Exercise duplicate citation validation.',
      expectation:'An inconsistent duplicate snapshot identity is rejected.',conditions:['Use one snapshot ID with two digests.'],
      observations:['The malformed historical source is retained only for this isolated test.'],
      assessment:'The reviewer credential must fail closed.',nextAction:'Reject assignment projection.',
      researchReferences:[reference(sharedSnapshotDigest),reference(`sha256:${'9'.repeat(64)}`)]});
    const issued=await current.admission.issueAgentAccess(reviewer,current.submissionId,
      {packageDigest:current.preview.packageDigest,expectedDecisionId:null},`conflict-issue-${randomUUID()}`);
    const agent=await current.admission.authenticateReviewAgent(issued.token);
    await expect(current.admission.reviewAgentAssignment(agent)).rejects.toMatchObject({code:'CONFLICT'});
    expect(engineCalls).toBe(0);
  },30_000);

  it('uses database expiry and serializes revocation ahead of a waiting decision without a pool-two deadlock',async()=>{
    const current=await prepared();const issued=await current.admission.issueAgentAccess(reviewer,current.submissionId,
      {packageDigest:current.preview.packageDigest,expectedDecisionId:null},`issue-${randomUUID()}`);
    const agent=await current.admission.authenticateReviewAgent(issued.token);const blocker=await pool.connect();
    let blockerOpen=false,blockerReleased=false;
    let revoke:ReturnType<typeof current.admission.revokeAgentAccess>|undefined;
    let attempted:ReturnType<typeof current.admission.decideAdmissionFromAgent>|undefined;
    const body={decision:'DECLINE' as const,rationale:'This exact package should remain outside shared research memory.'};
    try{
      await blocker.query('BEGIN');blockerOpen=true;
      await blocker.query(`SELECT id FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1 FOR UPDATE`,[issued.access.id]);
      revoke=current.admission.revokeAgentAccess(reviewer,current.submissionId,issued.access.id,`revoke-${randomUUID()}`);
      await waitForLock('hypothesis_submission_admission_agent_access');
      attempted=current.admission.decideAdmissionFromAgent(agent,body,`decide-${randomUUID()}`);
      await blocker.query('COMMIT');blockerOpen=false;blocker.release();blockerReleased=true;
      await expect(revoke).resolves.toMatchObject({access:{status:'REVOKED'}});
      await expect(attempted).rejects.toMatchObject({code:'UNAUTHORIZED'});
    }finally{
      if(blockerOpen)await blocker.query('ROLLBACK').catch(()=>undefined);
      if(!blockerReleased)blocker.release();
      const pending:Promise<unknown>[]=[];if(revoke)pending.push(revoke);if(attempted)pending.push(attempted);
      await Promise.allSettled(pending);
    }
    const decisions=await pool.query(`SELECT count(*)::int AS count FROM motive.hypothesis_submission_delivery_admission_decisions decision
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=decision.delivery_id WHERE delivery.source_submission_id=$1`,[current.submissionId]);
    expect(decisions.rows[0].count).toBe(0);

    const copied=(await pool.query(`SELECT * FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1`,[issued.access.id])).rows[0];
    const expiredId=randomUUID(),raw=`motive_review_${expiredId.replaceAll('-','')}_${'A'.repeat(43)}`;
    const expiredDigest=`sha256:${createHash('sha256').update(raw).digest('hex')}`;
    await pool.query(`INSERT INTO motive.hypothesis_submission_admission_agent_access
      (id,project_id,submission_id,delivery_id,reviewer_actor_id,review_package,review_package_digest,expected_decision_id,
       token_digest,token_hint,issuance_idempotency_key,issuance_request_digest,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '5 milliseconds')`,
    [expiredId,copied.project_id,copied.submission_id,copied.delivery_id,copied.reviewer_actor_id,JSON.stringify(copied.review_package),
      copied.review_package_digest,copied.expected_decision_id,expiredDigest,expiredDigest.slice(-12),`expired-${randomUUID()}`,
      `sha256:${'d'.repeat(64)}`]);
    await pool.query(`SELECT pg_sleep(0.02)`);
    await expect(current.admission.authenticateReviewAgent(raw)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    const expiredContext={...agent,accessId:expiredId,tokenDigest:expiredDigest};
    await expect(current.admission.decideAdmissionFromAgent(expiredContext,body,`expired-${randomUUID()}`))
      .rejects.toMatchObject({code:'UNAUTHORIZED'});
    const direct=await current.admission.decideAdmission(reviewer,current.submissionId,{packageDigest:current.preview.packageDigest,
      expectedDecisionId:null,decision:'DECLINE',rationale:'A direct reviewer records the retained expiry guard fixture.'},`direct-${randomUUID()}`);
    await expect(pool.query(`UPDATE motive.hypothesis_submission_admission_agent_access
      SET consumed_decision_id=$2,consumed_idempotency_key=$3,consumed_request_digest=$4,consumed_at=clock_timestamp()
      WHERE id=$1`,[expiredId,direct.id,`late-${randomUUID()}`,`sha256:${'e'.repeat(64)}`])).rejects.toMatchObject({code:'42501'});
    expect(engineCalls).toBe(0);
  },30_000);
});
