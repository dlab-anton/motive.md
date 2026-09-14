import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';

/** Synthetic HTTP peer for the disposable application rehearsal only. */
export async function startHypothesisFixture() {
  const apiKey = `he_${randomBytes(32).toString('base64url')}`;
  const tenantId = randomUUID(); const channelId = randomUUID(); const hypothesisId = randomUUID(); const evidenceId = randomUUID();
  const timestamp = '2026-09-07T00:00:00.000Z'; const channelName = 'circle-packing-rehearsal';
  const channel = { id: channelId, name: channelName, goal: 'Retain reference reproduction and bounded search results.', created_at: timestamp, updated_at: timestamp };
  const hypothesis = { id: hypothesisId, channel: channelName, statement: 'The frozen reference survives the exact checker.',
    context: 'Synthetic integration rehearsal.', falsification_criteria: 'The exact checker rejects the unchanged reference.',
    status: 'testing', confidence: .5, parent_id: null, outcome: null, updated_at: timestamp, created_at: timestamp, is_archived: false };
  const evidence = { id: evidenceId, hypothesis_id: hypothesisId, content: 'An earlier synthetic check retained the reference score.',
    source: 'Synthetic rehearsal fixture', evidence_type: 'neutral', strength: null, confidence_after: null, created_by: 'fixture-author', created_at: timestamp };
  const list = (items: unknown[]) => ({ items, total: items.length, offset: 0, limit: 20 });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') { response.writeHead(405).end('{}'); return; }
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/health') { response.end(JSON.stringify({ version: '1.8.0', status: 'ok', database: 'ok' })); return; }
    if (request.headers['x-api-key'] !== apiKey) { response.writeHead(401).end('{}'); return; }
    let body: unknown;
    if (url.pathname === '/api/v1/keys') body = [{ id: randomUUID(), prefix: apiKey.slice(0, 10), tenant_id: tenantId, is_active: true }];
    else if (url.pathname === `/api/v1/channels/${channelName}`) body = channel;
    else if (url.pathname === '/api/v1/hypotheses' && url.searchParams.get('channel') === channelName) body = list(url.searchParams.get('is_archived') === 'true' ? [] : [hypothesis]);
    else if (url.pathname === `/api/v1/hypotheses/${hypothesisId}/evidence`) body = list([evidence]);
    else if (url.pathname === '/api/v1/insights' && url.searchParams.get('channel') === channelName) body = list([]);
    else { response.writeHead(404).end('{}'); return; }
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not listen.');
  return { input: { apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`, apiKey, tenantId, channelId, channelName },
    hypothesisId, evidenceId, timestamp, statement: hypothesis.statement,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
