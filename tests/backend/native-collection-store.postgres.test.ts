import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { sandboxName } from '../../packages/sandbox-vercel/src/policy.ts';
import type { SandboxExecutionProfile } from '../../packages/sandbox-vercel/src/types.ts';
import type {
  ControllerLease,
  FreezeNativeCollectionPlanInput,
  NativeCollectionCompletionInput,
  NativeCollectionEffectProjection,
  ReserveEnvironmentInput,
} from '../../packages/orchestration/src/store-types.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../scripts/lib/gateway-fixture.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = databaseUrl ? describe : describe.skip;
const workerLauncherDigest = `sha256:${'1'.repeat(64)}` as const;
const workerProfileDigest = `sha256:${'2'.repeat(64)}` as const;
const collectorRuntimeDigest = `sha256:${'3'.repeat(64)}` as const;
const launchPlanDigest = `sha256:${'4'.repeat(64)}` as const;
const commandDigest = `sha256:${'5'.repeat(64)}` as const;
const controllerActor = 'native-collection-store-test-controller';

type Fixture = {
  seed: Awaited<ReturnType<typeof seedGatewayAttempt>>;
  authorizationId: string;
  lease: ControllerLease;
  environmentId: string;
  createEffectId: string;
  handle: { provider: string; externalId: string; sessionId: string } | null;
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function workerProfile(): SandboxExecutionProfile {
  return {
    format: 'motive.sandbox-profile/0.1',
    profileDigest: workerProfileDigest,
    protectedRuntime: defineProtectedRuntime(workerLauncherDigest),
    trustedSource: {
      kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', sourceCommit: 'a'.repeat(40),
      materialDigest: workerLauncherDigest, buildRecipeDigest: collectorRuntimeDigest,
    },
    timeoutMs: 120_000, commandTimeoutMs: 60_000, vcpus: 2,
    allowedExecutables: ['/usr/local/bin/codex'],
    egress: {
      gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
      artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }],
    },
    artifacts: { maxFiles: 4, maxFileBytes: 1_024, maxTotalBytes: 2_048 },
  };
}

function collectionPlan(paths = [{ relativePath: 'result.txt', mediaType: 'text/plain', availability: 'REQUIRED' as const, maximumBytes: 1_024 }]): FreezeNativeCollectionPlanInput {
  return {
    collectorRuntimeDigest,
    maximumFileBytes: 1_024,
    maximumTotalBytes: 2_048,
    approvedPaths: paths,
  };
}

pgDescribe('PostgreSQL durable native collection effects', () => {
  let pool: Pool;
  let ledger: LedgerKernel;
  let store: PostgresOrchestrationStore;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    const status = await getPostgresSchemaStatus(pool);
    if (!status.exact) throw new Error(`Native collection test schema is not exact: ${status.problems.join(' ')}`);
    ledger = new LedgerKernel(pool);
    store = new PostgresOrchestrationStore(pool);
  });

  beforeEach(async () => {
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true,
      reason: 'native collection PostgreSQL test setup',
    });
  });

  afterEach(async () => {
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true,
      reason: 'native collection PostgreSQL test cleanup',
    });
    for (const fixture of fixtures.splice(0)) {
      const lease = await store.acquireLease(fixture.seed.attempt.id, fixture.lease.ownerId, 60);
      fixture.lease = lease;
      const execution = await store.getExecution(fixture.seed.attempt.id);
      for (const environment of execution?.environments ?? []) {
        if (environment.state === 'TERMINATED' || environment.state === 'ABANDONED') continue;
        if (!environment.externalId) {
          const create = execution?.effects.find(effect => effect.environmentId === environment.id && effect.kind === 'CREATE');
          if (create?.state === 'INTENT_RECORDED') {
            await store.abandonReservedEnvironment(lease, environment.id);
            continue;
          }
          throw new Error(`Fixture ${fixture.seed.attempt.id} left a claimed create without a provider handle.`);
        }
        await store.recordObservation(lease, environment.id, {
          providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
        });
      }
    }
  });

  afterAll(async () => {
    try {
      await ledger?.setControllerSpending({
        actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false,
        reason: 'native collection PostgreSQL tests complete',
      });
    } finally {
      await pool?.end();
    }
  });

  async function reserve(): Promise<Fixture> {
    const seed = await seedGatewayAttempt(ledger, localGatewayProfile('http://127.0.0.1:1/responses'));
    const authorizationId = randomUUID();
    await store.createInfrastructureAuthorization({
      id: authorizationId, sourceAccountId: seed.source.id, sourceAccountRef: `synthetic:native:${seed.source.id}`,
      actorId: seed.actorId, limitUsd: '2.000000000000', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const lease = await store.acquireLease(seed.attempt.id, `native-collection:${randomUUID()}`, 300);
    const reservation: ReserveEnvironmentInput = {
      kind: 'WORKER', profileDigest: workerProfileDigest, profileSnapshot: workerProfile(), launchPlanDigest,
      infrastructureAuthorizationId: authorizationId, maximumCostUsd: '1.000000000000',
    };
    const planned = await store.reserveEnvironment(lease, reservation);
    const fixture: Fixture = {
      seed, authorizationId, lease, environmentId: planned.environment.id, createEffectId: planned.effect.effectId, handle: null,
    };
    fixtures.push(fixture);
    return fixture;
  }

  async function activateWithClaimedWorkerCommand(fixture: Fixture): Promise<void> {
    await expect(store.claimEffect(fixture.lease, fixture.createEffectId)).resolves.toMatchObject({ claimed: true });
    const handle = {
      provider: 'vercel', externalId: sandboxName(fixture.seed.attempt.id, fixture.lease.epoch),
      sessionId: `session_${randomUUID().replaceAll('-', '')}`,
    };
    fixture.handle = handle;
    await store.recordCreateResult(fixture.lease, fixture.createEffectId, handle);
    await store.recordObservation(fixture.lease, fixture.environmentId, {
      providerStatus: 'running', state: 'ACTIVE', providerTerminal: false,
    });
    const command = await store.planCommand(fixture.lease, fixture.environmentId, { commandDigest });
    await expect(store.claimEffect(fixture.lease, command.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await store.recordCommandResult(fixture.lease, command.effect.effectId, { providerCommandId: `worker-${randomUUID()}` });
  }

  function bindingInput(fixture: Fixture, workspaceIdentity = '12:34:56') {
    if (fixture.handle === null) throw new Error('A binding requires an active fixture handle.');
    const frame = `MOTIVE_COLLECTOR_BOOTSTRAP_V1\n${workspaceIdentity}\n`;
    return {
      exitCode: 0,
      stdoutDigest: sha256(frame),
      stdoutBytes: Buffer.byteLength(frame, 'utf8'),
      binding: {
        format: 'motive.vercel-native-workspace-binding/0.1' as const,
        runtimeDigest: collectorRuntimeDigest,
        workspaceIdentity,
        handle: {
          provider: 'vercel' as const, attemptId: fixture.seed.attempt.id, sandboxId: fixture.handle.externalId,
          sessionId: fixture.handle.sessionId, leaseEpoch: fixture.lease.epoch, profileDigest: workerProfileDigest,
        },
      },
    };
  }

  async function bootstrap(fixture: Fixture): Promise<NativeCollectionEffectProjection> {
    const intent = await store.planNativeBootstrap(fixture.lease, fixture.environmentId);
    await expect(store.claimNativeCollectionEffect(fixture.lease, intent.effect.effectId)).resolves.toEqual({ effectId: intent.effect.effectId, claimed: true });
    await store.recordNativeCollectionStarted(fixture.lease, intent.effect.effectId, { providerCommandId: `bootstrap-${randomUUID()}` });
    await store.recordNativeBootstrapBinding(fixture.lease, intent.effect.effectId, bindingInput(fixture));
    return store.getNativeCollectionEffect(fixture.lease, intent.effect.effectId);
  }

  it('freezes a bounded native collection plan before CREATE and rejects later or oversized plans', async () => {
    const fixture = await reserve();
    await expect(store.freezeNativeCollectionPlan(fixture.lease, fixture.environmentId, {
      ...collectionPlan(), maximumFileBytes: 8 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    const plan = await store.freezeNativeCollectionPlan(fixture.lease, fixture.environmentId, collectionPlan());
    expect(plan).toMatchObject({
      environmentId: fixture.environmentId, maximumFileBytes: 1_024, maximumTotalBytes: 2_048,
      maximumHelperCommands: 2,
      paths: [{ relativePath: 'result.txt', maximumBytes: 1_024 }],
    });
    await expect(store.claimEffect(fixture.lease, fixture.createEffectId)).resolves.toMatchObject({ claimed: true });
    fixture.handle = {
      provider: 'vercel', externalId: sandboxName(fixture.seed.attempt.id, fixture.lease.epoch), sessionId: `session_${randomUUID().replaceAll('-', '')}`,
    };
    await store.recordCreateResult(fixture.lease, fixture.createEffectId, fixture.handle);
    await store.recordObservation(fixture.lease, fixture.environmentId, {
      providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
    });

    const dispatched = await reserve();
    await expect(store.claimEffect(dispatched.lease, dispatched.createEffectId)).resolves.toMatchObject({ claimed: true });
    dispatched.handle = {
      provider: 'vercel', externalId: sandboxName(dispatched.seed.attempt.id, dispatched.lease.epoch),
      sessionId: `session_${randomUUID().replaceAll('-', '')}`,
    };
    await store.recordCreateResult(dispatched.lease, dispatched.createEffectId, dispatched.handle);
    await expect(store.freezeNativeCollectionPlan(dispatched.lease, dispatched.environmentId, collectionPlan()))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });
  });

  it('records one bootstrap claim, atomically binds its canonical report, and binds captures to that provenance', async () => {
    const fixture = await reserve();
    await store.freezeNativeCollectionPlan(fixture.lease, fixture.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(fixture);

    const bootstrapIntent = await store.planNativeBootstrap(fixture.lease, fixture.environmentId);
    const claims = await Promise.all([
      store.claimNativeCollectionEffect(fixture.lease, bootstrapIntent.effect.effectId),
      store.claimNativeCollectionEffect(fixture.lease, bootstrapIntent.effect.effectId),
    ]);
    expect(claims.map(claim => claim.claimed).sort()).toEqual([false, true]);
    await store.recordNativeCollectionStarted(fixture.lease, bootstrapIntent.effect.effectId, { providerCommandId: `bootstrap-${randomUUID()}` });
    const wrong = { ...bindingInput(fixture), stdoutDigest: `sha256:${'f'.repeat(64)}` as `sha256:${string}` };
    await expect(store.recordNativeBootstrapBinding(fixture.lease, bootstrapIntent.effect.effectId, wrong)).rejects.toMatchObject({ code: 'VALIDATION' });
    const persistedBinding = await store.recordNativeBootstrapBinding(fixture.lease, bootstrapIntent.effect.effectId, bindingInput(fixture));
    expect(persistedBinding.binding.workspaceIdentity).toBe('12:34:56');
    expect((await store.getNativeCollectionEffect(fixture.lease, bootstrapIntent.effect.effectId))).toMatchObject({ state: 'COMPLETED', exitCode: 0 });

    await expect(store.planNativeCapture(fixture.lease, fixture.environmentId, { relativePath: 'not-approved.txt' }))
      .rejects.toMatchObject({ code: 'EFFECT_UNAVAILABLE' });
    const captureIntent = await store.planNativeCapture(fixture.lease, fixture.environmentId, { relativePath: 'result.txt' });
    expect(captureIntent.effect).toMatchObject({
      kind: 'CAPTURE', bootstrapEffectId: bootstrapIntent.effect.effectId, workspaceIdentity: '12:34:56', maximumBytes: 1_024,
    });
    await expect(store.claimNativeCollectionEffect(fixture.lease, captureIntent.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await store.recordNativeCollectionStarted(fixture.lease, captureIntent.effect.effectId, { providerCommandId: `capture-${randomUUID()}` });
    const malformedNull = { exitCode: null, stdoutDigest: collectorRuntimeDigest, stdoutBytes: 0 } as unknown as NativeCollectionCompletionInput;
    const malformedString = { exitCode: '0', stdoutDigest: collectorRuntimeDigest, stdoutBytes: 0 } as unknown as NativeCollectionCompletionInput;
    await expect(store.recordNativeCollectionCompleted(fixture.lease, captureIntent.effect.effectId, malformedNull)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(store.recordNativeCollectionCompleted(fixture.lease, captureIntent.effect.effectId, malformedString)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(store.recordNativeCollectionCompleted(fixture.lease, captureIntent.effect.effectId, {
      exitCode: 0, stdoutDigest: collectorRuntimeDigest, stdoutBytes: 1_626,
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(store.recordNativeCollectionCompleted(fixture.lease, captureIntent.effect.effectId, {
      exitCode: 0, stdoutDigest: collectorRuntimeDigest, stdoutBytes: 0,
    })).resolves.toMatchObject({ state: 'COMPLETED', exitCode: 0 });
    await expect(store.planNativeCapture(fixture.lease, fixture.environmentId, { relativePath: 'result.txt' }))
      .resolves.toMatchObject({ effect: { effectId: captureIntent.effect.effectId, state: 'COMPLETED' } });
  });

  it('does not treat a legacy local workspace observation as helper dispatch provenance', async () => {
    const fixture = await reserve();
    await store.freezeNativeCollectionPlan(fixture.lease, fixture.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(fixture);
    const local = bindingInput(fixture).binding;
    await store.recordWorkerWorkspaceBinding(fixture.lease, fixture.environmentId, {
      workerRuntimeDigest: workerProfile().protectedRuntime!.runtimeDigest,
      binding: local,
    });
    await expect(store.planNativeCapture(fixture.lease, fixture.environmentId, { relativePath: 'result.txt' }))
      .rejects.toMatchObject({ code: 'EFFECT_UNAVAILABLE' });
  });

  it('does not redispatch an unknown helper effect', async () => {
    const fixture = await reserve();
    await store.freezeNativeCollectionPlan(fixture.lease, fixture.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(fixture);
    const intent = await store.planNativeBootstrap(fixture.lease, fixture.environmentId);
    await expect(store.claimNativeCollectionEffect(fixture.lease, intent.effect.effectId)).resolves.toMatchObject({ claimed: true });
    await store.markNativeCollectionUnknown(fixture.lease, intent.effect.effectId, 'provider response lost');
    await expect(store.claimNativeCollectionEffect(fixture.lease, intent.effect.effectId)).resolves.toEqual({ effectId: intent.effect.effectId, claimed: false });
    await expect(store.planNativeBootstrap(fixture.lease, fixture.environmentId))
      .resolves.toMatchObject({ effect: { effectId: intent.effect.effectId, state: 'UNKNOWN' } });
  });

  it('fails closed for cancellation, frozen control, and a stale worker lease', async () => {
    const cancelled = await reserve();
    await store.freezeNativeCollectionPlan(cancelled.lease, cancelled.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(cancelled);
    const cancelledIntent = await store.planNativeBootstrap(cancelled.lease, cancelled.environmentId);
    await ledger.requestAttemptCancellation({
      actorId: cancelled.seed.actorId, idempotencyKey: randomUUID(), attemptId: cancelled.seed.attempt.id, reason: 'test cancellation',
    });
    await expect(store.claimNativeCollectionEffect(cancelled.lease, cancelledIntent.effect.effectId))
      .rejects.toMatchObject({ code: 'ATTEMPT_UNAVAILABLE' });

    // Clean the first worker before reserving a second one; physical capacity is global and deliberately two.
    await store.recordObservation(cancelled.lease, cancelled.environmentId, {
      providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
    });

    const frozen = await reserve();
    await store.freezeNativeCollectionPlan(frozen.lease, frozen.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(frozen);
    const frozenIntent = await store.planNativeBootstrap(frozen.lease, frozen.environmentId);
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: false, reason: 'test durable helper freeze',
    });
    await expect(store.claimNativeCollectionEffect(frozen.lease, frozenIntent.effect.effectId))
      .rejects.toMatchObject({ code: 'CONTROLLER_FROZEN' });
    await ledger.setControllerSpending({
      actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true, reason: 'resume test cleanup',
    });
    await store.recordObservation(frozen.lease, frozen.environmentId, {
      providerStatus: 'stopped', state: 'TERMINATED', providerTerminal: true,
    });

    const stale = await reserve();
    await store.freezeNativeCollectionPlan(stale.lease, stale.environmentId, collectionPlan());
    await activateWithClaimedWorkerCommand(stale);
    const staleIntent = await store.planNativeBootstrap(stale.lease, stale.environmentId);
    await pool.query(`UPDATE motive.orchestration_leases
      SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE attempt_id = $1`, [stale.seed.attempt.id]);
    const recovered = await store.acquireLease(stale.seed.attempt.id, `takeover:${randomUUID()}`, 300);
    await expect(store.claimNativeCollectionEffect(stale.lease, staleIntent.effect.effectId))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });
    await expect(store.claimNativeCollectionEffect(recovered, staleIntent.effect.effectId))
      .rejects.toMatchObject({ code: 'LEASE_FENCED' });
    stale.lease = recovered;
  });
});

