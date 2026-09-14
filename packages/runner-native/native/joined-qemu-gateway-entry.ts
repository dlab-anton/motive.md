import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { LedgerKernel } from '../../accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../accounting/src/migrations.ts';
import { createInferenceGateway, type GatewayAudit } from '../../../server/gateway/app.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../../scripts/lib/gateway-fixture.ts';
import { redactCapturedRequests } from '../../runner-codex/src/harness.ts';
import { hasSuccessfulFixtureRead } from '../../runner-codex/src/protocol.ts';
import { startDeterministicMock } from '../../runner-codex/src/mock-provider.ts';

const postgresSocket = process.env.MOTIVE_JOINED_PG_SOCKET;
if (postgresSocket !== '/run/motive/postgres') throw new Error('The joined gateway requires the private guest PostgreSQL socket.');

const actorId = 'protected-worker-qemu-gateway-preflight';
const pool = new Pool({ host: postgresSocket, database: 'motive', user: 'motive_controller', max: 6,
  query_timeout: 5_000, connectionTimeoutMillis: 2_000 });
const ledger = new LedgerKernel(pool);
const audit: GatewayAudit[] = [];
const diagnostics: string[] = [];
let attemptId: string | null = null;
let mock: Awaited<ReturnType<typeof startDeterministicMock>> | null = null;
let gateway: ReturnType<typeof createInferenceGateway> | null = null;
let server: ReturnType<typeof createServer> | null = null;
let operations: Record<string, unknown>[] = [];
let spendingDisabled = false;

const stopRequested = new Promise<void>(resolve => {
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});

try {
  if (!(await getPostgresSchemaStatus(pool)).exact) throw new Error('Exact local migrations are required.');
  await ledger.setControllerSpending({ actorId, idempotencyKey: randomUUID(), enabled: true,
    reason: 'Synthetic joined Linux Codex and gateway probe; no provider credentials.' });
  mock = await startDeterministicMock('happy', '0.010000000000');
  const profile = localGatewayProfile(`${mock.baseUrl}/responses`);
  const seed = await seedGatewayAttempt(ledger, profile);
  attemptId = seed.attempt.id;
  gateway = createInferenceGateway({
    ledger,
    profiles: [profile],
    audit: event => audit.push(event),
    resolveCredential: async (sourceId, ref) => sourceId === seed.source.id && ref === profile.upstream.credentialRef
      ? 'synthetic-local-provider-only' : null,
  });
  server = createServer(gateway.app);
  server.listen(8080, '127.0.0.1');
  await once(server, 'listening');
  await writeFile('/exchange/capability', `${seed.capability}\n`, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
  await chmod('/exchange/capability', 0o400);
  await writeFile('/exchange/ready', `${JSON.stringify({ status: 'ready', attemptId })}\n`, { encoding: 'utf8', mode: 0o444, flag: 'wx' });
  process.stdout.write('MOTIVE_JOINED_GATEWAY_READY\n');
  await stopRequested;
  await gateway.drain(10_000);
  server.closeAllConnections();
  await new Promise<void>(resolve => server!.close(() => resolve()));
} catch (error) {
  diagnostics.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
} finally {
  try { await gateway?.drain(10_000); }
  catch (error) { diagnostics.push(`gateway drain: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  } catch (error) {
    diagnostics.push(`server close: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (attemptId) {
      operations = (await pool.query(`SELECT provider_operation_id, request_sequence, status, reserved_amount::text,
        actual_cost::text, request_body_digest, profile_digest, admission_metadata, provider_response_id,
        admitted_at::text, dispatched_at::text, settled_at::text,
        COALESCE(lag(settled_at) OVER (ORDER BY request_sequence) <= admitted_at, TRUE) AS admitted_after_previous_settlement
        FROM motive.request_operations WHERE attempt_id=$1 ORDER BY request_sequence`, [attemptId])).rows;
    }
  } catch (error) {
    diagnostics.push(`operation query: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { await mock?.close(); }
  catch (error) { diagnostics.push(`mock close: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    await ledger.setControllerSpending({ actorId, idempotencyKey: randomUUID(), enabled: false,
      reason: 'Synthetic joined preflight stopped; keep spending disabled.' });
    const state = await pool.query<{ spending_enabled: boolean }>('SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE');
    spendingDisabled = state.rows.length === 1 && state.rows[0].spending_enabled === false;
  } catch (error) {
    diagnostics.push(`spending disable: ${error instanceof Error ? error.message : String(error)}`);
  }
  await pool.end().catch(error => diagnostics.push(`pool close: ${error instanceof Error ? error.message : String(error)}`));
}

const requests = mock?.requests ?? [];
const successfulFileReads = ['turn-one', 'turn-two'].filter((expected, index) => requests.some(request =>
  hasSuccessfulFixtureRead(request.body, `call_motive_${index + 1}`, expected),
)).length;
const settled = operations.length === 3 && operations.every(operation => operation.status === 'RECONCILED');
const metadataNormalizationPassed = operations.length === 3 && operations.every(operation => {
  const metadata = operation.admission_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const candidate = metadata as Record<string, unknown>;
  const rawDigest = candidate.rawBodyDigest;
  const normalizedDigest = candidate.normalizedBodyDigest;
  const normalizations = candidate.normalizations;
  return typeof rawDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(rawDigest)
    && typeof normalizedDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(normalizedDigest)
    && rawDigest !== normalizedDigest && operation.request_body_digest === normalizedDigest
    && Array.isArray(normalizations) && normalizations.some(value => value && typeof value === 'object'
      && (value as Record<string, unknown>).field === 'client_metadata'
      && (value as Record<string, unknown>).from === 'pinned-codex-0.153.4'
      && (value as Record<string, unknown>).to === 'omitted'
      && typeof (value as Record<string, unknown>).valueDigest === 'string');
});
const clientMetadataOmittedUpstream = requests.length === 3
  && requests.every(request => !Object.prototype.hasOwnProperty.call(request.body, 'client_metadata'));
const oneRequestAtATime = operations.length === 3 && operations.every((operation, index) => {
  if (operation.request_sequence !== index + 1 || typeof operation.admitted_at !== 'string'
      || typeof operation.settled_at !== 'string') return false;
  return operation.admitted_after_previous_settlement === true;
});
const evidence = {
  format: 'motive.protected-worker-joined-gateway/0.1',
  status: diagnostics.length === 0 && spendingDisabled && settled && metadataNormalizationPassed
    && clientMetadataOmittedUpstream && oneRequestAtATime && requests.length === 3 && successfulFileReads === 2
    ? 'passed' : 'failed',
  attemptId,
  realProviderCalls: 0,
  realSpendUsd: '0.000000000000',
  syntheticUpstreamRequests: redactCapturedRequests(requests),
  toolExecution: { requestedFileReads: 2, successfulFileReads },
  requestPolicy: { metadataNormalizationPassed, clientMetadataOmittedUpstream, oneRequestAtATime },
  operations,
  audit,
  spendingDisabled,
  diagnostics,
};
process.stdout.write(`MOTIVE_GATEWAY_EVIDENCE ${JSON.stringify(evidence)}\n`);
if (evidence.status !== 'passed') process.exitCode = 1;
