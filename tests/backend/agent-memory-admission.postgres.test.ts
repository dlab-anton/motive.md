import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService,type ParticipationAgentContext,type ParticipationService } from '../../server/participation/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import { createHypothesisSubmissionAdmissionService } from '../../server/research-memory/submission-admission.ts';
import { createHypothesisSubmissionDeliveryService } from '../../server/research-memory/submission-delivery.ts';
import { createProjectResearchDeliveryPolicyService } from '../../server/research-memory/delivery-policy.ts';
import { LEGACY_REVIEWED_WRITEBACK_CONTRACT,PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../../server/research-memory/pinned-writeback-contract.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import type { SubmissionMotiveReference,SubmissionResearchReference } from '../../src/lib/participation.ts';
import type { ResearchDeliveryTargetSelection } from '../../src/lib/research-delivery-target.ts';
import { resolveResearchDeliveryTarget } from '../../server/research-memory/research-delivery-target.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('automatic memory admission on isolated PostgreSQL',()=>{
  const databaseName=`agent_memory_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:${randomUUID()}`,owner=`account:${randomUUID()}`,
    sourceOwner=`account:${randomUUID()}`,reviewerOwner=`account:${randomUUID()}`;
  const active=new Set([owner,sourceOwner,reviewerOwner]);const vaultKey=Buffer.alloc(32,19);
  let admin:Pool,pool:Pool,participation:ParticipationService,workOrderId:string;
  let finding:ReturnType<typeof createFindingAssessmentService>;
  let sourceContext:ParticipationAgentContext,reviewerContext:ParticipationAgentContext,projectId:string,scopeId:string;
  let researchTarget:ResearchDeliveryTargetSelection,channelId:string;
  let witness:string;
  const memoryAttempts:string[]=[];

  async function evidence(context:ParticipationAgentContext,options:{target?:{submissionId:string;reportDigest:string;artifactDigest:string};
    postCheck?:boolean;reproducibility?:boolean;researchDeliveryTarget?:ResearchDeliveryTargetSelection}){
    const claim=await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);
    if(claim.leaseEpoch===null)throw new Error('claim lease missing');
    const motiveReferences:SubmissionMotiveReference[]|undefined=options.target?[{submissionId:options.target.submissionId,
      reportDigest:options.target.reportDigest,artifactDigest:options.target.artifactDigest}]:undefined;
    const experimentProtocol:ExperimentProtocol|undefined=options.target?{format:'motive.experiment-protocol.v1',
      procedure:'circle-packing/automatic-finding-review-fixture-v1',purpose:'REPLICATION',
      inputs:[{name:'review_target_submission_id',value:options.target.submissionId}]}:undefined;
    const proposal=options.target?'Replicate the exact pinned finding.':'Produce one bounded source finding.';
    const expectation='Retain immutable checked evidence.';const conditions=['Use the exact declared fixture.'];
    const researchReferences:SubmissionResearchReference[]|undefined=options.researchDeliveryTarget?[{
      scopeId:options.researchDeliveryTarget.scopeId,snapshotId:options.researchDeliveryTarget.snapshotId,
      snapshotDigest:options.researchDeliveryTarget.snapshotDigest,hypothesisId:options.researchDeliveryTarget.hypothesisId,
      observedUpdatedAt:options.researchDeliveryTarget.observedUpdatedAt,evidenceIds:[]}]:undefined;
    await participation.declareAssignmentIntent(context,workOrderId,{leaseEpoch:claim.leaseEpoch,proposal,expectation,conditions,
      ...(motiveReferences?{motiveReferences}:{}),...(experimentProtocol?{experimentProtocol}:{}),
      ...(researchReferences?{researchReferences,researchDeliveryTarget:options.researchDeliveryTarget}:{})},`intent-${randomUUID()}`);
    const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch:claim.leaseEpoch,witness,
      investigation:{format:'motive.investigation.v1',proposal,expectation,conditions,
        observations:['The protected checker retained an exact report.'],assessment:'This evidence is bounded to the fixture.',
        nextAction:'Use only the declared evidence.',...(motiveReferences?{motiveReferences}:{}),
        ...(experimentProtocol?{experimentProtocol}:{}),
        ...(researchReferences?{researchReferences,researchDeliveryTarget:options.researchDeliveryTarget}:{})}},`submit-${randomUUID()}`);
    const artifact=(await pool.query(`SELECT report_digest,witness_digest FROM motive.participation_submission_artifacts
      WHERE submission_id=$1`,[submission.id])).rows[0];
    if(options.postCheck!==false)await participation.createPostCheckAssessment(context,submission.id,
      {reportDigest:String(artifact.report_digest),assessment:'The exact report matches this fixture.',
        nextAction:'Assess the bounded result.'},`post-${randomUUID()}`);
    if(options.reproducibility!==false)await participation.createSubmissionReproducibility(context,submission.id,
      {reportDigest:String(artifact.report_digest),solverSource:'deterministic fixture source',trialResults:'deterministic fixture result'},
      `repro-${randomUUID()}`);
    await participation.completeAssignment(context,workOrderId,{leaseEpoch:claim.leaseEpoch,submissionId:submission.id},
      `complete-${randomUUID()}`);
    return{submissionId:submission.id,reportDigest:String(artifact.report_digest),artifactDigest:String(artifact.witness_digest)};
  }

  beforeAll(async()=>{
    const sourceUrl=new URL(baseUrl!);expect(['127.0.0.1','localhost']).toContain(sourceUrl.hostname);
    const adminUrl=new URL(sourceUrl);adminUrl.pathname='/postgres';admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);const isolated=new URL(sourceUrl);isolated.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:isolated.toString(),max:8});await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Agent memory admission fixture'}})).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp()),
      ($5,'supabase',$6,'ACTIVE',clock_timestamp())`,
    [owner,owner.slice(8),sourceOwner,sourceOwner.slice(8),reviewerOwner,reviewerOwner.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'OWNER',ARRAY['project:admin'],$4)`,[randomUUID(),projectId,owner,issuer]);
    participation=createParticipationService(pool,{tokenSecret:`agent-finding-${'s'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:actor=>active.has(actor),validateResearchReferences:async()=>undefined,resolveResearchDeliveryTarget});
    workOrderId=(await participation.ensureCircleWorkOrder()).id;
    finding=createFindingAssessmentService({pool,isActorActive:actor=>active.has(actor),
      admitAgentFinding:async(context,id)=>{
        // A separate pool query must observe the committed finding before memory
        // preparation starts. A temporary memory failure cannot roll it back.
        expect((await pool.query('SELECT reviewer_agent_token_id FROM motive.finding_review_decisions WHERE id=$1',[id])).rows)
          .toEqual([{reviewer_agent_token_id:context.tokenId}]);
        memoryAttempts.push(id);
        if(memoryAttempts.length===1)throw new Error('Temporary memory fixture failure');
        return{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'};
      }});
    const sourceJoin=await participation.join(sourceOwner,'Source account',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const reviewerJoin=await participation.join(reviewerOwner,'Reviewer account',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    sourceContext=await participation.authenticateBearer(sourceJoin.token);
    reviewerContext=await participation.authenticateBearer(reviewerJoin.token);
    scopeId=randomUUID();channelId=randomUUID();await pool.query(`INSERT INTO motive.project_research_scopes
      (id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,channel_snapshot,channel_snapshot_digest,
       encrypted_api_key,credential_fingerprint,configuration_digest,api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','https://engine.invalid/api/v1',$3,$4,'memory-test','{}',$5,$6,$7,$8,'1.8.0',$9,'CONNECTED',$10,clock_timestamp())`,
    [scopeId,projectId,randomUUID(),channelId,`sha256:${'a'.repeat(64)}`,
      encryptSecret(vaultKey,'unused-test-key',`research-scope:v1:${scopeId}:${projectId}`),
      `sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'7'.repeat(40),owner]);
    const snapshotId=randomUUID(),hypothesisId=randomUUID(),observedUpdatedAt='2026-09-13T10:00:00.000Z';
    const snapshotPayload={format:'motive.research-context.v1',hypotheses:[{id:hypothesisId,updatedAt:observedUpdatedAt,
      contentDigest:`sha256:${'d'.repeat(64)}`,statement:'A retained thread selected before the experiment.',evidence:[]}]};
    const snapshotDigest=digestCanonicalJson(snapshotPayload);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',clock_timestamp())`,[snapshotId,scopeId,projectId,snapshotDigest,JSON.stringify(snapshotPayload)]);
    researchTarget={mode:'APPEND_EXISTING',scopeId,snapshotId,snapshotDigest,hypothesisId,observedUpdatedAt};
    witness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');
  },30000);

  afterAll(async()=>{await pool?.end();if(admin){try{await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);}finally{await admin.end();}}});

  it('requires current policy and exact current proof, admits once without engine I/O, and makes revised proof stale',async()=>{
    const source=await evidence(sourceContext,{});const secondSource=await evidence(sourceContext,{});
    const review=await evidence(reviewerContext,{target:source});
    const preview=await finding.previewFromAgent(reviewerContext,review.submissionId,source.submissionId);
    expect(preview).toMatchObject({submissionId:source.submissionId,reviewSubmissionId:review.submissionId,
      reviewerAgentTokenId:reviewerContext.tokenId,reviewDecision:null,package:{format:'motive.finding-review-package/0.2'}});
    const input={packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT' as const,
      outcome:'SUPPORTED' as const,finding:'The exact replication supports this bounded finding.',
      limitations:'One pinned completed replication.',novelty:'DISTINCT' as const,duplicateOfSubmissionId:null,
      rationale:'The ordinary contributor credential completed the exact pinned replication.'};

    const missingPost=await evidence(reviewerContext,{target:source,postCheck:false,reproducibility:false});
    await expect(finding.previewFromAgent(reviewerContext,missingPost.submissionId,source.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    const sameOwner=await evidence(sourceContext,{target:source});
    await expect(finding.previewFromAgent(sourceContext,sameOwner.submissionId,source.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    const replacementReviewerJoin=await participation.join(reviewerOwner,'Reviewer account',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const replacementReviewerContext=await participation.authenticateBearer(replacementReviewerJoin.token);
    await expect(finding.previewFromAgent(replacementReviewerContext,review.submissionId,source.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(finding.previewFromAgent(reviewerContext,review.submissionId,secondSource.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});

    await pool.query(`UPDATE motive.memberships SET role='REVIEWER'
      WHERE project_id=$1 AND actor_id=$2`,[reviewerContext.projectId,reviewerOwner]);
    await expect(pool.query(`INSERT INTO motive.finding_review_decisions
      (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
       finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,
       reviewer_agent_token_id,review_submission_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4::jsonb,$5,NULL,'DECLINE',NULL,NULL,NULL,NULL,NULL,NULL,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(),reviewerContext.projectId,source.submissionId,JSON.stringify(preview.package),preview.packageDigest,
      reviewerOwner,reviewerContext.tokenId,missingPost.submissionId,'Direct invalid proof',`direct-${randomUUID()}`,
      `sha256:${'a'.repeat(64)}`])).rejects.toMatchObject({code:'42501'});
    await pool.query(`UPDATE motive.memberships SET role='CONTRIBUTOR'
      WHERE project_id=$1 AND actor_id=$2`,[reviewerContext.projectId,reviewerOwner]);

    const key=`agent-review-${randomUUID()}`;const saved=await finding.decideFromAgent(
      reviewerContext,review.submissionId,source.submissionId,input,key);
    expect(saved).toMatchObject({replayed:false,reviewerAgentTokenId:reviewerContext.tokenId,
      reviewSubmissionId:review.submissionId,decision:'ACCEPT',
      memoryAdmission:{status:'PENDING',reason:'MEMORY_UNAVAILABLE'}});
    expect(await finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,input,key))
      .toMatchObject({id:saved.id,replayed:true,memoryAdmission:{status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'}});
    expect(memoryAttempts).toEqual([saved.id,saved.id]);
    await expect(finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,input,
      `second-decision-${randomUUID()}`)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,
      {...input,finding:'Tampered replay.'},key)).rejects.toMatchObject({code:'CONFLICT'});
    const after=await finding.previewFromAgent(reviewerContext,review.submissionId,source.submissionId);
    expect(after.reviewDecision).toMatchObject({id:saved.id,reviewSubmissionId:review.submissionId});

    const engineCalls:string[]=[];
    const memory=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),
      fetch:async input=>{engineCalls.push(String(input));throw new Error('Automatic preparation must not call the engine.');}});
    expect(await memory.admitFromAgentFinding(reviewerContext,saved.id))
      .toEqual({status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'});
    const beforePolicy=await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.hypothesis_writeback_intents) intents,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_deliveries) deliveries,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_admission_decisions) admissions`);
    expect(beforePolicy.rows[0]).toEqual({intents:0,deliveries:0,admissions:0});

    const policies=createProjectResearchDeliveryPolicyService({pool,vaultKey,isActorActive:actor=>active.has(actor)});
    const legacyPolicy=await policies.approve(owner,{projectSlug:'circle-packing',scopeId,workOrderId,
      idempotencyKey:`legacy-memory-policy-${randomUUID()}`,approvedApiBaseUrl:'https://engine.invalid/api/v1',
      contract:LEGACY_REVIEWED_WRITEBACK_CONTRACT},true);
    expect(legacyPolicy.status).toBe('ACTIVE');
    const directSource=await evidence(sourceContext,{});
    const directSender=createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive:actor=>active.has(actor),
      fetch:async input=>{engineCalls.push(String(input));throw new Error('Direct preparation must not call the engine.');}});
    const directDelivery=await directSender.sync(owner,{projectSlug:'circle-packing',scopeId,
      submissionId:directSource.submissionId,idempotencyKey:`direct-owner-delivery-${randomUUID()}`,
      approvedApiBaseUrl:'https://engine.invalid/api/v1',contract:LEGACY_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    expect(directDelivery).toMatchObject({status:'PENDING',reason:'EXECUTION_NOT_REQUESTED'});
    const directReview=await evidence(reviewerContext,{target:directSource});
    const directPreview=await finding.previewFromAgent(reviewerContext,directReview.submissionId,directSource.submissionId);
    const directFinding=await finding.decideFromAgent(reviewerContext,directReview.submissionId,directSource.submissionId,
      {...input,packageDigest:directPreview.packageDigest},`direct-owner-finding-${randomUUID()}`);
    expect(await memory.admitFromAgentFinding(reviewerContext,directFinding.id))
      .toEqual({status:'PENDING',reason:'OWNER_APPROVAL_REQUIRED'});
    expect((await pool.query(`SELECT count(*)::integer count FROM motive.hypothesis_submission_delivery_admission_decisions
      WHERE delivery_id=$1`,[directDelivery.deliveryId])).rows[0].count).toBe(0);
    expect(engineCalls).toEqual([]);
    expect(await memory.admitFromAgentFinding(reviewerContext,saved.id))
      .toEqual({status:'PENDING',reason:'CONTRACT_UNAVAILABLE'});
    expect((await pool.query(`SELECT count(*)::integer count FROM motive.hypothesis_submission_deliveries
      WHERE source_submission_id=$1`,[source.submissionId])).rows[0].count).toBe(0);
    const policy=await policies.approve(owner,{projectSlug:'circle-packing',scopeId,workOrderId,
      idempotencyKey:`memory-policy-${randomUUID()}`,approvedApiBaseUrl:'https://engine.invalid/api/v1',
      contract:PINNED_REVIEWED_WRITEBACK_CONTRACT},true);
    expect(policy.status).toBe('ACTIVE');
    const admitted=await memory.admitFromAgentFinding(reviewerContext,saved.id);
    expect(admitted).toMatchObject({status:'ADMITTED'});
    expect(await memory.admitFromAgentFinding(reviewerContext,saved.id)).toEqual(admitted);
    expect(engineCalls).toEqual([]);
    const retained=await pool.query(`SELECT decision,reviewer_actor_id,finding_decision_id,
        (SELECT count(*)::integer FROM motive.project_research_delivery_policies) policies,
        (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_admission_decisions
          WHERE finding_decision_id=$1) admissions
      FROM motive.hypothesis_submission_delivery_admission_decisions WHERE id=$2`,
    [saved.id,admitted.status==='ADMITTED'?admitted.admissionDecisionId:null]);
    expect(retained.rows[0]).toMatchObject({decision:'ADMIT',reviewer_actor_id:reviewerOwner,
      finding_decision_id:saved.id,policies:2,admissions:1});
    expect((await memory.publicAdmission('circle-packing',source.submissionId)).status).toBe('ADMITTED');
    await expect(memory.admitFromAgentFinding(sourceContext,saved.id)).rejects.toMatchObject({code:'FORBIDDEN'});

    const legacySource=await evidence(sourceContext,{});
    const legacySender=createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive:actor=>active.has(actor),
      fetch:async input=>{engineCalls.push(String(input));throw new Error('Automatic preparation must not call the engine.');}});
    const legacyDelivery=await legacySender.syncWithPolicyPrincipal(legacyPolicy.id,{projectSlug:'circle-packing',scopeId,
      submissionId:legacySource.submissionId,idempotencyKey:`legacy-delivery-${randomUUID()}`,
      approvedApiBaseUrl:'https://engine.invalid/api/v1',contract:LEGACY_REVIEWED_WRITEBACK_CONTRACT,execute:false});
    const legacyReview=await evidence(reviewerContext,{target:legacySource});
    const legacyPreview=await finding.previewFromAgent(reviewerContext,legacyReview.submissionId,legacySource.submissionId);
    const legacyFinding=await finding.decideFromAgent(reviewerContext,legacyReview.submissionId,legacySource.submissionId,
      {...input,packageDigest:legacyPreview.packageDigest},`legacy-finding-${randomUUID()}`);
    expect(await memory.admitFromAgentFinding(reviewerContext,legacyFinding.id)).toMatchObject({status:'ADMITTED'});
    const legacyPackage=await legacySender.reviewPackage(legacyDelivery.deliveryId!);
    expect(legacyPackage.contract.contractVersion).toBe('hypothesis-http-writeback-capabilities/2');
    expect(legacyPackage.operations.neutralEvidence.body).not.toHaveProperty('expected_channel_id');
    expect(engineCalls).toEqual([]);

    const declineReview=await evidence(reviewerContext,{target:secondSource});
    const declinePreview=await finding.previewFromAgent(reviewerContext,declineReview.submissionId,secondSource.submissionId);
    const declined=await finding.decideFromAgent(reviewerContext,declineReview.submissionId,secondSource.submissionId,
      {packageDigest:declinePreview.packageDigest,expectedDecisionId:null,decision:'DECLINE',outcome:null,finding:null,
        limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'The exact replication does not warrant a retained finding.'},
      `decline-memory-${randomUUID()}`);
    expect(await memory.admitFromAgentFinding(reviewerContext,declined.id))
      .toEqual({status:'NOT_REQUESTED',reason:'FINDING_DECLINED'});
    expect(Number((await pool.query(`SELECT count(*) AS count FROM motive.hypothesis_submission_delivery_admission_decisions`))
      .rows[0].count)).toBe(2);

    const correction=await finding.preview(owner,source.submissionId);
    await finding.decide(owner,source.submissionId,{packageDigest:correction.packageDigest,
      expectedDecisionId:correction.latestDecision!.id,decision:'DECLINE',outcome:null,finding:null,limitations:null,
      novelty:null,duplicateOfSubmissionId:null,rationale:'The accepted finding was revised after the automatic retention decision.'},
    `revise-memory-${randomUUID()}`);
    expect(await memory.admitFromAgentFinding(reviewerContext,saved.id))
      .toEqual({status:'PENDING',reason:'REVIEW_NO_LONGER_CURRENT'});
    expect((await memory.publicAdmission('circle-packing',source.submissionId)).status).toBe('STALE');

    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1`,
      [reviewerContext.tokenId]);
    expect((await memory.publicAdmission('circle-packing',source.submissionId)).status).toBe('STALE');
    await expect(memory.admitFromAgentFinding(reviewerContext,saved.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(finding.previewFromAgent(reviewerContext,review.submissionId,source.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,input,key))
      .rejects.toMatchObject({code:'FORBIDDEN'});
  },60000);

  it('reviews, admits, appends, blocks a 409 checkpoint, and recovers the same immutable operation',async()=>{
    const citationClaim=await participation.claimAssignment(sourceContext,workOrderId,`citation-claim-${randomUUID()}`);
    const citation={scopeId:researchTarget.scopeId,snapshotId:researchTarget.snapshotId,snapshotDigest:researchTarget.snapshotDigest,
      hypothesisId:researchTarget.hypothesisId,observedUpdatedAt:researchTarget.observedUpdatedAt,evidenceIds:[]};
    await participation.declareAssignmentIntent(sourceContext,workOrderId,{leaseEpoch:citationClaim.leaseEpoch!,
      proposal:'Cite a thread without selecting it for delivery.',expectation:'This remains a new-draft intent.',
      conditions:['A citation grants no append authority.'],researchReferences:[citation]},`citation-intent-${randomUUID()}`);
    const oldIntent=(await pool.query(`SELECT request_digest,created_at FROM motive.participation_claim_intents WHERE claim_id=$1`,
      [citationClaim.claimId])).rows[0];const resolverClient=await pool.connect();let binding;
    try{binding=await resolveResearchDeliveryTarget(projectId,researchTarget,resolverClient);}finally{resolverClient.release();}
    await expect(pool.query(`INSERT INTO motive.participation_claim_research_targets
      (claim_id,project_id,binding,binding_digest,intent_request_digest,declared_at) VALUES($1,$2,$3::jsonb,$4,$5,$6)`,
    [citationClaim.claimId,projectId,JSON.stringify(binding),digestCanonicalJson(binding),oldIntent.request_digest,oldIntent.created_at]))
      .rejects.toMatchObject({code:'23514'});
    await participation.releaseAssignment(sourceContext,workOrderId,{leaseEpoch:citationClaim.leaseEpoch!},`citation-release-${randomUUID()}`);
    const renewed=await participation.join(reviewerOwner,'Reviewer account',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`renew-${randomUUID()}`);
    reviewerContext=await participation.authenticateBearer(renewed.token);
    const source=await evidence(sourceContext,{researchDeliveryTarget:researchTarget});
    const review=await evidence(reviewerContext,{target:source,researchDeliveryTarget:researchTarget});
    const preview=await finding.previewFromAgent(reviewerContext,review.submissionId,source.submissionId);
    expect(preview.package).toMatchObject({format:'motive.finding-review-package/0.3',source:{target:{selection:researchTarget,channelId}}});
    const downgraded=structuredClone(preview.package) as Record<string,any>;downgraded.format='motive.finding-review-package/0.2';
    delete downgraded.source.target;const downgradedDigest=digestCanonicalJson(downgraded);
    await expect(pool.query(`INSERT INTO motive.finding_review_decisions
      (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
       finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4::jsonb,$5,NULL,'DECLINE',NULL,NULL,NULL,NULL,NULL,NULL,$6,$7,$8,$9)`,
    [randomUUID(),projectId,source.submissionId,JSON.stringify(downgraded),downgradedDigest,owner,
      'A targeted finding cannot be downgraded.',`downgrade-${randomUUID()}`,`sha256:${'9'.repeat(64)}`]))
      .rejects.toMatchObject({code:'23514'});
    const saved=await finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,{
      packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT',outcome:'INCONCLUSIVE',
      finding:'The bounded experiment retained a useful neutral update.',limitations:'One exact replication.',novelty:'DISTINCT',
      duplicateOfSubmissionId:null,rationale:'The exact target-bound replication completed independently.'},`target-finding-${randomUUID()}`);
    let calls=0;let retainedBody='';let retainedKey='';const evidenceId=randomUUID();
    const fetcher:typeof fetch=async(input,init)=>{calls+=1;const body=String(init?.body),key=new Headers(init?.headers).get('Idempotency-Key')!;
      if(calls===1){retainedBody=body;retainedKey=key;return new Response('{}',{status:409});}
      expect(body).toBe(retainedBody);expect(key).toBe(retainedKey);const parsed=JSON.parse(body);
      return new Response(JSON.stringify({evidence:{id:evidenceId,hypothesis_id:researchTarget.hypothesisId,content:parsed.content,
        source:parsed.source,evidence_type:'neutral',strength:null,confidence_after:0.7,created_by:parsed.created_by,
        created_at:'2026-09-13T11:00:00.000Z'},hypothesis:{id:researchTarget.hypothesisId,status:'active',confidence:0.7,
        initial_confidence:0.4,outcome:{result:'unchanged'}}}),{status:201,headers:{'content-type':'application/json'}});};
    const policies=createProjectResearchDeliveryPolicyService({pool,vaultKey,isActorActive:actor=>active.has(actor),fetch:fetcher});
    const policy=await policies.approve(owner,{projectSlug:'circle-packing',scopeId,workOrderId,
      idempotencyKey:`append-policy-${randomUUID()}`,approvedApiBaseUrl:'https://engine.invalid/api/v1',
      contract:PINNED_REVIEWED_WRITEBACK_CONTRACT,deliveryMode:'APPEND_EXISTING'},true);
    const memory=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:actor=>active.has(actor),fetch:fetcher});
    const admitted=await memory.admitFromAgentFinding(reviewerContext,saved.id);expect(admitted).toMatchObject({status:'ADMITTED'});
    const checkpoint=await policies.pendingDelivery(sourceContext,source.submissionId);
    expect(checkpoint).toMatchObject({status:'READY',mode:'APPEND_EXISTING',policyId:policy.id,target:{selection:researchTarget}});
    const first=await policies.syncFromAgent(sourceContext,source.submissionId,{policyId:policy.id,reportDigest:source.reportDigest},
      `append-sync-${randomUUID()}`);
    expect(first).toMatchObject({status:'PENDING',pendingOperation:'NEUTRAL_EVIDENCE',reason:'TARGET_PRECONDITION_CONFLICT',
      hypothesisId:researchTarget.hypothesisId});expect(calls).toBe(1);
    expect(await policies.nextReadyDelivery(sourceContext)).toBeNull();
    const completed=await policies.syncFromAgent(sourceContext,source.submissionId,{policyId:policy.id,reportDigest:source.reportDigest},
      `append-retry-${randomUUID()}`);
    expect(completed).toMatchObject({status:'EVIDENCE_RECORDED',hypothesisId:researchTarget.hypothesisId,evidenceId});
    expect(calls).toBe(2);
    const sender=createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive:actor=>active.has(actor),fetch:fetcher});
    const reviewed=await sender.reviewPackage(completed.deliveryId!);
    expect(reviewed).toMatchObject({format:'motive.research-delivery-review-package/0.2',
      delivery:{mode:'APPEND_EXISTING',target:{selection:researchTarget}},operations:{neutralEvidence:{body:{expected_channel_id:channelId}}}});
    expect(reviewed.operations).not.toHaveProperty('draft');
    const manifest=await sender.publicObservationManifest('circle-packing',completed.deliveryId!);
    expect(manifest.digest).toBe(`sha256:${(await import('node:crypto')).createHash('sha256').update(manifest.bytes).digest('hex')}`);
    expect(manifest.bytes.toString('utf8')).not.toContain('unused-test-key');
    expect(manifest.bytes.toString('utf8')).not.toContain(sourceOwner);expect(manifest.bytes.toString('utf8')).not.toContain(reviewerOwner);
    const contributions=await sender.confirmedEvidenceContributions(projectId,scopeId,[{hypothesisId:researchTarget.hypothesisId,evidenceId}]);
    expect(contributions.get(evidenceId)).toMatchObject({deliveryId:completed.deliveryId,sourceSubmissionId:source.submissionId,
      evidenceBinding:{hypothesisId:researchTarget.hypothesisId,evidenceId,source:expect.stringContaining('/observation'),
        contentDigest:expect.stringMatching(/^sha256:/)},labels:{evidence:'NEUTRAL',context:'HISTORICAL_TESTED_CONTEXT'}});
    expect(await sender.confirmedEvidenceContributions(projectId,scopeId,[{hypothesisId:randomUUID(),evidenceId}])).toEqual(new Map());
  },60000);
});
