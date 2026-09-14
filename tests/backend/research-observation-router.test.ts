import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { expect, it } from 'vitest';
import { createResearchObservationRouter } from '../../server/research-memory/observation-router.ts';
import { SubmissionDeliveryError } from '../../server/research-memory/submission-delivery.ts';

it('serves exact public observation bytes and digest without preparing research or requiring a bearer', async () => {
  const deliveryId = randomUUID(); const bytes = Buffer.from('{"finding":"A bounded negative result. \\u2192"}', 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const calls: string[] = []; const app = express();
  app.use('/api/public/projects/circle-packing', createResearchObservationRouter({
    publicObservationManifest: async (projectSlug, id) => {
      expect(projectSlug).toBe('circle-packing'); calls.push(id);
      if (id !== deliveryId) throw new SubmissionDeliveryError('NOT_FOUND', 'Internal record detail');
      return { bytes, digest };
    },
  }));
  const server = app.listen(0); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const origin = `http://127.0.0.1:${address.port}/api/public/projects/circle-packing/research-deliveries`;
  try {
    const response = await fetch(`${origin}/${deliveryId}/observation`);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('etag')).toBe(`"${digest}"`);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const missing = await fetch(`${origin}/${randomUUID()}/observation`);
    expect(missing.status).toBe(404); expect(await missing.text()).not.toContain('Internal');
    const malformed = await fetch(`${origin}/not-a-uuid/observation`); expect(malformed.status).toBe(404);
    expect(calls).toHaveLength(2);
  } finally { server.close(); await once(server, 'close'); }
});
