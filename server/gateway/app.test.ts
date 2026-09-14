import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationProjection, RunCapabilityContext } from '../../packages/accounting/src/kernel.ts';
import { profileDigest } from '../../packages/inference-gateway/src/profile.ts';
import { localGatewayProfile } from '../../scripts/lib/gateway-fixture.ts';
import { createInferenceGateway, type GatewayLedger } from './app.ts';

const encoder = new TextEncoder();
const requestBody = {
  model: 'motive-local-mock-v1', stream: true, store: false,
  input: [{ type: 'message', role: 'user', content: 'bounded lifecycle test' }],
  parallel_tool_calls: true, max_output_tokens: 256,
};
const frame = (type: string, response: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const created = frame('response.created', { id: 'lifecycle-response', model: 'motive-local-mock-v1', status: 'in_progress' });
const completed = frame('response.completed', { id: 'lifecycle-response', model: 'motive-local-mock-v1', status: 'completed', output: [],
  usage: { cost: '0.010000000000', input_tokens: 4, output_tokens: 2, total_tokens: 6 } });

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('inference gateway hosting lifecycle', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0).reverse()) await close(server); });

  it('registers detached provider accounting once and settles after the downstream disconnects', async () => {
    const profile = localGatewayProfile('http://127.0.0.1:9/v1/responses');
    let finishProvider!: () => void;
    const provider = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(created));
        finishProvider = () => { controller.enqueue(encoder.encode(completed)); controller.close(); };
      },
    });
    const operation = { providerOperationId: 'operation-lifecycle-test' } as OperationProjection;
    const context = {
      capabilityId: 'capability-lifecycle-test', projectId: 'project-lifecycle-test', attemptId: 'attempt-lifecycle-test',
      grantId: 'grant-lifecycle-test', sourceId: 'source-lifecycle-test', profileDigest: profileDigest(profile), leaseEpoch: 1,
      controllerGeneration: 'controller-lifecycle-test', issuedByActorId: 'test:lifecycle',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
    } satisfies RunCapabilityContext;
    const settleOperation = vi.fn(async () => operation);
    const ledger = {
      getRunCapabilityContext: vi.fn(async () => context),
      admitCapabilityRequest: vi.fn(async () => operation),
      claimOperationForDispatch: vi.fn(async () => ({ claimed: true, operation })),
      recordOperationProviderIdentity: vi.fn(async () => operation),
      settleOperation,
      markOperationUnknown: vi.fn(async () => operation),
    } as unknown as GatewayLedger;
    const tracked: Promise<void>[] = [];
    const gateway = createInferenceGateway({
      ledger, profiles: [profile], resolveCredential: async () => 'synthetic-provider-only',
      trackBackgroundTask: task => tracked.push(task),
      fetch: vi.fn(async () => new Response(provider, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    });
    const server = createServer(gateway.app); servers.push(server);
    const url = await listen(server);
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(48)}`,
    }, body: JSON.stringify(requestBody) });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(tracked).toHaveLength(1);
    finishProvider();
    await tracked[0];
    expect(settleOperation).toHaveBeenCalledTimes(1);
    expect(gateway.activeRequests).toBe(0);
  });

  it('rejects a profile beyond the hosting ceiling before credentials or provider access', () => {
    const profile = localGatewayProfile('http://127.0.0.1:9/v1/responses');
    const incompatible = { ...profile, limits: { ...profile.limits, requestTimeoutMs: 240_001 } };
    const resolveCredential = vi.fn(async () => 'must-not-be-read');
    const fetchProvider = vi.fn();

    expect(() => createInferenceGateway({
      ledger: {} as GatewayLedger,
      profiles: [incompatible],
      resolveCredential,
      fetch: fetchProvider,
      maximumRequestTimeoutMs: 240_000,
    })).toThrow('hosting lifecycle ceiling');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchProvider).not.toHaveBeenCalled();
  });
});
