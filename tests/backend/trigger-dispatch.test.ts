import { describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_RECONCILE_TASK_ID,
  ATTEMPT_WAKE_TOPICS,
  TriggerOutboxDispatcher,
  createTriggerSdkTaskClient,
  getAttemptTaskRuntime,
  resetAttemptTaskRuntimeForTests,
  runAttemptReconciliation,
  runOrphanReconciliation,
  type FencedOutboxClaim,
  type FencedOutboxStore,
  type WorkerCoordinator,
} from '../../packages/dispatcher-trigger/src/index.ts';
import {
  attemptReconciliationQueue,
  attemptReconcileTask,
  outboxDeliveryQueue,
  outboxDeliveryTask,
  orphanReconciliationQueue,
  orphanReconcileTask,
} from '../../trigger/reconciliation.ts';
import type { OrchestrationStore } from '../../packages/orchestration/src/store-types.ts';
import type { DurableWorkerCoordinator } from '../../packages/orchestration/src/coordinator.ts';

const ATTEMPT_ID = '6c0c6ca4-4a88-4db0-a187-59dd48c61b02';
const OUTBOX_ID = '5ac14552-72ec-42b9-98e0-af8a1e53f255';

// Compile-time proof that the concrete orchestration store can satisfy the
// dispatcher's deliberately smaller structural port.
const orchestrationStoreIsCompatible = (store: OrchestrationStore): FencedOutboxStore => store;
void orchestrationStoreIsCompatible;
const durableCoordinatorIsCompatible = (coordinator: DurableWorkerCoordinator): WorkerCoordinator => coordinator;
void durableCoordinatorIsCompatible;

function claim(overrides: Partial<FencedOutboxClaim['message']> = {}): FencedOutboxClaim {
  return {
    outboxId: OUTBOX_ID,
    claimToken: 'claim-token-1',
    message: {
      id: OUTBOX_ID,
      eventId: '20627958-62c4-41dc-bd51-f4d3c41b1e3f',
      aggregateType: 'attempt',
      aggregateId: ATTEMPT_ID,
      topic: 'attempt.reserved',
      dedupeKey: `attempt.reserved:${ATTEMPT_ID}`,
      payload: {
        attempt_id: ATTEMPT_ID,
        provider_url: 'https://worker-must-not-receive.example',
        secret_key: 'worker-must-not-receive',
      },
      deliveryAttempts: 1,
      ...overrides,
    },
  };
}

function fakeStore(claims: readonly FencedOutboxClaim[]) {
  const claimDeliveryBatch = vi.fn(async () => claims);
  const acknowledgeDelivery = vi.fn(async () => true);
  const deferDelivery = vi.fn(async () => true);
  const store: FencedOutboxStore = {
    claimDeliveryBatch,
    acknowledgeDelivery,
    deferDelivery,
  };
  return { store, claimDeliveryBatch, acknowledgeDelivery, deferDelivery };
}

describe('Trigger outbox dispatcher', () => {
  it('passes an atomic persisted-attempt scope to the fenced claim', async () => {
    const state = fakeStore([]);
    const attemptScope = { kind: 'PROJECT_LEAD_ACTIVATION' as const,
      projectSlug: 'circle-packing', beneficiaryActorId: 'operator:seed' };
    await new TriggerOutboxDispatcher(state.store, { triggerAttempt: async () => ({ id: 'unreachable' }) },
      { consumerId: 'circle-dispatch', attemptScope }).dispatchBatch();
    expect(state.claimDeliveryBatch).toHaveBeenCalledWith(expect.objectContaining({ attemptScope }));
  });

  it('claims only attempt wake topics and sends the strict attempt UUID payload', async () => {
    const state = fakeStore([claim()]);
    const triggerAttempt = vi.fn(async () => ({ id: 'run_accepted' }));
    const dispatcher = new TriggerOutboxDispatcher(state.store, { triggerAttempt }, {
      consumerId: 'dispatcher-1',
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({
      claimed: 1,
      accepted: 1,
      deferred: 0,
      leaseLost: 0,
    });
    expect(state.claimDeliveryBatch).toHaveBeenCalledWith(expect.objectContaining({
      topics: ATTEMPT_WAKE_TOPICS,
    }));
    expect(triggerAttempt).toHaveBeenCalledWith(
      { attemptId: ATTEMPT_ID },
      expect.objectContaining({
        idempotencyKey: `motive-outbox:${OUTBOX_ID}`,
        idempotencyKeyTTL: '30d',
      }),
    );
    expect(JSON.stringify(triggerAttempt.mock.calls[0])).not.toContain('provider_url');
    expect(JSON.stringify(triggerAttempt.mock.calls[0])).not.toContain('secret_key');
    expect(state.acknowledgeDelivery).toHaveBeenCalledWith({
      outboxId: OUTBOX_ID,
      claimToken: 'claim-token-1',
      triggerRunId: 'run_accepted',
    });
  });

  it('defers an ambiguous trigger result and never acknowledges it', async () => {
    const state = fakeStore([claim()]);
    const dispatcher = new TriggerOutboxDispatcher(state.store, {
      triggerAttempt: async () => { throw new Error('response lost after send'); },
    }, {
      consumerId: 'dispatcher-1',
      retryMs: 45_000,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({
      claimed: 1,
      accepted: 0,
      deferred: 1,
      leaseLost: 0,
    });
    expect(state.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(state.deferDelivery).toHaveBeenCalledWith({
      outboxId: OUTBOX_ID,
      claimToken: 'claim-token-1',
      retryAt: '2026-09-06T00:00:45.000Z',
      errorCode: 'TRIGGER_ACCEPTANCE_UNKNOWN',
    });
  });

  it('rejects an invalid or mismatched attempt identity before triggering', async () => {
    const state = fakeStore([claim({
      aggregateId: '489eac02-f80d-45bd-9ba8-8f3c2e2a66d4',
    })]);
    const triggerAttempt = vi.fn(async () => ({ id: 'run_should_not_exist' }));
    const dispatcher = new TriggerOutboxDispatcher(state.store, { triggerAttempt }, {
      consumerId: 'dispatcher-1',
    });

    await dispatcher.dispatchBatch();
    expect(triggerAttempt).not.toHaveBeenCalled();
    expect(state.deferDelivery).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'INVALID_OUTBOX_MESSAGE',
    }));
  });

  it('reports a lost fence when the accepted run cannot be acknowledged', async () => {
    const state = fakeStore([claim()]);
    state.acknowledgeDelivery.mockResolvedValue(false);
    const dispatcher = new TriggerOutboxDispatcher(state.store, {
      triggerAttempt: async () => ({ id: 'run_accepted' }),
    }, { consumerId: 'dispatcher-1' });

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({
      claimed: 1,
      accepted: 0,
      deferred: 0,
      leaseLost: 1,
    });
  });
});

describe('Trigger SDK control boundary', () => {
  it('registers both exported tasks with the installed Trigger SDK', () => {
    expect(attemptReconcileTask.id).toBe(ATTEMPT_RECONCILE_TASK_ID);
    expect(orphanReconcileTask.id).toBe('motive-orphan-reconcile');
    expect(outboxDeliveryTask.id).toBe('motive-circle-outbox-delivery');
    expect(attemptReconcileTask.trigger).toBeTypeOf('function');
    expect(orphanReconcileTask.trigger).toBeTypeOf('function');
    expect(attemptReconciliationQueue).toEqual(expect.objectContaining({
      name: 'motive-attempt-reconciliation',
      concurrencyLimit: 1,
    }));
    expect(orphanReconciliationQueue).toEqual(expect.objectContaining({
      name: 'motive-orphan-reconciliation',
      concurrencyLimit: 1,
    }));
    expect(orphanReconciliationQueue.name).not.toBe(attemptReconciliationQueue.name);
    expect(outboxDeliveryQueue).toEqual(expect.objectContaining({ name: 'motive-circle-outbox-delivery', concurrencyLimit: 1 }));
  });

  it('loads the actual Trigger config with an explicit supported runtime', async () => {
    vi.stubEnv('TRIGGER_PROJECT_REF', 'proj_local_config_smoke');
    try {
      const loaded = await import('../../trigger.config.ts');
      expect(loaded.default).toEqual(expect.objectContaining({
        project: 'proj_local_config_smoke',
        dirs: ['./trigger'],
        runtime: 'node-24',
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the pinned SDK call shape with one network attempt and no credentials', async () => {
    const network = vi.fn(async () => ({ id: 'run_sdk' }));
    const client = createTriggerSdkTaskClient(network);
    await expect(client.triggerAttempt(
      { attemptId: ATTEMPT_ID },
      {
        idempotencyKey: `motive-outbox:attempt.reserved:${ATTEMPT_ID}`,
        idempotencyKeyTTL: '30d',
        maxAttempts: 3,
        ttl: '10m',
        tags: [`attempt:${ATTEMPT_ID}`],
      },
    )).resolves.toEqual({ id: 'run_sdk' });

    expect(network).toHaveBeenCalledWith(
      ATTEMPT_RECONCILE_TASK_ID,
      { attemptId: ATTEMPT_ID },
      expect.objectContaining({ idempotencyKeyTTL: '30d' }),
      { retry: { maxAttempts: 1 } },
    );
  });
});

describe('Trigger reconciliation task functions', () => {
  it('reconciles the same attempt through bounded durable waits without spawning work', async () => {
    const reconcileAttempt = vi.fn()
      .mockResolvedValueOnce({ attemptId: ATTEMPT_ID, status: 'RUNNING' })
      .mockResolvedValueOnce({ attemptId: ATTEMPT_ID, status: 'STOPPING' })
      .mockResolvedValueOnce({ attemptId: ATTEMPT_ID, status: 'TERMINATED' });
    const waitFor = vi.fn(async () => undefined);
    const coordinator: WorkerCoordinator = {
      reconcileAttempt,
      reconcileOrphans: async () => ({}),
    };

    await expect(runAttemptReconciliation(
      { attemptId: ATTEMPT_ID },
      { coordinator, waitFor, waitSeconds: 10, maxPasses: 8 },
    )).resolves.toEqual({ attemptId: ATTEMPT_ID, status: 'TERMINATED', passes: 3 });
    expect(reconcileAttempt).toHaveBeenCalledTimes(3);
    expect(reconcileAttempt).toHaveBeenNthCalledWith(1, ATTEMPT_ID);
    expect(reconcileAttempt).toHaveBeenNthCalledWith(2, ATTEMPT_ID);
    expect(reconcileAttempt).toHaveBeenNthCalledWith(3, ATTEMPT_ID);
    expect(waitFor).toHaveBeenCalledTimes(2);
  });

  it('returns after the finite pass ceiling so the independent scan can recover it', async () => {
    const coordinator: WorkerCoordinator = {
      reconcileAttempt: async (attemptId) => ({ attemptId, status: 'RUNNING' }),
      reconcileOrphans: async () => ({}),
    };
    await expect(runAttemptReconciliation(
      { attemptId: ATTEMPT_ID },
      { coordinator, waitFor: async () => undefined, waitSeconds: 6, maxPasses: 2 },
    )).resolves.toEqual({ attemptId: ATTEMPT_ID, status: 'RUNNING', passes: 2 });
  });

  it('runs the independent orphan scan directly', async () => {
    const reconcileOrphans = vi.fn(async () => ({ inspected: 4 }));
    const coordinator: WorkerCoordinator = {
      reconcileAttempt: async (attemptId) => ({ attemptId, status: 'TERMINATED' }),
      reconcileOrphans,
    };
    await expect(runOrphanReconciliation({ coordinator }))
      .resolves.toEqual({ inspected: 4 });
    expect(reconcileOrphans).toHaveBeenCalledOnce();
  });

  it('fails closed while runtime bootstrap is unconfigured', () => {
    resetAttemptTaskRuntimeForTests();
    expect(() => getAttemptTaskRuntime()).toThrow(/unconfigured/i);
  });
});
