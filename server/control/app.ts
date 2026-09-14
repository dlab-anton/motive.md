import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Authenticate } from './auth.ts';
import { createEvidenceRouter, HUMAN_ACCEPTANCE_MUTATION_CAPABILITY, type EvidenceRouteOptions } from './evidence-routes.ts';

export type PublicProject = {
  id: string; slug: string; revision: number; title: string; purpose: string;
  nextStep: string; stage: 'preparation';
  executionEnabled: false; externalSubmissionsEnabled: false;
};
export interface ControlRepository {
  listPublicProjects(): Promise<PublicProject[]>;
  getProject(slug: string, actorId: string | null): Promise<PublicProject | null>;
  getSupport(actorId: string): Promise<unknown[]>;
}

export function createControlApp(options: {
  allowedOrigins: readonly string[]; authenticate: Authenticate; repository: ControlRepository;
  isDraining?: () => boolean; isReady?: () => boolean; reportError?: (requestId: string, error: unknown) => void;
  /** Supplied only by an execution-profile bootstrap with a separate accounting credential. */
  inferenceGateway?: Express;
  /** Reads use the restricted reader connection. Decision writes require a
   * separate reviewed bootstrap/credential and an explicit route capability. */
  evidence?: Pick<EvidenceRouteOptions, 'store' | 'acceptanceMutationCapability'>;
}) {
  const app = express();
  app.disable('x-powered-by');
  // No proxy-derived identity is trusted without a deployment-specific verified boundary.
  app.set('trust proxy', false);
  // The worker endpoint has its own capability authentication and no browser CORS.
  // The default read-only bootstrap deliberately supplies no gateway.
  if (options.inferenceGateway) app.use('/inference', options.inferenceGateway);
  else app.use('/inference', (_req, res) => res.status(503).json({ error: 'execution_not_enabled' }));
  app.use('/v1', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'rate_limited' } }));
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({ 'X-Request-Id': res.locals.requestId, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    const origin = req.get('origin');
    if (origin && !options.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'origin_denied' }); return;
    }
    if (origin) { res.set('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
    if (req.method === 'OPTIONS') {
      const acceptsHumanDecisions = options.evidence?.acceptanceMutationCapability === HUMAN_ACCEPTANCE_MUTATION_CAPABILITY
        && /^\/v1\/evidence\/evaluations\/[0-9a-f-]+\/acceptance$/i.test(req.path);
      res.set({ 'Access-Control-Allow-Methods': acceptsHumanDecisions ? 'GET, POST, OPTIONS' : 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' });
      res.sendStatus(204); return;
    }
    next();
  });
  // All evidence reads/reviews share readiness/drain and browser-origin checks.
  // Human acceptance cannot itself admit provider/cloud spend.
  app.use('/v1', (req, res, next) => {
    if (options.isDraining?.()) { res.status(503).json({ error: 'control_draining' }); return; }
    if (options.isReady && !options.isReady()) { res.status(503).json({ error: 'control_unavailable' }); return; }
    next();
  });
  if (options.evidence) app.use('/v1', createEvidenceRouter({
    ...options.evidence, authenticate: options.authenticate,
    reportError: (requestId, error) => options.reportError?.(requestId ?? 'unassigned', error),
  }));
  // The default bootstrap leaves human decisions off. All other mutations stay
  // disabled even when a reviewed bootstrap explicitly enables human review.
  app.use('/v1', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.status(503).json({ error: 'execution_not_enabled', message: 'The hosted pilot and external submission gates have not passed.' }); return;
    }
    next();
  });
  async function actor(header: string | undefined, required: boolean) {
    if (!header && !required) return null;
    if (!header || !/^Bearer [A-Za-z0-9._~+\/-]+=*$/.test(header) || header.length > 8192) return undefined;
    return (await options.authenticate(header.slice(7)))?.id ?? undefined;
  }
  app.get('/v1/status', (_req, res) => res.json({
    format: 'motive.status/0.1', executionEnabled: false, externalSubmissionsEnabled: false,
    evidence: { readsEnabled: Boolean(options.evidence), humanAcceptanceEnabled: options.evidence?.acceptanceMutationCapability === HUMAN_ACCEPTANCE_MUTATION_CAPABILITY },
    phase: 'infrastructure_preflight', gates: { A: 'not_passed', B: 'not_passed', C: 'not_passed', D: 'not_passed', E: 'not_passed', F: 'not_passed' },
  }));
  app.get('/v1/projects', async (_req, res) => res.json({ projects: await options.repository.listPublicProjects() }));
  app.get('/v1/projects/:slug', async (req, res) => {
    const actorId = await actor(req.get('authorization'), false);
    if (actorId === undefined) { res.status(401).json({ error: 'authentication_required' }); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(req.params.slug)) { res.status(404).json({ error: 'not_found' }); return; }
    const project = await options.repository.getProject(req.params.slug, actorId);
    if (!project) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ project });
  });
  app.get('/v1/me/support', async (req, res) => {
    const actorId = await actor(req.get('authorization'), true);
    if (!actorId) { res.status(401).json({ error: 'authentication_required' }); return; }
    res.json({ support: await options.repository.getSupport(actorId) });
  });
  app.use('/v1', (_req, res) => res.status(404).json({ error: 'not_found' }));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    options.reportError?.(res.locals.requestId, error);
    res.status(503).json({ error: 'control_unavailable', requestId: res.locals.requestId });
  };
  app.use(onError);
  return app;
}
