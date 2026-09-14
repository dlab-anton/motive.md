import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { DurableWorkerCoordinator, type WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import { VercelSandboxAdapter } from '../../packages/sandbox-vercel/src/adapter.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { VercelOrphanProvider } from '../../packages/sandbox-vercel/src/orphans.ts';
import { ArtifactSealer, type ImmutableObjectStore } from '../../packages/artifact-storage/src/index.ts';
import type { SandboxSdkFactory, SdkSandbox } from '../../packages/sandbox-vercel/src/types.ts';
import type { WorkerWorkspaceBindingInput } from '../../packages/orchestration/src/store-types.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../scripts/lib/gateway-fixture.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = databaseUrl ? describe : describe.skip;
const digest = `sha256:${'b'.repeat(64)}` as const;

pgDescribe('PostgreSQL coordinator and real sandbox adapter integration', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  let store: PostgresOrchestrationStore;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2000, query_timeout: 5000 });
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool); store = new PostgresOrchestrationStore(pool);
  });
  beforeEach(async () => {
    await ledger.setControllerSpending({ actorId: 'coordinator-integration', idempotencyKey: randomUUID(), enabled: true, reason: 'Synthetic local coordinator integration' });
  });
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  afterAll(async () => {
    try { await ledger?.setControllerSpending({ actorId: 'coordinator-integration', idempotencyKey: randomUUID(), enabled: false, reason: 'Coordinator integration complete' }); }
    finally { await pool?.end(); }
  });

  async function setup() {
    const seed = await seedGatewayAttempt(ledger, localGatewayProfile('http://127.0.0.1:1/responses'));
    const authorization = await store.createInfrastructureAuthorization({ id: randomUUID(), sourceAccountId: seed.source.id,
      sourceAccountRef: `synthetic:compute:${seed.source.id}`, actorId: seed.actorId, limitUsd: '3', expiresAt: new Date(Date.now() + 600000).toISOString() });
    const plan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: seed.attempt.workOrderId, termsDigest: seed.attempt.termsDigest,
      inputDigest: seed.attempt.inputDigest, inferenceProfileDigest: seed.attempt.profileDigest, actorId: seed.actorId,
      infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1', capabilityTtlSeconds: 120,
      command: { executable: '/usr/local/bin/codex', args: ['exec', 'synthetic trusted fixture'] },
      sandbox: { format: 'motive.sandbox-profile/0.1', profileDigest: digest, protectedRuntime: defineProtectedRuntime(digest),
        trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40), materialDigest: digest, buildRecipeDigest: digest },
        timeoutMs: 120000, commandTimeoutMs: 60000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
        egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
          artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }] },
        artifacts: { maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 8192 } } };
    const calls: string[] = [];
    let remote: SdkSandbox | null = null;
    const sdk: SandboxSdkFactory = {
      async create(input) {
        calls.push('create');
        const persisted = await store.getExecution(seed.attempt.id);
        expect(persisted?.effects.find(item => item.kind === 'CREATE')?.state).toBe('CLAIMED');
        remote = { name: input.name, sessionId: randomUUID(), status: 'running', persistent: false,
          sourceSnapshotId: 'snap_MotiveTrusted01', tags: { ...input.tags },
          async startCommand() {
            calls.push('command');
            const state = await store.getExecution(seed.attempt.id);
            expect(state?.effects.find(item => item.kind === 'COMMAND')?.state).toBe('CLAIMED');
            return { cmdId: 'synthetic-command', exitCode: null };
          },
          async getCommand() { return { cmdId: 'synthetic-command', exitCode: 0, durationMs: 50 }; },
          async stop() { calls.push('stop'); remote!.status = 'stopped'; return { status: 'stopped' }; },
        };
        return remote;
      },
      async get(input) {
        if (!remote || remote.name !== input.name || input.resume !== false) throw new Error('Unexpected synthetic handle');
        return remote;
      },
      async listOwned() { return { sandboxes: remote ? [remote] : [], complete: true }; },
    };
    const ownerId = `coordinator-test:${randomUUID()}`;
    const adapter = new VercelSandboxAdapter(plan.sandbox, sdk, { effects: 'durable-controller' });
    const objects = new Map<string, Uint8Array>();
    const objectStore: ImmutableObjectStore = {
      async putIfAbsent(input) {
        if (objects.has(input.objectKey)) return { status: 'EXISTS', objectId: input.objectKey };
        const parts: Uint8Array[] = [];
        for await (const part of input.body) parts.push(Uint8Array.from(part));
        objects.set(input.objectKey, Buffer.concat(parts));
        return { status: 'CREATED', objectId: input.objectKey };
      },
      async readObject(input) {
        const bytes = objects.get(input.objectKey); if (!bytes) return null;
        return { declaredBytes: bytes.length, body: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += input.maximumChunkBytes) yield bytes.slice(offset, offset + input.maximumChunkBytes);
        })() };
      },
    };
    const sealer = new ArtifactSealer({ store: objectStore,
      // Explicit test-only reader: this exercises sealing, not native filesystem isolation.
      reader: { async assertReady() { return { capability: 'native-beneath-workspace-no-follow-v1' }; }, async capture(input) {
        const bytes = new TextEncoder().encode('Synthetic worker output; independently unverified.\n');
        return { relativePath: input.relativePath, kind: 'regular', linkCount: 1, declaredBytes: bytes.length,
          identityToken: 'synthetic-snapshot', resolution: 'beneath-workspace-no-follow', immutableSnapshot: true,
          read: async function* () { yield Uint8Array.from(bytes); } };
      } },
      policy: { async assertReady() { return { capability: 'trusted-operator-artifact-policy-v1' }; },
        async approvedPaths() { return [{ relativePath: 'result.txt', mediaType: 'text/plain', availability: 'REQUIRED' }]; } },
    });
    const coordinator = new DurableWorkerCoordinator({ store, ledger, ownerId, resolvePlan: async () => plan, adapter: () => adapter,
      orphanProvider: new VercelOrphanProvider(sdk, 'durable-controller'),
      artifacts: { assertReady: value => sealer.assertReady(value), async seal(input) { calls.push('seal'); return sealer.seal(input); } } });
    cleanups.push(async () => {
      const execution = await store.getExecution(seed.attempt.id);
      const lease = await store.acquireLease(seed.attempt.id, ownerId, 60);
      for (const environment of execution?.environments ?? []) {
        if (environment.state === 'TERMINATED' || environment.state === 'ABANDONED') continue;
        if (!environment.externalId) {
          const effect = execution?.effects.find(item => item.environmentId === environment.id && item.kind === 'CREATE');
          if (effect?.state === 'INTENT_RECORDED') await store.abandonReservedEnvironment(lease, environment.id);
          continue;
        }
        if (remote) await remote.stop();
        await store.recordObservation(lease, environment.id, { state: 'TERMINATED', providerStatus: 'stopped', providerTerminal: true });
      }
    });
    return { seed, authorization, coordinator, calls, objects, ownerId, plan };
  }

  it('persists claims, seals, revokes and stops while retaining unbilled compute holds', async () => {
    const f = await setup();
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    expect(f.calls).toEqual(['create', 'command', 'seal', 'stop']);
    const execution = await store.getExecution(f.seed.attempt.id);
    expect(execution?.environments[0].state).toBe('TERMINATED');
    expect(execution?.artifactSeal?.status).toBe('SEALED');
    const manifestEntry = [...f.objects.entries()].find(([key]) => key.endsWith('/manifest.json'));
    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry![1]));
    expect(manifest.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });
    expect(manifest.controller_observed_outcome).toMatchObject({ kind: 'COMMAND_EXITED', exitCode: 0 });
    const authority = await pool.query('SELECT held_usd::text, consumed_usd::text FROM motive.infrastructure_authorizations WHERE id=$1', [f.authorization.id]);
    expect(authority.rows[0]).toEqual({ held_usd: '1.000000000000', consumed_usd: '0.000000000000' });
    const capabilities = await pool.query('SELECT revoked_at FROM motive.run_capabilities WHERE attempt_id=$1', [f.seed.attempt.id]);
    expect(capabilities.rows.length).toBeGreaterThan(0);
    expect(capabilities.rows.every(item => item.revoked_at !== null)).toBe(true);
  });

  it('tears down a provisioned worker after grant revocation without starting its command', async () => {
    const f = await setup(); await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    await ledger.revokeGrant({ actorId: f.seed.actorId, idempotencyKey: randomUUID(), grantId: f.seed.grant.id, reason: 'Stop synthetic compute' });
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    expect(f.calls).toContain('stop'); expect(f.calls).not.toContain('command');
    expect((await store.getExecution(f.seed.attempt.id))?.environments[0].state).toBe('TERMINATED');
    expect((await ledger.getAttempt(f.seed.attempt.id))?.cancellationRequestedAt).not.toBeNull();
  });

  it('freezes one native workspace identity through concurrent replay, process restart and teardown', async () => {
    const f = await setup();
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    const lease = await store.acquireLease(f.seed.attempt.id, f.ownerId, 60);
    const environment = (await store.getExecution(f.seed.attempt.id))!.environments[0];
    const input: WorkerWorkspaceBindingInput = {
      workerRuntimeDigest: f.plan.sandbox.protectedRuntime!.runtimeDigest,
      binding: { format: 'motive.vercel-native-workspace-binding/0.1', runtimeDigest: digest,
        workspaceIdentity: '1:12345:7', handle: { provider: 'vercel', attemptId: f.seed.attempt.id,
          sandboxId: environment.externalId!, sessionId: environment.sessionId!,
          leaseEpoch: environment.leaseEpoch!, profileDigest: environment.profileDigest! } },
    };
    await expect(store.recordWorkerWorkspaceBinding(lease, environment.id, input)).rejects.toMatchObject({ code: 'EFFECT_UNAVAILABLE' });
    // SQL cannot use an unrelated/orphan command claim as worker provenance.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO motive.orchestration_effects
        (id, environment_id, attempt_id, kind, effect_key, command_digest, state, claimed_by, claimed_lease_epoch, claimed_at)
        VALUES ($1,$2,NULL,'COMMAND',$3,$4,'CLAIMED','synthetic-orphan',1,clock_timestamp())`,
      [randomUUID(), environment.id, randomUUID(), digest]);
      await expect(client.query(`INSERT INTO motive.native_workspace_bindings
        (environment_id, attempt_id, provider, external_id, session_id, lease_epoch, controller_generation,
         profile_digest, worker_runtime_digest, collector_runtime_digest, workspace_identity)
        VALUES ($1,$2,'vercel',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [environment.id, f.seed.attempt.id, environment.externalId, environment.sessionId, environment.leaseEpoch,
        environment.controllerGeneration, environment.profileDigest, input.workerRuntimeDigest, input.binding.runtimeDigest,
        input.binding.workspaceIdentity])).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    const copies = await Promise.all([store.recordWorkerWorkspaceBinding(lease, environment.id, input),
      store.recordWorkerWorkspaceBinding(lease, environment.id, input)]);
    expect(copies).toEqual([input, input]);
    const restarted = new PostgresOrchestrationStore(pool);
    expect(await restarted.getWorkerWorkspaceBinding(lease, environment.id)).toEqual(input);
    for (const binding of [{ ...input.binding, workspaceIdentity: '1:54321:7' },
      { ...input.binding, runtimeDigest: `sha256:${'c'.repeat(64)}` as const }]) {
      await expect(restarted.recordWorkerWorkspaceBinding(lease, environment.id, { ...input, binding }))
        .rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    }
    await expect(pool.query('UPDATE motive.native_workspace_bindings SET workspace_identity = $2 WHERE environment_id = $1',
      [environment.id, '2:22:3'])).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM motive.native_workspace_bindings WHERE environment_id = $1',
      [environment.id])).rejects.toMatchObject({ code: '55000' });
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    expect(await restarted.recordWorkerWorkspaceBinding(lease, environment.id, input)).toEqual(input);
    expect(await restarted.getWorkerWorkspaceBinding(lease, environment.id)).toEqual(input);
  });

  it('rejects native bindings from a different session, runtime or attempt lease', async () => {
    const f = await setup();
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    const lease = await store.acquireLease(f.seed.attempt.id, f.ownerId, 60);
    const environment = (await store.getExecution(f.seed.attempt.id))!.environments[0];
    const input: WorkerWorkspaceBindingInput = {
      workerRuntimeDigest: f.plan.sandbox.protectedRuntime!.runtimeDigest,
      binding: { format: 'motive.vercel-native-workspace-binding/0.1', runtimeDigest: digest,
        workspaceIdentity: '1:12345:7', handle: { provider: 'vercel', attemptId: f.seed.attempt.id,
          sandboxId: environment.externalId!, sessionId: environment.sessionId!,
          leaseEpoch: environment.leaseEpoch!, profileDigest: environment.profileDigest! } },
    };
    await expect(store.recordWorkerWorkspaceBinding(lease, environment.id, { ...input,
      binding: { ...input.binding, handle: { ...input.binding.handle, sessionId: 'replacement-session' } } }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });
    await expect(store.recordWorkerWorkspaceBinding(lease, environment.id, { ...input, workerRuntimeDigest: digest }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });
    await expect(store.recordWorkerWorkspaceBinding({ ...lease, attemptId: randomUUID() }, environment.id, input))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await expect(store.getWorkerWorkspaceBinding({ ...lease, epoch: lease.epoch + 1 }, environment.id))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    await expect(store.recordWorkerWorkspaceBinding(lease, environment.id, input))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });
    expect(await store.getWorkerWorkspaceBinding(lease, environment.id)).toBeNull();
  });

  it('hands a stopped sealed worker to evaluator admission while inference stays fenced across replay', async () => {
    const f = await setup();
    for (let step = 0; step < 4; step++) await f.coordinator.reconcileAttempt(f.seed.attempt.id);
    const attempt = await ledger.getAttempt(f.seed.attempt.id);
    expect(attempt).toMatchObject({ executionStatus: 'OUTPUT_SEALED', admissionClosedAt: null });
    const lease = await store.acquireLease(f.seed.attempt.id, f.ownerId, 60);
    await expect(ledger.issueRunCapability({ actorId: f.seed.actorId, idempotencyKey: randomUUID(),
      attemptId: f.seed.attempt.id, ttlSeconds: 60 })).rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });
    await expect(ledger.admitRequest({ actorId: f.seed.actorId, idempotencyKey: randomUUID(),
      attemptId: f.seed.attempt.id, leaseEpoch: lease.epoch, profileDigest: f.seed.attempt.profileDigest,
      requestBody: { synthetic: 'forbidden-after-worker-seal' }, maximumExposure: '0.01' }))
      .rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });
    const next = await store.reserveEnvironment(lease, { kind: 'EVALUATOR', profileDigest: digest,
      profileSnapshot: { synthetic: true }, launchPlanDigest: digest,
      infrastructureAuthorizationId: f.authorization.id, maximumCostUsd: '1' });
    expect(next.environment.kind).toBe('EVALUATOR');
    expect((await ledger.getAttempt(f.seed.attempt.id))?.executionStatus).toBe('EVALUATING');
    expect(f.calls).toEqual(['create', 'command', 'seal', 'stop']);
  });
});
