import { Router, type NextFunction, type Request, type Response } from 'express';
import { ProjectRunProjectionError, type ProjectRunProjectionService } from './projection.ts';

export function createProjectRunPublicRouter(service: ProjectRunProjectionService): Router {
  const router = Router();
  router.get('/usage', async (_req, res, next) => {
    try { res.json(await service.publicCircleUsage()); } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(error instanceof ProjectRunProjectionError)) { next(error); return; }
    res.status(error.status).json({ error: error.code.toLowerCase() });
  });
  return router;
}
