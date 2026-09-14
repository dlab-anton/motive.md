import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  DomainValidationError,
  assertDigest,
  canonicalJson,
  digestCanonicalJson,
  validateWorkOrderTerms,
  type Digest,
} from '../../domain/src/contracts.ts';
import {
  EvaluatorContractError,
} from '../../evaluator-lean/src/contract.ts';
import {
  validateVersionedComparatorProfile as validateTrustedComparatorProfile,
  validateVersionedComparatorReport as validateTrustedComparatorReport,
  type VersionedComparatorAssessment as ComparatorAssessment,
  type VersionedComparatorProfile as TrustedComparatorProfile,
} from '../../evaluator-lean/src/versioned.ts';
import type {
  AcceptanceDecisionProjection,
  DecideAcceptanceInput,
  EvaluationProjection,
  EvidenceStore,
  EvidenceStoreErrorCode,
  EvaluatorEnvironmentProvenance,
  ExpectedReviewBinding,
  MemberAcceptanceProjection,
  MemberArtifactProjection,
  MemberAttemptEvidenceProjection,
  MemberEvaluationProjection,
  RecordTrustedEvaluatorCaptureInput,
} from './types.ts';

type JsonObject = Record<string, unknown>;

const ACCEPTANCE_ACTION = 'evidence.acceptance.decide';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CAPTURED_EVALUATOR_ENVIRONMENT_STATES = new Set(['ACTIVE', 'STOP_REQUESTED', 'UNKNOWN', 'TERMINATED']);

export class EvidenceStoreError extends Error {
  constructor(
    readonly code: EvidenceStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'EvidenceStoreError';
  }
}

function fail(code: EvidenceStoreErrorCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new EvidenceStoreError(code, message, details);
}

function requireText(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail('VALIDATION', `${name} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  const text = requireText(value, name, 64);
  if (!UUID_PATTERN.test(text)) fail('VALIDATION', `${name} must be a UUID.`);
  return text;
}

function requireDigest(value: unknown, name: string): Digest {
  try {
    return assertDigest(value, name);
  } catch (error) {
    if (error instanceof DomainValidationError) fail('VALIDATION', error.message);
    throw error;
  }
}

function requireRationale(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') fail('VALIDATION', 'rationale must be a string when supplied.');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes === 0 || bytes > 4_096 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail('VALIDATION', 'rationale must contain 1 to 4,096 UTF-8 bytes and no control characters.');
  }
  return value;
}

function requirePlainObject(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VALIDATION', `${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('VALIDATION', `${name} must be a plain object.`);
  return value as JsonObject;
}

function requireExpectedReview(value: unknown): ExpectedReviewBinding {
  const review = requirePlainObject(value, 'expectedReview');
  const keys = Object.keys(review).sort();
  const expected = ['artifactManifestDigest', 'attemptId', 'evaluatorProfileDigest', 'rawReportDigest', 'termsDigest'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('VALIDATION', 'expectedReview must contain only attemptId, artifactManifestDigest, termsDigest, evaluatorProfileDigest, and rawReportDigest.');
  }
  return {
    attemptId: requireUuid(review.attemptId, 'expectedReview.attemptId'),
    artifactManifestDigest: requireDigest(review.artifactManifestDigest, 'expectedReview.artifactManifestDigest'),
    termsDigest: requireDigest(review.termsDigest, 'expectedReview.termsDigest'),
    evaluatorProfileDigest: requireDigest(review.evaluatorProfileDigest, 'expectedReview.evaluatorProfileDigest'),
    rawReportDigest: requireDigest(review.rawReportDigest, 'expectedReview.rawReportDigest'),
  };
}

function asString(row: QueryResultRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Database returned ${field} as a non-string.`);
  return value;
}

function asInteger(row: QueryResultRow, field: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`Database returned ${field} as a non-integer.`);
}

function asBigIntegerText(row: QueryResultRow, field: string): string {
  const value = row[field];
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error(`Database returned ${field} as a non-positive bigint.`);
}

function asDate(row: QueryResultRow, field: string): string {
  const value = row[field];
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  throw new Error(`Database returned ${field} as an invalid timestamp.`);
}

function asJsonObject(value: unknown, field: string): JsonObject {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`Database returned ${field} as invalid JSON.`); }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Database returned ${field} as a non-object JSON value.`);
  }
  return parsed as JsonObject;
}

function asJsonArray(value: unknown, field: string): unknown[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`Database returned ${field} as invalid JSON.`); }
  }
  if (!Array.isArray(parsed)) throw new Error(`Database returned ${field} as a non-array JSON value.`);
  return parsed;
}

function storedDigest(row: QueryResultRow, field: string): Digest {
  try {
    return assertDigest(asString(row, field), field);
  } catch {
    throw new Error(`Database returned ${field} as an invalid digest.`);
  }
}

function comparisonText(row: QueryResultRow, field: string): string | null {
  const value = row[field];
  return value === null || value === undefined ? null : asString(row, field);
}

function normalizeDecision(value: unknown): 'ACCEPTED' | 'REJECTED' {
  if (value !== 'ACCEPTED' && value !== 'REJECTED') {
    fail('VALIDATION', 'decision must be ACCEPTED or REJECTED.');
  }
  return value;
}

function normalizeOutcome(value: unknown): EvaluationProjection['outcome'] {
  if (value !== 'VERIFIED' && value !== 'REJECTED' && value !== 'INCONCLUSIVE') {
    throw new Error('Database returned an invalid evaluation outcome.');
  }
  return value;
}

function evaluatorProvenance(row: QueryResultRow): EvaluatorEnvironmentProvenance {
  return {
    environmentId: asString(row, 'evaluator_environment_id'),
    provider: asString(row, 'evaluator_provider'),
    externalId: asString(row, 'evaluator_external_id'),
    sessionId: asString(row, 'evaluator_session_id'),
    leaseEpoch: asInteger(row, 'evaluator_lease_epoch'),
    controllerGeneration: asBigIntegerText(row, 'evaluator_controller_generation'),
  };
}

function evaluationProjection(row: QueryResultRow): EvaluationProjection {
  let evaluatorProfile: TrustedComparatorProfile;
  try {
    evaluatorProfile = validateTrustedComparatorProfile(asJsonObject(row.evaluator_profile, 'evaluator_profile'));
  } catch (error) {
    throw new Error(`Database returned an invalid evaluator profile: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const assessment = asJsonObject(row.assessment, 'assessment') as ComparatorAssessment;
  return {
    id: asString(row, 'id'),
    projectId: asString(row, 'project_id'),
    workOrderId: asString(row, 'work_order_id'),
    attemptId: asString(row, 'attempt_id'),
    artifactEnvironmentId: asString(row, 'artifact_environment_id'),
    artifactManifestDigest: storedDigest(row, 'artifact_manifest_digest'),
    artifactReceiptId: asString(row, 'artifact_receipt_id'),
    termsDigest: storedDigest(row, 'terms_digest'),
    evaluatorProfileDigest: storedDigest(row, 'evaluator_profile_digest'),
    evaluatorProfile,
    challengeDigest: storedDigest(row, 'challenge_digest'),
    dependencyLockDigest: storedDigest(row, 'dependency_lock_digest'),
    trustedBuildConfigDigest: storedDigest(row, 'trusted_build_config_digest'),
    rawReportDigest: storedDigest(row, 'raw_report_digest'),
    assessmentDigest: storedDigest(row, 'assessment_digest'),
    outcome: normalizeOutcome(asString(row, 'outcome')),
    assessment,
    evaluatorEnvironment: evaluatorProvenance(row),
    recordedAt: asDate(row, 'created_at'),
  };
}

function acceptanceDecisionProjection(row: QueryResultRow): AcceptanceDecisionProjection {
  return {
    id: asString(row, 'id'),
    evaluationId: asString(row, 'evaluation_id'),
    decision: normalizeDecision(asString(row, 'decision')),
    decidedAt: asDate(row, 'created_at'),
    attemptId: asString(row, 'attempt_id'),
    workOrderId: asString(row, 'work_order_id'),
    artifactManifestDigest: storedDigest(row, 'artifact_manifest_digest'),
    termsDigest: storedDigest(row, 'terms_digest'),
    evaluatorProfileDigest: storedDigest(row, 'evaluator_profile_digest'),
    rawReportDigest: storedDigest(row, 'raw_report_digest'),
  };
}

function memberAcceptance(value: unknown): MemberAcceptanceProjection | null {
  if (value === null || value === undefined) return null;
  const row = asJsonObject(value, 'acceptance');
  const created = row.decided_at;
  let decidedAt: string;
  if (created instanceof Date && !Number.isNaN(created.valueOf())) decidedAt = created.toISOString();
  else if (typeof created === 'string' && !Number.isNaN(Date.parse(created))) decidedAt = new Date(created).toISOString();
  else throw new Error('Database returned acceptance.decided_at as an invalid timestamp.');
  return {
    id: requireUuid(row.id, 'acceptance.id'),
    evaluationId: requireUuid(row.evaluation_id, 'acceptance.evaluation_id'),
    decision: normalizeDecision(row.decision),
    decidedAt,
  };
}

function memberEvaluation(value: unknown): MemberEvaluationProjection {
  const row = asJsonObject(value, 'evaluation');
  const created = row.created_at;
  let recordedAt: string;
  if (created instanceof Date && !Number.isNaN(created.valueOf())) recordedAt = created.toISOString();
  else if (typeof created === 'string' && !Number.isNaN(Date.parse(created))) recordedAt = new Date(created).toISOString();
  else throw new Error('Database returned evaluation.created_at as an invalid timestamp.');
  const outcome = row.outcome;
  if (outcome !== 'VERIFIED' && outcome !== 'REJECTED' && outcome !== 'INCONCLUSIVE') {
    throw new Error('Database returned an invalid member evaluation outcome.');
  }
  return {
    id: requireUuid(row.id, 'evaluation.id'),
    attemptId: requireUuid(row.attempt_id, 'evaluation.attempt_id'),
    workOrderId: requireUuid(row.work_order_id, 'evaluation.work_order_id'),
    artifactEnvironmentId: requireUuid(row.artifact_environment_id, 'evaluation.artifact_environment_id'),
    evaluatorEnvironmentId: requireUuid(row.evaluator_environment_id, 'evaluation.evaluator_environment_id'),
    artifactManifestDigest: requireDigest(row.artifact_manifest_digest, 'evaluation.artifact_manifest_digest'),
    termsDigest: requireDigest(row.terms_digest, 'evaluation.terms_digest'),
    evaluatorProfileDigest: requireDigest(row.evaluator_profile_digest, 'evaluation.evaluator_profile_digest'),
    challengeDigest: requireDigest(row.challenge_digest, 'evaluation.challenge_digest'),
    dependencyLockDigest: requireDigest(row.dependency_lock_digest, 'evaluation.dependency_lock_digest'),
    trustedBuildConfigDigest: requireDigest(row.trusted_build_config_digest, 'evaluation.trusted_build_config_digest'),
    rawReportDigest: requireDigest(row.raw_report_digest, 'evaluation.raw_report_digest'),
    assessmentDigest: requireDigest(row.assessment_digest, 'evaluation.assessment_digest'),
    outcome,
    recordedAt,
    acceptance: memberAcceptance(row.acceptance),
  };
}

function sameCapture(existing: QueryResultRow, input: {
  artifactEnvironmentId: string;
  evaluatorEnvironmentId: string;
  artifactManifestDigest: Digest;
  artifactReceiptId: string;
  termsDigest: Digest;
  evaluatorProfileDigest: Digest;
  evaluatorProfile: TrustedComparatorProfile;
  assessment: ComparatorAssessment;
  assessmentDigest: Digest;
  provenance: EvaluatorEnvironmentProvenance;
}): boolean {
  return asString(existing, 'artifact_environment_id') === input.artifactEnvironmentId
    && asString(existing, 'evaluator_environment_id') === input.evaluatorEnvironmentId
    && asString(existing, 'artifact_manifest_digest') === input.artifactManifestDigest
    && asString(existing, 'artifact_receipt_id') === input.artifactReceiptId
    && asString(existing, 'terms_digest') === input.termsDigest
    && asString(existing, 'evaluator_profile_digest') === input.evaluatorProfileDigest
    && asString(existing, 'assessment_digest') === input.assessmentDigest
    && normalizeOutcome(asString(existing, 'outcome')) === input.assessment.outcome
    && canonicalJson(asJsonObject(existing.evaluator_profile, 'evaluator_profile')) === canonicalJson(input.evaluatorProfile)
    && canonicalJson(asJsonObject(existing.assessment, 'assessment')) === canonicalJson(input.assessment)
    && asString(existing, 'evaluator_provider') === input.provenance.provider
    && asString(existing, 'evaluator_external_id') === input.provenance.externalId
    && asString(existing, 'evaluator_session_id') === input.provenance.sessionId
    && asInteger(existing, 'evaluator_lease_epoch') === input.provenance.leaseEpoch
    && asBigIntegerText(existing, 'evaluator_controller_generation') === input.provenance.controllerGeneration;
}

function mapEvaluatorContractError(error: unknown): never {
  if (error instanceof EvaluatorContractError) {
    const code = ['BINDING_MISMATCH', 'RAW_REPORT_DIGEST_MISMATCH', 'OUTCOME_INVALID'].includes(error.code)
      ? 'EVALUATION_BINDING_MISMATCH'
      : 'VALIDATION';
    fail(code, error.message, { evaluatorCode: error.code });
  }
  if (error instanceof DomainValidationError) fail('VALIDATION', error.message);
  throw error;
}

/**
 * Privileged PostgreSQL evidence store. The process that constructs this class
 * must keep it separate from worker/run capabilities. Its trusted-capture
 * method validates the collector bytes but, by design, cannot authenticate an
 * arbitrary caller that obtained this internal interface.
 */
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query('BEGIN');
      begun = true;
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (begun) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async idempotent<T>(
    client: PoolClient,
    identity: { actorId: string; idempotencyKey: string },
    body: unknown,
    work: () => Promise<{ response: T; resourceId: string }>,
  ): Promise<T> {
    const actorId = requireText(identity.actorId, 'actorId', 512);
    const idempotencyKey = requireText(identity.idempotencyKey, 'idempotencyKey', 512);
    const bodyDigest = digestCanonicalJson(body);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      `${actorId}\u001f${ACCEPTANCE_ACTION}\u001f${idempotencyKey}`,
    ]);
    const existing = await client.query<{ body_digest: string; response: T | null }>(
      `SELECT body_digest, response
       FROM motive.idempotency_records
       WHERE actor_id = $1 AND action = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [actorId, ACCEPTANCE_ACTION, idempotencyKey],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.body_digest !== bodyDigest) {
        fail('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different acceptance request.');
      }
      if (row.response === null) {
        fail('IDEMPOTENCY_INCOMPLETE', 'This idempotency key has an incomplete durable result and requires reconciliation.');
      }
      return row.response;
    }
    await client.query(
      `INSERT INTO motive.idempotency_records (actor_id, action, idempotency_key, body_digest, effect_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, ACCEPTANCE_ACTION, idempotencyKey, bodyDigest, randomUUID()],
    );
    const result = await work();
    await client.query(
      `UPDATE motive.idempotency_records
       SET response = $4::jsonb, resource_type = 'acceptance_decision', resource_id = $5
       WHERE actor_id = $1 AND action = $2 AND idempotency_key = $3`,
      [actorId, ACCEPTANCE_ACTION, idempotencyKey, JSON.stringify(result.response), result.resourceId],
    );
    return result.response;
  }

  private async lockCaptureContext(
    client: PoolClient,
    artifactEnvironmentId: string,
    evaluatorEnvironmentId: string,
  ): Promise<{ attempt: QueryResultRow; workOrder: QueryResultRow; artifact: QueryResultRow; evaluator: QueryResultRow; seal: QueryResultRow }> {
    const reference = await client.query<{ attempt_id: string | null }>(
      'SELECT attempt_id FROM motive.orchestration_environments WHERE id = $1', [artifactEnvironmentId],
    );
    if (reference.rowCount !== 1 || reference.rows[0].attempt_id === null) {
      fail('ARTIFACT_NOT_SEALED', 'The artifact environment is not a tracked attempt environment.');
    }
    const attemptResult = await client.query(
      'SELECT * FROM motive.attempts WHERE id = $1 FOR UPDATE', [reference.rows[0].attempt_id],
    );
    if (attemptResult.rowCount !== 1) fail('NOT_FOUND', 'Attempt was not found.');
    const attempt = attemptResult.rows[0];
    const environments = await client.query(
      `SELECT * FROM motive.orchestration_environments
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[artifactEnvironmentId, evaluatorEnvironmentId]],
    );
    if (environments.rowCount !== 2) fail('EVALUATOR_ENVIRONMENT_INVALID', 'Artifact and evaluator environments must both exist.');
    const artifact = environments.rows.find(row => asString(row, 'id') === artifactEnvironmentId);
    const evaluator = environments.rows.find(row => asString(row, 'id') === evaluatorEnvironmentId);
    if (!artifact || !evaluator) throw new Error('Locked environment identity was not returned.');
    if (asString(artifact, 'attempt_id') !== asString(attempt, 'id')
      || asString(evaluator, 'attempt_id') !== asString(attempt, 'id')) {
      fail('EVALUATION_BINDING_MISMATCH', 'Artifact and evaluator environments must belong to the exact same attempt.');
    }
    const workOrders = await client.query(
      `SELECT * FROM motive.work_orders
       WHERE id = $1 AND project_id = $2
       FOR KEY SHARE`,
      [asString(attempt, 'work_order_id'), asString(attempt, 'project_id')],
    );
    if (workOrders.rowCount !== 1) fail('NOT_FOUND', 'Frozen work order was not found.');
    const seals = await client.query(
      `SELECT * FROM motive.orchestration_artifact_seals
       WHERE environment_id = $1 AND attempt_id = $2
       FOR KEY SHARE`,
      [artifactEnvironmentId, asString(attempt, 'id')],
    );
    if (seals.rowCount !== 1) fail('ARTIFACT_NOT_SEALED', 'No durable artifact seal exists for the worker environment.');
    return { attempt, workOrder: workOrders.rows[0], artifact, evaluator, seal: seals.rows[0] };
  }

  private frozenTerms(attempt: QueryResultRow, workOrder: QueryResultRow): { termsDigest: Digest; evaluatorProfileDigest: Digest } {
    const attemptTermsDigest = storedDigest(attempt, 'terms_digest');
    const workOrderTermsDigest = storedDigest(workOrder, 'terms_digest');
    if (attemptTermsDigest !== workOrderTermsDigest) {
      fail('EVALUATION_BINDING_MISMATCH', 'Attempt terms do not match the frozen work-order terms.');
    }
    let terms;
    try {
      terms = validateWorkOrderTerms(asJsonObject(workOrder.terms, 'terms'));
    } catch (error) {
      if (error instanceof DomainValidationError) {
        fail('EVALUATION_BINDING_MISMATCH', `Frozen work-order terms are invalid: ${error.message}`);
      }
      throw error;
    }
    if (terms.project_id !== asString(attempt, 'project_id') || digestCanonicalJson(terms) !== workOrderTermsDigest) {
      fail('EVALUATION_BINDING_MISMATCH', 'Frozen work-order terms do not match their durable identity.');
    }
    return { termsDigest: attemptTermsDigest, evaluatorProfileDigest: terms.evaluation.profile_digest };
  }

  async recordTrustedEvaluatorCapture(input: RecordTrustedEvaluatorCaptureInput): Promise<EvaluationProjection> {
    const artifactEnvironmentId = requireUuid(input.artifactEnvironmentId, 'artifactEnvironmentId');
    const evaluatorEnvironmentId = requireUuid(input.evaluatorEnvironmentId, 'evaluatorEnvironmentId');
    if (artifactEnvironmentId === evaluatorEnvironmentId) {
      fail('EVALUATOR_ENVIRONMENT_INVALID', 'A worker artifact environment cannot also be the evaluator environment.');
    }
    return this.transaction(async client => {
      const { attempt, workOrder, artifact, evaluator, seal } = await this.lockCaptureContext(
        client, artifactEnvironmentId, evaluatorEnvironmentId,
      );
      if (asString(artifact, 'kind') !== 'WORKER') {
        fail('ARTIFACT_NOT_SEALED', 'Only a worker environment can supply a candidate artifact.');
      }
      if (asString(seal, 'status') !== 'SEALED' || comparisonText(seal, 'manifest_digest') === null) {
        fail('ARTIFACT_NOT_SEALED', 'Evaluator capture requires a durable SEALED artifact manifest.');
      }
      if (asString(evaluator, 'kind') !== 'EVALUATOR'
        || !CAPTURED_EVALUATOR_ENVIRONMENT_STATES.has(asString(evaluator, 'state'))
        || comparisonText(evaluator, 'provider') === null
        || comparisonText(evaluator, 'external_id') === null
        || comparisonText(evaluator, 'session_id') === null) {
        fail('EVALUATOR_ENVIRONMENT_INVALID', 'Capture requires an observed evaluator environment from the exact attempt.');
      }
      const frozen = this.frozenTerms(attempt, workOrder);
      if (comparisonText(evaluator, 'profile_digest') !== frozen.evaluatorProfileDigest) {
        fail('EVALUATION_BINDING_MISMATCH', 'Evaluator environment profile does not match the frozen evaluation profile.');
      }
      const artifactManifestDigest = storedDigest(seal, 'manifest_digest');
      let evaluatorProfile: TrustedComparatorProfile;
      let assessment: ComparatorAssessment;
      try {
        evaluatorProfile = validateTrustedComparatorProfile(input.evaluatorProfile);
        assessment = validateTrustedComparatorReport({
          evaluator_profile: evaluatorProfile,
          frozen_evaluator_profile_digest: frozen.evaluatorProfileDigest,
          solution_artifact_manifest_digest: artifactManifestDigest,
          captured_report: input.capturedReport,
        });
      } catch (error) {
        mapEvaluatorContractError(error);
      }
      const provenance: EvaluatorEnvironmentProvenance = {
        environmentId: evaluatorEnvironmentId,
        provider: asString(evaluator, 'provider'),
        externalId: asString(evaluator, 'external_id'),
        sessionId: asString(evaluator, 'session_id'),
        leaseEpoch: asInteger(evaluator, 'lease_epoch'),
        controllerGeneration: asBigIntegerText(evaluator, 'controller_generation'),
      };
      const assessmentDigest = digestCanonicalJson(assessment!);
      const existing = await client.query(
        `SELECT * FROM motive.evaluations
         WHERE attempt_id = $1 AND raw_report_digest = $2
         FOR UPDATE`,
        [asString(attempt, 'id'), assessment!.raw_report_digest],
      );
      const captureIdentity = {
        artifactEnvironmentId,
        evaluatorEnvironmentId,
        artifactManifestDigest,
        artifactReceiptId: asString(seal, 'receipt_id'),
        termsDigest: frozen.termsDigest,
        evaluatorProfileDigest: frozen.evaluatorProfileDigest,
        evaluatorProfile: evaluatorProfile!,
        assessment: assessment!,
        assessmentDigest,
        provenance,
      };
      if (existing.rowCount === 1) {
        if (!sameCapture(existing.rows[0], captureIdentity)) {
          fail('EVALUATION_CAPTURE_CONFLICT', 'The exact captured-report digest is already bound to different durable evaluator evidence.');
        }
        return evaluationProjection(existing.rows[0]);
      }
      const evaluationId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO motive.evaluations (
          id, project_id, work_order_id, attempt_id, artifact_environment_id, evaluator_environment_id,
          artifact_manifest_digest, artifact_receipt_id, terms_digest, evaluator_profile_digest, evaluator_profile,
          challenge_digest, dependency_lock_digest, trusted_build_config_digest, raw_report_digest,
          assessment_digest, assessment, outcome,
          evaluator_provider, evaluator_external_id, evaluator_session_id, evaluator_lease_epoch, evaluator_controller_generation
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
          $16, $17::jsonb, $18, $19, $20, $21, $22, $23
        ) RETURNING *`,
        [
          evaluationId, asString(attempt, 'project_id'), asString(attempt, 'work_order_id'), asString(attempt, 'id'),
          artifactEnvironmentId, evaluatorEnvironmentId, artifactManifestDigest, captureIdentity.artifactReceiptId,
          frozen.termsDigest, frozen.evaluatorProfileDigest, JSON.stringify(evaluatorProfile),
          assessment!.challenge_digest, assessment!.dependency_lock_digest, assessment!.trusted_build_config_digest,
          assessment!.raw_report_digest, assessmentDigest, JSON.stringify(assessment), assessment!.outcome,
          provenance.provider, provenance.externalId, provenance.sessionId, provenance.leaseEpoch, provenance.controllerGeneration,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error('Trusted evaluator capture was not persisted.');
      return evaluationProjection(inserted.rows[0]);
    });
  }

  async findAttemptEvidenceForMember(input: { actorId: string; attemptId: string }): Promise<MemberAttemptEvidenceProjection | null> {
    const actorId = requireText(input.actorId, 'actorId', 512);
    const attemptId = requireUuid(input.attemptId, 'attemptId');
    // This is one membership-scoped statement and intentionally has no row
    // locks, so it also works through the restricted read-only control role.
    const result = await this.pool.query(
      `WITH scoped_attempt AS (
        SELECT attempt.id, attempt.work_order_id, attempt.terms_digest
        FROM motive.attempts AS attempt
        WHERE attempt.id = $1
          AND EXISTS (
            SELECT 1 FROM motive.memberships AS membership
            WHERE membership.project_id = attempt.project_id
              AND membership.actor_id = $2
              AND membership.revoked_at IS NULL
          )
      )
      SELECT scoped_attempt.id, scoped_attempt.work_order_id, scoped_attempt.terms_digest,
             seal.environment_id AS artifact_environment_id,
             seal.manifest_digest AS artifact_manifest_digest,
             seal.created_at AS artifact_sealed_at,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', evaluation.id,
                   'attempt_id', evaluation.attempt_id,
                   'work_order_id', evaluation.work_order_id,
                   'artifact_environment_id', evaluation.artifact_environment_id,
                   'evaluator_environment_id', evaluation.evaluator_environment_id,
                   'artifact_manifest_digest', evaluation.artifact_manifest_digest,
                   'terms_digest', evaluation.terms_digest,
                   'evaluator_profile_digest', evaluation.evaluator_profile_digest,
                   'challenge_digest', evaluation.challenge_digest,
                   'dependency_lock_digest', evaluation.dependency_lock_digest,
                   'trusted_build_config_digest', evaluation.trusted_build_config_digest,
                   'raw_report_digest', evaluation.raw_report_digest,
                   'assessment_digest', evaluation.assessment_digest,
                   'outcome', evaluation.outcome::text,
                   'created_at', evaluation.created_at,
                   'acceptance', CASE WHEN decision.id IS NULL THEN NULL ELSE jsonb_build_object(
                     'id', decision.id,
                     'evaluation_id', decision.evaluation_id,
                     'decision', decision.decision::text,
                     'decided_at', decision.created_at
                   ) END
                 ) ORDER BY evaluation.created_at, evaluation.id
               ) FILTER (WHERE evaluation.id IS NOT NULL),
               '[]'::jsonb
             ) AS evaluations
      FROM scoped_attempt
      LEFT JOIN motive.orchestration_artifact_seals AS seal
        ON seal.attempt_id = scoped_attempt.id AND seal.status = 'SEALED'
      LEFT JOIN motive.evaluations AS evaluation ON evaluation.attempt_id = scoped_attempt.id
      LEFT JOIN motive.acceptance_decisions AS decision ON decision.evaluation_id = evaluation.id
      GROUP BY scoped_attempt.id, scoped_attempt.work_order_id, scoped_attempt.terms_digest,
               seal.environment_id, seal.manifest_digest, seal.created_at`,
      [attemptId, actorId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    const artifact: MemberArtifactProjection | null = row.artifact_environment_id === null
      ? null
      : {
        environmentId: asString(row, 'artifact_environment_id'),
        manifestDigest: storedDigest(row, 'artifact_manifest_digest'),
        sealedAt: asDate(row, 'artifact_sealed_at'),
      };
    return {
      attemptId: asString(row, 'id'),
      workOrderId: asString(row, 'work_order_id'),
      termsDigest: storedDigest(row, 'terms_digest'),
      artifact,
      evaluations: asJsonArray(row.evaluations, 'evaluations').map(memberEvaluation),
    };
  }

  async findEvaluationForMember(input: { actorId: string; evaluationId: string }): Promise<MemberEvaluationProjection | null> {
    const actorId = requireText(input.actorId, 'actorId', 512);
    const evaluationId = requireUuid(input.evaluationId, 'evaluationId');
    const result = await this.pool.query(
      `SELECT jsonb_build_object(
          'id', evaluation.id,
          'attempt_id', evaluation.attempt_id,
          'work_order_id', evaluation.work_order_id,
          'artifact_environment_id', evaluation.artifact_environment_id,
          'evaluator_environment_id', evaluation.evaluator_environment_id,
          'artifact_manifest_digest', evaluation.artifact_manifest_digest,
          'terms_digest', evaluation.terms_digest,
          'evaluator_profile_digest', evaluation.evaluator_profile_digest,
          'challenge_digest', evaluation.challenge_digest,
          'dependency_lock_digest', evaluation.dependency_lock_digest,
          'trusted_build_config_digest', evaluation.trusted_build_config_digest,
          'raw_report_digest', evaluation.raw_report_digest,
          'assessment_digest', evaluation.assessment_digest,
          'outcome', evaluation.outcome::text,
          'created_at', evaluation.created_at,
          'acceptance', CASE WHEN decision.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', decision.id,
            'evaluation_id', decision.evaluation_id,
            'decision', decision.decision::text,
            'decided_at', decision.created_at
          ) END
        ) AS evaluation
       FROM motive.evaluations AS evaluation
       LEFT JOIN motive.acceptance_decisions AS decision ON decision.evaluation_id = evaluation.id
       WHERE evaluation.id = $1
         AND EXISTS (
           SELECT 1 FROM motive.memberships AS membership
           WHERE membership.project_id = evaluation.project_id
             AND membership.actor_id = $2
             AND membership.revoked_at IS NULL
         )`,
      [evaluationId, actorId],
    );
    return result.rowCount === 0 ? null : memberEvaluation(result.rows[0].evaluation);
  }

  async decideAcceptance(input: DecideAcceptanceInput): Promise<AcceptanceDecisionProjection> {
    const actorId = requireText(input.actorId, 'actorId', 512);
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey', 512);
    const evaluationId = requireUuid(input.evaluationId, 'evaluationId');
    const decision = normalizeDecision(input.decision);
    const expectedReview = requireExpectedReview(input.expectedReview);
    const rationale = requireRationale(input.rationale);
    const requestBody = {
      evaluationId,
      decision,
      expectedReview,
      ...(rationale === null ? {} : { rationale }),
    };
    return this.transaction(async client => {
      // Lock attempt before membership. This both fences a concurrent evaluator
      // reservation and establishes access before any policy/binding detail is
      // inspected or an idempotency replay is returned.
      const evaluationReference = await client.query<{ attempt_id: string }>(
        'SELECT attempt_id FROM motive.evaluations WHERE id = $1', [evaluationId],
      );
      if (evaluationReference.rowCount !== 1) fail('NOT_FOUND', 'Evaluation was not found.');
      const attemptResult = await client.query(
        'SELECT id FROM motive.attempts WHERE id = $1 FOR UPDATE', [evaluationReference.rows[0].attempt_id],
      );
      if (attemptResult.rowCount !== 1) fail('NOT_FOUND', 'Evaluation was not found.');
      const evaluationResult = await client.query(
        `SELECT * FROM motive.evaluations
         WHERE id = $1 AND attempt_id = $2
         FOR UPDATE`,
        [evaluationId, evaluationReference.rows[0].attempt_id],
      );
      if (evaluationResult.rowCount !== 1) fail('NOT_FOUND', 'Evaluation was not found.');
      const evaluation = evaluationResult.rows[0];
      const membership = await client.query(
        `SELECT role, revoked_at FROM motive.memberships
         WHERE project_id = $1 AND actor_id = $2
         FOR UPDATE`,
        [asString(evaluation, 'project_id'), actorId],
      );
      // Do not disclose whether the evaluation exists to an absent or revoked
      // member. An active, lower-privilege member receives MAINTAINER_REQUIRED.
      if (membership.rowCount !== 1 || membership.rows[0].revoked_at !== null) {
        fail('NOT_FOUND', 'Evaluation was not found.');
      }
      if (!['OWNER', 'STEWARD'].includes(asString(membership.rows[0], 'role'))) {
        fail('MAINTAINER_REQUIRED', 'A current project owner or steward must make this decision.');
      }
      return this.idempotent(
        client,
        { actorId, idempotencyKey },
        requestBody,
        async () => {
          const exactBinding = asString(evaluation, 'attempt_id') === expectedReview.attemptId
          && asString(evaluation, 'artifact_manifest_digest') === expectedReview.artifactManifestDigest
          && asString(evaluation, 'terms_digest') === expectedReview.termsDigest
          && asString(evaluation, 'evaluator_profile_digest') === expectedReview.evaluatorProfileDigest
          && asString(evaluation, 'raw_report_digest') === expectedReview.rawReportDigest;
          if (!exactBinding) {
            fail('EVALUATION_BINDING_MISMATCH', 'The requested human decision does not match the frozen evaluated artifact and terms.');
          }
        const workOrder = await client.query(
          `SELECT terms, terms_digest FROM motive.work_orders
           WHERE id = $1 AND project_id = $2 AND terms_digest = $3
           FOR KEY SHARE`,
          [asString(evaluation, 'work_order_id'), asString(evaluation, 'project_id'), asString(evaluation, 'terms_digest')],
        );
        if (workOrder.rowCount !== 1) {
          fail('EVALUATION_BINDING_MISMATCH', 'The evaluation no longer resolves to its frozen work-order terms.');
        }
        let terms;
        try {
          terms = validateWorkOrderTerms(asJsonObject(workOrder.rows[0].terms, 'terms'));
        } catch (error) {
          if (error instanceof DomainValidationError) {
            fail('EVALUATION_BINDING_MISMATCH', `Frozen work-order terms are invalid: ${error.message}`);
          }
          throw error;
        }
        if (!terms.evaluation.human_acceptance_required) {
          fail('HUMAN_REVIEW_NOT_REQUIRED', 'Frozen work-order terms do not permit a human acceptance decision.');
        }
        if (decision === 'ACCEPTED' && asString(evaluation, 'outcome') !== 'VERIFIED') {
          fail('EVALUATION_NOT_VERIFIED', 'Only a VERIFIED evaluator assessment may receive ACCEPTED.');
        }
        const liveEnvironment = await client.query(
          `SELECT id FROM motive.orchestration_environments
           WHERE attempt_id = $1 AND kind IN ('WORKER', 'EVALUATOR')
             AND state NOT IN ('TERMINATED', 'ABANDONED')
           LIMIT 1`,
          [asString(evaluation, 'attempt_id')],
        );
        if ((liveEnvironment.rowCount ?? 0) > 0) {
          fail('REVIEW_NOT_READY', 'Human review requires every tracked worker and evaluator to be terminal or abandoned.');
        }
        const existing = await client.query(
          `SELECT * FROM motive.acceptance_decisions
           WHERE attempt_id = $1
           FOR UPDATE`,
          [asString(evaluation, 'attempt_id')],
        );
        if (existing.rowCount === 1) {
          fail('ACCEPTANCE_ALREADY_DECIDED', 'This frozen attempt already has an immutable human decision.');
        }
        const inserted = await client.query(
          `INSERT INTO motive.acceptance_decisions (
            id, project_id, work_order_id, attempt_id, evaluation_id, artifact_manifest_digest,
            terms_digest, evaluator_profile_digest, raw_report_digest, decision, decided_by_actor_id, rationale
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING *`,
          [
            randomUUID(), asString(evaluation, 'project_id'), asString(evaluation, 'work_order_id'),
            asString(evaluation, 'attempt_id'), asString(evaluation, 'id'), asString(evaluation, 'artifact_manifest_digest'),
            asString(evaluation, 'terms_digest'), asString(evaluation, 'evaluator_profile_digest'),
            asString(evaluation, 'raw_report_digest'), decision, actorId, rationale,
          ],
        );
        if (inserted.rowCount !== 1) throw new Error('Acceptance decision was not persisted.');
        const response = acceptanceDecisionProjection(inserted.rows[0]);
          return { response, resourceId: response.id };
        },
      );
    });
  }
}
