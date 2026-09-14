import type { TrustedComparatorFactsCapture } from '../../evaluator-lean/src/capture.ts';
import { BoundedTrustedEvaluatorLauncher, prepareTrustedEvaluatorCommand, prepareTrustedEvaluatorReportBindings,
  type DeclaredEvaluatorPreflight, type TrustedEvaluatorCommand } from '../../evaluator-lean/src/launch.ts';
import type { EnvironmentProjection } from './store-types.ts';
import type { EvaluatorRuntime } from './evaluator-coordinator.ts';

/** Deployment-owned host capabilities; no candidate or HTTP caller supplies this object. */
export type TrustedEvaluatorHost = Pick<EvaluatorRuntime, 'assertReady' | 'prepareCreate' | 'create' | 'recoverCreate' | 'observe' | 'observeCommand' | 'stop'> & {
  startCommand(environment: EnvironmentProjection, operationId: string,
    input: { command: TrustedEvaluatorCommand; signal: AbortSignal }): Promise<{ provider_command_id: string }>;
  /** Recorded observations from actual trusted probes; omitted checks remain false. */
  observedPreflight(environment: EnvironmentProjection, commandId: string): Promise<DeclaredEvaluatorPreflight | undefined>;
  facts(environment: EnvironmentProjection, commandId: string): TrustedComparatorFactsCapture;
};

/** Joins one bounded launcher to protected facts capture and the existing report0.2 validator. */
export function createTrustedEvaluatorRuntime(host: TrustedEvaluatorHost): EvaluatorRuntime {
  return {
    assertReady: plan => host.assertReady(plan),
    ...(host.prepareCreate ? { prepareCreate: (environment: EnvironmentProjection, plan: Parameters<NonNullable<EvaluatorRuntime['prepareCreate']>>[1]) => host.prepareCreate!(environment, plan) } : {}),
    create: (environment, plan, operationId, prepared) => host.create(environment, plan, operationId, prepared),
    recoverCreate: environment => host.recoverCreate(environment),
    observe: environment => host.observe(environment),
    observeCommand: (environment, commandId) => host.observeCommand(environment, commandId),
    stop: (environment, operationId) => host.stop(environment, operationId),
    async start(environment, plan, operationId) {
      const bindings = prepareTrustedEvaluatorReportBindings({ evaluator_profile: plan.evaluatorProfile,
        frozen_evaluator_profile_digest: plan.evaluatorProfileDigest, solution_artifact_manifest_digest: plan.artifactManifestDigest });
      const launcher = new BoundedTrustedEvaluatorLauncher({ start: input => host.startCommand(environment, operationId, input) });
      const command = prepareTrustedEvaluatorCommand({ executable: plan.command.executable, args: plan.command.args,
        timeout_ms: plan.command.timeoutMs, launcher_entrypoint_digest: plan.evaluatorProfile.runtime.launcher.entrypoint_digest,
        report_bindings: bindings });
      const receipt = await launcher.dispatch({ command, signal: AbortSignal.timeout(plan.command.timeoutMs) });
      return { providerCommandId: receipt.provider_command_id };
    },
    async capture(environment, plan, artifact, commandId) {
      if (artifact.manifestDigest !== plan.artifactManifestDigest) throw new Error('EVALUATOR_ARTIFACT_BINDING_MISMATCH');
      const bindings = prepareTrustedEvaluatorReportBindings({ evaluator_profile: plan.evaluatorProfile,
        frozen_evaluator_profile_digest: plan.evaluatorProfileDigest, solution_artifact_manifest_digest: plan.artifactManifestDigest,
        declared_preflight: await host.observedPreflight(environment, commandId) });
      return host.facts(environment, commandId).capture({ bindings, signal: AbortSignal.timeout(15000) });
    },
  };
}
