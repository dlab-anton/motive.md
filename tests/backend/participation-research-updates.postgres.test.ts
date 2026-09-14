import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import type { SubmissionResearchReference } from '../../src/lib/participation.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('public participation research updates on isolated PostgreSQL', () => {
  const databaseName = `motive_research_updates_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:research-updates-${randomUUID()}`;
  const tokenSecret = 'research-update-test-secret-longer-than-thirty-two-bytes';
  let admin: Pool; let pool: Pool; let service: ParticipationService; let projectId: string; let assignmentId: string;
  let scopeId: string; let snapshotId: string; let snapshotDigest: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Research updates test' } })).id;
    scopeId = randomUUID(); snapshotId = randomUUID();
    const payload = { format: 'motive.research-context.v1', hypotheses: [] };
    snapshotDigest = digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,clock_timestamp())`, [scopeId,projectId,randomUUID(),randomUUID(),
      `sha256:${'a'.repeat(64)}`,Buffer.alloc(48,7),`sha256:${'b'.repeat(64)}`,`sha256:${'c'.repeat(64)}`,'d'.repeat(40),issuer]);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',clock_timestamp())`, [snapshotId,scopeId,projectId,snapshotDigest,JSON.stringify(payload)]);
    const validate = async (candidateProjectId: string, references: SubmissionResearchReference[], client: PoolClient) => {
      for (const reference of references) {
        const found = await client.query(`SELECT 1 FROM motive.research_context_snapshots
          WHERE project_id=$1 AND scope_id=$2 AND id=$3 AND snapshot_digest=$4`,
        [candidateProjectId,reference.scopeId,reference.snapshotId,reference.snapshotDigest]);
        if (found.rowCount !== 1) throw new Error('unretained reference');
      }
    };
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer, validateResearchReferences: validate });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end(); }
  });

  async function participant(name: string, publish = true) {
    const owner = `account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner,randomUUID()]);
    const joined = await service.join(owner,name,{projectSlug:'circle-packing',publishDisplayName:publish,acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context,assignmentId,`claim-${randomUUID()}`);
    return {owner,joined,context,claim};
  }

  async function seedDelivery(sourceSubmissionId: string, hypothesisId: string,
    options: { withResult?: boolean; createdAt?: string; scopeId?: string } = {}) {
    const targetScopeId=options.scopeId ?? scopeId;
    const scope = (await pool.query(`SELECT api_base_url,configuration_digest,api_version FROM motive.project_research_scopes WHERE id=$1`,[targetScopeId])).rows[0];
    const intentId=randomUUID(),deliveryId=randomUUID(),engineActor=`motive:project:${projectId}`;
    const payload={format:'motive.hypothesis-writeback-preparation/0.1',disposition:'PROPOSED_UNREVIEWED',state:'ENGINE_WRITE_UNAVAILABLE',
      scope:{scopeId:targetScopeId,projectId,configurationDigest:scope.configuration_digest,apiVersion:scope.api_version},attribution:{engineActor},
      source:{submission:{id:sourceSubmissionId}},assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'}};
    const payloadDigest=digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.hypothesis_writeback_intents
      (id,project_id,scope_id,source_submission_id,prepared_by_actor_id,idempotency_key,request_digest,payload,payload_digest,
       engine_actor,disposition,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'PROPOSED_UNREVIEWED','ENGINE_WRITE_UNAVAILABLE')`,
    [intentId,projectId,targetScopeId,sourceSubmissionId,issuer,`intent-${randomUUID()}`,digestCanonicalJson({sourceSubmissionId}),JSON.stringify(payload),payloadDigest,engineActor]);
    await pool.query(`INSERT INTO motive.hypothesis_submission_deliveries
      (id,project_id,scope_id,source_submission_id,source_intent_id,source_intent_payload_digest,engine_actor,engine_api_base_url,
       scope_configuration_digest,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
       reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'test-contract',$12,$13,$14,$15)`,
    [deliveryId,projectId,targetScopeId,sourceSubmissionId,intentId,payloadDigest,engineActor,scope.api_base_url,scope.configuration_digest,
      scope.api_version,`sha256:${'1'.repeat(64)}`,'2'.repeat(64),'3'.repeat(64),issuer,
      options.createdAt ?? new Date().toISOString()]);
    const body={statement:'Durably delivered draft.'};
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_operations
      (delivery_id,operation,target_hypothesis_id,request_path,idempotency_key,request_body,request_body_digest,request_digest)
      VALUES($1,'DRAFT_HYPOTHESIS',NULL,'/api/v1/hypotheses',$2,$3::jsonb,$4,$5)`,
    [deliveryId,`motive-delivery:${deliveryId}:draft`,JSON.stringify(body),digestCanonicalJson(body),digestCanonicalJson({path:'/api/v1/hypotheses',body})]);
    if (options.withResult !== false) {
      const response={id:hypothesisId};
      await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_results
        (delivery_id,operation,resource_id,response_body,response_digest) VALUES($1,'DRAFT_HYPOTHESIS',$2,$3::jsonb,$4)`,
      [deliveryId,hypothesisId,JSON.stringify(response),digestCanonicalJson(response)]);
    }
    return deliveryId;
  }

  async function appendAdmission(deliveryId: string, reviewerActorId: string, decision: 'ADMIT'|'DECLINE',
    previousDecisionId: string|null) {
    const source = await pool.query(`SELECT delivery.*,artifact.report AS report_status,artifact.report_digest,
        artifact.exact_score,artifact.exceeds_reference,assessment.request_digest AS assessment_request_digest,
        assessment.report_digest AS assessment_report_digest,assessment.assessment AS assessment_text,
        assessment.next_action,assessment.created_at AS assessment_created_at,
        draft.request_path,draft.request_body,draft.request_body_digest,draft.request_digest AS draft_request_digest
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      JOIN motive.hypothesis_submission_delivery_operations draft
        ON draft.delivery_id=delivery.id AND draft.operation='DRAFT_HYPOTHESIS'
      WHERE delivery.id=$1`, [deliveryId]);
    expect(source.rowCount).toBe(1);
    const row=source.rows[0];
    const reviewPackage = {
      format:'motive.research-delivery-review-package/0.1',
      delivery:{id:deliveryId,projectId:String(row.project_id),scopeId:String(row.scope_id),
        sourceSubmissionId:String(row.source_submission_id),sourceIntentId:String(row.source_intent_id),
        sourceIntentPayloadDigest:String(row.source_intent_payload_digest)},
      scope:{configurationDigest:String(row.scope_configuration_digest),apiBaseUrl:String(row.engine_api_base_url),
        apiVersion:String(row.engine_api_version),engineActor:String(row.engine_actor)},
      report:{status:String(row.report_status),digest:String(row.report_digest),
        exactScore:row.exact_score===null?null:String(row.exact_score),
        exceedsReference:row.exceeds_reference===null?null:row.exceeds_reference===true},
      postCheck:{requestDigest:String(row.assessment_request_digest),reportDigest:String(row.assessment_report_digest),
        assessment:String(row.assessment_text),nextAction:String(row.next_action),
        createdAt:(row.assessment_created_at as Date).toISOString()},
      reproducibility:null,
      contract:{fileDigest:String(row.reviewed_contract_digest),contractVersion:String(row.reviewed_contract_version),
        apiVersion:String(row.engine_api_version),schemaRevision:'017_write_idempotency',
        surfaceDigest:String(row.reviewed_contract_surface_digest),implementationDigest:String(row.reviewed_implementation_digest)},
      assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'},
      operations:{draft:{method:'POST',path:String(row.request_path),body:row.request_body,
        bodyDigest:String(row.request_body_digest),requestDigest:String(row.draft_request_digest)},neutralEvidence:null},
    };
    const id = randomUUID();
    const request = { packageDigest: digestCanonicalJson(reviewPackage), expectedDecisionId: previousDecisionId,
      decision, rationale: `${decision} retained research package.` };
    const inserted = await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_admission_decisions
      (id,delivery_id,review_package,review_package_digest,previous_decision_id,decision,reviewer_actor_id,rationale,
       idempotency_key,request_digest)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING id,created_at`,
    [id,deliveryId,JSON.stringify(reviewPackage),request.packageDigest,previousDecisionId,decision,reviewerActorId,
      request.rationale,`review-${randomUUID()}`,digestCanonicalJson(request)]);
    return { id, reviewedAt: (inserted.rows[0].created_at as Date).toISOString() };
  }

  it('projects retained questions, report outcomes, post-check preference, completion, and trusted earlier Motive citations', async () => {
    const source=await participant('Earlier researcher');
    const sourceInvestigation={format:'motive.investigation.v1' as const,proposal:'Test the incomplete baseline.',
      expectation:'The checker rejects missing circles.',conditions:['Use the protected checker.'],observations:['The checker rejected it.'],
      assessment:'The baseline is incomplete.',nextAction:'Try a complete candidate.'};
    const sourceSubmission=await service.submitWitness(source.context,assignmentId,{leaseEpoch:source.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:sourceInvestigation},`submit-${randomUUID()}`);
    await service.completeAssignment(source.context,assignmentId,{leaseEpoch:source.claim.leaseEpoch!,submissionId:sourceSubmission.id},`complete-${randomUUID()}`);
    const sourceReport=await service.publicReport(sourceSubmission.id);
    await service.createPostCheckAssessment(source.context,sourceSubmission.id,{reportDigest:String(sourceReport.reportDigest),
      assessment:'The protected rejection confirms the missing-circle defect.',nextAction:'Construct all circles.'},`assess-${randomUUID()}`);
    const mappedHypothesis=randomUUID(),unmappedHypothesis=randomUUID(); await seedDelivery(sourceSubmission.id,mappedHypothesis);

    const current=await participant('Current researcher',false);
    await service.declareAssignmentIntent(current.context,assignmentId,{leaseEpoch:current.claim.leaseEpoch!,proposal:'Try a complete perturbation.',
      expectation:'The exact score may increase.',conditions:['Use the frozen reference.']},`declare-${randomUUID()}`);
    const reference=(hypothesisId:string):SubmissionResearchReference=>({scopeId,snapshotId,snapshotDigest,hypothesisId,
      observedUpdatedAt:'2026-09-08T00:00:00.000Z',evidenceIds:[]});
    const currentSubmission=await service.submitWitness(current.context,assignmentId,{leaseEpoch:current.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:{format:'motive.investigation.v1',
        proposal:'Final submitted proposal.',expectation:'Final submitted expectation.',conditions:['Use the current claim.'],
        observations:['The checker rejected the incomplete witness.'],assessment:'Submission-time assessment.',nextAction:'Review the failure.',
        researchReferences:[reference(mappedHypothesis),reference(unmappedHypothesis)]}},`submit-${randomUUID()}`);
    const currentReport=await service.publicReport(currentSubmission.id);
    const beforePostCheck=await service.publicProjection();
    const initialUpdate=beforePostCheck.researchUpdates?.find(item=>item.submissionId===currentSubmission.id);
    expect(initialUpdate).toMatchObject({reportDigest:currentReport.reportDigest,
      latestAssessment:'Submission-time assessment.',assessmentTiming:'AT_SUBMISSION',
      assessmentSourceDigest:digestCanonicalJson({format:'motive.research-assessment-source.v1',
        assessment:'Submission-time assessment.',timing:'AT_SUBMISSION'})});
    const publicSummary={question:'Did the checked submission satisfy the required witness shape?',finding:'The checker rejected this incomplete witness before scoring geometry.'};
    await service.createPostCheckAssessment(current.context,currentSubmission.id,{reportDigest:String(currentReport.reportDigest),
      assessment:'Post-check assessment takes precedence.',nextAction:'Choose another bounded test.',publicSummary},`assess-${randomUUID()}`);
    const siblingSubmission=await service.submitWitness(current.context,assignmentId,{leaseEpoch:current.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:{format:'motive.investigation.v1',
        proposal:'Second final proposal on the same claim.',expectation:'Second final expectation.',conditions:['Use the same current claim.'],
        observations:['The checker rejected this second witness.'],assessment:'Second submission assessment.',nextAction:'Compare both checked submissions.'}},
    `submit-${randomUUID()}`);
    await service.completeAssignment(current.context,assignmentId,{leaseEpoch:current.claim.leaseEpoch!,submissionId:currentSubmission.id},`complete-${randomUUID()}`);

    const submissionOnly=await participant('Submission-time researcher');
    const submissionOnlyResult=await service.submitWitness(submissionOnly.context,assignmentId,{leaseEpoch:submissionOnly.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:{format:'motive.investigation.v1',
        proposal:'Submission-only proposal.',expectation:'Submission-only expectation.',conditions:['Use the checker.'],
        observations:['The checker rejected it.'],assessment:'Submission-only assessment.',nextAction:'Try again.'}},`submit-${randomUUID()}`);
    const reportOnly=await participant('Report-only researcher');
    const reportOnlyResult=await service.submitWitness(reportOnly.context,assignmentId,{leaseEpoch:reportOnly.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}'},`submit-${randomUUID()}`);

    const projection=await service.publicProjection(); const update=projection.researchUpdates?.find(item=>item.submissionId===currentSubmission.id);
    expect(update).toMatchObject({reportDigest:currentReport.reportDigest,agentName:current.joined.credential.agentName,
      contributorDisplayName:null,proposal:'Final submitted proposal.',expectation:'Final submitted expectation.',
      latestAssessment:'Post-check assessment takes precedence.',assessmentTiming:'AFTER_CHECK',completed:true,
      publicSummary,
      assessmentSourceDigest:digestCanonicalJson({format:'motive.research-assessment-source.v1',
        assessment:'Post-check assessment takes precedence.',timing:'AFTER_CHECK'}),
      memoryReview:{latestDecision:null,hasEngineRecords:false},
      observedOutcome:{reportStatus:'REJECTED',exactScore:null,exceedsReference:null,
        reportHref:`/api/public/projects/circle-packing/submissions/${currentSubmission.id}/report`},
      citedEarlierMotiveSubmissions:[{submissionId:sourceSubmission.id,agentName:source.joined.credential.agentName,
        reportHref:`/api/public/projects/circle-packing/submissions/${sourceSubmission.id}/report`,
        investigationHref:`/api/public/projects/circle-packing/submissions/${sourceSubmission.id}/investigation`,
        postCheckAssessmentHref:`/api/public/projects/circle-packing/submissions/${sourceSubmission.id}/post-check-assessment`} ]});
    expect(projection.researchUpdates?.find(item=>item.submissionId===siblingSubmission.id)).toMatchObject({
      proposal:'Second final proposal on the same claim.',expectation:'Second final expectation.',
      latestAssessment:'Second submission assessment.',assessmentTiming:'AT_SUBMISSION',completed:false});
    expect(projection.researchUpdates?.find(item=>item.submissionId===sourceSubmission.id)).toMatchObject({
      proposal:sourceInvestigation.proposal,assessmentTiming:'AFTER_CHECK',completed:true,
      memoryReview:{latestDecision:null,hasEngineRecords:true}});
    expect(projection.researchUpdates?.find(item=>item.submissionId===submissionOnlyResult.id)).toMatchObject({
      proposal:'Submission-only proposal.',latestAssessment:'Submission-only assessment.',assessmentTiming:'AT_SUBMISSION',completed:false});
    expect(projection.researchUpdates?.find(item=>item.submissionId===reportOnlyResult.id)).toMatchObject({
      proposal:null,expectation:null,latestAssessment:null,assessmentTiming:null,assessmentSourceDigest:null,
      completed:false,memoryReview:{latestDecision:null,hasEngineRecords:false}});
    expect(update?.assessmentSourceDigest).not.toBe(initialUpdate?.assessmentSourceDigest);
    expect(update?.reportDigest).toBe(initialUpdate?.reportDigest);
    expect(projection.researchUpdates!.length).toBeLessThanOrEqual(20);
    const queryClient=await pool.connect();
    try {
      let queryCount=0;
      const query=queryClient.query.bind(queryClient) as unknown as (...args:unknown[])=>unknown;
      const countedClient={query:(...args:unknown[])=>{queryCount+=1;return query(...args);}} as unknown as PoolClient;
      const bounded=await (service as unknown as { publicResearchUpdates(client:PoolClient,projectId:string):
        Promise<Array<{submissionId:string}>> }).publicResearchUpdates(countedClient,projectId);
      expect(queryCount).toBe(1);expect(bounded.length).toBeLessThanOrEqual(20);
    } finally { queryClient.release(); }
    const serialized=JSON.stringify(projection.researchUpdates);
    expect(serialized).not.toContain(snapshotId); expect(serialized).not.toContain(mappedHypothesis);
    expect(serialized).not.toContain(unmappedHypothesis); expect(serialized).not.toContain(current.owner);
  },30_000);

  it('projects latest-delivery review history without depending on current reviewer or contributor authority', async () => {
    const contributor=await participant('Private review-history contributor',false);
    const submission=await service.submitWitness(contributor.context,assignmentId,{leaseEpoch:contributor.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}',investigation:{format:'motive.investigation.v1',
        proposal:'Retain a bounded negative result.',expectation:'The incomplete witness remains rejected.',
        conditions:['Use the protected checker.'],observations:['The checker rejected it.'],
        assessment:'The negative result is useful.',nextAction:'Retain it for later comparison.'}},`submit-${randomUUID()}`);
    const report=await service.publicReport(submission.id);
    await service.createPostCheckAssessment(contributor.context,submission.id,{reportDigest:String(report.reportDigest),
      assessment:'The independent read should retain this result.',nextAction:'Compare it with the next experiment.'},`assess-${randomUUID()}`);

    const reviewer=`account:${randomUUID()}`;const reviewerMembershipId=randomUUID();
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[reviewer,randomUUID()]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[reviewerMembershipId,projectId,reviewer,issuer]);
    const createdAt=(await pool.query(`SELECT created_at FROM motive.submissions WHERE id=$1`,[submission.id])).rows[0].created_at as Date;
    const firstDelivery=await seedDelivery(submission.id,randomUUID(),{createdAt:new Date(createdAt.getTime()+1_000).toISOString()});

    const unreviewed=await service.publicProjection();
    expect(unreviewed.researchUpdates?.find(item=>item.submissionId===submission.id)?.memoryReview)
      .toEqual({latestDecision:null,hasEngineRecords:true});
    const admitted=await appendAdmission(firstDelivery,reviewer,'ADMIT',null);
    const declined=await appendAdmission(firstDelivery,reviewer,'DECLINE',admitted.id);
    const corrected=await service.publicProjection();
    const correctedUpdate=corrected.researchUpdates?.find(item=>item.submissionId===submission.id);
    expect(correctedUpdate).toMatchObject({contributorDisplayName:null,memoryReview:{
      latestDecision:{decision:'DECLINE',reviewedAt:declined.reviewedAt},hasEngineRecords:true}});
    const correctedJson=JSON.stringify(correctedUpdate);
    expect(correctedJson).not.toContain(reviewer);expect(correctedJson).not.toContain(contributor.owner);
    expect(correctedJson).not.toContain(firstDelivery);expect(correctedJson).not.toContain(scopeId);

    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE id=$1`,[reviewerMembershipId]);
    await pool.query(`UPDATE motive.account_identities SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
      WHERE actor_id=$1`,[reviewer]);
    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1`,
      [contributor.joined.credential.id]);
    const retired=await service.publicProjection();
    expect(retired.researchUpdates?.find(item=>item.submissionId===submission.id)?.memoryReview)
      .toEqual({latestDecision:{decision:'DECLINE',reviewedAt:declined.reviewedAt},hasEngineRecords:true});

    const replacementScopeId=randomUUID();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
        channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
        api_version,inspected_source_revision,status,bound_by,verified_at)
        SELECT $1,project_id,provider,api_base_url,$2,$3,channel_name,channel_snapshot,channel_snapshot_digest,
          encrypted_api_key,credential_fingerprint,$4,api_version,inspected_source_revision,'REPLACEMENT_PENDING',bound_by,clock_timestamp()
        FROM motive.project_research_scopes WHERE id=$5`,[replacementScopeId,randomUUID(),randomUUID(),
        `sha256:${'e'.repeat(64)}`,scopeId]);
      await client.query(`UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2
        WHERE id=$1`,[scopeId,replacementScopeId]);
      await client.query(`UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1`,[replacementScopeId]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await seedDelivery(submission.id,randomUUID(),{withResult:false,scopeId:replacementScopeId,
      createdAt:new Date(createdAt.getTime()+2_000).toISOString()});
    const latestDelivery=await service.publicProjection();
    expect(latestDelivery.researchUpdates?.find(item=>item.submissionId===submission.id)?.memoryReview)
      .toEqual({latestDecision:null,hasEngineRecords:false});
    expect(latestDelivery.researchUpdates!.length).toBeLessThanOrEqual(20);
  },30_000);
});
