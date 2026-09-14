import { Router } from 'express';
import { SubmissionDeliveryError } from './submission-delivery.ts';

type ObservationReader = {
  publicObservationManifest(projectSlug: string, deliveryId: string): Promise<{ digest: string; bytes: Buffer }>;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Public retained bytes only; this route neither prepares nor dispatches work. */
export function createResearchObservationRouter(reader: ObservationReader) {
  const router = Router();
  router.get('/research-deliveries/:deliveryId/observation', async (req, res) => {
    const { deliveryId } = req.params;
    if (!UUID.test(deliveryId)) {
      res.status(404).json({ error: 'The retained observation is unavailable.' }); return;
    }
    try {
      const manifest = await reader.publicObservationManifest('circle-packing', deliveryId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('ETag', `"${manifest.digest}"`);
      // Do not reserialize: the engine observation pins these exact UTF-8 bytes.
      res.send(manifest.bytes);
    } catch (error) {
      if (error instanceof SubmissionDeliveryError && error.code === 'NOT_FOUND') {
        res.status(404).json({ error: 'The retained observation is unavailable.' }); return;
      }
      throw error;
    }
  });
  return router;
}
