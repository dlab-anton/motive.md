import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { canonicalJson,digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService,type ParticipationService } from '../../server/participation/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import type { FindingReviewPackageV2 } from '../../src/lib/finding-assessment.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('Motive-native finding review on isolated PostgreSQL',()=>{
  const databaseName=`motive_native_finding_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:${randomUUID()}`,owner=`account:${randomUUID()}`,reviewer=`account:${randomUUID()}`;
  const active=new Set([owner,reviewer]);
  let admin:Pool,pool:Pool,participation:ParticipationService,projectId:string,workOrderId:string;
  let finding:ReturnType<typeof createFindingAssessmentService>;
  let source:{submissionId:string;contributor:string};

  beforeAll(async()=>{
    const sourceUrl=new URL(baseUrl!);expect(['postgres:','postgresql:']).toContain(sourceUrl.protocol);
    expect(['127.0.0.1','localhost']).toContain(sourceUrl.hostname);expect(sourceUrl.search).toBe('');expect(sourceUrl.hash).toBe('');
    const adminUrl=new URL(sourceUrl);adminUrl.pathname='/postgres';admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);const isolated=new URL(sourceUrl);isolated.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:isolated.toString(),max:8});await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Motive-native finding review'}})).id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [owner,owner.slice(8),reviewer,reviewer.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$5),($4,$2,$6,'REVIEWER',ARRAY['project:review'],$5)`,
    [randomUUID(),projectId,owner,randomUUID(),issuer,reviewer]);
    participation=createParticipationService(pool,{tokenSecret:`native-finding-${'s'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:actorId=>active.has(actorId)});
    workOrderId=(await participation.ensureCircleWorkOrder()).id;
    finding=createFindingAssessmentService({pool,isActorActive:actorId=>active.has(actorId)});

    const contributor=`account:${randomUUID()}`;active.add(contributor);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[contributor,contributor.slice(8)]);
    const joined=await participation.join(contributor,'Native evidence contributor',
      {projectSlug:'circle-packing',publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context=await participation.authenticateBearer(joined.token);
    const claim=await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);
    if(claim.leaseEpoch===null)throw new Error('claim lease missing');
    await participation.declareAssignmentIntent(context,workOrderId,{leaseEpoch:claim.leaseEpoch,
      proposal:'Check one bounded candidate.',expectation:'The frozen checker reports a result.',conditions:['Use the frozen checker.']},
    `intent-${randomUUID()}`);
    const witness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');
    const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch:claim.leaseEpoch,witness,
      investigation:{format:'motive.investigation.v1',proposal:'Check one bounded candidate.',
        expectation:'The frozen checker reports a result.',conditions:['Use the frozen checker.'],
        observations:['The protected checker retained its exact report.'],assessment:'The result is scoped to this run.',
        nextAction:'Request independent Motive finding review.'}},`submit-${randomUUID()}`);
    const artifact=await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    await participation.createPostCheckAssessment(context,submission.id,{reportDigest:String(artifact.rows[0].report_digest),
      assessment:'The retained report matches the submitted witness.',nextAction:'Review the bounded result.',
      publicSummary:{question:'What did this run test?',finding:'It retained one checker result for review.'}},`post-${randomUUID()}`);
    await participation.completeAssignment(context,workOrderId,{leaseEpoch:claim.leaseEpoch,submissionId:submission.id},
      `complete-${randomUUID()}`);
    source={submissionId:submission.id,contributor};
  },30000);

  afterAll(async()=>{await pool?.end();if(admin){try{
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(0);
  }finally{await admin.end();}}});

  it('reviews native evidence without Hypothesis and preserves authority, CAS, replay, corruption and XP rules',async()=>{
    expect(await finding.publicReview('circle-packing',source.submissionId)).toMatchObject({available:true,reason:null});
    expect(await finding.eligibility(source.contributor,source.submissionId))
      .toMatchObject({canReview:false,reason:'ORIGINAL_CONTRIBUTOR'});
    await expect(finding.preview(source.contributor,source.submissionId)).rejects.toMatchObject({code:'FORBIDDEN'});

    const preview=await finding.preview(reviewer,source.submissionId);
    expect(preview.package.format).toBe('motive.finding-review-package/0.2');
    const pkg=preview.package as FindingReviewPackageV2;
    expect(Object.keys(pkg).sort()).toEqual(['assessment','claim','findingId','format','project','source','workOrder'].sort());
    expect(Object.keys(pkg.source.submission).sort()).toEqual(
      ['artifactManifestDigest','baseCommit','createdAt','format','id','licenseAcceptanceRef'].sort());
    expect(pkg).not.toHaveProperty('delivery');expect(pkg).not.toHaveProperty('engine');

    const insertDirectDecline=(candidate:unknown,label:string,options?:{
      projectId?:string;submissionId?:string;previousDecisionId?:string|null;packageDigest?:string})=>pool.query(`INSERT INTO motive.finding_review_decisions
      (id,project_id,source_submission_id,review_package,review_package_digest,previous_decision_id,decision,outcome,
       finding,limitations,novelty,duplicate_of_submission_id,duplicate_of_decision_id,reviewer_actor_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,'DECLINE',NULL,NULL,NULL,NULL,NULL,NULL,$7,$8,$9,$10)`,
    [randomUUID(),options?.projectId??projectId,options?.submissionId??source.submissionId,JSON.stringify(candidate),
      options?.packageDigest??digestCanonicalJson(candidate),options?.previousDecisionId??null,reviewer,
      `${label} packages must be rejected.`,`${label}-${randomUUID()}`,`sha256:${'a'.repeat(64)}`]);
    const missingFormat=structuredClone(pkg) as unknown as Record<string,unknown>;delete missingFormat.format;
    const nullFormat={...structuredClone(pkg),format:null};
    const unknownFormat={...structuredClone(pkg),format:'motive.finding-review-package/9.9'};
    for(const [label,candidate] of [['missing-format',missingFormat],['null-format',nullFormat],
      ['unknown-format',unknownFormat]] as const){
      await expect(insertDirectDecline(candidate,label)).rejects.toMatchObject({code:'23514'});
    }

    const actualCanonical=await pool.query(`SELECT motive.finding_review_canonical_json($1::jsonb) value`,
      [JSON.stringify(pkg)]);
    expect(actualCanonical.rows[0].value).toBe(canonicalJson(pkg));
    const boundedValue={asciiKey:'ภาษาไทย 😀\n"quoted" \\ slash',integer:[-9007199254740991,0,9007199254740991]};
    const boundedCanonical=await pool.query(`SELECT motive.finding_review_canonical_json($1::jsonb) value`,
      [JSON.stringify(boundedValue)]);
    expect(boundedCanonical.rows[0].value).toBe(canonicalJson(boundedValue));
    const normalized=await pool.query(`SELECT motive.finding_review_canonical_json('{"one":1.0,"zero":-0}'::jsonb) value`);
    expect(normalized.rows[0].value).toBe(canonicalJson({one:1,zero:0}));
    for(const unsupported of ['{"fraction":1e-7}','{"large":1e21}','{"é":1}']){
      await expect(pool.query(`SELECT motive.finding_review_canonical_json($1::jsonb)`,[unsupported]))
        .rejects.toMatchObject({code:'23514'});
    }

    const corrupted=structuredClone(pkg);corrupted.source.report.body={corrupted:true};
    await expect(insertDirectDecline(corrupted,'corrupt')).rejects.toMatchObject({code:'23514'});
    const forgedInvestigationDigest=structuredClone(pkg);
    forgedInvestigationDigest.source.investigation.digest=`sha256:${'0'.repeat(64)}`;
    await expect(insertDirectDecline(forgedInvestigationDigest,'forged-investigation-digest'))
      .rejects.toMatchObject({code:'23514'});
    await expect(insertDirectDecline(pkg,'forged-package-digest',{packageDigest:`sha256:${'0'.repeat(64)}`}))
      .rejects.toMatchObject({code:'23514'});

    const kernel=new LedgerKernel(pool);const foreignProject=await kernel.createProject({actorId:issuer,
      idempotencyKey:randomUUID(),slug:`foreign-${randomUUID()}`,visibility:'PRIVATE',
      revisionContent:{title:'Foreign native review guard fixture'}});
    const sourceWork=(await pool.query('SELECT terms FROM motive.work_orders WHERE id=$1',[workOrderId])).rows[0];
    const foreignTerms={...(sourceWork.terms as Record<string,unknown>),project_id:foreignProject.id,
      agreement_id:`foreign-${randomUUID()}`};
    const foreignWork=await kernel.createWorkOrder({actorId:issuer,idempotencyKey:randomUUID(),projectId:foreignProject.id,
      workOrderKey:'foreign-native-review',revision:1,state:'READY',terms:foreignTerms as never});
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[randomUUID(),foreignProject.id,reviewer,issuer]);
    const foreignToken=randomUUID(),foreignClaim=randomUUID(),foreignSubmission=randomUUID();
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,model_name,public_display_name,token_digest,token_hint,
       license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,clock_timestamp()+interval '1 day')`,
    [foreignToken,foreignProject.id,source.contributor,pkg.source.attribution.agentName,digestCanonicalJson({foreignToken}),
      foreignToken.replaceAll('-','').slice(0,12),pkg.source.submission.licenseAcceptanceRef]);
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'ACTIVE',clock_timestamp()+interval '1 hour')`,
    [foreignClaim,foreignProject.id,foreignWork.id,`agent:${foreignToken}`,foreignWork.termsDigest]);
    const retained=await pool.query(`SELECT submission.provenance,artifact.witness_format,artifact.witness_bytes,
      artifact.witness_digest,artifact.report::text,artifact.report_body,artifact.report_digest,artifact.exact_score,
      artifact.exceeds_reference FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      WHERE submission.id=$1`,[source.submissionId]);
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,
       base_commit,artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      VALUES($1,$2,$3,1,'EXTERNAL',$4,$5,1,$6,$7,$8,$9::jsonb,'unmetered_external',$10,'PENDING_EVALUATION')`,
    [foreignSubmission,foreignProject.id,foreignWork.id,`agent:${foreignToken}`,foreignClaim,pkg.source.submission.format,
      pkg.source.submission.baseCommit,pkg.source.submission.artifactManifestDigest,JSON.stringify(retained.rows[0].provenance),
      pkg.source.submission.licenseAcceptanceRef]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,
       report_digest,exact_score,exceeds_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [foreignSubmission,foreignProject.id,foreignToken,retained.rows[0].witness_format,retained.rows[0].witness_bytes,
      retained.rows[0].witness_digest,retained.rows[0].report,JSON.stringify(retained.rows[0].report_body),
      retained.rows[0].report_digest,retained.rows[0].exact_score,retained.rows[0].exceeds_reference]);
    const foreignPost=await pool.query(`INSERT INTO motive.participation_post_check_assessments
      (submission_id,project_id,agent_token_id,request_digest,report_digest,assessment,next_action)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,[foreignSubmission,foreignProject.id,foreignToken,
      digestCanonicalJson({foreignSubmission}),retained.rows[0].report_digest,'Foreign post-check evidence.',
      'Verify project binding.']);
    const foreignCompletion=await pool.query(`INSERT INTO motive.participation_claim_completions(claim_id,submission_id)
      VALUES($1,$2) RETURNING completed_at`,[foreignClaim,foreignSubmission]);
    const foreignCreated=await pool.query('SELECT created_at FROM motive.submissions WHERE id=$1',[foreignSubmission]);
    const foreignPackage:FindingReviewPackageV2={...structuredClone(pkg),findingId:foreignSubmission,
      project:{id:foreignProject.id,slug:'circle-packing',revision:1},
      workOrder:{id:foreignWork.id,revision:1,projectRevision:1,termsDigest:foreignWork.termsDigest,terms:foreignTerms},
      claim:{id:foreignClaim,leaseEpoch:1,termsDigest:foreignWork.termsDigest,
        completedAt:(foreignCompletion.rows[0].completed_at as Date).toISOString()},
      source:{...structuredClone(pkg.source),declaredIntent:null,
        submission:{...structuredClone(pkg.source.submission),id:foreignSubmission,
          createdAt:(foreignCreated.rows[0].created_at as Date).toISOString()},
        attribution:{...structuredClone(pkg.source.attribution),agentTokenId:foreignToken},
        references:{researchContext:null,researchReferences:null,motiveReferences:null},
        postCheck:{requestDigest:digestCanonicalJson({foreignSubmission}),reportDigest:retained.rows[0].report_digest,
          assessment:'Foreign post-check evidence.',nextAction:'Verify project binding.',
          createdAt:(foreignPost.rows[0].created_at as Date).toISOString()}}};
    await expect(insertDirectDecline(foreignPackage,'foreign-project',{
      projectId:foreignProject.id,submissionId:foreignSubmission})).rejects.toMatchObject({code:'23514'});

    const input={packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'ACCEPT' as const,
      outcome:'SUPPORTED' as const,finding:'The retained checker report supports this bounded result.',
      limitations:'One completed immutable Motive investigation.',novelty:'DISTINCT' as const,duplicateOfSubmissionId:null,
      rationale:'A different authorized account reviewed the exact retained evidence.'};
    await expect(finding.decide(reviewer,source.submissionId,{...input,packageDigest:`sha256:${'0'.repeat(64)}`},
      `bad-digest-${randomUUID()}`)).rejects.toMatchObject({code:'CONFLICT'});
    const key=`native-${randomUUID()}`;const accepted=await finding.decide(reviewer,source.submissionId,input,key);
    expect(accepted).toMatchObject({decision:'ACCEPT',replayed:false,hypothesis:null,evidence:{engineEvidence:null}});
    expect((await finding.decide(reviewer,source.submissionId,input,key))).toMatchObject({id:accepted.id,replayed:true});
    await expect(finding.decide(reviewer,source.submissionId,{...input,finding:'Altered replay.'},key))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(finding.decide(reviewer,source.submissionId,input,`stale-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});

    let projection=await participation.publicProjection();let contributor=projection.contributors
      .find(item=>item.publicSubmissionIds.includes(source.submissionId));
    expect(contributor?.acceptedFindingCount).toBe(1);
    const correctionPreview=await finding.preview(reviewer,source.submissionId);
    expect(correctionPreview.packageDigest).toBe(preview.packageDigest);
    const declined=await finding.decide(reviewer,source.submissionId,{packageDigest:correctionPreview.packageDigest,
      expectedDecisionId:accepted.id,decision:'DECLINE',outcome:null,finding:null,limitations:null,novelty:null,
      duplicateOfSubmissionId:null,rationale:'Retract the prior bounded assessment through the same append-only chain.'},
    `decline-${randomUUID()}`);
    expect(declined).toMatchObject({decision:'DECLINE',hypothesis:null,evidence:{engineEvidence:null}});
    projection=await participation.publicProjection();contributor=projection.contributors
      .find(item=>item.publicSubmissionIds.includes(source.submissionId));
    expect(contributor?.acceptedFindingCount).toBe(0);
  },60000);
});
