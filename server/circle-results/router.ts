import { Router } from 'express';
import { CircleResultsError, type CircleResultsService } from './service.ts';

/** Public reads are separate from account routes, which require the app's session/origin middleware. */
export function createCircleResultsRouters(service: CircleResultsService, isActorActive: (actorId: string) => boolean | Promise<boolean>) {
  const publicRouter = Router();
  const accountRouter = Router();
  publicRouter.get('/', async (_req, res) => { res.json(await service.publicResults('circle-packing')); });
  publicRouter.get('/:resultId/report', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.json(await service.publicReport(req.params.resultId));
  });
  publicRouter.get('/:resultId/investigation', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.json(await service.publicInvestigation(req.params.resultId));
  });
  publicRouter.get('/:resultId/artifact', async (req, res) => {
    const artifact = await service.publicArtifact(req.params.resultId);
    res.setHeader('Content-Type', artifact.mediaType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="candidate.json"');
    res.setHeader('ETag', `"${artifact.digest}"`);
    res.send(Buffer.from(artifact.bytes));
  });
  accountRouter.post('/:resultId/reviews', async (req, res) => {
    const actorId: unknown = res.locals.actorId;
    if (typeof actorId !== 'string' || !actorId.startsWith('account:') || !await isActorActive(actorId)) {
      res.status(401).json({ error: 'A live account session is required.' }); return;
    }
    const key = req.get('Idempotency-Key');
    if (!key) throw new CircleResultsError('VALIDATION', 'Idempotency-Key is required.', 400);
    res.json(await service.review(actorId, req.params.resultId, req.body, key));
  });
  return { publicRouter, accountRouter };
}
