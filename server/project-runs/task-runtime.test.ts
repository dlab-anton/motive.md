import { describe, expect, it, vi } from 'vitest';
import {
  getAttemptTaskRuntime,
  resetAttemptTaskRuntimeForTests,
} from '../../packages/dispatcher-trigger/src/index.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { CircleProjectRunApplication } from './runtime.ts';
import {
  bootstrapCircleAttemptTaskRuntime,
  createCircleAttemptTaskRuntime,
  createCircleAttemptWakeDispatcher,
  dispatchCircleAttemptWakeBatchFromEnvironment,
} from './task-runtime.ts';

const attemptId = '11111111-1111-4111-8111-111111111111';

function application(): CircleProjectRunApplication {
  return {
    readiness: () => ({ ready: true, reasons: [], components: { database: true, runtimeBundle: true,
      vercelAdapter: true, exactSessionCircleCollector: true, immutableObjectStore: true, accountActivity: true } }),
    reconcileBudget: vi.fn(async () => { throw new Error('Budget identifiers must not enter the task boundary.'); }),
    reconcileAttempt: vi.fn(async id => ({ attemptId: id, status: 'REVIEW_READY' })),
    reconcileOrphans: vi.fn(async () => ({ status: 'COMPLETE', stopped: 1 })),
    close: vi.fn(async () => undefined),
  };
}

describe('circle Trigger task runtime', () => {
  it('opens lazily and forwards only the trusted attempt identity and orphan scan', async () => {
    const app = application(); const factory = vi.fn(async () => app);
    const runtime = createCircleAttemptTaskRuntime({ env: {}, applicationFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    await expect(runtime.coordinator.reconcileAttempt(attemptId)).resolves.toEqual({ attemptId, status: 'REVIEW_READY' });
    await expect(runtime.coordinator.reconcileOrphans()).resolves.toEqual({ status: 'COMPLETE', stopped: 1 });
    expect(app.reconcileAttempt).toHaveBeenCalledWith(attemptId);
    expect(app.reconcileBudget).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
    await runtime.close(); await runtime.close();
    expect(app.close).toHaveBeenCalledOnce();
    await expect(runtime.coordinator.reconcileAttempt(attemptId)).rejects.toThrow('CIRCLE_ATTEMPT_TASK_RUNTIME_CLOSED');
  });

  it('leaves Trigger unconfigured without both database and provider control credentials', () => {
    resetAttemptTaskRuntimeForTests();
    expect(bootstrapCircleAttemptTaskRuntime({ env: {} })).toBe(false);
    expect(() => getAttemptTaskRuntime()).toThrow(/unconfigured/i);
  });

  it('registers an inert lazy runtime when cleanup-capable control resources exist', async () => {
    resetAttemptTaskRuntimeForTests();
    const app = application();
    const env = { MOTIVE_DATABASE_URL: 'postgres://configured.invalid/motive', MOTIVE_VERCEL_TOKEN: 'configured',
      MOTIVE_VERCEL_TEAM_ID: 'team', MOTIVE_VERCEL_PROJECT_ID: 'project', MOTIVE_DATA_DIR: 'missing-test-data' };
    try {
      expect(bootstrapCircleAttemptTaskRuntime({ env, applicationFactory: async () => app })).toBe(true);
      const registered = getAttemptTaskRuntime();
      await expect(registered.coordinator.reconcileAttempt(attemptId)).resolves.toMatchObject({ status: 'REVIEW_READY' });
    } finally { resetAttemptTaskRuntimeForTests(); }
  });

  it('composes the real fenced Postgres store with a simulated Trigger transport', () => {
    const triggerAttempt = vi.fn(async () => ({ id: 'run-simulated' }));
    const dispatcher = createCircleAttemptWakeDispatcher({ pool: {} as never, trigger: { triggerAttempt } });
    expect(dispatcher.store).toBeInstanceOf(PostgresOrchestrationStore);
    expect(dispatcher.trigger.triggerAttempt).toBe(triggerAttempt);
  });

  it('keeps environment dispatch inert without the paired Trigger configuration', async () => {
    await expect(dispatchCircleAttemptWakeBatchFromEnvironment({}, { triggerAttempt: async () => ({ id: 'unreachable' }) }))
      .rejects.toThrow('CIRCLE_TRIGGER_DISPATCH_UNCONFIGURED');
  });
});
