import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type Router,
} from 'express';
import type { Digest } from '../../packages/domain/src/contracts.ts';
import {
  EvidenceStoreError,
  type AcceptanceDecisionProjection,
  type DecideAcceptanceInput,
  type EvidenceStore,
  type MemberAcceptanceProjection,
  type MemberAttemptEvidenceProjection,
  type MemberEvaluationProjection,
} from '../../packages/evidence/src/index.ts';
import type { Authenticate } from './auth.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BEARER_PATTERN = /^Bearer [A-Za-z0-9._~+\/-]+=*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A trusted bootstrap must supply this exact value. It is never read from the environment here. */
export const HUMAN_ACCEPTANCE_MUTATION_CAPABILITY = 'motive.human-acceptance/0.1' as const;

export type EvidenceRouteOptions = {
  authenticate: Authenticate;
  store: EvidenceStore;
  acceptanceMutationCapability?: typeof HUMAN_ACCEPTANCE_MUTATION_CAPABILITY;
  reportError?: (requestId: string | undefined, error: unknown) => void;
};

class EvidenceRouteError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'EvidenceRouteError';
  }
}

function httpError(status: number, code: string): EvidenceRouteError {
  return new EvidenceRouteError(status, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key))) throw httpError(400, 'invalid_request');
  if (allowed.some(key => !(key in value)) && name === 'expectedReview') throw httpError(400, 'invalid_request');
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw httpError(404, 'not_found');
  return value;
}

function requireDigest(value: unknown): Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw httpError(400, 'invalid_request');
  return value as Digest;
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) throw httpError(400, 'idempotency_key_required');
  return value;
}

async function requireActor(authenticate: Authenticate, header: string | undefined): Promise<string> {
  if (!header || header.length > 8192 || !BEARER_PATTERN.test(header)) {
    throw httpError(401, 'authentication_required');
  }
  const principal = await authenticate(header.slice(7));
  if (!principal) throw httpError(401, 'authentication_required');
  return principal.id;
}

function acceptanceProjection(value: MemberAcceptanceProjection | null) {
  if (!value) return { status: 'PENDING' as const, decisionId: null, decidedAt: null };
  return { status: value.decision, decisionId: value.id, decidedAt: value.decidedAt };
}

function evaluationProjection(value: MemberEvaluationProjection) {
  return {
    id: value.id,
    attemptId: value.attemptId,
    workOrderId: value.workOrderId,
    artifactEnvironmentId: value.artifactEnvironmentId,
    evaluatorEnvironmentId: value.evaluatorEnvironmentId,
    artifactManifestDigest: value.artifactManifestDigest,
    termsDigest: value.termsDigest,
    evaluatorProfileDigest: value.evaluatorProfileDigest,
    challengeDigest: value.challengeDigest,
    dependencyLockDigest: value.dependencyLockDigest,
    trustedBuildConfigDigest: value.trustedBuildConfigDigest,
    rawReportDigest: value.rawReportDigest,
    assessmentDigest: value.assessmentDigest,
    outcome: value.outcome,
    recordedAt: value.recordedAt,
    acceptance: acceptanceProjection(value.acceptance),
  };
}

function attemptProjection(value: MemberAttemptEvidenceProjection) {
  return {
    attemptId: value.attemptId,
    workOrderId: value.workOrderId,
    termsDigest: value.termsDigest,
    artifact: value.artifact ? {
      environmentId: value.artifact.environmentId,
      manifestDigest: value.artifact.manifestDigest,
      sealedAt: value.artifact.sealedAt,
    } : null,
    evaluations: value.evaluations.map(evaluationProjection),
  };
}

function decisionProjection(value: AcceptanceDecisionProjection) {
  return {
    id: value.id,
    evaluationId: value.evaluationId,
    attemptId: value.attemptId,
    workOrderId: value.workOrderId,
    artifactManifestDigest: value.artifactManifestDigest,
    termsDigest: value.termsDigest,
    evaluatorProfileDigest: value.evaluatorProfileDigest,
    rawReportDigest: value.rawReportDigest,
    decision: value.decision,
    decidedAt: value.decidedAt,
  };
}

function parseDecisionBody(body: unknown, actorId: string, evaluationId: string, idempotencyKey: string): DecideAcceptanceInput {
  if (!isRecord(body)) throw httpError(400, 'invalid_request');
  exactKeys(body, ['decision', 'expectedReview', 'rationale'], 'body');
  if (body.decision !== 'ACCEPTED' && body.decision !== 'REJECTED') throw httpError(400, 'invalid_request');
  if (!isRecord(body.expectedReview)) throw httpError(400, 'invalid_request');
  exactKeys(body.expectedReview, [
    'attemptId',
    'artifactManifestDigest',
    'termsDigest',
    'evaluatorProfileDigest',
    'rawReportDigest',
  ], 'expectedReview');
  if (typeof body.expectedReview.attemptId !== 'string' || !UUID_PATTERN.test(body.expectedReview.attemptId)) {
    throw httpError(400, 'invalid_request');
  }
  if (body.rationale !== undefined && (
    typeof body.rationale !== 'string'
    || body.rationale.length === 0
    || Buffer.byteLength(body.rationale, 'utf8') > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(body.rationale)
  )) throw httpError(400, 'invalid_request');

  return {
    actorId,
    evaluationId,
    idempotencyKey,
    decision: body.decision,
    expectedReview: {
      attemptId: body.expectedReview.attemptId,
      artifactManifestDigest: requireDigest(body.expectedReview.artifactManifestDigest),
      termsDigest: requireDigest(body.expectedReview.termsDigest),
      evaluatorProfileDigest: requireDigest(body.expectedReview.evaluatorProfileDigest),
      rawReportDigest: requireDigest(body.expectedReview.rawReportDigest),
    },
    ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
  };
}

function mapStoreError(error: EvidenceStoreError): EvidenceRouteError {
  switch (error.code) {
    case 'VALIDATION': return httpError(400, 'invalid_request');
    case 'NOT_FOUND': return httpError(404, 'not_found');
    case 'MAINTAINER_REQUIRED': return httpError(403, 'maintainer_required');
    case 'ARTIFACT_NOT_SEALED':
    case 'EVALUATION_BINDING_MISMATCH':
    case 'EVALUATION_CAPTURE_CONFLICT':
    case 'HUMAN_REVIEW_NOT_REQUIRED':
    case 'REVIEW_NOT_READY':
    case 'EVALUATION_NOT_VERIFIED':
    case 'IDEMPOTENCY_CONFLICT':
    case 'IDEMPOTENCY_INCOMPLETE':
    case 'ACCEPTANCE_ALREADY_DECIDED': return httpError(409, error.code.toLowerCase());
    default: return httpError(503, 'evidence_unavailable');
  }
}

function sendError(options: EvidenceRouteOptions, res: Response, error: unknown): void {
  const mapped = error instanceof EvidenceStoreError ? mapStoreError(error) : error;
  if (mapped instanceof EvidenceRouteError) {
    res.status(mapped.status).json({ error: mapped.code });
    return;
  }
  options.reportError?.(typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined, error);
  res.status(503).json({ error: 'evidence_unavailable' });
}

function asyncRoute(options: EvidenceRouteOptions, handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void handler(req, res).catch(error => sendError(options, res, error));
  };
}

/**
 * Authenticated member evidence and named-human review routes. This router is
 * carries no ambient authority: the trusted control bootstrap owns CORS,
 * readiness, rate limits, and explicit decision-mutation enablement.
 */
export function createEvidenceRouter(options: EvidenceRouteOptions): Router {
  const router = express.Router();
  const decisionJson = express.json({ limit: '16kb', strict: true, type: 'application/json' });

  router.get('/evidence/attempts/:attemptId', asyncRoute(options, async (req, res) => {
    const actorId = await requireActor(options.authenticate, req.get('authorization'));
    const attemptId = requireUuid(req.params.attemptId);
    const evidence = await options.store.findAttemptEvidenceForMember({ actorId, attemptId });
    if (!evidence) throw httpError(404, 'not_found');
    res.json({ format: 'motive.attempt-evidence/0.1', evidence: attemptProjection(evidence) });
  }));

  router.get('/evidence/evaluations/:evaluationId', asyncRoute(options, async (req, res) => {
    const actorId = await requireActor(options.authenticate, req.get('authorization'));
    const evaluationId = requireUuid(req.params.evaluationId);
    const evaluation = await options.store.findEvaluationForMember({ actorId, evaluationId });
    if (!evaluation) throw httpError(404, 'not_found');
    res.json({ format: 'motive.evaluation-evidence/0.1', evaluation: evaluationProjection(evaluation) });
  }));

  router.post('/evidence/evaluations/:evaluationId/acceptance', decisionJson, asyncRoute(options, async (req, res) => {
    const actorId = await requireActor(options.authenticate, req.get('authorization'));
    if (options.acceptanceMutationCapability !== HUMAN_ACCEPTANCE_MUTATION_CAPABILITY) {
      throw httpError(503, 'human_acceptance_not_enabled');
    }
    const evaluationId = requireUuid(req.params.evaluationId);
    if (!req.is('application/json')) throw httpError(415, 'application_json_required');
    const input = parseDecisionBody(req.body, actorId, evaluationId, requireIdempotencyKey(req.get('idempotency-key')));
    const decision = await options.store.decideAcceptance(input);
    res.status(201).json({ format: 'motive.acceptance-decision/0.1', decision: decisionProjection(decision) });
  }));

  const parseError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_too_large' });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    sendError(options, res, error);
  };
  router.use(parseError);
  return router;
}
