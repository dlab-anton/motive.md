import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';
import { redactHarnessEvidence, runLocalCompatibilityHarness } from '../packages/runner-codex/src/harness.ts';
import { createInferenceGateway, type GatewayAudit } from '../server/gateway/app.ts';
import { localGatewayProfile, seedGatewayAttempt } from './lib/gateway-fixture.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
if (!databaseUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Gateway preflight requires a dedicated loopback MOTIVE_TEST_DATABASE_URL.');
}
const pool = new Pool({ connectionString: databaseUrl, max: 6, query_timeout: 5000, connectionTimeoutMillis: 2000 });
const ledger = new LedgerKernel(pool);
let attemptId: string | null = null;
const audit: GatewayAudit[] = [];
try {
  if (!(await getPostgresSchemaStatus(pool)).exact) throw new Error('Apply the exact local migrations before gateway preflight.');
  await ledger.setControllerSpending({ actorId: 'local-gateway-preflight', idempotencyKey: randomUUID(),
    enabled: true, reason: 'Synthetic loopback gateway compatibility probe; no provider credentials.' });
  const evidence = await runLocalCompatibilityHarness('happy', {
    syntheticCost: '0.010000000000',
    async connectGateway(providerBaseUrl) {
      const profile = localGatewayProfile(`${providerBaseUrl}/responses`);
      const seed = await seedGatewayAttempt(ledger, profile);
      attemptId = seed.attempt.id;
      const gateway = createInferenceGateway({ ledger, profiles: [profile], audit: event => audit.push(event),
        resolveCredential: async (sourceId, ref) => sourceId === seed.source.id && ref === profile.upstream.credentialRef ? 'synthetic-local-provider-only' : null });
      const server = createServer(gateway.app);
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local gateway address');
      return { baseUrl: `http://127.0.0.1:${address.port}/v1`, capability: seed.capability,
        async close() { await gateway.drain(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
    },
  });
  const operations = (await pool.query(`SELECT provider_operation_id, request_sequence, status, reserved_amount::text,
    actual_cost::text, request_body_digest, profile_digest, admission_metadata, provider_response_id
    FROM motive.request_operations WHERE attempt_id=$1 ORDER BY request_sequence`, [attemptId])).rows;
  const output = {
    format: 'motive.gateway-preflight-evidence/0.1', capturedAt: new Date().toISOString(),
    status: evidence.status === 'passed' && operations.length === 3 ? 'local-synthetic-passed'
      : operations.length === 0 ? 'blocked-runtime-profile' : 'local-tool-execution-failed',
    realProviderCalls: 0, realSpendUsd: '0.000000000000',
    interpretation: 'Only local synthetic requests are possible here. Gateway admission and settlement do not prove successful file execution or complete Gate A.',
    codex: redactHarnessEvidence(evidence), operations, audit,
  };
  const destination = resolve('fixtures/compatibility/evidence/codex-accounting-gateway.json');
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: output.status, providerRequests: evidence.requests.length, admittedOperations: operations.length,
    successfulFileReads: evidence.toolExecution?.successfulFileReads, evidence: destination }));
  if (output.status !== 'local-synthetic-passed') process.exitCode = 1;
} finally {
  try { await ledger.setControllerSpending({ actorId: 'local-gateway-preflight', idempotencyKey: randomUUID(),
    enabled: false, reason: 'Local gateway preflight stopped; keep spending disabled.' }); }
  finally { await pool.end(); }
}
