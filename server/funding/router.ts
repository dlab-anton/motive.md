import express, { type Request, type Router } from 'express';
import type { CompleteOpenRouterConnectInput, CreateProjectFundingBudgetInput, ActivateProjectFundingBudgetInput } from '../../src/lib/funding.ts';
import { FundingError, OpenRouterFundingService } from './service.ts';

export type FundingActorResolver = (request: Request) => string | null;

function defaultActor(request: Request): string | null {
  const actor = request.res?.locals.actorId;
  return typeof actor === 'string' && actor.startsWith('account:') ? actor : null;
}

function errorStatus(error: FundingError): number { return error.status; }

/** Mount beneath `/api/funding`; the account-session middleware must run first. */
export function createOpenRouterFundingRouter(
  service: OpenRouterFundingService,
  resolveActor: FundingActorResolver = defaultActor,
): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const actorId = resolveActor(req);
    if (!actorId || !/^account:[A-Za-z0-9._~-]{1,480}$/.test(actorId)) {
      res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to manage provider funding.' } }); return;
    }
    res.locals.fundingActorId = actorId; next();
  });
  router.get('/openrouter', async (_req, res, next) => {
    try { res.json(await service.status(res.locals.fundingActorId)); } catch (error) { next(error); }
  });
  router.get('/openrouter/readiness', async (_req, res, next) => {
    try { res.json(await service.readiness(res.locals.fundingActorId)); } catch (error) { next(error); }
  });
  router.post('/openrouter/connect', async (_req, res, next) => {
    try { res.status(201).json(await service.startConnect(res.locals.fundingActorId, _req.get('origin'))); } catch (error) { next(error); }
  });
  router.post('/openrouter/callback', async (req, res, next) => {
    try {
      const input = req.body as Partial<CompleteOpenRouterConnectInput> | undefined;
      const connection = await service.completeConnect(res.locals.fundingActorId, input?.flowId ?? '', input?.code ?? '');
      res.status(201).json({ connection });
    } catch (error) { next(error); }
  });
  router.delete('/openrouter', async (_req, res, next) => {
    try { await service.disconnect(res.locals.fundingActorId); res.sendStatus(204); } catch (error) { next(error); }
  });
  router.post('/openrouter/budgets', async (req, res, next) => {
    try {
      const result = await service.createBudget(res.locals.fundingActorId, req.get('Idempotency-Key'), req.body as CreateProjectFundingBudgetInput);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });
  router.post('/openrouter/budgets/:budgetId/activate', async (req, res, next) => {
    try {
      const input = req.body as ActivateProjectFundingBudgetInput;
      const result = await service.activateBudget(res.locals.fundingActorId, req.params.budgetId,
        req.get('Idempotency-Key'), input);
      res.status(201).json(result);
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (!(error instanceof FundingError)) { next(error); return; }
    res.status(errorStatus(error)).json({ error: { code: error.code, message: error.message } });
  });
  return router;
}
