import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { PostgresEvidenceStore } from '../../packages/evidence/src/index.ts';
import {
  digestTrustedComparatorProfile,
  type ComparatorChecks,
  type ComparatorOutcome,
  type TrustedComparatorProfile,
} from '../../packages/evaluator-lean/src/contract.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { ControllerLease, EnvironmentHandle, EnvironmentProjection } from '../../packages/orchestration/src/store-types.ts';
import { digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import { profile as runtimeTestProfile } from '../../packages/evaluator-lean/src/runtime-profile.fixture.ts';
import type { VersionedComparatorProfile } from '../../packages/evaluator-lean/src/versioned.ts';
import type { RuntimeBoundComparatorReport } from '../../packages/evaluator-lean/src/runtime-report.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const controllerActor = 'evidence-store-test-controller';

function digest(value: string): Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const inferenceProfileDigest = digest('evidence-test-inference-profile');
const workerProfileDigest = digest('evidence-test-worker-profile');
const workerLaunchPlanDigest = digest('evidence-test-worker-launch');
const evaluatorLaunchPlanDigest = digest('evidence-test-evaluator-launch');

const evaluatorProfile: TrustedComparatorProfile = {
  format: 'motive.lean-comparator-profile/0.1',
  profile_id: 'lean-comparator-evidence-store-test',
  challenge: {
    challenge_digest: digest('evidence-test-challenge'),
    dependency_lock_digest: digest('evidence-test-lock'),
    trusted_build_config_digest: digest('evidence-test-build-config'),
    challenge_module: 'Motive.Challenge',
    solution_module: 'Motive.Solution',
    theorem_names: ['Motive.Challenge.target'],
    allowed_solution_paths: ['Motive/Solution.lean'],
  },
  toolchain: {
    lean: { version: 'v4.23.0', digest: digest('evidence-test-lean') },
    lake: { version: 'v4.23.0', digest: digest('evidence-test-lake') },
    landrun: { commit: 'a'.repeat(40), digest: digest('evidence-test-landrun') },
    lean4export: { version: 'v4.23.0', digest: digest('evidence-test-lean4export') },
    comparator: { commit: 'b'.repeat(40), digest: digest('evidence-test-comparator') },
    export_config_digest: digest('evidence-test-export-config'),
    comparator_config_digest: digest('evidence-test-comparator-config'),
  },
  permitted_axioms: ['Classical.choice', 'propext'],
  isolation: {
    host_os: 'linux', user: 'nonprivileged',
    outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX',
    candidate_oleans: 'forbidden',
  },
};
const evaluatorProfileDigest = digestTrustedComparatorProfile(evaluatorProfile);
const runtimeEvaluatorProfile = { ...evaluatorProfile, format: 'motive.lean-comparator-profile/0.2' as const, runtime: runtimeTestProfile.runtime };

const passingChecks: ComparatorChecks = {
  trusted_challenge: 'PASS',
  trusted_dependencies: 'PASS',
  candidate_source_only: 'PASS',
  toolchain_and_export: 'PASS',
  protected_build: 'PASS',
  exported_terms: 'PASS',
  statement_comparison: 'PASS',
  transitive_axioms: 'PASS',
  kernel_replay: 'PASS',
};

type Fixture = {
  actorId: string;
  projectId: string;
  attempt: AttemptProjection;
  lease: ControllerLease;
  worker: EnvironmentProjection;
  evaluator: EnvironmentProjection;
  artifactManifestDigest: Digest;
};

function providerHandle(kind: string): EnvironmentHandle {
  return {
    provider: 'synthetic-evidence-provider',
    externalId: `motive-evidence-${kind}-${randomUUID()}`,
    sessionId: `session-${randomUUID()}`,
  };
}

function captureFor(fixture: Fixture, outcome: ComparatorOutcome, extra: Record<string, unknown> = {}) {
  const checks: ComparatorChecks = outcome === 'VERIFIED'
    ? passingChecks
    : outcome === 'REJECTED'
      ? { ...passingChecks, statement_comparison: 'FAIL' }
      : { ...passingChecks, kernel_replay: 'UNRESOLVED' };
  const report = {
    format: 'motive.lean-comparator-report/0.1',
    evaluator_profile_digest: evaluatorProfileDigest,
    challenge_digest: evaluatorProfile.challenge.challenge_digest,
    dependency_lock_digest: evaluatorProfile.challenge.dependency_lock_digest,
    trusted_build_config_digest: evaluatorProfile.challenge.trusted_build_config_digest,
    solution_artifact_manifest_digest: fixture.artifactManifestDigest,
    toolchain: evaluatorProfile.toolchain,
    permitted_axioms: evaluatorProfile.permitted_axioms,
    used_transitive_axioms: ['Classical.choice'],
    checks,
    outcome,
    ...extra,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  return {
    bytes,
    expected_raw_report_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest,
  };
}

function reviewBinding(evaluation: {
  attemptId: string; artifactManifestDigest: Digest; termsDigest: Digest; evaluatorProfileDigest: Digest; rawReportDigest: Digest;
}) {
  return {
    attemptId: evaluation.attemptId,
    artifactManifestDigest: evaluation.artifactManifestDigest,
    termsDigest: evaluation.termsDigest,
    evaluatorProfileDigest: evaluation.evaluatorProfileDigest,
    rawReportDigest: evaluation.rawReportDigest,
  };
}

describe.skipIf(!databaseUrl)('PostgreSQL durable evaluator evidence and human acceptance', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  let orchestration: PostgresOrchestrationStore;
  let evidence: PostgresEvidenceStore;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 16, connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    const status = await getPostgresSchemaStatus(pool);
    if (!status.exact) throw new Error(`Evidence test schema is not exact: ${status.problems.join(' ')}`);
    ledger = new LedgerKernel(pool);
    orchestration = new PostgresOrchestrationStore(pool);
    evidence = new PostgresEvidenceStore(pool);
  });

  beforeEach(async () => {
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true,
      reason: 'Synthetic evidence-store PostgreSQL test setup',
    });
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await terminateFixture(fixture);
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false,
        reason: 'Synthetic evidence-store PostgreSQL tests complete',
      });
    } finally {
      await pool?.end();
    }
  });

  async function activateEnvironment(
    fixture: Pick<Fixture, 'lease'> & { authorizationId: string },
    kind: 'WORKER' | 'EVALUATOR',
    selectedProfile: VersionedComparatorProfile = evaluatorProfile,
  ): Promise<EnvironmentProjection> {
    const planned = await orchestration.reserveEnvironment(fixture.lease, {
      kind,
      profileDigest: kind === 'WORKER' ? workerProfileDigest : digestCanonicalJson(selectedProfile),
      profileSnapshot: kind === 'WORKER'
        ? { format: 'motive.synthetic-worker-profile/0.1', source: 'test-only' }
        : JSON.parse(JSON.stringify(selectedProfile)) as Record<string, unknown>,
      launchPlanDigest: kind === 'WORKER' ? workerLaunchPlanDigest : evaluatorLaunchPlanDigest,
      infrastructureAuthorizationId: fixture.authorizationId,
      maximumCostUsd: '1.000000000000',
    });
    await expect(orchestration.claimEffect(fixture.lease, planned.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await orchestration.recordCreateResult(fixture.lease, planned.effect.effectId, providerHandle(kind.toLowerCase()));
    return orchestration.recordObservation(fixture.lease, planned.environment.id, {
      providerStatus: 'running', state: 'ACTIVE', providerTerminal: false,
    });
  }

  async function createFixture(options: { humanAcceptanceRequired?: boolean; runtimeBound?: boolean } = {}): Promise<Fixture> {
    const selectedProfile = options.runtimeBound ? runtimeEvaluatorProfile : evaluatorProfile;
    const actorId = `evidence-owner:${randomUUID()}`;
    const project = await ledger.createProject({
      actorId, idempotencyKey: randomUUID(), slug: `evidence-${randomUUID()}`,
      visibility: 'PRIVATE', revisionContent: { title: 'Synthetic durable evidence fixture' },
    });
    const source = await ledger.createFundingSource({
      actorId, idempotencyKey: randomUUID(), authorizedAmount: '10.000000000000', metadata: { test: 'evidence-store' },
    });
    const grant = await ledger.createGrant({
      actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id, limitAmount: '5.000000000000',
    });
    const workOrder = await ledger.createWorkOrder({
      actorId, idempotencyKey: randomUUID(), projectId: project.id,
      workOrderKey: `evidence-${randomUUID().replaceAll('-', '')}`, revision: 1, state: 'READY',
      terms: {
        format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1,
        agreement_id: `evidence-agreement-${randomUUID()}`, objective: 'Synthetic durable evidence regression.', input_commit: 'c'.repeat(40),
        allowed_effects: ['read-approved-inputs', 'submit-artifact'],
        hosted: {
          enabled: true,
          inference: { currency: 'USD', ceiling: '2.000000000000', profile_digest: inferenceProfileDigest },
          maximum_runtime_seconds: 120,
        },
        external: {
          enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
          late_submission_policy: 'reject', review_admission: 'manual',
          artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true },
        },
        evaluation: { profile_digest: digestCanonicalJson(selectedProfile), human_acceptance_required: options.humanAcceptanceRequired ?? true },
      },
    });
    const attempt = await ledger.reserveAttempt({
      actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: workOrder.id,
      ceilingAmount: '2.000000000000', profileDigest: inferenceProfileDigest, inputDigest: digest(`evidence-input:${randomUUID()}`),
    });
    const authorizationId = randomUUID();
    await orchestration.createInfrastructureAuthorization({
      id: authorizationId, sourceAccountId: source.id, sourceAccountRef: `synthetic-evidence:${randomUUID()}`,
      actorId, limitUsd: '3.000000000000', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const lease = await orchestration.acquireLease(attempt.id, `evidence-evaluator:${randomUUID()}`, 300);
    const worker = await activateEnvironment({ lease, authorizationId }, 'WORKER');
    const artifactManifestDigest = digest(`evidence-manifest:${randomUUID()}`);
    await orchestration.recordArtifactSeal(lease, worker.id, {
      manifestDigest: artifactManifestDigest, receiptId: `synthetic-receipt-${randomUUID()}`,
    });
    const evaluator = await activateEnvironment({ lease, authorizationId }, 'EVALUATOR', selectedProfile);
    const fixture = { actorId, projectId: project.id, attempt, lease, worker, evaluator, artifactManifestDigest };
    fixtures.push(fixture);
    return fixture;
  }

  async function terminateFixture(fixture: Fixture): Promise<void> {
    const execution = await orchestration.getExecution(fixture.attempt.id);
    for (const environment of execution?.environments ?? []) {
      if (environment.state === 'TERMINATED' || environment.state === 'ABANDONED') continue;
      const stop = await orchestration.requestStop(fixture.lease, environment.id);
      const claim = await orchestration.claimEffect(fixture.lease, stop.effect.effectId);
      if (claim.claimed) {
        await orchestration.recordStopResult(fixture.lease, stop.effect.effectId, {
          providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
        });
      }
    }
  }

  it.each([true, false])('persists and replays runtime-bound evidence with isolation complete=%s and retains private runtime details', async complete => {
    const fixture = await createFixture({ runtimeBound: true });
    const facts = Buffer.from(JSON.stringify({ format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete',
      rejection_stage: null, protected_build: true, toolchain_and_export: true, exported_terms: true,
      statement_comparison: true, transitive_axioms: true, kernel_replay: true, used_transitive_axioms: ['Classical.choice'] }));
    const report: RuntimeBoundComparatorReport = {
      format: 'motive.lean-comparator-report/0.2', evaluator_profile_digest: digestCanonicalJson(runtimeEvaluatorProfile),
      challenge_digest: evaluatorProfile.challenge.challenge_digest, dependency_lock_digest: evaluatorProfile.challenge.dependency_lock_digest,
      trusted_build_config_digest: evaluatorProfile.challenge.trusted_build_config_digest, solution_artifact_manifest_digest: fixture.artifactManifestDigest,
      runtime_digest: digestCanonicalJson(runtimeEvaluatorProfile.runtime),
      runtime_preflight: { af_unix_denied: true, landlock_enforced: true, namespace_identity: true, descendants_reaped: complete, protected_report_capture: true },
      input_preflight: { trusted_challenge: true, trusted_dependencies: true, candidate_source_only: true },
      facts_capture: { bytes_base64: facts.toString('base64'), digest: digest(facts.toString('utf8')) },
    };
    const capture = (value: unknown) => {
      const text = JSON.stringify(value);
      return { bytes: Buffer.from(text), expected_raw_report_digest: digest(text) };
    };
    const input = { artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile: runtimeEvaluatorProfile, capturedReport: capture(report) };
    const evaluation = await evidence.recordTrustedEvaluatorCapture(input);
    expect(evaluation.assessment).toMatchObject({ format: 'motive.lean-comparator-assessment/0.2',
      runtime: runtimeEvaluatorProfile.runtime, outcome: complete ? 'VERIFIED' : 'INCONCLUSIVE',
      human_acceptance: { status: 'PENDING', decision_id: null } });
    expect(evaluation.evaluatorProfile).toEqual(runtimeEvaluatorProfile);
    const restarted = new PostgresEvidenceStore(pool);
    expect(await restarted.recordTrustedEvaluatorCapture(input)).toEqual(evaluation);
    const member = await restarted.findEvaluationForMember({ actorId: fixture.actorId, evaluationId: evaluation.id });
    expect(JSON.stringify(member)).not.toContain('runtime_preflight');
    expect(JSON.stringify(member)).not.toContain('instrumentation_digest');
    await expect(restarted.recordTrustedEvaluatorCapture({ ...input,
      capturedReport: capture({ ...report, runtime_digest: digest('substituted runtime') }) })).rejects.toMatchObject({ code: 'EVALUATION_BINDING_MISMATCH' });
    if (complete) {
      await expect(restarted.decideAcceptance({ actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: evaluation.id,
        decision: 'ACCEPTED', expectedReview: reviewBinding(evaluation) })).rejects.toMatchObject({ code: 'REVIEW_NOT_READY' });
    }
  });

  it('binds trusted captured bytes to the sealed artifact and permits a human decision only after teardown, without spending enabled', async () => {
    const fixture = await createFixture();
    const evaluation = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id,
      evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile,
      capturedReport: captureFor(fixture, 'VERIFIED'),
    });
    expect(evaluation).toMatchObject({
      attemptId: fixture.attempt.id, artifactManifestDigest: fixture.artifactManifestDigest,
      evaluatorProfileDigest, outcome: 'VERIFIED',
    });
    expect(evaluation.assessment.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });
    await expect(evidence.decideAcceptance({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: evaluation.id,
      decision: 'ACCEPTED', expectedReview: reviewBinding(evaluation),
    })).rejects.toMatchObject({ code: 'REVIEW_NOT_READY' });

    await terminateFixture(fixture);
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false,
      reason: 'Human review must not require spending admission',
    });
    const idempotencyKey = randomUUID();
    const input = {
      actorId: fixture.actorId, idempotencyKey, evaluationId: evaluation.id,
      decision: 'ACCEPTED' as const, expectedReview: reviewBinding(evaluation), rationale: 'Reviewed synthetic Comparator evidence.',
    };
    const decision = await evidence.decideAcceptance(input);
    await expect(evidence.decideAcceptance(input)).resolves.toEqual(decision);
    await expect(evidence.decideAcceptance({ ...input, decision: 'REJECTED' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(evidence.decideAcceptance({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ACCEPTANCE_ALREADY_DECIDED' });

    const memberAttempt = await evidence.findAttemptEvidenceForMember({ actorId: fixture.actorId, attemptId: fixture.attempt.id });
    const memberEvaluation = await evidence.findEvaluationForMember({ actorId: fixture.actorId, evaluationId: evaluation.id });
    expect(memberAttempt?.artifact).toMatchObject({ manifestDigest: fixture.artifactManifestDigest });
    expect(memberAttempt?.evaluations).toHaveLength(1);
    expect(memberEvaluation).toMatchObject({ id: evaluation.id, acceptance: { id: decision.id, decision: 'ACCEPTED' } });
    expect(JSON.stringify(memberAttempt)).not.toContain('rationale');
    expect(JSON.stringify(memberAttempt)).not.toContain('evaluator_provider');
    expect(JSON.stringify(memberAttempt)).not.toContain('checks');

    const audit = await pool.query(
      `SELECT event_type, payload, actor_id FROM motive.events
       WHERE aggregate_id = ANY($1::uuid[]) ORDER BY event_type`,
      [[evaluation.id, decision.id]],
    );
    expect(audit.rows.map(row => row.event_type)).toEqual(['acceptance.decided', 'evaluation.recorded']);
    expect(audit.rows.find(row => row.event_type === 'acceptance.decided')?.actor_id).toBe(fixture.actorId);
    expect(JSON.stringify(audit.rows)).not.toContain('Reviewed synthetic Comparator evidence');
    const outbox = await pool.query(
      `SELECT topic, payload FROM motive.outbox WHERE aggregate_id = ANY($1::uuid[]) ORDER BY topic`,
      [[evaluation.id, decision.id]],
    );
    expect(outbox.rows.map(row => row.topic)).toEqual(['acceptance.decided', 'evaluation.recorded']);
    const attempt = await pool.query(`SELECT admission_closed_at IS NOT NULL AS closed FROM motive.attempts WHERE id = $1`, [fixture.attempt.id]);
    expect(attempt.rows[0]?.closed).toBe(true);
    await pool.query(
      `UPDATE motive.memberships SET revoked_at = clock_timestamp() WHERE project_id = $1 AND actor_id = $2`,
      [fixture.projectId, fixture.actorId],
    );
    await expect(evidence.decideAcceptance(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not mistake worker exit claims for evaluator evidence and retains an inconclusive trusted report after cancellation', async () => {
    const fixture = await createFixture();
    await expect(evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id,
      evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile,
      capturedReport: captureFor(fixture, 'VERIFIED', { worker_exit_code: 0 }),
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    const before = await pool.query('SELECT count(*)::int AS count FROM motive.evaluations WHERE attempt_id = $1', [fixture.attempt.id]);
    expect(before.rows[0]?.count).toBe(0);

    await ledger.requestAttemptCancellation({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), attemptId: fixture.attempt.id, reason: 'Synthetic cancellation before review',
    });
    const inconclusive = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id,
      evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile,
      capturedReport: captureFor(fixture, 'INCONCLUSIVE'),
    });
    expect(inconclusive.outcome).toBe('INCONCLUSIVE');
    await terminateFixture(fixture);
    await expect(evidence.decideAcceptance({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: inconclusive.id,
      decision: 'ACCEPTED', expectedReview: reviewBinding(inconclusive),
    })).rejects.toMatchObject({ code: 'EVALUATION_NOT_VERIFIED' });
    await expect(evidence.decideAcceptance({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: inconclusive.id,
      decision: 'REJECTED', expectedReview: reviewBinding(inconclusive),
    })).resolves.toMatchObject({ decision: 'REJECTED' });
  });

  it('hides cross-project and revoked membership access while rejecting an active non-maintainer', async () => {
    const fixture = await createFixture();
    const evaluation = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'VERIFIED'),
    });
    await terminateFixture(fixture);
    const reviewer = `evidence-reviewer:${randomUUID()}`;
    const steward = `evidence-steward:${randomUUID()}`;
    await pool.query(
      `INSERT INTO motive.memberships (id, project_id, actor_id, role, scopes, granted_by)
       VALUES ($1, $2, $3, 'REVIEWER', ARRAY[]::text[], $4), ($5, $2, $6, 'STEWARD', ARRAY['*'], $4)`,
      [randomUUID(), fixture.projectId, reviewer, fixture.actorId, randomUUID(), steward],
    );
    const request = {
      idempotencyKey: randomUUID(), evaluationId: evaluation.id,
      decision: 'ACCEPTED' as const, expectedReview: reviewBinding(evaluation),
    };
    await expect(evidence.decideAcceptance({ ...request, actorId: `other-project:${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(evidence.decideAcceptance({
      ...request,
      actorId: `other-project:${randomUUID()}`,
      idempotencyKey: randomUUID(),
      expectedReview: { ...reviewBinding(evaluation), termsDigest: digest(`wrong-terms:${randomUUID()}`) },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(evidence.decideAcceptance({ ...request, actorId: reviewer, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'MAINTAINER_REQUIRED' });
    await expect(evidence.findEvaluationForMember({ actorId: `other-project:${randomUUID()}`, evaluationId: evaluation.id })).resolves.toBeNull();

    const client = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM motive.memberships WHERE project_id = $1 AND actor_id = $2 FOR UPDATE`,
        [fixture.projectId, steward],
      );
      pending = evidence.decideAcceptance({ ...request, actorId: steward, idempotencyKey: randomUUID() });
      await client.query(`UPDATE motive.memberships SET revoked_at = clock_timestamp() WHERE project_id = $1 AND actor_id = $2`, [fixture.projectId, steward]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noHumanFixture = await createFixture({ humanAcceptanceRequired: false });
    const noHumanEvaluation = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: noHumanFixture.worker.id, evaluatorEnvironmentId: noHumanFixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(noHumanFixture, 'VERIFIED'),
    });
    await terminateFixture(noHumanFixture);
    const noHumanRequest = {
      idempotencyKey: randomUUID(), evaluationId: noHumanEvaluation.id,
      decision: 'ACCEPTED' as const, expectedReview: reviewBinding(noHumanEvaluation),
    };
    await expect(evidence.decideAcceptance({ ...noHumanRequest, actorId: `other-project:${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(evidence.decideAcceptance({ ...noHumanRequest, actorId: noHumanFixture.actorId, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'HUMAN_REVIEW_NOT_REQUIRED' });
  });

  it('rejects direct incomplete assessment JSON and prevents a second evaluator report from gaining a conflicting final decision', async () => {
    const fixture = await createFixture();
    const workerReceipt = await pool.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM motive.orchestration_artifact_seals WHERE environment_id = $1`, [fixture.worker.id],
    );
    const evaluator = fixture.evaluator;
    await expect(pool.query(
      `INSERT INTO motive.evaluations (
        id, project_id, work_order_id, attempt_id, artifact_environment_id, evaluator_environment_id,
        artifact_manifest_digest, artifact_receipt_id, terms_digest, evaluator_profile_digest, evaluator_profile,
        challenge_digest, dependency_lock_digest, trusted_build_config_digest, raw_report_digest, assessment_digest,
        assessment, outcome, evaluator_provider, evaluator_external_id, evaluator_session_id,
        evaluator_lease_epoch, evaluator_controller_generation
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16,
        '{}'::jsonb, 'VERIFIED', $17, $18, $19, $20, $21
      )`,
      [
        randomUUID(), fixture.projectId, fixture.attempt.workOrderId, fixture.attempt.id, fixture.worker.id, fixture.evaluator.id,
        fixture.artifactManifestDigest, workerReceipt.rows[0]?.receipt_id, fixture.attempt.termsDigest, evaluatorProfileDigest,
        JSON.stringify(evaluatorProfile), evaluatorProfile.challenge.challenge_digest, evaluatorProfile.challenge.dependency_lock_digest,
        evaluatorProfile.challenge.trusted_build_config_digest, digest(`direct-missing-keys:${randomUUID()}`), digest('direct-empty-assessment'),
        evaluator.provider, evaluator.externalId, evaluator.sessionId, evaluator.leaseEpoch, evaluator.controllerGeneration,
      ],
    )).rejects.toMatchObject({ code: '23514' });

    const verified = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'VERIFIED'),
    });
    const rejected = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'REJECTED'),
    });
    await terminateFixture(fixture);
    await evidence.decideAcceptance({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: verified.id,
      decision: 'ACCEPTED', expectedReview: reviewBinding(verified),
    });
    await expect(evidence.decideAcceptance({
      actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: rejected.id,
      decision: 'REJECTED', expectedReview: reviewBinding(rejected),
    })).rejects.toMatchObject({ code: 'ACCEPTANCE_ALREADY_DECIDED' });
    await expect(pool.query(
      `INSERT INTO motive.acceptance_decisions (
        id, project_id, work_order_id, attempt_id, evaluation_id, artifact_manifest_digest,
        terms_digest, evaluator_profile_digest, raw_report_digest, decision, decided_by_actor_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'REJECTED', $10)`,
      [
        randomUUID(), fixture.projectId, rejected.workOrderId, rejected.attemptId, rejected.id,
        rejected.artifactManifestDigest, rejected.termsDigest, rejected.evaluatorProfileDigest,
        rejected.rawReportDigest, fixture.actorId,
      ],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes concurrent capture and identical decision retries into one record and outbox effect', async () => {
    const fixture = await createFixture();
    const capture = {
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'VERIFIED'),
    };
    const [first, second] = await Promise.all([
      evidence.recordTrustedEvaluatorCapture(capture), evidence.recordTrustedEvaluatorCapture(capture),
    ]);
    expect(first.id).toBe(second.id);
    await terminateFixture(fixture);
    const request = { actorId: fixture.actorId, idempotencyKey: randomUUID(), evaluationId: first.id,
      decision: 'ACCEPTED' as const, expectedReview: reviewBinding(first) };
    const decisions = await Promise.all([evidence.decideAcceptance(request), evidence.decideAcceptance(request)]);
    expect(decisions[0]).toEqual(decisions[1]);
    const records = await pool.query(`SELECT topic, count(*)::int AS count FROM motive.outbox
      WHERE aggregate_id = ANY($1::uuid[]) GROUP BY topic ORDER BY topic`, [[first.id, decisions[0].id]]);
    expect(records.rows).toEqual([
      { topic: 'acceptance.decided', count: 1 }, { topic: 'evaluation.recorded', count: 1 },
    ]);
  });

  it('permits exactly one of two competing final decisions', async () => {
    const fixture = await createFixture();
    const evaluation = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'VERIFIED'),
    });
    await terminateFixture(fixture);
    const results = await Promise.allSettled((['ACCEPTED', 'REJECTED'] as const).map(decision =>
      evidence.decideAcceptance({ actorId: fixture.actorId, idempotencyKey: randomUUID(),
        evaluationId: evaluation.id, decision, expectedReview: reviewBinding(evaluation) })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'ACCEPTANCE_ALREADY_DECIDED' });
    const count = await pool.query('SELECT count(*)::int AS count FROM motive.acceptance_decisions WHERE attempt_id = $1', [fixture.attempt.id]);
    expect(count.rows[0].count).toBe(1);
  });

  it('rechecks membership after waiting for a concurrent revocation lock', async () => {
    const fixture = await createFixture();
    const evaluation = await evidence.recordTrustedEvaluatorCapture({
      artifactEnvironmentId: fixture.worker.id, evaluatorEnvironmentId: fixture.evaluator.id,
      evaluatorProfile, capturedReport: captureFor(fixture, 'VERIFIED'),
    });
    await terminateFixture(fixture);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('UPDATE motive.memberships SET revoked_at = clock_timestamp() WHERE project_id = $1 AND actor_id = $2', [fixture.projectId, fixture.actorId]);
      const blocker = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = evidence.decideAcceptance({ actorId: fixture.actorId, idempotencyKey: randomUUID(),
        evaluationId: evaluation.id, decision: 'ACCEPTED', expectedReview: reviewBinding(evaluation) })
        .then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error: { code: string }) => ({ code: error.code }));
      let observedWait = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting = await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting', [blocker]);
        if (waiting.rows[0].waiting) { observedWait = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(observedWait).toBe(true);
      await revoker.query('COMMIT');
      await expect(pending).resolves.toEqual({ code: 'NOT_FOUND' });
      const count = await pool.query('SELECT count(*)::int AS count FROM motive.acceptance_decisions WHERE attempt_id = $1', [fixture.attempt.id]);
      expect(count.rows[0].count).toBe(0);
    } finally {
      await revoker.query('ROLLBACK');
      revoker.release();
    }
  });
});
