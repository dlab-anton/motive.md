import { createHash } from 'node:crypto';
import type { AttemptProjection, LedgerKernel } from '../../accounting/src/kernel.ts';
import { positiveAmount } from '../../accounting/src/money.ts';
import { digestCanonicalJson, type DecimalAmount, type Digest } from '../../domain/src/contracts.ts';
import type { EvidenceStore, EvaluationProjection } from '../../evidence/src/types.ts';
import type { TrustedComparatorReportCapture } from '../../evaluator-lean/src/contract.ts';
import { requireFrozenRuntimeBoundProfile, type RuntimeBoundComparatorProfile } from '../../evaluator-lean/src/runtime-profile.ts';
import { INPUT_PREFLIGHT_CHECKS, RUNTIME_PREFLIGHT_CHECKS, validateRuntimeBoundComparatorReport } from '../../evaluator-lean/src/runtime-report.ts';
import type { ArtifactSealProjection, ControllerLease, EnvironmentHandle, EnvironmentProjection, OrchestrationStore, ProviderObservation } from './store-types.ts';
import type { DurableEvaluatorReports } from './evaluator-reports.ts';

export type EvaluatorLaunchPlan = {
  format: 'motive.evaluator-launch/0.1';
  workOrderId: string; termsDigest: Digest; inputDigest: Digest;
  evaluatorProfileDigest: Digest; evaluatorProfile: RuntimeBoundComparatorProfile;
  artifactManifestDigest: Digest;
  infrastructureAuthorizationId: string; maximumCostUsd: DecimalAmount;
  /** Trusted registry entry, never queue/candidate-supplied shell text. */
  command: { executable: string; args: string[]; timeoutMs: number };
};

/** Private provider boundary. capture is a repeatable read of protected output, never a second command. */
export interface EvaluatorRuntime {
  assertReady(plan: EvaluatorLaunchPlan): Promise<void>;
  /** Read-only preparation before the CREATE claim. Failure cannot make an unattempted provider request ambiguous. */
  prepareCreate?(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan): Promise<unknown>;
  create(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan, operationId: string, prepared?: unknown): Promise<EnvironmentHandle>;
  /** Must match the deterministic environment identity, ownership and exact provider session. */
  recoverCreate(environment: EnvironmentProjection): Promise<EnvironmentHandle | null>;
  observe(environment: EnvironmentProjection): Promise<ProviderObservation>;
  start(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan, operationId: string): Promise<{ providerCommandId: string }>;
  observeCommand(environment: EnvironmentProjection, providerCommandId: string): Promise<{ state: 'RUNNING' | 'EXITED' }>;
  capture(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan, artifact: ArtifactSealProjection,
    providerCommandId: string): Promise<TrustedComparatorReportCapture | null>;
  stop(environment: EnvironmentProjection, operationId: string): Promise<ProviderObservation>;
}

export type EvaluatorCoordinatorDependencies = {
  store: OrchestrationStore;
  ledger: Pick<LedgerKernel, 'getAttempt'>;
  evidence: Pick<EvidenceStore, 'recordTrustedEvaluatorCapture'>;
  reports: Pick<DurableEvaluatorReports, 'read' | 'retain'>;
  resolvePlan(attempt: AttemptProjection): Promise<EvaluatorLaunchPlan | null>;
  runtime: EvaluatorRuntime;
  ownerId: string; leaseSeconds?: number;
};
export type EvaluatorReconciliation = { attemptId: string; status: 'WAITING' | 'RUNNING' | 'STOPPING' | 'TERMINATED' | 'UNCONFIGURED' | 'QUARANTINED' | 'REVIEW_READY'; evaluationId?: string };
const ended = (environment: EnvironmentProjection) => ['TERMINATED', 'ABANDONED'].includes(environment.state);
const freshDenied = (error: unknown) => !!error && typeof error === 'object' && 'code' in error &&
  ['CONTROLLER_FROZEN', 'SOURCE_UNAVAILABLE', 'GRANT_UNAVAILABLE', 'ATTEMPT_UNAVAILABLE', 'INFRA_AUTHORIZATION_UNAVAILABLE'].includes(String(error.code));

/** One bounded step; the existing Trigger task supplies waits and wakeups. */
export class DurableEvaluatorCoordinator {
  private readonly ttl: number;
  constructor(private readonly deps: EvaluatorCoordinatorDependencies) {
    this.ttl = deps.leaseSeconds ?? 60;
    if (!deps.ownerId || !Number.isInteger(this.ttl) || this.ttl < 10 || this.ttl > 300) throw new Error('CONTROLLER_CONFIGURATION_INVALID');
  }

  async reconcileAttempt(attemptId: string): Promise<EvaluatorReconciliation> {
    const attempt = await this.deps.ledger.getAttempt(attemptId);
    if (!attempt) throw new Error('ATTEMPT_NOT_FOUND');
    let execution = await this.deps.store.getExecution(attemptId);
    const evaluators = execution?.environments.filter(item => item.kind === 'EVALUATOR') ?? [];
    let environment = evaluators.find(item => !ended(item)) ?? evaluators.at(-1);
    const result = (status: EvaluatorReconciliation['status'], evaluationId?: string): EvaluatorReconciliation =>
      ({ attemptId, status, ...(evaluationId ? { evaluationId } : {}) });
    let lease = await this.deps.store.acquireLease(attemptId, this.deps.ownerId, this.ttl);
    const frozen = environment ? await this.deps.store.getEvaluatorLaunchPlan(lease, environment.id) : null;
    let registryUnavailable = false;
    const configured = await this.deps.resolvePlan(attempt).then(value => value && structuredClone(value)).catch(error => {
      if (frozen) { registryUnavailable = true; return null; }
      throw error;
    });
    const plan = (frozen ?? configured) as EvaluatorLaunchPlan | null;
    let retired = !!environment && !registryUnavailable && !configured;
    if (environment && configured && frozen) {
      try { retired = digestCanonicalJson(configured) !== digestCanonicalJson(frozen); }
      catch { registryUnavailable = true; }
    }
    if (!plan && !environment) return result('UNCONFIGURED');
    let valid = false;
    if (plan) {
      try {
        requireFrozenRuntimeBoundProfile(plan.evaluatorProfile, plan.evaluatorProfileDigest);
        positiveAmount(plan.maximumCostUsd, 'evaluator maximumCostUsd');
        if (plan.format !== 'motive.evaluator-launch/0.1' || plan.workOrderId !== attempt.workOrderId || plan.termsDigest !== attempt.termsDigest
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(plan.infrastructureAuthorizationId)
          || plan.inputDigest !== attempt.inputDigest || !/^\/[A-Za-z0-9/._+-]+$/.test(plan.command.executable)
          || !Number.isSafeInteger(plan.command.timeoutMs) || plan.command.timeoutMs < 1000 || plan.command.timeoutMs > 3600000
          || !Array.isArray(plan.command.args) || plan.command.args.length > 128
          || plan.command.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('EVALUATOR_PLAN_INVALID');
        digestCanonicalJson(plan);
        valid = !environment || environment.launchPlanDigest === digestCanonicalJson(plan);
      } catch (error) { if (!environment) throw error; }
    }
    if (!valid || !plan) return environment ? this.cleanup(lease, environment) : result('UNCONFIGURED');
    const artifact = execution?.artifactSeal;
    if (artifact?.status !== 'SEALED' || !artifact.manifestDigest) return environment ? this.cleanup(lease, environment) : result('WAITING');
    if (plan.artifactManifestDigest !== artifact.manifestDigest) throw new Error('EVALUATOR_ARTIFACT_BINDING_MISMATCH');
    // No worker VM remains while the independent evaluator starts.
    const workerStillActive = execution!.environments.some(item => item.kind === 'WORKER' && !ended(item));
    if (workerStillActive && !environment) return result('WAITING');
    if (!environment) {
      if (attempt.cancellationRequestedAt || attempt.admissionClosedAt) return result('TERMINATED');
      await this.deps.runtime.assertReady(plan);
      try {
        environment = (await this.deps.store.reserveEnvironment(lease, { kind: 'EVALUATOR', profileDigest: plan.evaluatorProfileDigest,
          profileSnapshot: plan.evaluatorProfile as unknown as Record<string, unknown>, launchPlanDigest: digestCanonicalJson(plan),
          infrastructureAuthorizationId: plan.infrastructureAuthorizationId, maximumCostUsd: plan.maximumCostUsd })).environment;
      } catch (error) { if (freshDenied(error)) return result('TERMINATED'); throw error; }
      execution = await this.deps.store.getExecution(attemptId);
    }
    if (environment.state === 'ABANDONED') return result('TERMINATED');
    // Persist reviewed launch material before any provider dispatch. Recovery uses this exact snapshot.
    if (!frozen) await this.deps.store.freezeEvaluatorLaunchPlan(lease, environment.id, plan as unknown as Record<string, unknown>);
    if (environment.state === 'TERMINATED') return this.finish(lease, environment, plan, artifact, null);
    const stale = environment.leaseEpoch !== lease.epoch || environment.controllerGeneration !== lease.controllerGeneration;
    let create = execution!.effects.find(item => item.environmentId === environment!.id && item.kind === 'CREATE');
    if (!create) throw new Error('CREATE_INTENT_MISSING');
    if (!environment.externalId) {
      if (create.state === 'INTENT_RECORDED') {
        if (stale || retired || registryUnavailable || workerStillActive || attempt.cancellationRequestedAt || attempt.admissionClosedAt) {
          await this.deps.store.abandonReservedEnvironment(lease, environment.id);
          return result('TERMINATED');
        }
        await this.deps.runtime.assertReady(plan);
        const prepared = await this.deps.runtime.prepareCreate?.(environment, plan);
        lease = await this.deps.store.heartbeat(lease, this.ttl);
        try { if (!(await this.deps.store.claimEffect(lease, create.effectId)).claimed) return result('WAITING'); }
        catch (error) {
          if (!freshDenied(error)) throw error;
          await this.deps.store.abandonReservedEnvironment(lease, environment.id);
          return result('TERMINATED');
        }
        let handle: EnvironmentHandle;
        try { handle = await this.deps.runtime.create(environment, plan, create.effectId, prepared); }
        catch {
          await this.deps.store.markEffectUnknown(lease, create.effectId, 'EVALUATOR_CREATE_RESULT_UNCERTAIN');
          return result('QUARANTINED');
        }
        // A commit-response loss must never be mistaken for permission to create again.
        await this.deps.store.recordCreateResult(lease, create.effectId, handle);
        return result('RUNNING');
      }
      const recovered = await this.deps.runtime.recoverCreate(environment);
      if (!recovered) return result('QUARANTINED');
      environment = await this.deps.store.recordRecoveredCreate(lease, create.effectId, recovered);
    }
    environment = await this.deps.store.recordObservation(lease, environment.id, await this.deps.runtime.observe(environment));
    const command = (await this.deps.store.getExecution(attemptId))!.effects.find(item => item.environmentId === environment!.id && item.kind === 'COMMAND');
    if (environment.state === 'TERMINATED') return this.finish(lease, environment, plan, artifact, command?.providerCommandId ?? null);
    const retained = await this.deps.reports.read(environment.id);
    if (retained) return this.finish(lease, environment, plan, artifact, null, retained);
    const current = await this.deps.ledger.getAttempt(attemptId);
    if (stale || retired || workerStillActive || !current || current.cancellationRequestedAt || current.admissionClosedAt || environment.state === 'STOP_REQUESTED'
      || (registryUnavailable && command?.state !== 'RESULT_RECORDED')) {
      // Preserve completed evidence even during teardown. Running/unknown commands establish no result.
      const completed = command?.providerCommandId && (await this.deps.runtime.observeCommand(environment, command.providerCommandId)).state === 'EXITED';
      return this.finish(lease, environment, plan, artifact, completed ? command!.providerCommandId : null);
    }
    if (environment.state !== 'ACTIVE') return result('WAITING');
    let effect = command;
    try {
      if (!effect) effect = (await this.deps.store.planCommand(lease, environment.id, { commandDigest: digestCanonicalJson(plan.command) })).effect;
      if (effect.commandDigest !== digestCanonicalJson(plan.command)) throw new Error('FROZEN_COMMAND_MISMATCH');
      if (effect.state === 'INTENT_RECORDED') {
        lease = await this.deps.store.heartbeat(lease, this.ttl);
        if (!(await this.deps.store.claimEffect(lease, effect.effectId)).claimed) return result('WAITING');
      } else if (effect.state === 'RESULT_RECORDED' && effect.providerCommandId) {
        const observed = await this.deps.runtime.observeCommand(environment, effect.providerCommandId);
        return observed.state === 'RUNNING' ? result('RUNNING') : this.finish(lease, environment, plan, artifact, effect.providerCommandId);
      } else return this.finish(lease, environment, plan, artifact, null);
    } catch (error) { if (freshDenied(error)) return this.finish(lease, environment, plan, artifact, null); throw error; }
    let started: { providerCommandId: string };
    try { started = await this.deps.runtime.start(environment, plan, effect.effectId); }
    catch {
      await this.deps.store.markEffectUnknown(lease, effect.effectId, 'EVALUATOR_COMMAND_RESULT_UNCERTAIN');
      return result('QUARANTINED');
    }
    await this.deps.store.recordCommandResult(lease, effect.effectId, started);
    return result('RUNNING');
  }

  private unavailable(plan: EvaluatorLaunchPlan, artifact: ArtifactSealProjection): TrustedComparatorReportCapture {
    const profile = plan.evaluatorProfile;
    const bytes = Buffer.from(JSON.stringify({ format: 'motive.lean-comparator-report/0.2', evaluator_profile_digest: plan.evaluatorProfileDigest,
      challenge_digest: profile.challenge.challenge_digest, dependency_lock_digest: profile.challenge.dependency_lock_digest,
      trusted_build_config_digest: profile.challenge.trusted_build_config_digest, solution_artifact_manifest_digest: artifact.manifestDigest,
      runtime_digest: digestCanonicalJson(profile.runtime), facts_capture: null,
      runtime_preflight: Object.fromEntries(RUNTIME_PREFLIGHT_CHECKS.map(key => [key, false])),
      input_preflight: Object.fromEntries(INPUT_PREFLIGHT_CHECKS.map(key => [key, false])) }));
    return { bytes, expected_raw_report_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  }

  private async finish(lease: ControllerLease, environment: EnvironmentProjection, plan: EvaluatorLaunchPlan,
    artifact: ArtifactSealProjection, commandId: string | null, prior?: TrustedComparatorReportCapture): Promise<EvaluatorReconciliation> {
    lease = await this.deps.store.heartbeat(lease, this.ttl);
    const claim = await this.deps.store.getEvaluatorReportClaim(lease, environment.id);
    if (claim) commandId = claim.commandId;
    let report = prior ?? await this.deps.reports.read(environment.id);
    if (!report) {
      if (commandId) {
        // Transport/invalid-capture errors are retryable reads, never evidence of absence.
        report = await this.deps.runtime.capture(environment, plan, artifact, commandId);
        if (report) validateRuntimeBoundComparatorReport({ evaluator_profile: plan.evaluatorProfile,
          frozen_evaluator_profile_digest: plan.evaluatorProfileDigest, solution_artifact_manifest_digest: artifact.manifestDigest!, captured_report: report });
      }
      report ??= this.unavailable(plan, artifact);
      await this.deps.store.claimEvaluatorReport(lease, environment.id, { reportDigest: report.expected_raw_report_digest, commandId });
      report = await this.deps.reports.retain(environment.id, report);
    } else {
      if (!claim || claim.reportDigest !== report.expected_raw_report_digest) throw new Error('EVALUATOR_REPORT_CLAIM_MISMATCH');
    }
    lease = await this.deps.store.heartbeat(lease, this.ttl);
    let evaluation: EvaluationProjection;
    let cleanup: EvaluatorReconciliation;
    try {
      evaluation = await this.deps.evidence.recordTrustedEvaluatorCapture({ artifactEnvironmentId: artifact.environmentId,
        evaluatorEnvironmentId: environment.id, evaluatorProfile: plan.evaluatorProfile, capturedReport: report });
    } catch (error) {
      // Preserve both errors when the DB response and subsequent cleanup independently fail.
      try { await this.cleanup(lease, environment); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Evaluator evidence and cleanup both require recovery'); }
      throw error;
    }
    // Raw bytes are already durable; teardown precedes human review readiness.
    cleanup = await this.cleanup(lease, environment);
    if (cleanup.status !== 'TERMINATED') return cleanup;
    if ((await this.deps.store.getExecution(lease.attemptId))!.environments.some(item => !ended(item))) {
      return { attemptId: lease.attemptId, status: 'STOPPING' };
    }
    await this.deps.store.finishEvaluation(lease, environment.id, evaluation.id);
    return { attemptId: lease.attemptId, status: 'REVIEW_READY', evaluationId: evaluation.id };
  }

  private async cleanup(lease: ControllerLease, environment: EnvironmentProjection): Promise<EvaluatorReconciliation> {
    const result = (status: EvaluatorReconciliation['status']): EvaluatorReconciliation => ({ attemptId: lease.attemptId, status });
    if (ended(environment)) return result('TERMINATED');
    if (!environment.externalId) {
      const create = (await this.deps.store.getExecution(lease.attemptId))?.effects.find(item => item.environmentId === environment.id && item.kind === 'CREATE');
      if (create?.state === 'INTENT_RECORDED') {
        await this.deps.store.abandonReservedEnvironment(lease, environment.id);
        return result('TERMINATED');
      }
      const recovered = await this.deps.runtime.recoverCreate(environment);
      if (!recovered || !create) return result('QUARANTINED');
      environment = await this.deps.store.recordRecoveredCreate(lease, create.effectId, recovered);
    }
    environment = await this.deps.store.recordObservation(lease, environment.id, await this.deps.runtime.observe(environment));
    if (ended(environment)) {
      await this.deps.store.closeAttemptAdmission(lease, environment.id);
      return result('TERMINATED');
    }
    const { effect } = await this.deps.store.requestStop(lease, environment.id);
    if (!(await this.deps.store.claimEffect(lease, effect.effectId)).claimed) return result('STOPPING');
    let observed: ProviderObservation;
    try { observed = await this.deps.runtime.stop(environment, effect.effectId); }
    catch {
      await this.deps.store.markEffectUnknown(lease, effect.effectId, 'EVALUATOR_STOP_RESULT_UNCERTAIN');
      return result('STOPPING');
    }
    const saved = await this.deps.store.recordStopResult(lease, effect.effectId, observed);
    return result(saved.state === 'TERMINATED' ? 'TERMINATED' : 'STOPPING');
  }
}
