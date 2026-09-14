import { DurableWorkerCoordinator, type CoordinatorDependencies } from './coordinator.ts';
import { DurableEvaluatorCoordinator, type EvaluatorCoordinatorDependencies } from './evaluator-coordinator.ts';

/** Register this composition with the existing Trigger runtime. It introduces no scheduler. */
export function createLearningCoordinator(workerDeps: CoordinatorDependencies, evaluatorDeps: EvaluatorCoordinatorDependencies) {
  if (workerDeps.ownerId !== evaluatorDeps.ownerId || workerDeps.store !== evaluatorDeps.store) {
    throw new Error('LEARNING_COORDINATOR_REQUIRES_SHARED_STORE_AND_LEASE_OWNER');
  }
  const evaluator = new DurableEvaluatorCoordinator(evaluatorDeps);
  const worker = new DurableWorkerCoordinator({ ...workerDeps, evaluator });
  return {
    async reconcileAttempt(attemptId: string) {
      const execution = await workerDeps.store.getExecution(attemptId);
      if (execution?.environments.some(item => item.kind === 'EVALUATOR')) {
        if (execution.environments.some(item => item.kind === 'WORKER' && !['TERMINATED', 'ABANDONED'].includes(item.state))) {
          await worker.reconcileAttempt(attemptId);
        }
        return evaluator.reconcileAttempt(attemptId);
      }
      const work = await worker.reconcileAttempt(attemptId);
      return work.status === 'SEALED' ? evaluator.reconcileAttempt(attemptId) : work;
    },
    reconcileOrphans: () => worker.reconcileOrphans(),
  };
}
