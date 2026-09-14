import type { AttemptReconcileResult, WorkerCoordinator } from './types.ts';
import { requireAttemptPayload } from './validation.ts';

export const TERMINAL_ATTEMPT_STATUSES = new Set([
  'TERMINATED',
  'SEALED',
  'UNCONFIGURED',
  'REVIEW_READY',
]);

export type AttemptTaskRuntime = {
  coordinator: WorkerCoordinator;
  waitFor: (seconds: number) => Promise<void>;
  waitSeconds?: number;
  maxPasses?: number;
};

export type RegisteredAttemptTaskRuntime = Omit<AttemptTaskRuntime, 'waitFor'>;

let configuredRuntime: RegisteredAttemptTaskRuntime | undefined;

export function configureAttemptTaskRuntime(runtime: RegisteredAttemptTaskRuntime): void {
  if (configuredRuntime !== undefined) {
    throw new Error('Trigger task runtime is already configured.');
  }
  configuredRuntime = runtime;
}

export function getAttemptTaskRuntime(): RegisteredAttemptTaskRuntime {
  if (configuredRuntime === undefined) {
    throw new Error(
      'Trigger task runtime is unconfigured. Register the durable worker coordinator before enabling tasks or schedules.',
    );
  }
  return configuredRuntime;
}

export function isAttemptTaskRuntimeConfigured(): boolean {
  return configuredRuntime !== undefined;
}

export async function runAttemptReconciliation(
  rawPayload: unknown,
  runtime: AttemptTaskRuntime,
): Promise<AttemptReconcileResult> {
  const { attemptId } = requireAttemptPayload(rawPayload);
  const maxPasses = runtime.maxPasses ?? 8;
  const waitSeconds = runtime.waitSeconds ?? 30;
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 100) {
    throw new TypeError('maxPasses must be an integer from 1 to 100.');
  }
  if (!Number.isInteger(waitSeconds) || waitSeconds < 6 || waitSeconds > 3_600) {
    throw new TypeError('waitSeconds must be an integer from 6 to 3600.');
  }

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const reconciliation = await runtime.coordinator.reconcileAttempt(attemptId);
    if (reconciliation.attemptId.toLowerCase() !== attemptId) {
      throw new Error('Coordinator returned a different attempt identity.');
    }
    if (TERMINAL_ATTEMPT_STATUSES.has(reconciliation.status) || pass === maxPasses) {
      return { ...reconciliation, attemptId, passes: pass };
    }
    await runtime.waitFor(waitSeconds);
  }

  throw new Error('Unreachable attempt reconciliation state.');
}

export async function runOrphanReconciliation(
  runtime: Pick<AttemptTaskRuntime, 'coordinator'>,
): Promise<unknown> {
  return runtime.coordinator.reconcileOrphans();
}

/** Test-only reset; production bootstrap should configure once per process. */
export function resetAttemptTaskRuntimeForTests(): void {
  configuredRuntime = undefined;
}
