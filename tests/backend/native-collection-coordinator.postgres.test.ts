import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { DurableWorkerCoordinator, launchDigest, type WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { VercelSandboxAdapter } from '../../packages/sandbox-vercel/src/adapter.ts';
import { VercelOrphanProvider } from '../../packages/sandbox-vercel/src/orphans.ts';
import { sandboxName } from '../../packages/sandbox-vercel/src/policy.ts';
import type { SandboxSdkFactory, SdkSandbox } from '../../packages/sandbox-vercel/src/types.ts';
import {
  ClaimedVercelNativeArtifactReader,
  createClaimedNativeArtifactCollector,
  defineReviewedVercelNativeArtifactRuntime,
  StaticReviewedVercelNativeArtifactRuntimeRegistry,
  type VercelNativeArtifactTransport,
  type ImmutableObjectStore,
} from '../../packages/artifact-storage/src/index.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../scripts/lib/gateway-fixture.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = databaseUrl ? describe : describe.skip;
const profileDigest = `sha256:${'7'.repeat(64)}` as const;
const workerLauncherDigest = `sha256:${'8'.repeat(64)}` as const;
const launchPlanDigest = `sha256:${'9'.repeat(64)}` as const;

pgDescribe('native collection plan coordinator and claimed reader', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  let store: PostgresOrchestrationStore;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    ledger = new LedgerKernel(pool);
    store = new PostgresOrchestrationStore(pool);
  });

  beforeEach(async () => {
    await ledger.setControllerSpending({
      actorId: 'native-collection-coordinator-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'native collection coordinator PostgreSQL test setup',
    });
  });

  afterEach(async () => {
    await ledger.setControllerSpending({
      actorId: 'native-collection-coordinator-test', idempotencyKey: randomUUID(), enabled: true,
      reason: 'native collection coordinator PostgreSQL test cleanup',
    });
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: 'native-collection-coordinator-test', idempotencyKey: randomUUID(), enabled: false,
        reason: 'native collection coordinator PostgreSQL tests complete',
      });
    } finally {
      await pool?.end();
    }
  });

  async function assertAuthorityClosureDuringNativeFreeze(mode: 'CANCEL' | 'FREEZE'): Promise<void> {
    const seed = await seedGatewayAttempt(ledger, localGatewayProfile('http://127.0.0.1:1/responses'));
    const authorization = await store.createInfrastructureAuthorization({
      id: randomUUID(), sourceAccountId: seed.source.id, sourceAccountRef: `synthetic:native-close:${seed.source.id}`,
      actorId: seed.actorId, limitUsd: '2.000000000000', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const sandbox = {
      format: 'motive.sandbox-profile/0.1' as const, profileDigest,
      protectedRuntime: defineProtectedRuntime(workerLauncherDigest),
      trustedSource: { kind: 'snapshot' as const, snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40),
        materialDigest: workerLauncherDigest, buildRecipeDigest: launchPlanDigest },
      timeoutMs: 120_000, commandTimeoutMs: 60_000, vcpus: 2,
      allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'] as const, pathMatch: 'exact' as const }],
        artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'] as const, pathMatch: 'prefix' as const }] },
      artifacts: { maxFiles: 1, maxFileBytes: 1_024, maxTotalBytes: 1_024 },
    };
    const plan: WorkerLaunchPlan = {
      format: 'motive.worker-launch/0.1', workOrderId: seed.attempt.workOrderId, termsDigest: seed.attempt.termsDigest,
      inputDigest: seed.attempt.inputDigest, inferenceProfileDigest: seed.attempt.profileDigest, actorId: seed.actorId,
      infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1.000000000000', capabilityTtlSeconds: 120,
      command: { executable: '/usr/local/bin/codex', args: ['exec', 'close before native freeze'] }, sandbox,
      nativeCollection: {
        collectorRuntimeDigest: launchPlanDigest, maximumFileBytes: 1_024, maximumTotalBytes: 1_024,
        approvedPaths: [{ relativePath: 'result.bin', mediaType: 'application/octet-stream', availability: 'REQUIRED', maximumBytes: 1_024 }],
      },
    };
    const ownerId = `native-close:${randomUUID()}`;
    let providerCalls = 0;
    let readyCalls = 0;
    const forbiddenProvider = async (): Promise<never> => {
      providerCalls += 1;
      throw new Error('native CREATE must not reach the provider after authority closure');
    };
    const coordinator = new DurableWorkerCoordinator({
      store, ledger, ownerId, resolvePlan: async () => plan,
      adapter: () => ({
        create: forbiddenProvider, observe: forbiddenProvider, discoverOwned: forbiddenProvider,
        startCommand: forbiddenProvider, observeCommand: forbiddenProvider, stop: forbiddenProvider,
      }),
      orphanProvider: { discover: async () => ({ sandboxes: [], complete: true }), stopOwned: forbiddenProvider },
      artifacts: {
        async assertReady() {
          readyCalls += 1;
          // The first readiness check occurs before reserve. The second is the
          // exact gap between reserve/readiness and plan freeze.
          if (readyCalls !== 2) return;
          if (mode === 'CANCEL') {
            await ledger.requestAttemptCancellation({
              actorId: seed.actorId, idempotencyKey: randomUUID(), attemptId: seed.attempt.id, reason: 'cancel between ready and native freeze',
            });
          } else {
            await ledger.setControllerSpending({
              actorId: 'native-collection-coordinator-test', idempotencyKey: randomUUID(), enabled: false,
              reason: 'freeze between ready and native freeze',
            });
          }
        },
        async seal() { throw new Error('authority closure must prevent worker execution'); },
      },
    });
    cleanups.push(async () => {
      const lease = await store.acquireLease(seed.attempt.id, ownerId, 60);
      const execution = await store.getExecution(seed.attempt.id);
      for (const environment of execution?.environments ?? []) {
        if (environment.state === 'RESERVED' && !environment.externalId) {
          await store.abandonReservedEnvironment(lease, environment.id);
        } else if (!['TERMINATED', 'ABANDONED'].includes(environment.state) && environment.externalId) {
          await store.recordObservation(lease, environment.id, {
            providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
          });
        }
      }
    });

    await expect(coordinator.reconcileAttempt(seed.attempt.id)).resolves.toMatchObject({ status: 'TERMINATED' });
    expect(readyCalls).toBe(2);
    expect(providerCalls).toBe(0);
    const execution = await store.getExecution(seed.attempt.id);
    expect(execution?.environments).toMatchObject([{ state: 'ABANDONED' }]);
    const [plans, capacity] = await Promise.all([
      pool.query('SELECT count(*)::integer AS count FROM motive.native_collection_plans WHERE attempt_id = $1', [seed.attempt.id]),
      pool.query('SELECT occupied_count FROM motive.orchestration_capacity WHERE singleton = TRUE'),
    ]);
    expect(plans.rows).toEqual([{ count: 0 }]);
    expect(capacity.rows).toEqual([{ occupied_count: 0 }]);
  }

  it('abandons the unclaimed CREATE when cancellation lands between readiness and native plan freeze', async () => {
    await assertAuthorityClosureDuringNativeFreeze('CANCEL');
  });

  it('abandons the unclaimed CREATE when control freezes between readiness and native plan freeze', async () => {
    await assertAuthorityClosureDuringNativeFreeze('FREEZE');
  });

  it.each([false, true])('freezes before CREATE, captures once and supports coordinator sealing (seal=%s)', async sealWithCoordinator => {
    const seed = await seedGatewayAttempt(ledger, localGatewayProfile('http://127.0.0.1:1/responses'));
    const authorization = await store.createInfrastructureAuthorization({
      id: randomUUID(), sourceAccountId: seed.source.id, sourceAccountRef: `synthetic:native-coordinator:${seed.source.id}`,
      actorId: seed.actorId, limitUsd: '2.000000000000', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const sandbox = {
      format: 'motive.sandbox-profile/0.1' as const, profileDigest,
      protectedRuntime: defineProtectedRuntime(workerLauncherDigest),
      trustedSource: { kind: 'snapshot' as const, snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40),
        materialDigest: workerLauncherDigest, buildRecipeDigest: launchPlanDigest },
      timeoutMs: 120_000, commandTimeoutMs: 60_000, vcpus: 2,
      allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'] as const, pathMatch: 'exact' as const }],
        artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'] as const, pathMatch: 'prefix' as const }] },
      artifacts: { maxFiles: 1, maxFileBytes: 1_024, maxTotalBytes: 1_024 },
    };
    const reviewedRuntime = defineReviewedVercelNativeArtifactRuntime({
      format: 'motive.vercel-native-artifact-runtime/0.1', profileDigest: sandbox.profileDigest, source: sandbox.trustedSource,
      workerRuntimeDigest: sandbox.protectedRuntime.runtimeDigest, workerLauncherDigest,
      collectorPath: '/opt/motive/bin/artifact-collector', collectorDigest: launchPlanDigest,
      collectorLauncherPath: '/opt/motive/bin/artifact-collector-launcher', collectorLauncherDigest: launchPlanDigest,
      bootstrapPath: '/var/lib/motive/control/worker-bootstrap.json', collectorUid: 1000, workerUid: 2000,
    });
    const plan: WorkerLaunchPlan = {
      format: 'motive.worker-launch/0.1', workOrderId: seed.attempt.workOrderId, termsDigest: seed.attempt.termsDigest,
      inputDigest: seed.attempt.inputDigest, inferenceProfileDigest: seed.attempt.profileDigest, actorId: seed.actorId,
      infrastructureAuthorizationId: authorization.id, maximumCostUsd: '1.000000000000', capabilityTtlSeconds: 120,
      command: { executable: '/usr/local/bin/codex', args: ['exec', 'native collection fixture'] }, sandbox,
      nativeCollection: {
        collectorRuntimeDigest: reviewedRuntime.runtimeDigest, maximumFileBytes: 1_024, maximumTotalBytes: 1_024,
        approvedPaths: [{ relativePath: 'result.bin', mediaType: 'application/octet-stream', availability: 'REQUIRED', maximumBytes: sealWithCoordinator ? 512 : 1_024 }],
      },
    };
    const ownerId = `native-coordinator:${randomUUID()}`;
    const preLease = await store.acquireLease(seed.attempt.id, ownerId, 120);
    const reserved = await store.reserveEnvironment(preLease, {
      kind: 'WORKER', profileDigest: sandbox.profileDigest, profileSnapshot: sandbox,
      launchPlanDigest: launchDigest(plan), infrastructureAuthorizationId: authorization.id, maximumCostUsd: plan.maximumCostUsd,
    });

    const providerCalls: string[] = [];
    let remote: SdkSandbox | null = null;
    const sdk: SandboxSdkFactory = {
      async create(input) {
        providerCalls.push('create');
        const planRow = await pool.query(`SELECT collection_plan_digest, collector_runtime_digest
          FROM motive.native_collection_plans WHERE environment_id = $1`, [reserved.environment.id]);
        const createRow = await pool.query(`SELECT state FROM motive.orchestration_effects WHERE id = $1`, [reserved.effect.effectId]);
        expect(planRow.rows).toEqual([{ collection_plan_digest: expect.stringMatching(/^sha256:/), collector_runtime_digest: reviewedRuntime.runtimeDigest }]);
        expect(createRow.rows).toEqual([{ state: 'CLAIMED' }]);
        remote = {
          name: input.name, sessionId: `session_${randomUUID().replaceAll('-', '')}`, persistent: false, status: 'running',
          sourceSnapshotId: 'snap_MotiveTrusted01', tags: { ...input.tags },
          async startCommand() { providerCalls.push('worker-command'); return { cmdId: 'worker_command_1', exitCode: null }; },
          async getCommand() { return { cmdId: 'worker_command_1', exitCode: sealWithCoordinator ? 0 : null }; },
          async stop() { providerCalls.push('stop'); remote!.status = 'stopped'; return { status: 'stopped' }; },
        };
        return remote;
      },
      async get(input) {
        if (!remote || input.resume !== false || input.name !== remote.name) throw new Error('unexpected exact sandbox lookup');
        return remote;
      },
      async listOwned() { return { sandboxes: remote ? [remote] : [], complete: true }; },
    };
    const adapter = new VercelSandboxAdapter(sandbox, sdk, { effects: 'durable-controller' });
    let collectionTransport: VercelNativeArtifactTransport | null = null;
    const objects = new Map<string, Uint8Array>();
    const objectStore: ImmutableObjectStore = {
      async putIfAbsent(input) {
        if (objects.has(input.objectKey)) return { status: 'EXISTS', objectId: input.objectKey };
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.body) chunks.push(Uint8Array.from(chunk));
        objects.set(input.objectKey, Buffer.concat(chunks));
        return { status: 'CREATED', objectId: input.objectKey };
      },
      async readObject(input) {
        const bytes = objects.get(input.objectKey); if (!bytes) return null;
        return { declaredBytes: bytes.byteLength, body: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += input.maximumChunkBytes) yield bytes.slice(offset, offset + input.maximumChunkBytes);
        })() };
      },
    };
    const collector = createClaimedNativeArtifactCollector({ store, objectStore,
      runtimeRegistry: new StaticReviewedVercelNativeArtifactRuntimeRegistry([reviewedRuntime]), activation: 'local-test',
      transport: { getExactSession(input) {
        if (!collectionTransport) throw new Error('No provider calls are allowed during collector preflight.');
        return collectionTransport.getExactSession(input);
      } },
    });
    const coordinator = new DurableWorkerCoordinator({
      store, ledger, ownerId, resolvePlan: async () => plan, adapter: () => adapter,
      orphanProvider: new VercelOrphanProvider(sdk, 'durable-controller'),
      artifacts: {
        assertReady: value => collector.assertReady(value),
        async seal(input) {
          if (!sealWithCoordinator) throw new Error('this joined test leaves the worker command running');
          providerCalls.push('seal');
          expect(input.lease.attemptId).toBe(seed.attempt.id);
          return collector.seal(input);
        },
      },
    });
    cleanups.push(async () => {
      const lease = await store.acquireLease(seed.attempt.id, ownerId, 60);
      const execution = await store.getExecution(seed.attempt.id);
      for (const environment of execution?.environments ?? []) {
        if (environment.state === 'TERMINATED' || environment.state === 'ABANDONED') continue;
        if (!environment.externalId) {
          const create = execution?.effects.find(effect => effect.environmentId === environment.id && effect.kind === 'CREATE');
          if (create?.state === 'INTENT_RECORDED') await store.abandonReservedEnvironment(lease, environment.id);
          continue;
        }
        if (remote) await remote.stop();
        await store.recordObservation(lease, environment.id, {
          providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
        });
      }
    });

    // The reservation was persisted before a simulated coordinator restart.
    // Reconciliation must freeze the plan before it claims CREATE or issues a provider call.
    await coordinator.reconcileAttempt(seed.attempt.id);
    expect(providerCalls).toEqual(['create']);
    await coordinator.reconcileAttempt(seed.attempt.id);
    expect(providerCalls).toEqual(['create', 'worker-command']);

    const lease = await store.acquireLease(seed.attempt.id, ownerId, 60);
    const execution = await store.getExecution(seed.attempt.id);
    const environment = execution?.environments.find(item => item.id === reserved.environment.id);
    if (!environment?.externalId || !environment.sessionId || environment.leaseEpoch === null || !environment.profileDigest) {
      throw new Error('coordinator did not persist the exact worker handle');
    }
    const handle = {
      provider: 'vercel' as const, attemptId: seed.attempt.id, sandboxId: environment.externalId,
      sessionId: environment.sessionId, leaseEpoch: environment.leaseEpoch, profileDigest: environment.profileDigest,
    };
    const frozen = await store.getNativeCollectionPlan(lease, environment.id);
    expect(frozen).toMatchObject({ collectorRuntimeDigest: reviewedRuntime.runtimeDigest,
      paths: [{ relativePath: 'result.bin', maximumBytes: sealWithCoordinator ? 512 : 1_024 }] });

    const helperCalls: string[] = [];
    const transport: VercelNativeArtifactTransport = {
      async getExactSession(input) {
        expect(input).toMatchObject({ name: handle.sandboxId, resume: false });
        return {
          sandboxId: handle.sandboxId, sessionId: handle.sessionId, persistent: false, status: remote!.status, sourceSnapshotId: 'snap_MotiveTrusted01',
          async runCommand(command) {
            const kind = command.args[0] === '--bootstrap' ? 'BOOTSTRAP' : 'CAPTURE';
            if (kind === 'CAPTURE') expect(command.args[2]).toBe(sealWithCoordinator ? '512' : '1024');
            const effects = await store.listNativeCollectionEffects(lease, environment.id);
            expect(effects.find(effect => effect.kind === kind)?.state).toBe('CLAIMED');
            helperCalls.push(kind);
            const commandId = kind === 'BOOTSTRAP' ? 'native_bootstrap_1' : 'native_capture_1';
            const stdout = kind === 'BOOTSTRAP'
              ? 'MOTIVE_COLLECTOR_BOOTSTRAP_V1\n1:2:3\n'
              : 'MOTIVE_ARTIFACT_ASCII_V1\n1:2:3:4\nAP8K\n';
            return {
              commandId,
              async wait() {
                const effect = effects.find(item => item.kind === kind);
                if (!effect) throw new Error('helper effect disappeared');
                const started = await store.getNativeCollectionEffect(lease, effect.effectId);
                expect(started).toMatchObject({ state: 'START_RECORDED', providerCommandId: commandId });
                return { exitCode: 0 };
              },
              async *logs() { yield { stream: 'stdout' as const, data: stdout }; },
            };
          },
        };
      },
    };
    collectionTransport = transport;
    const readerOptions = {
      profile: sandbox, runtimeRegistry: new StaticReviewedVercelNativeArtifactRuntimeRegistry([reviewedRuntime]),
      context: { lease, environmentId: environment.id, handle }, store, transport, activation: 'local-test' as const,
    };
    if (sealWithCoordinator) {
      const failedCommit = vi.spyOn(store, 'recordArtifactSeal').mockRejectedValueOnce(new Error('simulated receipt commit disconnect'));
      try {
        await expect(coordinator.reconcileAttempt(seed.attempt.id)).rejects.toThrow('simulated receipt commit disconnect');
      } finally { failedCommit.mockRestore(); }
      expect(providerCalls).toEqual(['create', 'worker-command', 'seal']);
      expect(helperCalls).toEqual(['BOOTSTRAP', 'CAPTURE']);
      expect((await store.getExecution(seed.attempt.id))?.artifactSeal).toBeNull();
      expect([...objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(true);
      // A new reconciliation recovers the already committed manifest. The two
      // helper effects are completed and cannot be dispatched again.
      await expect(coordinator.reconcileAttempt(seed.attempt.id)).resolves.toMatchObject({ status: 'SEALED' });
      expect(providerCalls).toEqual(['create', 'worker-command', 'seal', 'seal', 'stop']);
      const completed = await store.getExecution(seed.attempt.id);
      expect(completed?.artifactSeal?.status).toBe('SEALED');
      expect(completed?.environments[0].state).toBe('TERMINATED');
      const manifestBytes = [...objects.entries()].find(([key]) => key.endsWith('/manifest.json'))?.[1];
      expect(manifestBytes).toBeDefined();
      const manifest = JSON.parse(Buffer.from(manifestBytes!).toString('utf8'));
      expect(manifest.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });
      expect(manifest.controller_observed_outcome).toMatchObject({ kind: 'COMMAND_EXITED', exitCode: 0 });
      expect(manifest.files).toMatchObject([{ relative_path: 'result.bin', bytes: 3 }]);
      expect(objects.get(manifest.files[0].object_key)).toEqual(Buffer.from([0, 255, 10]));
      await expect(coordinator.reconcileAttempt(seed.attempt.id)).resolves.toMatchObject({ status: 'SEALED' });
      expect(providerCalls).toEqual(['create', 'worker-command', 'seal', 'seal', 'stop']);
    } else {
      const snapshot = await new ClaimedVercelNativeArtifactReader(readerOptions).capture({
        handle, relativePath: 'result.bin', maximumBytes: 1_024, maximumChunkBytes: 1_024, signal: new AbortController().signal,
      });
      expect(snapshot?.declaredBytes).toBe(3);
      const bytes: Uint8Array[] = [];
      for await (const chunk of snapshot!.read()) bytes.push(chunk);
      expect(Buffer.concat(bytes)).toEqual(Buffer.from([0, 255, 10]));
    }
    expect(helperCalls).toEqual(['BOOTSTRAP', 'CAPTURE']);
    expect((await store.listNativeCollectionEffects(lease, environment.id)).map(effect => ({ kind: effect.kind, state: effect.state, providerCommandId: effect.providerCommandId })))
      .toEqual([
        { kind: 'BOOTSTRAP', state: 'COMPLETED', providerCommandId: 'native_bootstrap_1' },
        { kind: 'CAPTURE', state: 'COMPLETED', providerCommandId: 'native_capture_1' },
      ]);
    if (!sealWithCoordinator) {
      await expect(new ClaimedVercelNativeArtifactReader(readerOptions).capture({
        handle, relativePath: 'result.bin', maximumBytes: 1_024, maximumChunkBytes: 1_024, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'VERCEL_NATIVE_COLLECTION_ALREADY_CLAIMED' });
    }
    expect(helperCalls).toEqual(['BOOTSTRAP', 'CAPTURE']);
  });
});
