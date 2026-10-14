import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, EXOPLANET_HUNTING_PARTICIPATION_PROFILE,
  type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';
import { createFindingAssessmentService } from '../../server/research-memory/finding-assessment.ts';
import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import type { SubmissionMotiveReference } from '../../src/lib/participation.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('exoplanet evidence participation on an isolated PostgreSQL database', () => {
  const databaseName = `motive_exoplanet_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:exoplanet-${randomUUID()}`;
  const sourceOwner = `account:${randomUUID()}`;
  const reviewerOwner = `account:${randomUUID()}`;
  const active = new Set([sourceOwner, reviewerOwner]);
  const tokenSecret = `exoplanet-${'e'.repeat(48)}`;
  let admin: Pool; let pool: Pool; let astronomy: ParticipationService; let circle: ParticipationService;
  let assignmentId: string; let evidence: string; let sourceToken: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    expect(['127.0.0.1', 'localhost']).toContain(source.hostname);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated = new URL(source); isolated.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: isolated.toString(), max: 8 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const ledger = new LedgerKernel(pool);
    for (const slug of ['circle-packing', 'exoplanet-hunting']) {
      await ledger.createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug,
        visibility: 'PUBLIC', revisionContent: { title: `Isolated ${slug}` } });
    }
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp())`,
    [sourceOwner, sourceOwner.slice(8), reviewerOwner, reviewerOwner.slice(8)]);
    astronomy = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      profile: EXOPLANET_HUNTING_PARTICIPATION_PROFILE, isActorActive: actor => active.has(actor) });
    circle = createParticipationService(pool, { tokenSecret, issuerActorId: issuer,
      isActorActive: actor => active.has(actor) });
    assignmentId = (await astronomy.ensureWorkOrder()).id;
    await circle.ensureWorkOrder();
    evidence = await readFile('public/projects/exoplanet-hunting/example-evidence.json', 'utf8');
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      } finally { await admin.end(); }
    }
  });

  async function connect(owner: string): Promise<ParticipationAgentContext> {
    const joined = await astronomy.join(owner, 'Evidence contributor', { projectSlug: 'exoplanet-hunting',
      publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    if (owner === sourceOwner) sourceToken = joined.token;
    return astronomy.authenticateBearer(joined.token);
  }

  async function attempt(context: ParticipationAgentContext, target?: SubmissionMotiveReference, witness = evidence) {
    const claim = await astronomy.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    const proposal = target ? 'Independently recheck the pinned synthetic evidence.' : 'Record one bounded synthetic protocol example.';
    const expectation = 'The format checker reports only structure and provenance.';
    const conditions = ['Use the pinned pilot protocol; make no scientific claim.'];
    const experimentProtocol: ExperimentProtocol = { format: 'motive.experiment-protocol.v1',
      procedure: 'exoplanet-hunting/isolated-structure-fixture/v1', purpose: target ? 'REPLICATION' : 'CONTROL',
      inputs: target ? [{ name: 'review_target_submission_id', value: target.submissionId }]
        : [{ name: 'fixture', value: 'synthetic-inconclusive-example' }] };
    const motiveReferences = target ? [target] : undefined;
    await astronomy.declareAssignmentIntent(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, proposal,
      expectation, conditions, experimentProtocol, ...(motiveReferences ? { motiveReferences } : {}) }, `intent-${randomUUID()}`);
    const submission = await astronomy.submitWitness(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, witness,
      investigation: { format: 'motive.investigation.v1', proposal, expectation, conditions,
        observations: ['The example is synthetic and inconclusive; no TESS data were analyzed.'],
        assessment: 'The report checks bundle structure only.', nextAction: 'Obtain real public data and independent reanalysis.',
        experimentProtocol, ...(motiveReferences ? { motiveReferences } : {}) } }, `submit-${randomUUID()}`);
    const report = await astronomy.publicReport(submission.id);
    const reference = { submissionId: submission.id, reportDigest: String(report.reportDigest),
      artifactDigest: submission.artifactSha256 };
    await astronomy.createPostCheckAssessment(context, submission.id, { reportDigest: reference.reportDigest,
      assessment: 'Synthetic record only; no candidate is established.', nextAction: 'Continue with documented input provenance.' },
    `post-${randomUUID()}`);
    await astronomy.createSubmissionReproducibility(context, submission.id, { reportDigest: reference.reportDigest,
      solverSource: 'NO_ANALYSIS: structural fixture', trialResults: 'Synthetic example; no TESS result.' }, `repro-${randomUUID()}`);
    await astronomy.completeAssignment(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, submissionId: submission.id },
      `complete-${randomUUID()}`);
    return { submission, report, reference };
  }

  it('retains structurally valid but scientifically unvalidated evidence with null scores and a peer decision', async () => {
    const source = await connect(sourceOwner);
    const reviewer = await connect(reviewerOwner);
    expect((await astronomy.agentWorkQueue(source)).nextTask).toMatchObject({ kind: 'DISCOVERY' });
    const noIntent = await astronomy.claimAssignment(source, assignmentId, `claim-${randomUUID()}`);
    await expect(astronomy.submitWitness(source, assignmentId, { leaseEpoch: noIntent.leaseEpoch!, witness: evidence },
      `missing-intent-${randomUUID()}`)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(astronomy.declareAssignmentIntent(source, assignmentId, { leaseEpoch: noIntent.leaseEpoch!,
      proposal: 'Record a bounded pilot audit.', expectation: 'Retain one structural result.',
      conditions: ['Use the declared public input.'] }, `missing-protocol-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const declaredProtocol: ExperimentProtocol = { format: 'motive.experiment-protocol.v1',
      procedure: 'exoplanet-hunting/intent-boundary-fixture/v1', purpose: 'CONTROL',
      inputs: [{ name: 'fixture', value: 'synthetic-inconclusive-example' }] };
    await astronomy.declareAssignmentIntent(source, assignmentId, { leaseEpoch: noIntent.leaseEpoch!,
      proposal: 'Record a bounded pilot audit.', expectation: 'Retain one structural result.',
      conditions: ['Use the declared public input.'], experimentProtocol: declaredProtocol },
    `intent-boundary-${randomUUID()}`);
    await expect(astronomy.submitWitness(source, assignmentId, { leaseEpoch: noIntent.leaseEpoch!, witness: evidence,
      investigation: { format: 'motive.investigation.v1', proposal: 'Record a bounded pilot audit.',
        expectation: 'Retain one structural result.', conditions: ['Use the declared public input.'],
        observations: ['No observation was made.'], assessment: 'This is an input example.',
        nextAction: 'Run a declared test.' } }, `missing-final-protocol-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await astronomy.releaseAssignment(source, assignmentId, { leaseEpoch: noIntent.leaseEpoch! }, `release-${randomUUID()}`);
    const sourceRecord = await attempt(source);
    expect(sourceRecord.submission).toMatchObject({ reportStatus: 'VALID', exactScore: null,
      exceedsReference: null, acceptance: 'PENDING' });
    expect(sourceRecord.report).toMatchObject({ exactScore: null, exceedsReference: null,
      report: { assessmentScope: 'STRUCTURE_ONLY', provenanceStatus: 'DECLARED_NOT_VERIFIED', scientificStatus: 'NOT_VALIDATED',
        result: { ok: true, report: { scope: 'STRUCTURE_ONLY', scientificStatus: 'NOT_VALIDATED' } } } });
    const row = await pool.query(`SELECT witness_format,report::text,exact_score,exceeds_reference
      FROM motive.participation_submission_artifacts WHERE submission_id=$1`, [sourceRecord.submission.id]);
    expect(row.rows[0]).toMatchObject({ witness_format: 'motive.exoplanet.evidence.v1', report: 'VALID',
      exact_score: null, exceeds_reference: null });
    // In this disposable database, temporarily bypass the immutability trigger
    // inside a rolled-back transaction to exercise the new CHECK directly.
    const constraintClient = await pool.connect();
    try {
      await constraintClient.query('BEGIN');
      await constraintClient.query('ALTER TABLE motive.participation_submission_artifacts DISABLE TRIGGER USER');
      await expect(constraintClient.query(`UPDATE motive.participation_submission_artifacts SET exact_score='1'
        WHERE submission_id=$1`, [sourceRecord.submission.id])).rejects.toMatchObject({ code: '23514' });
      await constraintClient.query('ROLLBACK');
    } finally { constraintClient.release(); }
    const projection = await astronomy.publicProjection();
    expect(projection).toMatchObject({ project: { slug: 'exoplanet-hunting', lifecycle: 'RESULTS_AVAILABLE' },
      totalSubmissions: 1, bestChecked: null, bestAccepted: null });
    expect(projection.challengeOutcome).toBeUndefined();
    expect((await circle.publicProjection()).totalSubmissions).toBe(0);
    await expect(circle.authenticateBearer(sourceToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(circle.getAgentAssignment(source)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await attempt(reviewer);
    expect((await astronomy.agentWorkQueue(reviewer)).nextTask).toMatchObject({ kind: 'VALIDATION',
      reason: 'PEER_VALIDATION_DUE', target: { reference: sourceRecord.reference } });
    const reviewRecord = await attempt(reviewer, sourceRecord.reference);
    expect((await astronomy.agentWorkQueue(reviewer)).nextTask).toMatchObject({ kind: 'FINDING_REVIEW',
      reason: 'COMPLETED_REPLICATION_PENDING_REVIEW' });
    const finding = createFindingAssessmentService({ pool, isActorActive: actor => active.has(actor) });
    const sameOwnerReview = await attempt(source, sourceRecord.reference);
    await expect(finding.previewFromAgent(source, sameOwnerReview.submission.id, sourceRecord.submission.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const preview = await finding.previewFromAgent(reviewer, reviewRecord.submission.id, sourceRecord.submission.id);
    expect(preview.package).toMatchObject({ format: 'motive.finding-review-package/0.2',
      project: { slug: 'exoplanet-hunting' } });
    const decision = await finding.decideFromAgent(reviewer, reviewRecord.submission.id, sourceRecord.submission.id,
      { packageDigest: preview.packageDigest, expectedDecisionId: null, decision: 'ACCEPT', outcome: 'INCONCLUSIVE',
        finding: 'The independent synthetic replication supports only that the example bundle has the expected structure.',
        limitations: 'No observed TESS products, transit search, recovery test, or signal validation occurred.',
        novelty: 'DISTINCT', duplicateOfSubmissionId: null,
        rationale: 'Retain this bounded structural finding as inconclusive scientific evidence.' },
      `finding-${randomUUID()}`);
    expect(decision).toMatchObject({ decision: 'ACCEPT', outcome: 'INCONCLUSIVE', reviewSubmissionId: reviewRecord.submission.id });
    expect((await astronomy.publicProjection()).challengeOutcome).toBeUndefined();

    const invalid = JSON.parse(evidence) as { observations: { classification: string } };
    invalid.observations.classification = 'confirmed';
    const rejected = await attempt(source, undefined, JSON.stringify(invalid));
    expect(rejected.submission).toMatchObject({ reportStatus: 'REJECTED', exactScore: null,
      exceedsReference: null, acceptance: 'PENDING' });
    expect(rejected.report).toMatchObject({ reportStatus: 'REJECTED', exactScore: null, exceedsReference: null,
      report: { assessmentScope: 'STRUCTURE_ONLY', provenanceStatus: 'DECLARED_NOT_VERIFIED',
        result: { ok: false, error: { code: 'INVALID_FIELD' } } } });
    const finalProjection = await astronomy.publicProjection();
    expect(finalProjection).toMatchObject({ bestChecked: null, bestAccepted: null, acceptedResults: 0 });
    expect(finalProjection.challengeOutcome).toBeUndefined();
  }, 60_000);
});
