import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService,type ParticipationAgentContext,type ParticipationService } from '../../server/participation/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import type { SubmissionMotiveReference } from '../../src/lib/participation.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('ordinary agent replication finding review on isolated PostgreSQL',()=>{
  const databaseName=`agent_finding_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:${randomUUID()}`,sourceOwner=`account:${randomUUID()}`,reviewerOwner=`account:${randomUUID()}`;
  const active=new Set([sourceOwner,reviewerOwner]);
  let admin:Pool,pool:Pool,participation:ParticipationService,workOrderId:string;
  let finding:ReturnType<typeof createFindingAssessmentService>;
  let sourceContext:ParticipationAgentContext,reviewerContext:ParticipationAgentContext;
  let witness:string;
  const memoryAttempts:string[]=[];

  async function evidence(context:ParticipationAgentContext,options:{target?:{submissionId:string;reportDigest:string;artifactDigest:string};
    postCheck?:boolean;reproducibility?:boolean}){
    const claim=await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);
    if(claim.leaseEpoch===null)throw new Error('claim lease missing');
    const motiveReferences:SubmissionMotiveReference[]|undefined=options.target?[{submissionId:options.target.submissionId,
      reportDigest:options.target.reportDigest,artifactDigest:options.target.artifactDigest}]:undefined;
    const experimentProtocol:ExperimentProtocol|undefined=options.target?{format:'motive.experiment-protocol.v1',
      procedure:'circle-packing/automatic-finding-review-fixture-v1',purpose:'REPLICATION',
      inputs:[{name:'review_target_submission_id',value:options.target.submissionId}]}:undefined;
    const proposal=options.target?'Replicate the exact pinned finding.':'Produce one bounded source finding.';
    const expectation='Retain immutable checked evidence.';const conditions=['Use the exact declared fixture.'];
    await participation.declareAssignmentIntent(context,workOrderId,{leaseEpoch:claim.leaseEpoch,proposal,expectation,conditions,
      ...(motiveReferences?{motiveReferences}:{}),...(experimentProtocol?{experimentProtocol}:{})},`intent-${randomUUID()}`);
    const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch:claim.leaseEpoch,witness,
      investigation:{format:'motive.investigation.v1',proposal,expectation,conditions,
        observations:['The protected checker retained an exact report.'],assessment:'This evidence is bounded to the fixture.',
        nextAction:'Use only the declared evidence.',...(motiveReferences?{motiveReferences}:{}),
        ...(experimentProtocol?{experimentProtocol}:{})}},`submit-${randomUUID()}`);
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
    await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Agent finding review fixture'}});
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [sourceOwner,sourceOwner.slice(8),reviewerOwner,reviewerOwner.slice(8)]);
    participation=createParticipationService(pool,{tokenSecret:`agent-finding-${'s'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:actor=>active.has(actor)});workOrderId=(await participation.ensureCircleWorkOrder()).id;
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
    witness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');
  },30000);

  afterAll(async()=>{await pool?.end();if(admin){try{await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);}finally{await admin.end();}}});

  it('binds one automatic decision to exact current replication proof and rejects authority substitutions',async()=>{
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

    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1`,
      [reviewerContext.tokenId]);
    await expect(finding.previewFromAgent(reviewerContext,review.submissionId,source.submissionId))
      .rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(finding.decideFromAgent(reviewerContext,review.submissionId,source.submissionId,input,key))
      .rejects.toMatchObject({code:'FORBIDDEN'});
  },60000);
});
