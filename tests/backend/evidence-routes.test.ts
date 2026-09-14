import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceStoreError,
  type EvidenceStore,
  type MemberAttemptEvidenceProjection,
  type MemberEvaluationProjection,
} from '../../packages/evidence/src/index.ts';
import {
  createEvidenceRouter,
  HUMAN_ACCEPTANCE_MUTATION_CAPABILITY,
} from '../../server/control/evidence-routes.ts';
import { createControlApp, type ControlRepository } from '../../server/control/app.ts';

const ATTEMPT_ID = '10000000-0000-4000-8000-000000000001';
const EVALUATION_ID = '20000000-0000-4000-8000-000000000002';
const WORK_ORDER_ID = '30000000-0000-4000-8000-000000000003';
const ARTIFACT_ENVIRONMENT_ID = '40000000-0000-4000-8000-000000000004';
const EVALUATOR_ENVIRONMENT_ID = '50000000-0000-4000-8000-000000000005';
const DIGEST = (character: string) => `sha256:${character.repeat(64)}` as const;

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

function evaluation(overrides: Partial<MemberEvaluationProjection> = {}): MemberEvaluationProjection {
  return {
    id: EVALUATION_ID,
    attemptId: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    artifactEnvironmentId: ARTIFACT_ENVIRONMENT_ID,
    evaluatorEnvironmentId: EVALUATOR_ENVIRONMENT_ID,
    artifactManifestDigest: DIGEST('a'),
    termsDigest: DIGEST('b'),
    evaluatorProfileDigest: DIGEST('c'),
    challengeDigest: DIGEST('d'),
    dependencyLockDigest: DIGEST('e'),
    trustedBuildConfigDigest: DIGEST('f'),
    rawReportDigest: DIGEST('1'),
    assessmentDigest: DIGEST('2'),
    outcome: 'INCONCLUSIVE',
    recordedAt: '2026-09-06T12:00:00.000Z',
    acceptance: null,
    ...overrides,
  };
}

function attemptEvidence(): MemberAttemptEvidenceProjection {
  return {
    attemptId: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    termsDigest: DIGEST('b'),
    artifact: {
      environmentId: ARTIFACT_ENVIRONMENT_ID,
      manifestDigest: DIGEST('a'),
      sealedAt: '2026-09-06T11:00:00.000Z',
      // Deliberate runtime extras prove that the HTTP projection is an allow-list.
      receiptId: 'private-receipt',
      downloadUrl: 'https://storage.invalid/private',
      donorCredential: 'must-not-escape',
    } as never,
    evaluations: [
      Object.assign(evaluation(), { rawReportBytes: 'private report', evaluatorProfileSnapshot: { secret: true } }),
      Object.assign(evaluation({
        id: '60000000-0000-4000-8000-000000000006',
        outcome: 'REJECTED',
        acceptance: {
          id: '70000000-0000-4000-8000-000000000007',
          evaluationId: '60000000-0000-4000-8000-000000000006',
          decision: 'REJECTED',
          decidedAt: '2026-09-06T12:30:00.000Z',
          actorId: 'private-reviewer',
          rationale: 'private rationale',
        } as never,
      }), { report: { checks: ['private'] } }),
    ],
  };
}

function storeFixture(overrides: Partial<EvidenceStore> = {}): EvidenceStore {
  return {
    findAttemptEvidenceForMember: vi.fn(async () => attemptEvidence()),
    findEvaluationForMember: vi.fn(async () => evaluation()),
    decideAcceptance: vi.fn(async input => ({
      id: '70000000-0000-4000-8000-000000000007',
      evaluationId: input.evaluationId,
      attemptId: input.expectedReview.attemptId,
      workOrderId: WORK_ORDER_ID,
      artifactManifestDigest: input.expectedReview.artifactManifestDigest,
      termsDigest: input.expectedReview.termsDigest,
      evaluatorProfileDigest: input.expectedReview.evaluatorProfileDigest,
      rawReportDigest: input.expectedReview.rawReportDigest,
      decision: input.decision,
      decidedAt: '2026-09-06T13:00:00.000Z',
    })),
    recordTrustedEvaluatorCapture: vi.fn(async () => { throw new Error('HTTP must not capture evaluator reports'); }),
    ...overrides,
  };
}

async function fixture(options: { store?: EvidenceStore; mutation?: boolean; reportError?: (requestId: string | undefined, error: unknown) => void } = {}) {
  const store = options.store ?? storeFixture();
  const app = express();
  app.disable('x-powered-by');
  app.use('/v1', createEvidenceRouter({
    authenticate: async token => token === 'valid-session' ? { id: 'session-actor' } : null,
    store,
    ...(options.mutation ? { acceptanceMutationCapability: HUMAN_ACCEPTANCE_MUTATION_CAPABILITY } : {}),
    reportError: options.reportError,
  }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { base: `http://127.0.0.1:${address.port}/v1`, store };
}

async function controlFixture(options: {
  store?: EvidenceStore;
  mutation?: boolean;
  draining?: boolean;
  ready?: boolean;
} = {}) {
  const store = options.store ?? storeFixture();
  const repository: ControlRepository = {
    listPublicProjects: async () => [],
    getProject: async () => null,
    getSupport: async () => [],
  };
  const app = createControlApp({
    allowedOrigins: ['https://motive.example'],
    authenticate: async token => token === 'valid-session' ? { id: 'session-actor' } : null,
    repository,
    isDraining: () => options.draining ?? false,
    isReady: () => options.ready ?? true,
    evidence: {
      store,
      ...(options.mutation ? { acceptanceMutationCapability: HUMAN_ACCEPTANCE_MUTATION_CAPABILITY } : {}),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { base: `http://127.0.0.1:${address.port}/v1`, store };
}

const auth = { Authorization: 'Bearer valid-session' };
const expectedReview = {
  attemptId: ATTEMPT_ID,
  artifactManifestDigest: DIGEST('a'),
  termsDigest: DIGEST('b'),
  evaluatorProfileDigest: DIGEST('c'),
  rawReportDigest: DIGEST('1'),
};

describe('authenticated evidence routes', () => {
  it('requires a verified Supabase-style bearer session before every read', async () => {
    const store = storeFixture();
    const { base } = await fixture({ store });

    expect((await fetch(`${base}/evidence/attempts/${ATTEMPT_ID}`)).status).toBe(401);
    expect((await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}`, {
      headers: { Authorization: 'Bearer invalid-session' },
    })).status).toBe(401);
    expect(store.findAttemptEvidenceForMember).not.toHaveBeenCalled();
    expect(store.findEvaluationForMember).not.toHaveBeenCalled();
  });

  it('passes only derived identity to scoped reads and collapses inaccessible evidence to not found', async () => {
    const findEvaluationForMember = vi.fn(async () => null);
    const store = storeFixture({ findEvaluationForMember });
    const { base } = await fixture({ store });

    const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}?actorId=victim&projectId=foreign`, { headers: auth });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(findEvaluationForMember).toHaveBeenCalledWith({ actorId: 'session-actor', evaluationId: EVALUATION_ID });
  });

  it('returns digest-only allow-listed evidence with explicit unresolved and negative states', async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/evidence/attempts/${ATTEMPT_ID}`, { headers: auth });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.format).toBe('motive.attempt-evidence/0.1');
    expect(payload.evidence.artifact).toEqual({
      environmentId: ARTIFACT_ENVIRONMENT_ID,
      manifestDigest: DIGEST('a'),
      sealedAt: '2026-09-06T11:00:00.000Z',
    });
    expect(payload.evidence.evaluations.map((item: { outcome: string; acceptance: { status: string } }) => (
      [item.outcome, item.acceptance.status]
    ))).toEqual([
      ['INCONCLUSIVE', 'PENDING'],
      ['REJECTED', 'REJECTED'],
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/private|credential|downloadUrl|receiptId|rawReportBytes|rationale|actorId/);
  });

  it('keeps human acceptance disabled unless a trusted bootstrap explicitly enables it', async () => {
    const store = storeFixture();
    const { base } = await fixture({ store });
    const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-1' },
      body: JSON.stringify({ decision: 'ACCEPTED', expectedReview }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'human_acceptance_not_enabled' });
    expect(store.decideAcceptance).not.toHaveBeenCalled();
  });

  it('rejects body attempts to choose the actor, project, evaluator status, or verified state', async () => {
    const store = storeFixture();
    const { base } = await fixture({ store, mutation: true });
    for (const forbidden of [
      { actorId: 'victim' },
      { projectId: '80000000-0000-4000-8000-000000000008' },
      { status: 'VERIFIED' },
      { verified: true },
    ]) {
      const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-1' },
        body: JSON.stringify({ decision: 'ACCEPTED', expectedReview, ...forbidden }),
      });
      expect(response.status).toBe(400);
    }
    expect(store.decideAcceptance).not.toHaveBeenCalled();
  });

  it('derives the named reviewer, requires exact evidence bindings, and omits private review data', async () => {
    const decideAcceptance = vi.fn(storeFixture().decideAcceptance);
    const store = storeFixture({ decideAcceptance });
    const { base } = await fixture({ store, mutation: true });
    const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance?actorId=victim`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-2' },
      body: JSON.stringify({ decision: 'REJECTED', expectedReview, rationale: 'Private maintainer note.' }),
    });

    expect(response.status).toBe(201);
    expect(decideAcceptance).toHaveBeenCalledWith({
      actorId: 'session-actor',
      evaluationId: EVALUATION_ID,
      idempotencyKey: 'review-2',
      decision: 'REJECTED',
      expectedReview,
      rationale: 'Private maintainer note.',
    });
    const text = await response.text();
    expect(text).not.toContain('Private maintainer note.');
    expect(text).not.toContain('session-actor');
    expect(JSON.parse(text).decision.decision).toBe('REJECTED');
  });

  it('does not reveal a private evaluation through mutation error distinctions', async () => {
    for (const [code, expectedStatus, expectedBody] of [
      ['NOT_FOUND', 404, { error: 'not_found' }],
      ['MAINTAINER_REQUIRED', 403, { error: 'maintainer_required' }],
      ['EVALUATION_NOT_VERIFIED', 409, { error: 'evaluation_not_verified' }],
    ] as const) {
      const store = storeFixture({
        decideAcceptance: vi.fn(async () => { throw new EvidenceStoreError(code, 'private database detail'); }),
      });
      const { base } = await fixture({ store, mutation: true });
      const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': `review-${code}` },
        body: JSON.stringify({ decision: 'ACCEPTED', expectedReview }),
      });
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual(expectedBody);
    }
  });

  it('requires JSON, an idempotency key, canonical bindings, and bounded bodies', async () => {
    const store = storeFixture();
    const { base } = await fixture({ store, mutation: true });
    const path = `${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`;

    expect((await fetch(path, { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'review-3' }, body: '{}' })).status).toBe(415);
    expect((await fetch(path, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'ACCEPTED', expectedReview }),
    })).status).toBe(400);
    expect((await fetch(path, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-4' },
      body: JSON.stringify({ decision: 'ACCEPTED', expectedReview: { ...expectedReview, rawReportDigest: 'sha256:not-a-digest' } }),
    })).status).toBe(400);
    expect((await fetch(path, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-5' },
      body: JSON.stringify({ decision: 'REJECTED', expectedReview, rationale: 'x'.repeat(17_000) }),
    })).status).toBe(413);
    expect(store.decideAcceptance).not.toHaveBeenCalled();
  });

  it('bounds private rationale in UTF-8 bytes and rejects control characters', async () => {
    const store = storeFixture();
    const { base } = await fixture({ store, mutation: true });
    const path = `${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`;
    for (const rationale of ['é'.repeat(2_049), 'line one\nline two']) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-rationale' },
        body: JSON.stringify({ decision: 'REJECTED', expectedReview, rationale }),
      });
      expect(response.status).toBe(400);
    }
    expect(store.decideAcceptance).not.toHaveBeenCalled();
  });

  it('keeps arbitrary upstream status and code properties opaque', async () => {
    const reportError = vi.fn();
    const store = storeFixture({
      findEvaluationForMember: vi.fn(async () => {
        throw Object.assign(new Error('private failure'), { status: 500, code: 'secret_detail' });
      }),
    });
    const { base } = await fixture({ store, reportError });
    const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}`, { headers: auth });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe('{"error":"evidence_unavailable"}');
    expect(text).not.toMatch(/secret|private/);
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('accepts canonical UUIDv7 route identifiers', async () => {
    const evaluationId = '018f0000-0000-7000-8000-000000000001';
    const findEvaluationForMember = vi.fn(async () => evaluation({ id: evaluationId }));
    const { base } = await fixture({ store: storeFixture({ findEvaluationForMember }) });
    expect((await fetch(`${base}/evidence/evaluations/${evaluationId}`, { headers: auth })).status).toBe(200);
    expect(findEvaluationForMember).toHaveBeenCalledWith({ actorId: 'session-actor', evaluationId });
  });
});

describe('control app evidence integration', () => {
  it('blocks foreign origins, draining, and failed readiness before store access', async () => {
    for (const setup of [
      { origin: 'https://foreign.example' },
      { draining: true },
      { ready: false },
    ]) {
      const store = storeFixture();
      const { base } = await controlFixture(setup);
      const response = await fetch(`${base}/evidence/attempts/${ATTEMPT_ID}`, {
        headers: { ...auth, ...(setup.origin ? { Origin: setup.origin } : {}) },
      });
      expect(response.status).toBe(setup.origin ? 403 : 503);
      expect(store.findAttemptEvidenceForMember).not.toHaveBeenCalled();
    }
  });

  it('admits only explicitly enabled review POSTs while other control mutations remain disabled', async () => {
    const decideAcceptance = vi.fn(storeFixture().decideAcceptance);
    const store = storeFixture({ decideAcceptance });
    const { base } = await controlFixture({ store, mutation: true });
    const review = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, {
      method: 'POST',
      headers: { ...auth, Origin: 'https://motive.example', 'Content-Type': 'application/json', 'Idempotency-Key': 'review-integrated' },
      body: JSON.stringify({ decision: 'REJECTED', expectedReview }),
    });
    expect(review.status).toBe(201);
    expect(review.headers.get('access-control-allow-origin')).toBe('https://motive.example');
    expect(decideAcceptance).toHaveBeenCalledOnce();

    const grant = await fetch(`${base}/projects/math/grants`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // The evidence router must not parse or change unrelated mutation behavior.
      body: '{malformed',
    });
    expect(grant.status).toBe(503);
    expect(await grant.json()).toMatchObject({ error: 'execution_not_enabled' });
  });

  it('keeps the integrated decision route disabled by default', async () => {
    const store = storeFixture();
    const { base } = await controlFixture({ store });
    const response = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'review-disabled' },
      body: JSON.stringify({ decision: 'ACCEPTED', expectedReview }),
    });
    expect(response.status).toBe(503);
    expect(store.decideAcceptance).not.toHaveBeenCalled();
  });

  it('advertises browser POST only for the explicitly enabled acceptance path', async () => {
    const { base } = await controlFixture({ mutation: true });
    const headers = {
      Origin: 'https://motive.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key',
    };
    const review = await fetch(`${base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, { method: 'OPTIONS', headers });
    const grant = await fetch(`${base}/projects/math/grants`, { method: 'OPTIONS', headers });
    expect(review.status).toBe(204);
    expect(review.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(grant.status).toBe(204);
    expect(grant.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');

    const disabled = await controlFixture();
    const disabledReview = await fetch(`${disabled.base}/evidence/evaluations/${EVALUATION_ID}/acceptance`, { method: 'OPTIONS', headers });
    expect(disabledReview.status).toBe(204);
    expect(disabledReview.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
});
