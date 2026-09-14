import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { LedgerKernel, type AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import type { ImmutableObjectStore } from '../../packages/artifact-storage/src/types.ts';
import { canonicalJson, digestCanonicalJson, validateWorkOrderTerms, type Digest } from '../../packages/domain/src/contracts.ts';
import {
  CIRCLE_CANDIDATE_MEDIA_TYPE,
  CIRCLE_CANDIDATE_PATH,
  CIRCLE_EVALUATOR_PROFILE,
  CIRCLE_EVALUATOR_PROFILE_DIGEST,
  SealedCircleCandidateReader,
  SealedCircleInvestigationReader,
  SealedCirclePackingEvaluator,
  circleByteDigest,
  type CircleEvaluatorReport,
  type TrustedCircleSealContextResolver,
} from '../../packages/evaluator-circle/src/index.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { ArtifactSealProjection } from '../../packages/orchestration/src/store-types.ts';
import type {
  HostedCirclePublicArtifact,
  HostedCirclePublicInvestigation,
  HostedCirclePublicReport,
  HostedCirclePublicResults,
  HostedCircleResultSummary,
  HostedCircleReview,
  ReviewHostedCircleResultInput,
} from '../../src/lib/hosted-results.ts';
import type { SubmissionResearchReference } from '../../src/lib/participation.ts';
import { parseHostedInvestigation } from './learning.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTION = 'hosted_circle.review';
const CANDIDATE_PATH_TOKEN = 'a2ce32b4f23bbd97594d26707bcfb2c7d0090893f7ead7edf49394e00a7111da';
const INVESTIGATION_PATH_TOKEN = 'd10feb13d4b19c689631615a1cbeac981392022f29fca8cb721eb9e006d34570';
const SAFE_REJECTED_ARTIFACT_CODES = new Set(['NONPOSITIVE_RADIUS', 'OUT_OF_BOUNDS', 'OVERLAP']);

export type CircleResultsErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'STORAGE_UNAVAILABLE'
  | 'ARTIFACT_UNAVAILABLE';

export class CircleResultsError extends Error {
  constructor(readonly code: CircleResultsErrorCode, message: string, readonly status: number) {
    super(message); this.name = 'CircleResultsError';
  }
}

export type CircleResultsServiceOptions = {
  pool: Pool;
  objects: Pick<ImmutableObjectStore, 'readObject'> | null;
  validateResearchReferences?: (projectId: string, references: SubmissionResearchReference[], client: PoolClient) => Promise<void>;
};

function fail(code: CircleResultsErrorCode, message: string, status: number): never {
  throw new CircleResultsError(code, message, status);
}

function text(row: QueryResultRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Database field ${field} is invalid.`);
  return value;
}

function nullableText(row: QueryResultRow, field: string): string | null {
  return row[field] === null || row[field] === undefined ? null : text(row, field);
}

function bool(row: QueryResultRow, field: string): boolean {
  if (typeof row[field] !== 'boolean') throw new Error(`Database field ${field} is invalid.`);
  return row[field] as boolean;
}

function date(row: QueryResultRow, field: string): string {
  const value = row[field] instanceof Date ? row[field] as Date : new Date(String(row[field]));
  if (!Number.isFinite(value.getTime())) throw new Error(`Database field ${field} is invalid.`);
  return value.toISOString();
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('VALIDATION', `${field} must be a UUID.`, 400);
  return value;
}

function digest(value: unknown, field: string): Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('VALIDATION', `${field} must be a SHA-256 digest.`, 400);
  return value as Digest;
}

function reviewProjection(row: QueryResultRow): HostedCircleReview | null {
  if (row.review_id === null || row.review_id === undefined) return null;
  const decision = text(row, 'review_decision');
  if (decision !== 'ACCEPTED' && decision !== 'REJECTED') throw new Error('Database review decision is invalid.');
  return { id: text(row, 'review_id'), decision, decidedAt: date(row, 'review_created_at') };
}

function summary(row: QueryResultRow): HostedCircleResultSummary {
  const status = text(row, 'status');
  if (status !== 'VALID' && status !== 'REJECTED') throw new Error('Database result status is invalid.');
  return {
    id: text(row, 'id'), attemptId: text(row, 'attempt_id'),
    model: { id: text(row, 'model_id'), inferenceProfileDigest: text(row, 'inference_profile_digest') as Digest },
    status, exactScore: nullableText(row, 'exact_score'), exceedsReference: row.exceeds_reference === null ? null : bool(row, 'exceeds_reference'),
    artifactManifestDigest: text(row, 'artifact_manifest_digest') as Digest,
    candidateDigest: text(row, 'candidate_digest') as Digest,
    evaluationProfileDigest: text(row, 'evaluation_profile_digest') as Digest,
    reportDigest: text(row, 'report_digest') as Digest, artifactAvailable: bool(row, 'artifact_available'),
    investigation: { status: row.investigation_status === 'VALID' || row.investigation_status === 'INVALID'
      ? row.investigation_status : 'NOT_PROVIDED',
    href: `/api/public/projects/circle-packing/hosted-results/${text(row, 'id')}/investigation` },
    createdAt: date(row, 'created_at'), review: reviewProjection(row),
  };
}

function reviewInput(value: ReviewHostedCircleResultInput): ReviewHostedCircleResultInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['ACCEPTED', 'REJECTED'].includes(value.decision)
      || typeof value.rationale !== 'string' || Buffer.byteLength(value.rationale, 'utf8') < 1
      || Buffer.byteLength(value.rationale, 'utf8') > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.rationale)
      || !value.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)) {
    fail('VALIDATION', 'Review must contain a decision, bounded rationale, and exact expected result bindings.', 400);
  }
  uuid(value.expected.attemptId, 'expected.attemptId');
  digest(value.expected.artifactManifestDigest, 'expected.artifactManifestDigest');
  digest(value.expected.evaluationProfileDigest, 'expected.evaluationProfileDigest');
  digest(value.expected.reportDigest, 'expected.reportDigest');
  return value;
}

function candidateObjectKey(projectId: string, attemptId: string, environmentId: string): string {
  return `projects/${projectId}/attempts/${attemptId}/seals/${environmentId}/files/${CANDIDATE_PATH_TOKEN}`;
}

function artifactAvailable(report: CircleEvaluatorReport): boolean {
  return report.outcome === 'VALID'
    || (!report.result.ok && SAFE_REJECTED_ARTIFACT_CODES.has(report.result.error.code));
}

const RESULT_SELECT = `SELECT result.*, review.id AS review_id, review.decision AS review_decision,
  review.created_at AS review_created_at, investigation.status AS investigation_status,
  investigation.validation_code AS investigation_validation_code,
  investigation.investigation_digest, investigation.investigation_bytes, investigation.investigation_body
  FROM motive.hosted_circle_results result
  LEFT JOIN motive.hosted_circle_result_reviews review ON review.result_id=result.id
  LEFT JOIN motive.hosted_circle_investigations investigation ON investigation.result_id=result.id`;

export class CircleResultsService {
  private readonly ledger: LedgerKernel;
  private readonly orchestration: PostgresOrchestrationStore;
  private readonly contextResolver: TrustedCircleSealContextResolver;

  constructor(private readonly options: CircleResultsServiceOptions) {
    this.ledger = new LedgerKernel(options.pool);
    this.orchestration = new PostgresOrchestrationStore(options.pool);
    this.contextResolver = { resolve: async ({ attemptId, signal }) => {
      signal.throwIfAborted();
      const [attempt, execution] = await Promise.all([this.ledger.getAttempt(attemptId), this.orchestration.getExecution(attemptId)]);
      signal.throwIfAborted();
      const seal = execution?.artifactSeal;
      const worker = execution?.environments.find(item => item.id === seal?.environmentId);
      if (!attempt || !seal || seal.status !== 'SEALED' || !seal.manifestDigest || !worker
          || worker.kind !== 'WORKER' || worker.state !== 'TERMINATED' || worker.attemptId !== attemptId) return null;
      return { projectId: attempt.projectId, workerEnvironmentId: worker.id };
    } };
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private requireObjects(): Pick<ImmutableObjectStore, 'readObject'> {
    return this.options.objects ?? fail('STORAGE_UNAVAILABLE', 'Immutable artifact storage is not configured.', 503);
  }

  private async authority(attempt: AttemptProjection): Promise<QueryResultRow> {
    const result = await this.options.pool.query(`SELECT work.terms, work.terms_digest, work.project_revision,
        activation.profile_digest AS activation_profile_digest, activation.beneficiary_actor_id,
        budget.model_id, budget.work_order_id AS budget_work_order_id
      FROM motive.work_orders work
      JOIN motive.provider_budget_activations activation ON activation.attempt_id=$1 AND activation.work_order_id=work.id
      JOIN motive.provider_project_budgets budget ON budget.id=activation.budget_id
      WHERE work.id=$2 AND work.project_id=$3`, [attempt.id, attempt.workOrderId, attempt.projectId]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Hosted circle evaluation authority is unavailable.', 404);
    const row = result.rows[0];
    if (row.terms_digest !== attempt.termsDigest || row.activation_profile_digest !== attempt.profileDigest
        || row.budget_work_order_id !== attempt.workOrderId || typeof row.beneficiary_actor_id !== 'string'
        || typeof row.model_id !== 'string') fail('CONFLICT', 'Hosted attempt authority no longer matches its frozen material.', 409);
    return row;
  }

  async evaluateAttempt(attemptId: string): Promise<HostedCircleResultSummary> {
    uuid(attemptId, 'attemptId');
    const objects = this.requireObjects();
    const attempt = await this.ledger.getAttempt(attemptId);
    if (!attempt) fail('NOT_FOUND', 'Hosted attempt was not found.', 404);
    const execution = await this.orchestration.getExecution(attemptId);
    const seal = execution?.artifactSeal;
    if (!seal || seal.status !== 'SEALED' || !seal.manifestDigest) fail('ARTIFACT_UNAVAILABLE', 'Hosted attempt has no complete sealed artifact.', 409);
    const authority = await this.authority(attempt);
    let terms;
    try { terms = validateWorkOrderTerms(authority.terms); }
    catch { return fail('CONFLICT', 'Hosted work-order terms are invalid.', 409); }
    if (terms.evaluation.profile_digest !== CIRCLE_EVALUATOR_PROFILE_DIGEST) {
      fail('CONFLICT', 'Hosted work order does not pin the reviewed circle evaluator profile.', 409);
    }
    const evaluator = new SealedCirclePackingEvaluator({ store: objects, contextResolver: this.contextResolver });
    const learningReader = new SealedCircleInvestigationReader({ store: objects, contextResolver: this.contextResolver });
    const capture = await evaluator.evaluate({ attempt, artifactSeal: seal, signal: AbortSignal.timeout(15_000),
      workOrderTerms: terms, evaluationProfile: CIRCLE_EVALUATOR_PROFILE,
      evaluationProfileDigest: CIRCLE_EVALUATOR_PROFILE_DIGEST });
    const learning = await learningReader.read({ attempt, artifactSeal: seal, signal: AbortSignal.timeout(15_000) });
    const parsedInvestigation = learning.investigationBytes ? parseHostedInvestigation(learning.investigationBytes) : null;
    const report = capture.report;
    const exactScore = report.result.ok ? report.result.report.objective.exact_decimal : null;
    const exceedsReference = report.result.ok
      ? report.result.report.objective.versus_frozen_reference_5_29109518547430697 === 'greater' : null;
    const available = artifactAvailable(report);
    const id = randomUUID();
    return this.transaction(async client => {
      const locked = await client.query(`SELECT attempt.id, attempt.project_id, attempt.work_order_id, attempt.terms_digest,
          attempt.input_digest, attempt.profile_digest, work.terms,
          seal.environment_id, seal.manifest_digest, seal.receipt_id,
          activation.profile_digest AS activation_profile_digest, activation.beneficiary_actor_id,
          budget.id AS budget_id, budget.model_id, budget.work_order_id AS budget_work_order_id
        FROM motive.attempts attempt
        JOIN motive.work_orders work ON work.id=attempt.work_order_id
        JOIN motive.orchestration_artifact_seals seal ON seal.attempt_id=attempt.id
        JOIN motive.provider_budget_activations activation ON activation.attempt_id=attempt.id
        JOIN motive.provider_project_budgets budget ON budget.id=activation.budget_id
        WHERE attempt.id=$1 FOR UPDATE OF attempt`, [attemptId]);
      if (locked.rowCount !== 1) fail('NOT_FOUND', 'Hosted attempt was not found.', 404);
      const row = locked.rows[0];
      const same = row.project_id === attempt.projectId && row.work_order_id === attempt.workOrderId
        && row.terms_digest === attempt.termsDigest && row.input_digest === attempt.inputDigest
        && row.profile_digest === attempt.profileDigest && row.environment_id === seal.environmentId
        && row.manifest_digest === seal.manifestDigest && row.receipt_id === seal.receiptId
        && row.activation_profile_digest === attempt.profileDigest && row.beneficiary_actor_id === authority.beneficiary_actor_id
        && row.model_id === authority.model_id && row.budget_work_order_id === attempt.workOrderId
        && digestCanonicalJson(validateWorkOrderTerms(row.terms)) === attempt.termsDigest;
      if (!same) fail('CONFLICT', 'Hosted attempt changed while its artifact was evaluated.', 409);
      const inserted = await client.query(`${`INSERT INTO motive.hosted_circle_results
        (id,project_id,work_order_id,attempt_id,artifact_environment_id,artifact_manifest_digest,artifact_receipt_id,
         candidate_relative_path,candidate_media_type,candidate_object_key,candidate_digest,terms_digest,input_digest,
         inference_profile_digest,evaluation_profile_digest,model_id,research_actor_id,report_bytes,report_digest,report_body,
         status,exact_score,exceeds_reference,artifact_available)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24)
        ON CONFLICT (attempt_id) DO NOTHING RETURNING id`}`,
      [id, attempt.projectId, attempt.workOrderId, attempt.id, seal.environmentId, seal.manifestDigest, seal.receiptId,
        CIRCLE_CANDIDATE_PATH, CIRCLE_CANDIDATE_MEDIA_TYPE, candidateObjectKey(attempt.projectId, attempt.id, seal.environmentId),
        report.binding.candidate_digest, attempt.termsDigest, attempt.inputDigest, attempt.profileDigest,
        CIRCLE_EVALUATOR_PROFILE_DIGEST, authority.model_id, authority.beneficiary_actor_id, Buffer.from(capture.bytes),
        capture.expected_raw_report_digest, JSON.stringify(report), report.outcome, exactScore, exceedsReference, available]);
      const selected = await client.query(`${RESULT_SELECT} WHERE result.attempt_id=$1`, [attemptId]);
      if (selected.rowCount !== 1) throw new Error('Hosted circle result insert did not resolve.');
      const stored = selected.rows[0];
      if (inserted.rowCount === 0 && (stored.artifact_manifest_digest !== seal.manifestDigest
          || stored.candidate_digest !== report.binding.candidate_digest
          || stored.evaluation_profile_digest !== CIRCLE_EVALUATOR_PROFILE_DIGEST
          || stored.inference_profile_digest !== attempt.profileDigest
          || stored.report_digest !== capture.expected_raw_report_digest
          || !Buffer.from(stored.report_bytes as Buffer).equals(Buffer.from(capture.bytes)))) {
        fail('CONFLICT', 'Hosted attempt already has a different immutable evaluation result.', 409);
      }
      let validationCode: 'VALID'|'NOT_PROVIDED'|'INVALID_STRUCTURE'|'INVALID_REFERENCE' = learning.status === 'NOT_PROVIDED'
        ? 'NOT_PROVIDED' : parsedInvestigation ? 'VALID' : 'INVALID_STRUCTURE';
      if (parsedInvestigation?.researchReferences?.length) {
        if (!this.options.validateResearchReferences) validationCode = 'INVALID_REFERENCE';
        else {
          try { await this.options.validateResearchReferences(attempt.projectId, parsedInvestigation.researchReferences, client); }
          catch { validationCode = 'INVALID_REFERENCE'; }
        }
      }
      const investigationStatus = validationCode === 'VALID' ? 'VALID' : validationCode === 'NOT_PROVIDED' ? 'NOT_PROVIDED' : 'INVALID';
      const investigationBytes = learning.investigationBytes ? Buffer.from(learning.investigationBytes) : null;
      const investigationObjectKey = learning.investigationBytes
        ? `projects/${attempt.projectId}/attempts/${attempt.id}/seals/${seal.environmentId}/files/${INVESTIGATION_PATH_TOKEN}` : null;
      const learningInsert = await client.query(`INSERT INTO motive.hosted_circle_investigations
        (result_id,project_id,attempt_id,artifact_environment_id,artifact_manifest_digest,
         investigation_relative_path,investigation_media_type,investigation_object_key,investigation_digest,investigation_bytes,
         investigation_body,status,validation_code,model_id,inference_profile_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
        ON CONFLICT(result_id) DO NOTHING RETURNING result_id`, [stored.id, attempt.projectId, attempt.id, seal.environmentId,
        seal.manifestDigest, investigationBytes ? 'investigation.json' : null, investigationBytes ? 'application/json' : null,
        investigationObjectKey, learning.investigationDigest, investigationBytes,
        validationCode === 'VALID' ? JSON.stringify(parsedInvestigation) : null, investigationStatus, validationCode,
        authority.model_id, attempt.profileDigest]);
      const retained = await client.query(`SELECT * FROM motive.hosted_circle_investigations WHERE result_id=$1`, [stored.id]);
      if (retained.rowCount !== 1) throw new Error('Hosted investigation insert did not resolve.');
      const retainedLearning = retained.rows[0];
      const sameLearning = retainedLearning.project_id === attempt.projectId && retainedLearning.attempt_id === attempt.id
        && retainedLearning.artifact_environment_id === seal.environmentId
        && retainedLearning.artifact_manifest_digest === seal.manifestDigest
        && retainedLearning.investigation_digest === learning.investigationDigest
        && retainedLearning.status === investigationStatus && retainedLearning.validation_code === validationCode
        && retainedLearning.model_id === authority.model_id && retainedLearning.inference_profile_digest === attempt.profileDigest
        && (investigationBytes === null ? retainedLearning.investigation_bytes === null
          : Buffer.from(retainedLearning.investigation_bytes as Buffer).equals(investigationBytes));
      if (learningInsert.rowCount === 0 && !sameLearning) {
        fail('CONFLICT', 'Hosted attempt already has different immutable investigation material.', 409);
      }
      const finalRow = await client.query(`${RESULT_SELECT} WHERE result.id=$1`, [stored.id]);
      return summary(finalRow.rows[0]);
    });
  }

  async publicResults(projectSlug: string): Promise<HostedCirclePublicResults> {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectSlug)) fail('VALIDATION', 'Project slug is invalid.', 400);
    const project = await this.options.pool.query(`SELECT id FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'`, [projectSlug]);
    if (project.rowCount !== 1) fail('NOT_FOUND', 'Public project was not found.', 404);
    const [rows, counts, best] = await Promise.all([
      this.options.pool.query(`${RESULT_SELECT} WHERE result.project_id=$1 ORDER BY result.created_at DESC,result.id DESC LIMIT 100`, [project.rows[0].id]),
      this.options.pool.query(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE review.decision='ACCEPTED')::text AS accepted
        FROM motive.hosted_circle_results result LEFT JOIN motive.hosted_circle_result_reviews review ON review.result_id=result.id
        WHERE result.project_id=$1`, [project.rows[0].id]),
      this.options.pool.query(`${RESULT_SELECT} WHERE result.project_id=$1 AND result.status='VALID' AND review.decision='ACCEPTED'
        ORDER BY result.exact_score::numeric DESC,result.created_at,result.id LIMIT 1`, [project.rows[0].id]),
    ]);
    return { projectSlug, totalResults: Number(counts.rows[0].total), acceptedResults: Number(counts.rows[0].accepted),
      bestAccepted: best.rowCount ? summary(best.rows[0]) : null, results: rows.rows.map(summary) };
  }

  private async publicRow(resultId: string): Promise<QueryResultRow> {
    uuid(resultId, 'resultId');
    const result = await this.options.pool.query(`${RESULT_SELECT}
      JOIN motive.projects project ON project.id=result.project_id AND project.visibility='PUBLIC'
      WHERE result.id=$1`, [resultId]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'Public hosted result was not found.', 404);
    return result.rows[0];
  }

  async publicReport(resultId: string): Promise<HostedCirclePublicReport> {
    const row = await this.publicRow(resultId);
    const bytes = Buffer.from(row.report_bytes as Buffer);
    if (circleByteDigest(bytes) !== row.report_digest) throw new Error('Stored hosted report digest is invalid.');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Stored hosted report bytes are invalid.'); }
    if (canonicalJson(parsed) !== bytes.toString('utf8') || canonicalJson(parsed) !== canonicalJson(row.report_body)) {
      throw new Error('Stored hosted report is not canonical or does not match its projection.');
    }
    return { resultId, reportDigest: row.report_digest as Digest, report: parsed as CircleEvaluatorReport, review: reviewProjection(row) };
  }

  async publicInvestigation(resultId: string): Promise<HostedCirclePublicInvestigation> {
    const row = await this.publicRow(resultId);
    const status = row.investigation_status === 'VALID' || row.investigation_status === 'INVALID'
      ? row.investigation_status : 'NOT_PROVIDED';
    const validationCode = row.investigation_validation_code === 'VALID' || row.investigation_validation_code === 'INVALID_STRUCTURE'
      || row.investigation_validation_code === 'INVALID_REFERENCE' ? row.investigation_validation_code : 'NOT_PROVIDED';
    let investigation: HostedCirclePublicInvestigation['investigation'] = null;
    if (status === 'VALID') {
      const bytes = Buffer.from(row.investigation_bytes as Buffer);
      if (circleByteDigest(bytes) !== row.investigation_digest) throw new Error('Stored hosted investigation digest is invalid.');
      const parsed = parseHostedInvestigation(bytes);
      if (!parsed || canonicalJson(parsed) !== canonicalJson(row.investigation_body)) {
        throw new Error('Stored hosted investigation projection is invalid.');
      }
      investigation = parsed;
    }
    return { format: 'motive.hosted-investigation.public.v1', resultId: text(row, 'id'), status,
      binding: { attemptId: text(row, 'attempt_id'), artifactManifestDigest: text(row, 'artifact_manifest_digest') as Digest,
        investigationDigest: nullableText(row, 'investigation_digest') as Digest | null,
        model: { id: text(row, 'model_id'), inferenceProfileDigest: text(row, 'inference_profile_digest') as Digest } },
      investigation, validationCode,
      interpretationStatus: status === 'VALID' ? 'AGENT_DECLARED_UNVERIFIED' : validationCode,
      notice: 'Hosted investigation notes are agent statements retained separately from the numerical evaluator report and human acceptance.' };
  }

  async publicArtifact(resultId: string): Promise<HostedCirclePublicArtifact> {
    const row = await this.publicRow(resultId);
    if (!bool(row, 'artifact_available')) fail('ARTIFACT_UNAVAILABLE', 'Malformed candidate bytes are not public.', 404);
    const objects = this.requireObjects();
    const attempt = await this.ledger.getAttempt(text(row, 'attempt_id'));
    const execution = await this.orchestration.getExecution(text(row, 'attempt_id'));
    if (!attempt || !execution?.artifactSeal) fail('ARTIFACT_UNAVAILABLE', 'The immutable candidate is unavailable.', 404);
    const reader = new SealedCircleCandidateReader({ store: objects, contextResolver: this.contextResolver });
    const candidate = await reader.read({ attempt, artifactSeal: execution.artifactSeal, signal: AbortSignal.timeout(15_000) });
    if (candidate.artifactManifestDigest !== row.artifact_manifest_digest || candidate.candidateDigest !== row.candidate_digest) {
      fail('CONFLICT', 'Immutable candidate no longer matches its retained result.', 409);
    }
    return { resultId, filename: CIRCLE_CANDIDATE_PATH, mediaType: CIRCLE_CANDIDATE_MEDIA_TYPE,
      digest: candidate.candidateDigest, bytes: candidate.candidateBytes };
  }

  async review(actorId: string, resultId: string, value: ReviewHostedCircleResultInput, idempotencyKey: string): Promise<HostedCircleReview> {
    if (typeof actorId !== 'string' || actorId.length < 1 || actorId.length > 512
        || typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      fail('VALIDATION', 'Reviewer identity and idempotency key are required.', 400);
    }
    uuid(resultId, 'resultId'); const input = reviewInput(value); const bodyDigest = digestCanonicalJson({ resultId, ...input });
    return this.transaction(async client => {
      const found = await client.query(`${RESULT_SELECT} WHERE result.id=$1 FOR UPDATE OF result`, [resultId]);
      if (found.rowCount !== 1) fail('NOT_FOUND', 'Hosted result was not found.', 404);
      const row = found.rows[0];
      const membership = await client.query(`SELECT role FROM motive.memberships WHERE project_id=$1 AND actor_id=$2
        AND revoked_at IS NULL AND role IN ('OWNER','STEWARD','REVIEWER') FOR SHARE`, [row.project_id, actorId]);
      if (membership.rowCount !== 1 || row.research_actor_id === actorId) {
        fail('FORBIDDEN', 'Review requires an independent current project reviewer, owner, or steward.', 403);
      }
      if (input.expected.attemptId !== row.attempt_id || input.expected.artifactManifestDigest !== row.artifact_manifest_digest
          || input.expected.evaluationProfileDigest !== row.evaluation_profile_digest || input.expected.reportDigest !== row.report_digest) {
        fail('CONFLICT', 'Expected review bindings do not match the retained result.', 409);
      }
      if (input.decision === 'ACCEPTED' && row.status !== 'VALID') fail('CONFLICT', 'Only a valid numerical result can be accepted.', 409);
      const replay = await client.query(`SELECT body_digest,response FROM motive.idempotency_records
        WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3 FOR UPDATE`, [actorId, ACTION, idempotencyKey]);
      if (replay.rowCount) {
        if (replay.rows[0].body_digest !== bodyDigest) fail('CONFLICT', 'Idempotency key was used for different review material.', 409);
        const current = reviewProjection(row);
        if (!current) fail('CONFLICT', 'Review idempotency record is incomplete.', 409);
        return current;
      }
      const effectId = randomUUID();
      await client.query(`INSERT INTO motive.idempotency_records(actor_id,action,idempotency_key,body_digest,effect_id)
        VALUES($1,$2,$3,$4,$5)`, [actorId, ACTION, idempotencyKey, bodyDigest, effectId]);
      if (row.review_id !== null) fail('CONFLICT', 'This hosted result already has a review decision.', 409);
      const reviewId = randomUUID();
      const inserted = await client.query(`INSERT INTO motive.hosted_circle_result_reviews
        (id,result_id,project_id,decision,reviewer_actor_id,rationale) VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id,decision,created_at`, [reviewId, resultId, row.project_id, input.decision, actorId, input.rationale]);
      const response: HostedCircleReview = { id: text(inserted.rows[0], 'id'), decision: text(inserted.rows[0], 'decision') as HostedCircleReview['decision'],
        decidedAt: date(inserted.rows[0], 'created_at') };
      await client.query(`UPDATE motive.idempotency_records SET response=$4::jsonb,resource_type='hosted_circle_result_review',resource_id=$5
        WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3`, [actorId, ACTION, idempotencyKey, JSON.stringify(response), reviewId]);
      return response;
    });
  }
}

export function createCircleResultsService(options: CircleResultsServiceOptions): CircleResultsService {
  return new CircleResultsService(options);
}
