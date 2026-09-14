import { queue, schedules, task, wait } from '@trigger.dev/sdk';
import {
  ATTEMPT_RECONCILE_TASK_ID,
  ORPHAN_RECONCILE_TASK_ID,
  OUTBOX_DELIVERY_TASK_ID,
  getAttemptTaskRuntime,
  runAttemptReconciliation,
  runOrphanReconciliation,
  type AttemptReconcilePayload,
} from '../packages/dispatcher-trigger/src/index.ts';
import {
  bootstrapCircleAttemptTaskRuntime,
  dispatchCircleAttemptWakeBatchFromEnvironment,
} from '../server/project-runs/task-runtime.ts';

// Trigger loads this module in its own process; registration remains inert and
// fail-closed unless the database and provider control boundary are configured.
bootstrapCircleAttemptTaskRuntime();

export const attemptReconciliationQueue = queue({
  name: 'motive-attempt-reconciliation',
  concurrencyLimit: 1,
});

export const orphanReconciliationQueue = queue({
  name: 'motive-orphan-reconciliation',
  concurrencyLimit: 1,
});

export const outboxDeliveryQueue = queue({
  name: 'motive-circle-outbox-delivery',
  concurrencyLimit: 1,
});

export const attemptReconcileTask = task({
  id: ATTEMPT_RECONCILE_TASK_ID,
  queue: attemptReconciliationQueue,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  maxDuration: 900,
  ttl: '10m',
  run: async (payload: AttemptReconcilePayload) => runAttemptReconciliation(payload, {
    ...getAttemptTaskRuntime(),
    waitFor: async (seconds) => wait.for({ seconds }),
  }),
});

/**
 * This scheduled task intentionally has no declarative cron. An operator must
 * attach a schedule after the coordinator and database credentials are wired.
 */
export const orphanReconcileTask = schedules.task({
  id: ORPHAN_RECONCILE_TASK_ID,
  queue: orphanReconciliationQueue,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  maxDuration: 300,
  ttl: '5m',
  run: async () => runOrphanReconciliation(getAttemptTaskRuntime()),
});

/** Registered without a cron; an operator attaches a schedule after deployment review. */
export const outboxDeliveryTask = schedules.task({
  id: OUTBOX_DELIVERY_TASK_ID,
  queue: outboxDeliveryQueue,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  maxDuration: 120,
  ttl: '5m',
  run: async () => dispatchCircleAttemptWakeBatchFromEnvironment(),
});
