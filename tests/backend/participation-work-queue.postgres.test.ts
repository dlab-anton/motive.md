import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationRouters, createParticipationService, type ParticipationAgentContext,
  type ParticipationService } from '../../server/participation/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import type { SubmissionMotiveReference } from '../../src/lib/participation.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const witness = '{"format":"motive.csqv.witness.v1","n":101,"circles":[]}';

pgDescribe('participant agent work queue on isolated PostgreSQL', () => {
  const databaseName = `motive_agent_work_queue_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:agent-work-queue-${randomUUID()}`;
  let admin: Pool;
  let pool: Pool;
  let service: ParticipationService;
  let assignmentId: string;
  let server: Server;
  let httpOrigin: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Agent work queue test' } });
    service = createParticipationService(pool, {
      tokenSecret: 'agent-work-queue-test-secret-longer-than-thirty-two-bytes', issuerActorId: issuer,
    });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
    const app = express();
    const isActorActive=async(actorId:string)=>{
      const result = await pool.query(`SELECT 1 FROM motive.account_identities WHERE actor_id=$1 AND status='ACTIVE'`, [actorId]);
      return result.rowCount === 1;
    };
    const routers = createParticipationRouters({ service, isActorActive,
      findingAssessment:createFindingAssessmentService({pool,isActorActive}) });
    app.use('/api/agent', routers.agentRouter);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind a TCP port.');
    httpOrigin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) { server.close(); await once(server, 'close'); }
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function activate(owner: string) {
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
  }

  async function connect(owner: string, name: string) {
    const joined = await service.join(owner, name, { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    return { joined, context: await service.authenticateBearer(joined.token) };
  }

  function protocol(purpose: ExperimentProtocol['purpose'],reviewTarget?:string): ExperimentProtocol {
    return { format: 'motive.experiment-protocol.v1', procedure: 'Run the bounded solver and retain its exact output.',
      inputs: [{ name: 'fixture', value: `work-queue-${randomUUID()}` },
        ...(reviewTarget?[{name:'review_target_submission_id',value:reviewTarget}]:[])], purpose };
  }

  async function attempt(connection: { context: ParticipationAgentContext }, purpose: ExperimentProtocol['purpose'],
    options: { package?: boolean; references?: SubmissionMotiveReference[]; reviewTarget?:string } = {}) {
    const claim = await service.claimAssignment(connection.context, assignmentId, `claim-${randomUUID()}`);
    const experimentProtocol = protocol(purpose,options.reviewTarget);
    const motiveReferences = options.references;
    const intent = { leaseEpoch: claim.leaseEpoch!, proposal: 'Run one bounded experiment.',
      expectation: 'The checker will retain an exact result.', conditions: ['Use the frozen work-order terms.'],
      experimentProtocol, ...(motiveReferences ? { motiveReferences } : {}) };
    await service.declareAssignmentIntent(connection.context, assignmentId, intent, `intent-${randomUUID()}`);
    const submission = await service.submitWitness(connection.context, assignmentId, {
      leaseEpoch: claim.leaseEpoch!, witness, investigation: {
        format: 'motive.investigation.v1', proposal: intent.proposal, expectation: intent.expectation,
        conditions: intent.conditions, observations: ['The protected checker retained a report.'],
        assessment: 'This result is evidence for the stated bounded experiment.', nextAction: 'Choose the next queued task.',
        experimentProtocol, ...(motiveReferences ? { motiveReferences } : {}),
      },
    }, `submit-${randomUUID()}`);
    await service.completeAssignment(connection.context, assignmentId,
      { leaseEpoch: claim.leaseEpoch!, submissionId: submission.id }, `complete-${randomUUID()}`);
    const report = await service.publicReport(submission.id);
    const reference = { submissionId: submission.id, reportDigest: String(report.reportDigest),
      artifactDigest: submission.artifactSha256 } satisfies SubmissionMotiveReference;
    if (options.package) {
      await service.createPostCheckAssessment(connection.context, submission.id, {
        reportDigest: reference.reportDigest, assessment: 'Assess the retained report against the declared method.',
        nextAction: 'Make the source and trial log available for independent reproduction.',
      }, `post-check-${randomUUID()}`);
      await service.createSubmissionReproducibility(connection.context, submission.id, {
        reportDigest: reference.reportDigest, solverSource: 'export function solve() { return []; }',
        trialResults: '{"trials":[],"outcome":"retained"}',
      }, `reproducibility-${randomUUID()}`);
    }
    return { submission, reference };
  }

  it('routes a 1:1 discovery/peer-validation cadence without changing contributor authority', async () => {
    const owner = `account:${randomUUID()}`; await activate(owner);
    const researcher = await connect(owner, 'Queue researcher');
    const membershipsBefore = (await pool.query(`SELECT role,scopes FROM motive.memberships WHERE actor_id=$1`, [owner])).rows;

    const firstResponse = await fetch(`${httpOrigin}/api/agent/work-queue`, {
      headers: { Authorization: `Bearer ${researcher.joined.token}` },
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('cache-control')).toBe('no-store');
    expect(await firstResponse.json()).toMatchObject({ format: 'motive.agent-work-queue.v1',
      nextTask: { kind: 'DISCOVERY', reason: 'DISCOVERY_TURN', target: null },
      cadence: { discovery: 1, validation: 1 }, validationAuthority: 'EVIDENCE_ONLY' });
    const queryResponse = await fetch(`${httpOrigin}/api/agent/work-queue?unexpected=1`, {
      headers: { Authorization: `Bearer ${researcher.joined.token}` },
    });
    expect(queryResponse.status).toBe(400);
    expect(queryResponse.headers.get('cache-control')).toBe('no-store');

    const active = await service.claimAssignment(researcher.context, assignmentId, `claim-${randomUUID()}`);
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({ assignment: { claimId: active.claimId },
      nextTask: { kind: 'RESUME', reason: 'ACTIVE_CLAIM', target: null } });
    await service.releaseAssignment(researcher.context, assignmentId, { leaseEpoch: active.leaseEpoch! }, `release-${randomUUID()}`);

    const sameOwnerSource = await connect(owner, 'Same-owner source');
    const sameOwnerResult = await attempt(sameOwnerSource, 'EXPLORATORY', { package: true });
    await attempt(researcher, 'EXPLORATORY');
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({
      nextTask: { kind: 'DISCOVERY', reason: 'EMPTY_PEER_POOL', target: null },
    });

    const incompleteOwner = `account:${randomUUID()}`; await activate(incompleteOwner);
    await attempt(await connect(incompleteOwner, 'Incomplete peer'), 'EXPLORATORY');
    const oldestPeerOwner = `account:${randomUUID()}`; await activate(oldestPeerOwner);
    const oldestPeer = await attempt(await connect(oldestPeerOwner, 'Oldest eligible peer'), 'EXPLORATORY', { package: true });
    const newerPeerOwner = `account:${randomUUID()}`; await activate(newerPeerOwner);
    const newerPeer = await attempt(await connect(newerPeerOwner, 'Newer eligible peer'), 'EXPLORATORY', { package: true });

    const validation = await service.agentWorkQueue(researcher.context);
    expect(validation.nextTask).toEqual({ kind: 'VALIDATION', reason: 'PEER_VALIDATION_DUE', target: {
      submission: expect.objectContaining({ id: oldestPeer.submission.id,
        investigationHref: expect.any(String), postCheckAssessmentHref: expect.any(String), reproducibilityHref: expect.any(String) }),
      reference: oldestPeer.reference,
    } });

    await attempt(researcher, 'REPLICATION', { package: true, references: [sameOwnerResult.reference],
      reviewTarget: sameOwnerResult.submission.id });
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({ nextTask: { kind: 'VALIDATION',
      reason: 'PEER_VALIDATION_DUE', target: { submission: { id: oldestPeer.submission.id } } } });

    await attempt(researcher, 'REPLICATION', { package: true, references: [oldestPeer.reference] });
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({ nextTask: { kind: 'VALIDATION',
      reason: 'PEER_VALIDATION_DUE', target: { submission: { id: oldestPeer.submission.id } } } });

    const review=await attempt(researcher,'REPLICATION',{package:true,references:[oldestPeer.reference],
      reviewTarget:oldestPeer.submission.id});
    const reviewBase=`/api/agent/finding-reviews/${review.submission.id}/targets/${oldestPeer.submission.id}`;
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({nextTask:{kind:'FINDING_REVIEW',
      reason:'COMPLETED_REPLICATION_PENDING_REVIEW',target:{reviewSubmissionId:review.submission.id,
        targetSubmissionId:oldestPeer.submission.id,previewHref:`${reviewBase}/preview`,decisionHref:`${reviewBase}/decisions`}},
      validationAuthority:'REPLICATION_BOUND_FINDING_DECISION'});
    const reviewHeaders={Authorization:`Bearer ${researcher.joined.token}`};
    const reviewPreviewResponse=await fetch(`${httpOrigin}${reviewBase}/preview`,{headers:reviewHeaders});
    expect(reviewPreviewResponse.status).toBe(200);const reviewPreview=await reviewPreviewResponse.json();
    expect(reviewPreview).toMatchObject({reviewSubmissionId:review.submission.id,submissionId:oldestPeer.submission.id,
      reviewerAgentTokenId:researcher.context.tokenId,reviewDecision:null,
      package:{format:'motive.finding-review-package/0.2'}});
    const reviewInput={packageDigest:reviewPreview.packageDigest,expectedDecisionId:null,decision:'DECLINE',outcome:null,
      finding:null,limitations:null,novelty:null,duplicateOfSubmissionId:null,rationale:'The bounded replication does not support a finding decision.'};
    const reviewDecisionResponse=await fetch(`${httpOrigin}${reviewBase}/decisions`,{method:'POST',headers:{...reviewHeaders,
      'content-type':'application/json','idempotency-key':`finding-${randomUUID()}`},body:JSON.stringify(reviewInput)});
    expect(reviewDecisionResponse.status).toBe(201);
    expect(await reviewDecisionResponse.json()).toMatchObject({reviewSubmissionId:review.submission.id,
      submissionId:oldestPeer.submission.id,decision:'DECLINE',replayed:false});
    expect((await service.publicResearchJournalEntry(oldestPeer.submission.id)).update.findingReview).toMatchObject({
      reviewSubmissionId:review.submission.id,reviewerAgentTokenId:researcher.context.tokenId});
    expect(await service.agentWorkQueue(researcher.context)).toMatchObject({nextTask:{kind:'DISCOVERY',reason:'DISCOVERY_TURN'}});

    const siblingCredential = await connect(owner, 'Sibling credential');
    await attempt(siblingCredential, 'EXPLORATORY');
    const siblingQueue = await service.agentWorkQueue(siblingCredential.context);
    expect(siblingQueue.nextTask).toMatchObject({ kind: 'VALIDATION', reason: 'PEER_VALIDATION_DUE',
      target: { submission: { id: newerPeer.submission.id }, reference: newerPeer.reference } });

    expect((await pool.query(`SELECT role,scopes FROM motive.memberships WHERE actor_id=$1`, [owner])).rows)
      .toEqual(membershipsBefore);
    expect(await pool.query(`SELECT count(*)::integer AS count FROM motive.participation_submission_reviews
      WHERE reviewer_actor_id=$1`, [owner])).toMatchObject({ rows: [{ count: 0 }] });
    expect(await pool.query(`SELECT count(*)::integer AS count FROM motive.hypothesis_submission_delivery_admission_decisions
      WHERE reviewer_actor_id=$1`, [owner])).toMatchObject({ rows: [{ count: 0 }] });
  }, 45_000);
});
