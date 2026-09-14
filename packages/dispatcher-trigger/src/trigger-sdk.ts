import { tasks, type Task, type TriggerOptions } from '@trigger.dev/sdk';
import {
  ATTEMPT_RECONCILE_TASK_ID,
  type AttemptReconcilePayload,
  type AttemptReconcileResult,
  type AttemptTaskTrigger,
} from './types.ts';

type AttemptReconcileTask = Task<
  typeof ATTEMPT_RECONCILE_TASK_ID,
  AttemptReconcilePayload,
  AttemptReconcileResult
>;

export type TriggerSdkNetwork = (
  taskId: typeof ATTEMPT_RECONCILE_TASK_ID,
  payload: AttemptReconcilePayload,
  options: TriggerOptions,
  requestOptions: { retry: { maxAttempts: number } },
) => Promise<{ id: string }>;

const defaultTriggerNetwork: TriggerSdkNetwork = async (taskId, payload, options, requestOptions) => {
  const handle = await tasks.trigger<AttemptReconcileTask>(taskId, payload, options, requestOptions);
  return { id: handle.id };
};

/**
 * The SDK transport makes one HTTP attempt. A response-loss error remains
 * ambiguous and is handed back to the fenced outbox for idempotent redelivery.
 */
export function createTriggerSdkTaskClient(
  network: TriggerSdkNetwork = defaultTriggerNetwork,
): AttemptTaskTrigger {
  return {
    async triggerAttempt(payload, options) {
      return network(
        ATTEMPT_RECONCILE_TASK_ID,
        payload,
        options,
        { retry: { maxAttempts: 1 } },
      );
    },
  };
}

export const triggerSdkTaskClient = createTriggerSdkTaskClient();
