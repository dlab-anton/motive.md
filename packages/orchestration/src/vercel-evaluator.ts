import { canonicalJson } from '../../domain/src/contracts.ts';
import { SealedEvaluatorInputLoader, type TrustedSealedArtifactContextResolver } from '../../evaluator-lean/src/sealed-input.ts';
import type { ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import { createNativeVercelEvaluatorRuntime, type ReviewedVercelEvaluator } from '../../sandbox-vercel/src/evaluator-runtime.ts';
import type { NativeVercelCredentials } from '../../sandbox-vercel/src/vercel-sdk.ts';
import type { LedgerKernel } from '../../accounting/src/kernel.ts';
import type { OrchestrationStore } from './store-types.ts';

/** Resolve storage prefixes from existing application records, never from candidate fields. */
export function createStoredSealedArtifactContextResolver(input: {
  ledger: Pick<LedgerKernel, 'getAttempt'>;
  store: Pick<OrchestrationStore, 'getExecution'>;
}): TrustedSealedArtifactContextResolver {
  return { async resolve({ attemptId, signal }) {
    signal.throwIfAborted();
    const [attempt, execution] = await Promise.all([input.ledger.getAttempt(attemptId), input.store.getExecution(attemptId)]);
    signal.throwIfAborted();
    const seal = execution?.artifactSeal;
    const worker = execution?.environments.find(item => item.id === seal?.environmentId);
    if (!attempt || attempt.id !== attemptId || !seal || seal.attemptId !== attemptId || seal.status !== 'SEALED'
      || !seal.manifestDigest || !worker || worker.kind !== 'WORKER' || worker.attemptId !== attemptId || worker.state !== 'TERMINATED') return null;
    return { projectId: attempt.projectId, workerEnvironmentId: worker.id };
  } };
}

/** Private application wiring. No production registration or permission is implied by construction. */
export function createSealedVercelEvaluatorRuntime(input: {
  credentials: NativeVercelCredentials;
  objects: Pick<ImmutableObjectStore, 'readObject'>;
  contextResolver: TrustedSealedArtifactContextResolver;
  reviewed: readonly ReviewedVercelEvaluator[];
  effects?: 'suspended' | 'durable-controller';
  fetch?: typeof globalThis.fetch;
}) {
  const loader = new SealedEvaluatorInputLoader({ store: input.objects, contextResolver: input.contextResolver });
  return createNativeVercelEvaluatorRuntime(input.credentials, {
    effects: input.effects, reviewed: input.reviewed,
    async prepareInput(environment, plan) {
      if (!environment.attemptId) throw new Error('EVALUATOR_ATTEMPT_REQUIRED');
      return canonicalJson(await loader.load({ attemptId: environment.attemptId, workOrderId: plan.workOrderId,
        termsDigest: plan.termsDigest, inputDigest: plan.inputDigest, manifestDigest: plan.artifactManifestDigest,
        evaluatorProfile: plan.evaluatorProfile, evaluatorProfileDigest: plan.evaluatorProfileDigest,
        signal: AbortSignal.timeout(15000) }));
    },
  }, input.fetch);
}
