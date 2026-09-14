import { json, Router, type NextFunction, type Request, type Response } from 'express';
import {
  isClaimCommunityCoordinationTurnInput,
  isCompleteCommunityCoordinationTurnInput,
  isCreateCommunityCoordinationGrantInput,
  isReleaseCommunityCoordinationTurnInput,
  isRenewCommunityCoordinationTurnInput,
} from '../../src/lib/community-coordination.ts';
import { ParticipationError, type ParticipationAgentContext, type ParticipationService } from '../participation/service.ts';
import { CommunityCoordinationError, type CommunityCoordinationService } from './service.ts';

type AccountLocals = { actorId?: unknown; accountName?: unknown };
type AgentLocals = { participationAgent?: ParticipationAgentContext };

export type CommunityCoordinationRouterOptions = {
  service: CommunityCoordinationService;
  participation: Pick<ParticipationService, 'authenticateBearer'>;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY = /^[A-Za-z0-9._~-]{8,200}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~-]{20,512})$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function noQuery(req: Request): void {
  if (Object.keys(req.query).length) {
    throw new CommunityCoordinationError('VALIDATION', 'Community coordination routes do not accept query parameters.');
  }
}

function idempotency(req: Request): string {
  const value = req.get('Idempotency-Key');
  if (!value || !KEY.test(value)) {
    throw new CommunityCoordinationError('VALIDATION', 'A valid Idempotency-Key is required.');
  }
  return value;
}

function account(res: Response): string {
  const locals = res.locals as AccountLocals;
  if (typeof locals.actorId !== 'string' || !locals.actorId.startsWith('account:')
      || typeof locals.accountName !== 'string' || !locals.accountName.trim()) {
    throw new CommunityCoordinationError('UNAUTHORIZED', 'A live account session is required.');
  }
  return locals.actorId;
}

function agent(res: Response): ParticipationAgentContext {
  const context = (res.locals as AgentLocals).participationAgent;
  if (!context) throw new CommunityCoordinationError('UNAUTHORIZED', 'A project agent token is required.');
  return context;
}

function parameter(value: string | string[] | undefined, label: 'Grant' | 'Turn'): string {
  const result = typeof value === 'string' ? value : '';
  if (!UUID.test(result)) throw new CommunityCoordinationError('NOT_FOUND', `${label} was not found.`);
  return result;
}

function emptyBody(value: unknown): void {
  if (!object(value) || Object.keys(value).length) {
    throw new CommunityCoordinationError('VALIDATION', 'Request body must be an empty JSON object.');
  }
}

function errorResponse(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof CommunityCoordinationError) {
    res.status(error.statusCode).json({ error: error.code.toLowerCase(), message: error.message });
    return;
  }
  if (error instanceof ParticipationError) {
    const status = { VALIDATION: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, EXPIRED: 410 }[error.code];
    res.status(status).json({ error: error.code.toLowerCase(), message: error.message });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'invalid_json', message: 'Community coordination request body is invalid JSON.' });
    return;
  }
  if (object(error) && error.status === 413) {
    res.status(413).json({ error: 'payload_too_large', message: 'Community coordination request body is too large.' });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Community coordination request failed.' });
}

export function createCommunityCoordinationRouters(options: CommunityCoordinationRouterOptions) {
  const accountRouter = Router();
  accountRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.use(json({ limit: '24kb', strict: true }));
  accountRouter.get('/', async (req, res) => {
    noQuery(req);
    res.json(await options.service.accountState(account(res)));
  });
  accountRouter.post('/', async (req, res) => {
    noQuery(req);
    if (!isCreateCommunityCoordinationGrantInput(req.body)) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination access request is invalid.');
    }
    res.status(201).json(await options.service.createGrant(account(res), req.body, idempotency(req)));
  });
  accountRouter.post('/:grantId/revoke', async (req, res) => {
    noQuery(req); emptyBody(req.body);
    res.json(await options.service.revokeGrant(account(res), parameter(req.params.grantId, 'Grant'), idempotency(req)));
  });
  accountRouter.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Community coordination account route was not found.' });
  });
  accountRouter.use(errorResponse);

  const agentRouter = Router();
  agentRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  agentRouter.use(async (req, res, next) => {
    try {
      const token = BEARER.exec(req.get('Authorization') ?? '')?.[1];
      if (!token) throw new CommunityCoordinationError('UNAUTHORIZED', 'A project agent token is required.');
      (res.locals as AgentLocals).participationAgent = await options.participation.authenticateBearer(token);
      next();
    } catch (error) { next(error); }
  });
  agentRouter.use(json({ limit: '24kb', strict: true }));
  agentRouter.get('/', async (req, res) => {
    noQuery(req);
    res.json(await options.service.state(agent(res)));
  });
  agentRouter.post('/claim', async (req, res) => {
    noQuery(req);
    if (!isClaimCommunityCoordinationTurnInput(req.body)) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination claim request is invalid.');
    }
    res.status(201).json(await options.service.claim(agent(res), req.body, idempotency(req)));
  });
  agentRouter.post('/turns/:turnId/renew', async (req, res) => {
    noQuery(req);
    if (!object(req.body) || !exact(req.body, ['grantId'])) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination renewal request is invalid.');
    }
    const input = { ...req.body, turnId: parameter(req.params.turnId, 'Turn') };
    if (!isRenewCommunityCoordinationTurnInput(input)) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination renewal request is invalid.');
    }
    res.json(await options.service.renew(agent(res), input, idempotency(req)));
  });
  agentRouter.post('/turns/:turnId/release', async (req, res) => {
    noQuery(req);
    if (!object(req.body) || !exact(req.body, ['grantId', 'reason'])) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination release request is invalid.');
    }
    const input = { ...req.body, turnId: parameter(req.params.turnId, 'Turn') };
    if (!isReleaseCommunityCoordinationTurnInput(input)) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination release request is invalid.');
    }
    res.json(await options.service.release(agent(res), input, idempotency(req)));
  });
  agentRouter.post('/turns/:turnId/complete', async (req, res) => {
    noQuery(req);
    if (!object(req.body) || !exact(req.body, ['grantId', 'plan'])) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination completion request is invalid.');
    }
    const input = { ...req.body, turnId: parameter(req.params.turnId, 'Turn') };
    if (!isCompleteCommunityCoordinationTurnInput(input)) {
      throw new CommunityCoordinationError('VALIDATION', 'Community coordination completion request is invalid.');
    }
    res.status(201).json(await options.service.complete(agent(res), input, idempotency(req)));
  });
  agentRouter.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Community coordination agent route was not found.' });
  });
  agentRouter.use(errorResponse);

  const publicRouter = Router();
  publicRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  publicRouter.get('/', async (req, res) => {
    noQuery(req);
    res.json(await options.service.publicProjection());
  });
  publicRouter.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Community coordination public route was not found.' });
  });
  publicRouter.use(errorResponse);

  return { accountRouter, agentRouter, publicRouter };
}
