import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import type { ResearchContextSnapshot } from '../../src/lib/research-memory.ts';
import {
  createProjectRunResearchContextResolver,
} from '../../server/project-runs/research-context.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const integration = baseUrl ? describe : describe.skip;
const date = '2026-09-07T10:00:00.000Z';
const profileDigest = `sha256:${'a'.repeat(64)}` as const;
const hash = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const retainedBody = (promptText: string) => JSON.parse(promptText.split('RETAINED_RESEARCH_CONTEXT_JSON=')[1]!);

integration('frozen project-run research context on isolated PostgreSQL', () => {
  const databaseName = `motive_run_context_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let attempt: AttemptProjection;
  let ledger: LedgerKernel;
  let grantId: string;
  let workId: string;
  let scopeId: string;
  let snapshot: ResearchContextSnapshot;
  const actorId = `operator:research-run-${randomUUID()}`;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(source.hostname) || source.port !== '55439' || source.search || source.hash) {
      throw new Error('Research-context integration tests require the local PostgreSQL test authority.');
    }
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool);
    await ledger.setControllerSpending({ actorId, idempotencyKey: randomUUID(), enabled: true,
      reason: 'Enable only this disposable research-context database.' });
    const project = await ledger.createProject({ actorId, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Isolated research run' } });
    const sourceAccount = await ledger.createFundingSource({ actorId, idempotencyKey: randomUUID(), authorizedAmount: '1', metadata: {} });
    const grant = await ledger.createGrant({ actorId, idempotencyKey: randomUUID(), sourceId: sourceAccount.id,
      projectId: project.id, limitAmount: '1' });
    const work = await ledger.createWorkOrder({ actorId, idempotencyKey: randomUUID(), projectId: project.id,
      workOrderKey: `research-${randomUUID()}`, revision: 1, state: 'READY', terms: {
        format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1, agreement_id: `agreement:${randomUUID()}`,
        objective: 'Use retained research data for a bounded exact-data attempt.', input_commit: 'b'.repeat(40),
        allowed_effects: ['read-approved-inputs', 'write-isolated-workspace', 'submit-data-only-witness'],
        hosted: { enabled: true, inference: { currency: 'USD', ceiling: '0.1', profile_digest: profileDigest }, maximum_runtime_seconds: 120 },
        external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 60,
          late_submission_policy: 'reject', review_admission: 'manual',
          artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
        evaluation: { profile_digest: `sha256:${'c'.repeat(64)}`, human_acceptance_required: true },
      } });
    attempt = await ledger.reserveAttempt({ actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: work.id,
      ceilingAmount: '0.1', profileDigest, inputDigest: `sha256:${'d'.repeat(64)}` });
    grantId = grant.id; workId = work.id;
    scopeId = randomUUID();
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'circle-packing','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,$11)`, [scopeId,project.id,randomUUID(),randomUUID(),`sha256:${'e'.repeat(64)}`,
      Buffer.alloc(48, 7),`sha256:${'f'.repeat(64)}`,`sha256:${'1'.repeat(64)}`,'7'.repeat(40),actorId,date]);
    const hypothesisId = randomUUID();
    const evidenceId = randomUUID();
    const payload = { format: 'motive.research-context.v1' as const, scopeId, projectSlug: 'circle-packing',
      channelName: 'circle-packing', channelGoal: 'Retain both positive and negative exact results.',
      hypotheses: [{ id:hypothesisId,updatedAt:date,contentDigest:`sha256:${'2'.repeat(64)}`,statement:'A move may improve the sum.',
        context:'A bounded proposal.',falsificationCriteria:'The exact checker rejects it.',status:'testing',confidence:0.5,parentId:null,
        outcome:null,evidence:[{id:evidenceId,createdAt:date,contentDigest:`sha256:${'3'.repeat(64)}`,content:'Prior overlap.',source:null,
          evidenceType:'contradicting' as const,strength:1,confidenceAfter:0.2,createdBy:'agent'}],evidenceTotal:1,evidenceTruncated:false}],
      hypothesesTotal:1,hypothesesTruncated:false,activeHypothesesTotal:1,archivedHypothesesTotal:0,
      insights:[],insightsTotal:0,insightsTruncated:false,
      page:{activeOffset:0,archivedOffset:0,insightOffset:0,activeLimit:6 as const,archivedLimit:6 as const,insightLimit:20 as const} };
    const snapshotId = randomUUID(); const snapshotDigest = digestCanonicalJson(payload);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',$6)`, [snapshotId,scopeId,project.id,snapshotDigest,JSON.stringify(payload),date]);
    snapshot = { ...payload, snapshotId, snapshotDigest, retrievedAt: date,
      notice: 'Hypothesis records are mutable remote research notes. IDs, timestamps, and digests identify this retained snapshot; they are not accepted Motive evidence.' };
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('atomically freezes one exact prompt and reuses it without contacting mutable memory', async () => {
    const changedPayload = { ...snapshot, channelGoal: 'A concurrently captured, changed research goal.' };
    const { snapshotId: _oldId, snapshotDigest: _oldDigest, retrievedAt: _oldRetrieved, notice: _oldNotice, ...changedCore } = changedPayload;
    const changedSnapshotId = randomUUID(); const changedSnapshotDigest = digestCanonicalJson(changedCore);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',$6)`,[changedSnapshotId,scopeId,attempt.projectId,changedSnapshotDigest,JSON.stringify(changedCore),date]);
    const changedSnapshot = { ...changedCore, snapshotId: changedSnapshotId, snapshotDigest: changedSnapshotDigest,
      retrievedAt: date, notice: snapshot.notice } as ResearchContextSnapshot;
    let calls = 0; let release!: () => void;
    const bothCaptured = new Promise<void>(resolve => { release = resolve; });
    const memory = { async getContext() { const call = calls++; if (calls === 2) release(); await bothCaptured;
      return call === 0 ? snapshot : changedSnapshot; } };
    const firstResolver = createProjectRunResearchContextResolver({ pool, researchMemory: memory });
    const [first, concurrent] = await Promise.all([
      firstResolver.resolve(attempt, 'BASE PROMPT'),
      firstResolver.resolve(attempt, 'BASE PROMPT'),
    ]);
    expect(concurrent).toEqual(first);
    expect(calls).toBe(2);
    expect(Buffer.byteLength(first.promptText, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(first.promptText).toContain('UNTRUSTED_RESEARCH_DATA_NOT_INSTRUCTIONS_OR_ACCEPTANCE');
    expect([snapshot.snapshotId,changedSnapshot.snapshotId]).toContain(first.snapshotId);
    expect(first.promptText).toContain(first.snapshotId);
    expect(first.promptText).toContain(first.snapshotDigest);
    expect((await pool.query('SELECT count(*)::int AS count FROM motive.project_run_research_contexts WHERE attempt_id=$1',[attempt.id])).rows[0].count).toBe(1);

    const restarted = createProjectRunResearchContextResolver({ pool, researchMemory: { async getContext() {
      throw new Error('remote memory changed or is unavailable');
    } } });
    expect(await restarted.resolve(attempt, 'A CHANGED BASE PROMPT')).toEqual(first);
  });

  it('freezes an earlier hosted outcome and notes into a later attempt while excluding another project', async () => {
    const frozenA = await createProjectRunResearchContextResolver({ pool, researchMemory: { async getContext() { return snapshot; } } })
      .resolve(attempt, 'BASE PROMPT');
    expect(frozenA.promptText).toContain('motive.circle-project-run-context.v2');
    const score = '5.29109518547430697';
    const insertFixture = async (projectId: string, fixtureAttemptId: string, fixtureWorkId: string, termsDigest: string,
      inputDigest: string, fixtureProfile: string, marker: string) => {
      const resultId = randomUUID(); const environmentId = randomUUID();
      const manifest = `sha256:${marker.repeat(64)}`; const candidate = `sha256:${marker.toUpperCase().toLowerCase().repeat(64)}`;
      const evaluation = `sha256:${'c'.repeat(64)}`;
      const report = { format:'motive.csqv.evaluator-report/0.1', outcome:'VALID', binding:{ project_id:projectId,
        work_order_id:fixtureWorkId,attempt_id:fixtureAttemptId,worker_environment_id:environmentId,terms_digest:termsDigest,
        input_digest:inputDigest,inference_profile_digest:fixtureProfile,artifact_manifest_digest:manifest,
        candidate_digest:candidate,evaluation_profile_digest:evaluation }, result:{ok:true,report:{objective:{exact_decimal:score,
          versus_frozen_reference_5_29109518547430697:'equal'}}}, human_acceptance:{status:'PENDING',decision_id:null} };
      const reportBytes = Buffer.from(JSON.stringify(report)); const reportDigest = `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`;
      const notes = { format:'motive.investigation.v1',proposal:`proposal-${marker}`,expectation:'match the frozen reference',
        conditions:['exact checker'],observations:['valid non-improvement'],assessment:`Interpretation only: baseline reproduced.${'\"\\n🧪'.repeat(1_000)}`,
        nextAction:'Try another bounded move.' };
      const notesBytes = Buffer.from(JSON.stringify(notes)); const notesDigest = `sha256:${createHash('sha256').update(notesBytes).digest('hex')}`;
      const client = await pool.connect();
      try {
        // This fixture targets immutable context selection, not hosted ingestion: actual project/work/attempt bindings are used,
        // while replication role bypasses provider-activation and artifact-seal prerequisites covered by circle-results tests.
        await client.query(`SET session_replication_role='replica'`);
        await client.query(`INSERT INTO motive.hosted_circle_results(id,project_id,work_order_id,attempt_id,artifact_environment_id,
          artifact_manifest_digest,artifact_receipt_id,candidate_relative_path,candidate_media_type,candidate_object_key,candidate_digest,
          terms_digest,input_digest,inference_profile_digest,evaluation_profile_digest,model_id,research_actor_id,report_bytes,report_digest,
          report_body,status,exact_score,exceeds_reference,artifact_available)
          VALUES($1,$2,$3,$4,$5,$6,$7,'candidate.json','application/json',$8,$9,$10,$11,$12,$13,'openai/gpt-6-astra','account:test',
            $14,$15,$16::jsonb,'VALID',$17,false,true)`, [resultId,projectId,fixtureWorkId,fixtureAttemptId,environmentId,manifest,
          `receipt:${marker}`,`fixture/${marker}`,candidate,termsDigest,inputDigest,fixtureProfile,evaluation,reportBytes,reportDigest,JSON.stringify(report),score]);
        await client.query(`INSERT INTO motive.hosted_circle_investigations(result_id,project_id,attempt_id,artifact_environment_id,
          artifact_manifest_digest,investigation_relative_path,investigation_media_type,investigation_object_key,investigation_digest,
          investigation_bytes,investigation_body,status,validation_code,model_id,inference_profile_digest)
          VALUES($1,$2,$3,$4,$5,'investigation.json','application/json',$6,$7,$8,$9::jsonb,'VALID','VALID','openai/gpt-6-astra',$10)`,
        [resultId,projectId,fixtureAttemptId,environmentId,manifest,`fixture/notes/${marker}`,notesDigest,notesBytes,JSON.stringify(notes),fixtureProfile]);
      } finally { await client.query(`SET session_replication_role='origin'`).catch(() => undefined); client.release(); }
      return resultId;
    };
    const resultA = await insertFixture(attempt.projectId,attempt.id,workId,attempt.termsDigest,attempt.inputDigest,attempt.profileDigest,'4');
    await ledger.closeAttempt({actorId,idempotencyKey:randomUUID(),attemptId:attempt.id});
    const externalWork = await ledger.createWorkOrder({actorId,idempotencyKey:randomUUID(),projectId:attempt.projectId,
      workOrderKey:'external-learning',revision:1,state:'READY',terms:{format:'motive.work-order/0.1',project_id:attempt.projectId,
        project_revision:1,agreement_id:`agreement:${randomUUID()}`,objective:'Retain a checked external non-improvement.',input_commit:'f'.repeat(40),
        allowed_effects:['submit-data-only-witness'],hosted:{enabled:true,inference:{currency:'USD',ceiling:'0.1',profile_digest:profileDigest},maximum_runtime_seconds:120},external:{enabled:true,
          claim_required:true,max_active_claims:1,max_lease_seconds:300,late_submission_policy:'reject',review_admission:'manual',
          artifact:{formats:['motive.csqv.witness.v1'],max_bytes:32768,license_acceptance_required:true}},
        evaluation:{profile_digest:`sha256:${'c'.repeat(64)}`,human_acceptance_required:true}}});
    const tokenId=randomUUID(); const claimId=randomUUID(); const externalSubmissionId=randomUUID();
    const externalNotes={attribution:{kind:'AGENT_DECLARED',agentName:'external-test-agent',modelName:'external-model'},
      investigation:{format:'motive.investigation.v1',proposal:'external proposal',expectation:'test locally',conditions:['bounded'],
        observations:['non-improving'],assessment:'declared interpretation',nextAction:'revise'},interpretationStatus:'AGENT_DECLARED_UNVERIFIED'};
    const witness=Buffer.from('{}'); const witnessDigest=`sha256:${createHash('sha256').update(witness).digest('hex')}`;
    const externalReport={format:'motive.external-test-report/0.1',localOnly:true}; const externalReportDigest=digestCanonicalJson(externalReport);
    await pool.query(`INSERT INTO motive.participation_agent_tokens(id,project_id,owner_actor_id,agent_name,model_name,token_digest,
      token_hint,license_acceptance_ref,expires_at) VALUES($1,$2,$3,'external-test-agent','external-model',$4,'abcdef123456','test-license',
      clock_timestamp()+interval '1 hour')`,[tokenId,attempt.projectId,`account:${randomUUID()}`,`sha256:${'a'.repeat(64)}`]);
    await pool.query(`INSERT INTO motive.work_claims(id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,
      expires_at) VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'ACTIVE',clock_timestamp()+interval '5 minutes')`,
    [claimId,attempt.projectId,externalWork.id,`agent:${tokenId}`,externalWork.termsDigest]);
    await pool.query(`INSERT INTO motive.submissions(id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,
      format,base_commit,artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      VALUES($1,$2,$3,1,'EXTERNAL',$4,$5,1,'motive.submission/0.1',$6,$7,$8::jsonb,'unmetered_external','test-license','PENDING_EVALUATION')`,
    [externalSubmissionId,attempt.projectId,externalWork.id,`agent:${tokenId}`,claimId,'f'.repeat(40),`sha256:${'b'.repeat(64)}`,
      JSON.stringify({agent_name:'external-test-agent',model_name:'external-model',investigation:externalNotes})]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts(submission_id,project_id,agent_token_id,witness_format,witness_bytes,
      witness_digest,report,report_body,report_digest,exact_score,exceeds_reference,contributor_display_name)
      VALUES($1,$2,$3,'motive.csqv.witness.v1',$4,$5,'VALID',$6::jsonb,$7,$8,false,'External tester')`,
    [externalSubmissionId,attempt.projectId,tokenId,witness,witnessDigest,JSON.stringify(externalReport),externalReportDigest,score]);
    const solverSource = Buffer.from('candidate branch 🧪\n'.repeat(100));
    const trialResults = Buffer.from('prior condition → non-improving observation\n'.repeat(80));
    const solverSourceDigest = hash(solverSource); const trialResultsDigest = hash(trialResults);
    await pool.query(`INSERT INTO motive.participation_submission_reproducibility
      (submission_id,project_id,agent_token_id,report_digest,solver_source_bytes,solver_source_digest,
       trial_results_bytes,trial_results_digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [externalSubmissionId,attempt.projectId,tokenId,externalReportDigest,solverSource,solverSourceDigest,
      trialResults,trialResultsDigest,hash('research-context-repro-request')]);
    const other = await ledger.createProject({ actorId,idempotencyKey:randomUUID(),slug:`other-${randomUUID()}`,visibility:'PUBLIC',revisionContent:{title:'Other'} });
    const otherWork = await ledger.createWorkOrder({ actorId,idempotencyKey:randomUUID(),projectId:other.id,workOrderKey:'other',revision:1,state:'READY',terms:{
      format:'motive.work-order/0.1',project_id:other.id,project_revision:1,agreement_id:`agreement:${randomUUID()}`,objective:'other',input_commit:'e'.repeat(40),
      allowed_effects:['submit-data-only-witness'],hosted:{enabled:true,inference:{currency:'USD',ceiling:'0.1',profile_digest:profileDigest},maximum_runtime_seconds:120},
      external:{enabled:false,claim_required:false,max_active_claims:1,max_lease_seconds:60,late_submission_policy:'reject',review_admission:'manual',artifact:{formats:['motive.csqv.witness.v1'],max_bytes:32768,license_acceptance_required:true}},
      evaluation:{profile_digest:`sha256:${'c'.repeat(64)}`,human_acceptance_required:true} } });
    const otherSource = await ledger.createFundingSource({actorId,idempotencyKey:randomUUID(),authorizedAmount:'1',metadata:{}});
    const otherGrant = await ledger.createGrant({actorId,idempotencyKey:randomUUID(),sourceId:otherSource.id,projectId:other.id,limitAmount:'1'});
    const otherAttempt = await ledger.reserveAttempt({actorId,idempotencyKey:randomUUID(),grantId:otherGrant.id,workOrderId:otherWork.id,
      ceilingAmount:'0.1',profileDigest,inputDigest:`sha256:${'5'.repeat(64)}`});
    const otherResult = await insertFixture(other.id,otherAttempt.id,otherWork.id,otherWork.termsDigest,otherAttempt.inputDigest,profileDigest,'6');
    const attemptB = await ledger.reserveAttempt({actorId,idempotencyKey:randomUUID(),grantId,workOrderId:workId,ceilingAmount:'0.1',
      profileDigest,inputDigest:`sha256:${'7'.repeat(64)}`});
    const resolver = createProjectRunResearchContextResolver({pool,researchMemory:{async getContext(){return snapshot;}}});
    const first = await resolver.resolve(attemptB,'LATER PROMPT');
    expect(Buffer.byteLength(first.promptText,'utf8')).toBeLessThanOrEqual(16_384);
    expect(first.promptText).toContain(resultA); expect(first.promptText).toContain('valid non-improvement');
    expect(first.promptText).toContain(externalSubmissionId); expect(first.promptText).toContain('EXTERNAL_PROTECTED_LOCAL_CHECKER');
    expect(first.promptText).toContain('provenanceDigest'); expect(first.promptText).toContain('external proposal');
    expect(first.promptText).not.toContain(otherResult);
    expect(first.promptText).toContain('choose one evidence-linked branch');
    expect(first.promptText).toContain('checkpoint on a result, stall, authority change, or budget boundary');
    const firstBody = retainedBody(first.promptText);
    const reproducibility = firstBody.motiveFindings.findings
      .map((finding: { reproducibility: unknown }) => finding.reproducibility).filter(Boolean);
    expect(reproducibility).toHaveLength(1);
    expect(reproducibility[0]).toMatchObject({ projectId: attempt.projectId, submissionId: externalSubmissionId,
      reportDigest: externalReportDigest, excerptsOmittedForByteBudget: false,
      files: [
        { role: 'SOLVER_SOURCE', fullBytes: solverSource.length, fullDigest: solverSourceDigest, excerptTruncated: true },
        { role: 'TRIAL_RESULTS', fullBytes: trialResults.length, fullDigest: trialResultsDigest, excerptTruncated: true },
      ] });
    for (const file of reproducibility[0].files) {
      expect(Buffer.byteLength(file.excerpt, 'utf8')).toBeLessThanOrEqual(1_024);
      expect(file.downloadHref).toBe(`/api/public/projects/circle-packing/submissions/${externalSubmissionId}/reproducibility/${file.name}`);
    }
    expect(reproducibility[0].notice).toContain('not a runnable program or proof of reproducibility');
    await ledger.closeAttempt({actorId,idempotencyKey:randomUUID(),attemptId:attemptB.id});
    const lateAttempt = await ledger.reserveAttempt({actorId,idempotencyKey:randomUUID(),grantId,workOrderId:workId,ceilingAmount:'0.1',
      profileDigest,inputDigest:`sha256:${'8'.repeat(64)}`});
    const lateResult = await insertFixture(attempt.projectId,lateAttempt.id,workId,lateAttempt.termsDigest,lateAttempt.inputDigest,lateAttempt.profileDigest,'8');
    const replay = await createProjectRunResearchContextResolver({pool,researchMemory:{async getContext(){throw new Error('must not refetch');}}})
      .resolve(attemptB,'CHANGED');
    expect(replay).toEqual(first); expect(replay.promptText).not.toContain(lateResult);

    await ledger.closeAttempt({actorId,idempotencyKey:randomUUID(),attemptId:lateAttempt.id});
    const bytePressureAttempt = await ledger.reserveAttempt({actorId,idempotencyKey:randomUUID(),grantId,workOrderId:workId,
      ceilingAmount:'0.1',profileDigest,inputDigest:`sha256:${'a'.repeat(64)}`});
    const pressure = await resolver.resolve(bytePressureAttempt,'B'.repeat(5_000));
    const pressureBody = retainedBody(pressure.promptText);
    expect(Buffer.byteLength(pressure.promptText,'utf8')).toBeLessThanOrEqual(16_384);
    expect(Buffer.byteLength(JSON.stringify(pressureBody),'utf8')).toBeLessThanOrEqual(12_000);
    expect(pressure.promptText).toContain(resultA);
    expect(pressure.promptText).toContain(externalSubmissionId);
    expect(pressure.promptText).toContain('external proposal');
    expect(pressureBody.motiveFindings.findings).toHaveLength(3);
    expect(pressureBody.motiveFindings.omissions.dueToByteLimit).toBe(0);
    expect(pressureBody.motiveFindings.omissions.reproducibilityPackagesOmittedForByteLimit).toBe(1);
    expect(pressureBody.motiveFindings.findings
      .find((finding: { identity: { submissionId?: string } }) => finding.identity.submissionId === externalSubmissionId).reproducibility).toBeNull();
    await ledger.closeAttempt({actorId,idempotencyKey:randomUUID(),attemptId:bytePressureAttempt.id});

    const legacyAttempt = await ledger.reserveAttempt({actorId,idempotencyKey:randomUUID(),grantId,workOrderId:workId,ceilingAmount:'0.1',
      profileDigest,inputDigest:`sha256:${'9'.repeat(64)}`});
    const legacyBody = {format:'motive.circle-research-context-excerpt.v1',legacy:true};
    const legacyBytes = Buffer.from(JSON.stringify(legacyBody)); const legacyContextDigest = digestCanonicalJson(legacyBody);
    const legacyPrompt = 'ORIGINAL LEGACY PROMPT'; const legacyPromptDigest = `sha256:${createHash('sha256').update(legacyPrompt).digest('hex')}`;
    await pool.query(`INSERT INTO motive.project_run_research_contexts(attempt_id,project_id,work_order_id,terms_digest,input_digest,
      inference_profile_digest,scope_id,snapshot_id,snapshot_digest,context_bytes,context_digest,context_body,prompt_text,prompt_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,[legacyAttempt.id,legacyAttempt.projectId,legacyAttempt.workOrderId,
      legacyAttempt.termsDigest,legacyAttempt.inputDigest,legacyAttempt.profileDigest,scopeId,snapshot.snapshotId,snapshot.snapshotDigest,
      legacyBytes,legacyContextDigest,JSON.stringify(legacyBody),legacyPrompt,legacyPromptDigest]);
    const legacy = await createProjectRunResearchContextResolver({pool,researchMemory:{async getContext(){throw new Error('legacy must not refetch');}}})
      .resolve(legacyAttempt,'CHANGED LEGACY BASE');
    expect(legacy.promptText).toBe(legacyPrompt);
  });

  it('fails closed after the connected scope is replaced', async () => {
    const replacementId = randomUUID();
    const client = await pool.connect(); await client.query('BEGIN');
    try {
      const projectId = attempt.projectId;
      await client.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
        channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
        api_version,inspected_source_revision,status,bound_by,verified_at)
        SELECT $1,project_id,provider,api_base_url,$2,$3,channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,
          $4,$5,api_version,inspected_source_revision,'REPLACEMENT_PENDING',bound_by,verified_at
        FROM motive.project_research_scopes WHERE id=$6 AND project_id=$7`,
      [replacementId,randomUUID(),randomUUID(),`sha256:${'8'.repeat(64)}`,`sha256:${'9'.repeat(64)}`,scopeId,projectId]);
      await client.query("UPDATE motive.project_research_scopes SET status='REPLACED',replaced_at=clock_timestamp(),replaced_by=$2 WHERE id=$1",[scopeId,replacementId]);
      await client.query("UPDATE motive.project_research_scopes SET status='CONNECTED' WHERE id=$1",[replacementId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const resolver = createProjectRunResearchContextResolver({ pool, researchMemory: { async getContext() { return snapshot; } } });
    await expect(resolver.resolve(attempt, 'BASE PROMPT')).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
  });
});
