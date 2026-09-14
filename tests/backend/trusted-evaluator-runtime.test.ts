import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { captureRuntimeBoundComparatorReport } from '../../packages/evaluator-lean/src/capture.ts';
import { profile, hash } from '../../packages/evaluator-lean/src/runtime-profile.fixture.ts';
import { validateRuntimeBoundComparatorReport } from '../../packages/evaluator-lean/src/runtime-report.ts';
import { createTrustedEvaluatorRuntime, type TrustedEvaluatorHost } from '../../packages/orchestration/src/trusted-evaluator-runtime.ts';
import type { EvaluatorLaunchPlan } from '../../packages/orchestration/src/evaluator-coordinator.ts';
import type { ArtifactSealProjection, EnvironmentProjection } from '../../packages/orchestration/src/store-types.ts';
import { runAttemptReconciliation } from '../../packages/dispatcher-trigger/src/runtime.ts';

describe('trusted evaluator runtime composition', () => {
  it('binds one launcher dispatch and defaults unobserved preflight to inconclusive despite passing facts', async () => {
    let starts = 0;
    const environment = { id: 'fixture', sessionId: 'exact-session' } as EnvironmentProjection;
    const artifact = { manifestDigest: hash } as ArtifactSealProjection;
    const plan: EvaluatorLaunchPlan = { format: 'motive.evaluator-launch/0.1', workOrderId: 'work', termsDigest: hash, inputDigest: hash,
      evaluatorProfile: profile, evaluatorProfileDigest: digestCanonicalJson(profile), artifactManifestDigest: hash,
      infrastructureAuthorizationId: 'authorization', maximumCostUsd: '1', command: { executable: '/opt/evaluator/launcher', args: [], timeoutMs: 1000 } };
    const facts = Buffer.from(JSON.stringify({ format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
      protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true, transitive_axioms: true,
      kernel_replay: true, used_transitive_axioms: [] }));
    const forbidden = async (): Promise<never> => { throw new Error('Unexpected host operation'); };
    const host: TrustedEvaluatorHost = {
      assertReady: forbidden, create: forbidden, recoverCreate: forbidden, observe: forbidden, observeCommand: forbidden, stop: forbidden,
      async startCommand(actual, operationId, { command }) {
        expect(actual.sessionId).toBe('exact-session'); expect(operationId).toBe('durable-effect');
        expect(command.report_bindings.solution_artifact_manifest_digest).toBe(hash);
        expect(command.launcher_entrypoint_digest).toBe(profile.runtime.launcher.entrypoint_digest);
        starts++; return { provider_command_id: 'command-1' };
      },
      async observedPreflight() { return undefined; },
      facts(actual, commandId) {
        expect(actual).toBe(environment); expect(commandId).toBe('command-1');
        return { async capture({ bindings }) { return captureRuntimeBoundComparatorReport({ bindings, protectedFactsBytes: facts }); } };
      },
    };
    const runtime = createTrustedEvaluatorRuntime(host);
    expect(await runtime.start(environment, plan, 'durable-effect')).toEqual({ providerCommandId: 'command-1' });
    const captured = await runtime.capture(environment, plan, artifact, 'command-1');
    const assessment = validateRuntimeBoundComparatorReport({ evaluator_profile: profile, frozen_evaluator_profile_digest: plan.evaluatorProfileDigest,
      solution_artifact_manifest_digest: hash, captured_report: captured! });
    expect(assessment.outcome).toBe('INCONCLUSIVE'); expect(assessment.human_acceptance.status).toBe('PENDING');
    expect(starts).toBe(1);
    await expect(runtime.capture(environment, plan, { manifestDigest: digestCanonicalJson('wrong artifact') } as ArtifactSealProjection, 'command-1'))
      .rejects.toThrow('ARTIFACT_BINDING_MISMATCH');
  });

  it('the existing Trigger loop stops polling when evidence is ready for human review', async () => {
    const attemptId = '12345678-1234-4123-8123-123456789abc';
    let calls = 0, waits = 0;
    const value = await runAttemptReconciliation({ attemptId }, {
      coordinator: { async reconcileAttempt(id) { calls++; return { attemptId: id, status: 'REVIEW_READY' }; }, async reconcileOrphans() {} },
      async waitFor() { waits++; },
    });
    expect(value.status).toBe('REVIEW_READY'); expect(calls).toBe(1); expect(waits).toBe(0);
  });
});
