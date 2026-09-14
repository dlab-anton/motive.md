import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson, type WorkOrderTerms } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';
import { createResearchMemoryService, type ResearchMemoryService } from '../../server/research-memory/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('trusted Motive submissions in research context on isolated PostgreSQL', () => {
  const databaseName = `motive_research_submission_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:research-submission-${randomUUID()}`;
  const owner = `account:${randomUUID()}`;
  const reviewer = `account:${randomUUID()}`;
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const mappedHypothesisId = randomUUID();
  const staleScopeHypothesisId = randomUUID();
  const foreignProjectHypothesisId = randomUUID();
  const spoofedHypothesisId = randomUUID();
  const originalUpdatedAt = '2026-09-08T08:00:00.000Z';
  let mappedStatement = 'A complete candidate may improve after correcting the rejected witness shape.';
  let mappedUpdatedAt = originalUpdatedAt;
  let admin: Pool;
  let pool: Pool;
  let research: ResearchMemoryService;
  let batchResearch: ResearchMemoryService;
  let participation: ParticipationService;
  let context: ParticipationAgentContext;
  let submissionId: string;
  let reportDigest: string;
  let currentScopeId: string;
  let currentDeliveryId: string;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200,
    headers: { 'content-type': 'application/json' } });
  const hypothesis = (id: string, statement: string, updatedAt = originalUpdatedAt, metadata: unknown = null) => ({ id,
    statement, context: null, falsification_criteria: 'The protected checker rejects the candidate.', status: 'draft',
    confidence: null, parent_id: null, is_archived: false, outcome: null, channel: 'circle-packing',
    evidence_counts: { supporting: 0, contradicting: 0, neutral: 0 },
    created_at: originalUpdatedAt, updated_at: updatedAt, metadata });
  const activeHypotheses = () => [
    hypothesis(mappedHypothesisId, mappedStatement, mappedUpdatedAt),
    hypothesis(staleScopeHypothesisId, 'This ID was delivered through a replaced scope.'),
    hypothesis(foreignProjectHypothesisId, 'This ID belongs to another Motive project.'),
    hypothesis(spoofedHypothesisId, 'Remote metadata must not create Motive provenance.', originalUpdatedAt,
      { motiveSubmission: { submissionId, reportDigest }, source_submission_id: submissionId }),
  ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get('X-API-Key');
    if (url.pathname.endsWith('/health')) return json({ status: 'ok', version: '1.8.0', database: 'ok' });
    if (!key || ![`he_${'a'.repeat(43)}`, `he_${'b'.repeat(43)}`, `he_${'c'.repeat(43)}`].includes(key)) {
      return new Response('{}', { status: 401 });
    }
    if (url.pathname.endsWith('/keys')) return json([{ id: randomUUID(), prefix: key.slice(0, 10), tenant_id: tenantId }]);
    if (url.pathname.endsWith('/channels/circle-packing/context')) return json({
      format: 'hypothesis.channel-context.v1',
      channel: { id: channelId, name: 'circle-packing', goal: 'Use retained outcomes to choose the next bounded experiment.',
        created_at: originalUpdatedAt, updated_at: originalUpdatedAt },
      active_hypotheses: { items: activeHypotheses(), total: 4, offset: 0, limit: 6 },
      archived_hypotheses: { items: [], total: 0, offset: 0, limit: 6 },
      insights: { items: [], total: 0, offset: 0, limit: 20 },
      evidence_pages: activeHypotheses().map(item => ({ hypothesis_id: item.id, items: [], total: 0, offset: 0, limit: 20 })),
    });
    if (url.pathname.endsWith('/channels/circle-packing')) return json({ id: channelId, name: 'circle-packing',
      goal: 'Use retained outcomes to choose the next bounded experiment.', created_at: originalUpdatedAt, updated_at: originalUpdatedAt });
    if (url.pathname.endsWith('/hypotheses')) {
      if (url.searchParams.get('is_archived') === 'true') return json({ items: [], total: 0, offset: 0, limit: 6 });
      return json({ items: activeHypotheses(), total: 4, offset: 0, limit: 6 });
    }
    if (/\/hypotheses\/[a-f0-9-]+\/evidence$/.test(url.pathname)) return json({ items: [], total: 0, offset: 0, limit: 20 });
    if (url.pathname.endsWith('/insights')) return json({ items: [], total: 0, offset: 0, limit: 20 });
    return new Response('{}', { status: 404 });
  };

  beforeAll(async () => {
    const adminUrl = new URL(baseUrl!); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl!); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Research submission context test' } });
    research = createResearchMemoryService({ pool, vaultKey: Buffer.alloc(32, 9), fetch: fetcher,
      now: () => new Date('2026-09-08T09:00:00.000Z') });
    batchResearch = createResearchMemoryService({ pool, vaultKey: Buffer.alloc(32, 9), fetch: fetcher,
      contextTransport: 'channel-context-v1', now: () => new Date('2026-09-08T09:00:00.000Z') });
    const oldScope = await research.linkScope(issuer, 'circle-packing', { apiBaseUrl: 'http://127.0.0.1:8000/api/v1',
      tenantId, channelId, channelName: 'circle-packing', apiKey: `he_${'a'.repeat(43)}` });

    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [owner, randomUUID(), reviewer, randomUUID()]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`, [randomUUID(), project.id, reviewer, issuer]);
    participation = createParticipationService(pool, { issuerActorId: issuer,
      tokenSecret: 'research-context-submission-test-secret-longer-than-thirty-two-bytes' });
    const assignmentId = (await participation.ensureCircleWorkOrder()).id;
    const joined = await participation.join(owner, 'Visible experimenter', { projectSlug: 'circle-packing',
      publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    context = await participation.authenticateBearer(joined.token);
    const claim = await participation.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    const submission = await participation.submitWitness(context, assignmentId, { leaseEpoch: claim.leaseEpoch!,
      witness: '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}', investigation: {
        format: 'motive.investigation.v1', proposal: 'Check an intentionally incomplete candidate.',
        expectation: 'The protected checker rejects the missing circles.', conditions: ['Use the bounded checker.'],
        observations: ['The candidate was rejected.'], assessment: 'The generator did not create all required circles.',
        nextAction: 'Repair the generator and create a new candidate.' } }, `submit-${randomUUID()}`);
    submissionId = submission.id;
    reportDigest = String((await participation.publicReport(submissionId)).reportDigest);
    await participation.completeAssignment(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, submissionId }, `complete-${randomUUID()}`);
    await seedDelivery(project.id, oldScope.scopeId, submissionId, staleScopeHypothesisId);

    const currentScope = await research.linkScope(issuer, 'circle-packing', { apiBaseUrl: 'http://127.0.0.1:8000/api/v1',
      tenantId, channelId, channelName: 'circle-packing', apiKey: `he_${'b'.repeat(43)}`, replace: true });
    currentScopeId = currentScope.scopeId;
    currentDeliveryId = await seedDelivery(project.id, currentScopeId, submissionId, mappedHypothesisId);

    const foreign = await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: `foreign-${randomUUID()}`, visibility: 'PUBLIC', revisionContent: { title: 'Foreign project' } });
    const foreignScope = await research.linkScope(issuer, foreign.slug, { apiBaseUrl: 'http://127.0.0.1:8000/api/v1',
      tenantId, channelId, channelName: 'circle-packing', apiKey: `he_${'c'.repeat(43)}` });
    const foreignSubmissionId = await externalSubmission(foreign.id);
    await seedDelivery(foreign.id, foreignScope.scopeId, foreignSubmissionId, foreignProjectHypothesisId);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function seedDelivery(projectId: string, scopeId: string, sourceSubmissionId: string, hypothesisId: string) {
    const scope = (await pool.query(`SELECT api_base_url,configuration_digest,api_version FROM motive.project_research_scopes
      WHERE id=$1 AND project_id=$2`, [scopeId, projectId])).rows[0];
    const intentId = randomUUID(); const deliveryId = randomUUID(); const engineActor = `motive:project:${projectId}`;
    const payload = { format: 'motive.hypothesis-writeback-preparation/0.1', disposition: 'PROPOSED_UNREVIEWED',
      state: 'ENGINE_WRITE_UNAVAILABLE', scope: { scopeId, projectId, configurationDigest: scope.configuration_digest,
        apiVersion: scope.api_version }, attribution: { engineActor }, source: { submission: { id: sourceSubmissionId } },
      assessment: { hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED' } };
    const payloadDigest = digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.hypothesis_writeback_intents
      (id,project_id,scope_id,source_submission_id,prepared_by_actor_id,idempotency_key,request_digest,payload,payload_digest,
       engine_actor,disposition,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'PROPOSED_UNREVIEWED','ENGINE_WRITE_UNAVAILABLE')`,
    [intentId,projectId,scopeId,sourceSubmissionId,issuer,`intent-${randomUUID()}`,digestCanonicalJson({ sourceSubmissionId }),
      JSON.stringify(payload),payloadDigest,engineActor]);
    await pool.query(`INSERT INTO motive.hypothesis_submission_deliveries
      (id,project_id,scope_id,source_submission_id,source_intent_id,source_intent_payload_digest,engine_actor,
       engine_api_base_url,scope_configuration_digest,engine_api_version,reviewed_contract_digest,reviewed_contract_version,
       reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'test-contract',$12,$13,$14)`,
    [deliveryId,projectId,scopeId,sourceSubmissionId,intentId,payloadDigest,engineActor,scope.api_base_url,
      scope.configuration_digest,scope.api_version,`sha256:${'1'.repeat(64)}`,'2'.repeat(64),'3'.repeat(64),issuer]);
    const requestBody = { statement: 'Trusted immutable draft request.' };
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_operations
      (delivery_id,operation,target_hypothesis_id,request_path,idempotency_key,request_body,request_body_digest,request_digest)
      VALUES($1,'DRAFT_HYPOTHESIS',NULL,'/api/v1/hypotheses',$2,$3::jsonb,$4,$5)`,
    [deliveryId,`motive-delivery:${deliveryId}:draft`,JSON.stringify(requestBody),digestCanonicalJson(requestBody),
      digestCanonicalJson({ path: '/api/v1/hypotheses', body: requestBody })]);
    const response = { id: hypothesisId };
    await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_results
      (delivery_id,operation,resource_id,response_body,response_digest) VALUES($1,'DRAFT_HYPOTHESIS',$2,$3::jsonb,$4)`,
    [deliveryId,hypothesisId,JSON.stringify(response),digestCanonicalJson(response)]);
    return deliveryId;
  }

  async function appendAdmission(decision: 'ADMIT'|'DECLINE', rationale: string, previousDecisionId: string|null) {
    const result = await pool.query(`SELECT delivery.*,artifact.report AS report_status,artifact.report_digest,
        artifact.exact_score,artifact.exceeds_reference,assessment.request_digest AS assessment_request_digest,
        assessment.report_digest AS assessment_report_digest,assessment.assessment AS assessment_text,
        assessment.next_action,assessment.public_question,assessment.public_finding,assessment.created_at AS assessment_created_at,
        reproducibility.request_digest AS reproducibility_request_digest,
        reproducibility.solver_source_digest,reproducibility.trial_results_digest,
        draft.request_path,draft.request_body,draft.request_body_digest,draft.request_digest AS draft_request_digest
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      LEFT JOIN motive.participation_submission_reproducibility reproducibility ON reproducibility.submission_id=artifact.submission_id
      JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id AND draft.operation='DRAFT_HYPOTHESIS'
      WHERE delivery.id=$1`, [currentDeliveryId]);
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    const reviewPackage = {
      format: 'motive.research-delivery-review-package/0.1',
      delivery: { id: currentDeliveryId, projectId: String(row.project_id), scopeId: String(row.scope_id),
        sourceSubmissionId: String(row.source_submission_id), sourceIntentId: String(row.source_intent_id),
        sourceIntentPayloadDigest: String(row.source_intent_payload_digest) },
      scope: { configurationDigest: String(row.scope_configuration_digest), apiBaseUrl: String(row.engine_api_base_url),
        apiVersion: String(row.engine_api_version), engineActor: String(row.engine_actor) },
      report: { status: String(row.report_status), digest: String(row.report_digest),
        exactScore: row.exact_score === null ? null : String(row.exact_score),
        exceedsReference: row.exceeds_reference === null ? null : row.exceeds_reference === true },
      postCheck: { requestDigest: String(row.assessment_request_digest), reportDigest: String(row.assessment_report_digest),
        assessment: String(row.assessment_text), nextAction: String(row.next_action),
        ...(row.public_question===null?{}:{publicSummary:{question:String(row.public_question),finding:String(row.public_finding)}}),
        createdAt: (row.assessment_created_at as Date).toISOString() },
      reproducibility: row.reproducibility_request_digest === null ? null : {
        requestDigest: String(row.reproducibility_request_digest), solverSourceDigest: String(row.solver_source_digest),
        trialResultsDigest: String(row.trial_results_digest) },
      contract: { fileDigest: String(row.reviewed_contract_digest), contractVersion: String(row.reviewed_contract_version),
        apiVersion: String(row.engine_api_version), schemaRevision: '017_write_idempotency',
        surfaceDigest: String(row.reviewed_contract_surface_digest), implementationDigest: String(row.reviewed_implementation_digest) },
      assessment: { hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED' },
      operations: { draft: { method: 'POST', path: String(row.request_path), body: row.request_body,
        bodyDigest: String(row.request_body_digest), requestDigest: String(row.draft_request_digest) } },
    };
    const id = randomUUID();
    const saved = await pool.query(`INSERT INTO motive.hypothesis_submission_delivery_admission_decisions
      (id,delivery_id,review_package,review_package_digest,previous_decision_id,decision,reviewer_actor_id,rationale,idempotency_key,request_digest)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING id,created_at`,
    [id,currentDeliveryId,JSON.stringify(reviewPackage),digestCanonicalJson(reviewPackage),previousDecisionId,decision,reviewer,rationale,
      `context-review-${randomUUID()}`,digestCanonicalJson({ currentDeliveryId, previousDecisionId, decision, rationale })]);
    return { id, createdAt: (saved.rows[0].created_at as Date).toISOString() };
  }

  async function externalSubmission(projectId: string): Promise<string> {
    const profileDigest = `sha256:${'4'.repeat(64)}` as `sha256:${string}`;
    const terms: WorkOrderTerms = { format: 'motive.work-order/0.1', project_id: projectId, project_revision: 1,
      agreement_id: `agreement:${randomUUID()}`, objective: 'Retain a foreign checked candidate.', input_commit: 'f'.repeat(40),
      allowed_effects: ['submit-data-only-witness'], hosted: { enabled: false,
        inference: { currency: 'USD', ceiling: '0', profile_digest: profileDigest }, maximum_runtime_seconds: 1 },
      external: { enabled: true, claim_required: true, max_active_claims: 1, max_lease_seconds: 300,
        late_submission_policy: 'reject', review_admission: 'manual', artifact: { formats: ['motive.csqv.witness.v1'],
          max_bytes: 32768, license_acceptance_required: true } },
      evaluation: { profile_digest: profileDigest, human_acceptance_required: true } };
    const work = await new LedgerKernel(pool).createWorkOrder({ actorId: issuer, idempotencyKey: randomUUID(), projectId,
      workOrderKey: 'foreign-external', revision: 1, state: 'READY', terms });
    const tokenId = randomUUID(); const claimId = randomUUID(); const id = randomUUID(); const bytes = Buffer.from('{}');
    const witnessDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; const reportBody = { ok: false };
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'Foreign agent',$4,$5,'foreign-license',clock_timestamp()+interval '1 hour')`,
    [tokenId,projectId,`account:${randomUUID()}`,`sha256:${randomUUID().replaceAll('-','').repeat(2)}`,randomUUID().replaceAll('-','').slice(0,12)]);
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'ACTIVE',clock_timestamp()+interval '5 minutes')`,
    [claimId,projectId,work.id,`agent:${tokenId}`,work.termsDigest]);
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      VALUES($1,$2,$3,1,'EXTERNAL',$4,$5,1,'motive.submission/0.1',$6,$7,'{}'::jsonb,'unmetered_external','foreign-license','REJECTED')`,
    [id,projectId,work.id,`agent:${tokenId}`,claimId,'f'.repeat(40),`sha256:${'5'.repeat(64)}`]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,report_digest)
      VALUES($1,$2,$3,'motive.csqv.witness.v1',$4,$5,'REJECTED',$6::jsonb,$7)`,
    [id,projectId,tokenId,bytes,witnessDigest,JSON.stringify(reportBody),digestCanonicalJson(reportBody)]);
    return id;
  }

  it('adds only trusted current-scope submission provenance with one bounded bulk query', async () => {
    const querySpy = vi.spyOn(pool, 'query');
    const snapshot = await research.getContext('circle-packing');
    const batchSnapshot = await batchResearch.getContext('circle-packing');
    const bulkQueries = querySpy.mock.calls.filter(call => typeof call[0] === 'string'
      && call[0].includes('hypothesis_submission_delivery_results'));
    querySpy.mockRestore();
    const { engineReadCompletedAt: _legacyCompletedAt, ...retainedLegacy } = snapshot;
    const { engineReadCompletedAt: _batchCompletedAt, ...retainedBatch } = batchSnapshot;
    expect(retainedBatch).toEqual(retainedLegacy);
    expect(batchSnapshot.snapshotId).toBe(snapshot.snapshotId);
    expect(batchSnapshot.snapshotDigest).toBe(snapshot.snapshotDigest);
    expect(bulkQueries).toHaveLength(2);
    const mapped = snapshot.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(mapped.motiveSubmission).toMatchObject({ submissionId, reportDigest,
      reportHref: `/api/public/projects/circle-packing/submissions/${submissionId}/report`,
      investigationHref: `/api/public/projects/circle-packing/submissions/${submissionId}/investigation`,
      postCheckAssessmentHref: null, postCheckAssessment: null, reproducibilityHref: null });
    expect(mapped.motiveSubmission).not.toHaveProperty('latestAdmissionReview');
    const { contentDigest, evidence, evidenceTotal, evidenceTruncated, ...digestContent } = mapped;
    expect(contentDigest).toBe(digestCanonicalJson(digestContent));
    expect({ evidence, evidenceTotal, evidenceTruncated }).toEqual({ evidence: [], evidenceTotal: 0, evidenceTruncated: false });
    for (const id of [staleScopeHypothesisId, foreignProjectHypothesisId, spoofedHypothesisId]) {
      expect(snapshot.hypotheses.find(item => item.id === id)).not.toHaveProperty('motiveSubmission');
    }
    expect(JSON.stringify(snapshot)).not.toContain(owner);
    expect(JSON.stringify(snapshot)).not.toContain(tenantId);
    expect(JSON.stringify(snapshot)).not.toContain('source_submission_id');
  });

  it('retains the old snapshot and creates new digests when a post-check assessment arrives or the remote record changes', async () => {
    const before = await research.getContext('circle-packing');
    const beforeRow = (await pool.query(`SELECT payload::text AS payload,snapshot_digest FROM motive.research_context_snapshots
      WHERE id=$1`, [before.snapshotId])).rows[0];
    const assessment = await participation.createPostCheckAssessment(context, submissionId, { reportDigest,
      assessment: 'The rejected shape shows that candidate generation must be fixed before geometry can be evaluated.',
      nextAction: 'Generate all 101 circles, then run a new protected check.',
      publicSummary:{question:'Did this generated shape satisfy the required witness structure?',finding:'The checker rejected the incomplete shape before its geometry could be evaluated.'} }, `assessment-${randomUUID()}`);
    const afterAssessment = await research.getContext('circle-packing');
    const mapped = afterAssessment.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(mapped.motiveSubmission?.postCheckAssessment).toEqual(assessment);
    expect(mapped.motiveSubmission?.postCheckAssessmentHref)
      .toBe(`/api/public/projects/circle-packing/submissions/${submissionId}/post-check-assessment`);
    expect(mapped.contentDigest).not.toBe(before.hypotheses.find(item => item.id === mappedHypothesisId)!.contentDigest);
    expect(afterAssessment.snapshotDigest).not.toBe(before.snapshotDigest);
    expect(afterAssessment.snapshotId).not.toBe(before.snapshotId);

    const admittedDecision = await appendAdmission('ADMIT',
      'Independent review admits this exact checked delivery to shared research memory.', null);
    const afterAdmission = await research.getContext('circle-packing');
    const admittedMapped = afterAdmission.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(admittedMapped.motiveSubmission?.latestAdmissionReview).toEqual({
      decision: 'ADMIT',
      rationale: 'Independent review admits this exact checked delivery to shared research memory.',
      reviewedAt: admittedDecision.createdAt,
      disposition: 'HISTORICAL_DELIVERY_REVIEW',
      hypothesisSupport: 'UNASSESSED',
      conclusionApproval: 'UNASSESSED',
    });
    expect(admittedMapped.contentDigest).not.toBe(mapped.contentDigest);
    expect(afterAdmission.snapshotDigest).not.toBe(afterAssessment.snapshotDigest);
    const admittedRow = (await pool.query(`SELECT payload::text AS payload,snapshot_digest
      FROM motive.research_context_snapshots WHERE id=$1`, [afterAdmission.snapshotId])).rows[0];

    const declinedDecision = await appendAdmission('DECLINE',
      'A later independent correction declines this delivery without judging hypothesis support.', admittedDecision.id);
    const correctionQuerySpy = vi.spyOn(pool, 'query');
    const afterCorrection = await research.getContext('circle-packing');
    const afterCorrectionBatch = await batchResearch.getContext('circle-packing');
    const correctionBulkQueries = correctionQuerySpy.mock.calls.filter(call => typeof call[0] === 'string'
      && call[0].includes('hypothesis_submission_delivery_results'));
    correctionQuerySpy.mockRestore();
    const { engineReadCompletedAt: _legacyCorrectionAt, ...retainedCorrection } = afterCorrection;
    const { engineReadCompletedAt: _batchCorrectionAt, ...retainedBatchCorrection } = afterCorrectionBatch;
    expect(retainedBatchCorrection).toEqual(retainedCorrection);
    expect(correctionBulkQueries).toHaveLength(2);
    const correctedMapped = afterCorrection.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(correctedMapped.motiveSubmission?.latestAdmissionReview).toEqual({
      decision: 'DECLINE',
      rationale: 'A later independent correction declines this delivery without judging hypothesis support.',
      reviewedAt: declinedDecision.createdAt,
      disposition: 'HISTORICAL_DELIVERY_REVIEW',
      hypothesisSupport: 'UNASSESSED',
      conclusionApproval: 'UNASSESSED',
    });
    expect(correctedMapped.contentDigest).not.toBe(admittedMapped.contentDigest);
    expect(afterCorrection.snapshotDigest).not.toBe(afterAdmission.snapshotDigest);
    for (const id of [staleScopeHypothesisId, foreignProjectHypothesisId, spoofedHypothesisId]) {
      expect(afterCorrection.hypotheses.find(item => item.id === id)).not.toHaveProperty('motiveSubmission');
    }
    expect(Number.isFinite(Date.parse(afterAdmission.engineReadCompletedAt!))).toBe(true);
    const { engineReadCompletedAt: _afterAdmissionCompletedAt, ...retainedAfterAdmission } = afterAdmission;
    const exactAfterAdmission = await research.getSnapshot(context.projectId, afterAdmission.snapshotId);
    expect(exactAfterAdmission).toEqual(retainedAfterAdmission);
    expect(exactAfterAdmission).not.toHaveProperty('engineReadCompletedAt');
    expect((await pool.query(`SELECT payload::text AS payload,snapshot_digest
      FROM motive.research_context_snapshots WHERE id=$1`, [afterAdmission.snapshotId])).rows[0]).toEqual(admittedRow);
    expect(admittedRow.payload).not.toContain('engineReadCompletedAt');

    await pool.query(`UPDATE motive.memberships SET revoked_at=clock_timestamp()
      WHERE project_id=$1 AND actor_id=$2`, [context.projectId, reviewer]);
    const afterReviewerRetirement = await research.getContext('circle-packing');
    expect(afterReviewerRetirement.snapshotDigest).toBe(afterCorrection.snapshotDigest);
    expect(afterReviewerRetirement.snapshotId).toBe(afterCorrection.snapshotId);
    expect(afterReviewerRetirement.hypotheses.find(item => item.id === mappedHypothesisId)?.motiveSubmission?.latestAdmissionReview)
      .toEqual(correctedMapped.motiveSubmission?.latestAdmissionReview);
    expect(JSON.stringify(afterReviewerRetirement)).not.toContain(reviewer);
    expect(JSON.stringify(afterReviewerRetirement)).not.toContain(admittedDecision.id);
    expect(JSON.stringify(afterReviewerRetirement)).not.toContain(declinedDecision.id);

    const reproducibility = await participation.createSubmissionReproducibility(context, submissionId, { reportDigest,
      solverSource: 'print("bounded numeric trial")\n', trialResults: 'trial=1 result=rejected\n' }, `reproducibility-${randomUUID()}`);
    const afterReproducibility = await research.getContext('circle-packing');
    const reproducibleMapped = afterReproducibility.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(reproducibleMapped.motiveSubmission?.reproducibilityHref)
      .toBe(`/api/public/projects/circle-packing/submissions/${submissionId}/reproducibility`);
    expect(await participation.publicSubmissionReproducibility(submissionId)).toEqual(reproducibility);
    expect(reproducibleMapped.contentDigest).not.toBe(correctedMapped.contentDigest);
    expect(afterReproducibility.snapshotDigest).not.toBe(afterCorrection.snapshotDigest);
    expect(Number.isFinite(Date.parse(before.engineReadCompletedAt!))).toBe(true);
    const { engineReadCompletedAt: _beforeCompletedAt, ...retainedBefore } = before;
    const exactBefore = await research.getSnapshot(context.projectId, before.snapshotId);
    expect(exactBefore).toEqual(retainedBefore);
    expect(exactBefore).not.toHaveProperty('engineReadCompletedAt');
    const unchangedRow = (await pool.query(`SELECT payload::text AS payload,snapshot_digest FROM motive.research_context_snapshots
      WHERE id=$1`, [before.snapshotId])).rows[0];
    expect(unchangedRow).toEqual(beforeRow);

    mappedStatement = 'The remote draft changed wording while retaining its durable engine hypothesis ID.';
    mappedUpdatedAt = '2026-09-08T10:00:00.000Z';
    const changedRemote = await research.getContext('circle-packing');
    const changedMapped = changedRemote.hypotheses.find(item => item.id === mappedHypothesisId)!;
    expect(changedMapped.motiveSubmission?.submissionId).toBe(submissionId);
    expect(changedMapped.motiveSubmission?.postCheckAssessment).toEqual(assessment);
    expect(changedMapped.motiveSubmission?.reproducibilityHref).toBe(reproducibleMapped.motiveSubmission?.reproducibilityHref);
    expect(changedMapped.motiveSubmission?.latestAdmissionReview).toEqual(correctedMapped.motiveSubmission?.latestAdmissionReview);
    expect(changedMapped.contentDigest).not.toBe(reproducibleMapped.contentDigest);
    expect(changedRemote.snapshotDigest).not.toBe(afterReproducibility.snapshotDigest);
  });
});
