import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { resolveResearchDeliveryTarget as resolveRetainedResearchDeliveryTarget } from '../../server/research-memory/research-delivery-target.ts';
import type { SubmissionInvestigationInput, SubmissionResearchReference } from '../../src/lib/participation.ts';
import type { ResearchDeliveryTargetBinding, ResearchDeliveryTargetSelection } from '../../src/lib/research-delivery-target.ts';
import type { AgentResearchDeliveryCheckpoint, RecoveredFindingCheckpoint } from '../../src/lib/research-delivery-policy.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

pgDescribe('participation research delivery target on isolated PostgreSQL', () => {
  const databaseName = `motive_delivery_target_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:delivery-target-${randomUUID()}`;
  const tokenSecret = 'research-delivery-target-test-secret-longer-than-thirty-two-bytes';
  let admin: Pool; let pool: Pool; let service: ParticipationService; let assignmentId: string; let witness: string;
  let resolved: ResearchDeliveryTargetSelection[]; let targetSelection: ResearchDeliveryTargetSelection;
  let readyDelivery: AgentResearchDeliveryCheckpoint | null; let recoveredDelivery: RecoveredFindingCheckpoint | null;
  let deliveryChecks: number; let recoveryChecks: number;

  const target = (): ResearchDeliveryTargetSelection => ({ ...targetSelection });
  const reference = (selection: ResearchDeliveryTargetSelection): SubmissionResearchReference => ({
    scopeId: selection.scopeId, snapshotId: selection.snapshotId, snapshotDigest: selection.snapshotDigest,
    hypothesisId: selection.hypothesisId, observedUpdatedAt: selection.observedUpdatedAt, evidenceIds: [] });
  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
    await applyPostgresMigrations(pool); expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    witness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    const projectId = (await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'Delivery target test' } })).id;
    const scopeId=randomUUID(),snapshotId=randomUUID(),hypothesisId=randomUUID(),channelId=randomUUID();
    const observedUpdatedAt='2026-09-13T00:00:00.000Z',statement='Pinned target statement.';
    const hypothesisContentDigest=digest('c');
    const payload={format:'motive.research-context.v1',hypotheses:[{id:hypothesisId,updatedAt:observedUpdatedAt,
      contentDigest:hypothesisContentDigest,statement}]};
    const snapshotDigest=digestCanonicalJson(payload),scopeConfigurationDigest=digest('b');
    targetSelection={mode:'APPEND_EXISTING',scopeId,snapshotId,snapshotDigest,hypothesisId,observedUpdatedAt};
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine','http://127.0.0.1:8000/api/v1',$3,$4,'target-test','{}'::jsonb,$5,$6,$7,$8,
      '1.8.0',$9,'CONNECTED',$10,clock_timestamp())`,[scopeId,projectId,randomUUID(),channelId,digest('e'),
      Buffer.alloc(48,7),digest('f'),scopeConfigurationDigest,'1'.repeat(40),issuer]);
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',clock_timestamp())`,[snapshotId,scopeId,projectId,snapshotDigest,JSON.stringify(payload)]);
    resolved = []; readyDelivery=null; recoveredDelivery=null; deliveryChecks=0; recoveryChecks=0;
    const validateResearchReferences = async (_projectId: string, references: SubmissionResearchReference[]) => {
      if (!references.length) throw new Error('missing references');
    };
    const resolveResearchDeliveryTarget = async (candidateProjectId: string, selection: ResearchDeliveryTargetSelection,
      _client: PoolClient) => {
      expect(candidateProjectId).toBe(projectId); resolved.push(selection);
      return resolveRetainedResearchDeliveryTarget(candidateProjectId,selection,_client);
    };
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer, validateResearchReferences,
      resolveResearchDeliveryTarget,
      nextReadyRecoveredFinding:async()=>{recoveryChecks+=1;return recoveredDelivery;},
      nextReadyResearchDelivery:async()=>{deliveryChecks+=1;return readyDelivery;} });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  async function participant(name: string) {
    const owner = `account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
    const joined = await service.join(owner, name, { projectSlug: 'circle-packing', publishDisplayName: true,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    return { context, claim };
  }

  const investigation = (researchDeliveryTarget?: ResearchDeliveryTargetSelection): SubmissionInvestigationInput => ({
    format: 'motive.investigation.v1', proposal: 'Test a target-bound update.', expectation: 'Retain one result.',
    conditions: ['Use the retained observation.'], observations: ['The bounded test completed.'], assessment: 'Bounded result.',
    nextAction: 'Retain it.', ...(researchDeliveryTarget ? { researchReferences: [reference(researchDeliveryTarget)],
      researchDeliveryTarget } : {}) });

  async function directSubmission(claimId:string,leaseEpoch:number,selection?:ResearchDeliveryTargetSelection){
    const provenance={investigation:{attribution:{kind:'AGENT_DECLARED'},investigation:investigation(selection)}};
    return pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      SELECT $1,claim.project_id,claim.work_order_id,work.revision,'EXTERNAL',claim.operator_actor_id,claim.id,$3,
       'motive.submission/0.1',$4,$5,$6::jsonb,'unmetered_external',token.license_acceptance_ref,'REJECTED'
      FROM motive.work_claims claim JOIN motive.work_orders work ON work.id=claim.work_order_id
      JOIN motive.participation_agent_tokens token ON 'agent:'||token.id::text=claim.operator_actor_id WHERE claim.id=$2`,
    [randomUUID(),claimId,leaseEpoch,'0'.repeat(40),digest('8'),JSON.stringify(provenance)]);
  }

  it('resolves and persists one immutable pre-test binding and requires the exact final selector', async () => {
    const fixture = await participant('Targeted contributor'); const selection = target();
    const refs = [reference(selection),{...reference(selection),hypothesisId:randomUUID()}];
    const declared = await service.declareAssignmentIntent(fixture.context, assignmentId, {
      leaseEpoch: fixture.claim.leaseEpoch!, proposal: 'Test a target-bound update.', expectation: 'Retain one result.',
      conditions: ['Use the retained observation.'], researchReferences: refs, researchDeliveryTarget: selection,
    }, `intent-${randomUUID()}`);
    expect(declared.intent?.researchDeliveryTarget).toEqual(selection); expect(resolved).toEqual([selection]);
    expect((await service.agentWorkQueue(fixture.context)).nextTask.kind).toBe('RESUME');
    expect(deliveryChecks).toBe(0);
    const stored = await pool.query(`SELECT target.binding,target.binding_digest,target.intent_request_digest,target.declared_at,
        intent.request_digest,intent.created_at FROM motive.participation_claim_research_targets target
      JOIN motive.participation_claim_intents intent ON intent.claim_id=target.claim_id WHERE target.claim_id=$1`, [fixture.claim.claimId]);
    expect(stored.rows).toHaveLength(1); expect(stored.rows[0].binding.selection).toEqual(selection);
    expect(stored.rows[0].binding_digest).toBe(digestCanonicalJson(stored.rows[0].binding));
    expect(stored.rows[0].intent_request_digest).toBe(stored.rows[0].request_digest);
    expect(new Date(stored.rows[0].declared_at).toISOString()).toBe(new Date(stored.rows[0].created_at).toISOString());
    await expect(directSubmission(fixture.claim.claimId!,fixture.claim.leaseEpoch!,
      {...selection,hypothesisId:randomUUID()})).rejects.toThrow(/research delivery target/i);
    await expect(service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!, witness,
      investigation: investigation() }, `omit-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!, witness,
      investigation: investigation({ ...selection, hypothesisId: randomUUID() }) }, `change-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const submitted = await service.submitWitness(fixture.context, assignmentId, { leaseEpoch: fixture.claim.leaseEpoch!, witness,
      investigation: investigation(selection) }, `submit-${randomUUID()}`);
    const projected = await service.publicInvestigation(submitted.id);
    expect(projected.investigation.researchDeliveryTarget).toEqual(selection);
    expect(projected.claimIntent?.researchDeliveryTarget).toEqual(selection);
    await service.completeAssignment(fixture.context,assignmentId,
      {leaseEpoch:fixture.claim.leaseEpoch!,submissionId:submitted.id},`complete-${randomUUID()}`);
    readyDelivery={format:'motive.agent-research-delivery-checkpoint/0.1',status:'READY',submissionId:submitted.id,
      deliveryId:randomUUID(),policyId:randomUUID(),mode:'APPEND_EXISTING',
      target:stored.rows[0].binding as ResearchDeliveryTargetBinding,
      reportDigest:digest('9'),syncPath:'/api/agent/submissions/{submissionId}/research-sync',reason:'READY_FOR_SYNC'};
    recoveredDelivery={format:'motive.agent-memory-recovery-checkpoint/0.1',status:'READY',submissionId:submitted.id,
      findingDecisionId:randomUUID(),deliveryId:randomUUID(),policyId:randomUUID(),reportDigest:digest('7'),
      syncPath:'/api/agent/submissions/{submissionId}/research-sync'};
    expect((await service.agentWorkQueue(fixture.context)).nextTask).toEqual({kind:'RESEARCH_SYNC',
      reason:'READY_RESEARCH_DELIVERY',researchDelivery:recoveredDelivery});
    expect(recoveryChecks).toBe(1);expect(deliveryChecks).toBe(0);recoveredDelivery=null;
    expect((await service.agentWorkQueue(fixture.context)).nextTask).toEqual({kind:'RESEARCH_SYNC',
      reason:'READY_RESEARCH_DELIVERY',researchDelivery:readyDelivery});
    expect(recoveryChecks).toBe(2);expect(deliveryChecks).toBe(1);
  }, 30_000);

  it('keeps legacy absence unchanged and rejects a target added only after testing', async () => {
    const legacy = await participant('Legacy contributor');
    await expect(service.declareAssignmentIntent(legacy.context,assignmentId,{leaseEpoch:legacy.claim.leaseEpoch!,
      proposal:'Invalid target.',expectation:'Reject it.',conditions:['Missing target reference.'],
      researchDeliveryTarget:target()},`invalid-${randomUUID()}`)).rejects.toMatchObject({code:'VALIDATION'});
    const declared = await service.declareAssignmentIntent(legacy.context, assignmentId, { leaseEpoch: legacy.claim.leaseEpoch!,
      proposal: 'Legacy target-free test.', expectation: 'Retain one result.', conditions: ['No delivery target.'] },
    `legacy-${randomUUID()}`);
    expect(declared.intent).not.toHaveProperty('researchDeliveryTarget');
    expect((await pool.query(`SELECT 1 FROM motive.participation_claim_research_targets WHERE claim_id=$1`,
      [legacy.claim.claimId])).rowCount).toBe(0);
    const late = target();
    await expect(directSubmission(legacy.claim.claimId!,legacy.claim.leaseEpoch!,late)).rejects.toThrow(/research delivery target/i);
    await expect(service.submitWitness(legacy.context, assignmentId, { leaseEpoch: legacy.claim.leaseEpoch!, witness,
      investigation: investigation(late) }, `late-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    const submission = await service.submitWitness(legacy.context, assignmentId, { leaseEpoch: legacy.claim.leaseEpoch!, witness,
      investigation: investigation() }, `legacy-submit-${randomUUID()}`);
    expect((await service.publicInvestigation(submission.id)).investigation).not.toHaveProperty('researchDeliveryTarget');
  }, 30_000);
});
