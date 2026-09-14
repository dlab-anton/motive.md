import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import express from 'express';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationRouters, createParticipationService, type ParticipationAgentContext,
  type ParticipationService } from '../../server/participation/index.ts';
import type {
  AssignmentIntentProjection,
  AssignmentProjection,
  DeclareAssignmentIntentInput,
  ParticipationPublicProjection,
  PublicSubmissionInvestigation,
  SubmissionInvestigationInput,
  SubmissionResearchContext,
  SubmissionResearchReference,
  SubmissionSummary,
} from '../../src/lib/participation.ts';

type MotiveReference = { submissionId: string; reportDigest: string; artifactDigest: string };
type IntentWithMotiveReferences = DeclareAssignmentIntentInput & { motiveReferences?: MotiveReference[] };
type InvestigationWithMotiveReferences = SubmissionInvestigationInput & { motiveReferences?: MotiveReference[] };
type ProjectedIntentWithMotiveReferences = AssignmentIntentProjection & { motiveReferences?: MotiveReference[] };

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const witness = '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}';
const digest = (character: string) => `sha256:${character.repeat(64)}`;

pgDescribe('participation Motive references on isolated PostgreSQL', () => {
  const databaseName = `motive_submission_refs_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:motive-refs-${randomUUID()}`;
  const tokenSecret = 'motive-reference-test-secret-longer-than-thirty-two-bytes';
  let admin: Pool;
  let pool: Pool;
  let service: ParticipationService;
  let projectId: string;
  let assignmentId: string;
  let scopeId: string;
  let snapshotId: string;
  let snapshotDigest: string;
  let referenceWitness: string;
  let server: Server;
  let httpOrigin: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    referenceWitness = await readFile('public/projects/circle-packing/reference-witness.json','utf8');
    projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Motive reference test' } })).id;

    scopeId = randomUUID();
    snapshotId = randomUUID();
    const snapshot = { format: 'motive.research-context.v1', hypotheses: [] };
    snapshotDigest = digestCanonicalJson(snapshot);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,clock_timestamp())`, [scopeId,projectId,randomUUID(),randomUUID(),digest('a'),
      Buffer.alloc(48,7),digest('b'),digest('c'),'d'.repeat(40),issuer]);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',clock_timestamp())`, [snapshotId,scopeId,projectId,snapshotDigest,JSON.stringify(snapshot)]);
    const validateResearchReferences = async (candidateProjectId: string, references: SubmissionResearchReference[], client: PoolClient) => {
      for (const reference of references) {
        const retained = await client.query(`SELECT 1 FROM motive.research_context_snapshots
          WHERE project_id=$1 AND scope_id=$2 AND id=$3 AND snapshot_digest=$4`,
        [candidateProjectId,reference.scopeId,reference.snapshotId,reference.snapshotDigest]);
        if (retained.rowCount !== 1) throw new Error('unretained reference');
      }
    };
    const validateResearchContext = async (candidateProjectId: string, context: SubmissionResearchContext, client: PoolClient) => {
      const retained = await client.query(`SELECT 1 FROM motive.research_context_snapshots
        WHERE project_id=$1 AND scope_id=$2 AND id=$3 AND snapshot_digest=$4`,
      [candidateProjectId,context.scopeId,context.snapshotId,context.snapshotDigest]);
      if (retained.rowCount !== 1) throw new Error('unretained context');
    };
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      validateResearchContext, validateResearchReferences });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
    const app=express();
    const routers=createParticipationRouters({service,isActorActive:async actorId=>{
      const account=await pool.query(`SELECT 1 FROM motive.account_identities WHERE actor_id=$1 AND status='ACTIVE'`,[actorId]);
      return account.rowCount===1;
    }});
    app.use('/api/agent',routers.agentRouter);
    app.use('/api/public/projects/circle-packing',routers.publicRouter);
    server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('Test HTTP server did not bind a TCP port.');
    httpOrigin=`http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) { server.close(); await once(server,'close'); }
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function participant(name: string, publish = true) {
    const owner = `account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner,randomUUID()]);
    const joined = await service.join(owner,name,{projectSlug:'circle-packing',publishDisplayName:publish,
      acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context,assignmentId,`claim-${randomUUID()}`);
    return { owner, joined, context, claim };
  }

  async function postAgent<T>(token: string, path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const response=await fetch(`${httpOrigin}/api/agent${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,
      'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(body)});
    const payload=await response.json();
    expect(response.status,payload).toBe(201);
    return payload as T;
  }

  async function getPublic<T>(path: string): Promise<T> {
    const response=await fetch(`${httpOrigin}/api/public/projects/circle-packing${path}`);
    const payload=await response.json();
    expect(response.status,payload).toBe(200);
    return payload as T;
  }

  const investigation = (proposal: string, motiveReferences?: MotiveReference[], researchReferences?: SubmissionResearchReference[]):
    InvestigationWithMotiveReferences => ({ format:'motive.investigation.v1',proposal,
      expectation:'The protected checker will produce an exact bounded outcome.',conditions:['Use the frozen work-order terms.'],
      observations:['The protected checker returned a retained report.'],assessment:'Interpret only this checked candidate.',
      nextAction:'Compare this result with the cited earlier experiment.',
      ...(motiveReferences === undefined ? {} : { motiveReferences }),
      ...(researchReferences === undefined ? {} : { researchReferences }) } as InvestigationWithMotiveReferences);

  const intent = (leaseEpoch: number, motiveReferences?: MotiveReference[], researchReferences?: SubmissionResearchReference[]):
    IntentWithMotiveReferences => ({ leaseEpoch,proposal:'Test a bounded change informed by earlier Motive evidence.',
      expectation:'The protected checker will distinguish this candidate from the earlier result.',
      conditions:['Use the frozen work-order terms.'],
      ...(motiveReferences === undefined ? {} : { motiveReferences }),
      ...(researchReferences === undefined ? {} : { researchReferences }) } as IntentWithMotiveReferences);

  async function source(name: string, sourceWitness = witness) {
    const fixture = await participant(name);
    const submission = await service.submitWitness(fixture.context,assignmentId,{leaseEpoch:fixture.claim.leaseEpoch!,witness:sourceWitness,
      investigation:investigation(`Record the earlier ${name} result.`)},`submit-${randomUUID()}`);
    await service.completeAssignment(fixture.context,assignmentId,
      {leaseEpoch:fixture.claim.leaseEpoch!,submissionId:submission.id},`complete-${randomUUID()}`);
    const artifact = await pool.query(`SELECT report_digest,witness_digest FROM motive.participation_submission_artifacts
      WHERE submission_id=$1`,[submission.id]);
    return { ...fixture, submission, reference: { submissionId:submission.id,
      reportDigest:String(artifact.rows[0].report_digest),artifactDigest:String(artifact.rows[0].witness_digest) } satisfies MotiveReference };
  }

  const hypothesisReference = (hypothesisId: string): SubmissionResearchReference => ({ scopeId,snapshotId,snapshotDigest,hypothesisId,
    observedUpdatedAt:'2026-09-08T00:00:00.000Z',evidenceIds:[] });

  async function seedHypothesisMapping(sourceSubmissionId: string, hypothesisId: string) {
    const scope = (await pool.query(`SELECT api_base_url,configuration_digest,api_version
      FROM motive.project_research_scopes WHERE id=$1`,[scopeId])).rows[0];
    const intentId=randomUUID(),deliveryId=randomUUID(),engineActor=`motive:project:${projectId}`;
    const payload={format:'motive.hypothesis-writeback-preparation/0.1',disposition:'PROPOSED_UNREVIEWED',state:'ENGINE_WRITE_UNAVAILABLE',
      scope:{scopeId,projectId,configurationDigest:scope.configuration_digest,apiVersion:scope.api_version},attribution:{engineActor},
      source:{submission:{id:sourceSubmissionId}},assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'}};
    const payloadDigest=digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.hypothesis_writeback_intents
      (id,project_id,scope_id,source_submission_id,prepared_by_actor_id,idempotency_key,request_digest,payload,payload_digest,
       engine_actor,disposition,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'PROPOSED_UNREVIEWED','ENGINE_WRITE_UNAVAILABLE')`,
    [intentId,projectId,scopeId,sourceSubmissionId,issuer,`intent-${randomUUID()}`,
      digestCanonicalJson({sourceSubmissionId}),JSON.stringify(payload),payloadDigest,engineActor]);
    await pool.query(`INSERT INTO motive.hypothesis_submission_deliveries
      (id,project_id,scope_id,source_submission_id,source_intent_id,source_intent_payload_digest,engine_actor,engine_api_base_url,
       scope_configuration_digest,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
       reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'test-contract',$12,$13,$14)`,
    [deliveryId,projectId,scopeId,sourceSubmissionId,intentId,payloadDigest,engineActor,scope.api_base_url,scope.configuration_digest,
      scope.api_version,digest('1'),'2'.repeat(64),'3'.repeat(64),issuer]);
    const requestBody={statement:'Durably delivered draft.'};
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_operations
      (delivery_id,operation,target_hypothesis_id,request_path,idempotency_key,request_body,request_body_digest,request_digest)
      VALUES($1,'DRAFT_HYPOTHESIS',NULL,'/api/v1/hypotheses',$2,$3::jsonb,$4,$5)`,
    [deliveryId,`motive-delivery:${deliveryId}:draft`,JSON.stringify(requestBody),digestCanonicalJson(requestBody),
      digestCanonicalJson({path:'/api/v1/hypotheses',body:requestBody})]);
    const response={id:hypothesisId};
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_results
      (delivery_id,operation,resource_id,response_body,response_digest) VALUES($1,'DRAFT_HYPOTHESIS',$2,$3::jsonb,$4)`,
    [deliveryId,hypothesisId,JSON.stringify(response),digestCanonicalJson(response)]);
  }

  it('cites prior pending and rejected results, publishes the immutable references, and deduplicates direct and Hypothesis paths', async () => {
    const pending = await source('Pending source',referenceWitness);
    const rejected = await source('Rejected source');
    expect(pending.submission).toMatchObject({reportStatus:'VALID',acceptance:'PENDING',
      exactScore:'5.29109518547430697',exceedsReference:false});
    expect(rejected.submission).toMatchObject({reportStatus:'REJECTED',acceptance:'PENDING'});
    expect((await service.publicInvestigation(pending.submission.id)).claimIntent).toBeNull();
    await service.reviewSubmission(issuer,rejected.submission.id,
      {decision:'REJECTED',rationale:'Retain this bounded negative result without accepting it.'},`review-${randomUUID()}`);
    const mappedHypothesisId=randomUUID();
    await seedHypothesisMapping(pending.submission.id,mappedHypothesisId);
    const researchReferences=[hypothesisReference(mappedHypothesisId)];
    const researchContext={scopeId,snapshotId,snapshotDigest};
    const motiveReferences=[pending.reference,rejected.reference];
    const current=await participant('Current researcher');
    const body={...intent(current.claim.leaseEpoch!,motiveReferences,researchReferences),researchContext};
    const intentKey=`declare-${randomUUID()}`;
    const declared=await postAgent<AssignmentProjection>(current.joined.token,`/assignments/${assignmentId}/intent`,body,intentKey);
    expect((declared.intent as ProjectedIntentWithMotiveReferences).motiveReferences).toEqual(motiveReferences);
    expect(await service.declareAssignmentIntent(current.context,assignmentId,body,intentKey)).toEqual(declared);
    expect((await service.declareAssignmentIntent(current.context,assignmentId,body,`recover-${randomUUID()}`)).intent).toEqual(declared.intent);
    await expect(service.declareAssignmentIntent(current.context,assignmentId,
      intent(current.claim.leaseEpoch!,[rejected.reference,pending.reference],researchReferences),intentKey))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(service.declareAssignmentIntent(current.context,assignmentId,
      intent(current.claim.leaseEpoch!,[rejected.reference],researchReferences),`changed-${randomUUID()}`))
      .rejects.toMatchObject({code:'CONFLICT'});

    const activeProjection=await getPublic<ParticipationPublicProjection>('/');
    const activeIntent=activeProjection.activeResearchIntents?.find(item=>item.claimId===current.claim.claimId);
    expect(activeIntent?.motiveReferences).toEqual(motiveReferences);
    expect(activeIntent).not.toHaveProperty('ownerActorId');
    expect(activeIntent).not.toHaveProperty('agentTokenId');
    expect(JSON.stringify(activeIntent)).not.toContain(current.owner);
    expect(JSON.stringify(activeIntent)).not.toContain(current.context.tokenId);

    const rekeyedMotiveReferences=motiveReferences.map(reference=>({artifactDigest:reference.artifactDigest,
      submissionId:reference.submissionId,reportDigest:reference.reportDigest}));
    const final=investigation('Submit the bounded follow-up experiment.',rekeyedMotiveReferences);
    const submitKey=`submit-${randomUUID()}`;
    const submission=await postAgent<SubmissionSummary>(current.joined.token,`/assignments/${assignmentId}/submissions`,
      {leaseEpoch:current.claim.leaseEpoch!,witness:referenceWitness,investigation:final},submitKey);
    expect(submission).toMatchObject({reportStatus:'VALID',acceptance:'PENDING',
      exactScore:'5.29109518547430697',exceedsReference:false});
    expect(await service.submitWitness(current.context,assignmentId,
      {leaseEpoch:current.claim.leaseEpoch!,witness:referenceWitness,investigation:final},submitKey)).toEqual(submission);
    await expect(service.submitWitness(current.context,assignmentId,
      {leaseEpoch:current.claim.leaseEpoch!,witness:referenceWitness,investigation:{...final,assessment:'Changed under the same key.'}},submitKey))
      .rejects.toMatchObject({code:'CONFLICT'});
    await service.completeAssignment(current.context,assignmentId,
      {leaseEpoch:current.claim.leaseEpoch!,submissionId:submission.id},`complete-${randomUUID()}`);

    const publicInvestigation=await getPublic<PublicSubmissionInvestigation>(`/submissions/${submission.id}/investigation`);
    expect(publicInvestigation.investigation).toMatchObject({motiveReferences});
    expect(publicInvestigation.investigation).not.toHaveProperty('researchContext');
    expect(publicInvestigation.investigation).not.toHaveProperty('researchReferences');
    expect(publicInvestigation.claimIntent).toMatchObject({researchContext,researchReferences,motiveReferences});
    expect(await service.publicReport(submission.id)).toMatchObject({reportStatus:'VALID',acceptance:'PENDING',report:{
      agentInvestigation:{investigation:{motiveReferences}}}});
    const projection=await getPublic<ParticipationPublicProjection>('/');
    const update=projection.researchUpdates?.find(item=>item.submissionId===submission.id);
    expect(update?.citedEarlierMotiveSubmissions.map(item=>item.submissionId).sort())
      .toEqual([pending.submission.id,rejected.submission.id].sort());
    expect(update?.citedEarlierMotiveSubmissions.filter(item=>item.submissionId===pending.submission.id)).toHaveLength(1);
    expect(projection).toMatchObject({acceptedResults:0,bestAccepted:null});
    expect(projection.submissions.find(item=>item.id===pending.submission.id)?.acceptance).toBe('PENDING');
    expect(projection.submissions.find(item=>item.id===rejected.submission.id)?.acceptance).toBe('REJECTED');
    expect(projection.contributors.every(item=>item.reviewedArtifactCount===0 && item.reviewedSubmissionIds.length===0)).toBe(true);
    expect(await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.participation_submission_reviews WHERE decision='ACCEPTED') AS accepted,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_admission_decisions) AS admitted`))
      .toMatchObject({rows:[{accepted:0,admitted:0}]});
  }, 30_000);

  it('rejects malformed, duplicate, unretained, cross-project, and digest-mismatched references before recording an intent', async () => {
    const retained=await source('Validation source');
    const fixture=await participant('Validation researcher');
    const malformed: unknown[] = [
      null,
      [],
      Array.from({length:11},()=>({submissionId:randomUUID(),reportDigest:digest('1'),artifactDigest:digest('2')})),
      [{...retained.reference,submissionId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}],
      [{...retained.reference,reportDigest:digest('A')}],
      [{...retained.reference,unexpected:true}],
      [retained.reference,null],
      [retained.reference,retained.reference],
    ];
    for (const [index,motiveReferences] of malformed.entries()) {
      await expect(service.declareAssignmentIntent(fixture.context,assignmentId,
        {...intent(fixture.claim.leaseEpoch!),motiveReferences} as IntentWithMotiveReferences,`malformed-${index}-${randomUUID()}`))
        .rejects.toMatchObject({code:'VALIDATION'});
    }
    const missing={submissionId:randomUUID(),reportDigest:digest('4'),artifactDigest:digest('5')};
    await expect(service.declareAssignmentIntent(fixture.context,assignmentId,
      intent(fixture.claim.leaseEpoch!,[missing]),`missing-${randomUUID()}`)).rejects.toMatchObject({code:'VALIDATION'});
    await expect(service.declareAssignmentIntent(fixture.context,assignmentId,
      intent(fixture.claim.leaseEpoch!,[{...retained.reference,reportDigest:digest('6')}]),`wrong-report-${randomUUID()}`))
      .rejects.toMatchObject({code:'VALIDATION'});
    await expect(service.declareAssignmentIntent(fixture.context,assignmentId,
      intent(fixture.claim.leaseEpoch!,[{...retained.reference,artifactDigest:digest('7')}]),`wrong-artifact-${randomUUID()}`))
      .rejects.toMatchObject({code:'VALIDATION'});
    const foreign=await foreignArtifact();
    await expect(service.declareAssignmentIntent(fixture.context,assignmentId,
      intent(fixture.claim.leaseEpoch!,[foreign]),`foreign-${randomUUID()}`)).rejects.toMatchObject({code:'VALIDATION'});
    expect(await pool.query('SELECT count(*)::integer AS count FROM motive.participation_claim_intents WHERE claim_id=$1',
      [fixture.claim.claimId])).toMatchObject({rows:[{count:0}]});
  }, 30_000);

  it('requires the final investigation to repeat the exact declared set and denies retrospective references', async () => {
    const first=await source('Final-match source A');
    const second=await source('Final-match source B');
    const third=await source('Final-match source C');
    const fixture=await participant('Final-match researcher');
    await service.declareAssignmentIntent(fixture.context,assignmentId,
      intent(fixture.claim.leaseEpoch!,[first.reference,second.reference]),`declare-${randomUUID()}`);
    const attempts: Array<[string,MotiveReference[]|undefined]> = [
      ['drop-all',undefined],
      ['drop-one',[first.reference]],
      ['add',[first.reference,second.reference,third.reference]],
      ['substitute',[first.reference,third.reference]],
      ['reorder',[second.reference,first.reference]],
    ];
    for (const [label,motiveReferences] of attempts) {
      await expect(service.submitWitness(fixture.context,assignmentId,{leaseEpoch:fixture.claim.leaseEpoch!,witness,
        investigation:investigation(`Attempt to ${label} the declared source.`,motiveReferences)},`${label}-${randomUUID()}`))
        .rejects.toMatchObject({code:'VALIDATION'});
    }
    const exact=await service.submitWitness(fixture.context,assignmentId,{leaseEpoch:fixture.claim.leaseEpoch!,witness,
      investigation:investigation('Repeat the exact immutable sources.',[first.reference,second.reference])},`exact-${randomUUID()}`);
    expect(exact.reportStatus).toBe('REJECTED');

    const undeclared=await participant('No-intent researcher');
    await expect(service.submitWitness(undeclared.context,assignmentId,{leaseEpoch:undeclared.claim.leaseEpoch!,witness,
      investigation:investigation('Attempt a retrospective citation.',[first.reference])},`retrospective-${randomUUID()}`))
      .rejects.toMatchObject({code:'VALIDATION'});
  }, 30_000);

  it('preserves clients that omit Motive references and enforces the database guard against direct bypass', async () => {
    const legacy=await participant('Legacy researcher');
    const legacySubmission=await service.submitWitness(legacy.context,assignmentId,
      {leaseEpoch:legacy.claim.leaseEpoch!,witness},`legacy-${randomUUID()}`);
    expect(legacySubmission.reportStatus).toBe('REJECTED');
    const declared=await participant('Legacy intent researcher');
    await service.declareAssignmentIntent(declared.context,assignmentId,
      intent(declared.claim.leaseEpoch!),`declare-${randomUUID()}`);
    const activeIntent=(await getPublic<ParticipationPublicProjection>('/')).activeResearchIntents
      ?.find(item=>item.claimId===declared.claim.claimId);
    expect(activeIntent).toBeDefined();
    expect(activeIntent).not.toHaveProperty('motiveReferences');
    const declaredSubmission=await service.submitWitness(declared.context,assignmentId,{leaseEpoch:declared.claim.leaseEpoch!,witness,
      investigation:investigation('Submit without any Motive reference.')},`submit-${randomUUID()}`);
    const publicClaimIntent=(await service.publicInvestigation(declaredSubmission.id)).claimIntent;
    expect(publicClaimIntent).not.toHaveProperty('researchContext');
    expect(publicClaimIntent).not.toHaveProperty('researchReferences');
    expect(publicClaimIntent).not.toHaveProperty('motiveReferences');

    const retained=await source('Database-guard source');
    const malformed=await participant('Database malformed bypass');
    await expect(directIntentInsert(malformed.context,malformed.claim.leaseEpoch!,malformed.claim.claimId!,[]))
      .rejects.toThrow(/motive reference|invalid/i);
    const mismatched=await participant('Database mismatch bypass');
    await expect(directIntentInsert(mismatched.context,mismatched.claim.leaseEpoch!,mismatched.claim.claimId!,
      [{...retained.reference,reportDigest:digest('9')}])).rejects.toThrow(/motive reference|match|invalid/i);
    const finalMismatch=await participant('Database final mismatch bypass');
    await service.declareAssignmentIntent(finalMismatch.context,assignmentId,
      intent(finalMismatch.claim.leaseEpoch!,[retained.reference]),`declare-${randomUUID()}`);
    await expect(directSubmissionInsert(finalMismatch.context,finalMismatch.claim.claimId!,finalMismatch.claim.leaseEpoch!,
      [{...retained.reference,artifactDigest:digest('7')}])).rejects.toThrow(/Motive references must equal/i);
  }, 30_000);

  async function directIntentInsert(context: ParticipationAgentContext, leaseEpoch: number, claimId: string, motiveReferences: unknown) {
    return pool.query(`INSERT INTO motive.participation_claim_intents
      (claim_id,project_id,work_order_id,work_order_revision,work_order_terms_digest,lease_epoch,agent_token_id,
       proposal,expectation,conditions,research_context,research_references,motive_references,request_digest)
      SELECT claim.id,claim.project_id,claim.work_order_id,work.revision,work.terms_digest,$2,$3,
       'Direct bypass proposal.','Direct bypass expectation.',ARRAY['Direct bypass condition.'],NULL,NULL,$4::jsonb,$5
      FROM motive.work_claims claim JOIN motive.work_orders work ON work.id=claim.work_order_id WHERE claim.id=$1`,
    [claimId,leaseEpoch,context.tokenId,JSON.stringify(motiveReferences),digest('8')]);
  }

  async function directSubmissionInsert(context: ParticipationAgentContext, claimId: string, leaseEpoch: number,
    motiveReferences: MotiveReference[]) {
    const provenance={investigation:{attribution:{kind:'AGENT_DECLARED'},
      investigation:investigation('Attempt a direct final-reference mismatch.',motiveReferences)}};
    return pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      SELECT $1,claim.project_id,claim.work_order_id,work.revision,'EXTERNAL',claim.operator_actor_id,claim.id,$3,
       'motive.submission/0.1',$4,$5,$6::jsonb,'unmetered_external',token.license_acceptance_ref,'REJECTED'
      FROM motive.work_claims claim JOIN motive.work_orders work ON work.id=claim.work_order_id
      JOIN motive.participation_agent_tokens token ON token.id=$7 WHERE claim.id=$2`,
    [randomUUID(),claimId,leaseEpoch,'0'.repeat(40),digest('6'),JSON.stringify(provenance),context.tokenId]);
  }

  async function foreignArtifact(): Promise<MotiveReference> {
    const foreignIssuer=`operator:foreign-${randomUUID()}`;
    const foreignProject=(await new LedgerKernel(pool).createProject({actorId:foreignIssuer,idempotencyKey:randomUUID(),
      slug:`foreign-${randomUUID()}`,visibility:'PUBLIC',revisionContent:{title:'Foreign reference project'}})).id;
    const original=(await pool.query('SELECT * FROM motive.work_orders WHERE id=$1',[assignmentId])).rows[0];
    const foreignWorkId=randomUUID();
    const terms={...(original.terms as Record<string,unknown>),project_id:foreignProject};
    const termsDigest=digestCanonicalJson(terms);
    await pool.query(`INSERT INTO motive.work_orders(id,project_id,work_order_key,revision,project_revision,terms_format,terms,terms_digest,created_by)
      VALUES($1,$2,'foreign-reference',1,1,'motive.work-order/0.1',$3::jsonb,$4,$5)`,
    [foreignWorkId,foreignProject,JSON.stringify(terms),termsDigest,foreignIssuer]);
    await pool.query(`INSERT INTO motive.work_order_states(work_order_id,state,state_revision,updated_by)
      VALUES($1,'READY',1,$2)`,[foreignWorkId,foreignIssuer]);
    const tokenId=randomUUID(),owner=`account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,public_display_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'Foreign source','Foreign source',$4,$5,'foreign-test',clock_timestamp()+interval '1 day')`,
    [tokenId,foreignProject,owner,digest('e'),'e'.repeat(12)]);
    const claimId=randomUUID();
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at,released_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'RELEASED',clock_timestamp()+interval '1 day',clock_timestamp())`,
    [claimId,foreignProject,foreignWorkId,`agent:${tokenId}`,termsDigest]);
    const submissionId=randomUUID(),artifactDigest=digest('f'),reportDigest=digest('0');
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      VALUES($1,$2,$3,1,'EXTERNAL',$4,$5,1,'motive.submission/0.1',$6,$7,'{}'::jsonb,'unmetered_external','foreign-test','REJECTED')`,
    [submissionId,foreignProject,foreignWorkId,`agent:${tokenId}`,claimId,'0'.repeat(40),digest('d')]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,report_digest)
      VALUES($1,$2,$3,'motive.csqv.witness.v1',$4,$5,'REJECTED','{}'::jsonb,$6)`,
    [submissionId,foreignProject,tokenId,Buffer.from(witness),artifactDigest,reportDigest]);
    return {submissionId,reportDigest,artifactDigest};
  }
});
